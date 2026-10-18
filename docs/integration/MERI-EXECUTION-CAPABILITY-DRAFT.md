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
- the golden vector `docs/integration/meri-execution-capability.vector.json` (a SYNTHETIC key).

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
| `capability` | Exactly Meri `CapabilityClaims`:<br>- `capabilityId = jti`, `issuer = iss`, `audience = aud`;<br>- `binding` = the **executor** RunBinding (same tenant, actor, conversation and run as the proposal; current attempt, worker and fence);<br>- `actions = ["command.execute"]` only;<br>- `scopes` = `proposal.command.scopes` verbatim;<br>- `issuedAt` / `expiresAt` = ISO forms of `iat` / `exp`;<br>- `policyRevision` = `decision.policyRevision`, which must equal every scope's revision;<br>- `budgets` (see §7 Q1). |
| `execution.requestId` / `proposalId` / `commandSha256` / `idempotencyKey` | Fields of the `CommandExecutionRequest` |
| `execution.action` | `proposal.command.action`. `task.create` only (Meri `APPROVABLE_ACTIONS`). |
| `execution.argumentsSha256` | `SHA-256(JCS(proposal.command.arguments))`, the approved command |
| `execution.sourceBodySha256` | `SHA-256(JCS(commandSourceBody(command)))`: Meri's exact `create_task` body (`source-projection.mjs`, which drops a null `clientId`/`dueDate`; dot 6246527853). `TaskCreateArguments` is closed `{title, clientId, dueDate}`. |
| `execution.clientIds` | The scopes' client `resourceId`s, lowercase, sorted and unique |
| `execution.decisionSha256` | `SHA-256(JCS(ApprovalDecision))`: the immutable approved decision (R12 row) |
| `execution.approver` | The decision approver. It must equal the binding's tenant and actor. |
| `execution.requestSha256` | `SHA-256(JCS(CommandExecutionRequest))`, which the verifier recomputes |

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

## 7. Open questions (R0 / dot)

1. **Budgets.** `CapabilityClaims.budgets` is a Meri run-allocation fact. Should Core copy the issuance request's budgets, capped by a Core maximum, or should Meri drop the field for `command.execute`?
2. **Clock.** Meri requires `checkedAtMs ≥` its own call start. Core and Meri clocks differ, so either Meri allows a skew or Core echoes Meri's start time.
3. ~~**Tool input.**~~ Answered by dot (6246527853): the body is Meri's projection, not `command.arguments`. Both hashes are now bound.
4. **Lifecycle issuance.** Who issues for resume or `approval.wait`, when there is no attended request? This depends on the #150 delegation policy, which is pending with Neo.
5. **Grant mapping.** Is `grant_id` for `bindTrustedGrant` the `capabilityId`, and which grant facts does Meri bind?
6. **Other port suppliers.** `currentRun`, `authorizeBusiness`, `authorizeSources` and per-run result release still need production suppliers (D19). This draft covers only `verifyCapability` and `issueExecution`.

## 8. Keys (deployment packet only)

An Ed25519 key, either an AWS KMS `ECC_NIST_EDWARDS25519` SIGN_VERIFY key signed with `ED25519_SHA_512` over a **RAW** message (pure Ed25519), or an in-process key. `createKmsEd25519Signer` never requests DIGEST (Ed25519ph). It checks every signature against the pinned `GetPublicKey` readback.

The `kid` is a short label (`[A-Za-z0-9._-]{1,64}`). The KMS ARN stays server-side. The key, its key policy and the pinned JWK are created only in the deployment packet.
