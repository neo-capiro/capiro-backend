# Pinned Workspace copy source qualification

Final code `f073aacdef4fbf0ca860b9bfe0debd94022b9c1a`, tree `f957843c0709fa64081b8084b7d356c251a07a12`; base PR2470 `46aa2164c299151225c6cdb9f3cc565fee347657`. Independent review `48de0d6b03d7cb815fc28b40964a1843ec33509b` accepts source/static/mocked scope only.

| Evidence | Outcome and exact binding |
| --- | --- |
| Affected command/owner tests | 59 passed, zero failed/skipped, four suites at `2a83a957856de89892ecf2ed042d7c72ab179ba4`; all four specs and runtime JavaScript are byte-identical at final f073, whose only change exports an erased interface. Carry is explicit, not a falsely restamped run |
| Strict shared compiler | Exit 0, 2.630s at `5da422f44e2e8470d7aae45feefec1bb53fe54b3`; every shared source/package mode/blob is unchanged at final f073 |
| Strict Workspace compiler | Exit 0, 11.329s at exact final f073, cold owned build info, actual tsconfig |
| Actual Workspace Nest build | Exit 0, 12.830s at exact final f073; actual CLI/build config, owned output |
| Emitted syntax | Eight changed Workspace and two changed shared JavaScript modules pass `node --check`; 660 output files / 2,951,317 bytes inventoried before owned output retirement |
| Preservation | Fifteen bounded source paths change; 26,433 accepted-base entries and 30 unrelated existing owner members retain exact identities/bodies. All Core API, 33 qualified authority inputs, artifact/source policy, package/lock/config and protected reporting identities remain unchanged |

Tests exercise exact historical source selection, escaped hostile source text and retained original citations/provenance, complete rich JSON round trip, state conflicts, competing commands, interrupted copy/edit rollback, lost-response replay, older receipt replay after a later edit, wrong-client/prospect/document, live wall/grant/feature/member denial, source corruption, UUID collision concealment, copy bound/deduplication, legacy write/restore fences, locked config merge and deleted-destination non-recreation. The transaction serializer/rollback in these tests is synthetic; it does not qualify native PostgreSQL locking, isolation, trigger or RLS behavior.

Existing cached Workspace client schema SHA-256 `e67b41d7e5105937c201cab382e222817009dd8ec4843d045af2c754d756fa02` is byte-identical to the accepted base schema. The new nullable source column is handled only by explicit reviewed SQL, without a generated-model field reference. Type/build use that exact-base client and existing declared dependency caches (including htmlparser2 8.0.2, sanitize-html 2.17.7 and sharp 0.35.5 types). No install, native generation/download, checksum disabling, engine execution or database operation occurred. Fresh schema/client rollout and native permissions/transaction qualification remain gates; these checks do not claim a generated client for the new schema or artifact ABI acceptance.

## Original observations and evidence limit

Original test setup failed before any case because the inherited Workspace Jest `.js` mapper also matched `.cjs`; only the task-local host mapping was corrected. A second run had one synthetic wall-fixture dispatch failure, corrected without changing authority logic. A third run preserved three failures that caught an unintended changed void return; the established helper was restored and the new scoped helper introduced. Their original raw logs/results remain. Subsequent 59-case runs passed.

The first strict Workspace run used a stale root client missing existing prospect/newsletter fields and also found one nullable spec access. The exact-base client and existing declared package links corrected the setup; the assertion was corrected. Another strict run found a real public declaration error, resolved by exporting the `CopyDocument` interface, with identical runtime emission.

A dependency-link setup failure interrupted archival and allowed a rerun to overwrite the first compiler raw file and the older b4f passing Jest raw log/results. The 48,756-byte compiler log was promptly recreated from the same exact source/client/dependencies and verified byte-identical against the originally recorded SHA-256 `366598488a16b8d73b340df6db97bde4373081db5ff43b931b8adc992d8c5a61`; the recovery and incident are recorded honestly. The older b4f passing raw Jest file was **not** recovered: its tool receipt/hash and independent reviewer-observed 59-pass outcome are retained, and the later 2a83 full raw 59-case result is the qualifying run. No missing raw data is synthesized or claimed preserved. Further task-local check output preserves prior observations before replacement.

Exact surviving raw observations are checkpointed before finite lossless encoding of tool-emitted trailing spaces. The accepted ancestor's qualification/checksum indices remain exact. Source-only migration `20261013090000_prospect_brief_workspace_copy` is authored/reviewed, never run. Main merge, deployment, real messages/uploads/provider/model/customer writes, credentials/permissions, AWS and security/network changes remain excluded.

Frontend must consume [RECEIVING-CONTRACT.md](RECEIVING-CONTRACT.md) and independently qualify editor/receipt behavior. The preview template remains production-bound; [STAGING-INTEGRATION-PLAN.md](STAGING-INTEGRATION-PLAN.md) identifies isolation/automation/manual scopes but enables no E2E writes. Cleanup donors PR2469/PR2471 remain queued together and unconsumed by this product slice.

Surviving raw checkpoint: `b5ebff98afb3956302e275bf6293ddb21ac21349`, tree `076764ff27cab8cc7bafd46c2bf8b966d5fb4991`. Exactly five tool-emitted Jest warning logs are represented by finite lossless envelopes. Original raw bytes remain in this ancestor, and the initial raw hygiene failure is retained; no source or diagnostic was trimmed.
