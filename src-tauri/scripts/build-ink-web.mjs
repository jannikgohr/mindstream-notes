// Build the ink-egui-web wasm crate only when its sources have changed.
//
// The previous setup always shelled out to wasm-pack on every `pnpm dev`
// / `pnpm build` / `pnpm check`, which adds ~6-10s to each command even
// when nothing under crates/ink-egui-web/ moved. This script compares
// the newest mtime in the crate's source set against the wasm artefact
// and skips the rebuild when the artefact is already up-to-date.
//
// What counts as "source":
//   - everything under crates/ink-egui-web/src/
//   - the crate's Cargo.toml and Cargo.lock
//   - this script itself (so changing the build logic forces a rebuild)
//
// `rustup target add wasm32-unknown-unknown` is still run unconditionally
// because it's cheap (~50 ms when already installed) and the previous
// behaviour relied on it.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync, utimesSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");
const crateDir = join(repoRoot, "crates", "ink-egui-web");
const outputDir = join(repoRoot, "src", "lib", "ink-web", "pkg");
const wasmArtefact = join(outputDir, "ink_egui_web_bg.wasm");

function walkRustSources(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip target/ — it's huge and any change there is a *consequence*
      // of a source change, not a trigger for one.
      if (entry.name === "target") continue;
      out.push(...walkRustSources(path));
    } else if (entry.isFile() && entry.name.endsWith(".rs")) {
      out.push(path);
    }
  }
  return out;
}

function newestMtime(paths) {
  let max = 0;
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const stat = statSync(path);
    if (stat.mtimeMs > max) max = stat.mtimeMs;
  }
  return max;
}

function needsRebuild() {
  if (!existsSync(wasmArtefact)) {
    return "wasm artefact missing";
  }
  const artefactMtime = statSync(wasmArtefact).mtimeMs;
  const sources = [
    ...walkRustSources(join(crateDir, "src")),
    join(crateDir, "Cargo.toml"),
    join(crateDir, "Cargo.lock"),
    fileURLToPath(import.meta.url)
  ];
  const newest = newestMtime(sources);
  if (newest > artefactMtime) {
    return `source newer than artefact (Δ ${Math.round(newest - artefactMtime)} ms)`;
  }
  return null;
}

function run(cmd, args) {
  // Both rustup and wasm-pack ship as .cmd batch wrappers on Windows,
  // and Node 20+ refuses to spawn those without `shell: true`
  // (CVE-2024-27980). The catch is that cmd.exe then joins our args
  // back into one string and splits on whitespace — so any path
  // containing a space has to be quoted before it goes through.
  const useShell = process.platform === "win32";
  const finalArgs = useShell
    ? args.map((arg) => (arg.includes(" ") ? `"${arg}"` : arg))
    : args;
  const result = spawnSync(cmd, finalArgs, {
    stdio: "inherit",
    shell: useShell
  });
  if (result.error) {
    console.error(`[build-ink-web] failed to spawn ${cmd}:`, result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// rustup is idempotent and cheap; keep it unconditional so the first
// build on a fresh machine still works without manual setup.
run("rustup", ["target", "add", "wasm32-unknown-unknown"]);

const reason = needsRebuild();
if (!reason) {
  console.log(
    "[build-ink-web] up-to-date — skipping wasm-pack (delete src/lib/ink-web/pkg to force)"
  );
  process.exit(0);
}

console.log(`[build-ink-web] rebuilding: ${reason}`);
run("wasm-pack", [
  "build",
  crateDir,
  "--target",
  "web",
  "--out-dir",
  outputDir,
  "--out-name",
  "ink_egui_web"
]);

// wasm-pack / wasm-opt write the artefact with a backdated mtime when
// the bytes haven't changed (e.g. an unchanged crate built with the
// same compiler), which would make the next invocation think the
// source is still newer and rebuild forever. Stamp it to `now` so
// `needsRebuild()` has a stable freshness signal.
const now = new Date();
utimesSync(wasmArtefact, now, now);
