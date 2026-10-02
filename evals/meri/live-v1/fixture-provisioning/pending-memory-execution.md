# Pending memory setup and case 17 UI capture

This bounded continuation implements canonical pending setup for original cases 14 and 17. It also fixes the own-proposal list excluding personal proposals, and shows the existing source-kind label on the proposer's Meri card. Case 17 creates six independent pending proposals as Priya: three Aster, one Bluehaven, one firm, and one personal. Case 14 creates only the frozen Aster proposal as Pat; its independent review and subsequent recall remain separate work.

No live run is claimed by this change. Setup receipts and collected UI artifacts say `liveAcceptance: NOT_RUN`. Existing LIVE verifier gates remain unchanged. Case 12 corpus/ranking acceptance and case 14 review/recall acceptance are not implemented by this operator.

## Operator

The qualified API image exposes only this fixed verb:

```text
meri-pending-memory-setup plan|execute|read --input /absolute/recipe.json --out /absolute/new-output.jsonl
meri-pending-memory-setup plan|execute|read --input-env MERI_PENDING_MEMORY_SETUP_INPUT --out /absolute/new-output.jsonl
```

The existing entrypoint builds the private database URL. The existing minimal production memory factory supplies actual canonical services and both tenant scopes; no application server, scheduler, model, embedding, approval, or bulk worker starts. The environment input is limited to 6,000 bytes and must contain no credentials. The output is exclusive-create JSONL. Each source-owned sanitized record is also written to stdout with prefix `MERI_PENDING_MEMORY_SETUP_RECEIPT ` for task-bound log collection.

Input has `{recipe, expectedPlanSha256?}`. The recipe has exactly:

```json
{
  "schemaVersion": 1,
  "target": "capiro-dev",
  "fixtureNamespace": "meri-foundation-20260928",
  "caseId": "17",
  "fixtureInstanceId": "NEW_UUID_V4",
  "ctx": {
    "tenantId": "APPROVED_T1_ID",
    "tenantSlug": "meri-foundation-20260928-t1",
    "userId": "EXISTING_PRIYA_USER_ID",
    "role": "standard_user"
  },
  "clerkUserId": "EXISTING_PRIYA_CLERK_ID",
  "actors": {
    "PAT": {"tenantId": "T1", "physicalId": "EXISTING_PAT_USER_ID"},
    "PRIYA": {"tenantId": "T1", "physicalId": "EXISTING_PRIYA_USER_ID"}
  },
  "clients": {
    "ASTER": {"tenantId": "T1", "physicalId": "EXISTING_ASTER_CLIENT_ID"},
    "BLUEHAVEN": {"tenantId": "T1", "physicalId": "EXISTING_BLUEHAVEN_CLIENT_ID"},
    "CEDAR": {"tenantId": "T2", "physicalId": "EXISTING_CEDAR_CLIENT_ID"}
  }
}
```

Use the existing approved synthetic manifest to resolve identifiers, never create substitute identities. Case 14 changes `caseId` to `14` and uses Pat's ordinary context. The factory and operator verify current membership, Clerk identity, synthetic account markers, tenant namespace and current client walls. Source text is frozen in the repository; the recipe cannot supply it.

`plan` requires absent candidates and no prior operation for the case. `execute` requires the exact plan SHA and writes a tenant-owned durable claim before creating any candidate through the existing owner. Partial or uncertain execution retains that claim and refuses another execution. Do not clear the claim or issue another seed command to repair a failed operation. `read` reconstructs the completed operation's actual pending candidate hashes and versions from canonical rows; caller receipts do not establish state. No cleanup/reset command is supplied by this change.

Root must extend and independently review its fixed task-local ECS wrapper before using this new verb. The previous four-command case-01 wrapper intentionally does not accept this command. All live setup remains a separately qualified one-shot operator action.

## UI receipt collection

`collectCase17MemoryUi` in `../case17-memory-ui.mjs` accepts a newly authenticated ordinary Priya Playwright page, the recipe, `readCurrentOwner`, exact qualified API/Web source SHAs, and an initialized native Windows artifact-storage capability. The root operator owns fresh deployed-image qualification, session creation, cleanup/revocation, and the actual source-owned `read` command used by `readCurrentOwner`. Do not substitute saved caller JSON for that read function.

The collector only visits `https://os.capiro.ai/meri`, verifies current API identity and response release SHA plus loaded Web release SHA, reads the complete bounded own-proposal cursor chain, and joins each physical candidate to the current source-owned mapping. It opens Memory, traverses the actual UI pages, and checks the six exact cards' scope, source label, body and enabled Withdraw action. It does not click Withdraw. It repeats after reload, verifies unchanged canonical state, and saves only those six synthetic card screenshots per phase and a structured receipt through native immutable artifact storage. All application mutation methods are blocked; no chat/send occurs. Raw credentials, tokens, full-page screenshots and unrelated proposal bodies are not saved.

`CAPTURE_COMPLETE` means capture bytes were collected, not original case acceptance. Grade those same artifacts without another model turn, preserving the original six-source, ownership, current-wall and UI criteria. The generic saved-evidence predicate still has legacy assumptions (including a single page); it must not be used to claim this new capture passed without a separately reviewed authority join and pagination calibration.

## Verification

The actual PostgreSQL regression invokes the canonical candidate owner and real `GovernedMemoryCandidateService.listOwnProposals` via Prisma. Before the fix it fails with `5 !== 6`; afterward it traverses three pages, includes the own personal row, excludes a different user's private row and a foreign-tenant row, and preserves revoked client-wall redaction. The disposable transaction is rolled back and schema absence verified. Separate actual setup tests cover cases 14/17, restart readback, no projection/provider work, stale plans, altered identity, revoked membership/wall, retained partial claims and retry refusal.
