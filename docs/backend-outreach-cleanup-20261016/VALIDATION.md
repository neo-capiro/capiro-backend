# Focused validation

The single owned process ran from the isolated cleanup checkout:

```text
node --max-old-space-size=128 --test --test-isolation=none scripts/ci/outreach-current-evidence.contract.spec.mjs scripts/ci/meri-domain-cleanup.contract.spec.mjs scripts/backend-source-qualification.spec.mjs
```

**55/55 passed**, zero failed/skipped/cancelled: 12 actual-current evidence controls, 22 unchanged Meri controls plus two retargeted Engagement source controls, and 19 catalog controls. PID31992 started at 2026-10-16T05:08:51.2800869Z and exited0 at 05:08:51.8628215Z. Observed peak working set was 114,483,200 bytes. The 128MiB V8 heap and 120s hard wall were bounded; the 512MiB working-set stop was a ceiling, not an observed allocation. The process exited normally; no cleanup kill or resource stop was needed. The experimental TypeScript-strip warning is retained in stderr.

Raw stdout/stderr, actual argv/exit/cleanup receipt and nine input hashes are in `evidence/outreach-focused-stage1.*` and `evidence/outreach-focused-inputs.json`. No failed test stage preceded this pass. The normal memory observation at the start of this coherent light batch records physical memory and virtual address space, expressly **not commit margin**. No compiler/framework/browser/install/DB/provider process was started.

The actual current evidence methods are loaded by exact unique named boundaries with their real pure packet/freshness helpers and renderer; only fetch and logger are fixture ports. Other resolver kinds, decorators/Nest DI, real network fetch, caller authentication, guards and DB/RLS are not qualified by this fixture execution. Current gateway ownership is a source control, not gateway/provider execution.

The finite post-commit transition proof reconstructs the entire service from sealed a2 bytes using only seven hash-checked region removals, exact import deltas and one comment delta. It checks the 22 pinned historical operands, all seven decoded original case identities, the unchanged Meri prefix, nine tested inputs and the application/path allowlist. The source counter reads only changed canonical Git blobs against sealed PR36 totals. Their separate bounded receipts accompany the reports.

Independent source review found no code blocker. Its batch metadata finding was resolved by listing the three retained native spec paths and removing an unsupported aggregate count. The original finding and correction remain in evidence; no batch assertion/source was rewritten. A reviewer shell attempt failed before execution with CreateProcessInSandbox error5; this did not launch application or tests and is recorded separately.

UNRUN: native current application tests, native/type/build/image/DB/integration checks, full source catalog, and all seven historical fixtures. The flag-on relationship overlay gap remains explicit. Historical replay metadata requires an already-existing exact a2 root, exact operands/toolchain and a shared queue lease; it supplies no materialization/install/execution shortcut or fallback.
