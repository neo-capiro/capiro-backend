#!/bin/sh
# Capiro API container entrypoint.
#
# Modes, selected by argv:
#   serve           (default) -- start the NestJS HTTP server.
#   migrate         -- run prisma migrate deploy, then seed workflow templates,
#                      and exit. The CDK migration task definition overrides the
#                      container command to "migrate". The data seed is
#                      idempotent (upserts) so re-running on every deploy is
#                      safe and keeps the workflow catalog in sync with the
#                      seed file in git.
#   seed-workflows  -- run only the workflow template seed (idempotent upserts).
#                      Useful for one-shot reseeds without invoking migrations.
#
# In both modes we compose DATABASE_URL from the individual DB_* secrets
# injected by ECS from the Aurora master credential. We require sslmode=require
# because Aurora's parameter group has rds.force_ssl=1.

set -e

if [ -z "$DB_HOST" ] || [ -z "$DB_PORT" ] || [ -z "$DB_USER" ] || [ -z "$DB_PASSWORD" ] || [ -z "$DB_NAME" ]; then
  echo "Missing DB_* env vars (got DB_HOST=$DB_HOST DB_PORT=$DB_PORT DB_USER=$DB_USER DB_NAME=$DB_NAME)" >&2
  exit 1
fi

# URL-encode the password, Aurora passwords occasionally contain characters
# that are not URL-safe. Pure-shell encoding because we want zero deps.
encode() {
  awk -v str="$1" 'BEGIN {
    for (i = 1; i <= length(str); i++) {
      c = substr(str, i, 1)
      if (c ~ /[A-Za-z0-9._~-]/) printf "%s", c
      else printf "%%%02X", ord_lookup[c] ? ord_lookup[c] : 0 + sprintf("%d", c)
    }
  }'
}
# Fallback: use node since it's always present in this image.
ENCODED_PASSWORD=$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$DB_PASSWORD")

export DATABASE_URL="postgresql://${DB_USER}:${ENCODED_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}?schema=public&sslmode=require&connection_limit=10"

# tsx writes its compile cache under TMPDIR; this image has no /tmp or /app/tmp, so
# an unset TMPDIR makes tsx-based verbs (sync-*/diag-*/reconcile-*) crash. /dev/shm
# is always present (tmpfs). Default it only if the task definition didn't set one.
: "${TMPDIR:=/dev/shm}"
export TMPDIR

case "${1:-serve}" in
  migrate)
    echo "Running prisma migrate deploy"
    # Auto-resolve any previously failed migrations before deploying.
    # Prisma refuses to apply new migrations if a prior one is in failed state.
    # We query the _prisma_migrations table directly for any failed entries and
    # mark them as rolled-back so migrate deploy can proceed cleanly.
    node -e "
      const { PrismaClient } = require('@prisma/client');
      const p = new PrismaClient();
      (async () => {
        try {
          const failed = await p.\$queryRaw\`
            SELECT migration_name FROM _prisma_migrations
            WHERE finished_at IS NULL AND rolled_back_at IS NULL
          \`;
          for (const row of failed) {
            console.log('Resolving failed migration:', row.migration_name);
            await p.\$executeRaw\`
              UPDATE _prisma_migrations
              SET rolled_back_at = NOW()
              WHERE migration_name = \${row.migration_name}
            \`;
          }
        } catch (e) { /* table may not exist on first run */ }
        await p.\$disconnect();
      })();
    "
    node ./node_modules/prisma/build/index.js migrate deploy --schema=./prisma/schema.prisma
    echo "Seeding workflow templates"
    # Data seed (idempotent UPSERTs). Source of truth is prisma/seed-workflows.ts.
    # Re-asserts the catalog on every migration deploy so prod / staging stay in
    # sync with the file in git.
    exec ./node_modules/.bin/tsx prisma/seed-workflows.ts
    ;;
  seed-workflows)
    echo "Seeding workflow templates"
    exec ./node_modules/.bin/tsx prisma/seed-workflows.ts
    ;;
  bootstrap-capiro-admin)
    shift
    echo "Running bootstrap-capiro-admin $*"
    # node_modules/.bin/tsx is a shell wrapper that invokes node against
    # tsx's JS entry; call it directly.
    exec ./node_modules/.bin/tsx scripts/bootstrap-capiro-admin.ts "$@"
    ;;
  bootstrap-tenant)
    shift
    echo "Running bootstrap-tenant $*"
    exec ./node_modules/.bin/tsx scripts/bootstrap-tenant.ts "$@"
    ;;
  drain-identity-outbox)
    shift
    # Retry Clerk de-provisioning calls that did not land at removal time.
    # Exits non-zero if any due job is still failing, so a scheduled invocation
    # surfaces as a task failure instead of silently "succeeding".
    echo "Running drain-identity-outbox $*"
    exec ./node_modules/.bin/tsx scripts/drain-identity-outbox.ts "$@"
    ;;
  bootstrap-roles)
    shift
    echo "Running bootstrap-roles (rotate capiro_app password)"
    exec ./node_modules/.bin/tsx scripts/bootstrap-roles.ts "$@"
    ;;
  emit-changes)
    echo "Running emit-changes (post-sync IntelligenceChange emitter)"
    exec ./node_modules/.bin/tsx scripts/emit-changes.ts
    ;;
  diag-alert-coverage)
    echo "Running diag-alert-coverage (read-only alert-precondition coverage report)"
    exec ./node_modules/.bin/tsx scripts/diag-alert-coverage.ts
    ;;
  diag-audit-append-only)
    echo "Running diag-audit-append-only (SAFE: pg_temp rehearsal of the audit append-only trigger; touches no real data)"
    exec ./node_modules/.bin/tsx scripts/diag-audit-append-only.ts
    ;;
  diag-auditor-shadow)
    echo "Running diag-auditor-shadow (READ-ONLY: shadow meri_audit_ledger hold-rate canary for the enforce-flip decision)"
    exec ./node_modules/.bin/tsx scripts/diag-auditor-shadow.ts
    ;;
  diag-blueprint-qa)
    shift
    echo "Running diag-blueprint-qa (read-only: Blueprint v2 backend verification) $*"
    exec ./node_modules/.bin/tsx scripts/diag-blueprint-qa.ts "$@"
    ;;
  diag-ingestion-health)
    echo "Running diag-ingestion-health (read-only ingestion counts + freshness report)"
    exec ./node_modules/.bin/tsx scripts/diag-ingestion-health.ts
    ;;
  diag-lda-identity)
    echo "Running diag-lda-identity (read-only: LDA client_id stability vs name variation)"
    exec ./node_modules/.bin/tsx scripts/diag-lda-identity.ts
    ;;
  diag-tenant-config)
    shift
    echo "Running diag-tenant-config (read-only: dump a tenant/client configured profile) $*"
    exec ./node_modules/.bin/tsx scripts/diag-tenant-config.ts "$@"
    ;;
  diag-state-legislator-detail)
    shift
    echo "Running diag-state-legislator-detail (read-only: dump a state legislator's full profile) $*"
    exec ./node_modules/.bin/tsx scripts/diag-state-legislator-detail.ts "$@"
    ;;
  diag-state-crosswalk-coverage)
    shift
    echo "Running diag-state-crosswalk-coverage (read-only: per-state legislator roster vs legiscan-linked counts) $*"
    exec ./node_modules/.bin/tsx scripts/diag-state-crosswalk-coverage.ts "$@"
    ;;
  set-tenant-flag)
    shift
    echo "Running set-tenant-flag (flip a per-tenant clioFeatureFlags rollout flag) $*"
    exec ./node_modules/.bin/tsx scripts/set-tenant-flag.ts "$@"
    ;;
  diag-profile-v1)
    shift
    echo "Running diag-profile-v1 (read-only Intelligence-tab per-source health + latency)"
    exec ./node_modules/.bin/tsx scripts/diag-profile-v1.ts "$@"
    ;;
  diag-client-resolution)
    shift
    echo "Running diag-client-resolution (read-only: per-client registrant-anchored resolution blast radius)"
    exec ./node_modules/.bin/tsx scripts/diag-client-resolution.ts "$@"
    ;;
  emit-bill-alerts)
    echo "Running emit-bill-alerts (semantic per-bill stage alerts)"
    exec ./node_modules/.bin/tsx scripts/emit-bill-alerts.ts
    ;;
  detect-tracker-alerts)
    echo "Running detect-tracker-alerts (Tracker tab: tracked-bill change detection + email/SMS fan-out)"
    exec ./node_modules/.bin/tsx scripts/detect-tracker-alerts.ts
    ;;
  flush-tracker-digests)
    shift
    echo "Running flush-tracker-digests (Tracker tab: daily/weekly alert digests) $*"
    exec ./node_modules/.bin/tsx scripts/flush-tracker-digests.ts "$@"
    ;;
  diag-tracker-readiness)
    shift
    echo "Running diag-tracker-readiness (Tracker tab: READ-ONLY alert readiness report) $*"
    exec ./node_modules/.bin/tsx scripts/diag-tracker-readiness.ts "$@"
    ;;
  diag-outlook-sync)
    shift
    echo "Running diag-outlook-sync (READ-ONLY Outlook/Graph connection + sync health) $*"
    exec ./node_modules/.bin/tsx scripts/diag-outlook-sync.ts "$@"
    ;;
  reclaim-google-mail)
    # Retroactive Gmail re-association: reset+resume re-fetch of a tenant's Google
    # connection(s) so previously-skipped mail re-runs association against the
    # current client set. DRY RUN by default; pass --tenant=<slug|uuid> [--connection=<uuid>] [--commit].
    shift
    echo "Running reclaim-google-mail $*"
    exec ./node_modules/.bin/tsx scripts/reclaim-google-mail.ts "$@"
    ;;
  delete-tenant)
    shift
    echo "Running delete-tenant $*"
    exec ./node_modules/.bin/tsx scripts/delete-tenant.ts "$@"
    ;;
  backfill-sectors)
    echo "Running backfill-sector-tags"
    exec ./node_modules/.bin/tsx scripts/backfill-sector-tags.ts
    ;;
  generate-briefings)
    echo "Running generate-briefings"
    exec ./node_modules/.bin/tsx scripts/generate-briefings.ts
    ;;
  generate-meeting-briefings)
    echo "Running generate-meeting-briefings (P2-8 scheduled proactive briefings)"
    exec ./node_modules/.bin/tsx scripts/generate-meeting-briefings.ts
    ;;
  emit-clio-alerts)
    # Scheduled replacement for the old in-chat generateProactiveAlerts() call
    # (removed â€” see meri.service.ts:3369). Scans every active tenant for
    # upcoming meetings with no prep notes (48h) and clients quiet 30+ days;
    # writes clio_proactive_alert rows (dashboard inbox). Idempotent (dedupes
    # per tenant/sourceType/sourceId/pending). Intended cadence: every 30-60 min.
    echo "Running emit-clio-alerts (quiet-client + meeting-prep proactive alerts)"
    exec ./node_modules/.bin/tsx scripts/emit-clio-alerts.ts
    ;;
  compute-health-scores)
    echo "Running compute-health-scores"
    exec ./node_modules/.bin/tsx scripts/compute-health-scores.ts
    ;;
  check-comment-periods)
    echo "Running check-comment-periods"
    exec ./node_modules/.bin/tsx scripts/check-comment-periods.ts
    ;;
  embed-backfill)
    # Embedding backfill. Takes flags like `--source bills` /
    # `--source lda --since 2024-01-01` / `--source capabilities --tenant <uuid>`.
    # The CDK ApiEmbedBackfillTaskDef overrides container command to set them.
    shift
    echo "Running embed-backfill $*"
    exec ./node_modules/.bin/tsx scripts/embed-backfill.ts "$@"
    ;;
  embed-program-elements)
    # Embed each active PE's mission text into context_embeddings(source_type='pe')
    # to power the "Related Program Elements" suggestion panel. Idempotent.
    # Optional flag: --limit N.
    shift
    echo "Running embed-program-elements $*"
    exec ./node_modules/.bin/tsx scripts/embed-program-elements.ts "$@"
    ;;
  # â”€â”€ Federal data sync jobs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  # These populate the Intelligence Center source tables (LDA, Congress, FedReg,
  # Hearings, GAO, CRS, FEC, FARA, SEC, RSS intel, state bills, economic
  # indicators, grants). Wired so EventBridge can dispatch each as a
  # one-off ECS task, keep the case names in kebab-case matching the
  # script file so cron rules stay trivially mappable.
  sync-lda)               exec ./node_modules/.bin/tsx scripts/sync-lda.ts ;;
  sync-congress)          exec ./node_modules/.bin/tsx scripts/sync-congress.ts ;;
  sync-congress-members)  exec ./node_modules/.bin/tsx scripts/sync-congress-members.ts ;;
  sync-cbo)               exec ./node_modules/.bin/tsx scripts/sync-cbo.ts ;;
  sync-committees)        exec ./node_modules/.bin/tsx scripts/sync-committees.ts ;;
  sync-house-votes)       exec ./node_modules/.bin/tsx scripts/sync-house-votes.ts ;;
  sync-senate-votes)      exec ./node_modules/.bin/tsx scripts/sync-senate-votes.ts ;;
  derive-bill-status)     exec ./node_modules/.bin/tsx scripts/derive-bill-status.ts ;;
  sync-federal-register)  exec ./node_modules/.bin/tsx scripts/sync-federal-register.ts ;;
  sync-regulations)       exec ./node_modules/.bin/tsx scripts/sync-regulations.ts ;;
  sync-hearings)          exec ./node_modules/.bin/tsx scripts/sync-hearings.ts ;;
  # Track B (H2): official hearing-transcript TEXT from GovInfo CHRG (2026-scoped).
  sync-hearing-transcripts) exec ./node_modules/.bin/tsx scripts/sync-hearing-transcripts.ts ;;
  sync-gao)               exec ./node_modules/.bin/tsx scripts/sync-gao.ts ;;
  sync-crs)               exec ./node_modules/.bin/tsx scripts/sync-crs.ts ;;
  sync-fec)               exec ./node_modules/.bin/tsx scripts/sync-fec.ts ;;
  # Step 28: USAspending federal awards (DoD), PE-tagged. Daily 7-day delta; pass
  # --backfill --since YYYY-MM-DD for the separate backfill.
  sync-federal-award)     shift; exec ./node_modules/.bin/tsx scripts/sync-federal-award.ts "$@" ;;
  # District Nexus: USAspending financial assistance (award_type_codes 02-05:
  # block/formula/project grants + cooperative agreements) â€” kept separate
  # from federal_award/sync-federal-award (contracts, different data product).
  # Daily 7-day delta; pass --backfill --since YYYY-MM-DD --min-amount N for
  # a bounded backfill. Ships disabled in ingestion-schedule.ts pending canary.
  sync-federal-assistance-awards) shift; exec ./node_modules/.bin/tsx scripts/sync-federal-assistance-awards.ts "$@" ;;
  # District Nexus: thin per-award detail enrichment (fain/uri/subaward count/
  # non-federal funding/funding-opportunity number) for federal_assistance_award
  # rows sync-federal-assistance-awards couldn't fully populate from search alone.
  enrich-assistance-awards) shift; exec ./node_modules/.bin/tsx scripts/enrich-assistance-award-details.ts "$@" ;;
  # Step 32: LLM NER over recent DoD press releases (IntelArticle source=dod).
  extract-press-personnel) shift; exec ./node_modules/.bin/tsx scripts/extract-personnel-from-press-releases.ts "$@" ;;
  # Step 33: SAM.gov DoD solicitation KO/CS personnel (email domain only).
  sync-sam-personnel)     shift; exec ./node_modules/.bin/tsx scripts/sync-sam-personnel.ts "$@" ;;
  # Step 3.1: SAM.gov DoD contract opportunities feed (sam_opportunity). Always
  # commits when run as a scheduled task (dry-run is for local dev only).
  sync-sam-opportunities) shift; exec ./node_modules/.bin/tsx scripts/sync-sam-opportunities.ts --commit "$@" ;;
  # Re-run the opportunity->PE/program matcher over ALL existing sam_opportunity rows
  # WITHOUT re-fetching from SAM.gov â€” realizes a matcher change (e.g. procurement-BLIN
  # recognition) across the already-ingested backlog the daily sync would never re-match.
  # Idempotent. Add --commit to persist (dry-run reports the would-be counts).
  rematch-sam-opportunities) shift; exec ./node_modules/.bin/tsx scripts/sync-sam-opportunities.ts --match-only "$@" ;;
  # Step 34A: DoD witnesses at defense-committee hearings (committee_hearing).
  extract-hearing-witnesses) shift; exec ./node_modules/.bin/tsx scripts/extract-hearing-witnesses.ts "$@" ;;
  # Step 34B: DoD personnel named in recent GAO reports (LLM NER over metadata).
  extract-gao-interviewees)  shift; exec ./node_modules/.bin/tsx scripts/extract-gao-interviewees.ts "$@" ;;
  sync-fec-pac)           exec ./node_modules/.bin/tsx scripts/sync-fec-pac.ts ;;
  sync-entity-resolution) shift; exec ./node_modules/.bin/tsx scripts/sync-entity-resolution.ts "$@" ;;
  diag-client-resolution) shift; exec ./node_modules/.bin/tsx scripts/diag-client-resolution.ts "$@" ;;
  # Read-only: dump stored status/profile_status for every client carrying LDA ids,
  # to diagnose imported clients missing from the Portfolio list. No writes.
  diag-phantom-imports) shift; exec ./node_modules/.bin/tsx scripts/diag-phantom-imports.ts "$@" ;;
  diag-pe-detail-coverage) shift; exec ./node_modules/.bin/tsx scripts/diag-pe-detail-coverage.ts "$@" ;;
  # Read-only: audit client_facilities state/district data across all tenants (QA Bug 4
  # back-test): unknown states, invalid (state, district) pairs, orphan districts. No writes.
  diag-facility-districts) shift; exec ./node_modules/.bin/tsx scripts/diag-facility-districts.ts "$@" ;;
  # Task A step 3: prepopulation backfill (recompute lda_client_ids + issue codes
  # + ldaSignals from CONFIRMED mappings). Creates NO new associations; idempotent.
  prepopulate-all) shift; exec ./node_modules/.bin/tsx scripts/prepopulate-all.ts "$@" ;;
  # SAM gov-id backfill: fill clients.uei/cage_code/naics_codes/psc_codes from the
  # SAM Entity API by legal name (+state). Fill-if-empty, conservative single-match.
  # DRY RUN unless --commit; --tenant <uuid> / --delay <ms> supported.
  fill-govids-all) shift; exec ./node_modules/.bin/tsx scripts/fill-govids-all.ts "$@" ;;
  enrich-award-districts) shift; exec ./node_modules/.bin/tsx scripts/enrich-award-districts.ts "$@" ;;
  # PE->contractor linkage: read the DoD acquisition (MDAP) program code off each
  # award detail, persist it, and resolve a PE via the curated acq-program map.
  enrich-award-pe) shift; exec ./node_modules/.bin/tsx scripts/enrich-award-pe.ts "$@" ;;
  # Pure re-resolution: re-map EVERY award that already has a stored dodAcqProgramCode
  # to a PE via the CURRENT curated acq-program map â€” NO USAspending API call. Realizes
  # the full existing-map coverage across the backlog instantly, and re-applies a grown
  # map. Dry-run by default; add --commit to persist. Idempotent.
  resolve-awards-from-acq-map) shift; exec ./node_modules/.bin/tsx scripts/enrich-award-pe.ts --resolve-only "$@" ;;
  # Seed/refresh the curated DoD-acquisition-program -> PE map (idempotent upserts).
  seed-acq-program-map) shift; exec ./node_modules/.bin/tsx scripts/seed-acq-program-map.ts "$@" ;;
  # Materialize the Program graph from the curated MDAP map: one Program per MDAP
  # code + deterministic 'accepted' pe_program_match rows (evidenceTier mdap_curated).
  # This is what populates the PE-profile Programs panel. Dry-run default; --commit.
  seed-programs) shift; exec ./node_modules/.bin/tsx scripts/seed-programs.ts "$@" ;;
  # Propose FUZZY PE/project -> Program matches (alias-trigram) as 'candidate' rows
  # for human review. Never auto-accepts. Dry-run default; --apply to insert.
  match-pe-program) shift; exec ./node_modules/.bin/tsx scripts/match-pe-program.ts "$@" ;;
  # Read-only: print federal_award PE/acq-program coverage counts as JSON. No writes.
  report-award-pe-coverage) shift; exec ./node_modules/.bin/tsx scripts/report-award-pe-coverage.ts "$@" ;;
  # Read-only PE mark-coverage report: per-FY mark_present / expected_blank /
  # candidate_gap for HASC/SASC/HAC-D/SAC-D/conference/enacted. candidate_gap = an
  # in-request, unclassified RDT&E, in-jurisdiction PE that LACKS the mark (a real
  # extraction gap worth chasing). No writes.
  report-pe-coverage) shift; exec ./node_modules/.bin/tsx scripts/report-pe-coverage.ts "$@" ;;
  # â”€â”€ Stale old-DoW-directory cleanup (PEs + personnel) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  # Read-only: counts old-directory data still live (would-supersede / would-retire /
  # links-to-repair) using the SAME predicates as the reconcile jobs. No writes.
  diag-stale-directory) shift; exec ./node_modules/.bin/tsx scripts/diag-stale-directory.ts "$@" ;;
  # Read-only: per-tenant Meri memory health (totals, firm vs private, % embedded).
  diag-clio-memory) shift; exec ./node_modules/.bin/tsx scripts/diag-clio-memory.ts "$@" ;;
  # Read-only: Phase 1 SSOT-consolidation GATE â€” per-tenant clio_memoryâ†”memory_items
  # recall parity (wouldDropOnCollapse must be 0 before recall is re-pointed).
  diag-memory-recall-parity) shift; exec ./node_modules/.bin/tsx scripts/diag-memory-recall-parity.ts "$@" ;;
  # Backfill embeddings for clio_memory rows missing one. DRY RUN unless --commit.
  backfill-clio-memory-embeddings) shift; exec ./node_modules/.bin/tsx scripts/backfill-clio-memory-embeddings.ts "$@" ;;
  # W3: run DUE Meri scheduled tasks (read-only research digests to inbox). DRY RUN unless --commit.
  run-clio-scheduled-tasks) shift; exec ./node_modules/.bin/tsx scripts/run-clio-scheduled-tasks.ts "$@" ;;
  # Phase 1 M5.1: Tier-2 agentic worker (targeting-brief mode). DRY RUN unless --commit.
  run-intel-workflows) shift; exec ./node_modules/.bin/tsx scripts/run-intel-workflows.ts "$@" ;;
  # Rebuild the institutional-memory knowledge graph + embeddings for one/all tenants
  # (idempotent; picks up new clients/memories/meetings/emails/Meri sessions). --all-tenants | --tenant=<slug|uuid>.
  refresh-memory-graph) shift; exec ./node_modules/.bin/tsx scripts/refresh-memory-graph.ts "$@" ;;
  # Soft-supersede personnel whose only provenance is the old DoW spreadsheet and who
  # are absent from the updated directory. DRY RUN unless --commit; --limit=N caps.
  reconcile-personnel-supersede) shift; exec ./node_modules/.bin/tsx scripts/reconcile-personnel-supersede.ts "$@" ;;
  # Soft-retire old-spreadsheet PEs with no live signal (keeps real-but-uncovered).
  # DRY RUN unless --commit. Run AFTER reconcile-personnel-supersede.
  reconcile-stale-pes) shift; exec ./node_modules/.bin/tsx scripts/reconcile-stale-pes.ts "$@" ;;
  # Re-validate person->PE links: clear stale/untrusted links to retired/missing PEs
  # (keeps human-confirmed). DRY RUN unless --commit. Run AFTER reconcile-stale-pes,
  # then generate-pe-person-candidates to re-propose cleared links.
  repair-person-pe-links) shift; exec ./node_modules/.bin/tsx scripts/repair-person-pe-links.ts "$@" ;;
  sync-fara)              exec ./node_modules/.bin/tsx scripts/sync-fara.ts ;;
  # FARA foreign-principal enrichment over the active-registrant rows (fills the
  # FP_UNSPECIFIED sentinel + country from the FARA bulk feed at FARA_FP_SOURCE_URL).
  # Dry-run by default; a dispatched job passes --commit.
  sync-fara-enrichment)   shift; exec ./node_modules/.bin/tsx scripts/sync-fara-enrichment.ts "$@" ;;
  sync-sec-edgar)         exec ./node_modules/.bin/tsx scripts/sync-sec-edgar.ts ;;
  sync-rss-intel)         exec ./node_modules/.bin/tsx scripts/sync-rss-intel.ts ;;
  # Member press/RSS items for the directory News tab (every 3 days). A dispatched
  # task passes --commit; bare invocation is a dry run for local review.
  sync-member-press)      shift; exec ./node_modules/.bin/tsx scripts/sync-member-press.ts "$@" ;;
  # LegiStorm directory safe refresh. Dispatched tasks pass --commit (and --full on
  # the weekly reconciliation); a bare invocation is a dry run that writes nothing.
  sync-legistorm-directory) shift; exec ./node_modules/.bin/tsx scripts/sync-legistorm-directory.ts "$@" ;;
  # LegiStorm Legislative Districts (WS-B). Full reconciliation every run; a
  # bare invocation is a dry run that writes nothing (--commit to write,
  # --with-kml to also fetch+store boundaries, --states=XX,YY to scope a run).
  sync-legistorm-districts) shift; exec ./node_modules/.bin/tsx scripts/sync-legistorm-districts.ts "$@" ;;
  # District Nexus boundary artifacts (WS-D). Builds browser-safe GeoJSON from
  # the Census cartographic national file ('C') and our re-hosted LegiStorm KML
  # ('F'); a bare invocation is a dry run that writes nothing (--commit to
  # publish, --status=C|F to pick a rail, --states=XX,YY to scope a run).
  build-district-boundary-artifacts) shift; exec ./node_modules/.bin/tsx scripts/build-district-boundary-artifacts.ts "$@" ;;
  # LegiStorm Privately Funded Travel (WS-F). Incremental like the directory
  # job; a bare invocation is a dry run that writes nothing.
  sync-legistorm-trips) shift; exec ./node_modules/.bin/tsx scripts/sync-legistorm-trips.ts "$@" ;;
  sync-openstates)        exec ./node_modules/.bin/tsx scripts/sync-openstates.ts ;;
  # State Legislation Platform (Phase 0 S1) â€” LegiScan is the bill spine.
  # backfill = one-time dataset seed + quota-exhaustion fallback (accepts
  # LEGISCAN_STATES/LEGISCAN_SESSIONS via env, no CLI flags); masterlist =
  # cheap change_hash diff -> drain queue; bills = the getBill drain.
  backfill-legiscan-datasets) exec ./node_modules/.bin/tsx scripts/backfill-legiscan-datasets.ts ;;
  sync-legiscan-masterlist)   exec ./node_modules/.bin/tsx scripts/sync-legiscan-masterlist.ts ;;
  sync-legiscan-bills)        exec ./node_modules/.bin/tsx scripts/sync-legiscan-bills.ts ;;
  derive-state-bill-status)   exec ./node_modules/.bin/tsx scripts/derive-state-bill-status.ts ;;
  emit-state-changes)         exec ./node_modules/.bin/tsx scripts/emit-state-changes.ts ;;
  # WS-G, LegiStorm gaps/enrichment plan (optional temporal enrichment) â€”
  # committee membership gain/loss/role-change alerts. No CLI flags (matches
  # every other emit-* script's convention â€” only the sync-* vendor-fetch
  # scripts have a dry-run/--commit split).
  emit-committee-changes)     exec ./node_modules/.bin/tsx scripts/emit-committee-changes.ts ;;
  # WS-D3, District Nexus plan - enacted-but-not-yet-effective congressional
  # map alerts, emitted only for districts where a tracked client has a
  # facility. Reads the already-ingested legislative_district table (populated
  # by sync-legistorm-districts) and never calls the vendor API, so like
  # emit-committee-changes it has NO LEGISTORM_API_KEY dependency. Zero-arg,
  # matching every other emit-* script's convention.
  emit-redistricting-alerts)  exec ./node_modules/.bin/tsx scripts/emit-redistricting-alerts.ts ;;
  # Ongoing OpenStates<->LegiScan people crosswalk (S2): stamps
  # state_legislator.legiscan_people_id via getSessionPeople so legislators link
  # to their sponsored bills. Reads LEGISCAN_STATES from env (no CLI flags).
  crosswalk-state-people)     exec ./node_modules/.bin/tsx scripts/crosswalk-state-people.ts ;;
  # District Impact Engine (Phase 1 M1.2) â€” keyless Census Geocoder backfill.
  geocode-facilities)         exec ./node_modules/.bin/tsx scripts/geocode-facilities.ts ;;
  # Deadline Physics + Chokepoint (Phase 1 M2.1/M2.2) â€” committed calendar seed load + roster normalization.
  load-state-calendars)       exec ./node_modules/.bin/tsx scripts/load-state-calendars.ts ;;
  normalize-state-committees) exec ./node_modules/.bin/tsx scripts/normalize-state-committees.ts ;;
  backtest-deadline-physics)  exec ./node_modules/.bin/tsx scripts/backtest-deadline-physics.ts ;;
  sync-state-register)        exec ./node_modules/.bin/tsx scripts/sync-state-register.ts ;;
  sync-bls)               exec ./node_modules/.bin/tsx scripts/sync-bls.ts ;;
  sync-bea)               exec ./node_modules/.bin/tsx scripts/sync-bea.ts ;;
  sync-census)            exec ./node_modules/.bin/tsx scripts/sync-census.ts ;;
  # Grants.gov opportunities (NOFOs). Bare = daily posted|forecasted; pass
  # --all-statuses for the weekly reconcile that also sees closed/archived.
  # Needs "$@" â€” the flag was unreachable while this verb swallowed its args.
  sync-grants)            shift; exec ./node_modules/.bin/tsx scripts/sync-grants.ts "$@" ;;
  # District Nexus: Grants.gov fetchOpportunity detail pass. Fills every
  # federal_grant column search2 cannot return (award ceiling/floor, funding,
  # eligibility, description, category) plus the Workstream C detail block.
  # Ships disabled in ingestion-schedule.ts pending Phase 1 canary.
  enrich-grant-details)   shift; exec ./node_modules/.bin/tsx scripts/enrich-grant-details.ts "$@" ;;
  # District Nexus: deterministic relevance producer for client_grant_nexus
  # 'opportunity_candidate' rows (audit F3). Dry-run by default; needs "$@" so
  # --commit/--tenant/--min-relevance reach the script. Ships disabled in
  # ingestion-schedule.ts.
  generate-grant-opportunity-candidates) shift; exec ./node_modules/.bin/tsx scripts/generate-grant-opportunity-candidates.ts "$@" ;;
  sync-openlobby)         exec ./node_modules/.bin/tsx scripts/sync-openlobby.ts ;;
  sync-openspending)      exec ./node_modules/.bin/tsx scripts/sync-openspending.ts ;;
  sync-lobby-trending)    exec ./node_modules/.bin/tsx scripts/sync-lobby-trending.ts ;;
  refresh-lobby-intel-mv) exec ./node_modules/.bin/tsx scripts/refresh-lobby-intel-mv.ts ;;
  refresh-kg-edge-cache)  exec ./node_modules/.bin/tsx scripts/refresh-kg-edge-cache.ts ;;
  # Program Element J-book provenance. Loads the committed deterministic
  # extraction artifact (scripts/__data__/jbook_r1_fy2027.json) into program_element
  # + program_element_source. No Python in the runtime image, so the loader reads
  # the JSON artifact rather than re-parsing the PDF. --commit because a dispatched
  # task always writes (bare invocation is dry-run for local review only).
  sync-comptroller-jbooks) exec ./node_modules/.bin/tsx scripts/sync-comptroller-jbooks.ts --commit ;;
  # Program Element R-2/R-2A descriptive-summary loader. Reads committed extraction
  # artifacts (scripts/__data__/jbook_r2_*.json) and enriches program_element
  # narrative + program_element_project + page citations. No PDF/Python at runtime.
  sync-jbook-r2) exec ./node_modules/.bin/tsx scripts/sync-jbook-r2.ts --commit ;;
  # PE -> named prime contractor linkage (Layer 1, highest precision). Loads the R-3
  # "Product Development" performer tables (company, contract method, location, $) from
  # the committed offline artifacts scripts/__data__/jbook_performers_*.json into
  # program_element_performer + R-3 page citations. --commit (dispatched task always writes).
  sync-jbook-performers) exec ./node_modules/.bin/tsx scripts/sync-jbook-performers.ts --commit ;;
  # USAspending File C TAS+ProgramActivity funding crosswalk + UEI confirmation of awards
  # against R-3 named primes (Layer 2/3). Stores funding account/PA for display + asserts
  # pe_code only when the recipient matches an R-3 named prime. Pass --limit/--min-amount/--refresh.
  enrich-award-pe-tas) shift; exec ./node_modules/.bin/tsx scripts/enrich-award-pe-tas.ts "$@" ;;
  # Stanford DoW acquisition-personnel directory import (idempotent: pre-seeds its
  # dedup map from the DB by nameKey, re-runs add source mentions not duplicates).
  # Populates program_element + acquisition_personnel + person->PE links.
  import-dow-directory) exec ./node_modules/.bin/tsx scripts/import-stanford-dow-directory.ts ;;
  # DoW Directory Rev 6 (June 2026) acquisition-personnel import. Reads the committed
  # parsed artifact (scripts/__data__/dow_directory_v6/dow_v6_people.json) and upserts
  # via the writer+dedup engine (idempotent: reloads nameKey map from DB each call, so
  # re-runs add source mentions, never duplicate rows). Source: dow_directory_rev6_2026_06.
  # Packs programs_mentioned + managing CPE into programOfRecord to feed the PE matcher.
  import-dow-directory-v6) exec ./node_modules/.bin/tsx scripts/import-dow-directory-v6.ts ;;
  # Acquire official DoD headshots for acquisition-personnel whose publicProfileUrl is a
  # .mil bio page (metadata.linkType=mil_bio): Firecrawl-scrape the bio, pull the
  # media.defense.gov image, validate + upload to ASSETS_BUCKET/dow-headshots/{id}.{ext},
  # and merge metadata.headshotS3Key. Idempotent (skips people who already have a key
  # unless --force). Bare invocation is dry-run; a dispatched task passes --commit.
  sync-dow-headshots) shift; exec ./node_modules/.bin/tsx scripts/sync-dow-headshots.ts "$@" ;;
  # Phase 1b: generate person->PE link CANDIDATES for human review (review queue
  # only; never auto-applies pe_primary). Deterministic org/title token overlap.
  generate-pe-person-candidates) exec ./node_modules/.bin/tsx scripts/generate-pe-person-candidates.ts --commit ;;
  # Bulk auto-approve high-confidence person->PE candidates (score >= --min-score,
  # default 0.8) WITHOUT manual review. Dry-run unless --commit. Reversible via
  # source='pe_match_auto_confirmed'. Flags: --min-score= --limit= --commit --note=
  auto-confirm-pe-person-candidates) shift; exec ./node_modules/.bin/tsx scripts/auto-confirm-pe-person-candidates.ts "$@" ;;
  # Populate program_office_program_link (office->program) so the role chain
  # (person->office->program->PE) surfaces office-based roles on PE pages.
  # Deterministic + review-gated; manages only its derived_by cohort. Dry-run
  # unless --commit. Flags: --min-conf= --limit= --commit
  derive-office-program-links) shift; exec ./node_modules/.bin/tsx scripts/derive-office-program-links.ts "$@" ;;
  # Phase 3: load Army CPE/PEO org-chart rosters (real named acquisition leaders:
  # CPE/PEO, deputies, PMs, staff) into acquisition_personnel. People-first +
  # idempotent (nameKey dedup); does not set pe_primary (matcher proposes that).
  sync-peo-rosters) exec ./node_modules/.bin/tsx scripts/sync-peo-rosters.ts --commit ;;
  # Step 21: scan CongressBill text for PE codes, filter to existing program_element,
  # upsert congress_bill.pe_codes, emit IntelligenceChange when a new PE is watched.
  # Backfill primary sponsor (sponsor_name/state/party + cosponsors) on existing
  # CongressBill rows so the Office Recommender can rank by bill sponsor. Pass
  # --congress / --limit through, e.g. `backfill-bill-sponsors --congress 119`.
  backfill-bill-sponsors) shift; exec ./node_modules/.bin/tsx scripts/backfill-bill-sponsors.ts "$@" ;;
  # Step 22: load HASC/SASC committee-report PE marks from a committed rows artifact
  # (offline pdfplumber extraction) via the program-element writer. Pass the artifact
  # path as an extra arg; --chamber/--fy fall back to the artifact's own fields.
  parse-hasc-report) shift; exec ./node_modules/.bin/tsx scripts/parse-hasc-sasc-reports.ts --chamber HASC "$@" ;;
  parse-sasc-report) shift; exec ./node_modules/.bin/tsx scripts/parse-hasc-sasc-reports.ts --chamber SASC "$@" ;;
  # Step 23: load House/Senate Defense Appropriations subcommittee PE marks from a
  # committed rows artifact (offline pdfplumber extraction) via the writer. Same
  # pattern as Step 22; writes hac_d_mark / sac_d_mark.
  parse-hac-d-report) shift; exec ./node_modules/.bin/tsx scripts/parse-defense-approps-reports.ts --chamber HAC-D "$@" ;;
  parse-sac-d-report) shift; exec ./node_modules/.bin/tsx scripts/parse-defense-approps-reports.ts --chamber SAC-D "$@" ;;
  # Step 24: NDAA conference report (final authorization -> conference field) and
  # enacted Defense Appropriations public law (-> enacted field). Same offline-rows
  # pattern. Scheduled primarily Nov-Jan (conference + enactment window).
  parse-ndaa-conference) shift; exec ./node_modules/.bin/tsx scripts/parse-ndaa-conference.ts "$@" ;;
  parse-defense-approps-public-law) shift; exec ./node_modules/.bin/tsx scripts/parse-defense-approps-public-law.ts "$@" ;;
  # Step 27: load P-Doc (Procurement) parent PEs + child line items from a committed
  # rows artifact (offline pdfplumber extraction). Pass --service + --artifact.
  parse-pdoc) shift; exec ./node_modules/.bin/tsx scripts/parse-pdoc-army.ts "$@" ;;
  # R3 Â§3.2: load a CURATED, human-reviewed defense budget-package artifact
  # (package + vehicles + toplines + CR windows). DRY RUN unless --commit; rejects
  # any topline missing a stage, vehicle, scope, source, or explicit unit.
  #   load-defense-budget-package --artifact scripts/__data__/defense-budget/fy2027-package.json [--commit] [--supersede-verified]
  load-defense-budget-package) shift; exec ./node_modules/.bin/tsx scripts/load-defense-budget-package.ts "$@" ;;
  # R3 Â§3.7: READ-ONLY invariant report over the loaded package data. Non-zero exit
  # on a hard failure, so it can gate a deploy.
  verify-defense-budget-packages) shift; exec ./node_modules/.bin/tsx scripts/verify-defense-budget-packages.ts "$@" ;;
  # Deep P-40 enrichment: attach description / acatLevel / programOfRecord / status +
  # raw.pDocDetail (qty, unit cost, schedule, acquisition strategy, contractors,
  # milestones, risks) to EXISTING program elements. Enrich-only. Pass --artifact.
  load-pdoc-enrichment) shift; exec ./node_modules/.bin/tsx scripts/load-pdoc-enrichment.ts "$@" ;;
  # OP-5 O&M narrative loader (batch-10): SAG-code-joined descriptions -> EXISTING
  # O&M program elements only. Enrich-only, presence-based raw.op5Detail merge.
  load-om-op5) shift; exec ./node_modules/.bin/tsx scripts/load-om-op5.ts "$@" ;;
  # â”€â”€ Budget Lines money-graph derivations (BL-0). DAG order: actions ->
  # relationships -> capabilities -> intelligence cache. All dry-run by default;
  # pass --commit. Each deletes + rewrites only its own derived_by cohort.
  derive-budget-actions) shift; exec ./node_modules/.bin/tsx scripts/derive-budget-actions.ts "$@" ;;
  # Nightly PE derive chain (PE Watch auto-update plan, Phase 0): runs the whole
  # DAG above sequentially (deltas -> actions -> relationships -> capabilities ->
  # intelligence cache), aborting on first failure. Dry-run default; the
  # EventBridge rule passes --commit. SyncRun source: pe-derive-chain.
  run-pe-derive-chain) shift; exec ./node_modules/.bin/tsx scripts/run-pe-derive-chain.ts "$@" ;;
  # Budget-document watcher (PE Watch plan, Phase 1): diff publisher indexes +
  # committee-report listings against known detections + the source_document
  # registry; sha-check registry heads for republications. Dry-run default; the
  # EventBridge rule passes --commit. First prod run: --commit --baseline.
  watch-budget-docs) shift; exec ./node_modules/.bin/tsx scripts/watch-budget-docs.ts "$@" ;;
  # PE Watch alert emails + client-watchlist stamping (PE Watch plan, Phase 2).
  # Canary-gated by PE_ALERT_EMAIL_TENANTS (unset = dark). Runs as the final
  # step of run-pe-derive-chain; also dispatchable standalone. Dry-run default.
  send-pe-alert-emails) shift; exec ./node_modules/.bin/tsx scripts/send-pe-alert-emails.ts "$@" ;;
  # Phase 3 â€” hearing-transcript PE mentions + bill-title candidate links
  # (dry-run default; --commit, --limit N, --since YYYY-MM-DD). Candidates only;
  # nothing fuzzy auto-accepts.
  match-pe-mentions) shift; exec ./node_modules/.bin/tsx scripts/match-pe-mentions.ts "$@" ;;
  derive-relationships) shift; exec ./node_modules/.bin/tsx scripts/derive-relationships.ts "$@" ;;
  seed-capabilities) shift; exec ./node_modules/.bin/tsx scripts/seed-capabilities.ts "$@" ;;
  derive-intelligence-cache) shift; exec ./node_modules/.bin/tsx scripts/derive-intelligence-cache.ts "$@" ;;
  # Bill PE-code extractor (Step 21 + LEG-B): scans bill title/action/GovInfo
  # full text for verbatim PE codes; writes CongressBill.peCodes AND the
  # evidence-bearing bill_budget_line_link rows. Safe to re-run (idempotent).
  extract-bill-pe-codes) shift; exec ./node_modules/.bin/tsx scripts/extract-bill-pe-codes.ts "$@" ;;
  # Committee-report LANGUAGE provisions loader (Step 2.4 / LEG-C): reads
  # committee_provisions_*.json artifacts and builds review-gated PE links
  # (pe_code auto-accepted; title/alias land candidate). Dry-run default.
  sync-report-provisions) shift; exec ./node_modules/.bin/tsx scripts/sync-report-provisions.ts "$@" ;;
  # Read-only: dump the provision-link + bill-link data shape for one PE (FIX-1/2
  # verification). Pass --pe <code> [--bill <billId>].
  diag-leg-readpaths) shift; exec ./node_modules/.bin/tsx scripts/diag-leg-readpaths.ts "$@" ;;
  # O-1 Operation & Maintenance loader: O&M detail lines as program elements
  # (appropriationType=OM, pe_code=<account><line>). Pass --artifact. O-1 is $K.
  load-om) shift; exec ./node_modules/.bin/tsx scripts/load-om.ts "$@" ;;
  # Org graph: import DoW Directory orgs/roles/program-owners into program_office /
  # person_role / program(+links). Dry-run default; pass --commit.
  import-dow-orgs) shift; exec ./node_modules/.bin/tsx scripts/import-dow-orgs.ts "$@" ;;
  # Master program/people lists exported FROM PROD (read-only; CSVs to stdout).
  export-master-lists) shift; exec ./node_modules/.bin/tsx scripts/export-master-lists.ts "$@" ;;
  # Read-only graph-coverage baseline (org/program/person link counts by status).
  diag-graph-coverage) shift; exec ./node_modules/.bin/tsx scripts/diag-graph-coverage.ts "$@" ;;
  # Read-only per-PE data-presence report ("why is PE X thin?"). --pe=CODE.
  diag-pe) shift; exec ./node_modules/.bin/tsx scripts/diag-pe.ts "$@" ;;
  # Read-only network-link coverage matrix by appropriation type (RDT&E/PROC/OM) â€”
  # the before/after yield measurement for the procurement-BLIN matching remediation.
  diag-blin-coverage) shift; exec ./node_modules/.bin/tsx scripts/diag-blin-coverage.ts "$@" ;;
  backfill-appropriation-type) shift; exec ./node_modules/.bin/tsx scripts/backfill-appropriation-type.ts "$@" ;;
  # Personnel + derived jobs that were missing dispatch cases (Production
  # Ingestion plan, Phase 2). Scheduled via EventBridge in infra/cdk.
  sync-dod-orgcharts) shift; exec ./node_modules/.bin/tsx scripts/sync-dod-orgcharts.ts "$@" ;;
  sync-dod-press-personnel) shift; exec ./node_modules/.bin/tsx scripts/sync-dod-press-personnel.ts "$@" ;;
  sync-cpe-roster) shift; exec ./node_modules/.bin/tsx scripts/sync-cpe-roster.ts "$@" ;;
  recompute-conference-probability) shift; exec ./node_modules/.bin/tsx scripts/recompute-conference-probability.ts "$@" ;;
  # Step 1.4 â€” recompute typed budget deltas (incl. procurement quantity/unit-cost
  # from multi-FY procurement lines). --commit to persist; --fy to scope.
  compute-budget-deltas) shift; exec ./node_modules/.bin/tsx scripts/compute-budget-deltas.ts "$@" ;;
  # One-time canonical PE-year repair: reassemble each program_element_year row from
  # the per-field source-value log (un-clobber multi-source rows + normalize stored
  # thousands â†’ millions). DRY RUN by default; pass --commit to write. Run once,
  # right after deploying the writer fix and before any post-fix re-ingestion.
  rebuild-pe-years) shift; exec ./node_modules/.bin/tsx scripts/rebuild-program-element-years.ts "$@" ;;
  # Value-based companion to rebuild-pe-years: scales any dollar-magnitude PE-year
  # mark down to millions (Ã·1e6). Catches historical enacted/conference rows that
  # had no per-field source-value log for rebuild-pe-years to use. DRY RUN by
  # default; pass --commit. Idempotent.
  normalize-pe-units) shift; exec ./node_modules/.bin/tsx scripts/normalize-pe-units.ts "$@" ;;
  # One-time data move for the NDAA-conference split: relocate every existing
  # program_element_year.conference value into the new ndaa_conference column (outside
  # the appropriations funding ladder) and null conference. DRY RUN by default; pass
  # --commit. Idempotent + non-destructive. Run once, right after deploying this change.
  move-ndaa-conference) shift; exec ./node_modules/.bin/tsx scripts/move-ndaa-conference.ts "$@" ;;
  # One-time ordered backfill + pre-flight key check (Production Ingestion plan,
  # Phase 3). preflight exits non-zero if a REQUIRED key is missing.
  preflight-ingestion) shift; exec ./node_modules/.bin/tsx scripts/preflight-ingestion.ts "$@" ;;

  # PE Watch defense-budget ingestion (LlamaParse PDF + immutable S3 archive).
  # Archives each PDF to the Object-Lock raw bucket BEFORE parsing, records the
  # SourceDocument + DocumentParseJob, and loads independent page-cited assertions.
  ingest-defense-budget) shift; exec ./node_modules/.bin/tsx scripts/ingest-defense-budget-pdf.ts "$@" ;;
  # ONE fully-populated demo client (default tenant: capiro) for product demos:
  # profile + capabilities + people + facilities + strategy + workflow + campaign
  # + engagement activity + intel links + PE 0603270A fixture data + PE watch.
  # DRY RUN unless --commit. Idempotent (re-run refreshes the same named client).
  seed-demo-client) shift; exec ./node_modules/.bin/tsx scripts/seed-demo-client.ts "$@" ;;
  backfill-all) shift; exec ./node_modules/.bin/tsx scripts/backfill-all.ts "$@" ;;
  serve)
    echo "Starting Capiro API"
    exec node dist/main.js
    ;;
  *)
    echo "Unknown command: $1 (expected: serve | migrate | seed-workflows | bootstrap-capiro-admin | bootstrap-tenant | drain-identity-outbox | bootstrap-roles | emit-changes | emit-bill-alerts | emit-clio-alerts | generate-meeting-briefings | backfill-sectors | generate-briefings | compute-health-scores | check-comment-periods | embed-backfill | embed-program-elements | sync-lda | sync-congress | sync-congress-members | sync-cbo | sync-committees | sync-house-votes | sync-senate-votes | derive-bill-status | sync-federal-register | sync-regulations | sync-hearings | sync-hearing-transcripts | sync-gao | sync-crs | sync-fec | sync-federal-award | sync-federal-assistance-awards | enrich-assistance-awards | enrich-award-districts | enrich-award-pe | seed-acq-program-map | report-award-pe-coverage | extract-press-personnel | sync-sam-personnel | sync-fec-pac | sync-fara | sync-fara-enrichment | sync-sec-edgar | sync-rss-intel | sync-openstates | backfill-legiscan-datasets | sync-legiscan-masterlist | sync-legiscan-bills | sync-legistorm-districts | build-district-boundary-artifacts | sync-legistorm-trips | derive-state-bill-status | emit-state-changes | emit-committee-changes | emit-redistricting-alerts | crosswalk-state-people | geocode-facilities | load-state-calendars | normalize-state-committees | backtest-deadline-physics | sync-state-register | set-tenant-flag | sync-bls | sync-bea | sync-census | sync-grants | enrich-grant-details | generate-grant-opportunity-candidates | sync-openlobby |sync-openspending | sync-lobby-trending | refresh-lobby-intel-mv | refresh-kg-edge-cache | sync-comptroller-jbooks | sync-jbook-r2 | import-dow-directory | import-dow-directory-v6 | sync-dow-headshots | generate-pe-person-candidates | auto-confirm-pe-person-candidates | derive-office-program-links | sync-peo-rosters | sync-dod-orgcharts | sync-dod-press-personnel | sync-cpe-roster | recompute-conference-probability | extract-bill-pe-codes | extract-gao-interviewees | extract-hearing-witnesses | parse-hasc-report | parse-sasc-report | parse-hac-d-report | parse-sac-d-report | parse-ndaa-conference | parse-defense-approps-public-law | parse-pdoc | load-defense-budget-package | verify-defense-budget-packages | run-pe-derive-chain | watch-budget-docs | send-pe-alert-emails | match-pe-mentions | rebuild-pe-years | normalize-pe-units | diag-stale-directory | reconcile-personnel-supersede | reconcile-stale-pes | repair-person-pe-links | diag-client-resolution | diag-phantom-imports | diag-clio-memory | diag-memory-recall-parity | backfill-clio-memory-embeddings | run-clio-scheduled-tasks | run-intel-workflows | refresh-memory-graph | prepopulate-all | fill-govids-all)" >&2
    exit 1
    ;;
esac
