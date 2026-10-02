# Actual build failures and bounded Web fix review

Observed 2026-10-02 at 01:21–01:23 UTC. Source `83304d18e5a1ab647cf6f728392cf97b3058a832`. These build failures are retained and are not passing qualification.

## Web

Build `capiro-build-web-dev:dff87d70-5921-48fb-8a84-723c2685bce0` completed FAILED after pre-build passed. Source test initialization reported seven `ERR_REQUIRE_ESM` errors before any selected test ran. Exact dependency chain: CommonJS `html-encoding-sniffer@6.0.0/lib/html-encoding-sniffer.js` requires ESM `@exodus/bytes@1.15.1/encoding-lite.js`. The fallback test image used Node20.16.0.

The committed lockfile directly documents the incompatible engine floor: `@exodus/bytes@1.15.1` and `html-encoding-sniffer@6.0.0` accept `^20.19.0 || ^22.12.0 || >=24.0.0`; `jsdom@29.1.1` accepts `^20.19.0 || ^22.13.0 || >=24.0.0`. Thus Node20.16.0 is below every relevant supported range. Source typecheck and Docker compilation were not reached; the evidence does not establish a Docker compilation failure.

Independent review of root's actual two-file working diff in `C:\dev\cap-meri-migration-history-guard`: PASS. `apps/web/Dockerfile` changes its Node build argument to22.23.3 with a rationale; `.github/workflows/web-vnext-deploy.yml` changes setup-node from floating20 to22.23.3. No dependency lock, test, route, nginx runtime or image-promotion change. This repairs the canonical build/test toolchain and the fallback must use the same version. Root separately reports 54/54 selected local tests passed on actual Node22.23.3; this worker did not rerun them. Web requires a newly merged source SHA and a new build receipt.

## Orchestrator

Build `capiro-build-web-dev:c1f04637-2f7e-4eaa-9d44-485f3c0c2779` completed FAILED at the offline full-package Jest gate. Typecheck completed first. Actual result: 121/124 suites passed;1397 passed,4 failed,2 skipped,1403 total tests;75.352 seconds. Docker construction and push were not reached.

`orchestrator-source-test-failure.txt` preserves exact failure diagnostics, SHA256 `127146d076c59c5dd124ff13cd6087771563fcddcd302af5872e3facdc22e62e`:

- Current-conversation RP catalog expected18, actual19; the test also forbids `manage_research_portfolio` despite current registry membership.
- Full-chat read catalog expectation still includes `prepare_research_portfolio_brief` and `prepare_research_portfolio_meeting`, absent from the actual read catalog.
- Combined catalog count expected136, actual137 (exact-set/no-duplicate comparisons passed before the count assertion).
- Write catalog's31-tool expectation omits `manage_research_portfolio` plus the two RP preparation tools now present in the actual write catalog.

The bounded repair was delegated to the separate `/root/file01_ab_audit` worker, with an explicit requirement to inspect actual canonical/API side-effect semantics before updating expectations. No failed tests were removed or bypassed by this worker.

## API and per-service provenance

At01:22:40 API build `capiro-build-web-dev:dc4c281e-5372-4a7d-b667-2919a78125f1` was in POST_BUILD after BUILD succeeded. Its actual logs contain `OFFLINE_RUNTIME_IMPORT_PASS` and `EXACT_449_IMAGE_MIGRATION_HASHES_PASS`. Publication/digest was not yet confirmed at that observation.

Later compatible images may intentionally use different merged source revisions: API83304, Web after its toolchain fix, orchestrator after catalog repair. Each qualification must bind that service's exact source and immutable digest; no all-images-same-SHA claim should be made. Evidence may establish unchanged service inputs across commits without retagging an older image as a newer source.

## Read-only log retrieval

Windows AWS CLI initially could not encode Unicode test logs. The read-only collector now requests `--query 'to_string(events[].message)' --output json`, then decodes JSON twice locally. This produces ASCII-escaped transport without changing profiles, credentials or cloud state. Selected sanitized observations are timestamped `build-observation-*.json`; the earlier two log-encoding failures remain recorded separately from build failures. Full API, Web and orchestrator source/build status is authoritative only from the exact named build's readback, never from echoed command text.
