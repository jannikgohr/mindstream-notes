# CI follow-up after serializing coverage

[Workflow 39627105159](https://github.com/jannikgohr/mindstream-notes/actions/runs/39627105159)
completed with failure at `c7e51b93adcf4da021a20bee231df93a94aaa17b`.
`run.json` records the completed jobs and their conclusions. The compressed
logs come directly from the GitHub job-log API; `SHA256SUMS` covers this
snapshot. This supplements the earlier Rust port report without changing its
files or hashes.

Linux coverage passed with serial test execution. All three portable release
runtime probes, all three JS jobs, shipped Rust guest validation, Linux/macOS
workspace tests and the browser/Tauri E2E jobs passed. These conclusions apply
to the workflow's source commit, before the subsequent template-visibility
change. They do not constitute a physical-device UI or package-size pass.

Windows workspace tests remain a release gate. Job `119315815718` ran on
Windows Server 2025, build 10.0.26100, runner image
`windows-2025-vs2026` version `20261007.264.1`. Its app suite passed 1,038
tests with six ignored. The plugin runtime passed 82 tests and failed
`wasm::tests::the_interpreter_gives_the_same_answers_as_native_code` at
`plugin-runtime/src/wasm/tests.rs:767`. The interpreted `report` call returned
`HostError::Budget`, before the separate intentional runaway assertion.
Functional tests already ran with `--test-threads=1`, so the coverage
serialization fix alone does not resolve this Windows failure.

The failing call uses the unchanged default one-second budget. The log does
not identify which guest in the two-language loop exceeded it, nor isolate
instantiation versus execution cost. A passing Windows release probe and
earlier passing local debug runs do not prove this debug conformance gate
passed. The cause is unresolved; do not label it harmless contention or raise
the deadline without evidence. Preserve Luau and keep M5/M6 open.
