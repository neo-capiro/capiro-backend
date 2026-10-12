# Strategy grounding time and retry source candidate

This bounded conversion injects the Strategy grounding clock and retry randomness/delay at every actual caller. It preserves the current system defaults, retry classification and timing, fiscal math, transport DTOs, persistence, and all other timestamp/deadline/telemetry owners. It introduces no service/store or dependency. Canonical lazy defaults live in the existing shared package; Meri qualified authorization/capture clocks remain separate.

Base is frozen draft PR2408 `1bf52945b9fa01496ce41a349f8eaace490ad4ac`, tree `d3ede11cd213151b244853e39bb7fab30610d2d9`. App implementation is `e22731a66021bb4e7e5b4112624c823c611d2a3c`; integrated first source `f86bf11b9b6da367d464da453ee1f260fa60e06e` was held after independent guard bypass findings. The final repair/source pin and independent receipt are supplied in RELEASE-MANIFEST.json before publication; no pending source is declared accepted.

## Bounded contracts

`WallClock` samples epoch milliseconds; `RandomSource` samples the existing uniform [0,1) source; `Delay` awaits the supplied milliseconds. All system defaults are lazy and sample nothing at import. Required Nest clock/retry tokens are registered on the existing raw Meri/DraftJob paths; no implicit test-only fallback or optional token is introduced. All six actual retry callers pass the injected runtime explicitly (Meri 5, DraftJob 1).

Retry remains three total attempts, only the existing transient predicate, with delays 200/400 plus floor(u*75). Random/delay hook failures propagate; delay is awaited before retry. Existing classification, including 401 with timeout text, remains unchanged rather than being silently corrected. Grounding samples the clock once at its original post-load fiscal boundary; reference assistance uses the same boundary. Fiscal helpers now require the existing explicit Date input; every production baseline caller already supplied it. Other mutation, telemetry, credential-cache and draft deadline clocks remain byte-identical.

The same-change data-driven AST ratchet covers the 169 production source files, six required consumers and canonical helper ownership.123 existing ambient samples outside the converted boundaries remain explicitly deferred at their original identities/counts, plus 3 single canonical system defaults. New ambient access, indirect aliases, extra/helper copies and missing/invented retry runtime bindings must fail. The original guard's 29 passing controls were insufficient: review found 14 bypasses, a hoisted-import alias and four declaration copies. Original source, PASS and RED receipts are preserved; publication requires the repaired permanent corpus and independent replay to refuse them. Static patterns do not establish arbitrary runtime/OS containment.

Root gate alias and exactly one pure CI step ship in this source. Existing install/toolchain, workflow triggers/filters, permissions, commands, conditions, services and budgets remain unchanged; no new native job or action is invoked by the author. The step uses already installed TypeScript after the original frozen-lockfile install.

## Verification and preservation

App 137/137 cases pass across seven suites with all 102 original full names retained; strict full Strategy compiler and canonical shared build pass. Independent runtime 17 and real-Nest source-constructor 4 controls pass without bootstrapping the complete production module or any external collaborator. All six callers, required token/default/override behavior, October fiscal sampling, retry awaiting and fail-soft policies are exercised. Original unconverted members/governed factory/baseline/lock and package/workflow properties remain unchanged. The final repaired guard result belongs to its separate receipt; counts overlap and are not summed.

Initial dependency/inventory launcher failures, the post-run original-byte check that observed legitimate parent source advancement, the independent fake-delay microtask assumption failure, CI step-name lookup failure and all guard bypass REDs remain. Names-only baseline discovery is 102 pending, not acceptance; actual executed results are 137 pass. No assertion, timeout, case, threshold or original acceptance check is removed to get green.

## Scope and dependency matrix

| Owner/input | Relationship |
| --- | --- |
| PR2408 and original PR2406/2407 packets | Direct base; immutable packets and all original source histories preserved. |
| Shared package | Additive internal time types/default exports only; no root dependencies or lock change. |
| Strategy | Grounding/reference/fiscal sampling and all six retry callers only. No cryptographic UUID, authorization/capture, mutation/telemetry or deadline policy change. |
| PR2409 public-law containment | Published same-base sibling at `fbdba6db6a995845727f4b57007da0a7f6aa5a6c`, tree `82c628a1554d166990112b2267f71500d14e4838`. Its four source paths do not overlap this candidate's 18. Root owns any later composition; this branch alone still contains PR2408's old public-law verifier result. |
| Migration policy | Two genuine conflicting contracts remain; no recovery aliases/checks changed. Source/native/security policy adjudication belongs to the canonical owner. |
| Wider CleanUp4/CleanUp2 | This is one bounded source conversion and ratchet, not all Wave1 seams or complete shared/global time adoption. Other flag/DTO/entity/HTTP/context/config/registry/facade and ratchet gaps remain in PR2408 ADOPTION-MATRIX.md. |
| Frontend4a161488 / Meri greenfield | No routes/DTO/schema contract delta, no consumption requested and no source changes. The frontend approved image source remains frozen. |
| EngagementService reporting | Excluded owner/branches/unpublished reviewed source remain untouched and unassessed. |

Source preparation proceeds under Neo's explicit authorization; prerequisite clean toolchain, authentic coverage floor, pinned visuals, native DB/RLS/concurrency, full isolated CLI smoke and complete Cleanup1/4 CI/gates remain unrun/open. No wave or deployment acceptance is declared. No DB/SQL/migration/PGlite/provider/AWS/upload/message/paid-model/customer/credential/permission/security-network action, main merge or deployment occurs.
