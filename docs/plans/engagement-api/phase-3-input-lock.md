# Phase 3 — Input Lock

**Micro-session:** 3.0 — Lock prerequisites and source inputs
**Repository:** `neo-capiro/capirov2`
**Branch:** `agent/engagement-api-phase-3-full-ui-parity`
**Base SHA:** `3841a5ee58e011be7fb4fb6008adfccf081976d9`
**`origin/main` at lock time:** `f8505002234c716472d1cbbd547462150f4aa683`
**Date:** 2026-08-06

---

## Scope

Micro-session 3.0 proves Phase 2 is complete and freezes the exact inputs
Phase 3 will be executed against. It changes no application code, no
infrastructure code, and no product UI. This document is the only committed
artifact.

---

## 1. Prerequisite acceptance references

### Phase 0 — baseline and no-regression contract

| Field | Value |
|---|---|
| Accepted SHA | `68102d6453ec893100fbc314b2b40cca442ca168` |
| Branch | `agent/engagement-api-phase-0-baseline` |
| Verifier | `pnpm verify:engagement-phase-0` — **pass** (110 routes, 46 external importers, 23 side-effect registry entries, 5 process loops, 0 unregistered) |

### Phase 1 — local second runtime

| Field | Value |
|---|---|
| Accepted SHA | `b5de4d0954025483a46413d7a46eeaeb1d1d1345` |
| Head SHA | `47902517c7dd64a408a87cef57323812407c29c8` |
| Pull request | **#755** (open, draft) |
| Verifier | `pnpm verify:engagement-phase-1` — **pass** (`ENGAGEMENT_PHASE1_DB_FREE_COMPLETE`; 27 API suites; 180 web files / 1580 web tests) |

### Phase 2 — dark Fargate deployment

| Field | Value |
|---|---|
| Head SHA | `3841a5ee58e011be7fb4fb6008adfccf081976d9` |
| Branch | `agent/engagement-api-phase-2-dark-fargate` |
| Pull request | none yet — merge is Phase 10, per both plans |
| Code verifier | `pnpm verify:engagement-phase-2` — **pass** (34 passed, 0 failed, 1 skipped) |

**Recorded honestly: this is a stronger and also a less formal acceptance than
Phase 0→1 or Phase 1→2 had.** Phase 2's own plan's independent-validation
checkpoint (2.14, code-complete) passed before this session began. What
happened in *this* session was different from a documented micro-session
sequence — it was continuous, gated, live execution of Gates B, D-part-1, and
C against the real `capiro-dev` AWS account (967807252336), each authorized
explicitly and separately, with real failures found and fixed along the way
(not a clean first pass):

- **Gate B** — Registry + Network stacks deployed. Post-deploy checks all
  passed: ECR immutable/KMS-encrypted/scan-on-push, target group `ip`/`4500`/
  `/health`, empty, no listener rule created, generic `/api/*` rule
  unchanged.
- **Gate D-part-1** — preview rule created at priority 6
  (`.../listener-rule/app/capiro-prod-alb/7a4acb332b261724/e2d19b3dd47fc440/31705c7bdd372a94`).
  Verified exact shape. Ordinary traffic (`/api/health`, `/api/engagement/capabilities`
  without the header) unaffected throughout — confirmed before and after.
- **Gate C** — image built, pushed, and deployed at release SHA
  `17cdcb5cadaa91466b7708ad4399ffbea33a63fe`, digest
  `sha256:a2ab6d01bca2638fd99ef66f2735dc10badca253d1d28c7aca88f95f90f5b2d8`.
  Service running 1/1, target healthy. One safe preview read sent
  (`GET /api/engagement/capabilities` with the preview header): confirmed
  `X-Capiro-Service: engagement-api` and a `401` (auth still enforced, not
  bypassed). Task definition environment confirmed directly via
  `describe-task-definition`: `RELEASE_SHA` matches,
  `ENGAGEMENT_PROCESS_MODE=shadow`, `ENGAGEMENT_BACKGROUND_OWNER=disabled`,
  `ENGAGEMENT_EXTERNAL_ACTIONS=disabled`, `ENGAGEMENT_CALLBACKS_ENABLED=false`,
  `ENGAGEMENT_RECALL_WEBHOOK_ENABLED=false`, both UI-contract hashes present
  as nonsecret env vars.

**Five real defects were found and fixed during this live execution**, each
with a fix and a regression test, not just a live workaround:

1. `dbConnectionBudget.alarmThreshold` violated its own safe-ceiling formula.
2. `describe`/`verify-scan` in `engagement-api-image.sh` resolved the wrong
   digest (an OCI image index buildx creates by default, which ECR cannot
   scan) — fixed with `--provenance=false --sbom=false` on push.
3. 8 genuine base-image CVEs, all `perl-base` (Debian Essential, unremovable,
   already latest-patched, never invoked by this container) — reviewed and
   accepted by exact CVE ID, not a baseline bump. See commit `64f0d41a`.
4. The Service stack's log group tried to import the shared
   `alias/capiro-dev` CMK, whose policy is CloudTrail-only with no
   CloudWatch Logs grant — fixed with a stack-owned key scoped to exactly
   this log group. `kmsKeyArns.logs` is removed from the config contract.
5. `kmsKeyArns.data` pointed at the general-purpose key; the real Aurora and
   Clerk secrets are each encrypted with their own distinct dedicated keys.
   See commit `3841a5ee`.

**Update, 2026-08-07 — the gap below is now closed.** An independent agent (not
the one that implemented or deployed Phase 2) ran
`docs/runbooks/phase-2-independent-live-validation.md` against live
`capiro-dev` and returned `PHASE2_LIVE_INDEPENDENTLY_APPROVED` — every check in
its sections 1–7 passed as specified, re-verified against live AWS state, not
against this document's transcription of it. Full evidence and one
non-blocking runbook correction (a dead hostname in §3) are recorded in that
runbook's "Approval record" section.

**What had NOT happened before that**, matching Phase 2's own carry-forward
rules:

- No independent reviewer had validated the *live* deploy — 2.14's
  independent validation covered code-complete only, before any AWS
  credential existed. There was no Phase-2 equivalent of Phase 3's own 3.16
  ("independent live validation") until the update above.
- No merge. No canonical `/api/engagement/*` cutover. No Recall cutover. No
  database migration. No web/UI change. `engagement-api` remains in shadow
  mode, dark behind the preview header only.

---

## 2. Locked source inputs

Frozen by SHA-256 for the duration of Phase 3. These files live outside the
repository and are **not** committed.

| Input | SHA-256 | Bytes |
|---|---|---|
| `Outreach V3 (standalone).html` | `84b26c1d2ea0dd8d122ee0b4bdbe4087cdf37e1b328bf1ab6fd1146d0624f453` | 873843 |
| `engagement-api-outreach-v3-master-context.md` | `fc681d3e046276a6faf49f5fb3c1e95bc1b8c7ba1373876320075958d072e2a8` | 32281 |
| `phase-3-engagement-api-full-existing-ui-parity-micro-sessions.md` | `08ffa00a1c4fb1a127316e2f6da062b28366888b44b385042a7fd1c3977c4460` | 34766 |

Source directory at lock time: `C:/Users/neoma/Downloads/`.

The first two are **byte-identical** to the values Phase 2 locked
(`docs/plans/engagement-api/phase-2-input-lock.md` §2) — verified by direct
hash comparison, not by assumption. Neither the prototype nor the master
context drifted between Phase 2 and Phase 3.

---

## 3. Prerequisite verification results

Executed on `agent/engagement-api-phase-3-full-ui-parity` at
`3841a5ee58e011be7fb4fb6008adfccf081976d9` with a clean working tree.

| Command | Result |
|---|---|
| `pnpm verify:engagement-phase-0` | **pass** |
| `pnpm verify:engagement-phase-1` | **pass** — `ENGAGEMENT_PHASE1_DB_FREE_COMPLETE` |
| `pnpm verify:engagement-phase-2` | **pass** — 34 passed, 0 failed, 1 skipped (prototype-drift, expected without `OUTREACH_V3_PROTOTYPE_PATH`) |
| `pnpm turbo run typecheck` | **fail — pre-existing on `main`, identical to Phase 2 §6** |

### Known limitation carried forward — repository-wide typecheck fails on `main`

Identical root cause to Phase 2's own input lock §6: 17 of 18 turbo tasks
succeed; `@capiro/api#typecheck` fails on four pre-existing `TS6059` errors in
`apps/api/src/defense-budget/**` spec files that violate `rootDir` by
importing from `apps/api/scripts/`. Unrelated to Engagement, unrelated to this
session's changes, reproduces identically on a clean `origin/main` checkout.
Phase 3 must gate the production surface (as Phase 1 and Phase 2 both do),
never a bare `pnpm turbo run typecheck`.

---

## 4. Required confirmations

| Confirmation | Result | Proof |
|---|---|---|
| No pending migration | **pass** | Phase 2 created none; Phase 3 plan §31 forbids one |
| Ordinary Engagement traffic remains main | **pass** | `/api/health` and `/api/engagement/capabilities` without the preview header both return `401` (auth-enforced, server healthy) before and after every Gate B/C/D-part-1 mutation |
| Preview traffic reaches `engagement-api` | **pass** | one safe preview read returned `X-Capiro-Service: engagement-api` |
| Current web sends no preview header by default | **pass, unaffected** | Phase 1's static (`assertNoWebPreviewRouting`) and dynamic (1504 observed requests, 0 preview headers) proofs cover `apps/web/src`, which Phase 2 and this session did not touch |
| Shadow external actions and workers disabled | **pass** | live task definition: `ENGAGEMENT_BACKGROUND_OWNER=disabled`, `ENGAGEMENT_EXTERNAL_ACTIONS=disabled`, `ENGAGEMENT_CALLBACKS_ENABLED=false`, `ENGAGEMENT_RECALL_WEBHOOK_ENABLED=false` |

---

## 5. Carry-forward constraints

Restated from Phase 2 §8, still binding.

- Do not merge. Merge is Phase 10.
- Do not implement Outreach V3 production UI, LangGraph, Campaign Spec
  persistence, checkpoints, target recommendations, governed-context
  selection, representative samples, or V3 preflight (Phase 3 plan's own
  rule, restated).
- Do not create a database migration.
- Do not route ordinary users to `engagement-api`.
- Do not move Recall, OAuth callbacks, mailbox sync, workers, generation, or
  sends.
- Keep `engagement-api` in the exact fail-closed shadow posture.
- Do not modify or deploy the historical frozen Compute stack.
- Do not mutate AWS unless a specific Phase 3 session explicitly authorizes
  that exact action. Authorization is nontransitive.

---

## 6. Next micro-session

**3.1 — Inventory current UI surfaces and API consumers.**
