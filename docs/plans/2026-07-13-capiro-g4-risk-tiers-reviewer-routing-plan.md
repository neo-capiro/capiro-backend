# G4 — Risk-tier taxonomy + named-reviewer routing

**Goal (blueprint §3.3 approval gates by risk):** a shared 4-tier risk
vocabulary and a real review/release path for held deliverables — the G4
audit found held items today have NO release mechanism anywhere (alert-memo
`held` just skips auto-file, research `heldForReview` is written and read
nowhere, outreach `held` is a client-side bucket indistinguishable from a
generation failure).

## Audit-established facts (2026-07-12)
- Two disconnected approval systems: `meri_action_approval` (fingerprint,
  self-approve, dormant write tools) and `memory_candidate` (admin queue —
  THE lifecycle precedent: propose → pending → approve/reject with
  decidedBy/decidedAt).
- Compliance tiering today = PASS/WARN/BLOCK by tool name
  (PROPOSED_CAPIRO_RULES in meriv2-core); no named risk tier.
- Roles: tenant_memberships.role, rank-based RolesGuard; user_admin = the
  existing reviewer tier (memory-candidate routes precedent).
- alert-memo `saveEdited` re-files a held memo with NO held check;
  workspace export is TenantGuard-only — but Ninja's D1 says Workspace stays
  GATE-LESS, so workspace export is deliberately OUT of scope.
- `RiskTier` belongs in @capiro/shared (the Alert-type precedent: lowest
  common dep; meriv2-core re-exports).

## Design

### 1. Shared taxonomy (@capiro/shared, inlined per the single-file doctrine)
- `RISK_TIERS = ['low','moderate','high','restricted']` + `RiskTier`.
- `RISK_TIER_DEFAULT_OUTCOME: low→PASS, moderate→WARN, high→WARN,
  restricted→BLOCK` (maps onto the existing ComplianceOutcome).
- `DELIVERABLE_RISK_TIERS` (blueprint §3.3 table): research_report/internal
  summaries → low; meeting_prep/status → moderate; alert_memo,
  district_brief, white papers/testimony/legislative language → high;
  external sends/filings → restricted.
- meriv2-core: optional `tier?: RiskTier` on ComplianceRule +
  ComplianceDecision; PROPOSED_CAPIRO_RULES annotated (external_send →
  restricted, crm_mutation/standing_automation → high, internal artifacts →
  low). Re-export from shared.

### 2. `review_request` table (the memory_candidate lifecycle, generalized)
id, tenant_id, risk_tier, surface ('alert-memo'|'district-brief'|'research'),
subject_type + subject_id (loose polymorphic), client_id?, title,
reason (auditor finding summary), payload_jsonb (everything approve needs to
RELEASE: memo markdown/title/clientId; artifact id), status
(pending|approved|rejected), requested_by, assigned_to (the NAMED reviewer,
users.id, nullable until assigned), decided_by, decided_at, created_at.
RLS per meri_audit_ledger template. Indexes (tenant,status,created) +
(tenant,assigned_to,status).

### 3. Emitters (the enforce-hold sites become review requests)
- alert-memo `held` → create review_request (tier high, payload carries the
  rendered markdown + title + clientId + alert ref) — fail-open.
- district-brief `held` → same (its twin).
- research `heldForReview` → review_request (tier low→ but held means a
  critical finding: tier moderate; payload = artifact id).
- outreach: NOT emitted in v1 — held outreach lives only in the wizard's
  client-side generation results; there is no durable server row to release.
  Documented gap, revisit when outreach drafts persist per-recipient.

### 4. Routes (mirror memory-candidate's guard pattern)
- GET  /api/reviews?status= — user_admin sees all; others see their own
  requests + assignments.
- POST /api/reviews/:id/assign {userId} — user_admin only (naming the
  reviewer).
- POST /api/reviews/:id/approve — user_admin OR the assigned reviewer.
  RELEASES the deliverable: alert-memo/district-brief → render docx from
  payload.markdown + file to client Documents (the skipped auto-file);
  research → clear heldForReview on the artifact metadata.
- POST /api/reviews/:id/reject — same authz; deliverable stays unfiled;
  decided stamps recorded.

### 5. Close the ungated edit-then-save hole (alert-memo only)
`saveEdited` checks for an OPEN review_request on the same subject: if one
exists, only user_admin or the assigned reviewer may file (403 otherwise) —
a held memo can no longer be re-filed around the review by its requester.
(Workspace export intentionally untouched per D1.)

## Sequence
Migration + shared tier + core tier field → review service/controller +
emitters + release paths + saveEdited check → specs → land → deploy
(migrate + api roll; orchestrator/workspace unaffected) → live smoke:
held memo produces a pending review row; approve files the docx.
