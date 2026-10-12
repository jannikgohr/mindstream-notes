"""Check that the real tauri dev launcher survives worker handoff and closure.

Uses an existing Vite server and a disposable root. Explicit Quit cleans up the
owned CLI session. This does not terminate or take ownership of the Vite server.
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
        print("tauri dev retained its coordinator/server across handoff and last-worker closure", flush=True)
    finally:
        fixture.cleanup()


if __name__ == "__main__":
    main()
