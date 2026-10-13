"""Desktop handoff/recovery checks using disposable roots and real workers.

Requires an embedded debug/e2e-data-dir build. Records, logs and databases are
retained. Fault injection kills only the coordinator created by this fixture.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import time
import uuid

spec = importlib.util.spec_from_file_location("native_checks", Path(__file__).with_name("supervised-shortcuts-check.py"))
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
call, wait, owned, lease = helpers.call, helpers.wait, helpers.owned, helpers.lease


def uid():
    return str(uuid.uuid4())


class Fixture:
    check_focus = False
    def __init__(self, output, exe, missing=False):
        self.output = output.resolve()
        self.output.mkdir(parents=True, exist_ok=False)
        self.root = self.output / "root"
        self.root.mkdir()
        for name in ["source", "target"]:
            if not (missing and name == "source"):
                (self.root / "profiles" / name).mkdir(parents=True)
        (self.root / "profiles.json").write_text(json.dumps({"active": "source", "profiles": [
            {"id": name, "name": name, "created_at": "2026-10-12T00:00:00Z"} for name in ["source", "target"]]}))
        (self.root / "desktop-settings.json").write_text(json.dumps({"close_to_tray": True}))
        self.env = os.environ.copy()
        self.env["MINDSTREAM_ROOT_DIR"] = str(self.root)
        self.env["WEBVIEW2_USER_DATA_FOLDER"] = str(self.output / "legacy-webview")
        if os.name != "nt":
            self.env["XDG_DATA_HOME"] = str(self.output / "xdg-data")
            self.env["XDG_CACHE_HOME"] = str(self.output / "xdg-cache")
        self.exe = exe.resolve()
        self.log = (self.output / "native.log").open("w", encoding="utf-8")
        self.children = []
        self.launch()
        if not missing:
            wait(lambda: self.ready("source"))
            time.sleep(0.25)

    def launch(self):
        process = subprocess.Popen([str(self.exe), "--supervised-vaults"], env=self.env,
            stdout=self.log, stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        self.children.append(process)
        self.process = process
        (self.output / f"host-{len(self.children)}.pid").write_text(str(process.pid))
        wait(lambda: self.endpoint())

    def endpoint(self):
        try:
            peer = json.loads((self.root / "coordinator-endpoint.json").read_text())
            return peer if "Ok" in call(peer, {"command": "status"}) else None
        except (OSError, KeyError, json.JSONDecodeError):
            return None

    def status(self):
        return call(self.endpoint(), {"command": "status"})["Ok"]

    def ready(self, name):
        try:
            return self.status()["initialized"] and any(entry["id"] == name and entry["ready"]
                for entry in self.status()["workers"])
        except (OSError, KeyError, TypeError):
            return False

    def worker(self, name):
        return json.loads((self.root / "worker-registrations" / f"{name}.json").read_text())

    def private(self, name, command, request_id=None, **fields):
        worker = self.worker(name)
        return call(worker["endpoint"], {"command": command, "launch_id": worker["launch_id"], **fields}, request_id)

    def identity(self, name):
        return self.private(name, "identify")["Ok"]

    def windows(self, name):
        return self.private(name, "snapshotWindows")["Ok"]

    def operation(self, command, expected="ready", **fields):
        operation = uid()
        payload = {"command": command, **fields}
        # Readiness can race the last coordinator startup acknowledgement.
        wait(lambda: "Ok" in call(self.endpoint(), payload, operation))
        def terminal():
            progress = call(self.endpoint(), {"command": "openStatus", "operation_id": operation})["Ok"]
            return progress if progress["state"] != "pending" else None
        progress = wait(terminal, 300)
        assert progress["state"] == expected, progress
        assert "Ok" in call(self.endpoint(), payload, operation), "retry lost its terminal receipt"
        return operation

    def handoff(self, expected="ready", target="target"):
        source = self.worker("source")
        return self.operation("handoffFromWindow", expected=expected, source_vault_id="source",
            launch_id=source["launch_id"], vault_id=target)

    def journal(self):
        try:
            return json.loads((self.root / "vault-handoff.json").read_text())
        except (OSError, json.JSONDecodeError):
            return {}

    def observe_focus(self, name):
        if self.check_focus:
            wait(lambda: self.private(name, "testWindowFocus")["Ok"].get("main"), 15)
        focus = self.private(name, "testWindowFocus")["Ok"]
        (self.output / "focus-observed.json").write_text(json.dumps(focus))

    def setup_recovery(self, phase, changed_source=False):
        self.operation("open", vault_id="target")
        source, target = self.identity("source"), self.identity("target")
        geometry = next(window for window in self.windows("source") if window["label"] == "main")
        source_position = {key: geometry[key] for key in ["x", "y"]}
        # Snapshots use physical pixels. Keep fixture requests above GTK's
        # scaled minimum size and on whole logical pixels at integer scaling.
        scale = int(os.environ.get("GDK_SCALE", "1")) if os.name != "nt" else 1
        geometry.update({"x": 135 * scale, "y": 95 * scale, "width": 1020 * scale,
            "height": 740 * scale, "maximized": False})
        if os.environ.get("GDK_BACKEND") == "wayland":
            # Global placement belongs to the compositor; validate saved size.
            geometry.update(source_position)
        prepared = {**geometry, "visible": False, "minimized": False}
        restore = uid()
        assert "Ok" in self.private("target", "restoreWindows", restore, vault={
            "id": "target", "directory": target["directory"], "windows": [prepared]})
        wait(lambda: self.private("target", "restoreStatus", operation_id=restore)["Ok"]["state"] == "ready")
        record = {"version": 1, "root": source["root"], "operation_id": uid(),
            "source": {"id": "source", "directory": source["directory"],
                "launch_id": uid() if changed_source else source["launch_id"]},
            "target": {"id": "target", "directory": target["directory"], "launch_id": target["launch_id"]},
            "geometry": geometry, "source_close": uid(), "target_close": uid(), "restore": uid(), "activation_restore": uid(), "phase": phase}
        with lease(self.root / ".root.lock"):
            pending = self.root / f".handoff-fixture-{uid()}.json"
            with pending.open("x", encoding="utf-8") as stream:
                json.dump(record, stream)
                stream.flush()
                os.fsync(stream.fileno())
            pending.replace(self.root / "vault-handoff.json")
        return record

    def close(self, name, operation):
        assert "Ok" in self.private(name, "close", operation)
        wait(lambda: not owned(self.root / "profiles" / name / ".vault.lock"), 150)
        wait(lambda: all(entry["id"] != name for entry in self.status()["workers"]))

    def crash_coordinator(self):
        old = self.endpoint()["instance"]
        assert self.endpoint()["process_id"] == self.process.pid, "refusing to crash an unowned coordinator"
        self.process.kill()
        assert self.process.wait(timeout=10) != 0
        return old

    def recovered(self, old):
        return wait(lambda: (peer := self.endpoint()) and peer["instance"] != old and self.status()["initialized"])

    def cleanup(self):
        try:
            peer = self.endpoint()
            if peer:
                call(peer, {"command": "quit"})
                wait(lambda: not owned(self.root / ".coordinator.lock"), 190)
            for name in ["source", "target"]:
                lock = self.root / "profiles" / name / ".vault.lock"
                if lock.exists():
                    assert not owned(lock), f"fixture vault {name} remained owned"
            for child in self.children:
                if child.poll() is None:
                    child.wait(timeout=10)
        except (OSError, KeyError, AssertionError, subprocess.TimeoutExpired):
            print(f"Fixture retained for inspection at {self.output}", flush=True)
            raise
        finally:
            self.log.close()


def check(case, fixture):
    if case == "missing-startup":
        assert not fixture.status()["initialized"]
        assert not (fixture.root / "profiles/source").exists()
        fixture.operation("pickerOpen", vault_id="target")
        wait(lambda: fixture.ready("target"))
        assert not (fixture.root / "profiles/source").exists(), "picker recreated the missing vault"
        assert (fixture.root / "profiles/target/mindstream.db").is_file()
        return
    original = fixture.worker("source")["launch_id"]
    if case == "normal":
        geometry = next(window for window in fixture.windows("source") if window["label"] == "main")
        fixture.handoff()
        assert fixture.journal()["phase"] == "completed"
        assert not owned(fixture.root / "profiles/source/.vault.lock")
        assert [worker["id"] for worker in fixture.status()["workers"]] == ["target"]
        target = next(window for window in fixture.windows("target") if window["label"] == "main")
        for field in ["x", "y", "width", "height", "maximized"]:
            assert target[field] == geometry[field], (field, target, geometry)
        assert target["visible"]
        fixture.observe_focus("target")
        with sqlite3.connect(fixture.root / "profiles/source/mindstream.db") as database:
            assert database.execute("SELECT COUNT(*) FROM notes").fetchone()[0] > 0
        return
    if case == "existing":
        fixture.operation("open", vault_id="target")
        before = fixture.windows("target")
        fixture.handoff()
        assert fixture.worker("source")["launch_id"] == original
        assert owned(fixture.root / "profiles/source/.vault.lock")
        assert fixture.windows("target") == before
        assert not fixture.journal()
        return
    if case == "missing":
        fixture.handoff(expected="failed", target="missing")
        assert fixture.worker("source")["launch_id"] == original
        assert not (fixture.root / "profiles/missing").exists()
        assert fixture.status()["handoff"] is None
        return
    if case in ["save-failure", "busy-timeout"]:
        # Leave ample time for target preparation before the 30-second source
        # drain timeout, including under a busy native/container test runner.
        command, fields = ("testCloseFailure", {}) if case == "save-failure" else ("testHoldJob", {"seconds": 60})
        assert "Ok" in fixture.private("source", command, **fields)
        fixture.handoff(expected="failed")
        assert fixture.journal()["phase"] == "cancelled"
        assert fixture.worker("source")["launch_id"] == original
        assert owned(fixture.root / "profiles/source/.vault.lock")
        assert not owned(fixture.root / "profiles/target/.vault.lock")
        assert fixture.status()["handoff"] is None
        return
    phase = "preparing" if case in ["recover-open-source", "recover-changed-source"] else "closing"
    record = fixture.setup_recovery(phase, case == "recover-changed-source")
    if case in ["recover-closed-source", "recover-target-replacement"]:
        fixture.close("source", record["source_close"])
    if case == "recover-target-replacement":
        fixture.close("target", record["target_close"])
    old = fixture.crash_coordinator()
    if case == "recover-target-replacement":
        fixture.launch()
    else:
        fixture.recovered(old)
    terminal = "cancelled" if case in ["recover-open-source", "recover-changed-source"] else "completed"
    wait(lambda: fixture.journal().get("phase") == terminal, 190)
    if terminal == "cancelled":
        assert fixture.worker("source")["launch_id"] == original
        assert owned(fixture.root / "profiles/source/.vault.lock")
        assert not owned(fixture.root / "profiles/target/.vault.lock")
        if case == "recover-open-source":
            assert "Ok" in fixture.private("source", "close", record["source_close"])
            assert fixture.private("source", "closeStatus", operation_id=record["source_close"])["Ok"]["state"] == "failed"
            assert owned(fixture.root / "profiles/source/.vault.lock"), "delayed close escaped cancellation"
    else:
        assert not owned(fixture.root / "profiles/source/.vault.lock")
        def restored_geometry():
            target = next(window for window in fixture.windows("target") if window["label"] == "main")
            (fixture.output / "target-observed.json").write_text(json.dumps(target))
            return target if target["visible"] and all(target[field] == record["geometry"][field]
                for field in ["x", "y", "width", "height"]) else None
        # GTK reports geometry from asynchronous configure notifications.
        wait(restored_geometry, 30)
        fixture.observe_focus("target")
        if case == "recover-target-replacement":
            replacement = fixture.worker("target")
            assert replacement["launch_id"] != record["target"]["launch_id"]
            assert "Err" in call(replacement["endpoint"], {"command": "close", "launch_id": record["target"]["launch_id"]})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--exe", type=Path, default=Path(__file__).resolve().parents[1] / "target/debug/mindstream-notes.exe")
    cases = ["normal", "existing", "missing", "save-failure", "busy-timeout", "recover-open-source",
        "recover-closed-source", "recover-changed-source", "recover-target-replacement", "missing-startup"]
    parser.add_argument("--cases", nargs="+", choices=cases, default=cases)
    parser.add_argument("--check-focus", action="store_true", help="require native foreground focus; run only on an isolated desktop")
    args = parser.parse_args()
    Fixture.check_focus = args.check_focus
    assert os.name in ["nt", "posix"]
    for case in args.cases:
        fixture = Fixture(args.output / case, args.exe, missing=case == "missing-startup")
        try:
            check(case, fixture)
            print(f"Handoff check passed: {case}", flush=True)
        finally:
            fixture.cleanup()
    print(f"Every handoff fixture exited and released its leases. Artifacts: {args.output.resolve()}", flush=True)


if __name__ == "__main__":
    main()
