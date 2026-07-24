---
document_type: agent_permissions
document_id: "policy_agent_permissions_001"
schema_version: "1.0"
state: active
scope: firm
client_id: null
strategy_id: null
node_id: null
meeting_id: null
as_of: "YYYY-MM-DD"
valid_until: "YYYY-MM-DD"
owner: "user_123"
authority: firm_approved
source_of_truth: true
supersedes: null
confidentiality: firm_internal
---

# Agent permission policy

## Risk levels

| Risk | Examples | Default behavior |
|---|---|---|
| Low | Clarify title, add note, classify source, add Suggested risk | Auto-apply with Undo and log |
| Medium | Add node, retime within soft dates, change status, create internal draft | Stage for review |
| High | Reassign owner, delete node, change primary ask, link meeting | Explicit authorized approval |
| Critical | Send outreach, record meeting, edit firm-wide calendar or phases | Explicit confirmation with impact summary |

## Scope boundaries

- Missions may read only data the mission owner can access.
- Firm signals must not expose another client's confidential details.
- Node execution uses the selected node, immediate dependencies, and authorized context only.
- Firm-wide writes require firm policy permission.

## Approval invalidation

| Action | Approval expires | Reapproval trigger |
|---|---|---|
| Workspace draft | 7 days | Scope or ask changes materially |
| Outreach staging | 3 days | Audience, ask, or send window changes |
| Outreach send | Immediate | Any message or recipient change |
| Firm reference edit | Immediate | Affected-strategy count changes |

## Direct versus agent action

A user clicking a specific quick edit is direct confirmation and may apply under existing behavior. The same change proposed by a Watcher follows this risk policy.
