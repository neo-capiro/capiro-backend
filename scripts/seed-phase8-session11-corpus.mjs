#!/usr/bin/env node
/**
 * Phase 8 Session 11 — disposable-database rehearsal corpus.
 *
 * Seeds a historically-grounded, multi-fiscal-year, multi-track scenario
 * derived from the SAME real corpus Session 7 already proved against
 * (`apps/defense-api/src/budget-lifecycle/testing/fixture-ports.ts`) — same
 * technique Session 10 used for its own merge-gate proof (`FY2032_HASC_REPORT`,
 * cloned from the real FY2024 fixture with only the year changed, because the
 * classifier is deliberately year-agnostic). Nothing here is invented
 * monetary data — this domain carries none by construction.
 *
 * Scenario, spanning two OVERLAPPING fiscal years:
 *  FY2027 request           — PB overview, published, adapter dod-comptroller (made STALE)
 *  FY2027 authorization     — HASC report: a corrected (superseded -> current) pair
 *  FY2027 appropriations    — HAC-D report: review_required (ambiguous), resolved by the CLI later
 *  FY2027 alternative_funding — Ukraine-style supplemental, not_filed (a recorded state, not zero)
 *  FY2028 authorization     — SASC report, published (independent of FY2027's authorization)
 *  FY2028 appropriations    — SAC-D report, not_filed (independent of FY2027's appropriations)
 *
 * Watcher/schedule: one healthy adapter, one stale adapter, one completed
 * tick, one failed tick — both coverage states the product surface reports.
 */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const appRoot = path.join(repoRoot, 'apps/defense-api');
const { PrismaClient } = require(path.join(appRoot, 'generated/prisma-client/index.js'));

const sha = (seed) => createHash('sha256').update(`phase8-session11-rehearsal:${seed}`).digest('hex');
const dedup = (seed) => createHash('sha256').update(`phase8-session11-rehearsal-dedup:${seed}`).digest('hex');

const prisma = new PrismaClient();

const CYCLE_2027_REQUEST = '10000000-0000-0000-0000-000000002701';
const CYCLE_2027_AUTH = '10000000-0000-0000-0000-000000002702';
const CYCLE_2027_APPR = '10000000-0000-0000-0000-000000002703';
const CYCLE_2027_ALT = '10000000-0000-0000-0000-000000002704';
const CYCLE_2028_AUTH = '10000000-0000-0000-0000-000000002802';
const CYCLE_2028_APPR = '10000000-0000-0000-0000-000000002803';

const ES_PB_2027 = '20000000-0000-0000-0000-000000000001';
const ES_HASC_2027 = '20000000-0000-0000-0000-000000000002';
const ES_HACD_2027 = '20000000-0000-0000-0000-000000000003';
const ES_ALT_2027 = '20000000-0000-0000-0000-000000000004';
const ES_SASC_2028 = '20000000-0000-0000-0000-000000000005';
const ES_SACD_2028 = '20000000-0000-0000-0000-000000000006';

const OBS_PB_2027 = '30000000-0000-0000-0000-000000000001';
const OBS_HASC_2027_V1 = '30000000-0000-0000-0000-000000000002';
const OBS_HASC_2027_V2 = '30000000-0000-0000-0000-000000000003';
const OBS_HACD_2027 = '30000000-0000-0000-0000-000000000004';
const OBS_SASC_2028 = '30000000-0000-0000-0000-000000000005';

const DOC_PB_2027 = '40000000-0000-0000-0000-000000000001';
const DOC_HASC_2027_V2 = '40000000-0000-0000-0000-000000000002';
const DOC_SASC_2028 = '40000000-0000-0000-0000-000000000003';

async function main() {
  await prisma.$transaction([
    // ── Immutable source-document identity (required by the `ingested` CHECK) ─
    prisma.$executeRawUnsafe(
      `INSERT INTO source_document
         (id, source_key, fiscal_year, budget_cycle, document_type, title, source_url, sha256,
          byte_size, extraction_method)
       VALUES
        ($1::uuid,'phase8-session11-rehearsal:pb-2027',2027,'request','pb_overview',
         'FY2027 President''s Budget Request Overview',
         'https://comptroller.defense.gov/Portals/45/Documents/defbudget/FY2027/FY2027_Budget_Request_Overview_Book.pdf',
         $2,2048,'deterministic_primary'),
        ($3::uuid,'phase8-session11-rehearsal:hasc-2027-v2',2027,'authorization','auth_committee_report',
         'House Report 999-125 - NDAA FOR FISCAL YEAR 2027 (corrected)',
         'https://www.govinfo.gov/content/pkg/CRPT-999hrpt125/pdf/CRPT-999hrpt125-corrected.pdf',
         $4,4224,'deterministic_primary'),
        ($5::uuid,'phase8-session11-rehearsal:sasc-2028',2028,'authorization','auth_committee_report',
         'Senate Report 999-58 - NDAA FOR FISCAL YEAR 2028',
         'https://www.govinfo.gov/content/pkg/CRPT-999srpt58/pdf/CRPT-999srpt58.pdf',
         $6,4096,'deterministic_primary')
       ON CONFLICT (source_key, sha256) DO NOTHING`,
      DOC_PB_2027, sha('crpt-999-pb-2027'),
      DOC_HASC_2027_V2, sha('crpt-999hrpt125-v2-corrected'),
      DOC_SASC_2028, sha('crpt-999srpt58'),
    ),

    // ── Cycles ────────────────────────────────────────────────────────────
    prisma.$executeRawUnsafe(
      `INSERT INTO defense_budget_cycle (id, fiscal_year, authority_track, status, template_version, bootstrap_origin, dedup_key)
       VALUES ($1::uuid,2027,'request','active','v1','template',$2),
              ($3::uuid,2027,'authorization','active','v1','template',$4),
              ($5::uuid,2027,'appropriations','active','v1','template',$6),
              ($7::uuid,2027,'alternative_funding','active','v1','template',$8),
              ($9::uuid,2028,'authorization','active','v1','template',$10),
              ($11::uuid,2028,'appropriations','active','v1','template',$12)
       ON CONFLICT (fiscal_year, authority_track) DO NOTHING`,
      CYCLE_2027_REQUEST, dedup('cycle-2027-request'),
      CYCLE_2027_AUTH, dedup('cycle-2027-authorization'),
      CYCLE_2027_APPR, dedup('cycle-2027-appropriations'),
      CYCLE_2027_ALT, dedup('cycle-2027-alternative_funding'),
      CYCLE_2028_AUTH, dedup('cycle-2028-authorization'),
      CYCLE_2028_APPR, dedup('cycle-2028-appropriations'),
    ),

    // ── Expected sources ──────────────────────────────────────────────────
    prisma.$executeRawUnsafe(
      `INSERT INTO defense_budget_expected_source
         (id, cycle_id, fiscal_year, authority_track, stage, source_family, chamber, committee,
          adapter_id, label, expected_state, optional, template_version, expected_from, expected_to, dedup_key, review_reason)
       VALUES
        ($1::uuid,$2::uuid,2027,'request','president_budget_request','pb_overview',NULL,NULL,
         'dod-comptroller','FY2027 President''s Budget Request Overview','published',false,'v1',
         now() - interval '400 days', now() + interval '1 day', $3, NULL),
        ($4::uuid,$5::uuid,2027,'authorization','hasc_report','auth_committee_report','house','HASC',
         'govinfo-committee-reports','House Report 999-125 - NDAA FOR FISCAL YEAR 2027','published',false,'v1',
         now() - interval '300 days', now() + interval '1 day', $6, NULL),
        ($7::uuid,$8::uuid,2027,'appropriations','hac_d_report','appr_committee_report','house','HAC-D',
         'govinfo-committee-reports','House Report 999-121 - DEPARTMENT OF DEFENSE APPROPRIATIONS BILL, 2027','review_required',false,'v1',
         now() - interval '200 days', now() + interval '1 day', $9,
         'classification confidence 0.62 below the 0.8 accept threshold; content excerpt did not corroborate metadata'),
        ($10::uuid,$11::uuid,2027,'alternative_funding','emergency_supplemental','alt_supplemental',NULL,NULL,
         'govinfo-public-laws','Security Supplemental Appropriations Act, 2027','not_filed',true,'v1',
         now() - interval '100 days', now() + interval '1 day', $12, NULL),
        ($13::uuid,$14::uuid,2028,'authorization','sasc_report','auth_committee_report','senate','SASC',
         'govinfo-committee-reports','Senate Report 999-58 - NDAA FOR FISCAL YEAR 2028','published',false,'v1',
         now() - interval '30 days', now() + interval '300 days', $15, NULL),
        ($16::uuid,$17::uuid,2028,'appropriations','sac_d_report','appr_committee_report','senate','SAC-D',
         'govinfo-committee-reports','Senate Report 999-81 - DEPARTMENT OF DEFENSE APPROPRIATIONS BILL, 2028','not_filed',false,'v1',
         now() - interval '30 days', now() + interval '300 days', $18, NULL)
       ON CONFLICT (dedup_key) DO NOTHING`,
      ES_PB_2027, CYCLE_2027_REQUEST, dedup('es-2027-pb'),
      ES_HASC_2027, CYCLE_2027_AUTH, dedup('es-2027-hasc'),
      ES_HACD_2027, CYCLE_2027_APPR, dedup('es-2027-hacd'),
      ES_ALT_2027, CYCLE_2027_ALT, dedup('es-2027-alt-supplemental'),
      ES_SASC_2028, CYCLE_2028_AUTH, dedup('es-2028-sasc'),
      ES_SACD_2028, CYCLE_2028_APPR, dedup('es-2028-sacd'),
    ),

    // ── Observations: PB (ingested), HASC v1->v2 (superseded->current), HAC-D (review_required), SASC (ingested) ──
    prisma.$executeRawUnsafe(
      `INSERT INTO defense_budget_source_observation
         (id, expected_source_id, cycle_id, adapter_id, discovered_url, content_sha256, byte_size,
          observation_state, revision_kind, classified_fiscal_year, classified_authority_track,
          classified_stage, classified_source_family, classification_confidence, review_reasons,
          source_document_id, first_seen_at, last_seen_at, dedup_key)
       VALUES
        ($1::uuid,$2::uuid,$3::uuid,'dod-comptroller',
         'https://comptroller.defense.gov/Portals/45/Documents/defbudget/FY2027/FY2027_Budget_Request_Overview_Book.pdf',
         $4,2048,'ingested','first_discovery',2027,'request','president_budget_request','pb_overview',0.99,'[]',
         $6::uuid, now() - interval '395 days', now() - interval '395 days', $5)
       ON CONFLICT (expected_source_id, content_sha256) DO NOTHING`,
      OBS_PB_2027, ES_PB_2027, CYCLE_2027_REQUEST, sha('crpt-999-pb-2027'), dedup('obs-2027-pb'), DOC_PB_2027,
    ),
    prisma.$executeRawUnsafe(
      `INSERT INTO defense_budget_source_observation
         (id, expected_source_id, cycle_id, adapter_id, discovered_url, content_sha256, byte_size,
          observation_state, revision_kind, classified_fiscal_year, classified_authority_track,
          classified_stage, classified_source_family, classification_confidence, review_reasons,
          first_seen_at, last_seen_at, dedup_key)
       VALUES ($1::uuid,$2::uuid,$3::uuid,'govinfo-committee-reports',
         'https://www.govinfo.gov/content/pkg/CRPT-999hrpt125/pdf/CRPT-999hrpt125.pdf',
         $4,4096,'classified','first_discovery',2027,'authorization','hasc_report','auth_committee_report',0.97,'[]',
         now() - interval '290 days', now() - interval '290 days', $5)
       ON CONFLICT (expected_source_id, content_sha256) DO NOTHING`,
      OBS_HASC_2027_V1, ES_HASC_2027, CYCLE_2027_AUTH, sha('crpt-999hrpt125-v1'), dedup('obs-2027-hasc-v1'),
    ),
    prisma.$executeRawUnsafe(
      `INSERT INTO defense_budget_source_observation
         (id, expected_source_id, cycle_id, adapter_id, discovered_url, content_sha256, byte_size,
          observation_state, revision_kind, classified_fiscal_year, classified_authority_track,
          classified_stage, classified_source_family, classification_confidence, review_reasons,
          source_document_id, first_seen_at, last_seen_at, dedup_key)
       VALUES ($1::uuid,$2::uuid,$3::uuid,'govinfo-committee-reports',
         'https://www.govinfo.gov/content/pkg/CRPT-999hrpt125/pdf/CRPT-999hrpt125-corrected.pdf',
         $4,4224,'ingested','superseding_version',2027,'authorization','hasc_report','auth_committee_report',0.98,'[]',
         $6::uuid, now() - interval '285 days', now() - interval '285 days', $5)
       ON CONFLICT (expected_source_id, content_sha256) DO NOTHING`,
      OBS_HASC_2027_V2, ES_HASC_2027, CYCLE_2027_AUTH, sha('crpt-999hrpt125-v2-corrected'), dedup('obs-2027-hasc-v2'), DOC_HASC_2027_V2,
    ),
    prisma.$executeRawUnsafe(
      `UPDATE defense_budget_source_observation SET superseded_by_observation_id = $2::uuid, observation_state = 'superseded'
        WHERE id = $1::uuid`,
      OBS_HASC_2027_V1, OBS_HASC_2027_V2,
    ),
    prisma.$executeRawUnsafe(
      `INSERT INTO defense_budget_source_observation
         (id, expected_source_id, cycle_id, adapter_id, discovered_url, content_sha256, byte_size,
          observation_state, revision_kind, classification_confidence, review_reasons,
          first_seen_at, last_seen_at, dedup_key)
       VALUES ($1::uuid,$2::uuid,$3::uuid,'govinfo-committee-reports',
         'https://www.govinfo.gov/content/pkg/CRPT-999hrpt121/pdf/CRPT-999hrpt121.pdf',
         $4,3072,'review_required','first_discovery',0.62,
         '["content excerpt did not corroborate metadata","classification confidence below 0.8 accept threshold"]'::jsonb,
         now() - interval '190 days', now() - interval '190 days', $5)
       ON CONFLICT (expected_source_id, content_sha256) DO NOTHING`,
      OBS_HACD_2027, ES_HACD_2027, CYCLE_2027_APPR, sha('crpt-999hrpt121'), dedup('obs-2027-hacd'),
    ),
    prisma.$executeRawUnsafe(
      `INSERT INTO defense_budget_source_observation
         (id, expected_source_id, cycle_id, adapter_id, discovered_url, content_sha256, byte_size,
          observation_state, revision_kind, classified_fiscal_year, classified_authority_track,
          classified_stage, classified_source_family, classification_confidence, review_reasons,
          source_document_id, first_seen_at, last_seen_at, dedup_key)
       VALUES ($1::uuid,$2::uuid,$3::uuid,'govinfo-committee-reports',
         'https://www.govinfo.gov/content/pkg/CRPT-999srpt58/pdf/CRPT-999srpt58.pdf',
         $4,4096,'ingested','first_discovery',2028,'authorization','sasc_report','auth_committee_report',0.96,'[]',
         $6::uuid, now() - interval '25 days', now() - interval '25 days', $5)
       ON CONFLICT (expected_source_id, content_sha256) DO NOTHING`,
      OBS_SASC_2028, ES_SASC_2028, CYCLE_2028_AUTH, sha('crpt-999srpt58'), dedup('obs-2028-sasc'), DOC_SASC_2028,
    ),

    // ── Watcher adapters: one healthy, one stale ─────────────────────────
    prisma.$executeRawUnsafe(
      `INSERT INTO defense_budget_watcher_adapter (adapter_id, status, next_check_at, last_check_at, last_success_at, consecutive_failures)
       VALUES ('govinfo-committee-reports','idle', now() + interval '1 day', now() - interval '10 minutes', now() - interval '10 minutes', 0),
              ('dod-comptroller','failing', now() - interval '2 days', now() - interval '5 days', now() - interval '5 days', 3)
       ON CONFLICT (adapter_id) DO UPDATE SET
         status = EXCLUDED.status, next_check_at = EXCLUDED.next_check_at,
         last_check_at = EXCLUDED.last_check_at, last_success_at = EXCLUDED.last_success_at,
         consecutive_failures = EXCLUDED.consecutive_failures`,
    ),
    prisma.$executeRawUnsafe(
      `INSERT INTO defense_budget_watcher_run
         (adapter_id, run_key, status, started_at, finished_at, discovered_count, unchanged_count,
          changed_count, review_count, queued_count, blocked_count, next_check_at)
       VALUES
        ('govinfo-committee-reports','rehearsal-run-1','succeeded', now() - interval '15 minutes', now() - interval '10 minutes',
         3, 0, 3, 1, 2, 0, now() + interval '1 day'),
        ('dod-comptroller','rehearsal-run-1','failed', now() - interval '5 days 1 hour', now() - interval '5 days',
         0, 0, 0, 0, 0, 1, now() - interval '2 days')
       ON CONFLICT (adapter_id, run_key) DO NOTHING`,
    ),

    // ── Ingestion outbox ──────────────────────────────────────────────────
    prisma.$executeRawUnsafe(
      `INSERT INTO defense_budget_ingestion_outbox (observation_id, observation_state, cycle_id, job_kind, state, dedup_key)
       VALUES ($1::uuid,'ingested',$2::uuid,'governed_source_ingestion','succeeded',$3),
              ($4::uuid,'ingested',$5::uuid,'governed_source_ingestion','succeeded',$6)
       ON CONFLICT (observation_id, job_kind) DO NOTHING`,
      OBS_PB_2027, CYCLE_2027_REQUEST, dedup('outbox-pb-2027'),
      OBS_HASC_2027_V2, CYCLE_2027_AUTH, dedup('outbox-hasc-2027-v2'),
    ),

    // ── Schedule ticks: one completed, one failed ────────────────────────
    prisma.$executeRawUnsafe(
      `INSERT INTO defense_budget_schedule_tick
         (worker_id, tick_key, started_at, finished_at, outcome, horizon_bootstrapped,
          adapters_considered, adapters_due, adapters_succeeded, adapters_failed, adapters_skipped_lease,
          committed, failure_reason)
       VALUES
        ('rehearsal-worker','rehearsal-tick-1', now() - interval '15 minutes', now() - interval '10 minutes',
         'completed', false, 14, 1, 1, 0, 0, true, NULL),
        ('rehearsal-worker','rehearsal-tick-2', now() - interval '5 days 1 hour', now() - interval '5 days',
         'failed', false, 14, 1, 0, 1, 0, true, 'dod-comptroller: publisher returned HTTP 403')
       ON CONFLICT (worker_id, tick_key) DO NOTHING`,
    ),
  ]);

  console.log('SESSION11_REHEARSAL_CORPUS_SEEDED');
  console.log(JSON.stringify({
    ES_PB_2027, ES_HASC_2027, ES_HACD_2027, ES_ALT_2027, ES_SASC_2028, ES_SACD_2028,
    OBS_PB_2027, OBS_HASC_2027_V1, OBS_HASC_2027_V2, OBS_HACD_2027, OBS_SASC_2028,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
