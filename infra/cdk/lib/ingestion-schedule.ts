/**
 * Capiro ingestion schedule matrix — single source of truth for which sync job
 * runs when. Consumed by ComputeStack to create one EventBridge rule per job,
 * each firing the shared sync Fargate task with a command override (the
 * kebab-case name already wired in apps/api/scripts/entrypoint.sh).
 *
 * Cadence rationale lives in docs/plans/2026-06-01-...-schedule-matrix.md.
 * Times are UTC, staggered so SOURCES finish before DERIVED emitters, emitters
 * before EMBEDDINGS, and the lobby MV refresh runs after LDA.
 *
 * `command` is the argv passed to the container (entrypoint.sh dispatches on
 * argv[0]). Add `--since`-aware flags here only when the script reads them; the
 * SyncRun watermark handles incrementality for the rest.
 */

export interface ScheduledIngestionJob {
  /** Stable id (becomes the EventBridge rule + CDK construct id). */
  id: string;
  /** Container command argv (entrypoint.sh kebab name + optional flags). */
  command: string[];
  /** EventBridge cron. Use the 6-field AWS form via the `cron` helper below. */
  cron: { minute: string; hour: string; day?: string; month?: string; weekDay?: string };
  /** Human note for the rule description. */
  description: string;
  /** Tier for grouping/observability. */
  tier: 'daily' | 'weekly' | 'monthly' | 'derived' | 'embeddings' | 'agent';
  /**
   * Whether the EventBridge rule is created enabled. Defaults to `true` when
   * omitted (every existing job). Set `false` for a not-yet-safe capability
   * that must ship dark (R7) — e.g. an agentic writer awaiting its
   * kill-switch env var. This is a secondary/belt-and-braces layer: the
   * PRIMARY dark-by-default guarantee for such a job must ALSO be enforced
   * in the script's own code (see run-intel-workflows.ts's POSTURE), since
   * this flag only takes effect on the next `cdk deploy Compute` (see
   * infra_cdk_taskdef_drift memory — that deploy has its own risks).
   */
  enabled?: boolean;
}

// NOTE: AWS EventBridge cron requires exactly one of day-of-month / day-of-week
// to be '?'. The helpers below default the unused field to '?'.

export const INGESTION_JOBS: ScheduledIngestionJob[] = [
  // ── TIER 1 — DAILY sources ────────────────────────────────────────────────
  {
    id: 'SyncCongress',
    command: ['sync-congress'],
    cron: { minute: '0', hour: '6' },
    tier: 'daily',
    description: 'Congress bills/actions (daily, incremental)',
  },
  {
    id: 'SyncCbo',
    command: ['sync-cbo'],
    cron: { minute: '10', hour: '6' },
    tier: 'daily',
    description: 'CBO cost-estimate RSS discovery (daily — freshness is the product)',
  },
  {
    id: 'SyncCongressMembers',
    command: ['sync-congress-members'],
    cron: { minute: '20', hour: '5', weekDay: 'MON,THU' },
    tier: 'weekly',
    description: 'Canonical member roster + entity crosswalk (Mon+Thu — roster churn is slow)',
  },
  {
    id: 'SyncCommittees',
    command: ['sync-committees'],
    cron: { minute: '40', hour: '5', weekDay: 'MON,THU' },
    tier: 'weekly',
    description: 'Committee registry + membership rosters (Mon+Thu, CC0 dataset)',
  },
  // ── LegiStorm directory safe refresh (Phase 3 — ships DISABLED) ─────────────
  // Both rules run the SAME script and their crons CANNOT fire on the same day
  // (MON-SAT vs SUN), so Monday's incremental watermark follows Sunday's full
  // reconciliation. Created disabled for canary: enable MON-SAT first, then SUN,
  // and ONLY after the compromised LegiStorm key is rotated + the commit canary
  // passes (Phase 3 is blocked until then). Runs at 04:30 UTC, before
  // SyncCongressMembers (05:20), SyncCommittees (05:40), and SyncMemberPress (06:00).
  {
    id: 'SyncLegistormDirectory',
    command: ['sync-legistorm-directory', '--commit'],
    cron: { minute: '30', hour: '4', weekDay: 'MON-SAT' },
    tier: 'daily',
    description: 'LegiStorm directory incremental refresh (Mon-Sat 04:30 UTC, 48h overlap)',
    enabled: false,
  },
  {
    id: 'ReconcileLegistormDirectoryFull',
    command: ['sync-legistorm-directory', '--commit', '--full'],
    cron: { minute: '30', hour: '4', weekDay: 'SUN' },
    tier: 'weekly',
    description: 'LegiStorm directory full reconciliation (Sun 04:30 UTC)',
    enabled: false,
  },
  // ── LegiStorm Legislative Districts (WS-B) ──────────────────────────────────
  // Separate script, separate schedule, separate table — per the directory
  // runbook's "each new dataset gets its own script + schedule + retention"
  // rule. Full reconciliation every run (districts change only at
  // redistricting, no incremental window), so there is only ONE job, unlike
  // the directory's incremental/full pair. KML boundary fetch is a separate
  // opt-in flag (--with-kml), NOT part of this default command, so this job
  // does not hit www.legistorm.com.
  //
  // ⚠️ CDK↔LIVE DRIFT — READ BEFORE "FIXING" THIS.
  // `enabled: false` below does NOT describe reality. The live EventBridge
  // rule for this job is ENABLED and has been firing weekly (Sun 04:00 UTC);
  // 440 census_district rows carry synced_at 2026-07-01 from it. The rule was
  // turned on out-of-band and CDK was never updated to match, so this
  // declaration is stale, not authoritative.
  //
  // Do NOT "reconcile" that by deploying this stack. The drift is recorded
  // deliberately so nobody re-disables a live, working cron mid-project. The
  // same out-of-band pattern applies to ~10 ingestion secrets that exist on
  // the live task definition and not in CDK.
  //
  // The original gate on this job — rotation of the compromised LegiStorm key
  // — was cleared 2026-07-25. The key has been rotated, which also invalidated
  // any leaked vendor KML URLs (they embed the key).
  {
    id: 'SyncLegistormDistricts',
    command: ['sync-legistorm-districts', '--commit'],
    cron: { minute: '0', hour: '4', weekDay: 'SUN' },
    tier: 'weekly',
    description: 'LegiStorm legislative districts full reconciliation (Sun 04:00 UTC, before directory at 04:30)',
    enabled: false,
  },
  // ── District Nexus boundary artifacts (WS-D — ships DISABLED) ───────────────
  // Builds the browser-safe GeoJSON the map reads. Runs Sun 05:00 UTC, after
  // both the districts sync (04:00) and the directory refresh (04:30), because
  // the CURRENT rail stamps boundary metadata onto legislative_district rows
  // and should see a settled table.
  //
  // Ships DISABLED for two independent reasons, BOTH still open:
  //  1. [STILL OPEN — corrected 2026-07-26] The FUTURE ('F') rail reads each
  //     district's re-hosted kmlS3Key, which only `sync-legistorm-districts
  //     --commit --with-kml` populates. An earlier revision of this comment
  //     recorded that backfill as done; a live read on 2026-07-26 found
  //     kml_s3_key NULL on all 741 legislative_district rows, so it either
  //     never ran or did not persist. Until it does, the future rail
  //     legitimately produces zero features — run `--status=C` alone rather
  //     than letting the 'F' rail publish an empty artifact.
  //  2. [STILL OPEN] The first run should be a deliberate, reviewed `--commit`
  //     with its warnings read, not a cron tick. The CURRENT rail is verified:
  //     the live Census file yields 441/441 features with zero warnings at
  //     4.90 MB gzipped (measured 2026-07-24), inside the ~6 MB budget.
  //
  // Note the current rail now also refuses to publish below 400 districts /
  // 50 states, so a truncated Census download fails loudly instead of quietly
  // blanking the map.
  //
  // The current rail depends only on the keyless Census cartographic file, so
  // it is NOT blocked by the LegiStorm key rotation — `--status=C` can be run
  // on its own the moment someone wants the current map published.
  {
    id: 'BuildDistrictBoundaryArtifacts',
    command: ['build-district-boundary-artifacts', '--commit'],
    cron: { minute: '0', hour: '5', weekDay: 'SUN' },
    tier: 'weekly',
    description:
      'District Nexus boundary artifacts, current + future rails (Sun 05:00 UTC, after districts sync)',
    enabled: false,
  },
  // ── District Nexus redistricting alerts (WS-D3 — ships DISABLED) ────────────
  // Emits an intelligence_change row when an enacted-but-not-yet-effective
  // congressional map covers a district where a TRACKED CLIENT has a facility
  // — never a market-wide broadcast (the script skips any district with no
  // related client). Reads legislative_district + client_facilities only and
  // never calls the vendor API, so it carries no LEGISTORM_API_KEY dependency.
  //
  // Sun 05:30 UTC: after the districts sync (04:00) that supplies its 'F' rows,
  // the directory refresh (04:30), and the boundary build (05:00), so it reads
  // a fully settled table. It does not actually depend on the 05:00 artifact —
  // it reads only effective/enacted dates and district identity — but running
  // last keeps the whole Sunday LegiStorm chain in one ordered block.
  //
  // Ships DISABLED per house convention: this is a brand-new automated write
  // path into intelligence_change that has never run in prod, so its first run
  // should be a deliberate, reviewed invocation whose emitted/skipped counts
  // someone actually reads — the same bar EmitCommitteeChanges is held to.
  {
    id: 'EmitRedistrictingAlerts',
    command: ['emit-redistricting-alerts'],
    cron: { minute: '30', hour: '5', weekDay: 'SUN' },
    tier: 'weekly',
    description:
      'Redistricting alerts for districts where a tracked client has a facility (Sun 05:30 UTC, after districts sync)',
    enabled: false,
  },
  // ── LegiStorm Privately Funded Travel (WS-F — ships DISABLED) ───────────────
  // Same base URL / same blocker as the directory jobs above (compromised key
  // pending rotation). Incremental like the directory job's staff/offices
  // window — NOT a full-reconciliation job like WS-B's districts, since
  // trips have no retired-ids endpoint and an incremental fetch must never
  // attempt to reconcile deletions. Runs after the directory refresh
  // (04:30) so a member added same-day is already resolvable for
  // denormalization if ever needed.
  {
    id: 'SyncLegistormTrips',
    command: ['sync-legistorm-trips', '--commit'],
    cron: { minute: '0', hour: '5', weekDay: 'MON-SAT' },
    tier: 'daily',
    description: 'LegiStorm privately funded travel incremental refresh (Mon-Sat 05:00 UTC, 48h overlap)',
    enabled: false,
  },
  {
    id: 'ReconcileLegistormTripsFull',
    command: ['sync-legistorm-trips', '--commit', '--full'],
    cron: { minute: '0', hour: '5', weekDay: 'SUN' },
    tier: 'weekly',
    description: 'LegiStorm privately funded travel full reconciliation (Sun 05:00 UTC)',
    enabled: false,
  },
  {
    id: 'SyncHouseVotes',
    command: ['sync-house-votes'],
    cron: { minute: '5', hour: '0/6' },
    tier: 'daily',
    description: 'House roll-call votes (LegiWatch A1, every 6h — floor outcomes)',
  },
  {
    id: 'SyncSenateVotes',
    command: ['sync-senate-votes'],
    cron: { minute: '15', hour: '0/6' },
    tier: 'daily',
    description: 'Senate roll-call votes via LIS XML (LegiWatch A1, every 6h)',
  },
  {
    id: 'DeriveBillStatus',
    command: ['derive-bill-status'],
    cron: { minute: '40', hour: '0/6' },
    tier: 'derived',
    description:
      'Canonical congress_bill.status from actions + votes + rule links (after the vote syncs)',
  },
  {
    id: 'SyncFederalRegister',
    command: ['sync-federal-register'],
    cron: { minute: '15', hour: '6' },
    tier: 'daily',
    description: 'Federal Register documents (daily)',
  },
  // ── State Rules & Agency Watch (Phase 1 M3.2) — FL FAR only for v1; the
  // other 7 priority states need their own feasibility spike (CA is
  // spike-confirmed NOT feasible — PDF-only, no structured feed).
  {
    id: 'SyncStateRegisterFl',
    command: ['sync-state-register'],
    cron: { minute: '45', hour: '6' },
    tier: 'daily',
    description:
      'Florida Administrative Register notices (daily). Defaults to FL (the only registered adapter) when STATE_REGISTER_STATES is unset — no env needed. Set STATE_REGISTER_STATES out-of-band only to narrow/expand the state set as more adapters ship. Writes only the global public feed (no tenant data).',
  },
  {
    id: 'SyncRegulations',
    command: ['sync-regulations'],
    cron: { minute: '30', hour: '6' },
    tier: 'daily',
    description: 'Regulations.gov dockets (daily)',
  },
  {
    id: 'SyncHearings',
    command: ['sync-hearings'],
    cron: { minute: '45', hour: '6' },
    tier: 'daily',
    description: 'Committee hearings (daily)',
  },
  {
    id: 'SyncRssIntel',
    command: ['sync-rss-intel'],
    cron: { minute: '0', hour: '0/6' },
    tier: 'daily',
    description: 'RSS intel news (every 6h)',
  },
  {
    id: 'SyncFec',
    command: ['sync-fec'],
    cron: { minute: '0', hour: '7' },
    tier: 'daily',
    description: 'FEC contributions (daily)',
  },
  {
    id: 'SyncFecPac',
    command: ['sync-fec-pac'],
    cron: { minute: '20', hour: '7' },
    tier: 'daily',
    description: 'FEC PAC (Schedule B) giving (daily)',
  },
  {
    id: 'SyncFederalAward',
    command: ['sync-federal-award'],
    cron: { minute: '40', hour: '7' },
    tier: 'daily',
    description: 'USAspending federal awards (daily)',
  },
  {
    id: 'SyncSamOpportunities',
    command: ['sync-sam-opportunities'],
    cron: { minute: '50', hour: '7' },
    tier: 'daily',
    description: 'SAM.gov DoD contract opportunities (daily, incremental)',
  },
  {
    id: 'EnrichAwardDistricts',
    command: ['enrich-award-districts'],
    cron: { minute: '0', hour: '8' },
    tier: 'daily',
    description: 'Award district enrichment (after awards)',
  },
  // ── District Nexus assistance awards ───────────────────────────────────────
  //
  // ⚠️ CDK↔LIVE DRIFT — READ BEFORE "FIXING" THIS.
  // `enabled: false` below does NOT describe reality. Both live EventBridge
  // rules were HAND-CREATED 2026-07-27 and are ENABLED:
  //   capiro-dev-sync-federal-assistance-awards  cron(20 11 * * ? *)
  //   capiro-dev-enrich-assistance-awards        cron(50 11 * * ? *)
  // Each had one verified manual run that day (4 inserted / 32 updated, and
  // 499 updated respectively). The crons below have been updated to MATCH live;
  // the `enabled: false` is kept deliberately, exactly as for
  // SyncLegistormDistricts above.
  //
  // Do NOT "reconcile" this by deploying the Compute stack — CloudFormation
  // holds dead-ALB values for the app.capiro.ai Route53 records and a failed
  // deploy repeats the 2026-07-25 seven-minute prod DNS outage. Flipping these
  // to `enabled: true` would also make a future deploy try to take over rules
  // that already exist out-of-band.
  //
  // Original gate (Phase 1 canary volume approval, district-nexus-grants-mcp-
  // plan.md §10) was cleared by audit finding F6: the rails were merged but
  // never operating, so 239,114 assistance awards sat frozen at 2026-07-26.
  //
  // KNOWN LIMITATION on EnrichAssistanceAwards: default --limit 500/run against
  // 238,619 unenriched rows is ~478 days to clear the backlog. The daily cadence
  // correctly absorbs NEW arrivals; the backlog needs a separate bounded
  // backfill (--limit 50000 is ~4.2h/run at DELAY_MS=300).
  {
    id: 'SyncFederalAssistanceAwards',
    command: ['sync-federal-assistance-awards', '--days', '7'],
    cron: { minute: '20', hour: '11' },
    tier: 'daily',
    description: 'USAspending financial assistance awards, all agencies (daily 11:20 UTC, after contracts 09:50 and grants 10:00)',
    enabled: false,
  },
  {
    id: 'EnrichAssistanceAwards',
    command: ['enrich-assistance-awards'],
    cron: { minute: '50', hour: '11' },
    tier: 'daily',
    description: 'Assistance award detail enrichment (daily 11:50 UTC, 30min after its own upstream sync)',
    enabled: false,
  },

  // ── TIER 2 — WEEKLY ───────────────────────────────────────────────────────
  {
    id: 'SyncLda',
    command: ['sync-lda'],
    cron: { minute: '0', hour: '5', weekDay: 'MON' },
    tier: 'weekly',
    description: 'LDA lobbying filings (weekly Mon)',
  },
  {
    id: 'SyncOpenlobby',
    command: ['sync-openlobby'],
    cron: { minute: '30', hour: '5', weekDay: 'MON' },
    tier: 'weekly',
    description: 'OpenLobby derived intel (weekly Mon)',
  },
  {
    id: 'SyncFara',
    command: ['sync-fara'],
    cron: { minute: '0', hour: '6', weekDay: 'MON' },
    tier: 'weekly',
    description: 'FARA registrations (weekly Mon)',
  },
  {
    id: 'SyncFaraEnrichment',
    command: ['sync-fara-enrichment', '--commit'],
    cron: { minute: '20', hour: '6', weekDay: 'MON' },
    tier: 'weekly',
    description: 'FARA foreign-principal enrichment from FARA_FP_SOURCE_URL (after FARA sync)',
  },
  {
    id: 'SyncGao',
    command: ['sync-gao'],
    cron: { minute: '30', hour: '6', weekDay: 'MON' },
    tier: 'weekly',
    description: 'GAO reports (weekly Mon)',
  },
  {
    id: 'SyncCrs',
    command: ['sync-crs'],
    cron: { minute: '0', hour: '7', weekDay: 'MON' },
    tier: 'weekly',
    description: 'CRS reports (weekly Mon)',
  },
  {
    id: 'SyncGrants',
    command: ['sync-grants'],
    cron: { minute: '30', hour: '7', weekDay: 'MON' },
    tier: 'weekly',
    description: 'Federal grants (weekly Mon)',
  },
  // ── District Nexus Workstream C ────────────────────────────────────────────
  //
  // ⚠️ CDK↔LIVE DRIFT — READ BEFORE "FIXING" THIS.
  // `enabled: false` below does NOT describe reality. Both live EventBridge
  // rules were HAND-CREATED 2026-07-27 and are ENABLED:
  //   capiro-dev-sync-grants-reconcile   cron(25 8 ? * SUN *)
  //   capiro-dev-enrich-grant-details    cron(45 10 * * ? *)
  // Crons below updated to MATCH live; `enabled: false` kept deliberately.
  // Same rationale as SyncLegistormDistricts and the assistance pair above —
  // never deploy the Compute stack (2026-07-25 prod DNS outage).
  //
  // Schedules differ from the original plan's proposals for a measured reason:
  // it proposed 10:30 for EnrichGrantDetails, but that slot already holds
  // enrich-award-districts AND pe-derive-chain, and :30 is hourly-busy
  // (sync-legiscan-bills). It proposed Sun 09:00 for the reconcile, but 09:00
  // holds emit-changes-daily AND sync-congress, and :00 is hourly-busy
  // (emit-clio-alerts).
  //
  // SyncGrantsReconcile: the old note here said MAX_PAGES=100 caps a run at
  // 10,000 upserts, "12% per run, ~8 Sundays to walk the corpus". That was
  // WRONG and the walk could never advance: sync-grants.ts sent `offset`, but
  // search2's pagination parameter is `startRecordNum` and it silently ignores
  // unknown keys, so every page of every run re-read the same first 100
  // records. Measured 2026-07-28: a 100-page run "upserted 10,000" while
  // federal_grant grew 852 -> 864 (+12) against hitCount ~83,000.
  // Fixed: correct parameter, MAX_PAGES 100 -> 1000, plus a --from-page flag so
  // a capped walk can resume. A page costs ~0.8s, so the full ~830-page corpus
  // is one ~11-minute run. It still reports success_with_errors on genuine cap
  // exhaustion, which is honest incompleteness, not an alarm.
  {
    id: 'SyncGrantsReconcile',
    command: ['sync-grants', '--all-statuses'],
    cron: { minute: '25', hour: '8', weekDay: 'SUN' },
    tier: 'weekly',
    description:
      'Grants.gov all-status reconcile — re-sees closed/archived opportunities the posted|forecasted pass cannot (weekly Sun 08:25 UTC)',
    enabled: false,
  },
  {
    id: 'EnrichGrantDetails',
    command: ['enrich-grant-details'],
    cron: { minute: '45', hour: '10' },
    tier: 'daily',
    description: 'Grants.gov fetchOpportunity detail enrichment (daily 10:45 UTC, 45min after the opportunity sync)',
    enabled: false,
  },
  // ── District Nexus F3 producer (audit remediation phase i3, B3) ─────────────
  //
  // Deterministic relevance producer for client_grant_nexus
  // 'opportunity_candidate' rows. Both preconditions this entry used to block
  // on are now addressed IN CODE (2026-07-27):
  //   1. The per-(client, grant) findFirst is batched into one findMany per
  //      client (was 780-960ms/client for 567 sequential findFirst calls
  //      against capiro-internal, now ~4-6ms) — see
  //      generate-grant-opportunity-candidates.ts.
  //   2. A 5-column unique index (migration
  //      20260806010000_client_grant_nexus_producer_unique) closes the
  //      concurrent-double-run duplicate-row risk.
  // BOTH are now live (verified 2026-07-28): the migration IS applied and
  // client_grant_nexus_producer_unique_idx exists in capiro-dev, and the live
  // rule capiro-dev-generate-grant-opportunity-candidates is ENABLED at
  // cron(35 11 * * ? *) with a target verified structurally identical to a
  // known-good rule. An earlier version of THIS comment claimed the migration
  // was unapplied; it was already applied, and that stale claim propagated into
  // the closeout runbook and matrix before being caught. Do not record live
  // database state in a code comment — query _prisma_migrations.
  // As with every entry in this file, enabled:true here is a declared desired
  // state, not a deploy; EventBridge rules are managed out-of-band
  // (`aws events put-rule`/`enable-rule`), never via `cdk deploy
  // Capiro-dev-Compute` (see the hard boundary on that stack).
  //
  // Also note the producer only lights up F3. F4's seven award-bearing
  // relationship types have NO producer and no entry UI — reviewer-entered by
  // design, so F4 stays dark regardless of this job.
  {
    id: 'GenerateGrantOpportunityCandidates',
    command: ['generate-grant-opportunity-candidates', '--commit'],
    cron: { minute: '35', hour: '11' },
    tier: 'daily',
    description:
      'District Nexus F3: deterministic opportunity_candidate producer (daily 11:35 UTC, after the assistance sync at 11:20 supplies prior ALNs)',
    enabled: true,
  },
  {
    id: 'SyncOpenstates',
    command: ['sync-openstates'],
    cron: { minute: '0', hour: '8', weekDay: 'MON' },
    tier: 'weekly',
    description:
      'State legislators/committees only (weekly Mon) — LegiScan is the bill spine now (DD2)',
  },
  {
    id: 'NormalizeStateCommittees',
    command: ['normalize-state-committees'],
    cron: { minute: '30', hour: '8', weekDay: 'MON' },
    tier: 'weekly',
    description:
      'Roster normalization (Phase 1 M2.2) — state_legislator.committees Json into state_committee/state_committee_membership rows, after sync-openstates',
  },
  // ── State Legislation Platform (Phase 0 S1) — LegiScan bill spine ─────────
  // Priority-state vs wide-sweep masterlist rules share `command`; the actual
  // LEGISCAN_STATES env split is applied on the rule's containerOverrides
  // out-of-band (the PE_ALERT_EMAIL_TENANTS trick — flips without a task-def
  // revision, docs/runbooks/out-of-band-ingestion-deploy.md). 2026-07-10
  // hot-fix (W1.2): ALSO set a distinct LEGISCAN_MASTERLIST_SOURCE_SUFFIX
  // out-of-band per rule (e.g. `priority` / `wide`) so the two schedules
  // record SEPARATE sync_run rows — before this, both wrote
  // source='sync-legiscan-masterlist', so a slow wide-sweep run could make
  // the priority rule's skipIfRunning guard falsely no-op (and vice versa),
  // and per-schedule health was indistinguishable in diag-ingestion-health.
  {
    id: 'SyncLegiscanMasterlist',
    command: ['sync-legiscan-masterlist'],
    cron: { minute: '10', hour: '*' },
    tier: 'daily',
    description:
      'LegiScan change_hash diff, priority states hourly (set LEGISCAN_STATES=FL,CA,TX,NY,IL,MA,GA,VA + LEGISCAN_MASTERLIST_SOURCE_SUFFIX=priority out-of-band)',
  },
  {
    id: 'SyncLegiscanMasterlistWide',
    command: ['sync-legiscan-masterlist'],
    cron: { minute: '25', hour: '1/6' },
    tier: 'daily',
    description:
      'LegiScan change_hash diff, remaining 43 states every 6h (set LEGISCAN_STATES=<other 43> + LEGISCAN_MASTERLIST_SOURCE_SUFFIX=wide out-of-band)',
  },
  {
    id: 'SyncLegiscanBills',
    command: ['sync-legiscan-bills'],
    cron: { minute: '30', hour: '*' },
    tier: 'daily',
    description:
      'LegiScan getBill drain of the change queue (quota-governed, LEGISCAN_MONTHLY_BUDGET)',
  },
  {
    id: 'DeriveStateBillStatus',
    command: ['derive-state-bill-status'],
    cron: { minute: '50', hour: '0/6' },
    tier: 'derived',
    description:
      'Canonical state_bill.status from actions + votes + session calendars (after the LegiScan drains)',
  },
  {
    id: 'EmitStateChanges',
    command: ['emit-state-changes'],
    cron: { minute: '55', hour: '0/6' },
    tier: 'derived',
    description:
      'intelligence_change rows for material state_bill status transitions (dashboard/changes-inbox rail, DD4) — after derive-state-bill-status',
  },
  {
    id: 'CrosswalkStatePeople',
    command: ['crosswalk-state-people'],
    cron: { minute: '20', hour: '5' },
    tier: 'daily',
    description:
      'Ongoing OpenStates↔LegiScan people crosswalk (S2) — stamps state_legislator.legiscan_people_id via getSessionPeople so newly-ingested/renamed legislators link to their sponsored bills. The one-time backfill left coverage frozen (sync-legiscan-bills never re-crosswalks); without this a legislator reads "no sponsored bills". Quota-cheap (~1 query/active session). Needs LEGISCAN_API_KEY.',
  },
  // Phase 1 M5.1 — Tier-2 agentic worker (targeting-brief mode). Staggered a
  // full hour after the 0/6 derive-chain cycle (derive-bill-status :40,
  // derive-state-bill-status :50, emit-state-changes :55) so chokepoint/
  // status truth is fresh before the worker reads it.
  //
  // 2026-07-10 hot-fix (R7, W1.2): created DISABLED. `--commit` stays in the
  // command (harmless — the script's own POSTURE logic additionally requires
  // INTEL_WORKFLOWS_TARGETING_ENABLED before it will ever write a cross-realm
  // row; see run-intel-workflows.ts) but the rule itself ships dark as a
  // second, independent layer. To go live: (1) confirm the M5-B anti-
  // fabrication gates (Wave 3) have landed, (2) set
  // INTEL_WORKFLOWS_TARGETING_ENABLED=true on the sync-jobs task out-of-band
  // (do not `cdk deploy Compute` for this alone — infra_cdk_taskdef_drift),
  // (3) enable this rule (an `aws events enable-rule` targeting
  // `capiro-<env>-run-intel-workflows`, or flip `enabled` here and redeploy
  // Compute once a Compute deploy is happening anyway for another reason).
  {
    id: 'RunIntelWorkflows',
    command: ['run-intel-workflows', '--commit'],
    cron: { minute: '10', hour: '1,7,13,19' },
    tier: 'derived',
    enabled: false,
    description:
      'Tier-2 agentic worker (M5.1/M5.2 targeting-brief) — polls recent high-severity bill/state_bill alerts, one hour after the derive chain. DARK by default (see comment above) — requires INTEL_WORKFLOWS_TARGETING_ENABLED + this rule enabled to ever surface a brief.',
  },
  // ── District Impact Engine (Phase 1 M1) ────────────────────────────────────
  {
    id: 'GeocodeFacilities',
    command: ['geocode-facilities'],
    cron: { minute: '15', hour: '4' },
    tier: 'daily',
    description:
      'Census Geocoder backfill for client facilities (keyless, low volume — federal CD + both state legislative chambers in one call per facility)',
  },
  {
    id: 'SyncSecEdgar',
    command: ['sync-sec-edgar'],
    cron: { minute: '30', hour: '8', weekDay: 'MON' },
    tier: 'weekly',
    description: 'SEC EDGAR filings (weekly Mon)',
  },
  // Every ~3 days at 06:00 UTC (~2am ET; 1am EST in winter). Live rule `capiro-dev-sync-member-press` created out-of-band — see docs/plans/member-press-feed-ingestion.md.
  {
    id: 'SyncMemberPress',
    command: ['sync-member-press', '--commit'],
    cron: { minute: '0', hour: '6', day: '1/3' },
    tier: 'weekly',
    description: 'Member press/RSS items for the directory News tab (every 3 days ~02:00 ET)',
  },
  {
    id: 'SyncPeoRosters',
    command: ['sync-peo-rosters'],
    cron: { minute: '0', hour: '9', weekDay: 'TUE' },
    tier: 'weekly',
    description: 'PEO rosters (weekly Tue)',
  },
  {
    id: 'SyncDodOrgcharts',
    command: ['sync-dod-orgcharts'],
    cron: { minute: '30', hour: '9', weekDay: 'TUE' },
    tier: 'weekly',
    description: 'DoD org charts (weekly Tue)',
  },
  {
    id: 'SyncDodPressPersonnel',
    command: ['sync-dod-press-personnel'],
    cron: { minute: '0', hour: '10', weekDay: 'TUE' },
    tier: 'weekly',
    description: 'DoD press personnel (weekly Tue)',
  },
  {
    id: 'ExtractPressPersonnel',
    command: ['extract-press-personnel'],
    cron: { minute: '30', hour: '10', weekDay: 'TUE' },
    tier: 'weekly',
    description: 'Press-release personnel NER (after press sync)',
  },
  {
    id: 'ExtractGaoInterviewees',
    command: ['extract-gao-interviewees'],
    cron: { minute: '0', hour: '11', weekDay: 'TUE' },
    tier: 'weekly',
    description: 'GAO interviewees (after GAO sync)',
  },
  {
    id: 'ExtractHearingWitnesses',
    command: ['extract-hearing-witnesses'],
    cron: { minute: '30', hour: '11', weekDay: 'TUE' },
    tier: 'weekly',
    description: 'Hearing witnesses (after hearings sync)',
  },
  {
    id: 'SyncSamPersonnel',
    command: ['sync-sam-personnel'],
    cron: { minute: '0', hour: '12', weekDay: 'TUE' },
    tier: 'weekly',
    description: 'SAM.gov solicitation personnel (weekly Tue)',
  },

  // ── TIER 3 — MONTHLY (1st of month) ───────────────────────────────────────
  {
    id: 'SyncBea',
    command: ['sync-bea'],
    cron: { minute: '0', hour: '4', day: '1' },
    tier: 'monthly',
    description: 'BEA economic series (monthly)',
  },
  {
    id: 'SyncBls',
    command: ['sync-bls'],
    cron: { minute: '30', hour: '4', day: '1' },
    tier: 'monthly',
    description: 'BLS series (monthly)',
  },
  {
    id: 'SyncCensus',
    command: ['sync-census'],
    cron: { minute: '0', hour: '5', day: '1' },
    tier: 'monthly',
    description: 'Census district refs (monthly)',
  },
  {
    id: 'SyncOpenspending',
    command: ['sync-openspending'],
    cron: { minute: '30', hour: '5', day: '1' },
    tier: 'monthly',
    description: 'Agency/contractor/industry refs (monthly)',
  },
  {
    id: 'SyncCpeRoster',
    command: ['sync-cpe-roster'],
    cron: { minute: '0', hour: '6', day: '1' },
    tier: 'monthly',
    description: 'CPE roster (monthly)',
  },
  {
    id: 'ImportDowDirectory',
    command: ['import-dow-directory'],
    cron: { minute: '30', hour: '6', day: '1' },
    tier: 'monthly',
    description: 'Stanford DoW directory (monthly)',
  },
  {
    id: 'SyncLobbyTrending',
    command: ['sync-lobby-trending'],
    cron: { minute: '0', hour: '7', day: '1' },
    tier: 'monthly',
    description: 'Lobby trending topics recompute (monthly)',
  },

  // ── TIER 5 — DERIVED / EMITTERS (daily, after sources) ────────────────────
  // UPDATED 2026-07-10 (was a stale LIVE-DRIFT WARNING dated 2026-06-07): this
  // matrix IS consumed by a live CDK construct — `ScheduledIngestionJobs`
  // (infra/cdk/lib/constructs/scheduled-ingestion-jobs.ts), instantiated from
  // ComputeStack (compute-stack.ts) with `jobs: INGESTION_JOBS` — every entry
  // below (derived or otherwise) becomes a real EventBridge rule + Fargate
  // command override on the next `cdk deploy Compute`. Adding a new entry
  // here, or flipping an existing entry's `enabled` flag, DOES change what
  // fires in prod. See infra_cdk_taskdef_drift (memory) before running that
  // deploy: it can drop out-of-band task-def secrets/env — apply schedule-only
  // changes out-of-band (a targeted `aws events` CLI call) when possible
  // rather than a full stack deploy. Historical note: an orphan legacy rule
  // (`capiro-dev-emit-changes-daily`, dead `EventsServiceRole`) was cleaned up
  // separately; see apps/api/reports/changes-inbox-emit-changes-role-2026-06-07.md
  // for that incident's write-up.
  {
    id: 'ExtractBillPeCodes',
    command: ['extract-bill-pe-codes'],
    cron: { minute: '0', hour: '9' },
    tier: 'derived',
    description: 'Bill<->PE linkage (after congress)',
  },
  {
    id: 'RefreshLobbyIntelMv',
    command: ['refresh-lobby-intel-mv'],
    cron: { minute: '30', hour: '9' },
    tier: 'derived',
    description: 'Lobby intel MV refresh (after LDA/openlobby)',
  },
  // ── Track B — knowledge-graph edge cache (daily, after the money/lobby syncs) ─
  // Rebuilds the materialized kg_edge_cache (aggregated FEC money-flow + LDA
  // lobbying + tenant overlays) so the scoped graph traversal reads fresh
  // relationships without anyone running the manual refresh. Runs at 09:45 UTC —
  // AFTER the daily FEC/award/SAM syncs (07:00–08:00) and the lobby MV refresh
  // (09:30), so a day's new contributions/filings are present before we
  // re-aggregate. refresh_kg_edge_cache() is advisory-locked + idempotent; the
  // SyncRun wrapper adds the run-ledger row + the INGESTION_METRIC line the
  // failure alarm already watches. DARK-safe: nothing reads the cache until
  // KG_TRAVERSAL_SOURCE=cache, but keeping it fresh from day one means the flip
  // is instant when it comes.
  {
    id: 'RefreshKgEdgeCache',
    command: ['refresh-kg-edge-cache'],
    cron: { minute: '45', hour: '9' },
    tier: 'derived',
    description: 'Knowledge-graph edge cache refresh (after FEC/LDA/lobby syncs)',
  },
  {
    id: 'EmitChanges',
    command: ['emit-changes'],
    cron: { minute: '0', hour: '10' },
    tier: 'derived',
    description: 'IntelligenceChange emitter (after sources)',
  },
  {
    id: 'EmitBillAlerts',
    command: ['emit-bill-alerts'],
    cron: { minute: '20', hour: '10' },
    tier: 'derived',
    description: 'Per-bill stage alerts (after bill-PE link)',
  },
  {
    id: 'CheckCommentPeriods',
    command: ['check-comment-periods'],
    cron: { minute: '40', hour: '10' },
    tier: 'derived',
    description: 'Reg comment-period alerts (after regulations)',
  },
  // Client-profile Tracker tab: detect material moves on tracked bills, then
  // deliver realtime alerts + bucket digests. Runs after the congress sync +
  // bill emitters so the latest action is in the DB.
  //
  // CADENCE: every 6h (00/06/12/18 UTC) so realtime alerts trail an action by
  // hours, not up to a day. Safe to run often — the detector is idempotent
  // (NotificationLog claim + IntelligenceChange dedupe) and the catch-up scan
  // (TRACKER_SCAN_ACTION_HISTORY) emits only moves newer than each bill's
  // snapshot, so extra runs never double-send and never drop intermediate moves.
  //
  // The LIVE rule is still out-of-band (`capiro-dev-detect-tracker-alerts`, cron
  // 0 12) — this matrix isn't consumed by CDK yet (see live-drift warning above).
  // To adopt the 6h cadence now, update the live rule out-of-band:
  //   aws events put-rule --name capiro-dev-detect-tracker-alerts \
  //     --schedule-expression 'cron(0 0/6 * * ? *)'
  // A transient overlap with a future CDK-created rule is harmless (idempotent).
  {
    id: 'DetectTrackerAlerts',
    command: ['detect-tracker-alerts'],
    cron: { minute: '0', hour: '0/6' },
    tier: 'derived',
    description:
      'Tracker: tracked-bill change detection + email/SMS fan-out (every 6h, after congress)',
  },
  {
    id: 'FlushTrackerDigestsDaily',
    command: ['flush-tracker-digests', '--cadence', 'daily'],
    cron: { minute: '30', hour: '12' },
    tier: 'derived',
    description: 'Tracker: daily alert digest flush (~8am ET)',
  },
  {
    id: 'FlushTrackerDigestsWeekly',
    command: ['flush-tracker-digests', '--cadence', 'weekly'],
    cron: { minute: '45', hour: '12', weekDay: 'MON' },
    tier: 'weekly',
    description: 'Tracker: weekly alert digest flush (Mon ~8am ET)',
  },
  // ⚠️ THE THREE JOBS ABOVE ARE THE **LEGACY apps/api** TRACKER RAIL. The
  // intel-api rail has its own separate, live schedule that is NOT in this
  // matrix — read this before concluding intel-api alerts "aren't scheduled".
  //
  // Every entry in INGESTION_JOBS runs on `syncJobsTaskDef`, which is built
  // from the **apps/api image** and dispatched by apps/api/scripts/
  // entrypoint.sh. It therefore CANNOT express an intel-api task-runner verb:
  // adding e.g. `command: ['flush-digests', 'daily']` here would start a
  // container whose entrypoint has no such arm and die on "Unknown command".
  // (That mistake was made and reverted during the P0-02 work — don't repeat it.)
  //
  // intel-api's verbs (`node dist/tasks/task-runner.js <verb>`, registered in
  // apps/intel-api/src/tasks/task-runner.ts KNOWN_VERBS) are scheduled by
  // OUT-OF-BAND EventBridge rules targeting the `capiro-<env>-intel-api-enableflag`
  // task def with a `["task", "<verb>", ...]` containerOverride. Verified live on
  // 2026-07-26 (all ENABLED, cluster capiro-dev):
  //   capiro-dev-emit-bill-alerts            cron(20 0/6 * * ? *)   task emit-bill-alerts
  //   capiro-dev-flush-intel-digests-daily   cron(30 12 * * ? *)    task flush-digests daily
  //   capiro-dev-flush-intel-digests-weekly  cron(45 12 ? * MON *)  task flush-digests weekly
  //
  // Note the near-identical names hiding DIFFERENT tables/services:
  //   flush-tracker-digests (above) → apps/api TrackerAlertService → `alert_digest_queue`
  //   flush-digests (intel-api)     → IntelAlertService            → `intel_alert_digest_queue`
  // Both are scheduled at the same 12:30/12:45 slots and neither supersedes the
  // other; they drain independent queues.
  //
  // These rules are deliberately NOT declared here (this matrix cannot target a
  // second task def). Treat the live rules as source of truth — same
  // out-of-band posture as the ~10 ingestion secrets and the
  // SyncLegistormDistricts drift documented above.
  //
  // OPERATIONAL NOTE: all three intel-api task defs pull `intel-api:latest`, so
  // the verb runner picks up a newly-pushed image at its NEXT tick with no
  // `update-service` step and no deploy gate. A schema-dependent change must
  // therefore have its migration applied (run-task on
  // `capiro-<env>-intel-api-migrate`, which CI does NOT do automatically —
  // no workflow references `migrate`) BEFORE the image lands, or the next tick
  // runs new code against an old schema.
  {
    id: 'ComputeHealthScores',
    command: ['compute-health-scores'],
    cron: { minute: '0', hour: '11' },
    tier: 'derived',
    description: 'Health scores (after emit-changes)',
  },
  {
    id: 'GenerateBriefings',
    command: ['generate-briefings'],
    cron: { minute: '30', hour: '11' },
    tier: 'derived',
    description: 'Briefings (after changes + health)',
  },
  {
    id: 'RecomputeConferenceProbability',
    command: ['recompute-conference-probability'],
    cron: { minute: '50', hour: '11' },
    tier: 'derived',
    description: 'PE conference probability recompute',
  },

  // ── TIER 6 — EMBEDDINGS (daily, last) ─────────────────────────────────────
  // NOTE: embed-backfill has its own dedicated task def + rule already wired in
  // compute-stack.ts (Phase 1). It is intentionally NOT in this list to avoid a
  // duplicate rule; it runs at 13:00 UTC via EmbedBackfillDailyRule.

  // ── TIER 7 — AGENT (Meri self-scheduled tasks) ────────────────────────────
  // Drains DUE rows in clio_scheduled_task (Meri's `schedule_task` tool writes
  // them) and delivers each result to the in-app inbox (clio_proactive_alert).
  // Runs hourly; the runner enforces a 60-min minimum cadence per task, so an
  // hourly drain is the finest granularity any task can actually use. Reuses the
  // shared migrate task def (has ANTHROPIC_API_KEY + CLIO_* runtime env). The
  // live rule is `capiro-dev-run-clio-scheduled-tasks` (created out-of-band;
  // this matrix is not yet consumed by a CDK construct — see warning above).
  {
    id: 'RunClioScheduledTasks',
    command: ['run-clio-scheduled-tasks', '--commit'],
    cron: { minute: '15', hour: '*' },
    tier: 'agent',
    description: 'Meri self-scheduled research tasks (hourly drain of clio_scheduled_task)',
  },

  // ── TIER 8 — INSTITUTIONAL MEMORY (daily, off-peak) ───────────────────────
  // Rebuilds the memory knowledge graph + embeddings for every tenant so the
  // graph reflects new clients/memories/meetings/emails/Meri sessions without
  // anyone clicking "Populate graph". Idempotent (stable slugs + content-hash
  // embedding skip); the embedding pass fails open, so a Bedrock hiccup never
  // fails the rebuild. Runs on the shared api-sync-jobs task def + apiTaskRole
  // (same Aurora + embedding access as every other job here).
  {
    id: 'RefreshMemoryGraph',
    command: ['refresh-memory-graph', '--all-tenants'],
    cron: { minute: '30', hour: '4' },
    tier: 'daily',
    description: 'Rebuild institutional memory graph + embeddings (all tenants, off-peak)',
  },

  // ── TIER 9 — PROACTIVE ALERTS (Chief-of-Staff behaviors) ──────────────────
  // Both verbs existed and were registered in entrypoint.sh with no rule ever
  // created (2026-07-12 blueprint-gap audit finding: "built but not
  // scheduled"). Write-only to in-app surfaces (clio_proactive_alert /
  // meeting-brief inbox) — no external email/SMS, so this is a low-risk flip.
  // Live rules created out-of-band the same way as RefreshMemoryGraph/
  // RunClioScheduledTasks above (this matrix isn't consumed by CDK yet).
  {
    id: 'EmitClioAlerts',
    command: ['emit-clio-alerts'],
    cron: { minute: '0', hour: '*' },
    tier: 'agent',
    description:
      'Quiet-client (30d) + meeting-prep-missing (48h) proactive alerts, all active tenants, hourly (replaces the removed in-chat generateProactiveAlerts trigger)',
  },
  {
    id: 'GenerateMeetingBriefings',
    command: ['generate-meeting-briefings'],
    cron: { minute: '0', hour: '12' },
    tier: 'daily',
    description:
      'P2-8: once-daily digest of newly-upcoming meetings (7d lookahead) into the in-app inbox (~8am ET, ahead of FlushTrackerDigestsDaily at 12:30)',
  },
  // WS-G, LegiStorm gaps/enrichment plan (optional temporal enrichment) —
  // ships DISABLED per R7: a brand-new automated write path into
  // intelligence_change that has never run in prod. Unlike the other
  // LegiStorm-adjacent jobs, this has NO LEGISTORM_API_KEY dependency at all
  // (it reads the already-ingested directory snapshot + writes to our own
  // committee_membership_watch ledger) — the blocker here is purely "prove
  // it once before enabling," not the compromised-key gate. Runs after
  // SyncCommittees (05:40) so same-day committee-roster changes are
  // reflected before this compares against them.
  {
    id: 'EmitCommitteeChanges',
    command: ['emit-committee-changes'],
    cron: { minute: '0', hour: '6' },
    tier: 'derived',
    description: 'Committee membership gain/loss/role-change alerts for tracked members (daily 06:00 UTC)',
    enabled: false,
  },
];
