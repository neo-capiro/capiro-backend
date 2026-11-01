# Saved CRM activity metrics

`GET /clients/:clientId/activity/metrics` returns definition
`client-recorded-activity-v1`. The existing activity owner reads the complete
`client_activity` population under current tenant membership and the client wall.
Each saved entry is counted once; there are no association joins or page limits.
All counts use one SQL statement snapshot after current authority is established.

| Count | Population and time rule |
| --- | --- |
| `recordedActivities` | All saved activity kinds whose `occurred_at` is in the inclusive UTC interval `[observedAt - 30 days, observedAt]`. Future occurrences are excluded. |
| `openRequests` | Saved `request` entries with `settled_at IS NULL`, across all time, including undated entries. |
| `overdueRequests` | Open requests with `due_at < observedAt`. Due-now and undated entries are excluded. |
| `openCommitments` | Saved `commitment` entries with `settled_at IS NULL`, across all time, including undated entries. |
| `overdueCommitments` | Open commitments with `due_at < observedAt`. Due-now and undated entries are excluded. |

These are record counts, with no percentage denominator, stage weights, fiscal
year or health formula. Derived meetings, mail, outreach, attachments and Planner
tasks are excluded. Counts are not contact touches, replies, Planner deadlines,
engagement health or a portfolio-wide work summary. Source associations do not
multiply an activity; separate user-authored entries remain separate records.

The response supplies tenant/client identity, observation time, exact activity
window and `coverage: complete`. The aggregate either succeeds completely or
fails; an unavailable source never returns invented zeros or a partial total.
Clients should label old observations, refresh after activity mutations, and
discard results after authority loss. The UI refreshes every minute while open,
labels observations older than two minutes stale, and hides failed refresh data.

Validation: ten ordinary-role PostgreSQL cases cover complete zeros, more than
500 rows, date boundaries, request/commitment settlement, tenant/client isolation,
walls, archival, membership, role and tenant changes. Existing activity service
and HTTP tests also pass. No schema migration, application build or deployment.
