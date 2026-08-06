# Outreach V3 UI-to-API Capability Matrix — v1

**Micro-session:** 2.2 — Build the UI-to-API capability matrix
**Schema version:** 1
**Prototype SHA-256:** `84b26c1d2ea0dd8d122ee0b4bdbe4087cdf37e1b328bf1ab6fd1146d0624f453`
**Manifest:** `apps/api/src/engagement/__fixtures__/outreach-v3-ui-api-capability-manifest.v1.json`
**Matrix:** `apps/api/src/engagement/outreach-v3-ui-api-capability.ts`
**CLI:** `apps/api/scripts/verify-outreach-v3-ui-api-capabilities.ts`
**Spec:** `apps/api/src/engagement/outreach-v3-ui-api-capability.spec.ts`

---

## What this is

Every one of the **62** states in the [prototype contract](outreach-v3-prototype-contract-v1.md)
gets exactly one entry saying what Phase 2 does about it and which phase owns it
later. Nothing here implements Outreach V3.

The matrix is proved against two accepted upstream contracts rather than
asserted:

- **Phase 0 route manifest** — a referenced route must really exist. 24 distinct
  routes are referenced; all 24 resolve.
- **Phase 1 runtime route policy** — a shadow-denied route must really carry
  runtime-action metadata. 36 routes carry it; every denial names one of them.

---

## Distribution

| Capability class | States |
|---|---|
| `safe_read` | 21 |
| `future_phase_not_implemented` | 30 |
| `external_action_blocked_in_shadow` | 5 |
| `prototype_only` | 6 |
| `safe_local_write` | 0 |
| `current_ui_only` | 0 |

| Shadow expectation | States |
|---|---|
| `same_as_main` | 21 |
| `not_implemented` | 30 |
| `503_external_action_disabled` | 5 |
| `not_called` | 6 |

| Future owner | States |
|---|---|
| `phase_5` (V3 state and LangGraph) | 14 |
| `phase_6` (conversational shell) | 5 |
| `phase_7` (targets and profiles) | 19 |
| `phase_8` (delivery, context, strategy) | 6 |
| `phase_9` (generation, review, test send) | 15 |
| `phase_11` (canary and cutover) | 3 |

36 of 62 states carry a documented `gap`. **No route was invented to close one.**

`safe_local_write` and `current_ui_only` are deliberately unused: Phase 2 creates
no V3 state, and no prototype state is served by the current Outreach v2 UI.

---

## What is safe to read through the dark preview

21 states map to existing safe reads and must behave identically on
`engagement-api` and the main API:

- **Outreach records** — `outreach-landing`, `post-send-partial-failure`,
  `post-send-learning-proposals`
- **Targets** — `client-contacts-several-clients`, `saved-audiences`,
  `no-saved-audiences`
- **Context** — `context-recommendations`, `excluded-context-wrong-client`,
  `target-specific-context`, `critical-context-failure`
- **Drafts** — `draft-summary-12-drafts`, `exception-review`,
  `held-draft-claim-level-remediation`,
  `dirty-draft-approval-cleared-by-an-edit`, `stale-drafts-upstream-change`,
  `audit-trail-unavailable`, `draft-sources-view-line-provenance`,
  `generation-interrupted-at-7-of-12`, `one-draft-failed-to-generate`,
  `generation-taking-longer-than-expected`
- **Health** — `meri-unavailable-options-still-work`

---

## What is blocked in shadow

5 states resolve to external actions that must return
`503 ENGAGEMENT_EXTERNAL_ACTION_DISABLED` with
`X-Capiro-Service: engagement-api`, creating no job, no send intent and no
provider call:

| State | Routes |
|---|---|
| `representative-samples` | 8 generation routes |
| `generating-samples` | 8 generation routes |
| `generating-remaining-drafts` | 8 generation routes |
| `preflight-partial-send-ready` | 6 send routes |
| `sending-the-campaign` | 6 send routes |

### The GET that generates

`GET /api/engagement/outreach/ai-templates/:id/preview` carries the
`outreach_generate` runtime action. **It is a read-shaped route that is an
external action.** Any acceptance harness that treats "GET" as a synonym for
"safe" would probe it as a safe read and either get a false failure or, worse,
invoke generation on a live service.

It is classified with the generation routes here, and the verifier rejects any
attempt to classify a route carrying runtime-action metadata as `safe_read`.
Micro-session 2.12 must carry this forward.

---

## Documented gaps

Missing capability is recorded as a later-phase gap, never invented.

**Directory** — the Capiro Directory is not part of the Engagement route
manifest. `directory-search`, `expanded-office-with-staff`, `target-profile`,
`stale-target-role`, `no-prior-relationship`, `loading-a-target-profile`,
`directory-search-failed`, `target-profile-failed-to-load`,
`recommended-targets` and `no-recommendations-found` have **no current
`/api/engagement` route**. Phase 7 owns the V3 composition.

> **Phase 3 must not claim Directory parity through the preview route.** Phase 3
> proves the *current* Engagement experience; the Directory reaches the browser
> through a different module that Phase 2 does not route.

**Campaign Spec state** — no session, event, checkpoint or canonical state
storage exists. Phase 2 creates none. Phase 5 owns it. This covers the goal,
read-back, sponsor, criteria, express-path, typed-instruction, resume and
autosave states.

**Coverage and health** — target health indicators and audience-coverage
analysis have no current route. Phase 7 owns them.

**Preflight** — the thirteen deterministic checks are prototype-side. No current
route computes them. Phase 9 owns preflight. Note that
`preflight-partial-send-ready` is nonetheless shadow-blocked, because the
prototype's send affordance resolves to real send routes.

---

## Entry shape

```ts
interface UiCapabilityEntry {
  stateId: string;          // join key, unique across all 62 states
  stateLabel: string;       // verbatim prototype label
  visibleStage: string;     // one of the six stages, or 'any'
  menuGroup: string;        // source group from the prototype contract
  requiredData: string[];
  currentRouteRefs: string[];   // must exist in the Phase 0 manifest
  routeManifestKeys: string[];  // sorted copy, for stable joins
  capabilityClass: CapabilityClass;
  shadowExpectation: ShadowExpectation;
  futureOwner: FuturePhase;
  futureOwnerNote?: string;
  sensitiveScopes: SensitiveScope[];
  fixtureRequirements: string[];
  observabilityFamily: string;  // from the Phase 2 observability contract
  gap?: string;                 // required when there is no current route
}
```

`visibleStage` accepts `any` for six states that span every stage — the bottom
chat bar, mobile layout, implementation notes, autosave failure, model
unavailability, and the two scenarios.

`futureOwner` is a single phase. Where the roadmap says "Phase 5–6" or
"Phase 9/11", the earlier phase owns the enabling work and `futureOwnerNote`
records the split. `post-send-learning-proposals` is assigned `phase_11` with a
note that governed memory writes actually belong to the separate
institutional-memory remediation, outside the numbered phases.

---

## Enforced invariants

The verifier fails closed on all of these:

1. Exactly one entry per prototype state, and no entry without a state.
2. The manifest's prototype SHA-256 matches the prototype contract.
3. Every referenced route exists in the Phase 0 route manifest.
4. Every shadow-blocked entry names at least one route, and every route it names
   carries Phase 1 runtime-action metadata.
5. No `safe_read` or `safe_local_write` entry references a route carrying
   runtime-action metadata.
6. Every target-specific state declares `target` scope.
7. Every client, context, sponsor or coalition state declares both `client` and
   `ethical_wall` scope.
8. Every state has exactly one future owner, a known visible stage, and a route
   family from the observability contract.
9. Any entry with no route carries a documented gap.

Invariants 6 and 7 use a deliberately over-broad match on the state id. Where it
fires on a state that only arguably touches the dimension, the matrix
**over-declares the scope** rather than narrowing the check — over-declaring can
only cause more authorization checking downstream, never less. There are no
per-entry exemptions.

---

## Negative controls

| Control | Result |
|---|---|
| NC-2.2-A — classify Send as `safe_local_write` | rejected: names a Phase 1 external action |
| NC-2.2-B — remove target scope from Target profile | rejected |
| NC-2.2-C — reference a nonexistent route | rejected |
| NC-2.2-D — shadow-block a route with no runtime-action metadata | rejected |
| NC-2.2-E — drop a prototype state | rejected |
| NC-2.2-F — drift the prototype checksum | rejected |

A–C are the three the plan requires; D–F close gaps the plan's list left open.

---

## Running it

```bash
# verify (fails if the committed manifest is stale or violates an invariant)
pnpm --filter @capiro/api exec tsx scripts/verify-outreach-v3-ui-api-capabilities.ts

# regenerate after a matrix change
pnpm --filter @capiro/api exec tsx scripts/verify-outreach-v3-ui-api-capabilities.ts --write

# invariants and negative controls
pnpm --filter @capiro/api exec jest src/engagement/outreach-v3-ui-api-capability.spec.ts
```

### Why the matrix lives under `src/`

`apps/api/scripts/` sits outside every tsconfig `rootDir`. A spec importing the
CLI directly would raise `TS6059` — the exact pre-existing breakage recorded in
[the Phase 2 input lock §6](../plans/engagement-api/phase-2-input-lock.md). The
matrix and its pure `build`/`verify` functions therefore live in
`src/engagement/`, and the CLI is a thin file-I/O wrapper. Confirmed: the full
`tsc --noEmit` still reports exactly the 4 pre-existing defense-budget errors and
none from this work.

---

## Downstream consumers

**Micro-session 2.8** — `observabilityFamily` on every entry is drawn from the
allowed route families. The distribution is: targets 16, drafts 14,
outreach_records 12, profiles 5, context 4, delivery_history 4, health 4,
preflight 3.

**Micro-session 2.12** — every entry must resolve to exactly one probe:
`same_as_main` → safe preview GET probe; `503_external_action_disabled` →
shadow-denial probe; `not_called` → not-called assertion; `not_implemented` →
future-phase assertion. The GET-that-generates above must not be probed as a
safe read.

**Micro-session 2.18** — `fixtureRequirements` across the 62 entries is the
fixture backlog Phase 3 must build. No fixture may reuse prototype scenario
data, which is fictional mockup content.

**Phase 3** — owns rendering the exact current Engagement UI through preview. It
must not claim any state marked `future_phase_not_implemented` or
`prototype_only`.
