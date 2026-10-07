# Planner timed schedules and repeating work

Status: candidate validated locally; immutable builds and live verification pending. The existing core and private sections/activity release remain live. Full Asana parity continues in [IMPLEMENTATION.md](IMPLEMENTATION.md).

## Behavior

Tasks support optional start/due times in an IANA time zone. Date-only work stays open through its calendar day. Timed work becomes overdue at its deadline; list/board labels include the time and zone. CSV import/export carries times and the zone. Due sorting and the Dashboard queue compare actual deadlines across zones.

Repeats support daily, weekly, monthly, yearly and periodic work, a due-date or completion-date basis, chosen weekdays, an interval and an inclusive end date. A recurring task creates one successor on completion. Calendar anchors restore month ends and leap days; start/due duration and local clock times are preserved. Reopening, concurrent completion, task reordering or project-section changes cannot create a second successor. Archiving does not create more work. Timed repeats use the first occurrence of a repeated daylight saving hour and shift skipped times forward.

Only the Strategies API stores this data in the existing Planner task JSON. Server-derived deadlines and successor identities are hidden from responses and cannot be submitted by callers. All task writes preserve these internal properties; project duplication/template creation starts a fresh series. No migration, IAM, routing or shared authentication changes are required. The signed-in organization and approved Capiro integrations remain unchanged.

Reference: [Asana task scheduling](https://help.asana.com/s/article/scheduling-tasks-using-start-dates-due-dates-and-times), [task date/time contract](https://developers.asana.com/reference/updatetask). This release does not yet duplicate recurring subtasks/attachments or add scheduled rule execution/reminders.

## Verification

130 focused API checks passed across seven suites, including 23 real PostgreSQL cases. Coverage includes cross-zone queue sorting, the first folded daylight saving hour, local times across daylight saving changes, month-end/leap-year anchors, selected weekdays, completion dates, repeat limits, concurrent completion, reopen after reorder/section removal, redaction and unauthorized/stale writes. Twenty-two focused web checks passed. Shared/Strategies/web typechecks and Strategies/web production builds passed; the immutable builds will also compile the exact source.

Synthetic local browser editing passed weekly interval/weekday/end-date selection, a due time and zone, and save/reopen persistence. Evidence: `artifacts/planner/schedule-local-qa.png`. Database tests are constrained to the dedicated localhost `planner_qa` database; they clear only prior synthetic assignments there to make queue ordering repeatable.

## Release and recovery

The inspected serving baseline is Strategies revision 34 and web-vNext revision 443, both stable with one healthy task. Clone their task definitions and change only immutable images/release identifiers. Preserve concurrent Meri work. Promote Strategies first, wait for stability, then promote web-vNext and verify using private synthetic records.

The web can return to revision 443 while retaining the new Strategies image. Older Strategies revision 34 can read new schedule JSON but its older write validator rejects the new fields; after new schedule records exist, retain the new API contract for recovery and use a compatible forward fix instead of rolling the API below this release. Do not remove task data or weaken authentication/RLS to recover.
