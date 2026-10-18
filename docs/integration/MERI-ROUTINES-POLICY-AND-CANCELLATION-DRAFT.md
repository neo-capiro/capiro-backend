# Meri routines: selection-policy receipt and cancellation proof — DRAFT

**Status: DRAFT for R0/laneB review** (assigned to Core by dot, #121 6246642210). Nothing is implemented, mounted, keyed or
activated. This draft covers **two wires only**: the attended selection-policy receipt and the cancellation proof.

**Out of scope:**
- **Unattended firing** (routine grant, whole-grant accounting, grant revocation custody). It stays **HELD** under Meri's
  normative `docs/coordination/contracts/CODEX-ROUTINE-GRANT-PROPOSAL-20261017.md`.
- **The pending #121 6246196380 policy.** It is read-only delegation and authorizes no unattended execution, writes or
  routine grants (dot 6246642210). Nothing below infers authority from it.

Meri sources are cited at meri-greenfield `09781127`.

## 1. Meri contracts this answers

| Meri site | Requirement |
| --- | --- |
| `apps/runtime/product-ports/routines.mjs` `PRODUCTION_ROUTINE_OWNERS` | `context.policy` is a "Core schedule policy receipt route (fresh owner/client/tenant authority per selection)". `runControl` is a "Core unattended-grant proof for a service-authenticated cancellation of the owner's run (no service privilege)". |
| `apps/control/schedules/runtime-context.mjs:24-56` `policy()` | `check({selection, selectionSha256, signal, limitDeadline})` answers **exactly** `{authorized: true, selectionSha256, binding, scopes, selectedClientId, destinationResolution, limits, checkedAtMs, expiresAtMs}`.<br>Every echo must equal the selection. `checkedAtMs` lies in `[started, now]` and `expiresAtMs > now`.<br>For list/cancel, `destinationResolution` and `limits` are `null`. Otherwise the destination is `{reference: request.destinationReference, destinationId: 'meri-inbox'}` and limits are `{maxCostMicrousd ≥1, maxRuntimeSeconds ≥1, retryLimit ≥0}`. |
| `runtime-context.mjs` `resolve` / `authorize` | Meri calls the check at `before_preparation_release`, `resolve`, and each lifecycle `authorize(phase)`, always inside a **live native session** (`createRequestCurrent` over the caller's credential). Effective limits are `min(requested, receipt, allocation)`. A later receipt may not shrink below the approved projection. |
| `apps/control/schedules/scheduled-run-cancellation.mjs` | A human-approved `cancel_scheduled_task` with `running: 'request_cancel'` re-selects the exact same-work runs. It then calls `runControl.cancel({binding: currentBinding, signal, deadlineMs})` for that occurrence's current run only. |

## 2. Wire A — selection-policy receipt (attended)

**Route:** `POST /api/clio/routines/policy/check`, HTTP 200, `Cache-Control: no-store`.

**Auth:** the same as R12/R13: native session bearer, verified `x-internal-service-secret`, and `standard_user`. Every Meri
caller phase runs with the user's session, so this wire is attended and no service privilege is involved.

**Body:** `{selection, selectionSha256}`. The selection is Meri's exact object, `{phase, operation, request, currentSchedule,
proposal, current: {binding, scopes, selectedClientId}, scheduleBinding}`.

**Core's checks.** Core recomputes `selectionSha256` as RFC 8785 SHA-256. It parses closed only the members it decides on;
the rest are bound by the hash, so Core needs no second schedules-0.2 parser. The operation is one of `schedule_task`,
`update_scheduled_task`, `list_scheduled_tasks` or `cancel_scheduled_task`. **Authorized** requires all of:

1. **Principal.** The session principal equals the `current.binding` tenant and actor.
2. **Membership.** The current application membership is active. This reuses `ApplicationMembershipService` facts and is
   never membership alone as policy.
3. **Client.** `selectedClientId`, if any, is in the member's `clientIds`.
4. **Scopes.** Every scope belongs to this tenant, all share one `policyRevision`, and client scopes are within `clientIds`.
5. **Existing schedule.** When `currentSchedule` or `proposal` is present, its owner is the principal and its scopes equal
   `current.scopes`.
6. **Destination (create and update).** `request.destinationReference` must resolve to `meri-inbox`, the only supported
   destination. Any other reference is refused, because no other output adapter exists.

**Limits (create and update).** Each comes from existing approved semantics, or is flagged:

| Limit | Value | Basis |
| --- | --- | --- |
| `maxCostMicrousd` | 2,000,000 | D1, Neo-approved: $2 per run (lane-5 doc, budget row). |
| `retryLimit` | 0 | The only supported static profile (routine-grant contract, "Current PR128 receiving profile"). |
| `maxRuntimeSeconds` | **NEW POLICY, flagged.** | No approved value exists. Core requires an explicit `ROUTINES_POLICY_MAX_RUNTIME_SECONDS`, with no default. When it is unset, the route answers 503 rather than guessing. |

**Lease.** `expiresAtMs = min(checkedAtMs + lease, session expiry)`. The lease is **NEW POLICY, flagged**: the routine-grant
contract forbids a default check-lease. Core requires an explicit `ROUTINES_POLICY_RECEIPT_LEASE_MS`, with no default, and
answers 503 when it is unset.

**Answers.** On success, the exact closed receipt. Refusal is 403 and unavailability is 503. Meri's receipt has no
`authorized: false` branch, so every non-200 fails closed there.

**Clock.** Use the same pattern dot set for R14: Meri's trusted adapter stamps its own local observation after a correlated
fresh Core response. `expiresAtMs` stays enforced separately.

## 3. Wire B — cancellation proof (issued attended, used by service)

**Purpose.** The schedule service stops the owner's own scheduled run with no service privilege, carrying a proof that
the owner approved exactly this cancellation.

**Issuance route:** `POST /api/clio/routines/cancellation-proof`, HTTP 200, with the same auth as Wire A. It is called
during the attended approval of the cancel.

**Body:** `{intent, intentSha256, decision, runs, targets}`.
- `intent` is the cancel intent, and `intentSha256` its RFC 8785 SHA-256.
- `decision` is Meri's `ApprovalDecision`.
- `runs` is `[{workflowId, runId}]`, the human-approved selection.
- `targets` is the exact RunBindings of `expectedLineage.currentBinding` and its `bindings`.

**Core's checks:**
- The session principal equals `intent.projection.owner` and `decision.approver`.
- The decision is `approved`, with `proposalId = intentId` and `commandSha256 = intentSha256`. It is unexpired, and its
  `policyRevision` equals the intent's single scope revision.
- The intent is `cancel_scheduled_task` with `running: 'request_cancel'`, and `intent.cancel.runs` equals `runs`.
- Membership is current, as in Wire A.

**Proof.** Core issues an EdDSA compact JWS, `typ capiro-meri-routine-cancel+jwt`, through the shared `CoreEd25519Signer`.
Its payload bytes are exactly the RFC 8785 form, as in R14:

```
{iss, aud: 'meri-schedule-run-control', iat, nbf, exp, jti,
 cancel: {tenantId, ownerActorId, scheduleId, intentId, intentSha256, decisionSha256, runs, targets}}
```

`exp` is the minimum of `decision.expiresAt` and `iat + ROUTINES_CANCEL_PROOF_TTL_SECONDS`. That TTL is **NEW POLICY,
flagged**, with no default.

**Consumer (Meri, R0/laneB).** The production `runControl.cancel({binding})` presents the proof from the approval journal
to Meri's own run-lifecycle cancel owner. That owner verifies:
- the pinned key, issuer and audience;
- that `binding` is one of `targets` and is owned by `ownerActorId` in `tenantId`;
- that the proof is unexpired.

It then requests the stop. The proof authorizes **stopping only those exact runs**; it grants no execution, read or write.

**Replay and revocation.** Stopping is monotone and idempotent, so a replay inside `exp` re-requests the same stop and
nothing else. No revocation list is needed. A proof never outlives the approving decision.

**No Core run state.** Core does not see or stop Meri runs. It attests only the owner's approval of an exact selection.

## 4. Flags and open items for R0/laneB

1. **New policy values, none chosen here:** `ROUTINES_POLICY_MAX_RUNTIME_SECONDS`, `ROUTINES_POLICY_RECEIPT_LEASE_MS` and
   `ROUTINES_CANCEL_PROOF_TTL_SECONDS`. Each is explicit, with no default; a missing value answers 503.
2. **Destination vocabulary.** This draft accepts only the reference `meri-inbox`. Confirm the reference strings the
   schedule tool actually emits.
3. **Meri lifecycle consumer.** Does Meri's run-lifecycle cancel owner accept a Core proof in place of a session? Its
   verifier and the journal custody of the proof are Meri work. If R0 prefers, Core could expose a verify-and-stop relay,
   but Core holds no Meri run state.
4. **Listener.** Both routes are POSTs on the preview host. They fit as one more value in the P3 native-operations
   condition, which holds up to 3 values: `^/api/clio/routines/(policy/check|cancellation-proof)$`. This is a source
   change for dot to review.
5. **Keys.** One more Ed25519 key for Wire B, created only in the deployment packet.
6. **Firing grant.** Unchanged and held. When Neo approves unattended execution policy, the routine-grant contract's Core
   rows (grant schema, proof custody, revocation, service audience) become Core work on top of these wires.
