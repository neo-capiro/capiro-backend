---
document_type: decision_rules
document_id: "ctx_decision_rules_001"
schema_version: "1.0"
state: active
scope: strategy
client_id: "client_123"
strategy_id: "strategy_456"
node_id: null
meeting_id: null
as_of: "YYYY-MM-DD"
valid_until: "YYYY-MM-DD"
owner: "user_123"
authority: client_approved
source_of_truth: true
supersedes: null
confidentiality: client_confidential
---

# Decision rules and constraints

## Meri may auto-apply with Undo
-

## Meri must stage for review
-

## Meri requires explicit approval
-

## Meri must never do
-

## Strategy rules

| rule_id | If | Then | Rationale | Approver | Severity |
|---|---|---|---|---|---|
| RULE-001 | A hard date moves by more than 14 days | Recalculate dependent preparation steps and stage a Change Set | Preserve lead time | Strategy owner | high |
| RULE-002 | A Tier 1 stakeholder becomes opposed | Propose a decision gate before public outreach | Avoid escalation without reassessment | Client lead | high |

## Stop conditions

- Material controlling fact is conflicted.
- Required approval is missing.
- A hard constraint would be violated.
- Current user lacks permission.
- Destination tool is unavailable.
