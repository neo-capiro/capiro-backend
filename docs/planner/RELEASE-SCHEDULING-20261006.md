# Planner timed schedules and repeating work

Status: live and verified. Strategies revision 35 and web-vNext revision 444 are stable with one healthy task each and completed deployments. The public runtime configuration reports the promoted source. Full Asana parity continues in [IMPLEMENTATION.md](IMPLEMENTATION.md).

## Behavior

Tasks support optional start/due times in an IANA time zone. Date-only work stays open through its calendar day. Timed work becomes overdue at its deadline; list/board labels include the time and zone. CSV import/export carries times and the zone. Due sorting and the Dashboard queue compare actual deadlines across zones.

Repeats support daily, weekly, monthly, yearly and periodic work, a due-date or completion-date basis, chosen weekdays, an interval and an inclusive end date. A recurring task creates one successor on completion. Calendar anchors restore month ends and leap days; start/due duration and local clock times are preserved. Reopening, concurrent completion, task reordering or project-section changes cannot create a second successor. Archiving does not create more work. Timed repeats use the first occurrence of a repeated daylight saving hour and shift skipped times forward.

Only the Strategies API stores this data in the existing Planner task JSON. Server-derived deadlines and successor identities are hidden from responses and cannot be submitted by callers. All task writes preserve these internal properties; project duplication/template creation starts a fresh series. No migration, IAM, routing or shared authentication changes are required. The signed-in organization and approved Capiro integrations remain unchanged.

Reference: [Asana task scheduling](https://help.asana.com/s/article/scheduling-tasks-using-start-dates-due-dates-and-times), [task date/time contract](https://developers.asana.com/reference/updatetask). This release does not yet duplicate recurring subtasks/attachments or add scheduled rule execution/reminders.

## Verification

130 focused API checks passed across seven suites, including 23 real PostgreSQL cases. Coverage includes cross-zone queue sorting, the first folded daylight saving hour, local times across daylight saving changes, month-end/leap-year anchors, selected weekdays, completion dates, repeat limits, concurrent completion, reopen after reorder/section removal, redaction and unauthorized/stale writes. Twenty-two focused web checks passed. Shared/Strategies/web typechecks and Strategies/web production builds passed; the immutable builds will also compile the exact source.

Synthetic local browser editing passed weekly interval/weekday/end-date selection, a due time and zone, and save/reopen persistence. Evidence: `artifacts/planner/schedule-local-qa.png`. Database tests are constrained to the dedicated localhost `planner_qa` database; they clear only prior synthetic assignments there to make queue ordering repeatable.

## Release and recovery

The serving baselines were Strategies revision 34 and web-vNext revision 443. Their cloned definitions changed only immutable images and release identifiers. Concurrent Meri code and release records are retained. Strategies was promoted and verified stable before web-vNext. No migrations, IAM, canonical API or routing deployments ran.

Both ARM64 images use source `21ace0df6c876db0e95615e9103ec9d44718c801`:

- Strategies revision 35: `capiro/dev/api-strategy@sha256:5917815853ef8327a80904c722bea4b3e52af72e556175483a472b7f6455edbc`; CodeBuild `capiro-build-web-dev:aa2c4dc6-8c3d-4ae8-a0c5-e6e786bc9f18` succeeded. Task `02f902d7aa704441a206106cda4c8e73` started successfully, connected Prisma and passed health.
- Web-vNext revision 444: `capiro/dev/web-vnext@sha256:1a798056ef6bdf5f61bdb74c07852456a84472cb2c67b4c1ad13c749bf557fc4`; CodeBuild `capiro-build-web-dev:d02c0de0-19af-4696-a988-6936e6484ef5` succeeded. Public runtime source and signed-in UI match the release.

## Live verification and cleanup

A private, self-assigned weekly task persisted its October 6/7 dates, 08:00/09:30 local times, America/New_York zone, two-week interval, Monday/Wednesday choices and October 31 end date across reload. Completing it created October 19 work with the same duration and times. Reopening/completing the original created no duplicate. Completing subsequent occurrences produced October 21 and then stopped before the next interval exceeded the end date. List labels include 9:30 AM EDT.

QA project `82a1dd76-108b-40c8-8755-ff2a1d19ed8d` and exactly three synthetic tasks (`914a83c9-de50-40f3-ae83-ad8a0a2b168f`, `3da388bb-916b-47a1-90a9-2ee887bcc189`, `d833276d-3676-4689-9a27-7af1ef553926`) are recoverably archived. The Dashboard Work Queue and Planner My Tasks are clear. No clients/meetings were changed, no public capabilities were created and no colleagues were notified.

Evidence before cleanup: `artifacts/planner/live-scheduling-qa.png` and `artifacts/planner/live-recurrence-qa.png`.

The web can return to revision 443 while retaining the new Strategies image. Older Strategies revision 34 can read new schedule JSON but its older write validator rejects the new fields; after new schedule records exist, retain the new API contract for recovery and use a compatible forward fix instead of rolling the API below this release. Do not remove task data or weaken authentication/RLS to recover.
