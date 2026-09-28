# Meri live-v1 canonical acceptance contract foundation

## Status

This directory defines the first canonical contract and fail-closed reporting foundation for the Appendix F 75-case live benchmark. It does not implement or claim authenticated capture, server/provider fault injection, browser automation, live writes, or product passes.

The existing `evals/meri/` 26-case offline suite is separate and unchanged. `CD-01`–`CD-07` and `CW-01`–`CW-08` remain separate future namespaces; they are not renumbered into these 75 cases.

## Frozen contract

- Source: Appendix F of `01-Meri-Foundation-and-Reliability.md`
- IDs: exactly `01` through `75`
- Fixture version: `meri-live-v1-2026-09-26.1`
- Frozen clock: `2026-09-26 12:00 America/New_York` (`2026-09-26T16:00:00.000Z`)
- Contract source SHA-256: `acd2a1cf766ad6e988025c4c43235213164926e7036cc8361986916d59963b66`
- Fixture SHA-256: `2a8159d45d512f325539eb700907700ecc16cbc2d6536277adf85d8f49368e61`

`source/appendix-f.md` is a byte-content-equivalent normalized extraction of the complete Appendix F section. `cases.mjs` keeps every prompt, setup, and observable pass condition verbatim. Each typed case also declares category, surface, actor, selected client, fixture/source IDs, exact facts, required and forbidden sources, expected operation/effect count, allowed terminal state, hard gates, and the five-dimension human rubric.

`fixture.mjs` is self-contained and synthetic. It freezes tenants, clients, current actor roles, ethical wall, clock, memory lifecycle, budget stages and amounts, bill versions/events, opportunities, documents, artifacts, meetings, research portfolios, BD records, District Nexus records, fault fixtures, and disposable effect sinks. Supplemental synthetic details fill source passages that Appendix F requires the seed to specify but does not itself name; they remain covered by the fixture hash.

## Files

- `cases.mjs`, `contract.types.d.ts` — typed 75-case manifest.
- `fixture.mjs` — frozen self-contained synthetic fixture specification.
- `source/appendix-f.md`, `contract-lock.json` — frozen source and hash lock.
- `validate-contract.mjs` — exact ID, duplicate, verbatim source, source-ID, role/clock, prompt hash, source hash, fixture hash, and artifact-byte validation.
- `capture.schema.json` — capture evidence schema with explicit setup/stale/runtime/product boundaries and an owned optional row-predicate artifact boundary.
- `artifact-reader.mjs` — owned-root artifact reader that recomputes raw-byte hashes and refuses absolute, traversal, URL and symlink references.
- `deterministic-predicates.mjs`, `saved-evidence-predicates.mjs`, `execution-requirements.mjs` — implemented row predicates plus canonical saved memory/document receipts and structured prior-turn, fault, transition and mode-matrix requirements.
- `capture-adapter.mjs`, `capture-transport.mjs`, `artifact-collector.mjs`, `capture-cli.mjs` — bounded read-only API capture path for cases 01 and 20.
- `verify-capture.mjs` — runtime-schema, artifact, correlation, predicate and status verifier. Caller `passed`, proof booleans and arbitrary 64-hex strings are not PASS evidence.
- `recorded-provider.mjs` — read-only recorded-output provider that refuses network/write request fields.
- `report.mjs` — deterministic JSON/Markdown reporter.
- `tests/` — narrow Node tests against the actual validator/verifier.
- `evidence/` — no-run declaration and generated foundation report.

## Deterministic normalization and drift policy

Text hashing applies Unicode NFC, converts CRLF/CR to LF, removes trailing horizontal whitespace per line, and ignores terminal newlines. It does not collapse interior whitespace, punctuation, case, or wording. Structured fixture hashing recursively sorts object keys while preserving array order and normalized string content.

The validator rejects:

- any count other than 75;
- missing, duplicate, reordered, or nonsequential IDs;
- any prompt, setup, or observable pass-condition difference from frozen Appendix F;
- prompt lock, Appendix source, fixture, frozen clock/role, source-ID, or artifact raw-byte hash drift.

Do not update `contract-lock.json` merely to make validation pass. A lock update requires review against the authoritative Appendix F source and an intentional fixture-version decision. `derive-lock.mjs` prints candidate hashes and can compare the frozen extraction with the supplied source document; it does not modify files.

## Capture and report semantics

The capture schema records, separately:

- prerequisite/setup readiness and stale-target failures;
- execution state and earliest failure boundary;
- run/conversation/trace/plan/step identity;
- authenticated actor, tenant, selected client, and session proof;
- effective model/mode and each tool attempt/outcome;
- expected/consulted/cited sources, locators, passage hashes, coverage, and attachment/download byte hashes;
- proposal, payload, operation and receipt IDs, observed logical effect count, and authoritative readback;
- terminal/answer status;
- `/meri` route, approval/error/reload evidence, or explicit API-only non-applicability;
- hash-bound current-role/wall, memory candidate/decision/version/recall/list, source-byte/readback, page/slide/cell/range, prior-turn pointer, access-denial and pagination manifests for implemented rows;
- deterministic hard-gate evidence and human adjudication.

Status is fail-closed:

- `NOT_RUN`: no capture, execution not captured, or required run/auth/source/effect/status/UI evidence is missing.
- `BLOCKED`: prerequisite, auth setup, fixture readiness, bundle integrity, or stale deployment prevents a valid run.
- `FAIL`: a fully captured execution demonstrates a product/runtime contract violation, including a leak, duplicate effect, false success, bad terminal state, failed hard gate, or failed human rubric.
- `PASS`: complete evidence proves every deterministic gate and the human rubric. It is never inferred from text, HTTP success, a resolved promise, or a missing record.

A setup failure is not reported as a Meri defect. A real defect requires a ready setup and captured execution. `BLOCKED` and `NOT_RUN` never enter the pass-rate denominator and never become PASS.

This offline implementation deliberately returns `BLOCKED` for purported live captures until capture/auth/source authority verification exists. Controlled test artifacts are marked `UNIT_FIXTURE_NOT_LIVE` and remain `NOT_RUN`, even when their byte hashes and implemented predicates validate.

Artifact references are relative to an absolute owned bundle root containing a hash-bound `bundle-owner.json`. The verifier reads answer, cited passage, trace, auth, setup, payload, sink, download, UI, row-predicate and adjudication files from that root, computes hashes from their bytes, and checks stable capture-run/case/run/trace/tool/source/proposal/effect/UI bindings. Missing row predicates remain `NOT_RUN`; hard-gate `passed: true` values are never a fallback.

Cases 13–18 require canonical saved memory state/decision receipts. Those receipts bind the frozen candidate and proposal, current actor role/wall, selected tenant/client, source and tool call, exact `/meri` action order, decision payload, revision, sink receipt/effect and recall/list result. Case 16 requires a role-bound 403, a still-pending candidate and zero payload/receipt/effect. Case 18 requires two same-actor scoped session receipts, a zero-effect stale-revision rejection and one current-version approval; an edited or stale pending value is not eligible merely because a UI label says approved.

Cases 40–45 retain lower-level structural checks for canonical source read receipts rather than accepting answer substrings as document content. Applicable rows join owned raw bytes to a byte hash and readback receipt, parser identity/version, source call, current version, locator and extracted section/cell hash; every declared read range must resolve to an actual authorized trace call with the same source, version and range locator. Case 42 additionally binds the three-turn pointer, compaction state and exact cell range. Case 45 requires ordered page 1–80 range coverage for a complete result; its partial branch must retain bounded missing-range evidence and cannot claim “every.” These checks do not qualify the original rows as implemented: mutually consistent declarations do not independently prove binary source identity, trusted parser output, or current-version authority. The frozen fixture does not contain valid PDF/PPTX/XLSX binaries. Unit artifacts therefore identify themselves as `UNIT_FIXTURE_NOT_LIVE`; only a future authoritative capture reader may establish those missing qualifications. The current authority gate still returns `NOT_RUN` for the former and `BLOCKED` for purported live evidence.

## Offline grading safety

Live behavior must be captured exactly once. Writes may occur only in a separately authorized disposable sink through a future live capture adapter. Offline grading then consumes saved records through `recorded-provider.mjs`; that provider has no network client and rejects embedded network/write/operation request fields. An evaluator must not repeat a write to obtain answer text.

## Dedicated live read capture

This slice is an interim capture guard, not completion of the mandatory live-75 run or a server receipt. `LIVE_CAPTURE` currently returns `LIVE_SERVER_AUTHORITY_CONTRACT_MISSING` before any HTTP request, conversation creation, or synthesis. The guard is unconditional because the existing server does not expose authority for all of these preconditions:

1. predispatch read-only tool enforcement plus suppression or sandboxing of incidental after-turn writes;
2. a server-authored current fixture/source ownership and version receipt for the authenticated actor, tenant, client, and frozen-to-physical mapping;
3. the exact served API and orchestrator release identities; and
4. a server/provider-enforced cost reservation.

A caller-owned boolean, `expectedOperation`, scope-file SHA, configured release SHA, model instruction, or absence of late SSE write events cannot satisfy the guard. `maxSpendUsd` is only a configured post-hoc comparison threshold in the current controlled collector. It is not a provider ceiling or reservation, and an over-threshold observation can only be reported after cost has been incurred. Do not run the CLI with a live bearer while this guard is present.

`UNIT_FIXTURE_NOT_LIVE` remains available as a controlled loopback diagnostic for cases 01 and 20. It exercises the reviewed `/health`, `/api/me`, `/api/clio/status`, `/api/clients`, conversation, stream, message-readback, and supported source-readback sequence, but it remains `NOT_RUN`. It submits synthesis at most once and never retries an ambiguous submission. Redirects are never followed. Strict UTF-8, a 4,096-frame SSE bound, complete frame termination, exactly one terminal event, and no post-terminal event are required; violations are `CAPTURE_UNCERTAIN`. The only permitted live API origin is `https://app.capiro.ai`; `https://os.capiro.ai` is UI-only.

Controlled artifact writes reject linked roots, parents, refs, dangling destinations, root/parent identity changes, and external same-byte substitutions. New files use a temporary plain file plus an atomic no-replace hard-link commit and are checked before and after access. These checks are not claimed to be fully race-proof: portable Node path APIs do not pin every traversed directory handle, especially across Windows reparse substitution. `ArtifactCollector` therefore refuses `LIVE_CAPTURE` path mode with `LIVE_ARTIFACT_PATH_UNSAFE`; only the controlled diagnostic uses this writer.

Copy `capture-scope.example.json` outside the repository, replace every placeholder with the existing synthetic fixture's physical IDs and current seed/deployment receipts, then bind the mapping:

```bash
node evals/meri/live-v1/capture-cli.mjs --scope-hash C:/path/to/scope.json
# Put the printed hash in fixture.mappingSha256.
# LIVE_CAPTURE execution remains blocked; do not supply a live bearer.
```

The bearer is read only from `MERI_LIVE_BEARER_TOKEN`; credentials, cookies, provider headers, JWT-shaped values, and exact known secret values are redacted before controlled persistence. This is bounded redaction, not a categorical guarantee for unknown secret forms or caller-provided logging. Do not put tokens in the scope file. The CLI creates a fresh owned run directory under `--out`; it refuses an existing run path. Exit 0 is reserved for `CAPTURE_COMPLETE` only. `BLOCKED` exits 2, `CAPTURE_UNCERTAIN` exits 3, and `CAPTURE_INCOMPLETE` exits 4. No collector exit is acceptance.

Current server integration gaps remain explicit. The main API source does not emit the release SHA, public stream events do not expose an authoritative orchestrator identity, server trace ID, durable tool-call IDs, logical-effect audit, or complete model/token/cost receipt, and budget citations have no supported `/api/clio/sources` owner readback. Missing authority remains `BLOCKED`; it is never converted to PASS. The existing verifier's all-live source/auth authority gate and human rubric are unchanged.

The precise next integration is an extension of existing API ownership paths, not a new evaluation framework:

1. `/health` must expose the actual served API SHA, and authenticated `/api/clio/status` must return a server-authored, short-lived capture-readiness receipt. Its bytes must bind the served orchestrator SHA, authenticated actor/tenant/client, exact allowed read-tool registry, dispatch-boundary write denial, incidental-job policy, and a server/provider cost reservation amount and identity. A readiness boolean is insufficient.
2. Before conversation creation, the existing `/api/clio/sources` owner path must return a current authority receipt for each mapped physical source, binding frozen ID, owner tenant/client, canonical version, locator, and content/passage hash. The owner must add equivalent budget-record support for case 20; until then that case remains blocked.
3. The existing conversation/stream request contract must consume the single-use readiness receipt, reject stale or mismatched scope before assistant dispatch, and emit a durable terminal receipt binding API/orchestrator identities, request/trace/tool-call IDs, effective model, token and actual cost records, source versions/locators/passage hashes, and a zero-logical-effect audit covering incidental writes.
4. The collector can then validate those server-authored receipts before conversation creation and after the one stream submission. It must not accept scope-config declarations as substitutes. The portable LIVE artifact path still requires an owner implementation that can pin directory handles or an equivalently safe existing storage primitive.

No endpoint or trusted config switch is fabricated in this collector. App/API owners must implement the above on the existing contracts before the unconditional guard can be removed.

## Narrow local commands

Run from this directory with the existing Node runtime; no install or added dependency is required:

```bash
node validate-contract.mjs
node --test tests/*.test.mjs
node report.mjs evidence/no-live-run.json evidence/live-contract-report.json evidence/live-contract-report.md
```

Optional source comparison:

```bash
node derive-lock.mjs C:/Users/Administrator/Downloads/01-Meri-Foundation-and-Reliability.md
```

These commands do not call APIs, browsers, databases, providers, AWS, or write sinks. Do not run root test/build/lint for this narrow contract-only change.

## Bounded source-binary fixture generation

Cases 40–45 have deterministic synthetic PDF, PPTX and XLSX input preparation under `source-binaries/`. Regenerate only that owned directory, using the repository's existing `apps/api` dependencies:

```bash
node evals/meri/live-v1/source-binaries/generator.mjs --out evals/meri/live-v1/source-binaries
node --test evals/meri/live-v1/tests/source-binaries.test.mjs
node evals/meri/live-v1/validate-contract.mjs
```

The generator performs no network, API, browser, cloud, database or sink work. `asset-manifest.json` is a fixture definition, not a current-access attestation, canonical source-authority receipt, or production hash match. The binaries do not make cases 40–45 pass: trusted capture and a canonical API loader must still establish source identity, authorization, parser receipts and current-version authority.

## Required future capture work

Before any live case can be scored:

1. Add dedicated eval-tenant fixture seed/reset without the destructive fixed-ID Phase 19 seed.
2. Acquire and prove the existing synthetic Clerk users/roles without storing auth state in Git.
3. Inspect and implement the actual governed V3 API/SSE protocol and `/meri` browser controls.
4. Add run-keyed adapter/model/worker fault injection rather than replacing final browser text.
5. Use only sandbox/disposable effect sinks and reconcile authoritative receipts/readback.
6. Capture downloads, raw byte hashes, UI approval/error/reload evidence, and sanitized traces.
7. Add human adjudication and version-pinned recorded-output Promptfoo configuration without write execution.
8. Extract CD and affected CW contracts into separate namespaces when their harness work starts.

The repaired verifier currently has qualified row-specific predicates for cases 01, 03, 12–20, 46, 51, 56 and 72. Cases 40–45 have useful lower-level receipt, join and content-claim checks but remain explicitly unimplemented at original-row coverage because source-byte identity, trusted parsing and current-version authority are not proven. Other rows remain explicitly `NOT_RUN` rather than inheriting caller assertions. Case 12 still requires a saved setup artifact containing 500 distinct newer eligible distractor rows; `fixture.mjs` is only a specification and does not supply that seeded corpus. Cases 40–45 likewise require a future authoritative reader because the fixture records exact facts but does not embed valid binary Office/PDF source documents.

No live API/cloud/provider/browser/write execution, shared-AWS fault, deployment, Phase 19 destructive seed, global budget/bill mutation, merge, or push is part of this foundation.
