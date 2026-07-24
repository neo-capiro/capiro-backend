# Meri Strategy Context Pack

These templates provide durable, typed context for the Context Steward, Strategy Watcher, and Execution Agent.

## Use

1. Complete the YAML front matter on every file.
2. Use ISO dates (`YYYY-MM-DD`) and explicit federal fiscal year/quarter labels.
3. Pin a file at the narrowest valid scope: node, strategy, client, or firm.
4. Mark `source_of_truth: true` only after the file is approved for that scope.
5. Replace older files with `supersedes`; do not silently delete history.
6. Separate facts, assumptions, intelligence, decisions, and rules.
7. Never place credentials, passwords, or access tokens in these files.

## Conflict order

Meri must not silently choose between material conflicts. It should use:

1. A recorded conflict resolution.
2. An active source-of-truth file at the matching scope.
3. Higher authority.
4. More specific applicable scope.
5. Newer `as_of` date.

When the conflict remains material, Meri stops the affected recommendation or execution and asks for resolution.

## Files by agent

| File | Context Steward | Strategy Watcher | Execution Agent |
|---|---|---|---|
| `00_context_manifest.md` | Index, gaps, conflicts | Stale/missing context | Preflight eligibility |
| `01_strategy_brief.md` | Goal and success criteria | On-track evaluation | Deliverable purpose |
| `02_client_constraints.md` | Hard limits and approvals | Constraint alerts | Blocks disallowed actions |
| `03_ask_and_options.md` | Primary/fallback asks | Ask-change detection | Grounds drafts and outreach |
| `04_stakeholder_map.md` | Stakeholder facts | Position-change monitoring | Audience context |
| `05_calendar_and_deadlines.md` | Date normalization | Schedule monitoring | Timing and due dates |
| `06_decision_rules.md` | If/then rules | Watch logic | Approval/stop logic |
| `07_current_plan.md` | Live-plan export | Node/dependency checks | Eligible-node input |
| `08_evidence_register.md` | Provenance | Evidence changes | Cited claims |
| `09_meeting_intelligence.md` | Commitments/signals | Follow-up proposals | Approved follow-up context |
| `10_decision_log.md` | Settled decisions | Revisit triggers | Prevents contradictory work |
| `11_agent_mission.md` | Mission validation | Triggers/cadence/stops | Bounded mission context |
| `12_execution_playbook.md` | Input validation | Ready-step checks | Tools, outputs, approvals |
| `13_agent_permissions.md` | Policy scope | Auto-apply rules | External-action boundaries |
