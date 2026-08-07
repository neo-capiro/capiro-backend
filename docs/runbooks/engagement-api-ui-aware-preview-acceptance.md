# engagement-api UI-Aware Preview Acceptance

**Micro-session:** 2.12 · **Manifest generator:** `scripts/engagement-api-preview-ui-contract.mjs`
**Live runner:** `apps/api/scripts/engagement-phase2-preview-parity.ts`
**Fixture:** `apps/api/src/engagement/__fixtures__/outreach-v3-preview-probe-manifest.v1.json`

---

## What this is

Every one of the 62 states in the [2.2 capability matrix](../contracts/outreach-v3-ui-api-capability-matrix-v1.md)
resolves to exactly one of six preview-acceptance probe classes. This is the
contract micro-session 2.18 (live acceptance) and 2.19 (independent
validation) execute against — built and unit-tested now, without AWS
credentials, so nothing about *what* to check is invented at deploy time.

**Important boundary.** This harness proves the dark service supports safe
reads and denies external actions identically to main. It does not render or
ship the Outreach V3 prototype from production web, and it must never claim
full UI parity. Phase 3 owns rendering the exact current Engagement UI through
preview. Phase 5–9 own Outreach V3 implementation.

---

## The six probe classes

| Class | Meaning | Count |
|---|---|---|
| `safe_read_get_probe` | GET compared byte-for-status against main | 21 |
| `safe_local_write_probe` | safe local write (schema-ready; none exist yet) | 0 |
| `shadow_denial_probe` | must return `503 ENGAGEMENT_EXTERNAL_ACTION_DISABLED` | 5 |
| `not_called_assertion` | served by the current UI, not this preview route | 0 |
| `future_phase_assertion` | not implemented yet | 30 |
| `prototype_only_assertion` | visual/scenario contract with no backend capability | 6 |

Derivation is mechanical: `capabilityClass` from the 2.2 manifest maps
1:1 to a probe class (`safe_read` → `safe_read_get_probe`,
`external_action_blocked_in_shadow` → `shadow_denial_probe`, etc). The mapping
lives in `scripts/engagement-api-preview-ui-contract.mjs` and is verified
against the committed capability manifest, not re-derived from routes.

### The GET that generates

`representative-samples` includes
`GET /api/engagement/outreach/ai-templates/:id/preview` as a **route probe
inside a `shadow_denial_probe`**, expecting 503 — not inside a
`safe_read_get_probe`. This route carries the Phase 1 `outreach_generate`
runtime action despite being a GET; treating it as a safe read would risk
invoking generation against a live service. A test asserts this route
specifically.

---

## Required probe families

Per the full Phase 2 plan §17, wherever a current route exists:

**Safe reads:** meetings, reports, integrations capabilities/status, outreach
records/history, client contacts, saved audiences, context/source metadata,
draft/version status, preflight/status/history, delivery history.

**Denials:** every one of the 36 Phase 1 external actions — generation, sample
generation, remaining-draft generation, test send, real send, OAuth
start/callback, mailbox/calendar sync, subscription management, notetaker
dispatch/remove, external attachment action.

**Directory search** and **recent contacts** have **no current
`/api/engagement` route** and are documented gaps
(`future_phase_assertion`, Phase 7) — not invented routes.

---

## Running it

### Structural check (no network, runs anywhere)

```bash
node scripts/engagement-api-preview-ui-contract.mjs --write
node scripts/engagement-api-preview-ui-contract.spec.mjs

cd apps/api && pnpm exec tsx scripts/engagement-phase2-preview-parity.ts --self-check
```

The live runner's `--self-check` mode loads and validates the manifest and
prints coverage counts **without making a network call**. This is the only
mode available in an environment with no deployed preview — which is every
environment until micro-session 2.17.

### Live run (2.18, requires a deployed dark service)

```bash
export APP_ORIGIN=https://app.capiro.ai
export TEST_BEARER_TOKEN=<dedicated internal test user/tenant token>
export TEST_TENANT_ID=<test tenant>
cd apps/api && pnpm exec tsx scripts/engagement-phase2-preview-parity.ts
```

For each `safe_read_get_probe` route: GET main (no header), GET preview (with
`X-Capiro-Engagement-Preview: v3` and the bearer token), assert identical
status and the `X-Capiro-Service: engagement-api` header on preview. Where
`authParityRequired` is set, also compares the missing-bearer denial between
main and preview.

For each `shadow_denial_probe` route: call through preview only, assert `503`,
a body containing `ENGAGEMENT_EXTERNAL_ACTION_DISABLED`, and the service
header.

**Never logs a bearer token or any response body from a route with a
non-empty `sensitiveScopes`** — `redact()` replaces such bodies before they
could reach a log line or evidence file.

Evidence: `.artifacts/engagement-phase2/preview-parity/preview-parity-results.json`.

---

## Why the live runner lives where it does

`apps/api/scripts/` is excluded from every tsconfig — transpiled by `tsx`,
never typechecked as part of the build (Phase 1 handoff limitation #4). The
runner's own logic is thin: a loop dispatching to two request-shaped
functions. There is nothing here that the manifest generator's own spec
doesn't already cover, so a standalone `tsc --noEmit` pass against the file
is sufficient assurance without pulling it into the excluded rootDir.

---

## The prototype-aware report

The generated manifest carries a `report` object answering exactly the
questions the plan requires:

- `safeBackendSupportedStates` — which of the 62 states have current safe
  backend support right now (21).
- `prototypeOnlyStates` — visual/scenario contracts with no backend capability
  (6).
- `futurePhaseWork` — keyed by phase (`phase_5`, `phase_7`, `phase_8`,
  `phase_9`), which states each owns.
- `blockedActionStates` — intentionally denied in Phase 2 (5).
- `fixtureRequirementsByState` — carried through unchanged from the 2.2
  matrix; the fixture backlog Phase 3 must build.
- `cannotYetRenderStates` — every state with no current route, whatever the
  reason (36).

A test asserts no state appears in both `safeBackendSupportedStates` and
`cannotYetRenderStates`.

---

## Required tests and negative controls

21 assertions in `scripts/engagement-api-preview-ui-contract.spec.mjs`,
including the three required negative controls, all against the committed
manifest proven equal to what the generator produces:

| Required by the plan | Result |
|---|---|
| Every capability entry receives a probe classification | ✅ |
| No generation/send action is a safe probe | ✅ |
| No unavailable route is silently skipped | ✅ |
| Sensitive values are redacted | ✅ — no email or bearer-token-shaped string anywhere |
| Prototype and capability manifest checksums appear in results | ✅ |
| Main and preview auth/tenant denials match | ✅ — encoded as `authParityRequired` on every safe-read route |
| Current web has no preview header | ✅ |

| Negative control | Result |
|---|---|
| Classify send as safe | rejected — "is an external action but is classified…" |
| Skip a prototype state | rejected — "has no probe — a state was skipped" |
| Permit a target-specific probe without target scope | rejected — "dropped sensitive scope \"target\"" |

---

## Downstream

**2.18** runs this against the deployed dev environment and produces the
22-state and edge-state coverage report the plan requires. **2.19** re-runs it
independently. Neither may claim a state implemented that this manifest marks
`future_phase_assertion` or `prototype_only_assertion`.
