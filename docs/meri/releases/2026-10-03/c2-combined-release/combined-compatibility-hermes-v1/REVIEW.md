# Independent C2 source review

Review target declared by caller: `c0f393f863bf73bd4e65e7a94e17c073e7be021e`.

Status: **BLOCKED for build-backed compatibility/release evidence; bounded source review finds no concrete source-level blocker in the reviewed additions.** This is not deployment qualification, acceptance, or human approval. The API image is not qualified.

## Scope and evidence limits

The candidate and pin manifests were readable at:

- `C:/dev/main/outputs/meri-c2-20261003/combined-c2-candidate-v1.json`
- `C:/dev/main/outputs/meri-c2-20261003/combined-c2-source-pins-v1.json`

Candidate JSON declares source SHA `c0f393f863bf73bd4e65e7a94e17c073e7be021e`, no schema/config/model/schedule change, builds/release NOT_RUN at manifest creation, and acceptance UNCHANGED. Its source pins cover the API proposer service/spec, Case20 core/API/orchestrator source/tests, and web queue source/test. Case20 archive README and checkpoint were readable under `docs/meri/releases/2026-10-03/c2-case20-receipt-repair/README.md` and `checkpoint.json`; archive README preserves the original Case20 result as `CAPTURE_UNCERTAIN`, acceptance `NOT_RUN`, and explicitly says the saved failed run was not replayed or accepted.

I could not locate/read the requested Case17 provenance checkpoint/review or the named build readbacks/logs in this environment. Attempts at the requested Case17 directory and named build files returned not found; output-root listing/search did not expose those names. Consequently I cannot attest the Case17 review/checkpoint, source SHA/image digest binding, or successful current orchestrator/web build-readbacks. The Case20 checkpoint claims native focused tests/typechecks passed, but that is historical source qualification, not proof of the two current images.

Reviewed production paths include:

- `apps/api/src/memory/governed-memory-candidate.service.ts` (especially proposer history around lines 293-356)
- `apps/web/src/components/memory-queue-shared.ts` (optional `recordedSource` at lines 17-44)
- `apps/web/src/vnext/meri/MeriMemoryTab.tsx` (queue API use and source display)
- `apps/web/src/vnext/meri/MeriMemoryTab.targets.test.tsx` (source disclosure and restricted-candidate tests)
- `apps/api/src/meri/meri-controlled-read-fixture.ts` (Case20 exact controlled result and recheck)
- `apps/meriv2-orchestrator/src/meri/controlled-read-observations.ts` (actual invocation/HTTP observation and full-read capture)
- `packages/meriv2-core/src/context/capture-evidence-receipt.ts` (receipt blockers and Case20 public-source exception)
- `apps/api/src/app.module.ts`, `apps/api/src/memory/memory.module.ts`, `apps/meriv2-orchestrator/src/app.module.ts`, and `apps/meriv2-orchestrator/src/meri/meri.module.ts` (runtime module entrypoints)
- `docs/meri/deployment-prerequisite.md`

## Findings

1. **No source-level incompatibility found in Case17 `recordedSource` contract, bounded to the inspected current source.** API proposer history adds an optional `recordedSource` only when current wall authorization passes and a payload row exists; it selects only `payload`, `sourceType`, and `sourceId`, and does not expose source excerpt/reference. Restricted rows retain status/capability but no proposal body, recorded provenance, or client name (`governed-memory-candidate.service.ts:293-345`). The web type marks the field optional (`memory-queue-shared.ts:17-44`), so responses from an older API without it remain type/shape-compatible. The UI displays the value as a plain-text expandable reference and tests per-candidate isolation and restricted-row suppression (`MeriMemoryTab.targets.test.tsx:190-225,295-301`).

   For sequential API → orchestrator → web rollout, this field is served by API and consumed only by web; the inspected orchestrator module has no dependency on this queue DTO. Old web can ignore the additive JSON property; new web tolerates its absence. This is source-contract reasoning, not a live mixed-version test, and the missing Case17 provenance review/checkpoint remains a required evidence gap.

2. **Case20 repairs preserve fail-closed qualification in the reviewed current source.** The API's controlled Case20 result reports completeness for the exact one-source response only, and rechecks controlled fixture/current authority before returning it (`meri-controlled-read-fixture.ts:301-328`). Orchestrator observations bind the actual invocation identity and actual HTTP response, validate the Case20 one-record source and hash, and record full-read facts (`controlled-read-observations.ts:89-99,168-215,287-323`). Core's Case20 null-client exception is narrowly gated on an observed tenant-owned public source, selected client capture context, full read, equal passage/byte hashes, valid prompt clock, exactly one complete source-bearing call and one attempt, fixed logical source `R2-27`, version and current verification binding; all other missing/mismatched facts keep the existing blocker (`capture-evidence-receipt.ts:361-407,474-508`). Clock receipt verification still recomputes blockers and verifies the HMAC/policy bindings (`capture-evidence-receipt.ts:544-592`).

   The source delta is additive to the v1 receipt shape and the Case20 branch is opt-in through a semantic-clock policy; normal unbound traffic is not admitted by the new qualification path. API-first deployment may produce additive Case20 coverage metadata before orchestrator updates. The inspected new orchestrator uses it; I did not have the prior deployed orchestrator implementation/build to prove it ignores every new API result property. Validate that mixed-version behavior with the exact old/new image pair before relying on a live controlled receipt. Never treat a receipt assembled across mixed versions as proof unless its API/orchestrator release identities and joins verify.

3. **No retired Hermes runtime or evidence of a dropped-table import was found in the inspected application module entrypoints.** API entrypoint imports `MeriModule` and `MemoryModule`; orchestrator entrypoint imports its Meri module, whose runtime is the native `MeriV3CleanAssistantService` alias (`apps/api/src/app.module.ts:28,54,107,130`; `apps/meriv2-orchestrator/src/app.module.ts:7-8`; `apps/meriv2-orchestrator/src/meri/meri.module.ts:33-38,64-71`). The governed proposer source uses current Prisma `memoryCandidate` access, and the C2 change has no schema-change declaration. This is not a complete transitive import/table-use audit: the requested archive review and exact candidate diff were unavailable here, and this file-only lane did not establish current production DB schema/ledger. Parent must verify the full runtime/import graph and absence of dependencies on retired tables against the actual live schema.

4. **Release/build evidence is incomplete.** I could not inspect the named `meriv2-orchestrator-combined-c2-build-v1` and `web-vnext-combined-c2-build-v1` successful readbacks/logs, so I make no claim that either image qualifies. API build v1 is explicitly reported as failing an added offline probe gate and is being repaired separately; do not qualify or deploy that API image. Candidate metadata's original `builds: NOT_RUN` is not superseded by the unreadable artifacts.

## Actionable gates before any promotion

- Provide/review the actual Case17 provenance checkpoint and independent review, and verify the checkpoint pins against the exact merged tree.
- Inspect successful orchestrator and web build/readback records; bind each to the exact candidate SHA, immutable image digest, build run/attempt, and current readback. Run a deliberate previous-orchestrator/new-API compatibility check for Case20's additive response/receipt fields.
- Require repaired API build to pass its offline probe gate and bind the successful immutable API image to the same exact SHA. No current API qualification is established here.
- Parent to independently verify Git diff, production migration ledger/live schema, and retired-table dependency inventory as stated in the request. The candidate's `schemaChange: false` is not a substitute for that check.
- Follow `docs/meri/deployment-prerequisite.md`: per-service digest qualification, one-service-at-a-time attended rollout, explicit change window, authenticated application/canary checks, and no inference from ECS health or build success to acceptance. Case20 archive outcome remains uncertain and acceptance unrun.

No service, database, cloud, network, configuration, or source action was performed in this review.