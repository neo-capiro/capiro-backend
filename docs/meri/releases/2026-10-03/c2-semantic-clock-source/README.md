# Qualified fixture clock: source and local evidence

This candidate gives the already-qualified native01/14/20/72 captures the original fixture instant,2026-09-26T16:00Z in America/New_York. Authorization, memory eligibility, leases, deadlines, spending and audit timestamps still use actual time. Ordinary requests retain their existing behavior. The matching core/API/orchestrator contract is compiled and independently reviewed; it is not deployed by this source checkpoint.

The API requalifies the canonical fixture before issuing clock authority. The compiler persists its actual clock use in existing ContextPacket JSONB and reads it back in the same transaction. The orchestrator records actual prompt date bytes, selected logical calls and HTTP invocations before response truncation. The final API reader independently checks the stored packet census and exact actor/client/policy/request/turn binding. Missing, extra, duplicate, unresolved or refused calls and packets block clock evidence. A caught refusal remains observable with an unproved identity and zero HTTP attempts.

## Validation

- [Independent review and integration record](qualification.json): final42 clock files plus one separately reviewed PostgreSQL test;26 production/17 test files. Cross-service contract changes were reviewed in frozen stages, whose original incomplete statuses and failures remain in this archive.
- Core expiry race regression: identical final tests fail5 checks before repair and pass70/70 after. Eligibility is evaluated after asynchronous loading using actual time. StageB-v2 receipts retain the earlier typing/assertion failures.
- Exact-client tool binding regression: same tests fail5 checks before repair and pass19/19 after. Final packet/receipt suites pass core30/30, API111/111 and orchestrator34/34 before the narrow v2 corrections. The native selected regression passes1 with121 explicitly selected out; no full-suite claim is made by that command.
- Final v2 refusal regression: same tests24 pass/3 fail before,27/27 after. Focused API typing and packet-join suites38/38. [Frozen hashes](stage-c2-v2-checkpoint.json).
- [Actual generated-Prisma/PostgreSQL storage](context-clock-jsonb-qualification.json):22/22,0 skipped, off/enforce/shadow JSONB round trips and real SQL failure/tamper triggers. Every test schema rolled back; owned local cluster stopped and data retained. This does not establish production RLS or the final served packet query.
- Both final service builds exit0: [API](stage-c2-v2-local-api-build.receipt.json), [orchestrator](stage-c2-v2-local-meriv2-orchestrator-build.receipt.json). The earlier failed API compilation is preserved; existing defense package outputs and the two clock typing errors were resolved before these builds. Source hashes were checked before/after.

## Boundaries

Case46 remains a separate artifact-clock join. Mail/task relative windows and cross-turn continuation remain unimplemented and outside these admitted captures. Unexpected shadow/concurrent packets deliberately block; raw API clock evidence remains blocked. Clock proof does not grant fixture, provider, deployment, artifact or effect authority.

No model/config/schema change, fixture reset, provider call or original acceptance result occurred here. Original PASS0/75, CD0/7 and CW0/8 remain. Existing memory lifecycle source remains unchanged. The separately developed fresh-spend adapter is excluded from this source commit.

Native images and candidate-bound human-reviewed release evidence must be prepared next; then original served capture can qualify the complete path. [Artifact byte hashes](artifacts.json) cover every retained file. The seven stage patches reconstruct the prior stages against de74185ab417a85a725d212d9d825fee47681bfe; checkpoints retain their exact raw source hashes. Local original mirrors and all private runtime data are preserved outside this public archive.
