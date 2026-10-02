# Retirement and rolling compatibility review

Source: `83304d18e5a1ab647cf6f728392cf97b3058a832`. Policy: `39590a3bfc57ce03b0411ff7912a7c8d99deb70c`. Reviewer: `/root/file01_ab_audit`.

**Retirement compatibility: PASS for the reviewed source. Rolling compatibility: PASS subject to the release conditions below.** This is a bounded source and historical-receipt attestation; it is not a new mixed-image runtime test or an image-build attestation.

The API and orchestrator module graphs use native Meri/V3 and governed API adapters. Runtime source searches found no restored Hermes imports or accesses to the eight retired Meri/Hermes persistence tables or three dropped LegiWatch saved-view/preset/backtest tables. The remaining `Hermes` runtime string is status/conversation metadata; other mentions are comments or procedure provenance. Prior API/Web `fc8133d` and orchestrator `c2bc41a` sources likewise have no retired persistence runtime access. Current API `serve` dispatch reaches `node dist/main.js`; explicit migration verbs are separate, and Prisma startup only connects. Orchestrator `serve` also starts its server without migrations.

The actual owned-local fresh database receipt and log verify 449/449 migrations, exit 0, no missing, unfinished, mismatched or unexpected history. Its prerequisite SQL hashes and migration/schema source match this candidate. The actual isolated upgrade evidence comprises a 61-step prefix and four terminal checks, followed by independently qualified final catalog review. All 65 step receipt hashes and execution exits were verified, as were the final qualification and linked run hashes. The prefix/supplement's historical BLOCKED verdicts remain preserved; the final isolated rehearsal verdict is PASS. All 466 frozen source files match candidate Git blobs, and both migration trees match the rehearsal sources. The rehearsal's separate data baseline and preexisting broad-grant limitation are explicitly retained. Current live schema evidence and accepted original-fingerprint uncertainty are recorded separately in `schema-qualification.json`.

Release conditions:

- Bind each service to its actual immutable image digest and passing exact-source build/runtime evidence. This review has no candidate image digest and cannot substitute for a failed build or test gate.
- Deploy compatible Web vNext before API. Current Web rejects incomplete old-API previews, refreshes before new requests or exact retries, and rejects incomplete responses. The old API Apply implementation is a no-op; a mixed-roll response cannot be mistaken for a confirmed conversion. Cached old Web requests against new API fail validation and may require refresh.
- Keep `RESEARCH_PORTFOLIO_MERI_TOOLS_ENABLED` absent/false while old Engagement serves. The sole institutional task/prep producer is reached through the Meri adapter, with manifest and dispatch gates requiring exact `true`. Verify the dark flag at preparation and after promotion.
- Preserve existing native V3 global/cohort/tenant settings. Global environment disable precedes tenant opt-in. This review authorizes no feature activation or routing change.
- Retain the forward schema on application rollback. No new migration or ledger operation is required.

`retirement-rolling-compatibility.json` contains all source links/hashes, exact receipt references, source equivalence, 65 step results, conditions and limitations. This audit made no database queries, provider calls, AWS mutations or source edits, and did not rerun test suites.
