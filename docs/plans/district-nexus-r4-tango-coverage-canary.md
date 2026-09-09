# District Nexus R4 — authenticated browser canary

This is a read-only check of the authorized capiro-dev surface. Confirm the host is
serving the intended environment and release before starting. Do not access
capiro-prod-os-capiro, ingest data, change tenant flags, or enable schedules.

## Browser findings (2026-09-09) and repair scope

The authenticated browser check reached the real District Nexus drawers:

- **L3Harris Technologies / FL-08:** GSA rendered 590 assets, 550 owned / 40 leased,
  and 505,731 sq ft (FY2024). Supplier coverage rendered "No matches in records
  ingested so far." with a partial corpus note showing 50 of 2,743,636 records.
- **Anduril / CA-47:** GSA rendered 73 assets, 65 owned / 8 leased, and 1,759,253 sq ft.
  Supplier coverage required a confirmed contracting identity and retained the
  partial corpus note. Anduril's selectable districts were CA-47 and GA-06; the
  old instruction to select Anduril / FL-08 was not reproducible in the UI.
- Requested and enacted amounts remained distinct; Senate CDS entries displayed
  statewide labels and GSA source-unknown warnings were visible.
- Three defects were observed: GSA's source line borrowed boundary Congress 119
  from the economic rail despite its unknown-source warning; manufacturing metrics
  omitted their measurement names; Federal Market showed about $2B in FL-08
  contracts while the canonical District Nexus contract total was absent.

The repair uses GSA's full latest-FY aggregate for its source boundary values,
adds sector measurement labels, and makes Federal Market contracts use District
Nexus's existing canonical award identity policy. A disposable database regression
compares both contract readers against the same facts. Repeat live contract
reconciliation after deployment; the browser observation alone does not establish
which live mappings produced the discrepancy.

These observations are browser rendering evidence, not an independent live
database or network-payload audit. This repair was not deployed by the canary
session. Matches-present supplier coverage and a flag-off control tenant were
not exercised in that browser check.

## Preconditions for the repair canary

1. After merge/deploy authorization, verify API and web serve the repair commit
   or a verified descendant. Record the actual release SHA and timestamp.
   This display/identity repair adds no migration.
2. R4 and migration
   `20280908010000_tango_subaward_checkpoint_pagination` were already shipped.
   Verify their continued presence rather than replaying recovery by default.
3. Use the internal tenant and a client visible to the signed-in user:
   - L3Harris Technologies:
     `0e042626-ecde-44b3-88f1-9c2aed31d910`, district FL-08.
   - Anduril:
     `d1b0cb55-fd3a-49ef-847a-7bbe9175dc44`, district CA-47.
   Reconfirm these selections exist; do not manufacture a client relationship.
4. All four ingestion schedules remain disabled and external tenant activation
   remains unchanged. Use an authenticated session, or let the user sign in.

## Checks

1. **GSA totals and vintage.** Open District Nexus, choose L3Harris, then FL-08.
   The last observed FY2024 totals were 590 assets / 505,731 sq ft. If ingestion
   has changed, reconcile against the current source aggregate instead of treating
   the old numbers as permanent fixtures.
   - The source line must say "district vintage source-unknown (not inferred)"
     when any contributing GSA boundary value is null or metadata is absent.
   - Economic boundary Congress 119 must not become GSA's boundary.
   - If a later source supplies a known boundary, render that source's value;
     label multiple known boundaries as mixed.
   - Source warnings remain visible. First-publication baseline ledger entries
     must not appear as new material changes.

2. **Sector measurements.** In Industry & workforce, every row must name its
   measurement, retaining units, source, year, and public-context labeling.
   - For the observed CBP FY2023 FL-08 snapshot: annual payroll was
     1,453,285,000 USD, first-quarter payroll 355,377,000 USD, and employment
     18,543 people.
   - Annual and quarterly payroll must not have indistinguishable labels or be
     added together. Unknown metric keys must remain identifiable.

3. **Contract reconciliation.** For the same L3Harris / FL-08 selection and
   equivalent date/source filters, compare Federal Market's contract count and
   amount with the canonical District Nexus contract rail and its evidence.
   - Both readers use `federal_award`, place-of-performance geography, and the
     same contract identity policy. Without a date filter, the drawer reads all
     ingested dates; do not compare it to a time-filtered explorer.
   - Verified UEIs take precedence over every name match. Contracting mapping
     UUIDs resolve through `federal_contractor.uei`; assistance mappings do not
     supply contract identifiers. Only reviewed, non-fuzzy names can be a fallback
     when no verified UEI exists.
   - Capture matching response fields or visible values where available. Explain
     any remaining mismatch before claiming this check passes. Do not broaden
     identity matching or add subawards/future opportunities to make totals agree.

4. **Partial supplier coverage and identity.**
   - L3Harris's previously observed no-match case must retain
     "No matches in records ingested so far." while the unfiltered corpus is partial.
   - A client with real matched rows should show its figures qualified as
     "records ingested so far"; do not create matches for this test.
   - Anduril's no-identity case must explain the missing confirmed identity.
   - All cases retain `sourceCoverageNote` and current observed counts. The last
     verified corpus was 50 / 2,743,636; it is not complete.
   - Never label a partial no-match case as a complete, genuinely empty corpus.
     If an appropriate matched client is unavailable, mark that case unverified.

5. **CPF/CDS, Senate, and warnings.** Verify requested versus final/enacted amounts,
   source year, statewide Senate attribution when no project district is
   source-backed, and visible source-unknown warnings. Missing final amounts
   must not become zero-dollar awards.

6. **Flag-off control.** Use an existing authorized control tenant with the child
   flag off; do not mutate flags. Priority Intelligence must be hidden when its
   child flag is off. Supplier coverage must be hidden when its flag is off or
   the endpoint returns the flag-denial 404. Where supported, verify no supplier
   status request is issued for a disabled surface. If there is no available
   control tenant, mark live verification incomplete and report automated flag
   tests separately.

## Evidence record

For each check, record the environment/release, tenant, client, district, observed
result, pass/fail/unverified, and screenshot or response evidence when available.

Keep these separate:

- Authenticated browser rendering and any actually captured network payloads.
- Live service-method/database checks, including the earlier FL-08 590 / 505,731
  proof on the R4 ship.
- Local unit/integration results attached to the repair PR.

A service-method result or bundle marker does not establish that the UI rendered
correctly. Automated fixtures do not replace missing live identity/control cases.

## Further Tango ingestion — separate authorization

The legacy recovery already completed: the last verified checkpoint was
`next_page=3`, `page_size=25`, `page_size_source=resume_flag`,
`completeness=in_progress`, with 50 distinct stored records.

If further ingestion is explicitly authorized, first verify the current checkpoint,
provider quota, task image, and that no competing run is active. The ordinary
bounded resume is:

```text
sync-tango-subawards --commit --limit 25
```

Do not repeat `--resume-page-size 25` for an already migrated checkpoint, reset the
walk, or change its page size. The previously observed quota was 25 requests per
window; recheck it before execution. Verify the resulting checkpoint, distinct
identities, SyncRun, and INGESTION_METRIC after the bounded run. Schedules remain
disabled unless separately authorized.
