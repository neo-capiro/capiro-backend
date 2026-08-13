# Engagement Program — Canonical Remaining-Work Plan

**Status:** active remaining-work authority
**Date:** 2026-08-10
**Repository:** `neo-capiro/capirov2`
**Execution rule:** the current repository wins over stale file/function anchors in older plans. Re-audit before editing.
**Merge/deploy authority:** none unless explicitly granted in the current session.

## Objective

Finish the Engagement program without conflating three different milestones:

1. **request-serving extraction** — the whole Engagement Manager can serve safely from `engagement-api`;
2. **Outreach V3 product completion** — planning, samples, drafts, approval, preflight, send, outcomes, and follow-up are governed end-to-end;
3. **canonical ownership cutover** — customer traffic and background/external-action ownership move to the new service with tested rollback.

Phase 6 planning UI is not the end of the program.

---

# Workstream A — Exact-head Phase 4–6 closeout

## Goal

Prove the newest Outreach V3 planning stack after the accepted standalone-layout supersession.

## Required sequence

1. Resolve current PR #891 head and ancestry through #890/#883/#881/#862/#822.
2. Run:

```bash
pnpm install --frozen-lockfile
pnpm --filter @capiro/api exec prisma generate
node scripts/verify-outreach-v3-phase6-final.mjs --sha "$(git rev-parse HEAD)"
node scripts/verify-outreach-v3-phase4-6-final.mjs --sha "$(git rev-parse HEAD)"
git diff --check
git status --short
```

3. Run focused and full web tests/build if not already included by the scripts.
4. Repair every new P0/P1/blocking-P2.
5. Fresh-context review the exact final diff.

## Acceptance

- latest standalone layout tests pass;
- no permanent desktop conversation column returns;
- Classic remains default/fallback outside authorized V3 access;
- no generation/send browser authority appears;
- Phase 4 target and Phase 5 context security regressions remain green.

Do not merge solely because a source review is clean.

---

# Workstream B — Capiro-internal whole-Engagement HTTP canary

## Goal

Exercise the entire Engagement Manager request-serving path through the dedicated `engagement-api` for the Capiro internal tenant before customer cutover.

## Desired initial ownership matrix

| Capability | Capiro internal canary owner |
|---|---|
| Engagement HTTP reads/writes | `engagement-api` |
| Meetings HTTP | `engagement-api` |
| Reports HTTP | `engagement-api` |
| Integrations HTTP/settings reads | `engagement-api` where already supported |
| Engagement tasks/outcomes HTTP | `engagement-api` |
| Classic Outreach HTTP | `engagement-api` compatibility path where accepted |
| Outreach V3 state/reasoning/targets/context | `engagement-api` |
| background workers/timers | current canonical owner |
| OAuth callbacks | current canonical owner |
| Recall webhook/continuations | current canonical owner |
| scheduled sync/subscription ownership | current canonical owner |
| external mail/provider actions | current governed owner until later transfer |

One active owner per background/external subsystem.

## Tenant authorization

Add/reuse one **server-owned** internal entitlement/allowlist for V3. Example shape only:

```text
OUTREACH_V3_ENABLED=true
OUTREACH_V3_ALLOWED_TENANT_IDS=<actual internal tenant UUID>
```

Resolve the real UUID from authoritative tenant/admin data. Never guess it or identify access only by email/display name.

Every `/api/engagement/outreach-v3/**` route must independently enforce:

```text
authenticated effective tenant
→ global V3 enabled
→ tenant in allowed set
→ allowed
otherwise → nonleaking denial / 404
```

Browser entitlement is UX only. Spoofed preview query/header cannot grant authorization.

Existing V2 Outreach records/drafts always stay Classic until an explicit semantic migration exists.

## Browser acceptance

For Capiro internal, prove:

- Meetings;
- Reports;
- Integrations;
- tasks/outcomes;
- Classic Outreach existing drafts;
- new Outreach V3;
- desktop/tablet/mobile;
- keyboard/focus/live region/touch targets;
- model outage fallback;
- stale proposal conflict;
- target/client/context ethical-wall denials;
- Classic rollback.

For one external test tenant, prove V3 UI hidden and direct V3 API denied.

## Rollback

One kill switch/routing rollback must return Capiro internal to current/Classic behavior without deleting V3 state.

---

# Workstream C — Governed representative samples and generation

## Goal

Implement the standalone's representative-sample and full-generation journey using existing Engagement trust/correctness contracts, not a new raw prompt path.

## Required architecture

1. Build one recipient-correct Evidence Packet **before any model call**.
2. Filter scoped context before source resolution, planning, verification, manifesting, or drafting.
3. Shared context may reach all intended recipients; target-specific context reaches only that target.
4. Client-scoped context cannot cross clients; no-client campaigns cannot silently acquire a named client's private source.
5. Writing guidance is authenticated instruction material, never evidence for a factual claim.
6. Generate a structured Message Plan before prose when the current gateway contract requires it.
7. Deterministic verifier and claim/source ledger use the same effective packet as the writer.
8. Persist truthful source manifest/provenance.
9. Large campaigns use bounded async work; no long 40-recipient model fan-out stays on one HTTP request.
10. Async jobs never persist bearer tokens.

## Sample-first behavior

For larger campaigns:

- generate a representative sample set first;
- samples represent distinct audience/personalization patterns;
- editing a sample creates a new immutable version;
- approval of the approach is separate from generation;
- only after the approach gate does the system generate the remaining recipient versions;
- interrupted generation preserves completed versions and resumes only unfinished slots.

## No-autonomy rule

Reasoning may recommend sample strategy but may not generate/approve/send simply because the user typed a natural-language instruction. Deterministic endpoints own the action.

---

# Workstream D — Immutable V3 drafts and exact-version approval

## Goal

Make every generated/editable V3 message an immutable, auditable server-side artifact/version.

## Lifecycle requirements

Distinct states must include, at minimum, the current server contract equivalent of:

```text
ready for review
approved
held
dirty
stale
failed
audit unavailable
```

## Rules

- stable logical draft artifact per recipient/group generation slot;
- every generation/edit/improve/revert produces a new version;
- subject/body of an existing version never mutate in place;
- manual typing becomes dirty/non-sendable until a new server version is persisted and audited;
- approval/rejection references the exact immutable version ID;
- an upstream target/context/delivery change marks affected versions stale rather than silently rewriting them;
- stale edit base returns conflict and never overwrites a newer version;
- held content remains visible for remediation;
- audit failure under enforce mode fails closed;
- regeneration never overwrites user edits;
- provenance and claim-level remediation remain inspectable.

## Review UX

Exception-first:

- held;
- dirty;
- stale;
- failed/missing-recipient-address;
- ready/approved drafts stay out of the way until exceptions are resolved.

---

# Workstream E — Deterministic preflight, durable send intents, provider outcomes

## Goal

No real message leaves a mailbox unless the exact approved immutable versions pass deterministic preflight and a durable send intent exists before the provider call.

## Preflight checks

At minimum reconcile current backend contracts for:

- exact current approved version;
- audit/approval status;
- recipient address/envelope;
- duplicate/collision handling;
- selected sender ownership/connection;
- sponsor/send policy;
- attachments ready/scanned/provider-compatible;
- target snapshot/currentness where required;
- delivery pattern/group visibility acknowledgement;
- held/stale/dirty drafts excluded;
- test-vs-real send mode;
- required prompt/gateway policy if still active.

## Send-intent rules

- durable intent + per-delivery rows committed before provider call;
- request idempotency retained across client retries;
- provider call occurs outside DB transaction;
- group delivery remains one logical provider request when the delivery pattern requires it;
- rendered subject/body/attachments for the delivery are frozen before send;
- partial eligibility is explicit; held-out drafts never silently send.

## Provider outcomes

Keep these distinct:

```text
pending
sending
sent/accepted
failed
unknown
skipped/held
```

Unknown means provider acceptance is ambiguous. It is **not failed** and never automatically returns to pending/retry.

A process crash after claim or a timeout after request transmission must reconcile to unknown when outcome cannot be proven.

Manual resend after unknown requires provider-status/Sent Items verification and an explicit operator decision.

## Test send

Uses the same exact governed version and attachment path, but sends only to the authenticated user's test destination and never creates/reuses real-recipient delivery rows.

---

# Workstream F — Context correctness, large-batch, group policy, provenance

## Goal

Close the full cross-feature validation matrix before scaling Outreach V3 generation.

## Matrix

Test combinations of:

```text
versioned drafts
× generation gateway
× asynchronous generation
× recipient-scoped context
× list/group audiences
× selected Intel/LegiWatch/government evidence
× client / multi-client / coalition / no-client sponsors
× legacy compatibility paths that remain reachable
```

## Required properties

- no recipient-specific source affects another recipient's plan/verifier/draft;
- no client-specific source crosses clients;
- group message policy uses one compatible audience policy;
- group personalization uses only facts common/authorized for the group;
- large batches have deterministic slot identity and bounded work;
- async source snapshots are durable and authorized without storing bearer tokens;
- “available to model” is not displayed as “used in final draft”;
- Context Used reflects the exact effective packet/plan/draft version.

---

# Workstream G — Permanent evaluation and release gates

## Goal

Prevent green focused tests from being mistaken for whole-Engagement correctness.

## Required gates

- exact-head locked install/typecheck/build/test matrix;
- recipient/client/tenant/ethical-wall adversarial tests;
- group/multi-client/no-client matrix;
- 40-recipient async recovery tests;
- immutable version + stale/dirty/held lifecycle tests;
- send idempotency/unknown-outcome tests;
- authenticated browser desktop/tablet/mobile acceptance;
- accessibility checks;
- Classic compatibility regression;
- shadow/current service request parity;
- fresh independent review;
- SOC 2 evidence/control mapping for externally consequential actions.

A GitHub Actions `startup_failure` with zero jobs is environment-blocked, never passing evidence.

---

# Workstream H — One-by-one background/external ownership transfer

## Goal

After request-serving canary is proven, move each non-HTTP ownership plane to `engagement-api` or its intended runtime deliberately.

## Transfer candidates

1. Engagement worker timers/job sweepers.
2. OAuth callbacks.
3. Microsoft/Google subscription/notification callbacks where applicable.
4. Recall webhook and continuation/reconciliation paths.
5. scheduled sync ownership.
6. notetaker lifecycle owner if still split.
7. external mail/provider delivery worker.

## Transfer rule for each subsystem

1. identify current owner and new owner;
2. prove dark new owner cannot act;
3. deploy new owner disabled;
4. record baseline counts/events;
5. stop old ownership;
6. enable new ownership;
7. prove exactly one active owner;
8. validate backlog/idempotency/recovery;
9. retain one-step rollback;
10. independently review before moving the next subsystem.

Never run old and new external-action owners simultaneously just to “see which works.”

---

# Workstream I — Customer canary, canonical cutover, rollback, legacy retirement

## Goal

Move from internal proof to customer traffic without turning a merge into an uncontrolled release.

## Rollout sequence

1. exact accepted SHA;
2. Capiro-internal HTTP canary;
3. Capiro-internal V3 planning + generation/send canary;
4. repair and independent acceptance;
5. one explicitly authorized design-partner tenant;
6. small tenant cohort;
7. broader customer routing;
8. canonical service routing cutover;
9. transfer remaining background owners;
10. prove telemetry/no legacy first-party dependency;
11. retire legacy path last.

## Rollback triggers

Rollback immediately on:

- cross-tenant/client leakage;
- duplicate/ambiguous send mishandling;
- wrong-recipient context;
- unexpected worker/callback double ownership;
- material meeting/report/integration parity regression;
- state/version corruption;
- inability to return to Classic/current owner quickly.

Rollback preserves canonical records; do not delete V3 state or historical Outreach records.

---

# Definition of whole-program done

The Engagement program is complete only when all of the following are true for one accepted deployed revision or a deliberately versioned coordinated release set:

- whole Engagement request-serving path proven on the target service;
- Outreach V3 planning + governed generation/drafts/approval/preflight/send/outcomes complete;
- recipient/client/tenant correctness matrix green;
- immutable exact-version audit/send boundary enforced;
- at-most-once/unknown outcome behavior proven;
- Capiro internal and selected customer canaries accepted;
- every background/external subsystem has exactly one proven owner;
- customer canonical routing is cut over with rollback rehearsed;
- legacy ownership/routes are retired only after telemetry proves they are unnecessary;
- fresh independent code/security/database/product/release review is complete;
- no open P0/P1/blocking-P2 remains.
