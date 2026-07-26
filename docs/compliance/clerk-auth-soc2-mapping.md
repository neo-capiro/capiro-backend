# Clerk Authentication — SOC 2 Control Mapping

Maps the 2026-07-25 Clerk auth hardening to Trust Services Criteria, and names
the **concrete evidence artifact** for each — the thing an auditor can actually
be shown. Written against what this repo emits, not generic control language.

Implementation: branch `feat/clerk-auth-hardening`.
Test baseline + open items: `docs/plans/clerk-auth-hardening-baseline.md`.

---

## Evidence infrastructure this relies on

| Facility | Where | Note |
|---|---|---|
| `audit_logs` | `apps/api/prisma/schema.prisma` | **Append-only, enforced by trigger** (`20260718000000_audit_append_only`): UPDATE/DELETE raise SQLSTATE 0A000 except a GDPR purge and the actor-FK SET NULL. Non-repudiable by construction. `tenant_id` is **NOT NULL** — pre-tenant-resolution events cannot go here. |
| `auth.denied` events | `packages/shared` `authDeniedEvent()`, mirrored in `packages/auth` + `apps/intel-api` guards | Single-line JSON on stdout. Reason vocabulary pinned by a CI-gated test. |
| `Capiro/Security` metrics | `infra/cdk/lib/compute-stack.ts` | `auth.denied_count`, `identity.deprovision_failed`. **Committed, not yet applied** — see open items. |
| `identity_outbox` | `apps/api` | De-provisioning attempts + failures, with retry state. |
| `user_identity_conflict` | `apps/api` | Every identity rebind/merge, with the previous identity and membership count. |

Before this work the **only** metric filter in the stack was bound to the
sync-jobs log group, so nothing the request path logged could become a
CloudWatch metric. Auth denials were invisible to monitoring.

---

## Mapping

### CC6.1 — Logical access controls
**Controls.** Canonical org→tenant resolution with claim cross-checks; issuer
pinning; exact-match role allowlist; fail-closed `RolesGuard`.

**Evidence.**
- `packages/auth/src/tenant.guard.spec.ts` (20 cases): claim mismatch → 403,
  unresolvable org → 403, canonical UUID (never the raw `org_...` claim) in the
  request context.
- `apps/api/src/config/config-issuer.spec.ts` (7 cases): the service **refuses
  to start** without `CLERK_JWT_ISSUER` outside tests.
- `auth.denied` rows with reason `tenant_claim_mismatch` / `org_claim_mismatch`
  / `slug_claim_mismatch` / `host_mismatch`.
- `audit_logs` row `auth.denied.<reason>` per denied cross-tenant claim, with
  `entity_id` = the **claimed** tenant (the fact under review).

### CC6.2 — Registration and authorization of new users
**Controls.** Active local membership required before access; identity rebinding
recorded; onboarding identity gating fails closed.

**Evidence.**
- Per-service tests proving a revoked membership = 403:
  `packages/auth/src/tenant.guard.spec.ts`, `apps/workspace/test/tenant-guard.spec.ts`.
  These four services had **no** membership check before this change, so the
  test is the control's existence proof.
- `user_identity_conflict` rows: every email-keyed rebind and merge, reviewable.
- `apps/onboard-web/src/lib/funnel.draft.test.ts` (23 cases): a registration
  draft cannot be adopted by a different signed-in user.
- `OnboardConsent` (pre-existing) already binds each e-signature to
  `clerk_user_id` + ip + user_agent + `doc_sha256`.

### CC6.3 — Modification and removal of access
**Controls.** De-provisioning is durable and retryable; role elevation is exact-match.

**Evidence.**
- `identity_outbox`: one row per Clerk de-provisioning attempt. `consumed_at`
  proves it landed; `attempts` + `last_error` prove it was retried.
  **This is the deprovisioning-completeness artifact** — previously a failed
  Clerk delete returned HTTP 200 with no record at all.
- `identity.deprovision_failed` metric + alarm.
- `apps/api/src/auth/clerk-role.util.spec.ts`: `org:admin_readonly`,
  `org:not-admin`, `org:billing-admin` do **not** elevate.
- `apps/api/src/auth/roles.guard.spec.ts`: an unmapped role is rejected, not
  admitted (it previously passed every gated route).
- `audit_logs` `tenant.user.remove`, routed to the affected tenant so its own
  admins can see it. Now survives a slow Clerk call, which previously rolled it
  back.

### CC6.6 — Boundary protection
**Controls.** WebSocket origin allowlist; `authorizedParties` (pending).

**Evidence.**
- `apps/intel-api/src/hearing/hearing-ws-ticket.service.spec.ts`: origin
  allowlist accepts only the four production origins, and explicitly rejects
  `http://localhost:5173` — which is still present in that service's *HTTP*
  CORS allowlist (open item 2).
- Enforced at the handshake via `verifyClient`, so a disallowed origin gets
  HTTP 401 **before** the 101 upgrade.
- ⚠️ `authorizedParties` is **NOT yet in place** — see CC-gap below.

### CC6.7 — Transmission of confidential information
**Controls.** No credential in the WebSocket URL; no long-lived token retained.

**Evidence.**
- Diff: `LiveHearingRoomPage.tsx` no longer interpolates a bearer token into the
  ws URL; `LiveConn.authToken` is gone from the gateway.
- Ticket table stores **only** SHA-256; a test asserts the raw value is never
  persisted and never appears in the lookup.
- Tests prove second redemption and expiry are rejected. A redeemed row is the
  per-connection access record, which the previous design could not produce.

### CC7.2 — Monitoring for anomalies
**Controls.** Security events reach CloudWatch as metrics.

**Evidence.**
- `auth.denied` emitted from every denial site across `apps/api`,
  `packages/auth`, `apps/intel-api` (HTTP **and** WebSocket) and
  `apps/meriv2-orchestrator`.
- Reason vocabulary pinned by `apps/meriv2-orchestrator/test/security-events.spec.ts`,
  which runs in CI — renaming a reason breaks the build rather than silently
  breaking historical queries.
- ⚠️ Metric filters are committed to CDK but **not applied** (open item 5).
  Until applied, the events exist in logs but not as metrics or alarms.

### CC8.1 — Change management
**Evidence.** Nine reviewed commits, each naming its finding, its verification,
and its measured regression against a recorded baseline. Auth files carry
explicit change-control banners requiring named approval; the "Option F"
question was raised and approved before the membership check was written.

---

## Known gaps (do not present these as covered)

1. **`authorizedParties` is not set.** Requires measuring the observed `azp`
   values first — Clerk skips the check entirely when the claim is absent, so a
   blind allowlist can protect nothing while appearing to. If measurement shows
   `azp` is always absent, this control should be **withdrawn**, not claimed.
2. **Metric filters and alarms are not applied to the live stack.** The events
   are emitted; nothing is watching them yet.
3. **Identity rebinding is recorded, not blocked.** `user_identity_conflict`
   gives an auditor the list; there is no enforced review state yet.
4. **No periodic re-authorization of long-lived WebSocket sessions.** Membership
   is checked at connect time only; a session opened before a revocation stays
   open.
5. **Three migrations are authored but not applied**, so `identity_outbox`,
   `intel_ws_ticket` and `user_identity_conflict` do not exist in any live
   database yet. The controls that depend on them are code-complete, not
   operative.
