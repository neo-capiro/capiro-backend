# Meri execution capability — DRAFT `capiro.meri-execution-capability.v1`

**Status: DRAFT for review.** Nothing is minted, mounted, keyed or activated.

**Who does what** (dot, #121 6246253130):

| Role | Owner |
| --- | --- |
| Draft | Core integration owner |
| Consumer and lifecycle review | R0 |
| Cross-repo fit review | dot |

**What exists in source (capiro-backend #84):**
- the pure codec `apps/api/src/meri/execution-capability/meri-execution-capability.ts`, with its spec;
- the async signer shape `apps/api/src/auth/core-ed25519-signer.ts`;
- the golden vector `docs/integration/meri-execution-capability.vector.json` (a SYNTHETIC key; production-shaped since rev 3: a 64-hex policy revision, closed task arguments, an allocation and qualification facts).

**Revisions:** rev 2 bound the `create_task` body projection; rev 3 applies dot's review (#121 6246551969): budgets from the authenticated allocation, the allocation hash, the qualification facts, and a trusted comparison before dispatch. D19 stays open for the composition fixes below.

This draft closes ledger D19's spec gap only once R0 and dot agree that it matches.

## 1. What Meri needs (meri-greenfield `497479c7`)

| Meri site | Requirement this contract satisfies |
| --- | --- |
| `apps/control/intents/approval.mjs` `execute` | `issueExecution({proposal,principal})` returns `{execution, credential, checkedAtMs, expiresAtMs}`, closed, in that order.<br>`execution` is `CommandExecutionRequest`. Its `proposalId`, `commandSha256` and `idempotencyKey` must equal the proposal's.<br>`executorBinding` must keep the proposal's tenant, actor, conversation and run.<br>`credential` is a non-empty string. `checkedAtMs` lies in `[started, now]`, and `expiresAtMs > now`. |
| `apps/gateway/authorization/current-tool-authority.mjs` `identify` | `verifyCapability(credential)` returns `CapabilityClaims` JSON, closed.<br>`audience` is `meri-gateway`, and `actions` includes `command.execute`.<br>`issuedAt` is at or before now, which is before `expiresAt`.<br>Every scope's tenant equals `binding.tenantId`, and its `policyRevision` equals `claims.policyRevision`. |
| `apps/control/commands/approval-context.mjs` | The current decision's `policyRevision` equals the capability's `policyRevision`, and its approver equals the proposal's `requiredApprover`. |
| `packages/contracts/meri.schema.json` | `CapabilityClaims`, `CommandExecutionRequest` 0.1.0, `RunBinding`, `Scope` and `Budgets`, all closed. |
| `apps/gateway/budget/postgres-tool-budget.mjs` `bindTrustedGrant` | Grant facts are immutable per `grant_id`. |

## 2. Token

A JWS in compact form: `base64url(header).base64url(payload).base64url(signature)`. At most 8192 bytes in total, and the signing input is at most 4096 bytes (the KMS RAW limit).

- **Header.** Exactly `{"alg":"EdDSA","typ":"capiro-meri-execution+jwt","kid":"<kid>"}`, in that byte order.
- **Payload.** Its bytes are **exactly the RFC 8785 (JCS) form** of the payload object, so it is not malleable. Every object is closed and every key required.
- **Signature.** Pure Ed25519 (RFC 8032), 64 bytes.

| Payload member | Value and binding source |
| --- | --- |
| `iss` | Core issuer label, e.g. `capiro-core:meri-execution:v1` |
| `aud` | `meri-gateway` |
| `iat` = `nbf` | Issuance second |
| `exp` | `min(iat + 120, decision.expiresAt, proposal.expiresAt, run deadline)`, always greater than `iat` |
| `jti` | `capabilityId`, a UUIDv4 and the replay key |
| `capability` | Exactly Meri `CapabilityClaims`:<br>- `capabilityId = jti`, `issuer = iss`, `audience = aud`;<br>- `binding` = the **executor** RunBinding (same tenant, actor, conversation and run as the proposal; current attempt, worker and fence);<br>- `actions = ["command.execute"]` only;<br>- `scopes` = `proposal.command.scopes` verbatim;<br>- `issuedAt` / `expiresAt` = ISO forms of `iat` / `exp`;<br>- `policyRevision` = `decision.policyRevision`, which must equal every scope's revision;<br>- `budgets` copied from the authenticated `currentAllocation` (Meri's admitted-run owner), mapping `maxCostMicroUSD` to `maxCostMicrousd`. Caller-chosen numbers are refused. |
| `execution.requestId` / `proposalId` / `commandSha256` / `idempotencyKey` | Fields of the `CommandExecutionRequest` |
| `execution.action` | `proposal.command.action`. `task.create` only (Meri `APPROVABLE_ACTIONS`). |
| `execution.argumentsSha256` | `SHA-256(JCS(proposal.command.arguments))`, the approved command |
| `execution.sourceBodySha256` | `SHA-256(JCS(commandSourceBody(command)))`: Meri's exact `create_task` body (`source-projection.mjs`, which drops a null `clientId`/`dueDate`; dot 6246527853). `TaskCreateArguments` is closed `{title, clientId, dueDate}`. |
| `execution.clientIds` | The scopes' client `resourceId`s, lowercase, sorted and unique |
| `execution.decisionSha256` | `SHA-256(JCS(ApprovalDecision))`: the immutable approved decision (R12 row) |
| `execution.approver` | The decision approver. It must equal the binding's tenant and actor. |
| `execution.requestSha256` | `SHA-256(JCS(CommandExecutionRequest))`, which the verifier recomputes |
| `execution.allocationSha256` | `SHA-256(JCS(currentAllocation))`, the allocation the budgets came from (Meri grant fact `allocationSha256`) |
| `execution.qualification` | Meri grant fact `qualificationBinding`: `{runId, attempt (numeric), workerArn (ECS task ARN), fence, policyRevision}`. It must match the executor binding's run and fence and the decision's revision; UUID attempt/worker ids cannot substitute for it. |

## 3. Issuance (Core owner; route proposed, not mounted)

**Route:** `POST /api/clio/approvals/native/execution` with body `{proposal, executorBinding, requestId}`. Same auth as R12: native session bearer, verified service secret, `standard_user`. It answers HTTP 200 with the Meri `issueExecution` receipt.

**Preconditions.** Core issues only when every one of these holds:
1. The caller is the approver, the proposal's `requiredApprover` and the conversation owner (R12 rules).
2. The **stored** R12 decision for (tenant, proposal) is `approved`, unexpired and has the same `commandSha256`. Proposal integrity is recomputed.
3. The executor binding keeps the proposal's tenant, actor, conversation and run.
4. The action is `task.create`.
5. Every scope's revision equals the decision's `policyRevision`, and the client scopes are still visible to the actor.
6. The issuance ledger has no live capability for (tenant, proposal, run, attempt). If one exists, Core answers that same receipt again.

**Issuance ledger.** A Core table, insert-only and under RLS, with one row per capability: `jti`, tenant, proposal, run, attempt, `decisionSha256`, `requestSha256`, `exp` and `revokedAt`. Its migration is reserved only after this draft is agreed.

## 4. Verification

The same checks run in Meri's `verifyCapability` port and in Core's receiver branch. `verifyMeriExecutionCapability`:
- **Key:** the exact header, a `kid` from the pinned key set, and a valid pure-Ed25519 signature.
- **Payload:** byte-identical to its JCS form.
- **Claims:** `iss` is pinned, `aud` is `meri-gateway`, `nbf = iat ≤ now < exp`, and `exp − iat ≤ 120`.
- **Capability:** it must match `jti`, `iss`, `aud`, `iat` and `exp`, with exactly one action.
- **Scopes:** each scope's tenant and revision match, with no duplicates, and `clientIds` is re-derived.
- **Request:** `requestSha256` is recomputed.

Meri receives `claimsJson`, the exact `CapabilityClaims`. Public keys reach Meri as pinned OKP JWKs `(iss, kid) → x`. Meri never fetches keys at run time.

**Verification is only self-consistency.** Before any dispatch, the holder must also run `assertExecutionMatches` against the actual external `CommandExecutionRequest`, the approved proposal, the current decision, the allocation and the qualification facts. Every hash and the scopes must be equal.

## 5. Replay and revocation

**Both receiver behaviours below are obligations, not supplied behaviour** (dot 6246534408). Nothing is mounted until they exist.

- **Replay at Meri.** `jti` is unique in Core's issuance ledger. Meri binds grant facts immutably per grant (`bindTrustedGrant`). The command journal claims `(proposal, idempotencyKey)` once, so a replay *through Meri* gets the journaled outcome.
- **Replay at Core (unique consumption, required).** Unique issuance is not unique consumption: the same capability, service identity and body could otherwise reach the Core receiver repeatedly. The receiver must claim a durable effect identity, `(tenant, proposalId, commandSha256, idempotencyKey)`, in a Core consumption row **in the same transaction as the effect**, and store the result there. A repeat answers the stored result. If a claim exists with no result, it answers `UNKNOWN` and **never redispatches**. One capability is consumed at most once.
- **Revocation.** There is no capability revocation list, by design. The token lives at most 120 s. Inside that window the executor already re-checks CURRENT facts:
  - **`approval/decision`:** a revoked or absent decision refuses the execution.
  - **`currentRun`:** a fence or attempt change refuses it.
  - **`authorizeBusiness`:** a membership or policy revision change refuses it.

  Core's receiver branch would also refuse a ledger row whose `revokedAt` is set.
- **Revocation is not supplied today.** R12 decisions are immutable, and `approval/decision` always answers `revoked: false`: there is no revocation record or path. Before the receiver mounts, Core must add an append-only decision-revocation record, answer `revoked: true` from `approval/decision`, and set the capability's `revokedAt` on decision revocation, membership loss or run cancellation. Until then the only bounds are the 120 s TTL and the CURRENT run and policy checks.

## 6. Receiver branch: the executor with no user bearer (dot 6246253130)

**Attended UI calls keep native auth unchanged.** For the executor or lifecycle path, which has no user bearer, the verified capability **is** the authority that is bound to the run and the approval. Core would accept `Authorization: Bearer <capiro-meri-execution+jwt>` together with the verified service secret, and **only** for:

1. **`POST /api/clio/approvals/native/decision`,** when the body's proposal, `commandSha256` and binding (tenant, actor, conversation, run) equal the token's. This is `executionCoversDecisionRead` in source.
2. **`POST /api/clio/tools/create_task`,** when `SHA-256(JCS(body))` equals `execution.sourceBodySha256`, the actor and client scopes are the token's, and the §5 consumption claim succeeds.

It is never the control credential and never any other route or tool. **Not mounted.** This branch stays open until R0 and dot agree on it, because it changes which credential the tool route accepts.

## 7. Questions and answers (dot #121 6246551969)

1. ~~**Budgets.**~~ Copied from the authenticated `currentAllocation`, with the allocation hash bound (rev 3).
2. ~~**Clock.**~~ Meri's trusted adapter stamps `checkedAtMs` with its own local observation after a correlated fresh Core response; the signed `iat`/`exp` are enforced separately. An idempotent re-issue may return the same immutable token, but only after a fresh current-authority check.
3. ~~**Tool input.**~~ Answered by dot (6246527853): the body is Meri's projection, not `command.arguments`. Both hashes are now bound.
4. ~~**Lifecycle issuance.**~~ A ≤120 s approved-execution token cannot bootstrap a pre-approval wait or an arbitrary continuation. Core owns current approval and issuance; R0 owns the proposal reader, continuation authority and admission, and the executor binding. #150 read delegation does not authorize unattended write capabilities.
5. ~~**Grant mapping.**~~ `grantId = capabilityId (jti)`. The grant binds the exact executor RunBinding, `qualificationBinding`, the SHA-256 of the exact compact token (`capabilitySha256`) and `allocationSha256`. `bindTrustedGrant` requires an already ACTIVE matching row; it neither creates nor activates a grant, so the existing grant owner creates it on the same allocation.
6. **Suppliers (R0).** `currentRun` and `currentAllocation` come from `createPostgresAdmittedRunOwner`. Business and source authority come from Core's canonical current membership, client, policy and source owners through exact current-tool-authority adapters. `createIntentResultRelease` only validates a supplied authority. The executor's pre-release re-checks stay.

## 8. Keys (deployment packet only)

An Ed25519 key, either an AWS KMS `ECC_NIST_EDWARDS25519` SIGN_VERIFY key signed with `ED25519_SHA_512` over a **RAW** message (pure Ed25519), or an in-process key. `createKmsEd25519Signer` never requests DIGEST (Ed25519ph). It checks every signature against the pinned `GetPublicKey` readback.

The `kid` is a short label (`[A-Za-z0-9._-]{1,64}`). The KMS ARN stays server-side. The key, its key policy and the pinned JWK are created only in the deployment packet.
