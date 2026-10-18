# Meri execution capability — `capiro.meri-execution-capability.v1` (rev 5)

**Status: in source on capiro-backend #84, not deployed.** The issuance route, the revocation route and the `create_task` receiver exist. All answer 503 until these are in place:
- the four `MERI_EXECUTION_SIGNER_*` values;
- the KMS key (created only in the deployment packet);
- Core's access to Meri's admission tables (§8).

The ledger migration `20281018040000_clio_meri_execution_authority` is reserved and NOT applied.

**Who does what** (dot, #121 6246253130; R0 6247577743):

| Role | Owner |
| --- | --- |
| Core source: issuance, replay, receiver, revocation | Core integration owner |
| Meri's 13-field verifier and the execution-grant installer | Meri lane X (merged at `11b90c7f`) |
| Consumer and lifecycle review | R0 |
| Cross-repo fit review | dot |

**Cross-check with Meri's own code** at integration tip `a2239dde`, against the complete admitted-allocation vector. All of these accept:
- `verifyExecutionCapability`
- `assertExecutionCorrelation` (with the allocation hash and the qualification)
- `executionRequestId`
- `capabilityBudgets` (exact budgets and allocation hash)
- `commandSourceBody`
- `parseToolGrantFacts`

`exp*1000` matches too.

**What exists in source:**

| Piece | File |
| --- | --- |
| Codec: issue, verify, trusted comparison, request id, allocation budgets, qualification, body inverse, platform maxima, client-scope containment | `apps/api/src/meri/execution-capability/meri-execution-capability.ts` |
| Meri's canonical admission predicate | `apps/api/src/meri/execution-capability/meri-admitted-run.reader.ts` |
| Issuance service and route | `apps/api/src/meri/native-approvals/native-execution.service.ts` (`POST /api/clio/approvals/native/execution`) |
| Revocation and `revoked` on reads | `apps/api/src/meri/native-approvals/native-approval.service.ts` (`POST /api/clio/approvals/native/revoke`) |
| Receiver and the preview no-fallback rule | `apps/api/src/meri/execution-capability/meri-execution-receiver.service.ts`, called from `MeriController.executeTool` |
| Middleware admission | `apps/api/src/tenant/tenant-context.middleware.ts` (`useMeriExecutionCapability`), `apps/api/src/auth/meri-execution-request.ts` |
| Key configuration and verification (pure, SDK-free) | `apps/api/src/auth/core-ed25519-key-config.ts`, `apps/api/src/auth/core-ed25519-signer.ts` |
| KMS signer (the only `@aws-sdk/client-kms` import) | `apps/api/src/auth/core-ed25519-kms-config.ts` |
| Ledger: issuances, consumptions, revocations | `apps/api/prisma/migrations/20281018040000_clio_meri_execution_authority/migration.sql` |
| Vectors | `docs/integration/meri-execution-capability.vector.json` (codec, minimal allocation)<br>`docs/integration/meri-execution-admitted-allocation.vector.json` (complete allocation from Meri's `composeGeneralReadAllocation`) |

## 1. What Meri needs (meri-greenfield `11b90c7f`)

| Meri site | Requirement |
| --- | --- |
| `apps/runtime/native-authority/execution-issuance.mjs` | Posts the rev 3 body `{proposal, executorBinding, requestId, allocation, allocationSha256, qualification, runDeadlineMs}` with the attended approver's native bearer and the service secret. It requires a closed receipt `{execution, credential, checkedAtMs, expiresAtMs}` with `expiresAtMs === exp*1000` and budgets equal to its allocation's. It then installs the capability's execution grant before the receipt is used. |
| `apps/runtime/native-authority/execution-capability.mjs` | Verifies the 13-key execution member; applies `assertExecutionCorrelation` and `executionRequestId`. |
| `apps/gateway/budget/execution-grant-admission.mjs` | Inserts the ACTIVE execution grant (`grant_id = jti`, `capability_sha256` = SHA-256 of the token, `expires_at = exp`) under the budget lock. Its `revoke` sets the run's execution grants to REVOKED. |
| `apps/control/commands/source-http.mjs` | `POST /api/clio/tools/create_task` with the capability bearer, the service secret and the null-omitting body; requires HTTP 200 JSON. |

## 2. Token

A compact JWS of at most 8192 bytes; the signing input is at most 4096 bytes.
- **Header:** exactly `{"alg":"EdDSA","typ":"capiro-meri-execution+jwt","kid":"<kid>"}`.
- **Payload:** its bytes are exactly its RFC 8785 form.
- **Signature:** pure Ed25519.

| Payload member | Value |
| --- | --- |
| `iss`, `aud` | Core issuer label; `meri-gateway` |
| `iat` = `nbf`, `exp` | The database clock read under Meri's budget lock. `exp = min(iat + 120, decision.expiresAt, proposal.expiresAt, admission deadline)`. |
| `jti` | `capabilityId` (UUIDv4); also Meri's execution `grant_id` |
| `capability` | Meri `CapabilityClaims`. `budgets` are derived from the admitted allocation exactly as Meri's `capabilityBudgets` derives them. |
| `execution` (13 keys) | `requestId`, `proposalId`, `commandSha256`, `idempotencyKey`, `action`, `argumentsSha256`, `sourceBodySha256`, `clientIds`, `decisionSha256`, `approver`, `requestSha256`, `allocationSha256`, `qualification` |

## 3. Issuance: `POST /api/clio/approvals/native/execution`

**Auth:** native session bearer, verified service identity (`hasVerifiedToolServiceIdentity`), `standard_user`, `no-store`, HTTP 200.

**Preconditions.** Every call re-runs all five, a replay included. They run under the proposal's advisory lock and Meri's budget lock, against the database clock:
1. The caller is the required approver and the executor binding's actor.
2. The stored decision meets all of these:
   - approved, unexpired and **not revoked**;
   - for this command and run;
   - approved by the caller.

   The proposal must also equal Meri's prepared approval metadata.
3. The executor binding meets all of these:
   - it keeps the proposal's tenant, actor, conversation and run;
   - it is **exactly** the admitted grants' binding (this authenticates `attemptId`, `workerId` and `writerFence`);
   - `requestId` is Meri's deterministic id for it.
4. The action is `task.create`, with closed arguments and no attachments.
5. Scopes and clients:
   - every scope is this tenant's at the decision's revision;
   - **the task's client is inside the approved client scope**: a non-null `clientId` is one of the client scopes; a null `clientId` needs no client scope and the tenant's own tenant scope;
   - every client is visible now.

**Meri's canonical admission** (`readCurrentAdmission` + `execution-grant-admission`). Core reads it through ONE call on its transaction: Meri's SECURITY DEFINER function `meri_core_authority.current_admission_v1(run_id)` (dot 6248138427 / 6248171459; proposal `docs/integration/CORE-ADMISSION-SNAPSHOT-FUNCTION-20261018.sql`, placed by R0 in Meri's integration grants). Core takes its proposal lock first. Inside the function:
- **Lock.** `SELECT … FROM meri_product_budget.budget WHERE id = 1 FOR SHARE`. This conflicts with the `FOR UPDATE` that Meri's admission, revocation, grant installation and fence changes take, so nothing commits in between. It also requires the budget not to be quarantined, and supplies the database clock.
- **Run and allocation rows.** There must be one `runs` row and one `tool_run_allocations` row, and all of these hold:
  - the stored hash equals the RFC 8785 hash of the allocation;
  - the allocation's run is the executor's;
  - the qualification is the run row's, at the executor's fence and the decision's revision.
- **Admitted grants (R26).** Meri's saved ADMITTED record (`meri_conversations.native_allocations`) must be ADMITTED, with exactly the executor binding and the allocation hash. **Every grant it declares** must exist, be ACTIVE, unexpired and bound with exactly the declared facts. Every other grant on the run must be a Core-issued capability. At the receiver, this capability's own grant must be current, and its expiry joins the deadline. A completed result is released only after a fresh database-clock check.
- **Deadline.** `min(started_at + maxRuntimeSeconds, schedule.expiresAt, admitted grant expiries)` must be ahead.

The request's `allocation`, `allocationSha256`, `qualification` and `runDeadlineMs` must **equal** the owner's.

**Budgets** are never caller-chosen: they are derived from the allocation. The configured platform maxima `MERI_EXECUTION_MAX_{TURNS,RUNTIME_SECONDS,COST_MICROUSD,OUTPUT_BYTES}` refuse above themselves. Unset means no extra bound, and a malformed value answers 503. The D016 default profile is set in the deployment template, never hard-coded.

**Ledger:** the row is written before signing. Existing rows decide the outcome:

| Existing state | Outcome |
| --- | --- |
| A live row for the same request | The same immutable token, re-signed after every check above passes again; `checkedAtMs` is fresh. |
| A live row for another attempt | 409 |
| A lower writer fence | 409 |
| An expired row | A new capability is issued. |

## 4. Verification

`verifyMeriExecutionCapability` checks:
- the exact header, a pinned `kid`, and a pure Ed25519 signature;
- payload bytes equal to their JCS form;
- `iss`, `aud` and time;
- the capability against the payload;
- scopes, `clientIds`, `requestSha256` and the qualification binding.

`assertExecutionMatches` compares the token with the actual request, proposal, current decision, allocation and qualification.

## 5. Consumption and revocation

**Consumption.** The receiver does all of the following in **one transaction**, under the proposal lock and Meri's budget lock:
- the checks;
- the claim;
- the task write (`source_type meri_approved_execution`, which also hits the partial UNIQUE on tasks);
- the completion.

A repeat answers the stored result only after every check passed again on the database clock. A claimed row without a result answers UNKNOWN and is never redispatched.

**Decision revocation.** The approver calls `POST /api/clio/approvals/native/revoke` (the same body and auth as `approval/decision`). Core writes an append-only `clio_meri_approval_revocations` row under the proposal lock; the decision row stays immutable. From then on:
- `approval/decision` and `approval/record` answer `revoked: true`, and Meri's `readDecision` treats that as no decision;
- issuance, receipt and completed-result release all refuse.

The revocation and an effect serialize on the same lock. **Run cancellation and fence changes** come from Meri's owner: its `revoke` sets the grants to REVOKED, and a fence move changes the run row. The admission predicate sees either one at the next issuance, effect or release.

## 6. Receiver: `POST /api/clio/tools/create_task` with the capability

**Middleware admission.** The tenant middleware admits the capability only on this exact path:
- signature, issuer, audience and time;
- no tenant or impersonation header;
- an existing active member with at least `standard_user`.

Service identity and the allowlist still apply.

**Receiver checks**, all under the proposal lock and Meri's budget lock:
- **Identity.** The tool is `create_task`, and the capability is fully re-verified.
- **Body.** The body equals `sourceBodySha256` and maps back to `argumentsSha256`.
- **Ledger.** Core's issuance row matches exactly and is the newest.
- **Decision.** The current decision is unrevoked.
- **Admission.** Meri's admission predicate passes, **including this capability's own execution grant**: ACTIVE, unexpired, with the token's digest.
- **Clock.** The database clock is before the token `exp`, the decision expiry and the admission deadline. It is checked once under the locks (before any completed-result release) and again **at the effect boundary**.
- **Membership.** It is active with at least `standard_user`.
- **Clients.** The client is inside the approved scope, and the wall is current.

**No fallback (dot 6247742665 item 3).** In the `first-chat-preview` profile, where Meri is the only tool caller, `create_task` is refused on the ordinary bearer path. A capability that fails admission is refused at the receiver and never retried as an ordinary call. Other deployments keep their existing orchestrator path.

## 7. Questions and answers

1. ~~**Budgets.**~~ They are derived from the owner's allocation and bounded only by configured platform maxima.
2. ~~**Issuance request.**~~ Meri's rev 3 body is accepted, and every member must equal Meri's admission owner.
3. ~~**Replay.**~~ The same immutable token is returned only after fresh current authority, with a fresh `checkedAtMs`.
4. ~~**Receiver.**~~ Durable consumption, the canonical admission and database-clock checks at release and at the effect.
5. ~~**Revocation, client scope, no fallback, configurable bounds**~~ (dot 6247742665): implemented.
6. **Open:** Meri's executor and lifecycle callers of `revoke` (R0 lane L/cancellation).

## 8. Keys and grants (deployment packet only)

One AWS KMS key: `KeySpec ECC_NIST_EDWARDS25519`, `KeyUsage SIGN_VERIFY`, signed with `ED25519_SHA_512` over RAW.

The Core task needs:
- `MERI_EXECUTION_SIGNER_{ISSUER,KID,KMS_KEY_ARN,PUBLIC_KEY_X}`;
- optionally `MERI_EXECUTION_MAX_*`;
- `kms:Sign` on the key only.

Core's database role (`capiro_app` in Core source; the packet reads back the app credential's username) needs:
- USAGE on schema `meri_core_authority` and EXECUTE on exactly `meri_core_authority.current_admission_v1(uuid)`. It needs no grant on Meri's tables: the function's NOLOGIN owner holds SELECT and the one-column privilege `FOR SHARE` requires;
- SELECT on `meri_commands.approval_metadata` (D17).
