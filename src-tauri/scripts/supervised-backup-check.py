"""Resume a real backend-produced portable restore through desktop startup.

Owns a disposable root. Apps exit via authenticated Quit and release their leases.
The Rust fixture producer exercises export, preview and staging before launch;
native file-picker interaction is not part of this check.
"""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import socket
import subprocess
import urllib.request

spec = importlib.util.spec_from_file_location("handoff", Path(__file__).with_name("supervised-handoff-check.py"))
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)


class Fixture(h.Fixture):
    def launch(self):
        if not getattr(self, "prepared", False):
            assert self.root.resolve().is_relative_to(self.output.resolve())
            self.env["MINDSTREAM_BACKUP_FIXTURE_ROOT"] = str(self.root)
            with (self.output / "prepare.log").open("w", encoding="utf-8") as log:
                subprocess.run([str(args.test_exe.resolve()), "backup::portable_tests::produce_native_restore_fixture", "--ignored", "--exact", "--test-threads=1"], env=self.env, stdout=log, stderr=subprocess.STDOUT, check=True)
            assert (self.root / "profiles/source/pending-restore.flag").is_file()
            self.prepared = True
        super().launch()


def check_restore_ui(fixture):
    """Call the bundled dialog helper and inspect its selection without applying
    a second restore. The native backend round trip is verified separately.
    """
    assert os.name == "nt"
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        driver_port = sock.getsockname()[1]
    log = (fixture.output / "webdriver.log").open("w", encoding="utf-8")
    driver = subprocess.Popen(["msedgedriver", f"--port={driver_port}"], stdout=log, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
    session = None
    def request(path, payload=None):
        req = urllib.request.Request(f"http://127.0.0.1:{driver_port}{path}", data=None if payload is None else json.dumps(payload).encode(), headers={"Content-Type":"application/json"})
        with urllib.request.urlopen(req, timeout=35) as response:
            return json.load(response)["value"]
    def execute(script, *values):
        return request(session + "/execute/sync", {"script":script,"args":list(values)})
    def click_text(texts):
        return execute("const b=Array.from(document.querySelectorAll('button')).find(b=>arguments[0].includes(b.innerText.trim()));if(!b)return false;b.click();return true;", texts)
    locales = [json.loads((Path(__file__).resolve().parents[2] / f"src/lib/settings/i18n/{code}.json").read_text(encoding="utf-8")) for code in ["en", "de"]]
    try:
        h.wait(lambda: request("/status"))
        worker = fixture.worker("source")
        digest = hashlib.sha256()
        for value in [worker["root"].encode(), worker["vault_id"].encode(), worker["directory"].encode()]:
            digest.update(len(value).to_bytes(8, "big")); digest.update(value)
        debug_file = fixture.root / "webview-stores" / digest.hexdigest() / "EBWebView/DevToolsActivePort"
        def debug_port():
            try: return int(debug_file.read_text().splitlines()[0])
            except (OSError, ValueError, IndexError): return None
        address = f"127.0.0.1:{h.wait(debug_port)}"
        session = "/session/" + request("/session", {"capabilities":{"alwaysMatch":{"browserName":"MicrosoftEdge","ms:edgeOptions":{"debuggerAddress":address}}}})["sessionId"]
        preview = {"token":"fixture-preview","backup_counts":{"notes":1,"folders":0,"assets_bytes":0},"current_counts":{"notes":1,"folders":0,"assets_bytes":0},"backup_app_version":"QA","backup_created_at":"2026-10-13T00:00:00Z","same_account":False,"backup_account":None,"current_account":None,"portable":True,"plugin_packages":1,"plugin_data_bytes":13}
        build = Path(__file__).resolve().parents[2] / ".output/build"
        chunks = [path for path in (build / "_app/immutable/chunks").glob("*.js") if "includeDevice:!1" in path.read_text(encoding="utf-8") and "resolve:" in path.read_text(encoding="utf-8")]
        assert len(chunks) == 1, "could not identify the bundled import-choice helper"
        module_path = "/" + chunks[0].relative_to(build).as_posix()
        request(session + "/execute/async", {"script":"const done=arguments[arguments.length-1];const preview=arguments[0];import(new URL(arguments[1],location.href).href).then(module=>{const pick=Object.values(module).find(value=>typeof value==='function'&&value.toString().includes('includeDevice:!1')&&value.toString().includes('new Promise'));if(!pick)return done({error:'dialog helper missing'});const options={includeDevice:false};pick(preview,options).then(choice=>{window.__portableDecision={choice,includeDevice:options.includeDevice};});done(true);}).catch(error=>done({error:String(error)}));","args":[preview,module_path]})
        h.wait(lambda: execute("return !!document.querySelector('input[type=checkbox]');"))
        assert execute("return document.querySelector('input[type=checkbox]').checked;") is False
        (fixture.output / "restore-choice.png").write_bytes(base64.b64decode(request(session + "/screenshot")))
        execute("document.querySelector('input[type=checkbox]').click();return true;")
        assert execute("return document.querySelector('input[type=checkbox]').checked;") is True
        h.wait(lambda: click_text([locale["ui"]["data.import.button.restore"] for locale in locales]))
        h.wait(lambda: execute("return !!window.__portableDecision;"))
        assert execute("return window.__portableDecision;") == {"choice":"restore","includeDevice":True}
        print("Real restore dialog started unchecked and returned the selected shared-device option", flush=True)
    finally:
        driver.terminate(); driver.wait(timeout=10); log.close()


def titles(root, vault):
    database = root / "profiles" / vault / "mindstream.db"
    assert database.is_file()
    with sqlite3.connect(database) as conn:
        return [row[0] for row in conn.execute("SELECT title FROM notes ORDER BY title")]


parser = argparse.ArgumentParser()
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--exe", type=Path, default=Path(__file__).resolve().parents[1] / "target/debug/mindstream-notes.exe")
parser.add_argument("--test-exe", type=Path, required=True)
parser.add_argument("--check-ui", action="store_true")
args = parser.parse_args()
fixture = None
try:
    fixture = Fixture.__new__(Fixture)
    if args.check_ui:
        # Set before launch through the environment copied by the fixture.
        assert os.name == "nt"
        os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = "--remote-debugging-port=0"
    fixture.__init__(args.output, args.exe)
    vault = fixture.root / "profiles/source"
    assert titles(fixture.root, "source") == ["Portable note"]
    assert not (vault / "pending-restore.flag").exists()
    assert (vault / "plugin-data/com.test.portable/state.json").read_bytes() == b'{"counter":9}'
    assert (vault / "plugin-data/com.test.portable/empty").is_dir()
    content = json.loads((vault / "content-settings.json").read_text())
    assert content["values"]["appearance.editorFontSize"] == 19
    device = json.loads((fixture.root / "ui-settings.json").read_text())
    assert device["values"]["appearance.uiFontSize"] == 17
    assert device["values"]["appearance.preset"] == "portable-theme"
    desktop = json.loads((fixture.root / "desktop-settings.json").read_text())
    assert desktop["language_code"] == "de" and desktop["theme_mode"] == "dark"
    catalog = json.loads((fixture.root / "plugins/catalog.json").read_text())
    assert catalog["entries"]["com.test.portable"]["hash"]
    with sqlite3.connect(vault / "mindstream.db") as conn:
        enabled, accepted = conn.execute("SELECT enabled, accepted_hash FROM plugins WHERE id = 'com.test.portable'").fetchone()
        assert not enabled and not accepted
        assert conn.execute("SELECT COUNT(*) FROM sync_state").fetchone()[0] == 0
    assert any(path.joinpath("plugin-data/before").is_file() for path in (vault / "backups").glob("pre-restore-files-*"))
    fixture.operation("open", vault_id="target")
    h.wait(lambda: fixture.ready("target"))
    assert titles(fixture.root, "target") == ["Other vault unchanged"]
    print("Native startup restored the exported vault, kept device conflicts and gated third-party execution", flush=True)
    if args.check_ui: check_restore_ui(fixture)
    assert "Ok" in h.call(fixture.endpoint(), {"command":"quit"})
    h.wait(lambda: not h.owned(fixture.root / ".coordinator.lock"), 190)
    for name in ["source", "target"]:
        h.wait(lambda: not h.owned(fixture.root / "profiles" / name / ".vault.lock"))
    fixture.launch()
    active = json.loads((fixture.root / "profiles.json").read_text())["active"]
    h.wait(lambda: fixture.ready(active))
    assert titles(fixture.root, "source") == ["Portable note"]
    assert titles(fixture.root, "target") == ["Other vault unchanged"]
    assert not (vault / "pending-restore.flag").exists()
    print("Cold restart retained the restored vault and the separate peer vault", flush=True)
finally:
    if fixture and hasattr(fixture, "children"):
        fixture.cleanup()
        print("Backup fixture released every coordinator/vault lease", flush=True)
