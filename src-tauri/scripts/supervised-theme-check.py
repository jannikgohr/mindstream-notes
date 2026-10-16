"""Root appearance across real vaults, a popout, missing presets and restart.

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


class Fixture(h.Fixture):
    def launch(self):
        if not self.children:
            (self.root / "desktop-settings.json").write_text(json.dumps({"close_to_tray": True, "theme_mode": "light"}))
            (self.root / "ui-settings.json").write_text(json.dumps({"version": 1, "revision": 0, "values": {"appearance.preset": "warm"}}))
            for name, accent, font, editor in [("source", "#112233", 14, 20), ("target", "#abcdef", 18, 22)]:
                (self.root / "profiles" / name / "content-settings.json").write_text(json.dumps({"version": 1, "revision": 0, "values": {"appearance.accent": accent, "appearance.uiFontSize": font, "appearance.editorFontSize": editor}}))
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


def state(handle):
    select_window(handle)
    return execute("const root=document.documentElement;return {preset:root.dataset.themePreset,dark:root.classList.contains('dark'),font:getComputedStyle(root).fontSize,editor:root.style.getPropertyValue('--editor-font-size'),accent:root.style.getPropertyValue('--accent-brand'),surface:root.style.getPropertyValue('--surface-1')};")


def check_windows(handles, preset, font, dark, accent=None):
    def ready():
        states = [state(handle) for handle in handles]
        return states if all(item["preset"] == preset and item["font"] == f"{font}px" and item["dark"] == dark and (accent is None or item["accent"] == accent) for item in states) else None
    return h.wait(ready)


def patch(id, value=None, remove=False):
    return invoke("patch_ui_setting", expectedVaultId="source", id=id, value=value, remove=remove)


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--exe", type=Path, default=Path(__file__).resolve().parents[1] / "target/debug/mindstream-notes.exe")
args = parser.parse_args()
assert os.name == "nt", "this fixture needs WebView2"
driver_port = port()
sessions = {}
fixture = Fixture(args.output, args.exe)
driver_log = (fixture.output / "webdriver.log").open("w", encoding="utf-8")
driver = subprocess.Popen(["msedgedriver", f"--port={driver_port}"], stdout=driver_log, stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)
try:
    h.wait(lambda: request("/status"))
    session = attach("source")
    source = h.wait(lambda: find_window("source"))
    check_windows([source], "warm", 14, False, "#112233")
    geometry = next(window for window in fixture.windows("source") if window["label"] == "main")
    popout = {**geometry, "label": "note_seed_sprint", "note_id": "seed_sprint", "visible": True}
    operation = h.uid()
    assert "Ok" in fixture.private("source", "restoreWindows", operation, vault={"id": "source", "directory": fixture.identity("source")["directory"], "windows": [geometry, popout]})
    h.wait(lambda: fixture.private("source", "restoreStatus", operation_id=operation)["Ok"]["state"] == "ready")
    note = h.wait(lambda: find_window("source", "seed_sprint"))
    fixture.operation("open", vault_id="target")
    attach("target")
    target = h.wait(lambda: find_window("target"))
    states = check_windows([source, note, target], "warm", 14, False, "#112233")
    assert [item["editor"] for item in states] == ["20px", "20px", "22px"], states
    select_window(source)
    patch("appearance.accent", remove=True)
    invoke("set_desktop_theme_mode", mode="dark")
    patch("appearance.uiFontSize", 17)
    states = check_windows([source, note, target], "warm", 17, True)
    assert all(item["accent"].startswith("oklch(") for item in states), states
    print("Root accent/font and mode reached both vaults and the popout; editor typography stayed separate", flush=True)

    select_window(source)
    execute("document.querySelector('button[aria-label=\"Open settings\"]').click();return true;")
    h.wait(lambda: execute("const button=Array.from(document.querySelectorAll('button')).find(button=>button.innerText.trim()==='Appearance');if(!button)return false;button.click();return true;"))
    h.wait(lambda: execute("const select=document.querySelector('select[aria-label=\"Theme preset\"]');if(!select)return false;select.value='forest';select.dispatchEvent(new Event('change',{bubbles:true}));return true;"))
    check_windows([source, note, target], "forest", 17, True)
    select_window(source)
    execute("Array.from(document.querySelectorAll('button')).find(button=>button.innerText.trim()==='Show preset JSON').click();return true;")
    h.wait(lambda: execute("const input=document.querySelector('textarea[aria-label=\"Preset JSON\"]');if(!input?.value)return false;const preset=JSON.parse(input.value);preset.id='qa-forest';preset.name='QA Forest';input.value=JSON.stringify(preset);input.dispatchEvent(new Event('input',{bubbles:true}));return true;"))
    execute("Array.from(document.querySelectorAll('button')).find(button=>button.innerText.trim()==='Save preset').click();return true;")
    check_windows([source, note, target], "qa-forest", 17, True)
    select_window(source)
    (fixture.output / "custom-preset.png").write_bytes(base64.b64decode(request(session + "/screenshot")))
    custom = next(preset for preset in invoke("list_theme_presets") if preset["id"] == "qa-forest")
    invoke("delete_theme_preset", id="qa-forest")
    check_windows([source, note, target], "default", 17, True)
    root_values = json.loads((fixture.root / "ui-settings.json").read_text())["values"]
    assert root_values["appearance.preset"] == "qa-forest"
    assert "appearance.accent" not in root_values
    for name, accent in [("source", "#112233"), ("target", "#abcdef")]:
        assert json.loads((fixture.root / "profiles" / name / "content-settings.json").read_text())["values"]["appearance.accent"] == accent
    select_window(source)
    invoke("save_theme_preset", raw=json.dumps(custom))
    check_windows([source, note, target], "qa-forest", 17, True)
    print("Real preset selection/import worked; removal used a fallback without clearing selection or source values", flush=True)

    assert "Ok" in h.call(fixture.endpoint(), {"command": "quit"})
    h.wait(lambda: not h.owned(fixture.root / ".coordinator.lock"), 190)
    for name in ["source", "target"]:
        h.wait(lambda: not h.owned(fixture.root / "profiles" / name / ".vault.lock"))
    fixture.launch()
    active = json.loads((fixture.root / "profiles.json").read_text())["active"]
    h.wait(lambda: fixture.ready(active))
    session = attach(active)
    reopened = h.wait(lambda: find_window(active))
    result = check_windows([reopened], "qa-forest", 17, True)
    (fixture.output / "restarted-state.json").write_text(json.dumps(result))
    print("Cold startup restored the custom preset, mode and root font size without importing another vault's legacy values", flush=True)
except Exception as error:
    print(type(error).__name__, error, flush=True)
    raise
finally:
    try:
        fixture.cleanup()
    finally:
        driver.terminate()
        driver.wait(timeout=10)
        driver_log.close()
