"""Check the real tauri dev launcher across worker handoff and last-worker closure.

Uses an existing Vite server and a disposable root. With close-to-tray on, the
coordinator outlives its last worker; with it off, closing the last worker ends
the owned CLI session as it would a release. This does not terminate or take
ownership of the Vite server.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import urllib.request

spec = importlib.util.spec_from_file_location("handoff", Path(__file__).with_name("supervised-handoff-check.py"))
handoff = importlib.util.module_from_spec(spec)
spec.loader.exec_module(handoff)


class DevFixture(handoff.Fixture):
    def launch(self):
        repo = Path(__file__).resolve().parents[2]
        config = json.dumps({"build": {"beforeDevCommand": None, "devUrl": self.dev_url}})
        self.process = subprocess.Popen(["node", str(repo / "src-tauri/scripts/tauri.mjs"),
            "dev", "--no-watch", "--config", config, "--", "--", "--supervised-vaults"],
            cwd=repo, env=self.env, stdout=self.log, stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        self.children.append(self.process)
        (self.output / "launcher.pid").write_text(str(self.process.pid))
        handoff.wait(lambda: self.endpoint(), 300)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--dev-url", default="http://127.0.0.1:1421")
    args = parser.parse_args()
    DevFixture.dev_url = args.dev_url
    fixture = DevFixture(args.output, Path("src-tauri/target/debug/mindstream-notes"))
    try:
        handoff.check("normal", fixture)
        assert fixture.process.poll() is None, "tauri dev exited with its source worker"
        fixture.close("target", handoff.uid())
        assert fixture.process.poll() is None, "tauri dev exited with its last worker"
        assert fixture.endpoint(), "coordinator exited with its last worker"
        with urllib.request.urlopen(args.dev_url) as response:
            assert response.status == 200
        fixture.operation("open", vault_id="source")
        assert fixture.ready("source")
        print("tauri dev retained its coordinator/server across handoff and, with close-to-tray, last-worker closure", flush=True)
        with handoff.lease(fixture.root / ".root.lock"):
            path = fixture.root / "desktop-settings.json"
            document = json.loads(path.read_text())
            document["close_to_tray"] = False
            document["revision"] = document.get("revision", 0) + 1
            temporary = path.with_suffix(".fixture-next")
            temporary.write_text(json.dumps(document), encoding="utf-8")
            temporary.replace(path)
        # The coordinator is gone afterwards, so its status cannot be polled.
        assert "Ok" in fixture.private("source", "close", handoff.uid())
        assert fixture.process.wait(timeout=190) == 0, "tauri dev outlived its last worker without close-to-tray"
        assert not handoff.owned(fixture.root / ".coordinator.lock")
        with urllib.request.urlopen(args.dev_url) as response:
            assert response.status == 200
        print("tauri dev ended with its last worker once close-to-tray was off", flush=True)
    finally:
        fixture.cleanup()


if __name__ == "__main__":
    main()
