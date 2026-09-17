---
document_type: route_and_vehicle_status
document_id: "ctx_routes_001"
schema_version: "1.0"
state: active
scope: strategy
client_id: "client_123"
strategy_id: "strategy_456"
node_id: null
meeting_id: null
as_of: "YYYY-MM-DD"
valid_until: null
owner: "system"
authority: firm_approved
source_of_truth: true
supersedes: null
confidentiality: client_confidential
generated_by: "Capiro"
---

# Route and vehicle status

> Capiro should generate this file from live bill, vote, rule, and hearing state. It is not a second manually maintained tracker. Stages are the tracker's derived bill stages; votes and rule outcomes are recorded only when the roll call or rule report exists.

## Vehicles

| vehicle_id | Vehicle | Chamber | Bill | Current stage | Last action | Last action date | Rule or motion status | Latest vote | Source |
|---|---|---|---|---|---|---|---|---|---|
| VEH-001 |  | House / Senate |  | introduced / committee / reported / rule_pending / rule_failed / floor / passed_chamber / resolving / to_president / enacted / failed / vetoed |  | YYYY-MM-DD |  |  |  |

## Routes in priority order

| route_id | Route | Vehicle | Entry point | Requirements | Window status | Backstop |
|---|---|---|---|---|---|---|
| RT-001 |  | VEH-001 | Floor amendment / Markup / Managers' package / Report language / Conference |  | Open / Not yet scheduled / Closed |  |

## Amendment status ladder

| Hurdle | Status | Evidence | Date |
|---|---|---|---|
| Filed | Not yet / Done |  | YYYY-MM-DD |
| Made in order | Not yet / Done |  | YYYY-MM-DD |
| Adopted | Not yet / Done |  | YYYY-MM-DD |
| Conferenced | Not yet / Done |  | YYYY-MM-DD |
| Enacted | Not yet / Done |  | YYYY-MM-DD |

## Deadlines that bound the routes

| Deadline | Date | Hard or soft | Source |
|---|---|---|---|
| Continuing resolution expires | YYYY-MM-DD | Hard |  |
| Rules Committee amendment deadline | Not yet scheduled | Hard |  |
| Next-FY programmatic request window opens | YYYY-MM-DD | Soft |  |
