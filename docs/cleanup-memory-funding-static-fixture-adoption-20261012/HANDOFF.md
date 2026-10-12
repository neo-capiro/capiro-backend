# Memory and Funding static contract inputs

Frozen source is `44eda40f7951e73722566862649939e51a8f151a` / tree `d13ee8799aa89c5a55d2d96efdbd9458c6e4439f`, based on published backend-acceptance PR2426 `d587441261fd356ee5144a8fc29cb2f771d062b8` / tree `0ef751228de0415c9a260c00bae3f8e7369b7755`. That baseline differs from the inspected `fe50dc1c2de1660a036e338cf81acdcf0f2fb26a` only in documentation. Source proposal is PR2423 `d09429a509d5b3cc2501f3736e619723e4b2c4c0`. A subsequent **CODE-only** check of `67fa9255b8a73f489d7a57c8fe270ed6d03fa016` confirms all ten selected blobs are unchanged. No denied new detailed report was read, copied or published.

The ten-path change adds seven opaque `.txt` fixtures, exactly matching both the proposal and current destination Web source, and changes four file operands in three existing specs. Inverting those replacements restores every original reader byte, case and assertion. Fixture contents are read as text, never imported or executed. The three specs retain all existing backend policy/source checks and Funding explanation cases. No Web source is edited or retired, and the existing APIs, schemas, SQL, helpers, full/scoped aliases, smoke guards, process policies, source inventory parser and public/shared exports remain unchanged. The original 20-path scoped qualification and nine current fixes are preserved by the exact base and ten-path diff.

Before and after, the actual three owner suites each run **60 cases: 59 pass, one inherited failure, zero skipped/todo**. The same result and passing-assertion counts recur with all Web file reads refused and Jest's crawler restricted to the actual API/shared roots. The failing Memory administrator UI-copy case still expects `Submitted for approval` in `MemoryFileEditor.tsx`; the exact destination source now delegates that copy to an existing helper. We preserve the source and original assertion. This slice does not repair that mismatch or claim a green full owner suite.

The evidence contains **39 structural/identity/fault controls** and **eight refusal-preload controls**, all passing. Controls check the exact ten-path diff, seven current/proposal source identities, three exact inverse reader bodies and malformed/missing fixtures, changed/deleted case or assertion structure, restored Web operands and duplicate reader operands. Mutation cases use in-memory maps. Native services, clients, providers, migrations and SQL are never run.

The actual owner runs use cached Jest29, cached ts-jest, the current shared source and no application setup/bootstrap. Network, DNS, fetch and child-process ports are intercepted. TypeScript transform diagnostics are disabled for this focused behavior runner, so it supplies no typecheck acceptance. The Web-refusal supplement uses separate explicit crawler roots to avoid Jest reading unrelated Web package metadata. Its original failed broad-crawler attempt is retained, including the exact stack; it never reached the suites. Raw original failure output, JSON results, command receipts and all corrections remain in `evidence/`.

Reproduce identity/fault checks and case comparison from the repository root:

```sh
node docs/cleanup-memory-funding-static-fixture-adoption-20261012/evidence/static-controls.cjs
node docs/cleanup-memory-funding-static-fixture-adoption-20261012/evidence/refusal-controls.cjs
python docs/cleanup-memory-funding-static-fixture-adoption-20261012/evidence/compare-cases.py
```

`run-specs.py before` was executed on the intact baseline and `run-specs.py after` on the frozen source. Their immutable command receipts bind those exact heads. The adoption utility is an authoring receipt with baseline assertions, not an idempotent runtime script or generator. No root/package/CI/permanent guard path is added here; evidence controls remain reproducible inspection artifacts. Independent review is assigned to `/root/newsletter_staging` and publication to root.

The inherited Memory assertion remains an explicit acceptance gap. Frontend rendering/retirement, broader immutable Core-floor reconciliation (830 exact / 280 missing / 36 different at the original inspected source), native DB/RLS/MVCC, full coverage/visual gates, live providers and wider Cleanup acceptance remain outside this bounded change. See the separate read-only newsletter/retirement contract packet `9358b4fc8f950a6344078c0a9df93895d80b5b93`; no newsletter dispatch, UUID bridge or protected unpublished reporting work is included.
