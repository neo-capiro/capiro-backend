# Tango REST page leaf conversion

Source checkpoint: `6d243a1393b8736544e1d216cf2bd141595dd315`, tree `7ef0d154bddf8e69014433bdd9eab3252b2c2963`. Base: reviewed `802bbd0b2c510a44e46a9952d8127e7edc55aaaa`, tree `6c11b1094aadcbf6645e759204f72b6f87c8982a`. Root owns composition, the same-change data/duplicate/role controls, CI aliases, independent application review, and draft publication.

Exactly five application paths change: the three Tango REST clients and new `tango-rest-page.ts` / `tango-rest-page.spec.ts`, all under `apps/api/src/external/tango`. No root/shared/package/workflow, consumer, existing test, config, DTO, API, database or migration source changes belong to this worker.

## Canonical owner and caller roles

The existing Tango module now owns one pure parsing helper. Exports are `asCount(value: unknown)`, `nextPageOf(next: unknown, baseUrl: string)`, `rateOf(headers: Headers, profile: RateReadProfile)`, and the internal type `RateReadProfile = 'interleaved' | 'captured'`. `asRateInteger` is a private numeric kernel. The profile argument is mandatory and has no default. No service, store, dependency, public transport or policy is introduced.

| Consumer | Count calls | Next calls | Rate calls and required literal profile |
|---|---|---|---|
| TangoDibbsClient | 1 | 1 | 2: non-OK error metadata and successful page, both `interleaved` |
| TangoSbirClient | 1 | 1 | 2: non-OK error metadata and successful page, both `interleaved` |
| TangoSubawardClient | 1 | 1 | 1: successful page, `captured` |

All three import exactly `{ asCount, nextPageOf, rateOf }` from `./tango-rest-page.js`. The existing Subaward unused type-only rate import is removed. The three local functions per client are removed, including their attached helper comments. The next-page explanation moves into the canonical helper. RawPage and all used task/backend/provider functionality remain.

The captured branch reads all four numeric header values before coercion; the interleaved branch reads and coerces each in order. Both call the same kernel and retain the existing type header read and all-null/result construction. Header method lookup/receiver, throwing or mutating coercions, finite/truncation/null/clamping rules, HTTP-date Retry-After handling, and inherited/prototype inputs remain unchanged. No prebinding, normalization, caching or new validation policy is added.

## Protected semantics and source proof

[source-preservation.json](evidence/source-preservation.json) verifies all three whole client class bodies are byte-exact after removing only the five new literal profile operands. It also verifies the entire files differ only by helper removal, helper import, profile arguments, and the unused Subaward type import. It records the exact changed AST paths and required five rate roles. Twenty-five previously inventoried consumer/test/config/plan files match this reviewed base.

Therefore constructors, configured/credential checks, URL construction and filters, request auth headers, captured fetch implementation, abort timers/deadline lifetime, single-fetch/no-client-retry behavior, typed errors, response text handling, envelope distinctions, row filtering, redaction profiles and finally cleanup remain canonical source. SDK/resilience behavior and DIBBS/SBIR sync retry/accounting policy remain outside the extraction. This is a pure-leaf conversion, not a shared HTTP transport or full Cleanup Wave 1 acceptance. Existing security-owned behavior is preserved rather than newly accepted.

The three complete original source fixtures were captured from the frozen base before any edit. Their Git blobs and SHA256 values are in [ORIGINALS.json](evidence/ORIGINALS.json); the permanent spec checks the hashes before extracting original pure declarations. Expected values are never generated from the candidate.

## Qualification

- Focused strict/noUnchecked TypeScript check passed for the three clients, helper, new spec, existing SBIR/Subaward specs and real transitive type imports. It uses cached installed compiler/Node/Jest declarations, no generation/download. This is not a full application compile.
- Runtime Jest passed 237/237 in three suites: 208 new differential/profile/actual-client fake-fetch cases plus 29 unchanged existing SBIR/Subaward cases. No database setup, SDK/native-provider environment, provider request, PM installation, Prisma or paid model is used. Actual client tests use immediate synthetic fetches/Responses and preserve the native abort/timer source; no live fetch occurs.
- The original 68-case leaf corpus runs against three frozen originals and three candidate profile bindings: 204 original plus 204 candidate evaluations. Three stable/throwing/mutating profile probes add nine original and nine candidate evaluations. All 426 before/after leaf evaluations match their owner profile, including exact read/coercion effects.
- Eighteen original success-envelope/catch cases across three owners run before and after in one coherent host Error realm, 54 + 54 = 108 fragment evaluations. Every original result matches the separately reviewed coherent golden and every candidate result matches its original. No error message is normalized. The prior four authored VM message artifacts remain qualified in the untouched earlier packet.

Together the two source-fragment corpora record 534 original/candidate evaluations. They do not instantiate clients, timers, providers or databases. Constructor/non-OK/transport/abort coverage comes from the separate synthetic actual-client tests. Existing sync/diagnostic suites were not launched; their source and class behavior are preserved, and wider acceptance remains root-owned.

Failures are retained with exact inputs/configurations: default Jest project transformation exhausted the 4 GB heap; isolated transformation then passed alongside separate strict checking. The first new leaf differential used separate VM object prototypes and failed a deepStrictEqual on equal rate fields; the corrected harness evaluates both sides in the same host realm, without modifying any messages or production source. Previous audit raw failures and reviewed original corpora remain untouched.

## Reproduction and handoff boundary

Run from the isolated worktree root with cached dependencies:

```sh
node docs/cleanup-tango-page-leaf-conversion-20261012/evidence/source-preservation.mjs
node docs/cleanup-tango-page-leaf-conversion-20261012/evidence/before-after-leaf.mjs
node docs/cleanup-tango-page-leaf-conversion-20261012/evidence/before-after-envelope.cjs
node /workspace/capirov2/node_modules/typescript/lib/tsc.js -p docs/cleanup-tango-page-leaf-conversion-20261012/evidence/focused.strict.json
node /workspace/capirov2/apps/api/node_modules/jest/bin/jest.js --config docs/cleanup-tango-page-leaf-conversion-20261012/evidence/pure.jest.cjs --runInBand --no-cache
```

Root's standalone equivalent runner can replace the last author-local command while preserving the real three suites and their original fixtures. The worktree's two untracked node_modules links bind existing cached dependencies privately; they are excluded from commits. There are no installs, schema changes, migration/native/RLS acceptance, provider/cloud/security/network changes, frontend changes, retirement, main merge or deployment. The excluded unpublished EngagementService reporting source remains unassessed.

Application independent acceptance and the root-authored same-change controls remain separate review scopes. This author packet is qualification evidence, not independent acceptance or publication.
