# District Nexus R4 — authenticated browser canary plan (post-deploy, authorization-gated)

Scope guard: this canary runs ONLY after the PR merges and ships to capiro-dev with explicit
authorization. It performs no writes, no ingestion, no flag mutations, and touches no prod
account. Read-only page loads only.

## Preconditions

1. PR merged + deployed; api/intel-api/web-vnext TDs rolled to the merge SHA (standard R4 ship
   path: three parallel arm64 buildx builds, registration scripts, digest checks).
2. Migration `20280908010000_tango_subaward_checkpoint_pagination` applied via
   `capiro-dev-api-migrate` (bare `["migrate"]`), re-pinned to the ship SHA first. Verify live
   columns: `SELECT column_name FROM information_schema.columns WHERE
   table_name='tango_subaward_sync_checkpoint' ORDER BY ordinal_position;` must now include
   `page_size`, `page_size_source`, `total_reported`.
3. Canopy tenant: `capiro-internal` (17b63099-bc0f-4ac5-b596-496161e9481e). Client: Anduril
   (`d1b0cb55-…` — the same client used for the FL-08 service-method canary).
4. All four ingestion schedules remain DISABLED; no further live ingestion in this canary.
5. Re-pin `c1-sql-master` to the ship image (standard post-ship cadence) for the evidence queries.

## Canary steps (authenticated browser session, os.capiro.ai)

User logs in with their own credentials; agent assists read-only. Surface:
`https://os.capiro.ai` → client Anduril → District Nexus → district FL-08.

1. **FL-08 GSA totals** — Federal Property panel:
   - `detailedAssetCount` 590 and `detailedSquareFeetTotal` 505,731 sq ft visible in the
     priority-intelligence panel (or the equivalent rendered totals).
   - Distinct from the service-method canary: here we verify the NUMBERS RENDER in the
     authenticated UI, not just that the service method returns them.
   - `recentChanges: 0` remains correct (all FL-08 ledger rows are first-publication baseline).

2. **Partial supplier coverage** — Federal Market panel:
   - The Subawards cell shows the supplier status; with the corpus at 25/2,743,636 the panel
     must show the partial-coverage wording — either "No matches in records ingested so far."
     (if Anduril has no matches in the 25 rows) or "Matches in records ingested so far" with
     the caption "District-resolved · records ingested so far" (if matches exist).
   - The note line must render `sourceCoverageNote`, e.g. "Subaward corpus sync is in
     progress: 25 records ingested so far of 2,743,636."
   - MUST NOT show a bare "real empty result" claim while completeness is in_progress.
   - Capture: the panel screenshot + the network response of
     `/api/intelligence/clients/<id>/district-nexus-v2/supplier-footprint/status` (check
     `sourceCompleteness`, `sourceCoverageNote`, `providerTotalRecords` fields present).

3. **Requested vs final CPF/CDS amounts** — Community Funding panel:
   - Amounts displayed must use the requested-vs-final distinction vocabulary (requested ≠
     enacted). Check both a House CPF and a Senate CDS entry render with their amount stage.
   - Capture: network response of the priority-intelligence endpoint showing `cpfCds` rows
     with `amountStage`-carrying fields.

4. **Statewide Senate labels** — CDS entries from Senate requests must carry the statewide
   label (statewide by construction unless a project district is source-backed). A
   state-attributed Senate project without the source-backed district must NOT appear as a
   district-resolved row.

5. **Source warnings** — the priority-intelligence panel renders `warnings` (e.g. the
   source-unknown boundary-Congress warning) — visible in the panel, not suppressed.

6. **Flag-off behavior** — with `district_nexus_supplier_footprint` disabled for a control
   tenant (or by inspecting the fail-closed path), the supplier surface must vanish entirely:
   - no "Supplier coverage" cell, no partial-coverage wording, no call to the supplier status
     endpoint in the network tab.
   - The 404-deny path (flag row absent) must also hide the surface (web treats it as denial).
   - This can be verified against a tenant where the flag is off; do NOT mutate flags to test.

## Evidence separation (report format)

- **Browser canary (this document):** authenticated UI rendering + network payloads — proves
  the deployed surface, not just service methods.
- **Service-method canary (already done 2026-09-08 on ship image):** FL-08 590/505,731 via
  `getClientDistrictPriorityIntelligence` in a Nest app context.
- **Unit/integration evidence (PR):** jest/vitest/migration rehearsal results in the PR body.
- These three classes stay distinct in the report; none substitutes for another.

## Bounded resume (post-canary, separate authorization)

If and only if the operator authorizes further ingestion, the exact recovery command for the
legacy checkpoint is:

```
aws ecs run-task \
  --cluster capiro-dev \
  --task-definition capiro-dev-api-sync-tango-subawards:<rev pinned to merge SHA> \
  --launch-type FARGATE \
  --network-configuration "$NETCFG" \
  --overrides '{"containerOverrides":[{"name":"api-sync-tango-subawards","command":["sync-tango-subawards","--commit","--limit","25","--resume-page-size","25"]}]}'
```

- `--resume-page-size 25` is the operator assertion that the 2026-09-08 first run walked at
  size 25 — evidence: its run log shows `pages=1, processed=25` with the request limit
  `min(100, 25) = 25` (log line `TANGO_SUBAWARD_SYNC_DONE … "pages":1`), and the checkpoint's
  `next_page=2` was written from that single 25-row page.
- The command persists `page_size=25, page_size_source='resume_flag'` on first checkpoint
  write, making all later resumes provable.
- Alternative if the operator declines the assertion: leave the legacy checkpoint untouched;
  run bounded fresh walks under a DIFFERENT filter (e.g. `--fiscal-year`) which lands on a
  different sync key, and the unfiltered corpus stays honestly `in_progress`/partial.
- Quota reality: 25 requests/window — keep `--limit` ≤ 25×page-size per run.
