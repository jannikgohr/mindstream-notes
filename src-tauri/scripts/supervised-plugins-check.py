"""Global plugin ownership, approvals, updates and restart across real vaults.

Windows WebView2 checks use a disposable root and its own debugging port.
Only the owned WebDriver process is terminated; apps exit through authenticated Quit.
"""
import argparse
import base64
import importlib.util
import json
import hashlib
import os
from pathlib import Path
import socket
import subprocess
import urllib.error
import urllib.request

spec = importlib.util.spec_from_file_location("handoff", Path(__file__).with_name("supervised-handoff-check.py"))
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


ROOT = Path(__file__).resolve().parents[2]
PLUGIN = "com.test.global"
ARTIFACT = b"global artifact bytes"
ARTIFACT_HASH = hashlib.sha256(ARTIFACT).hexdigest()
COMPONENT = None


def component():
    # The conformance plugin's `echo` export returns its input, which carries
    # the backend's merged `settings`.
    global COMPONENT
    if COMPONENT is None:
        out = ROOT / ".output/plugin-fixtures"
        subprocess.run(["node", str(ROOT / "plugin-sdk/fixtures.mjs"), "--out", str(out), "conformance-rust"], check=True)
        COMPONENT = (out / "conformance-rust.wasm").read_bytes()
    return COMPONENT


def write_package(path, note="first package"):
    path.mkdir(parents=True, exist_ok=True)
    manifest = {"manifestVersion":2,"id":PLUGIN,"name":"Global QA","version":"1.0.0","runtime":"wasm","entry":"plugin.wasm","permissions":["pluginArtifacts.download"],"contributes":{"artifacts":[{"id":"data","kind":"data","version":"1","url":"https://example.invalid/data.bin","sha256":ARTIFACT_HASH,"fileName":"data.bin","sizeBytes":len(ARTIFACT)}],"i18n":{"en":{"qa":"QA","device":"Device value","vault":"Vault value"}},"settings":[{"sectionId":"qa","titleKey":"qa","settings":[{"id":"device","scope":"D","type":"text","labelKey":"device","default":"default"},{"id":"vault","scope":"V","type":"text","labelKey":"vault","default":"default"}]}]}}
    (path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (path / "plugin.wasm").write_bytes(component())
    # A changed asset gives an update new bytes under the same version.
    (path / "notes.txt").write_text(note, encoding="utf-8")


def snapshot():
    settings = invoke("plugins_run_script", id=PLUGIN, export="echo", input={})["settings"]
    return {key: settings.get(key) for key in ("device", "vault")}


class Fixture(h.Fixture):
    def launch(self):
        if not self.children:
            write_package(self.root / "profiles/source/plugins/qa")
            artifact = self.root / "profiles/source/plugin-artifacts" / PLUGIN / "data/1/data.bin"
            artifact.parent.mkdir(parents=True, exist_ok=True)
            artifact.write_bytes(ARTIFACT)
        self.env["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = "--remote-debugging-port=0"
        super().launch()


def request(path, payload=None):
    req = urllib.request.Request(f"http://127.0.0.1:{driver_port}{path}", data=None if payload is None else json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=35) as response:
            return json.load(response)["value"]
    except urllib.error.HTTPError as error:
        raise RuntimeError(error.read().decode()) from error


def debugger_port(vault):
    record = fixture.worker(vault)
    digest = hashlib.sha256()
    for value in [record["root"].encode(), record["vault_id"].encode(), record["directory"].encode()]:
        digest.update(len(value).to_bytes(8, "big"))
        digest.update(value)
    path = fixture.root / "webview-stores" / digest.hexdigest() / "EBWebView" / "DevToolsActivePort"
    def read():
        try:
            return int(path.read_text().splitlines()[0])
        except (OSError, ValueError, IndexError):
            return None
    return h.wait(read)


def attach(vault):
    address = f"127.0.0.1:{debugger_port(vault)}"
    endpoint = "/session/" + request("/session", {"capabilities": {"alwaysMatch": {"browserName": "MicrosoftEdge", "ms:edgeOptions": {"debuggerAddress": address}}}})["sessionId"]
    sessions[vault] = endpoint
    return endpoint


def select_window(handle):
    global session
    session = handle[0]
    request(session + "/window", {"handle": handle[1]})


def execute(script, *args):
    return request(session + "/execute/sync", {"script": script, "args": list(args)})


def invoke(command, **args):
    result = request(session + "/execute/async", {"script": "const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]).then(done,error=>done({error}));", "args": [command, args]})
    assert not isinstance(result, dict) or "error" not in result, result
    return result


def find_window(vault, note=None):
    global session
    session = sessions[vault]
    for handle in request(session + "/window/handles"):
        request(session + "/window", {"handle": handle})
        try:
            active = invoke("list_profiles")["active"]
            search = execute("return location.search;")
            if active == vault and ((note is None and not search) or (note and note in search)):
                return (session, handle)
        except (RuntimeError, AssertionError, KeyError):
            continue
    return None


parser = argparse.ArgumentParser(description="Global plugin packages in two real vault workers")
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--exe", type=Path, default=Path(__file__).resolve().parents[1] / "target/debug/mindstream-notes.exe")
args = parser.parse_args()
assert os.name == "nt", "this fixture needs WebView2"
driver_port = port()
sessions = {}
fixture = Fixture(args.output, args.exe)
driver_log = (fixture.output / "webdriver.log").open("w", encoding="utf-8")
driver = subprocess.Popen(["msedgedriver", f"--port={driver_port}"], stdout=driver_log, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)

def record(handle):
    select_window(handle)
    return next(item for item in invoke("plugins_list") if item["id"] == PLUGIN)

def settings(handle):
    select_window(handle)
    return invoke("plugins_settings_all", id=PLUGIN)

try:
    h.wait(lambda: request("/status"))
    attach("source")
    source = h.wait(lambda: find_window("source"))
    h.wait(lambda: not record(source)["enabled"])
    select_window(source)
    invoke("plugins_approve", id=PLUGIN)
    assert bytes(invoke("plugins_read_artifact", id=PLUGIN, artifactId="data")) == ARTIFACT
    invoke("plugins_settings_set", id=PLUGIN, key="device", value="shared")
    invoke("plugins_settings_set", id=PLUGIN, key="vault", value="source-only")
    fixture.operation("open", vault_id="target")
    attach("target")
    target = h.wait(lambda: find_window("target"))
    assert not record(target)["enabled"], "approval must not cross vaults"
    assert settings(target)["device"] == "shared"
    assert "vault" not in settings(target)
    select_window(target)
    invoke("plugins_approve", id=PLUGIN)
    invoke("plugins_settings_set", id=PLUGIN, key="vault", value="target-only")
    select_window(source)
    assert snapshot() == {"device":"shared","vault":"source-only"}
    select_window(target)
    assert snapshot() == {"device":"shared","vault":"target-only"}
    select_window(source)
    invoke("plugins_disable", id=PLUGIN)
    assert record(target)["enabled"]
    select_window(source)
    invoke("plugins_enable", id=PLUGIN)
    execute("document.querySelector('button[aria-label=\"Open settings\"]').click();return true;")
    h.wait(lambda: execute("const button=Array.from(document.querySelectorAll('button')).find(button=>button.innerText.trim()==='Plugins');if(!button)return false;button.click();return true;"))
    h.wait(lambda: execute("return document.body.innerText.includes('Global QA') && document.body.innerText.includes('Packages and updates are shared');"))
    (fixture.output / "plugin-management.png").write_bytes(base64.b64decode(request(session + "/screenshot")))
    print("Root discovery, independent approvals/disable, shared D settings and vault-specific script context passed", flush=True)

    update = fixture.output / "update-package"
    write_package(update, "changed bytes, same declared version")
    select_window(source)
    invoke("plugins_install", sourcePath=str(update))
    h.wait(lambda: not record(target)["enabled"])
    h.wait(lambda: not record(source)["enabled"])
    select_window(source)
    invoke("plugins_approve", id=PLUGIN)
    select_window(target)
    invoke("plugins_approve", id=PLUGIN)
    fixture.close("target", h.uid())
    select_window(source)
    invoke("plugins_remove", id=PLUGIN)
    managed_artifact = fixture.root / "plugin-artifacts" / PLUGIN / "data/1" / ARTIFACT_HASH / "data.bin"
    h.wait(lambda: not managed_artifact.exists())
    assert (fixture.root / "profiles/source/plugins/qa/plugin.wasm").exists()
    invoke("plugins_install", sourcePath=str(update))
    h.wait(lambda: not record(source)["enabled"])
    fixture.operation("open", vault_id="target")
    attach("target")
    target = h.wait(lambda: find_window("target"))
    h.wait(lambda: not record(target)["enabled"])
    assert record(target)["acceptedHash"] == ""
    assert settings(target) == {"device":"shared","vault":"target-only"}
    print("Same-version update gated both workers; reinstall gated an unopened vault and preserved configuration", flush=True)

    select_window(source)
    invoke("plugins_settings_remove", id=PLUGIN, key="device")
    h.wait(lambda: "device" not in settings(target))
    assert "device" not in settings(source)
    assert "Ok" in h.call(fixture.endpoint(), {"command":"quit"})
    h.wait(lambda: not h.owned(fixture.root / ".coordinator.lock"), 190)
    for name in ["source", "target"]:
        h.wait(lambda: not h.owned(fixture.root / "profiles" / name / ".vault.lock"))
    fixture.launch()
    active = json.loads((fixture.root / "profiles.json").read_text())["active"]
    h.wait(lambda: fixture.ready(active))
    attach(active)
    reopened = h.wait(lambda: find_window(active))
    assert not record(reopened)["enabled"]
    assert "device" not in settings(reopened)
    (fixture.output / "restart-state.json").write_text(json.dumps({"record":record(reopened),"settings":settings(reopened)}), encoding="utf-8")
    print("Cold restart retained the approval gate and the device-setting reset", flush=True)
finally:
    try:
        fixture.cleanup()
    finally:
        driver.terminate()
        driver.wait(timeout=10)
        driver_log.close()
