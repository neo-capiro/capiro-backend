# Portfolio 3.1 prospect stages — isolated contract candidate

Base: `fd8765ec01d292013758606204f2c9d886cd31c1`. Human decision: adopt Figma stages; existing-record mapping will follow. Backend owner and migration allocation remain unassigned; no integration, migration application or deployment is authorized.

## Implementation outline

- Business Development owns the stage catalog and transport validation. A focused `prospect-stages.ts` catalog is reused by DTOs and the guarded discovery route.
- Additive PostgreSQL CHECK support accepts Figma values alongside all legacy values. The proposed migration identity `20281011020000` follows the separate Objectives candidate; allocation must be confirmed before integration. No rows, defaults, RLS policies, auth settings or financial behavior change.
- New Portfolio creates explicitly submit `identified`; omitted stages from existing callers still default to `researching`.
- Legacy-only stages cannot move into the new vocabulary until mapping is approved. Basic edits, existing legacy transitions, notes and ownership remain available. `proposal` is already the identical wire value in both vocabularies.
- `closed_won` and `closed_lost` record stage outcomes only. Conversion remains the existing explicit transaction; no provider/billing action occurs.
- Frontend capability discovery gates new creates and stage writes. An old/disabled backend returns 404 and the frontend keeps those writes unavailable.

## Contract

`GET /api/business-development/prospect-stages` uses the controller's existing RolesGuard and BusinessDevelopmentFlagGuard, returning:

```json
{"version":"portfolio-3.1","createStage":"identified","legacyMapping":"pending","allowLegacyTransitions":false,"stages":[{"value":"identified","label":"Identified"},{"value":"initiated","label":"Initiated"},{"value":"engaged","label":"Engaged"},{"value":"proposal","label":"Proposal"},{"value":"negotiation","label":"Negotiation"},{"value":"closed_won","label":"Closed won"},{"value":"closed_lost","label":"Closed lost"}]}
```

Existing GET list/detail/history and POST/PATCH paths remain canonical. Invalid stage values stay validation failures. Transitioning a legacy-only stage to a new value returns 409 without writing the record/activity/audit. Tenant predicates and active-member ownership checks remain unchanged.

## Verification and coordination

Required: DTO vocabulary and unknown-value rejection; service creation/defaults, explicit closed outcomes without conversion, legacy transition rejection, tenant isolation; existing dossier/brief/watch regressions; disposable SQL CHECK migration and unchanged legacy rows; API type/build checks. No production/test-account checks are claimed. Cleanup reported no Business Development overlap and requires fresh combined exact-source gates before any integration. A named owner and migration allocation are still required.

Local checks: **PASS** 230 tests in 8 Jest suites (catalog/DTO/service/roles/flag/dossier/brief/watch); primary API TypeScript with 8 GiB heap; Nest build; diff whitespace check. Disposable PGlite constraint rehearsal: 8 legacy rows unchanged, 7 Figma values accepted, unknown value rejected, omitted stage still `researching`. This rehearses the changed constraint, not the complete production schema/RLS. Backend ESLint is unavailable in the frozen API workspace; frontend formatter checked the focused TypeScript. No live integration, provider call, shared migration or deployment was run.
