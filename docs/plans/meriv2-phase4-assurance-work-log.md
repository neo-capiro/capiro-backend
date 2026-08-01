# MeriV2 Phase 4 — Assurance Work Log

**Branch:** `feat/meriv2-p4-government-affairs-assurance`  
**Base branch:** `feat/meriv2-p3-memory-context-v2`  
**Base SHA:** `3e06995b35c2cac5415e28e82f8f7ef525ebc7c7`  
**Draft PR:** #674  
**Production actions:** none

## Prerequisite disposition

The Phase 4 execution specification requires Phase 3 to be independently validated before release. The actual Phase 3 head used here contains important governance primitives but its independent closeout explicitly records that Context Packet v2 and governed memory are not yet reachable from every live surface, the Prisma schema is not aligned to its new migrations, and Strategy/Steward do not yet consume the shared context contract. Phase 4 therefore proceeds on the real Phase 3 branch for integration visibility, but remains release-blocked until those Phase 3 defects are closed and independently revalidated.

## Baseline architecture inventory

| Concern | Existing baseline | Phase 4 action |
|---|---|---|
| Grounding prompt | Strong federal/defense-oriented `MERI_GROUNDING_INVARIANT` and `DOMAIN_PRIMER` | Add a cross-jurisdiction operating-frame/evidence/claim protocol without weakening existing checks. |
| Chat verification | Citation validation and deterministic auditor run after prose; token deltas can already be streamed | Buffer high-risk turns, resolve claims and checks before release, retain low-risk streaming. |
| In-editor | Read-only tools and grounding kernel, federal persona | Add cross-jurisdiction assurance protocol and preserve review-before-apply. |
| Workspace generation | Citation validation, PE structural checks, advisory auditor | Add the shared assurance protocol and require a release decision for high-risk artifacts in the integration closeout. |
| Strategy/Steward | Separate `apps/api-strategy` service and verifier package | Inventory real prompt and generation paths, add shared protocol and provenance mapping; do not invent a parallel strategy engine. |
| Compliance | Phase 0 generic action gates and immutable proposals | Encode only that approved behavior as an active versioned pack. Legal-rule categories remain disabled examples until reviewed. |
| Evals | Deterministic MeriV2 safety gate plus strategy L1/L2 suites | Add versioned GA goldens, category-specific release gates, and feedback review/anonymization. |
| Observability | Auditor and usage ledgers | Add content-free assurance metrics and versioned eval provenance. |

## Government-affairs domain matrix

| Domain | Required primary/system-of-record evidence | Deterministic assurance |
|---|---|---|
| Federal/state/local legislation | Official text, actions, rules, votes, enacted proof | Stage ordering, failed-rule, recorded-vote, companion/target, enactment proof. |
| Defense/budget | Official exhibits, marks, conference/enacted rows, exact scope/FY/stage | Authorization/appropriation, dimensions, comparable deltas, PE/procurement identity, category, report attribution. |
| Current roles/entities | Canonical entity and dated roster | Ambiguity and current-as-of checks. |
| District impact | Deterministic facility/geospatial/roster join | No location/name inference. |
| Regulatory | Official docket/register state, deadline, timezone | Proposed/final/effective/open and window checks. |
| Grants/procurement | Official opportunity/award/solicitation records | Opportunity vs award, active/expired status, dates and eligibility. |
| Client strategy | Approved objective/ask plus current policy evidence | No manufactured objectives; structured recommendation contract. |
| Negative/exhaustive claims | Complete, non-truncated, successful source coverage | Empty/failed query is never proof of absence. |

## Policy-pack activation boundary

The only active seed pack mirrors the already-approved product policy: external sends, CRM mutations, and standing automation require explicit approval; unknown writes fail safe. Gifts, travel, pay-to-play, contingent fees, procurement integrity, ex-parte contacts, FARA/LDA, revolving-door, and state-registration categories are schema-only disabled examples with zero substantive rules. They cannot be published or selected.

## Rollout posture

1. Shared contracts and deterministic tests first.
2. High-risk chat buffering behind the same tool/citation ledger.
3. In-editor and Workspace prompt parity.
4. Strategy/Steward integration only after real paths are inspected.
5. Policy packs in simulation/shadow; no legal pack activation.
6. Category-specific eval report before any canary.
7. No merge, deployment, production flag, policy activation, backfill, or migration during this task.
