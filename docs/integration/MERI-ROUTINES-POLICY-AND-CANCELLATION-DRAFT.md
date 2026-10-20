# Meri routines: selection-policy receipt and cancellation proof — DRAFT

**Status: DRAFT for R0/laneB review** (assigned to Core by dot, #121 6246642210).

**Source:**
- `apps/api/src/meri/routines/*`, with specs.
- The reserved migration `20281018030000_clio_meri_routine_authority` (**not applied**).

**Not mounted:** `MeriRoutinesModule` is absent from `AppModule`. No key exists: the cancellation signer is `null`, so the
proof route answers 503.

**Out of scope:**
- **Unattended firing.** The routine grant, whole-grant accounting and revocation custody stay **HELD** under Meri's
  normative `docs/coordination/contracts/CODEX-ROUTINE-GRANT-PROPOSAL-20261017.md`.
- **The pending #121 6246196380 policy.** It is read-only delegation and authorizes no unattended execution, writes or
  routine grants (dot 6246642210). Nothing here infers authority from it.

Meri sources are cited at meri-greenfield `09781127` unless noted.

## 1. Meri contracts this answers

| Meri site | Requirement |
| --- | --- |
| `apps/runtime/product-ports/routines.mjs` `PRODUCTION_ROUTINE_OWNERS` | `context.policy` is a "Core schedule policy receipt route (fresh owner/client/tenant authority per selection)". `runControl` is a "Core unattended-grant proof for a service-authenticated cancellation of the owner's run (no service privilege)". |
| `apps/control/schedules/runtime-context.mjs:24-56` `policy()` | `check({selection, selectionSha256, signal, limitDeadline})` answers **exactly** `{authorized: true, selectionSha256, binding, scopes, selectedClientId, destinationResolution, limits, checkedAtMs, expiresAtMs}`. For list/cancel, the destination and limits are `null`. The spec checks every receipt against these acceptance rules as an oracle. |
| `runtime-context.mjs` `resolve` / `authorizeRequest` / `authorize(phase)` | Each runs with the caller's native session credential (`createRequestCurrent`), so every policy check is **attended**. Effective limits are `min(requested, receipt, allocation)`. |
| `apps/control/schedules/scheduled-run-cancellation.mjs` | An approved `cancel_scheduled_task` with `running: 'request_cancel'` re-selects the exact same-work runs. It then calls `runControl.cancel({binding, signal, deadlineMs})` inside the approval request's lifetime (`maxRequestMs`). |

## 2. Authority: what proves the owner's current rights

Both routes require all three of the following, the same as R12/R13:
- the **verified service identity** (`x-internal-service-secret`, `hasVerifiedToolServiceIdentity`);
- the **native session** bearer of the routine owner;
- `standard_user`.

The owner's current rights are Core's **canonical application-membership receipt**, from
`ApplicationMembershipService.read`:
- the identity is rechecked across reads;
- the tenant and membership are active, with the role floor;
- the client list is filtered by the memory wall;
- the membership revision is included.

A membership receipt alone is never treated as policy. The decision below also binds the exact selection, scopes,
schedule owner and destination.

## 3. Parsing: a minimal digest-bound subset, not a second validator

Core does **not** vendor Meri's schedules-0.2 validators. `tool-interface.schema.json` and `lifecycle.schema.json` `$ref`
each other and the whole `meri.schema.json`, so a copy would become a second schema owner that drifts.

Instead, Core recomputes Meri's own RFC 8785 digests (`selectionSha256`, `intentSha256` and every `projectionSha256`).
It then parses closed only the members it decides on:
- `operation`;
- the operation's exact request key set;
- `destinationReference` and `scheduleId`;
- `current.{binding, scopes, selectedClientId}`;
- the `owner`/`scopes`/`scheduleId` of `currentSchedule.projection` and of a pending `proposal.projection`;
- for cancellation, the intent's `operation`, `projection` and `cancel.{mode, running, runs}`.

Every other byte is bound by the digest. The schema files are pinned in `MERI_SCHEDULES_SCHEMA_PINS`:
- `tool-interface` `2de84501…`;
- `lifecycle` `0b391e3e…`.

## 4. Wire A — `POST /api/clio/routines/policy/check`

**Body:** `{selection, selectionSha256}`, where the selection is Meri's exact object.

**Authorized when all of these hold** (otherwise 403; a malformed body is 400):
1. The session principal equals both the membership receipt and `current.binding`'s tenant and actor.
2. All scopes belong to this tenant and share one `policyRevision`, and every client scope is in the member's
   `clientIds`.
3. `selectedClientId` is null or in `clientIds`.
4. `currentSchedule`, and any pending `proposal`, is owned by the principal with the same scopes and the same
   `scheduleId` as the request.
5. For create and update, the destination reference is `meri-inbox`, the only supported destination. It answers
   `{reference, destinationId: 'meri-inbox'}`.

**Limits.** Reconciled with existing approved semantics; nothing is new policy. They are the pinned, approved first-chat
allocation budgets (meri-greenfield `9ce9ecd5` `infra/product-preview/first-chat/allocation.json`, sha256 `d9cd9a84…`;
D1 is $2 per run). Meri then takes the minimum with the routine's own sealed allocation, so the receipt is a ceiling,
never a grant.

| Limit | Value | Allocation field |
| --- | --- | --- |
| `maxCostMicrousd` | 2,000,000 | `maxCostMicroUSD` |
| `maxRuntimeSeconds` | 900 | `maxRuntimeSeconds` |
| `retryLimit` | 0 | `maxRecoveryAttempts` 0, the supported routine profile |

**Lease.** `expiresAtMs = min(membership receipt expiry, now + 30 s)`. The membership receipt expiry is the native
session's; 30 s is Meri's own request bound (`maxRequestMs` ≤ 30000). No new lease value is introduced.

**Clock.** Meri's trusted adapter stamps its own observation after a correlated fresh Core response, as dot set for R14.

## 5. Wire B — `POST /api/clio/routines/cancellation-proof`

**When it is called.** During the attended approval of the cancellation.

**Body:** `{intent, intentSha256, decision, targets}`.
- `runs` comes from `intent.cancel.runs`.
- `targets` is the exact RunBindings of `expectedLineage`.

**Core's checks:**
- `intentSha256` is the intent's RFC 8785 hash.
- The intent is `cancel_scheduled_task` with `running: 'request_cancel'`, owned by the principal, and its scopes pass §4
  rule 2.
- The decision is an `approved` `ApprovalDecision` for `proposalId = intentId` and `commandSha256 = intentSha256`. Its
  approver is the owner, its `policyRevision` is the intent's, and it is unexpired. This mirrors Meri's `approved()`.
- Every target is a run of that owner.

**Proof.** An EdDSA compact JWS (`typ capiro-meri-routine-cancel+jwt`, `aud meri-schedule-run-control`), signed through the
shared `CoreEd25519Signer`, with an exact RFC 8785 payload. It carries:

```
{tenantId, ownerActorId, scheduleId, intentId, intentSha256, decisionSha256, runs, targets}
```

Its lifetime is at most 30 s (Meri's request bound, within which the cancellation runs) and never past the decision. This
is existing semantics.

**Use.** The proof authorizes **only stopping those exact owner runs** (`cancellationCoversRun`). It grants no execution,
read or write. A replay re-requests the same stop.

**Reference verifier.** `verifyRoutineCancellationProof` is the reference for Meri's run-lifecycle cancel owner: pinned
key, issuer and audience, exact header and payload bytes, TTL, and every target owned by `ownerActorId`.

**Ordering.** The consent row and the proof's `jti` are recorded **before** signing, so every released proof has a
ledger row.

## 6. Storage — reserved, not applied

Migration `20281018030000_clio_meri_routine_authority` follows the Objective workload delegation pattern:
- **`clio_meri_routine_approvals`** (the consent row): the owner's approval of one exact intent.
  - Key: `(tenant, intent_id)`, plus the intent and decision digests, the schedule, the operation and the decision window.
  - **`CHECK (unattended_enabled = false)`**: no row can authorize unattended firing until a later reviewed migration,
    under the held routine-grant contract, lifts the fence.
  - An exact replay reuses the row; a different digest for the same intent answers 409.
- **`clio_meri_routine_cancel_proofs`** (the issuance ledger): one row per `jti`, with claims digests only, never the
  token. It has an FK to the approval **without cascade**, so deleting an approval never releases a proof, and a check
  that `exp - iat ≤ 30`.
- **Both tables:** immutability triggers, FORCE RLS on `tenant_id`, and insert-only grants for `capiro_app`.

## 7. Open items for R0/laneB

1. **Limits.** dot asked R0/laneB to reconcile them with D015 / `6f315108`. D015 sets no routine timing, and
   `6f315108`'s receiving code applies `min(requested, receipt, allocation)`. Core therefore proposes the pinned approved
   allocation (§4). Confirm that this is the right existing source.
2. **Destination vocabulary.** Only the reference `meri-inbox` is accepted. Confirm the reference strings the schedule
   tool emits.
3. **Meri consumer.** Does Meri's run-lifecycle cancel owner accept a Core proof in place of a session? The verifier and
   the journal custody of the proof are Meri's.
4. **Listener.** Both routes are POSTs on the preview host. They fit as one more value in the P3 native-operations
   condition (up to 3 values): `^/api/clio/routines/(policy/check|cancellation-proof)$`. Not encoded until review.
5. **Keys.** One more Ed25519 key, created only in the deployment packet.
6. **Firing grant.** Unchanged and held. Create/update approvals have a consent table ready, but no route records them
   yet. That waits for the routine-grant owners and Neo's unattended policy.
