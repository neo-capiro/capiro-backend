# 26 offline / 75 live baseline

## Live-v1 contract result

- Contract validity: VALID
- Live score: UNSET — no executed PASS/FAIL cases
- PASS: 0
- FAIL: 0
- BLOCKED: 0
- NOT_RUN: 75
- Frozen fixture: meri-live-v1-2026-09-26.1
- Fixture SHA-256: `2a8159d45d512f325539eb700907700ecc16cbc2d6536277adf85d8f49368e61`
- Appendix F source SHA-256: `acd2a1cf766ad6e988025c4c43235213164926e7036cc8361986916d59963b66`

No live API, cloud, provider, browser, database, or write execution was performed for this foundation report. The 75 live cases are NOT_RUN, not inferred PASS. The existing 26-case offline suite remains separate and was not rerun by this narrow contract change.

## Classification

Missing captures are NOT_RUN. Missing prerequisites or stale deployment/fixture identity are BLOCKED. Only a captured run with complete run, auth, source, effect, status, UI, deterministic assertion, and human-rubric evidence can become PASS or FAIL.

## Narrow local verification

- `node derive-lock.mjs C:/Users/Administrator/Downloads/01-Meri-Foundation-and-Reliability.md` — exit 0; frozen Appendix F matched the authoritative downloaded source
- `node validate-contract.mjs` — exit 0; valid=true; exactly 75 cases; source and fixture hashes matched
- `node --test tests/*.test.mjs` — exit 0; 28 passed, 0 failed; controlled UNIT fixtures are explicitly NOT live and cover fake captures, byte hashes, correlations, priority predicates, mode/fault setup, traversal/symlink refusal, and recorded-output drift
- `node --check artifact-reader.mjs && node --check capture-adapter.mjs && node --check deterministic-predicates.mjs && node --check execution-requirements.mjs && node --check verify-capture.mjs && node --check recorded-provider.mjs && node --check lib/schema-validator.mjs` — exit 0; verifier modules parsed successfully; no dependency install was used

## Remaining implementation gaps

- Authenticated Clerk identity/session acquisition and dedicated eval-tenant readiness checks.
- Case-specific fixture seeding/reset against an isolated database; no destructive Phase 19 seed is included.
- Real governed API/SSE capture and actual `/meri` Playwright controls.
- Adapter/provider/JEV/worker fault injection for cases 19, 51, 54, 56–58, and 71–75.
- Disposable sink execution, authoritative effect reconciliation, and persisted approval/readback evidence.
- Browser download byte capture, screenshots/traces, and approval/reload UI evidence.
- Human adjudication and optional recorded-output Promptfoo wiring; the included provider is read-only only.
- CD-01–CD-07 and CW-01–CW-08 extraction namespaces are not included in this first canonical 75-case foundation.

## Safety disposition

- No production/shared AWS faults or deployments.
- No real sends, cloud/provider calls, or browser actions.
- No global budget/bill writes and no destructive Phase 19 fixture seed.
- Offline grading must consume recorded outputs and cannot invoke writes.
