#!/usr/bin/env python3
"""Verify a local test-signed Linux AppImage update and concurrent-vault restart.

Both packages must use the supplied QA identifier, the same disposable public key
and a localhost updater endpoint. Run on an isolated desktop and secret-service
session. Never point this fixture at a production app root or production endpoint.
"""
import argparse
import functools
import hashlib
import http.server
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading

spec = importlib.util.spec_from_file_location("handoff", Path(__file__).with_name("supervised-handoff-check.py"))
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)


class Fixture(h.Fixture):
    def __init__(self, output, exe, identifier):
        self.output = output.resolve()
        self.output.mkdir(parents=True, exist_ok=False)
        self.root = self.output / "device" / identifier
        for name in ["source", "target"]:
            (self.root / "profiles" / name).mkdir(parents=True)
        (self.root / "profiles.json").write_text(json.dumps({"active": "source", "profiles": [
            {"id": name, "name": name, "created_at": "2026-10-13T00:00:00Z"} for name in ["source", "target"]]}))
        (self.root / "desktop-settings.json").write_text(json.dumps({"close_to_tray": True}))
        self.exe = self.output / "Mindstream-QA.AppImage"
        shutil.copy2(exe, self.exe)
        self.env = os.environ.copy()
        for key in ["MINDSTREAM_ROOT_DIR", "MINDSTREAM_PROFILE_DIR"]:
            self.env.pop(key, None)
        self.env.update(XDG_DATA_HOME=str(self.output / "device"),
                        XDG_CACHE_HOME=str(self.output / "cache"),
                        XDG_CONFIG_HOME=str(self.output / "config"))
        self.log = (self.output / "native.log").open("w")
        self.children = []
        self.launch()
        h.wait(lambda: self.ready("source"), 180)

    def check_update(self):
        operation = h.uid()
        payload = {"command": "updateCheck", "vault_id": "source",
                   "launch_id": self.worker("source")["launch_id"], "force": True}
        assert "Ok" in h.call(self.endpoint(), payload, operation)
        def terminal():
            reply = h.call(self.endpoint(), {"command": "updateCheckStatus", "operation_id": operation})["Ok"]
            return reply if reply["state"] != "pending" else None
        reply = h.wait(terminal, 120)
        assert reply["state"] == "ready", reply
        assert reply["available"], "QA update was not offered; check build identity and OS integration gating"
        return reply["available"]

    def install(self, offer):
        operation = h.uid()
        assert "Ok" in h.call(self.endpoint(), {"command": "updateInstall", "vault_id": "source",
                             "launch_id": self.worker("source")["launch_id"],
                             "update_id": offer["id"]}, operation)
        return operation


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--old", type=Path, required=True)
    parser.add_argument("--new", type=Path, required=True)
    parser.add_argument("--identifier", default="com.jannikgohr.mindstream-notes.qa")
    parser.add_argument("--old-version", default="0.1.15-qa.1")
    parser.add_argument("--new-version", default="0.1.15-qa.2")
    parser.add_argument("--port", type=int, default=18090)
    args = parser.parse_args()
    assert os.name == "posix" and args.identifier.endswith(".qa")
    args.output = args.output.resolve()
    serve = args.output.with_name(args.output.name + "-server")
    serve.mkdir(parents=True, exist_ok=False)
    shutil.copy2(args.new, serve / "update.AppImage")
    signature = Path(str(args.new) + ".sig").read_text().strip()
    metadata = {"version": args.new_version, "notes": "Disposable local QA update",
                "pub_date": "2026-10-13T00:00:00Z", "platforms": {"linux-x86_64": {
                    "url": f"http://127.0.0.1:{args.port}/update.AppImage", "signature": signature}}}
    def publish(valid):
        value = json.loads(json.dumps(metadata))
        if not valid:
            # A syntactically signed response with a different signed payload.
            value["platforms"]["linux-x86_64"]["signature"] = signature
            (serve / "update.AppImage").write_bytes(args.new.read_bytes() + b"invalid-signature-fixture")
        else:
            shutil.copy2(args.new, serve / "update.AppImage")
        (serve / "latest.json").write_text(json.dumps(value))
    publish(False)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port),
                functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(serve)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    fixture = None
    try:
        fixture = Fixture(args.output, args.old.resolve(), args.identifier)
        fixture.operation("open", vault_id="target")
        main_window = next(w for w in fixture.windows("source") if w["label"] == "main")
        source_windows = [main_window, {**main_window, "label": "note_seed_welcome", "note_id": "seed_welcome",
                                       "width": 900, "height": 620, "x": 170, "y": 120}]
        restore = h.uid()
        assert "Ok" in fixture.private("source", "restoreWindows", restore, vault={
            "id": "source", "directory": fixture.identity("source")["directory"], "windows": source_windows})
        h.wait(lambda: fixture.private("source", "restoreStatus", operation_id=restore)["Ok"]["state"] == "ready")
        target_window = next(w for w in fixture.windows("target") if w["label"] == "main")
        restore = h.uid()
        assert "Ok" in fixture.private("target", "restoreWindows", restore, vault={
            "id": "target", "directory": fixture.identity("target")["directory"],
            "windows": [{**target_window, "visible": False, "minimized": False}]})
        h.wait(lambda: fixture.private("target", "restoreStatus", operation_id=restore)["Ok"]["state"] == "ready")
        fixture.operation("open", vault_id="source")
        old_launches = {name: fixture.worker(name)["launch_id"] for name in ["source", "target"]}
        old_endpoint = fixture.endpoint()["instance"]
        offer = fixture.check_update()
        assert offer["currentVersion"] == args.old_version and offer["version"] == args.new_version, offer
        operation = fixture.install(offer)
        def failed():
            reply = h.call(fixture.endpoint(), {"command": "openStatus", "operation_id": operation})["Ok"]
            return reply if reply["state"] != "pending" else None
        assert h.wait(failed, 180)["state"] == "failed"
        assert not (fixture.root / "update-restart.json").exists()
        assert old_launches == {name: fixture.worker(name)["launch_id"] for name in old_launches}
        assert digest(fixture.exe) == digest(args.old)
        print("Invalid signature rejected before any vault closed or restart intent was written", flush=True)
        publish(True)
        offer = fixture.check_update()
        fixture.install(offer)
        h.wait(lambda: fixture.endpoint() and fixture.endpoint()["instance"] != old_endpoint, 240)
        for name in old_launches:
            h.wait(lambda: fixture.ready(name), 180)
            assert fixture.worker(name)["launch_id"] != old_launches[name]
        h.wait(lambda: json.loads((fixture.root / "update-restart.json").read_text())["phase"] == "consumed", 120)
        assert digest(fixture.exe) == digest(args.new)
        source = fixture.windows("source")
        target = fixture.windows("target")
        assert {w["label"] for w in source} == {"main", "note_seed_welcome"}
        assert all(w["visible"] for w in source)
        assert not next(w for w in target if w["label"] == "main")["visible"]
        for name in old_launches:
            with __import__("sqlite3").connect(fixture.root / "profiles" / name / "mindstream.db") as conn:
                assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        record = json.loads((fixture.root / "update-restart.json").read_text())
        assert record["focus"]["vault_id"] == "source"
        print("Signed AppImage installed; both vaults, source popout and hidden target restored", flush=True)
        fixture.cleanup()
        fixture.log = (fixture.output / "native.log").open("a")
        fixture.launch()
        h.wait(lambda: fixture.ready("source"), 180)
        assert [w["id"] for w in fixture.status()["workers"]] == ["source"]
        assert json.loads((fixture.root / "update-restart.json").read_text())["phase"] == "consumed"
        (fixture.output / "verified.json").write_text(json.dumps({
            "old_version": args.old_version, "new_version": args.new_version,
            "installed_sha256": digest(fixture.exe), "signature_rejection": True,
            "vaults_restored": 2, "popout_restored": True, "hidden_target_restored": True,
            "restart_consumed": True, "cold_start_single_vault": True}, indent=2))
        print("Normal packaged cold startup did not replay the consumed update session", flush=True)
    finally:
        if fixture:
            # cleanup closes its log; reopen after an earlier successful drain.
            if fixture.log.closed:
                fixture.log = (fixture.output / "native.log").open("a")
            fixture.cleanup()
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
