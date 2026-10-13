#!/usr/bin/env python3
"""Prepare and verify isolated Linux fixtures around an externally requested VM reset.

Run prepare on a disposable QA VM, stream settings receipts to another host, reset
the VM without guest shutdown, then run verify with that host's last receipt.
This checks durable checkpoint recovery, not every possible power-loss instant.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import time

spec = importlib.util.spec_from_file_location("handoff", Path(__file__).with_name("supervised-handoff-check.py"))
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)


def document(path, value):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    sync_directory(path.parent)


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def boot_id():
    return Path("/proc/sys/kernel/random/boot_id").read_text().strip()


class Reopened(h.Fixture):
    def __init__(self, output, exe):
        self.output = output.resolve()
        self.root = self.output / "root"
        self.exe = exe.resolve()
        self.env = os.environ.copy()
        self.env.update(MINDSTREAM_ROOT_DIR=str(self.root),
                        XDG_DATA_HOME=str(self.output / "xdg-data"),
                        XDG_CACHE_HOME=str(self.output / "xdg-cache"))
        self.children = []
        self.log = (self.output / "after-reset.log").open("w")
        self.launch()
        h.wait(lambda: self.status()["initialized"])


def prepare(args):
    args.output.mkdir(parents=True, exist_ok=False)
    fixtures = []
    for name, phase in [("handoff-preparing", "preparing"), ("handoff-source-closed", "closing")]:
        fixture = h.Fixture(args.output / name, args.exe)
        fixtures.append(fixture)
        record = fixture.setup_recovery(phase)
        if phase == "closing":
            fixture.close("source", record["source_close"])
        # setup_recovery already flushes the journal file. Flush its rename too.
        sync_directory(fixture.root)
    for boundary in ["files-preserved", "resources-published", "database-installed"]:
        output = args.output / boundary
        root = output / "root"
        for name in ["source", "target"]:
            (root / "profiles" / name).mkdir(parents=True)
        document(root / "profiles.json", {"active": "source", "profiles": [
            {"id": name, "name": name, "created_at": "2026-10-13T00:00:00Z"}
            for name in ["source", "target"]]})
        env = os.environ.copy()
        env.update(MINDSTREAM_BACKUP_FIXTURE_ROOT=str(root),
                   MINDSTREAM_BACKUP_FIXTURE_BOUNDARY=boundary)
        with (output / "prepare.log").open("w") as log:
            subprocess.run([str(args.test_exe), "backup::portable_tests::produce_native_restore_fixture",
                            "--ignored", "--exact", "--test-threads=1"],
                           env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
    settings = args.output / "settings"
    settings.mkdir()
    with (settings / "reset-fixture.owner").open("xb") as stream:
        stream.write(b"mindstream-qa-v1")
        stream.flush()
        os.fsync(stream.fileno())
    sync_directory(settings)
    document(args.output / "ready.json", {"boot_id": boot_id(), "cases": 5})
    print("RESET_READY " + str(args.output), flush=True)
    # Keep coordinators alive at their prepared checkpoints until the VM reset.
    while True:
        assert all(f.process.poll() is None for f in fixtures)
        time.sleep(1)


def titles(vault):
    with sqlite3.connect(vault / "mindstream.db") as conn:
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        return [row[0] for row in conn.execute("SELECT title FROM notes ORDER BY title")]


def verify_restore(fixture):
    vault = fixture.root / "profiles/source"
    assert titles(vault) == ["Portable note"]
    assert not (vault / "pending-restore.flag").exists()
    assert (vault / "plugin-data/com.test.portable/state.json").read_bytes() == b'{"counter":9}'
    assert (vault / "plugin-data/com.test.portable/empty").is_dir()
    assert json.loads((vault / "content-settings.json").read_text())["values"]["appearance.editorFontSize"] == 19
    settings = json.loads((fixture.root / "ui-settings.json").read_text())["values"]
    assert settings["appearance.accent"] == "#abcdef"
    assert settings["appearance.preset"] == "portable-theme"
    desktop = json.loads((fixture.root / "desktop-settings.json").read_text())
    assert desktop["language_code"] == "de" and desktop["theme_mode"] == "dark"
    assert any(p.joinpath("plugin-data/before").read_bytes() == b"old native data"
               for p in (vault / "backups").glob("pre-restore-files-*"))
    with sqlite3.connect(vault / "mindstream.db") as conn:
        enabled, accepted = conn.execute("SELECT enabled, accepted_hash FROM plugins WHERE id='com.test.portable'").fetchone()
        assert not enabled and not accepted
        assert conn.execute("SELECT COUNT(*) FROM sync_state").fetchone()[0] == 0
    fixture.operation("open", vault_id="target")
    h.wait(lambda: fixture.ready("target"))
    assert titles(fixture.root / "profiles/target") == ["Other vault unchanged"]


def verify(args):
    ready = json.loads((args.output / "ready.json").read_text())
    assert ready["boot_id"] != boot_id(), "VM has not rebooted since preparation"
    receipt = json.loads(args.receipt.read_text())
    settings = json.loads((args.output / "settings/ui-settings.json").read_text())
    assert settings["revision"] >= receipt["revision"], (settings, receipt)
    sequence = receipt["sequence"] + settings["revision"] - receipt["revision"]
    assert settings["values"]["appearance.uiFontSize"] == 12 + sequence % 7
    assert settings["values"]["appearance.accent"] == "#abcdef"
    print(f"Durable settings retained receipt {receipt['revision']}; recovered {settings['revision']}", flush=True)
    for name in ["handoff-preparing", "handoff-source-closed",
                 "files-preserved", "resources-published", "database-installed"]:
        fixture = Reopened(args.output / name, args.exe)
        try:
            if name.startswith("handoff-"):
                selected = "source" if name == "handoff-preparing" else "target"
                phase = "cancelled" if selected == "source" else "completed"
                h.wait(lambda: fixture.journal().get("phase") == phase)
                h.wait(lambda: fixture.ready(selected))
                assert [w["id"] for w in fixture.status()["workers"]] == [selected]
                other = "target" if selected == "source" else "source"
                assert not h.owned(fixture.root / "profiles" / other / ".vault.lock")
                titles(fixture.root / "profiles" / selected)
            else:
                verify_restore(fixture)
            print("Reset recovery passed: " + name, flush=True)
        finally:
            fixture.cleanup()
        # A second cold launch must not replay the consumed operation.
        fixture = Reopened(args.output / name, args.exe)
        try:
            if not name.startswith("handoff-"):
                assert titles(fixture.root / "profiles/source") == ["Portable note"]
                assert titles(fixture.root / "profiles/target") == ["Other vault unchanged"]
        finally:
            fixture.cleanup()
    document(args.output / "verified.json", {"boot_id": boot_id(), "receipt": receipt, "recovered_revision": settings["revision"]})
    print("All reset fixtures passed and released their leases", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["prepare", "verify"])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--exe", type=Path, required=True)
    parser.add_argument("--test-exe", type=Path)
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args()
    assert os.name == "posix" and Path("/proc/sys/kernel/random/boot_id").is_file()
    args.output = args.output.resolve()
    args.exe = args.exe.resolve()
    if args.mode == "prepare":
        assert args.test_exe, "--test-exe required for prepare"
        args.test_exe = args.test_exe.resolve()
        prepare(args)
    else:
        assert args.receipt, "--receipt required for verify"
        verify(args)


if __name__ == "__main__":
    main()
