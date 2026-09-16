# LW8 calendar source and canonical hearing repair

Prepared against `5538e04a84df376eb2ea5c703f8d1aeaf178a671`. This change set fixes LW8-04 source diagnostics/qualification and LW8-05 duplicate prevention. It does not claim that a publisher access restriction has been removed or that existing production duplicates have already been reconciled.

## Deployment order

1. Run the API test and migration gates, including the hearing alias PostgreSQL verification. Build the API and all hearing writer images from the same source revision and generated Prisma schema.
2. Apply additive migration `20280915010000_hearing_canonical_alias` before starting the new API/writers. This sequence intentionally follows the repository's existing 2028-numbered migrations. It adds nullable alias columns and filters the existing federal SQL view; it merges no hearing data. Preserve the view's `security_invoker` option and existing grants.
3. Deploy API request handlers and discovery/sync workers together. New numeric Senate events share the `sen-{congress}-{eventId}` identity in Congress.gov discovery, Senate discovery and legacy sync. Historical exact `cm-*` and `sen-*` IDs remain supported. House IDs stay in the existing `cm-*` namespace. Canonical Senate projections retain schedule/title ownership; the legacy sync only supplements missing fields on these rows.
4. Complete the reviewed data operation below. Until then, existing duplicate rows will still appear. The migration alone must never silently hide an unreviewed row.
5. Run ordinary-account UI checks and resume paused writers after successful verification.

## Existing duplicates: reviewed, ID-based operation

The committed `apps/api/scripts/fixtures/hearing-alias-review-2026-09-14.json` contains three pairs confirmed through both live UI records:

| Proceeding | Retained alias ID | Canonical ID | Official schedule |
| --- | --- | --- | --- |
| FBI oversight | `cm-119-338740` | `sen-119-338740` | Sep 15, 2026, 9 AM ET, SH-216 |
| Nominations | `cm-119-338745` | `sen-119-338745` | Sep 16, 2026, 10:15 AM ET, SD-G50 |
| Executive business | `cm-119-338752` | `sen-119-338752` | Sep 17, 2026, 10:15 AM ET, SH-216 |

The live observations are public, scheduled Senate Judiciary events. Each pair shares the exact Congress.gov Senate event identifier; the richer source-qualified Senate row is the proposed canonical record. The runtime validator still requires matching jurisdiction, Congress, chamber, parent/subcommittee, date, time, normalized title and known visibility before any reference changes. It refuses a private/public visibility conflict, alias chains, ambiguous identities and changed schedules.

Pause hearing discovery/sync, capture and related writers for the maintenance window. Drain or explicitly reconcile queued jobs containing an old hearing ID before application; embedded JSON and jobs in another database are not rewritten by this script. Obtain a database snapshot and retain the resulting plan in the deployment record. Use the normal maintenance database role; the script does not enable an RLS bypass, and it fails if a policy would hide tenant references from its inventory.

From the API package directory, the default operation is read-only:

```sh
pnpm exec tsx scripts/reconcile-hearing-aliases.ts --pairs scripts/fixtures/hearing-alias-review-2026-09-14.json
```

Review every public hearing snapshot and same-schema reference count. Check `readyToApply` and `blockedOperations`: an immutable recording permission, review-context or published-record reference blocks this repair even if identity matches. The inventory includes `intel_hearing_record_run.event_id`, `intel_hearing_record_brief.event_id` and `intel_hearing_record_job.event_id`; queued record jobs also block application because their payload and lifecycle need a separate repair. Ordering cursor `last_event_id` is not rewritten. Those records require a separate reviewed integration; their triggers are never disabled. The result includes a `planHash`. The apply step must use that exact hash, with the same quiesced inputs:

```sh
pnpm exec tsx scripts/reconcile-hearing-aliases.ts --pairs scripts/fixtures/hearing-alias-review-2026-09-14.json --apply --plan-hash REVIEWED_PLAN_HASH
```

For pairs without immutable history, the script changes mutable reference values without deleting their rows or tenant/user identities. It retains both original hearing rows, stores the source evidence and reviewed plan, and sets a durable alias. A uniqueness/FK conflict, missing scope, RLS error, changed plan or lock timeout aborts the entire transaction. Do not delete a conflicting follow, transcript, source observation or calendar transition to force success; resolve that concrete conflict in a separate reviewed repair. The script does not reconcile arbitrary duplicate-looking titles.

Public bill links (`committee_hearing_bill`, unique per hearing and bill) are the one reference class both sides of a pair can legitimately hold at once: each source may have written its own row linking the same bill to the same event. For those rows the apply step does not relocate blindly. An alias-side link whose billId and Congress already exist on the canonical side is RETAINED in place — same row id, same `synced_at` to the microsecond — because the canonical side's equivalent link already serves the same mapping to every reader. Only non-overlapping alias-side links move to the canonical hearing, and each moved row is updated by exact row id with an affected-row identity check. A same-billId link carrying a different Congress on the two sides is never merged; the batch aborts before any update. The reviewed plan inventories the exact bill-link rows (ids, billIds, Congress, microsecond `synced_at`) for both sides, so any bill-row content change with unchanged counts still invalidates the `planHash` and forces a new dry run. The stored `aliasEvidence` and the emitted report label each link `retained` or `moved` explicitly — a retained duplicate must never be reported as "all references moved" — and the exact row rows appear under the bill-link reference in `plans[].references[]` (`rows`, `retained`, `moved`).

Existing hearing URLs resolve to canonical facts. Existing single-event `.ics` URLs retain their prior UID; the exported detail link points to the canonical event. Explicit-selection bulk exports also retain a selected legacy UID. When both IDs are selected, canonical identity wins regardless of selection order and only one event is exported. An offset combining retained alias revision with current canonical calendar/source revisions makes each subsequent federal source change advance the sequence. Window-based bulk exports use canonical IDs and include one event per proceeding. Files already downloaded or imported into a third-party calendar cannot be retracted by this server change.

## Florida publisher availability

The configured first-party URLs remain valid:

- House: `https://www.flhouse.gov/Sections/HouseSchedule/houseschedule.aspx`
- Senate: `https://www.flsenate.gov/Committees`

The Sept 14 direct House daily fetch returned HTTP 200 with a 244-byte **Request Rejected** page. This is an upstream denial, not a verified empty calendar. The repaired fetcher reports that denial explicitly; it does not bypass the publisher restriction. Complete House coverage still requires an approved publisher integration or permitted worker access, followed by an actual successful source replay.

Senate Committees and the Sept 14 daily page returned normal HTML. This establishes availability only; it does not prove every notice, session and agenda reconciles. Re-run the bounded Florida discovery job for the affected window using the existing worker path. Inspect per-URL source errors and coverage qualification separately. An accessible notice with an unresolved session may have a healthy publisher but incomplete event coverage. A missing layout, unreadable page, denied fetch or no page read cannot produce a healthy/complete result. Empty schedules count only when the page explicitly confirms the requested calendar day.

Dates in publisher headings are parsed as calendar days independently of the worker timezone. One bad House day no longer prevents later days in the same window from being checked. Transient network retries remain bounded.

## Acceptance checks

- Federal Schedule, Sep 14–20: the three reviewed proceedings appear once each; query count and pagination agree. Judiciary room totals agree with Schedule. Archive/recording SQL reads exclude durable aliases through the federal view.
- Open both IDs for each pair. Canonical detail, source evidence, follow/attendance state and export actions remain accessible to the same authorized user. If immutable saved history exists, the data operation remains blocked until that integration is separately verified.
- A user who followed the old ID still sees the proceeding under Following. Another user's or tenant's follow state remains isolated. Unfollow through either old/new hearing route targets the canonical reference.
- Download an existing old-ID calendar URL twice: the UID remains old-ID-stable, time/date follow canonical facts, and the detail URL is canonical. Bulk selection containing both IDs returns one event and no spurious unavailable warning.
- Discovery refresh and a legacy replay do not create another row. A subsequent Senate reschedule changes the same canonical row and is not undone by legacy fill-only enrichment.
- Florida House denial remains clearly labeled until the worker can read the official schedule. Senate health cannot replace the independent complete-coverage gate. Confirm the actual replay timestamps and errors rather than only refreshing the UI status panel.

Before alias application, application rollback can leave the additive nullable columns in place. After application, retain the alias-capable API on rollback; reverting to old handlers can strand moved references. Reversing a reviewed merge requires its stored plan plus a reviewed reference-level restoration or database snapshot. Do not automatically split current references or drop the alias columns.
