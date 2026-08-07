# Current Engagement UI Parity Contract v1

**Phase:** 3 — Full Existing Engagement Experience Parity
**Micro-session:** 3.1 — Inventory current UI surfaces and API consumers
**Artifact:** `apps/web/src/pages/engagement/__fixtures__/engagement-current-ui-surface-manifest.v1.json`
**Generator:** `scripts/engagement-phase3-ui-inventory.mjs`
**Suite:** `scripts/engagement-phase3-ui-inventory.spec.mjs` (32 assertions)

This document explains what the manifest means and why it is trustworthy. The
manifest itself is generated, never hand-edited — `--check` fails if the
committed copy differs from a fresh build, so it cannot drift from the source it
describes.

---

## 1. What the manifest defines

Phase 3 must prove that the exact current Engagement experience behaves
identically through the dark `engagement-api` preview route. This manifest is
the definition of "the exact current experience": every surface, every consumer
file, every request, and every route.

| Measure | Count |
|---|---|
| Surfaces | 13 |
| Consumer files | 23 |
| Distinct requests | 146 |
| — reads | 53 |
| — safe local writes | 46 |
| — external actions | 47 |
| Routes in the Phase 0 manifest | 110 |
| — consumed by the web UI | 84 |
| — `api_only` (no browser consumer) | 26 |

---

## 2. Surfaces

`owner: engagement` surfaces live under the Engagement tabs (plus
`/settings/integrations`, which the plan explicitly scopes into preview mode).
`owner: cross-surface` consumers read Engagement data while living elsewhere in
the product — they matter because a preview-mode regression there would be
invisible from the Engagement tabs, and because their *non*-Engagement requests
must keep going to the main API.

| Surface | Owner | Files | Reads | Safe writes | External |
|---|---|---:|---:|---:|---:|
| `engagement-shell` | engagement | 1 | 11 | 11 | 7 |
| `engagement-meetings-api` | engagement | 1 | 7 | 13 | 7 |
| `engagement-outreach-list` | engagement | 1 | 9 | 6 | 4 |
| `engagement-outreach-wizard` | engagement | 7 | 10 | 12 | 7 |
| `settings-integrations` | engagement | 1 | 3 | 1 | 7 |
| `app-shell` | cross-surface | 1 | 1 | 0 | 2 |
| `onboarding` | cross-surface | 1 | 1 | 0 | 2 |
| `home-dashboard` | cross-surface | 1 | 4 | 0 | 2 |
| `client-profile` | cross-surface | 5 | 4 | 2 | 6 |
| `admin-clients` | cross-surface | 1 | 0 | 0 | 2 |
| `workspace-context` | cross-surface | 1 | 2 | 0 | 1 |
| `program-element` | cross-surface | 1 | 1 | 0 | 0 |
| `funding-opportunities` | cross-surface | 1 | 0 | 1 | 0 |

Every surface declares the four states Phase 3 must render in both modes:
`loading`, `empty`, `error`, `permission_denied`. Sessions 3.6–3.11 consume this
list; a surface that dropped a state would silently shrink the workload, so the
verifier rejects it.

---

## 3. How classification is decided

Classification is **not** inferred from the URL. The server already carries the
answer: Phase 1 marks every externally-effecting handler with
`@EngagementRuntimeAction('<action>')`, and that decorator is exactly what
`engagement-api` consults to refuse the call in shadow mode.

```
external_action    ⟺  the handler carries @EngagementRuntimeAction
read               ⟺  otherwise, and the method is GET
safe_local_write   ⟺  otherwise
```

Deriving the manifest from the same metadata the runtime enforces means the two
cannot disagree. A URL-shape heuristic would have been guessing at exactly the
question that matters most.

### 3.1 The heuristic survives as a cross-check

Path heuristics remain in the generator, but only to answer a different
question: *does any route look external while carrying no decorator?* That would
be a containment hole — `engagement-api` would let the call through in shadow
mode. The verifier fails on it.

Closing that check honestly required fixing the heuristic itself. An
end-anchored `/send$/` matches `/send` and `/send-campaign` but **misses
`/outreach/send-batch`**, a real send route. The pattern is `/send(-|$)/` for
that reason; `scripts/engagement-phase3-ui-inventory.spec.mjs` pins it.

### 3.2 Exemptions carry evidence

Two routes look external to the heuristic and provably are not. Each exemption
costs a source citation, so the cheap way out is to fix the code rather than
widen a regex. Session 3.14 re-reads both.

| Route | Why it is not external | Evidence |
|---|---|---|
| `POST /api/engagement/outreach/:id/open-email` | Builds a `mailto:` URL locally and flips the record to `opened_in_email`. No provider API call. | `engagement.service.ts:2515` `openOutreachInConnectedEmail` |
| `POST /api/engagement/outreach/send-intents/:id/cancel` | One Prisma transaction: marks pending deliveries skipped and the intent canceled. Stops sends rather than causing one. | `outreach-send-intent.service.ts:537` `cancelIntent` |

---

## 4. Documented drift from the plan

**The plan lists "provider-backed open-in-email" under Outreach external
denial (3.7). The implementation is not provider-backed.**

`openOutreachInConnectedEmail` checks that a mailbox is connected, updates the
record status, and returns a locally-constructed `mailto:` URL. It never calls
Microsoft Graph or Gmail. Classifying it `external_action` to match the plan's
wording would assert a denial the server does not perform, and 3.7 would then
"prove" a containment property that isn't real.

It is therefore classified `safe_local_write`, and 3.7 must prove it as a shared
safe write (record transitions to `opened_in_email` once, visible through both
runtimes) rather than as a denial. Recorded per agent operating rule 13:
document drift rather than silently follow either side.

---

## 5. External actions reachable from the browser

21 distinct routes, each bound to a declared runtime action. Phase 3 must prove
every one is denied before any side effect, per the plan's five-point acceptance
(control present · request reaches `engagement-api` · server returns
`ENGAGEMENT_EXTERNAL_ACTION_DISABLED` · UI explains no external action occurred ·
no job, intent, provider call, OAuth mutation, sync, notetaker action, or
external attachment mutation).

| Runtime action | Routes |
|---|---|
| `outreach_send` | `POST /outreach/:id/send-campaign`, `POST /outreach/send-batch`, `POST /outreach/send-intents` |
| `outreach_generate` | `POST /outreach/:id/generate-draft`, `POST /outreach/generate-batch`, `POST /outreach/jobs/generate` |
| `meeting_prep_generate` | `POST /meetings/:id/prep` |
| `meeting_debrief_generate` | `POST /meetings/:id/debrief-draft` |
| `notetaker_dispatch` / `notetaker_remove` | `POST` / `DELETE /meetings/:id/notetaker` |
| `attachment_external_write` | `POST /attachments/upload-url`, `POST /attachments/confirm` |
| `attachment_external_read` | `POST /attachments/:id/extract-text` |
| `integration_oauth_start` | `POST /integrations/microsoft/start`, `POST /integrations/google/start` |
| `integration_sync` | `POST /integrations/microsoft/:id/sync`, `POST /integrations/google/:id/sync`, `POST /integrations/microsoft/:id/calendar-window` |
| `integration_subscription` | `POST /integrations/microsoft/:id/subscriptions` |
| `integration_disconnect` | `DELETE /integrations/microsoft/:id`, `DELETE /integrations/google/:id` |

`calendar-window` is declared `integration_sync`, which matches the plan's
Integrations deny list. It is worth naming because a URL-shape heuristic reads
it as an ordinary settings write.

---

## 6. Routes with no browser consumer

26 of 110 routes are `api_only`. They are recorded rather than omitted, so the
inventory states what it did *not* check instead of leaving a silent gap. Nine
of them carry a runtime action — external routes no browser session reaches:

| Route | Action | Why no consumer |
|---|---|---|
| `GET /integrations/microsoft/callback` | `integration_oauth_callback` | Top-level browser navigation, not an XHR |
| `GET /integrations/google/callback` | `integration_oauth_callback` | Top-level browser navigation, not an XHR |
| `GET`/`POST /integrations/microsoft/notifications` | `integration_notification` | Provider webhook |
| `POST /campaigns/:id/generate` | `outreach_generate` | Meri campaign surface, not Outreach v2 |
| `POST /campaigns/:id/send` | `outreach_send` | Meri campaign surface |
| `POST /campaigns/:id/send-test` | `outreach_test_send` | Meri campaign surface |
| `POST /outreach/jobs/send` | `outreach_send` | Worker-owned send path |
| `POST /outreach/insights/talking-points` | `outreach_generate` | Not wired to a current UI control |

These are direct input to **3.12's Phase 4 gap ledger**: OAuth callbacks and
webhooks stay on the main API through Phase 3, and worker-owned send paths are a
Phase 4 ownership question, not a Phase 3 parity one.

---

## 7. Fail-closed scanning

The scanner resolves string literals, template literals through module-level
constants, and URL-builder helpers such as
`intelTrackerPaths.feedback(clientId)`. Anything it cannot resolve becomes a
recorded finding, and **any finding fails the verifier** — an unresolvable
Engagement URL is never silently dropped from the parity workload.

Helper resolution exists so the scanner can tell a non-Engagement call apart
from an Engagement one it failed to parse. Without it, `NewOutreachWizard`'s
call to `/intel-api/clients/:id/tracker/feedback` was reported as an
unresolvable Engagement request. That call is a useful fact in its own right:
the Outreach wizard issues non-Engagement requests that must **not** receive the
preview header, which is a negative control for 3.9.

---

## 8. What each classification obliges Phase 3 to prove

| Classification | Obligation | Sessions |
|---|---|---|
| `read` | Identical data, counts, ordering, and empty/error states in both modes | 3.6–3.9 |
| `safe_local_write` | One shared row through both runtimes, no dual write, readable from the other mode | 3.6–3.8 |
| `external_action` | Denied before any side effect, with the five-point acceptance above | 3.6–3.8, 3.11 |

---

## 9. Regenerating

```bash
node scripts/engagement-phase3-ui-inventory.mjs --write apps/web/src/pages/engagement/__fixtures__/engagement-current-ui-surface-manifest.v1.json
node scripts/engagement-phase3-ui-inventory.mjs --check apps/web/src/pages/engagement/__fixtures__/engagement-current-ui-surface-manifest.v1.json
node scripts/engagement-phase3-ui-inventory.spec.mjs
```

Adding an Engagement consumer to the product changes the manifest; `--check`
then fails until it is regenerated and the new consumer's file is mapped to a
surface. That is the intended friction — a new Engagement caller cannot join the
product without joining the parity workload.
