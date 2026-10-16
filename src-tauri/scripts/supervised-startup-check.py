"""Startup hardening checks with disposable roots and real coordinator/worker IPC.

The optional Windows UI check attaches WebDriver only to its isolated picker.
Filesystem faults preserve the original index and never target user directories.
"""
import argparse
import base64
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import urllib.error
import urllib.request

spec = importlib.util.spec_from_file_location("handoff", Path(__file__).with_name("supervised-handoff-check.py"))
handoff = importlib.util.module_from_spec(spec)
spec.loader.exec_module(handoff)


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class PickerFixture(handoff.Fixture):
    debug_port = None

    def launch(self):
        if not self.children:
            preferences = {"close_to_tray": True, "language_code": "de", "theme_mode": "light",
                "custom_window_decorations": True, "future": {"keep": 1}}
            (self.root / "desktop-settings.json").write_text(json.dumps(preferences))
        if self.debug_port:
            self.env["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = f"--remote-debugging-port={self.debug_port}"
        super().launch()


def retry_after_discovery_failure(fixture):
    index = fixture.root / "profiles.json"
    original = fixture.output / "profiles-before-failure.json"
    # Both paths must be owned by this fixture before any directory/file move.
    for path in [index, original]:
        path.resolve().relative_to(fixture.output)
    with handoff.lease(fixture.root / ".root.lock"):
        index.rename(original)
        index.mkdir()
    try:
        fixture.operation("pickerOpen", expected="failed", vault_id="target")
        assert not fixture.status()["initialized"]
        assert not (fixture.root / "profiles/target/mindstream.db").exists()
    finally:
        with handoff.lease(fixture.root / ".root.lock"):
            index.rmdir()  # Only the empty directory created above, never recursive.
            index.write_bytes(original.read_bytes())
    fixture.operation("pickerOpen", vault_id="target")
    handoff.wait(lambda: fixture.ready("target"))
    assert not (fixture.root / "profiles/source").exists()
    print("Failed discovery published a terminal receipt; picker retry opened the target", flush=True)


def surviving_worker(fixture):
    fixture.operation("open", vault_id="target")
    launch_id = fixture.worker("target")["launch_id"]
    fixture.close("source", handoff.uid())
    fixture.crash_coordinator()
    missing = fixture.root / "profiles/missing"
    with handoff.lease(fixture.root / ".root.lock"):
        index = fixture.root / "profiles.json"
        document = json.loads(index.read_text())
        document["active"] = "missing"
        document["profiles"].append({"id": "missing", "name": "Missing", "created_at": "2026-10-12T00:00:00Z"})
        index.write_text(json.dumps(document))
    fixture.launch()
    handoff.wait(lambda: fixture.ready("target"))
    assert fixture.worker("target")["launch_id"] == launch_id
    assert not missing.exists()
    assert (fixture.root / "profiles/source/mindstream.db").exists()
    assert [entry["id"] for entry in fixture.status()["workers"]] == ["target"]
    print("Missing last-used vault stayed absent and the exact surviving target was adopted", flush=True)


def picker_ui(fixture, create=False):
    driver_port = port()
    log = (fixture.output / "webdriver.log").open("w", encoding="utf-8")
    driver = subprocess.Popen(["msedgedriver", f"--port={driver_port}"], stdout=log,
        stderr=subprocess.STDOUT, creationflags=subprocess.CREATE_NO_WINDOW)

    def request(path, payload=None):
        data = None if payload is None else json.dumps(payload).encode()
        req = urllib.request.Request(f"http://127.0.0.1:{driver_port}{path}", data=data,
            headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                return json.load(response)["value"]
        except urllib.error.HTTPError as error:
            raise RuntimeError(error.read().decode()) from error

    try:
        handoff.wait(lambda: request("/status"))
        session = request("/session", {"capabilities": {"alwaysMatch": {
            "browserName": "MicrosoftEdge", "ms:edgeOptions": {
                "debuggerAddress": f"127.0.0.1:{fixture.debug_port}"}}}})
        endpoint = "/session/" + session["sessionId"]

        def execute(script):
            return request(endpoint + "/execute/sync", {"script": script, "args": []})

        state = handoff.wait(lambda: execute("const h=document.querySelector('h1');return h && document.querySelectorAll('button').length ? {title:document.title,heading:h.innerText,body:document.body.innerText,language:document.documentElement.lang,dark:document.documentElement.classList.contains('dark'),buttons:Array.from(document.querySelectorAll('button')).map(b=>({text:b.innerText,disabled:b.disabled}))} : null;"))
        (fixture.output / "picker-state.json").write_text(json.dumps(state))
        assert "Tresor" in state["heading"], state
        assert state["language"] == "de" and not state["dark"], state
        assert any(button["text"].startswith("source") and button["disabled"] for button in state["buttons"]), state
        assert any(button["text"] == "target" and not button["disabled"] for button in state["buttons"]), state
        decorated = request(endpoint + "/execute/async", {"script": "const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke('plugin:window|is_decorated',{label:'vault-picker'}).then(done,error=>done({error:String(error)}));", "args": []})
        assert decorated is True, decorated
        (fixture.output / "picker.png").write_bytes(base64.b64decode(request(endpoint + "/screenshot")))
        assert not (fixture.root / ".desktop-settings-migrated").exists()
        assert not (fixture.root / "profiles/source").exists()
        assert not (fixture.root / "profiles/target/mindstream.db").exists()
        if create:
            execute("const input=document.querySelector('form input');input.value='Created from picker';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('form').requestSubmit();return true;")
            def created():
                index = json.loads((fixture.root / "profiles.json").read_text())
                return next((vault["id"] for vault in index["profiles"] if vault["name"] == "Created from picker"), None)
            selected = handoff.wait(created)
        else:
            execute("Array.from(document.querySelectorAll('button')).find(button=>button.innerText==='target').click();return true;")
            selected = "target"
        handoff.wait(lambda: fixture.ready(selected))
        assert not (fixture.root / "profiles/source").exists()
        assert json.loads((fixture.root / "desktop-settings.json").read_text())["future"] == {"keep": 1}
        print(f"Picker used root German/light settings and {'created a new vault' if create else 'opened the available target'} without recreating the missing vault", flush=True)
    finally:
        driver.terminate()
        driver.wait(timeout=10)
        log.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--exe", type=Path, default=Path(__file__).resolve().parents[1] / "target/debug/mindstream-notes.exe")
    parser.add_argument("--check-ui", action="store_true")
    args = parser.parse_args()
    for case in ["discovery-retry", "surviving-worker"] + (["picker-ui", "picker-create-ui"] if args.check_ui else []):
        PickerFixture.debug_port = port() if case.endswith("ui") else None
        fixture = PickerFixture(args.output / case, args.exe, missing=case != "surviving-worker")
        try:
            if case == "discovery-retry":
                retry_after_discovery_failure(fixture)
            elif case == "surviving-worker":
                surviving_worker(fixture)
            else:
                assert os.name == "nt", "the picker UI check requires WebView2"
                picker_ui(fixture, create=case == "picker-create-ui")
        except Exception as error:
            print(f"{case}: {type(error).__name__}: {error}", flush=True)
            # The picker has not initialized shutdown yet. Open only this
            # fixture's available target so authenticated Quit can drain it.
            if not fixture.status()["initialized"]:
                fixture.operation("pickerOpen", vault_id="target")
                handoff.wait(lambda: fixture.ready("target"))
            raise
        finally:
            fixture.cleanup()
            for lock in (fixture.root / "profiles").glob("*/.vault.lock"):
                assert not handoff.owned(lock), f"created fixture vault stayed open: {lock}"
    print("Startup fixtures released every coordinator/vault lease", flush=True)


if __name__ == "__main__":
    main()
