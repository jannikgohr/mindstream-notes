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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--exe", type=Path, default=Path(__file__).resolve().parents[1] / "target/debug/mindstream-notes.exe")
    parser.add_argument("--wait-for-external-quit", action="store_true", help="wait for external menu or IPC Quit after writing quit-ready.json")
    args = parser.parse_args()
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
            "values": {"hotkeys.globalShortcuts": vault_id == "capture"}}), encoding="utf-8")
    (root / "profiles.json").write_text(json.dumps({"active": "other", "profiles": [
        {"id": vault_id, "name": vault_id, "created_at": "2026-10-11T00:00:00Z"} for vault_id in vaults]}), encoding="utf-8")
    env = os.environ.copy()
    env["MINDSTREAM_ROOT_DIR"] = str(root)
    env["WEBVIEW2_USER_DATA_FOLDER"] = str(output / "legacy-webview")
    with (output / "native.log").open("w", encoding="utf-8") as log:
        host = subprocess.Popen([str(args.exe.resolve()), "--supervised-vaults"], env=env,
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
        try:
            peer = wait(endpoint)
            wait(lambda: status()["initialized"] and any(entry["id"] == "other" and entry["ready"] for entry in status()["workers"]))
            assert status()["contract"]["protocol"] == 5
            assert status()["shortcuts"]["vault_id"] == "capture"
            assert not status()["shortcutRegistration"]["registered"], "test root registered OS shortcuts"
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
            clean = True
        finally:
            # Graceful close retains every worker's real ownership until it exits.
            # Leave failed/hung fixtures alive for inspection rather than guessing
            # from PIDs or force-releasing another process's vault lease.
            if peer and not clean:
                try:
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
