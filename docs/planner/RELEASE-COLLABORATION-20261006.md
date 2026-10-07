# Planner activity corrections and reusable work

Release candidate; promotion and live verification are pending.

Authors can correct, remove and restore their own comments and time entries while their current access permits it. Corrections append a versioned revision; original activity and revision history remain immutable. Current task totals, activity and inbox use the latest revision, and removed content is redacted. Generated task audit events cannot be changed. Competing edits return 409 and the editor preserves its draft and opening version.

Completing a recurring task copies its active subtask hierarchy and attachments into fresh identities, resets completion/approval state and remaps internal dependencies. Subtask dates retain their original values. Prior comments and logged time remain with the previous occurrence. Attachment metadata has independent archive state and permission checks; encrypted immutable payloads are reused within the same tenant. A requester must be able to read every copied descendant; an inaccessible descendant rolls back completion. One transaction can copy up to 1,000 tasks.

Project templates support positive/negative offsets from a project start or due date, missing dates, working-day counting and weekend skipping. Creation shows a date preview, shifts timed schedules and repeat limits, and preserves the template. Created projects start private. Existing templates retain fixed-date behavior unless configured to use relative dates.

Only Strategies owns this API and storage. The additive `20261006050000_planner_activity_revisions` migration creates the seventh Planner table with forced tenant RLS, an immutable trigger, and SELECT/INSERT-only application privileges. Shared authentication and the accepted integrations are unchanged. No Workspace documents, client/meeting writes, Asana writes or migration of Asana records are included.

References: [Asana repeating tasks](https://help.asana.com/s/article/scheduling-tasks-using-start-dates-due-dates-and-times), [relative template dates](https://help.asana.com/s/article/project-templates).

## Qualification

140 API checks passed across eight suites, including 29 real PostgreSQL cases and the tenant-scope build guard. Twenty-eight web checks passed. Shared/Strategies/web typechecks and both production builds passed. A fresh disposable localhost database applied all six Planner migrations in one transaction, starting with Aurora's broad legacy grants; all seven final tables have forced RLS and the intended restricted privileges.

Local browser checks passed comment/time edit, remove and restore with corrected totals, plus relative-template preview and creation. A stale Vite dependency cache was refreshed after adding a shared export; the fresh preview passed. Remote immutable builds, production migration proof and signed-in verification remain required.

## Promotion and recovery

Serving baselines: Strategies revision 35 and web-vNext revision 444. Clone their task definitions, changing only immutable images and release identifiers; preserve current secrets, roles, network, health checks and circuit breakers. Apply the additive migration using the existing dedicated migration role and verify the restricted runtime application role before promoting Strategies, then web-vNext. No Compute/CDK, IAM, canonical API or routing deployment is needed.

After corrections or relative templates exist, retain the new Strategies contract during recovery: the older API ignores revisions when calculating totals and rejects relative-template properties on writes. The web may return to revision 444 while retaining a compatible Strategies image. Do not delete original activity, revisions, copied tasks or attachment payloads.
