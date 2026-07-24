---
document_type: agent_mission
document_id: "mission_keep_on_track_001"
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
authority: firm_approved
source_of_truth: true
supersedes: null
confidentiality: client_confidential
mission_type: strategy_watcher
---

# Agent mission

## Mission

- Name: Keep this strategy on track
- Objective:
- Mission owner:
- Start date: `YYYY-MM-DD`
- Target completion date: `YYYY-MM-DD`

## Triggers

- `strategy_updated`
- `node_updated`
- `node_due_within: 14_days`
- `node_overdue`
- `dependency_completed`
- `meeting_completed`
- `context_document_updated`
- `reference_calendar_changed`
- `linked_artifact_updated`

## Cadence

- Scheduled check: Daily / Weekly / Custom
- Local time: `08:00`
- Timezone: `America/New_York`
- Digest day: Monday

## Interrupt only when

- A hard deadline is at risk.
- A client constraint may be violated.
- Critical approval is needed.
- A material context conflict blocks the plan.
- An external action lacks approval.

## Permissions

### Auto-apply with Undo
- Add an explanatory note.
- Add a Suggested risk.
- Mark context stale.

### Stage for review
- Add a node.
- Retime within soft deadlines.
- Change status.
- Create an internal Workspace draft.

### Explicit approval
- Change owner.
- Delete node.
- Change primary ask.
- Link meeting.
- Send external outreach.
- Change firm-wide calendar or phase.

## Stop conditions

- Strategy target reached.
- User pauses/cancels.
- Strategy archived.
- Required permissions revoked.
