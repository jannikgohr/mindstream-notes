# Local changes to sqlite-wasm-vfs 0.2.0

Source: the published 0.2.0 crate at https://crates.io/crates/sqlite-wasm-vfs/0.2.0.
The upstream MIT license is retained in LICENSE.

- `xCheckReservedLock` reports no competing connection, allowing SQLite to roll
  back a hot journal after worker termination. Mindstream enforces one SQLite
  connection per database file in a dedicated worker, with an exclusive Web Lock
  for the pool. This patch requires that restriction. Supporting simultaneous
  connections would require tracking locks per file instead.
- Pool filename assignment and deletion flush their handle metadata, so a commit
  does not return with an unflushed logical journal deletion.

The same reserved-lock defect and SQLite's recovery behavior are documented in
https://sqlite.org/forum/info/ccf76ca4225ab38f. This Rust port contains the original
constant return value. The browser suite terminates a worker after uncommitted
pages spill to OPFS, then verifies that all 300 original rows are restored.

Keep this patch until the compatible upstream VFS includes these fixes. Do not
replace it with an unpatched registry crate when updating the lockfile.
