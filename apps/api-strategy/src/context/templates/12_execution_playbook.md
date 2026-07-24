---
document_type: execution_playbook
document_id: "ctx_execution_playbook_001"
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

# Execution playbook

## Modes

- `Prepare`: create an internal draft or analysis.
- `Stage`: configure an external action but do not send or publish.
- `Execute`: perform only when policy explicitly allows it and approvals are present.

## Supported routes

| playbook_id | Eligible node | Destination | Mode | Required inputs | Output | Approval | Completion signal |
|---|---|---|---|---|---|---|---|
| PLAY-WORKSPACE-001 | Action + Deliverable or Submission | Workspace - New document setup | Prepare | Brief, ask, evidence, deadline, reviewer | Linked draft | Review before final use | Artifact ready for review |
| PLAY-OUTREACH-001 | Action + Member, Committee, Agency, or Coalition | Outreach - New campaign, Step 1 | Stage | Audience, approved ask, constraints, send window | Linked campaign draft | Explicit approval before send | Campaign sent and receipt recorded |

Planner is not supported until that feature ships.

## Preconditions

- Stable node ID.
- Owner and target date.
- No blocking context conflict.
- Required sources active and fresh.
- User can access destination.
- Required approvers known.

## Plan contract

Before tool use, record objective, sources, tool steps, artifacts, approval checkpoints, acceptance criteria, and cancellation behavior.

## Idempotency and recovery

- Reuse an active artifact for the same node and playbook unless a new version is requested.
- Use an idempotency key per run step.
- Preserve completed steps on failure and expose a resume point.
- Canceling does not delete an approved artifact without confirmation.
