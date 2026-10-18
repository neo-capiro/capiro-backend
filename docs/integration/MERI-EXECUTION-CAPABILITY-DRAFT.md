# Meri execution capability — `capiro.meri-execution-capability.v1` (rev 5)

**Status: in source on capiro-backend #84, not deployed.** The issuance route and the `create_task` receiver exist. Both answer 503 until all of these are in place:
- the four `MERI_EXECUTION_SIGNER_*` values;
- the KMS key (created only in the deployment packet);
- Core's SELECT on Meri's run owner tables (§3).

The ledger migration `20281018040000_clio_meri_execution_authority` is reserved and NOT applied.

**Who does what** (dot, #121 6246253130; R0 6247577743):

| Role | Owner |
| --- | --- |
| Draft and Core source (issuance agreement, replay, receiver) | Core integration owner |
| Meri's 13-field verifier and the ACTIVE execution-grant installer | Meri lane X (in progress) |
| Consumer and lifecycle review | R0 |
| Cross-repo fit review | dot |

**Shape note.** dot reviewed rev 3's 13-field execution member (#121 6247443108 / 6247464370), and R0 assigned Meri lane X to adopt it. Rev 5 keeps that shape. Meri's verifier at the integration tip (`10f01297`) still closes the member to 10 keys, so it refuses rev 5 tokens until lane X lands. A rev 4 that dropped to 10 keys to match Meri `1cc5a554` was never pushed.

**What exists in source:**

| Piece | File |
| --- | --- |
| Codec: issue, verify, trusted comparison, Meri's request id, allocation budgets, qualification, body inverse | `apps/api/src/meri/execution-capability/meri-execution-capability.ts` |
| Meri run owner reader | `apps/api/src/meri/execution-capability/meri-admitted-run.reader.ts` |
| Issuance service and route | `apps/api/src/meri/native-approvals/native-execution.service.ts` (`POST /api/clio/approvals/native/execution`) |
| Receiver | `apps/api/src/meri/execution-capability/meri-execution-receiver.service.ts`, called from `MeriController.executeTool` |
| Middleware admission | `apps/api/src/tenant/tenant-context.middleware.ts` (`useMeriExecutionCapability`), `apps/api/src/auth/meri-execution-request.ts` |
| KMS configuration and signer | `apps/api/src/auth/core-ed25519-kms-config.ts`, `apps/api/src/auth/core-ed25519-signer.ts` |
| Ledger | `apps/api/prisma/migrations/20281018040000_clio_meri_execution_authority/migration.sql` |
| Codec vector (minimal allocation, SYNTHETIC key) | `docs/integration/meri-execution-capability.vector.json` |
| Complete admitted-allocation vector | `docs/integration/meri-execution-admitted-allocation.vector.json` |

The complete vector's allocation is composed by Meri's own `composeGeneralReadAllocation` (D016 default run budgets) and parses with Meri's `allocation()`.

**Cross-check with Meri's own code** (integration tip `10f01297`). These all match:
- `executionRequestId`;
- `capabilityBudgets` (exact budgets and `allocationSha256`);
- `commandSourceBody` (`sourceBodySha256`);
- `parseToolGrantFacts` (qualification and allocation as grant facts);
- `exp*1000`.

Meri's verifier refuses only on the 10-key closure.

## 1. What Meri needs

| Meri site | Requirement this contract satisfies |
| --- | --- |
| `apps/runtime/native-authority/execution-issuance.mjs` | Posts `{proposal, executorBinding, requestId, budgets, allocationSha256}` with the attended approver's native bearer and the service secret. Requires a closed receipt `{execution, credential, checkedAtMs, expiresAtMs}` where `expiresAtMs === exp*1000`, `execution` equals the verified request, and budgets are exactly equal to its own. |
| `apps/runtime/native-authority/execution-capability.mjs` | `executionRequestId`, `capabilityBudgets`, `assertExecutionCorrelation`, and the closed execution member (13 keys after lane X). |
| `apps/runtime/native-authority/execution-grant.mjs` | `executionGrantFacts` binds `qualificationBinding` and `allocationSha256` from the run's admitted grant set; the signed facts must equal them. |
| `apps/control/commands/source-http.mjs` | `POST /api/clio/tools/create_task` with `Authorization: Bearer <capability>`, the service secret, and the null-omitting body. Requires HTTP 200 JSON. |

## 2. Token

A compact JWS of at most 8192 bytes; the signing input is at most 4096 bytes.
- **Header:** exactly `{"alg":"EdDSA","typ":"capiro-meri-execution+jwt","kid":"<kid>"}`.
- **Payload:** its bytes are exactly its RFC 8785 form.
- **Signature:** pure Ed25519.

| Payload member | Value |
| --- | --- |
| `iss`, `aud` | Core issuer label; `meri-gateway` |
| `iat` = `nbf`, `exp` | `exp = min(iat + 120, decision.expiresAt, proposal.expiresAt, run deadline)`. The run deadline is `started_at + maxRuntimeSeconds` and `schedule.expiresAt`, from Meri's owner. |
| `jti` | `capabilityId` (UUIDv4) |
| `capability` | Exactly Meri `CapabilityClaims`. `budgets` is derived from the admitted allocation exactly as Meri's `capabilityBudgets` derives it. |
| `execution.requestId` … `requestSha256` | Request id (Meri's deterministic id), proposal, command hash, idempotency key, `task.create`, `argumentsSha256`, client ids, `decisionSha256`, approver, `requestSha256` |
| `execution.sourceBodySha256` | `SHA-256(JCS(commandSourceBody(command)))`: Meri's exact `create_task` body |
| `execution.allocationSha256` | `SHA-256(JCS(admitted allocation))`, read from Meri's allocation owner |
| `execution.qualification` | `{runId, attempt, workerArn, fence, policyRevision}`, read from Meri's run owner. It must be the executor's run and fence, at the decision's policy revision; the worker ARN uses Meri's pinned account pattern. |

## 3. Issuance: `POST /api/clio/approvals/native/execution`

**Auth:** the same as R12. Native session bearer, verified service identity, `standard_user`, `Cache-Control: no-store`, HTTP 200.

**Request:** the body is closed: `{proposal, executorBinding, requestId, budgets, allocationSha256}`.

**Preconditions.** Every call re-runs all five, a replay included:
1. The caller is the proposal's `requiredApprover`, and is also the executor binding's tenant and actor.
2. The stored R12 decision for (tenant, proposal) meets all of these:
   - it is approved and unexpired;
   - it is for this `commandSha256`, actor, conversation and run;
   - the caller approved it.

   The proposal must also equal Meri's prepared approval metadata.
3. The executor binding keeps the proposal's tenant, actor, conversation and run. `requestId` must equal Meri's `executionRequestId` for this exact executor binding.
4. The action is `task.create`, with closed arguments and no attachments. A non-null `clientId` is a UUID.
5. Every scope belongs to this tenant at the decision's policy revision. Every client (scopes and `arguments.clientId`) is visible to the actor now.

**Allocation and qualification come from an authenticated owner, never from the caller** (dot item 2). Core reads Meri's run owner tables on its own transaction, the way it already reads `meri_commands.approval_metadata`:

```sql
SELECT r.run_id, r.attempt, r.worker_arn, r.fence, r.policy_revision,
       a.allocation, a.allocation_sha256, a.started_at
  FROM meri_product_budget.runs r
  JOIN meri_product_budget.tool_run_allocations a ON a.run_id = r.run_id
 WHERE r.run_id = $executorRun
```

It requires all of these:
- exactly one row;
- the stored hash equals the RFC 8785 hash of the stored allocation;
- the allocation's run is the executor's;
- the qualification is the executor's run and fence at the decision's revision;
- the run deadline is still ahead.

The request's `budgets` and `allocationSha256` must **equal** the owner's, as an exact copy. A request above the D016 B1 envelope is refused. If the tables are unreadable, Core answers 503.

**Ledger** (`clio_meri_execution_issuances`, immutable, RLS): one row per capability. Each row holds the hashes, the executor binding, the budgets, the allocation hash, the qualification, the signer, `iat` and `exp`. The row is written **before** signing, under a per-(tenant, proposal) advisory lock. An existing row decides the outcome:

| Existing state | Outcome |
| --- | --- |
| A live row for the same `requestId` | The same immutable capability is re-signed at its recorded `iat`, only after every precondition and the owner read pass again and all of these are identical: binding, budgets, allocation, qualification, decision and signer. `checkedAtMs` is Core's fresh observation, never the old receipt. |
| A live row for another attempt | 409 |
| A higher writer fence on the run | 409 |
| An expired row | A new capability is issued. |

**Receipt:** `{execution, credential, checkedAtMs, expiresAtMs}` with `expiresAtMs = exp*1000`.

## 4. Verification

`verifyMeriExecutionCapability` checks:
- the exact header, a pinned `kid`, and a pure Ed25519 signature;
- payload bytes equal to their JCS form;
- `iss` and `aud`, and `nbf = iat ≤ now < exp` with `exp − iat ≤ 120`;
- the capability against the payload;
- scope tenant and revision, with no duplicates;
- `clientIds` re-derived and `requestSha256` recomputed;
- the qualification bound to the binding and the policy revision.

Verification is only self-consistency. `assertExecutionMatches` compares the token with the actual request, proposal, current decision, allocation and qualification.

## 5. Replay, consumption and revocation

**Core consumption** (`clio_meri_execution_consumptions`) has one durable effect identity per (tenant, proposal, idempotency key), shared by every capability for that proposal. The receiver does all of the following in **one transaction**, so either everything commits or nothing does:
- the checks;
- the claim;
- the task write (`EngagementService.createTask` on the same transaction, with `source_type = meri_approved_execution` and `source_id = <proposalId>|<idempotencyKey>`, which also hits the existing partial UNIQUE on tasks);
- completing the row with the JSON result.

A repeat answers the stored result. A claimed row without a result cannot commit in this design; if one is read it answers 409 UNKNOWN and is never redispatched.

**Revocation is still not supplied.** R12 decisions are immutable and `approval/decision` answers `revoked: false`. Within the ≤120 s window the receiver re-checks all of these: the current decision, membership, the client wall, Meri's run owner (attempt, worker, fence, allocation) and the ledger. A decision-revocation record needs an owner decision (ledger D33).

## 6. Receiver: `POST /api/clio/tools/create_task` with the capability

**Middleware admission.** The tenant middleware admits `Authorization: Bearer <capiro-meri-execution+jwt>` only on this exact path, for POST, with no query. It then checks:
- the signature, issuer, audience and time, against the configured key;
- no tenant or impersonation header;
- that the signed actor is an existing active member of an active tenant, with at least `standard_user`.

On any other path the bearer gets Clerk verification and fails. The service secret (`hasVerifiedToolServiceIdentity`) and the tool allowlist still apply.

**Receiver checks**, all before the effect and under the proposal lock:
- **Identity.** The tool is `create_task`. The whole capability is re-verified, and its `jti`, tenant and actor equal the admitted ones.
- **Body.** The body hashes to `sourceBodySha256` and maps back to closed arguments whose hash is `argumentsSha256`.
- **Ledger.** The capability is Core's issuance row, with the same request, hashes, binding, budgets, allocation, qualification, window and signer. It is the newest issuance for the proposal.
- **Run.** Meri's run owner still holds the same allocation and qualification, before the deadline. An attempt or fence change at Meri refuses.
- **Decision.** The current decision hashes to `decisionSha256`. It is approved, unexpired, for this run, and at the signed revision.
- **Membership.** It is active with at least `standard_user`, re-read in the transaction.
- **Clients.** Every client is visible now.
- **Consumption.** As in §5.

The capability is never accepted on `approval/decision` or any other route. Lane L supplies the run- and proposal-bound executor forwarder for decision reads, with native plus verified service identity.

## 7. Questions and answers

1. ~~**Budgets.**~~ They are derived from the owner's admitted allocation, and the request must equal them exactly.
2. ~~**Issuance request (dot 6247464370 item 2).**~~ Meri's five members are accepted. Core proves the allocation and qualification from Meri's owner tables, not from the caller's hash. The complete admitted-allocation vector is published.
3. ~~**Replay (item 3).**~~ The same immutable token is returned only after a fresh current-authority check. The receipt's `checkedAtMs` is fresh; Meri stamps its own as well.
4. ~~**Receiver (item 7).**~~ Mounted in source with durable effect consumption and current checks; 503 until keyed.
5. **Open (D33):**
   - decision revocation;
   - whether `arguments.clientId` must also appear among the client scopes;
   - closing the ordinary bearer `create_task` in the preview.

## 8. Keys and grants (deployment packet only)

One AWS KMS key: `KeySpec ECC_NIST_EDWARDS25519`, `KeyUsage SIGN_VERIFY`, signed with `ED25519_SHA_512` over RAW (pure Ed25519).

The Core task needs:
- `MERI_EXECUTION_SIGNER_ISSUER` = `capiro-core:meri-execution:v1`;
- `MERI_EXECUTION_SIGNER_KID`;
- `MERI_EXECUTION_SIGNER_KMS_KEY_ARN` (server-side only);
- `MERI_EXECUTION_SIGNER_PUBLIC_KEY_X` (the `GetPublicKey` readback);
- `kms:Sign` on that key ARN only.

Meri pins the same `(issuer, kid, x)`.

Core's database role needs SELECT on `meri_product_budget.runs` and `meri_product_budget.tool_run_allocations`, and the SELECT on `meri_commands.approval_metadata` already listed as D17.
