# Planner activity corrections and reusable work

Live on `os.capiro.ai`, verified October 6, 2026. Full Asana parity remains in progress.

Authors can correct, remove and restore their own comments and time entries while their current access permits it. Corrections append a versioned revision; original activity and revision history remain immutable. Current task totals, activity and inbox use the latest revision, and removed content is redacted. Generated task audit events cannot be changed. Competing edits return 409 and the editor preserves its draft and opening version.

Completing a recurring task copies its active subtask hierarchy and attachments into fresh identities, resets completion/approval state and remaps internal dependencies. Subtask dates retain their original values. Prior comments and logged time remain with the previous occurrence. Attachment metadata has independent archive state and permission checks; encrypted immutable payloads are reused within the same tenant. A requester must be able to read every copied descendant; an inaccessible descendant rolls back completion. One transaction can copy up to 1,000 tasks.

Project templates support positive/negative offsets from a project start or due date, missing dates, working-day counting and weekend skipping. Creation shows a date preview, shifts timed schedules and repeat limits, and preserves the template. Created projects start private. Existing templates retain fixed-date behavior unless configured to use relative dates.

Only Strategies owns this API and storage. The additive `20261006050000_planner_activity_revisions` migration creates the seventh Planner table with forced tenant RLS, an immutable trigger, and SELECT/INSERT-only application privileges. Shared authentication and the accepted integrations are unchanged. No Workspace documents, client/meeting writes, Asana writes or migration of Asana records are included.

References: [Asana repeating tasks](https://help.asana.com/s/article/scheduling-tasks-using-start-dates-due-dates-and-times), [relative template dates](https://help.asana.com/s/article/project-templates).

## Qualification

140 API checks passed across eight suites, including 29 real PostgreSQL cases and the tenant-scope build guard. Twenty-eight web checks passed. Shared/Strategies/web typechecks and both production builds passed. A fresh disposable localhost database applied all six Planner migrations in one transaction, starting with Aurora's broad legacy grants; all seven final tables have forced RLS and the intended restricted privileges.

Local browser checks passed comment/time edit, remove and restore with corrected totals, plus relative-template preview and creation. A stale Vite dependency cache was refreshed after adding a shared export; the fresh preview passed. Both exact-source remote ARM64 image builds succeeded. Production migration task `741996c20d8e46bfa571f277e7809414` exited 0 after applying only the sixth Planner migration. ECS execution through the actual serving application role confirmed `current_user = capiro_app`, six finished Planner migration entries, seven forced-RLS tables, no DELETE privileges, no UPDATE privileges on events/revisions, and enabled immutable triggers (`PLANNER_SIX_MIGRATIONS_RUNTIME_PROOF_PASSED`).

Signed-in verification passed comment correction/removal/restoration and 15-to-25-minute time correction, removal to zero and restoration to 25, all persisted after reload. Completion created exactly one fresh parent/child hierarchy and remapped the child's dependency to the new parent. The copied attachment downloaded with SHA-256 `f70b0b8146ed21fa95951183131ef1c5908d79117856446ee346fae9a233cb93`, matching the synthetic source; archiving the original attachment left the copied metadata active. Comments and time remained with the prior occurrence. A private relative template previewed November 7 (Saturday) as task dates on November 9/10, and its newly created private project persisted those dates after reload.

Cleanup recoverably archived all eight synthetic tasks, both private projects (`7a0b040c-2dad-4e68-90f4-8a4fa7be2d73`, `bf41b073-58b7-4bef-b5c5-6e8a768a1254`) and the QA template. My Tasks (all statuses) and the Dashboard Work Queue contain no QA work. No colleagues were mentioned or assigned. Screenshots are in ignored `artifacts/planner/live-collaboration-qa.png`, `live-relative-template-qa.png` and `live-relative-project-qa.png`.

## Promotion and recovery

Source: `45da2eabfc098e2a61c62f3d3ec2535c2ce4316c`, including concurrent main `f86a166fc51521d03ef3f96fe90d82005c982609`. CodeBuild runs `capiro-build-web-dev:9e11f7c5-a25f-4b22-affd-d698be66d004` (Strategies) and `capiro-build-web-dev:f320eb71-2009-42da-a32a-964dfe9d4bae` (web) succeeded.

Serving images:

- Strategies revision 36: `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/api-strategy@sha256:390a1310a31299593e1bdfc6971c6a9ca633af66d53ce1a341cff0292f8511fe`.
- Web-vNext revision 445: `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/web-vnext@sha256:2d15aa0aba38b4da4415edfcd674536baa2faf46090a2e02ae098f6270cd2204`.

Both ECS services report one desired/running task and a single PRIMARY/COMPLETED deployment. Public Strategies health is OK, web runtime config reports the exact release source, and Strategies startup reports 25 tenant-scoped models. Task definitions cloned serving baselines 35/444 and changed only immutable images/release identifiers, preserving secrets, roles, network, health checks and circuit breakers. Migration revision 10 cloned the existing dedicated migration definition with only its image changed. No Compute/CDK, IAM, canonical API or routing deployment was performed.

After corrections or relative templates exist, retain the new Strategies contract during recovery: the older API ignores revisions when calculating totals and rejects relative-template properties on writes. The web may return to revision 444 while retaining a compatible Strategies image. Do not delete original activity, revisions, copied tasks or attachment payloads.
