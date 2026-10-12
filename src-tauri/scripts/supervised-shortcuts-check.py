"""Native Windows smoke check against an embedded debug build, using fresh data.

python src-tauri/scripts/supervised-shortcuts-check.py --output .output/shortcut-check
OS registrations stay disabled. Authenticated IPC exercises real WebView workers,
SQLite writes, eligibility, closed capture startup and repeatable action receipts.
Artifacts are retained. Never point this check at an existing data directory.
"""
import argparse
from contextlib import contextmanager
import json
import os
from pathlib import Path
import socket
import sqlite3
import struct
import subprocess
import time
import uuid


def call(peer, payload, request_id=None):
    request_id = request_id or str(uuid.uuid4())
    wire = json.dumps({"version": 1, "secret": peer["secret"], "request": {
        "id": request_id, "payload": payload}}).encode()
    address, port = peer["address"].rsplit(":", 1)

    def exact(connection, size):
        data = b""
        while len(data) < size:
            chunk = connection.recv(size - len(data))
            if not chunk:
                raise OSError("peer closed the connection")
            data += chunk
        return data

    deadline = time.monotonic() + 5
    while True:
        try:
            with socket.create_connection((address, int(port)), timeout=2) as connection:
                connection.sendall(struct.pack(">I", len(wire)) + wire)
                size = struct.unpack(">I", exact(connection, 4))[0]
                assert 0 < size <= 65536, "invalid frame size"
                reply = json.loads(exact(connection, size))
            assert reply["id"] == request_id and reply["instance"] == peer["instance"]
            return reply["result"]
        except OSError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.04)


def wait(check, timeout=100):
    deadline = time.monotonic() + timeout
    while True:
        result = check()
        if result:
            return result
        assert time.monotonic() < deadline, "native operation timed out"
        time.sleep(0.04)


@contextmanager
def lease(path):
    # Rust File::lock covers this byte as well. File presence is not ownership.
    import msvcrt
    with path.open("r+b") as handle:
        def acquire():
            try:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                return True
            except OSError:
                return False
        wait(acquire, 5)
        try:
            yield
        finally:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)


def owned(path):
    import msvcrt
    with path.open("r+b") as handle:
        try:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            return True
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--exe", type=Path, default=Path(__file__).resolve().parents[1] / "target/debug/mindstream-notes.exe")
    parser.add_argument("--wait-for-external-quit", action="store_true", help="wait for external menu or IPC Quit after writing quit-ready.json")
    parser.add_argument("--wait-for-window-close", action="store_true", help="start two vaults without background capture and wait for native window closure")
    parser.add_argument("--autostart-hidden", action="store_true", help="check hidden autostart before the window-close UI fixture; create activate-now to continue")
    parser.add_argument("--check-revival", action="store_true", help="crash the owned coordinator and check automatic worker adoption without a manual launch")
    parser.add_argument("--check-update-recovery", action="store_true", help="simulate a completed update and verify all-vault/popout/hidden-state recovery without installing software")
    parser.add_argument("--wait-for-update-inspection", action="store_true", help="pause recovered-update fixture for computer-use inspection until inspect-done exists")
    args = parser.parse_args()
    if args.wait_for_update_inspection:
        args.check_update_recovery = True
    if args.autostart_hidden:
        args.wait_for_window_close = True
    if args.check_revival and (args.wait_for_window_close or args.wait_for_external_quit):
        parser.error("revival check cannot be combined with interactive close/quit modes")
    if args.check_update_recovery and (args.check_revival or args.wait_for_window_close or args.wait_for_external_quit):
        parser.error("update recovery cannot be combined with another lifecycle fixture")
    assert os.name == "nt", "this fixture checks Windows native workers"
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    root = output / "root"
    root.mkdir()
    vaults = ["capture", "other"]
    for vault_id in vaults:
        directory = root / "profiles" / vault_id
        directory.mkdir(parents=True)
        (directory / "content-settings.json").write_text(json.dumps({"version": 1, "revision": 1,
            "values": {"hotkeys.globalShortcuts": vault_id == "capture" and not args.wait_for_window_close}}), encoding="utf-8")
    (root / "profiles.json").write_text(json.dumps({"active": "other", "profiles": [
        {"id": vault_id, "name": vault_id, "created_at": "2026-10-11T00:00:00Z"} for vault_id in vaults]}), encoding="utf-8")
    # Keep the coordinator for the deliberate zero-eligibility tray scenarios.
    # A second launch below checks the user's normal last-window exit policy.
    (root / "desktop-settings.json").write_text(json.dumps({"close_to_tray": not args.wait_for_window_close,
        "start_in_tray": args.autostart_hidden}), encoding="utf-8")
    env = os.environ.copy()
    env["MINDSTREAM_ROOT_DIR"] = str(root)
    env["WEBVIEW2_USER_DATA_FOLDER"] = str(output / "legacy-webview")
    with (output / "native.log").open("w", encoding="utf-8") as log:
        initial_args = [str(args.exe.resolve()), "--supervised-vaults"]
        if args.autostart_hidden:
            initial_args.append("--mindstream-autostart")
        host = subprocess.Popen(initial_args, env=env,
            stdout=log, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
        (output / "host.pid").write_text(str(host.pid), encoding="utf-8")
        peer = None

        def endpoint():
            assert host.poll() is None, "coordinator exited; inspect native.log"
            try:
                record = json.loads((root / "coordinator-endpoint.json").read_text())
                # Process ID correlates this fixture, never determines ownership.
                return record if record.get("process_id") == host.pid else None
            except (FileNotFoundError, json.JSONDecodeError):
                return None

        def status():
            return call(peer, {"command": "status"})["Ok"]

        def worker(vault_id):
            return json.loads((root / "worker-registrations" / (vault_id + ".json")).read_text())

        def completed(command, **fields):
            operation_id = str(uuid.uuid4())
            payload = {"command": command, **fields}
            assert call(peer, payload, operation_id)["Ok"] == {"accepted": True}
            def terminal():
                progress = call(peer, {"command": "openStatus", "operation_id": operation_id})["Ok"]
                return progress if progress["state"] != "pending" else None
            progress = wait(terminal)
            assert progress["state"] == "ready", progress
            assert call(peer, payload, operation_id)["Ok"] == {"accepted": True}
            return operation_id

        def counts(vault_id):
            path = root / "profiles" / vault_id / "mindstream.db"
            with sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True) as db:
                return dict(db.execute("SELECT note_kind, COUNT(*) FROM notes GROUP BY note_kind"))

        def close_all():
            for entry in status()["workers"]:
                record = worker(entry["id"])
                operation_id = str(uuid.uuid4())
                unknown = {"command": "closeStatus", "launch_id": record["launch_id"], "operation_id": str(uuid.uuid4())}
                assert "Err" in call(record["endpoint"], unknown)
                payload = {"command": "close", "launch_id": record["launch_id"]}
                assert call(record["endpoint"], payload, operation_id)["Ok"]["accepted"]
                try:
                    assert call(record["endpoint"], payload, operation_id)["Ok"]["accepted"]
                    progress = call(record["endpoint"], {**unknown, "operation_id": operation_id})["Ok"]
                    assert progress["state"] in ["queued", "pending", "committing"], progress
                except OSError:
                    # A lost socket never counts as exit. The coordinator still
                    # must observe its child's actual exit below.
                    pass
            wait(lambda: not status()["workers"])

        def enabled(vault_id, enabled):
            directory = root / "profiles" / vault_id
            with lease(root / ".root.lock"), lease(directory / ".vault.lock"):
                path = directory / "content-settings.json"
                document = json.loads(path.read_text())
                document["values"]["hotkeys.globalShortcuts"] = enabled
                document["revision"] += 1
                path.write_text(json.dumps(document), encoding="utf-8")

        clean = False
        revival_started = False
        try:
            peer = wait(endpoint)
            wait(lambda: status()["initialized"] and any(entry["id"] == "other" and entry["ready"] for entry in status()["workers"]))
            assert status()["contract"]["protocol"] == 8
            if args.wait_for_window_close:
                if args.autostart_hidden:
                    assert status()["active"] is None, "hidden worker incorrectly took focus recency"
                    (output / "autostart-ready.json").write_text(json.dumps({"host_pid": host.pid}), encoding="utf-8")
                    print("Autostart worker ready; inspect hidden windows and create activate-now", flush=True)
                    wait(lambda: (output / "activate-now").exists())
                    # Normal executable launch must route through the existing
                    # coordinator and show its ready hidden worker.
                    launcher = subprocess.Popen([str(args.exe.resolve()), "--supervised-vaults"], env=env,
                        stdout=log, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
                    assert launcher.wait(timeout=30) == 0
                    wait(lambda: status()["active"] == "other")
                    print("Normal duplicate launch activated the hidden autostart worker")
                completed("open", vault_id="capture")
                wait(lambda: len(status()["workers"]) == 2 and all(entry["ready"] for entry in status()["workers"]))
                assert status()["shortcuts"] == {"state": "none"}
                (output / "close-ready.json").write_text(json.dumps({"host_pid": host.pid, "vaults": vaults}), encoding="utf-8")
                print("Both workers ready for native window-close checks", flush=True)
                assert host.wait(timeout=190) == 0
                with lease(root / ".coordinator.lock"):
                    for vault_id in vaults:
                        with lease(root / "profiles" / vault_id / ".vault.lock"):
                            pass
                print("Native window closure exited coordinator and released every lease")
                clean = True
                return
            assert status()["shortcuts"]["vault_id"] == "capture"
            assert not status()["shortcutRegistration"]["registered"], "test root registered OS shortcuts"
            owner = worker("other")
            for enabled_value in [None, True]:
                request_id = str(uuid.uuid4())
                payload = {"command": "autostart", "vault_id": "other", "launch_id": owner["launch_id"], "enabled": enabled_value}
                assert call(peer, payload, request_id)["Ok"] == {"accepted": True}
                def autostart_terminal():
                    progress = call(peer, {"command": "autostartStatus", "operation_id": request_id})["Ok"]
                    return progress if progress["state"] != "pending" else None
                progress = wait(autostart_terminal)
                if enabled_value is None:
                    assert progress == {"state": "ready", "enabled": False}
                else:
                    assert progress["state"] == "failed" and "dev/test" in progress["message"]
                assert call(peer, payload, request_id)["Ok"] == {"accepted": True}
                assert call(peer, {"command": "autostartStatus", "operation_id": request_id})["Ok"] == progress
                assert "Err" in call(peer, {"command": "open", "vault_id": "capture"}, request_id)
            assert "Err" in call(peer, {"command": "autostart", "vault_id": "other", "launch_id": str(uuid.uuid4()), "enabled": None})
            print("Coordinator autostart read/retry/identity and disabled test-root writes passed")
            check_id = str(uuid.uuid4())
            check_payload = {"command": "updateCheck", "vault_id": "other", "launch_id": owner["launch_id"], "force": False}
            assert call(peer, check_payload, check_id)["Ok"] == {"accepted": True}
            def update_checked():
                progress = call(peer, {"command": "updateCheckStatus", "operation_id": check_id})["Ok"]
                return progress if progress["state"] != "pending" else None
            assert wait(update_checked) == {"state": "ready", "available": None}
            assert call(peer, check_payload, check_id)["Ok"] == {"accepted": True}
            assert "Err" in call(peer, {**check_payload, "force": True}, check_id)
            assert "Err" in call(peer, {**check_payload, "launch_id": str(uuid.uuid4())})
            install_id = str(uuid.uuid4())
            install_payload = {"command": "updateInstall", "vault_id": "other", "launch_id": owner["launch_id"], "update_id": str(uuid.uuid4())}
            assert call(peer, install_payload, install_id)["Ok"]["operation_id"] == install_id
            def update_failed():
                progress = call(peer, {"command": "openStatus", "operation_id": install_id})["Ok"]
                return progress if progress["state"] != "pending" else None
            assert wait(update_failed)["state"] == "failed"
            wait(lambda: status()["quitting"] is None)
            assert call(peer, install_payload, install_id)["Ok"]["operation_id"] == install_id
            assert not (root / "update-restart.json").exists(), "unverified update saved restart state"
            assert worker("other")["launch_id"] == owner["launch_id"], "disabled update closed a worker"
            print("Coordinator update check/retry/identity and disabled installation passed")
            if args.check_update_recovery:
                completed("open", vault_id="capture")
                wait(lambda: status()["active"] == "capture")
                completed("tray", action="markdownNote")
                captures = {}
                def snapshot(vault_id):
                    registered = worker(vault_id)
                    return call(registered["endpoint"], {"command": "snapshotWindows", "launch_id": registered["launch_id"]})["Ok"]
                def restore(vault_id, windows):
                    registered = worker(vault_id)
                    identity = call(registered["endpoint"], {"command": "identify", "launch_id": registered["launch_id"]})["Ok"]
                    operation_id = str(uuid.uuid4())
                    payload = {"command": "restoreWindows", "launch_id": registered["launch_id"], "vault": {
                        "id": vault_id, "directory": identity["directory"], "windows": windows}}
                    assert call(registered["endpoint"], payload, operation_id)["Ok"]["accepted"]
                    def terminal():
                        progress = call(registered["endpoint"], {"command": "restoreStatus", "launch_id": registered["launch_id"], "operation_id": operation_id})["Ok"]
                        return progress if progress["state"] != "pending" else None
                    assert wait(terminal)["state"] == "ready"
                    assert call(registered["endpoint"], payload, operation_id)["Ok"]["accepted"]
                    changed = json.loads(json.dumps(payload))
                    changed["vault"]["windows"][0]["width"] += 1
                    assert "Err" in call(registered["endpoint"], changed, operation_id)
                    return identity
                with sqlite3.connect(root / "profiles/capture/mindstream.db") as db:
                    note_id = db.execute("SELECT id FROM notes WHERE title='Untitled' ORDER BY created DESC LIMIT 1").fetchone()
                    if note_id is None:
                        note_id = db.execute("SELECT id FROM notes ORDER BY created DESC LIMIT 1").fetchone()
                    assert note_id
                    note_id = note_id[0]
                popout_label = note_id if note_id.startswith("note_") else "note_" + note_id
                windows = snapshot("capture")
                windows.append({"label": popout_label, "note_id": note_id, "x": 160, "y": 120, "width": 900, "height": 700,
                    "visible": True, "minimized": False, "maximized": False})
                captures["capture"] = restore("capture", windows)
                hidden = snapshot("other")
                for window in hidden:
                    window["visible"] = False
                captures["other"] = restore("other", hidden)
                saved = [{"id": vault_id, "directory": captures[vault_id]["directory"], "windows": snapshot(vault_id)} for vault_id in vaults]
                call(worker("capture")["endpoint"], {"command": "activate", "window": popout_label})
                wait(lambda: status()["active"] == "capture")
                print("Update fixture ready with visible capture/popout and hidden other vault", flush=True)
                assert call(peer, {"command": "quit"})["Ok"]["accepted"]
                assert host.wait(timeout=190) == 0
                for vault_id in vaults:
                    assert not owned(root / "profiles" / vault_id / ".vault.lock")
                target_version = json.loads((Path(__file__).resolve().parents[2] / "package.json").read_text())["version"]
                journal = {"version": 1, "operation_id": str(uuid.uuid4()), "root": captures["capture"]["root"],
                    "source_version": "fixture-previous-version", "target_version": target_version, "phase": "installing",
                    "vaults": saved, "focus": {"vault_id": "capture", "window": popout_label}, "restored": []}
                with lease(root / ".coordinator.lock"), lease(root / ".root.lock"):
                    (root / "update-restart.json").write_text(json.dumps(journal), encoding="utf-8")
                # Installer auto-launch can inherit the recovery flag from a
                # revived host. Valid update intent must override background mode.
                host = subprocess.Popen([str(args.exe.resolve()), "--supervised-vaults", "--coordinator-recovery"], env=env,
                    stdout=log, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
                peer = wait(endpoint)
                wait(lambda: len(status()["workers"]) == 2 and all(entry["ready"] for entry in status()["workers"]))
                wait(lambda: json.loads((root / "update-restart.json").read_text())["phase"] == "consumed")
                for vault in saved:
                    actual = {window["label"]: window for window in snapshot(vault["id"])}
                    assert set(actual) == {window["label"] for window in vault["windows"]}
                    for expected in vault["windows"]:
                        current = actual[expected["label"]]
                        assert current["visible"] == expected["visible"], current
                        assert current["minimized"] == expected["minimized"], current
                        assert current["maximized"] == expected["maximized"], current
                        assert abs(current["width"] - expected["width"]) <= 2, (current, expected)
                        assert abs(current["height"] - expected["height"]) <= 2, (current, expected)
                wait(lambda: any(entry["id"] == "capture" and entry["window"] == popout_label for entry in status()["workers"]))
                (output / "update-recovered.json").write_text(json.dumps({"vaults": saved, "focus": journal["focus"]}), encoding="utf-8")
                print("Completed update reopened both vaults, restored the popout/hidden state and consumed intent", flush=True)
                if args.wait_for_update_inspection:
                    wait(lambda: (output / "inspect-done").exists(), 190)
                assert call(peer, {"command": "quit"})["Ok"]["accepted"]
                assert host.wait(timeout=190) == 0
                host = subprocess.Popen([str(args.exe.resolve()), "--supervised-vaults"], env=env,
                    stdout=log, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
                peer = wait(endpoint)
                wait(lambda: status()["initialized"] and any(entry["ready"] for entry in status()["workers"]))
                assert len(status()["workers"]) == 1, "consumed update reopened old session again"
                assert status()["workers"][0]["id"] == "capture"
                assert [window["label"] for window in snapshot("capture")] == ["main"]
                assert call(peer, {"command": "quit"})["Ok"]["accepted"]
                assert host.wait(timeout=190) == 0
                with lease(root / ".coordinator.lock"):
                    for vault_id in vaults:
                        with lease(root / "profiles" / vault_id / ".vault.lock"):
                            pass
                print("Normal cold start opened only the last vault; final Quit released all leases")
                clean = True
                return
            if args.check_revival:
                completed("open", vault_id="capture")
                wait(lambda: len(status()["workers"]) == 2 and all(entry["ready"] for entry in status()["workers"]))
                launches = {vault_id: worker(vault_id)["launch_id"] for vault_id in vaults}
                old_instance = peer["instance"]
                before = counts("capture").get("markdown", 0)
                host.terminate()  # Deliberate crash of this fixture's owned Popen.
                assert host.wait(timeout=10) != 0
                revival_started = True
                for vault_id in vaults:
                    assert owned(root / "profiles" / vault_id / ".vault.lock"), "coordinator crash released a live vault lease"
                def replacement():
                    try:
                        record = json.loads((root / "coordinator-endpoint.json").read_text())
                        if record["instance"] == old_instance:
                            return None
                        reply = call(record, {"command": "status"})["Ok"]
                        return record if reply["initialized"] and len(reply["workers"]) == 2 and all(entry["ready"] for entry in reply["workers"]) else None
                    except (OSError, KeyError, FileNotFoundError, json.JSONDecodeError):
                        return None
                peer = wait(replacement)
                assert owned(root / ".coordinator.lock")
                assert {vault_id: worker(vault_id)["launch_id"] for vault_id in vaults} == launches
                for vault_id in vaults:
                    record = worker(vault_id)
                    identity = call(record["endpoint"], {"command": "identify", "launch_id": launches[vault_id]})["Ok"]
                    assert identity["ready"] and identity["vault_id"] == vault_id
                completed("shortcut", command_id="newMarkdownNote")
                assert counts("capture")["markdown"] == before + 1
                print("Automatic coordinator revival adopted both original workers and restored capture")
                quit_id = str(uuid.uuid4())
                assert call(peer, {"command": "quit"}, quit_id)["Ok"]["operation_id"] == quit_id
                wait(lambda: not owned(root / ".coordinator.lock"), 190)
                with lease(root / ".coordinator.lock"):
                    for vault_id in vaults:
                        with lease(root / "profiles" / vault_id / ".vault.lock"):
                            pass
                print("Revived coordinator Quit released every coordinator/vault lease")
                clean = True
                return
            # Tray follows the disabled overall most-recent vault, independent
            # of the sole eligible capture vault selected by system shortcuts.
            recent = worker("other")
            assert "Ok" in call(peer, {"command": "focused", "vault_id": "other", "launch_id": recent["launch_id"], "window": "main"})
            before_tray = counts("other")
            for action, kind in [("markdownNote", "markdown"), ("drawing", "freeform"), ("inkNote", "ink")]:
                before_kind = counts("other").get(kind, 0)
                completed("tray", action=action)
                assert counts("other")[kind] == before_kind + 1
            completed("tray", action="diagram")
            with sqlite3.connect(root / "profiles" / "other" / "mindstream.db") as db:
                assert db.execute("SELECT COUNT(*) FROM notes WHERE title='Untitled diagram' AND body LIKE '%flowchart TD%'").fetchone()[0] == 1
            private_tray = str(uuid.uuid4())
            tray_payload = {"command": "tray", "launch_id": recent["launch_id"], "action": "diagram"}
            first_tray = call(recent["endpoint"], tray_payload, private_tray)
            assert "Ok" in first_tray and first_tray == call(recent["endpoint"], tray_payload, private_tray)
            assert "Err" in call(recent["endpoint"], {"command": "shortcut", "launch_id": recent["launch_id"], "command_id": "newMarkdownNote", "accelerator": None}, private_tray)
            assert counts("other")["markdown"] == before_tray.get("markdown", 0) + 3
            print("Tray targets disabled overall MRU; all templates and private retry isolation passed")
            completed("shortcut", command_id="showApp")
            baseline = {vault_id: counts(vault_id) for vault_id in vaults}
            completed("shortcut", command_id="showApp")
            assert counts("capture") == baseline["capture"], "Show app wrote a note"
            close_all()
            completed("open", vault_id="other")
            # Capture is closed and Other is disabled/foreground.
            assert all(entry["id"] != "capture" for entry in status()["workers"])
            operation = completed("shortcut", command_id="newMarkdownNote")
            assert counts("capture")["markdown"] == baseline["capture"]["markdown"] + 1
            assert counts("other") == baseline["other"], "disabled vault received a note"
            assert call(peer, {"command": "openStatus", "operation_id": operation})["Ok"]["state"] == "ready"
            record = worker("capture")
            private_id = str(uuid.uuid4())
            payload = {"command": "shortcut", "launch_id": record["launch_id"], "command_id": "newDrawing", "accelerator": None}
            first = call(record["endpoint"], payload, private_id)
            assert first == call(record["endpoint"], payload, private_id)
            assert "Ok" in first
            expected = baseline["capture"].get("freeform", 0) + 1
            assert counts("capture")["freeform"] == expected, "retry wrote a second drawing"
            bad = {**payload, "launch_id": str(uuid.uuid4())}
            assert "Err" in call(record["endpoint"], bad)
            bad = {**payload, "command_id": "newInkNote", "accelerator": "CommandOrControl+Alt+KeyK"}
            assert "Err" in call(record["endpoint"], bad)
            assert counts("capture").get("ink", 0) == baseline["capture"].get("ink", 0)
            completed("shortcut", command_id="newInkNote", accelerator="CommandOrControl+Alt+KeyI")
            assert counts("capture")["ink"] == baseline["capture"].get("ink", 0) + 1
            print("Closed capture routing, all note kinds, Show app and root/worker retry checks passed")
            close_all()
            enabled("capture", False)
            # With zero shortcut eligibility and no open windows, tray capture
            # still reopens the overall last-used vault.
            recent_closed = json.loads((root / "profiles.json").read_text())["active"]
            before_closed = counts(recent_closed).get("markdown", 0)
            completed("tray", action="markdownNote")
            assert counts(recent_closed)["markdown"] == before_closed + 1
            close_all()
            failed_id = str(uuid.uuid4())
            assert "Ok" in call(peer, {"command": "shortcut", "command_id": "newMarkdownNote"}, failed_id)
            failure = wait(lambda: (progress if (progress := call(peer, {"command": "openStatus", "operation_id": failed_id})["Ok"])["state"] != "pending" else None))
            assert failure["state"] == "failed" and "enabled" in failure["message"]
            assert status()["shortcutRegistration"]["error"], "action failure was hidden"
            enabled("other", True)
            before = counts("other")
            completed("shortcut", command_id="newDrawing")
            assert counts("other")["freeform"] == before.get("freeform", 0) + 1
            recent = worker("other")
            assert "Ok" in call(peer, {"command": "focused", "vault_id": "other", "launch_id": recent["launch_id"], "window": "main"})
            close_all()
            enabled("capture", True)
            before = counts("other")
            completed("shortcut", command_id="newInkNote")
            assert counts("other")["ink"] == before.get("ink", 0) + 1
            print("Zero eligibility fails visibly; closed eligible MRU routing passed")
            completed("open", vault_id="capture")
            wait(lambda: len(status()["workers"]) == 2 and all(entry["ready"] for entry in status()["workers"]))
            if args.wait_for_external_quit:
                (output / "quit-ready.json").write_text(json.dumps({"host_pid": host.pid, "vaults": vaults}), encoding="utf-8")
                print("Both workers ready for external Quit", flush=True)
            else:
                quit_id = str(uuid.uuid4())
                assert call(peer, {"command": "quit"}, quit_id)["Ok"] == {"accepted": True, "operation_id": quit_id}
            # Actual coordinator exit is required, then acquire every physical
            # vault lease. Lost IPC replies alone prove neither condition.
            assert host.wait(timeout=190) == 0
            with lease(root / ".coordinator.lock"):
                for vault_id in vaults:
                    with lease(root / "profiles" / vault_id / ".vault.lock"):
                        pass
            print("Whole-app Quit closed both workers and released coordinator/vault leases")
            if not args.wait_for_external_quit:
                for vault_id in vaults:
                    enabled(vault_id, False)
                with lease(root / ".root.lock"):
                    path = root / "desktop-settings.json"
                    document = json.loads(path.read_text())
                    document["close_to_tray"] = False
                    document["revision"] = document.get("revision", 0) + 1
                    temporary = path.with_suffix(".fixture-next")
                    temporary.write_text(json.dumps(document), encoding="utf-8")
                    temporary.replace(path)
                host = subprocess.Popen([str(args.exe.resolve()), "--supervised-vaults"], env=env,
                    stdout=log, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
                (output / "host.pid").write_text(str(host.pid), encoding="utf-8")
                peer = wait(endpoint)
                wait(lambda: status()["initialized"] and any(entry["ready"] for entry in status()["workers"]))
                completed("open", vault_id="capture")
                completed("open", vault_id="other")
                for vault_id in vaults:
                    record = worker(vault_id)
                    assert call(record["endpoint"], {"command": "close", "launch_id": record["launch_id"]})["Ok"]["accepted"]
                    if vault_id == "capture":
                        wait(lambda: all(entry["id"] != vault_id for entry in status()["workers"]))
                        assert host.poll() is None, "coordinator exited with another vault still open"
                assert host.wait(timeout=190) == 0
                with lease(root / ".coordinator.lock"):
                    for vault_id in vaults:
                        with lease(root / "profiles" / vault_id / ".vault.lock"):
                            pass
                print("Last vault close exits coordinator with no eligible shortcuts and close-to-tray off")
            clean = True
        finally:
            # Graceful close retains every worker's real ownership until it exits.
            # Leave failed/hung fixtures alive for inspection rather than guessing
            # from PIDs or force-releasing another process's vault lease.
            if peer and not clean:
                try:
                    if revival_started:
                        call(peer, {"command": "quit"})
                        wait(lambda: not owned(root / ".coordinator.lock"), 190)
                    else:
                        close_all()
                    clean = True
                except (OSError, AssertionError, KeyError):
                    pass
            if clean and host.poll() is None:
                host.terminate()
                host.wait(timeout=10)
            elif not clean:
                print(f"Fixture retained for inspection; owned coordinator PID {host.pid}")
        print(f"Native shortcut checks passed; workers exited and artifacts retained at {output}")


if __name__ == "__main__":
    main()
