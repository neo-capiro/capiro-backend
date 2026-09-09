# Client Intelligence contract and PAC repair

## Result and scope

The client profile contract card and Federal Spending drilldown now share one
reviewed identity scope. Both resolve mapped contractor UUIDs to UEIs. Approved
exact names can recover historical award rows only when the source UEI is NULL
or blank. A populated source UEI must match a verified client or mapped contractor
UEI. Contract and assistance mappings remain separate. Confirmed review status and
an explicit award roll-up decision are required for both screens.

This is a bounded repair to profile/explorer reads. Funding-opportunity scoring
and broader District Nexus calculations keep their existing stricter identity
and provenance rules. If a source award has a UEI absent from the reviewed client
and contractor catalog, verify and repair that identifier or corporate relationship;
do not delete a client UEI or broadly match award names to inflate the total.

The card is labeled Federal contracts. The existing importer covers Department
of Defense contracts; this change does not expand it to all agencies or grants,
nor certify complete historical award ingestion. An imported zero is explicitly
described as no matching imported records.

Political giving means Form 3X Schedule B line 23 contributions to federal
candidates and other committees, excluding memo entries and retaining negative
corrections. PAC catalog discovery includes Q/N/O/V/W, matching entity resolution.
Schedule B is traversed using FEC continuation cursors until exhaustion. Each
committee/cycle snapshot is replaced atomically only after a successful full
fetch, preserving source sub IDs, transaction IDs and filing numbers. Distinct
same-day/amount/recipient gifts remain distinct; successful reconciliation removes
superseded or deleted rows and legacy vendor spending.

The API shows all mapped committee links, totals across all recipient groups,
supported cycles, and sync evidence. Missing evidence or a failed import is not
reported as complete zero giving. The supported period begins January 1, 2021
(2022 cycle) and expands through the current two-year cycle. Employer-linked
Schedule A remains a separate, deliberately limited sample; its pagination is
fixed and truncated runs are marked incomplete.

## Rollout order

1. Pause the scheduled PAC importer and let existing PAC tasks finish. The old
   importer uses the tuple unique key removed by this migration and must not run
   against the new schema. Keep the pause until the new importer image is active.
2. Apply `20260909110000_fec_pac_source_identity_and_coverage` through the normal
   Prisma migration process. It adds source identity columns and the global
   `fec_pac_sync_state` table and replaces the old tuple uniqueness constraint.
   It intentionally does not label legacy rows as complete.
3. Deploy the API/importer build with its newly generated Prisma client, then
   the web build. The API requires the new state table. Verify application and
   ingestion database roles have the same access to this global table as to the
   other FEC source tables.
4. Run the updated `pnpm --filter @capiro/api sync:fec` in the normal ingestion
   environment with `FEC_API_KEY`. Verify the PAC catalog import completes.
   The Schedule A sample can leave this combined job marked incomplete by design;
   that is independent of the PAC snapshot completeness tracked per cycle.
5. In Intelligence Mappings, resolve the intended clients and review their PAC
   candidates, or use **Map manually → FEC PAC committee** with an official ID.
   Example acceptance case: verify Anduril PAC `C00763623` on the official FEC
   page before attaching it to Anduril. Existing L3 Harris mappings are
   `C00100321` and `C00129122`. Do not attach PACs solely on a weak name score.
6. Run `pnpm --filter @capiro/api sync:fec-pac` to reconcile every confirmed
   committee across the supported cycles. Verify every required committee/cycle
   state is `complete`; errors retain the last successful snapshot and remain
   visible as incomplete coverage. Resume the updated scheduled importer.
7. Open each client profile, use Sync, and compare the contract card with its
   drilldown with no additional filters. Check PAC periods and source-update
   timestamps. For official reconciliation, compare the same FEC line-23 scope
   and cycle, not all-disbursement committee totals or a different date window.

## Acceptance checks

- L3 Harris: approved exact names recover UEI-missing contract rows on both
  screens. Do not assume the previously observed 324 explorer rows are all valid
  corporate attribution; known conflicting UEIs remain excluded.
- Anduril: contract list/card agree; verified PAC mapping remains visible while
  awaiting import, then displays reconciled contributions after completed cycles.
- Unmapped clients: show actionable mapping state. Mapped/no-state clients: show
  awaiting import. Failed/partial imports: show coverage status. Only completed
  empty snapshots support a zero-giving statement for the stated period.
- Mapping changes invalidate the current profile and explorer caches. Profile
  Sync rereads contract, PAC and lobbying data. It does not itself ingest upstream
  FEC or USAspending data.
- Changing selected clients in Federal Spending does not show the previous
  client's records under the new label while the request is pending.

## Validation boundary

Regression suites cover identity exclusion/recovery and profile/list parity,
committee search/pinning, full recipient totals, coverage states, cursor traversal,
snapshot publication and UI refresh/mapping states. Local verification uses mocked
source responses and database collaborators; live ingestion, migration rehearsal,
deployed role grants, FEC totals reconciliation and production browser acceptance
must occur during rollout. No production mappings or data are changed by this branch.
