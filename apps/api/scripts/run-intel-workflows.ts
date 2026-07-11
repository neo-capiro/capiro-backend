/**
 * Tier-2 agentic worker (Phase 1 M5.1) — run-intel-workflows.
 *
 * Generalizes run-clio-scheduled-tasks.ts's bounded-loop/per-tenant-context/
 * BYOK-credential pattern for UNATTENDED agentic modes triggered by real
 * legislative events rather than a user's cron schedule. Mode registry
 * (agentic doc §3/§10): only `targeting-brief` (M5.2) is wired — amendment-
 * diff (Event Analyst, P0.5) is explicitly DEFERRED: it needs a
 * version/amendment TEXT-diff data source (Congress.gov's amendments
 * sub-resource federally, state_bill_amendment for states) that does not
 * exist in this schema yet; building it blind here would mean fabricating
 * an ingestion pipeline without the feasibility spike this codebase's own
 * discipline requires (PD2's "never guess" standard, applied to scope
 * itself). Rules-comparison assist (M5.3) is likewise deferred to a
 * follow-up pass, not silently dropped.
 *
 * Polls apps/api's OWN truth tables (Chokepoint/District Impact Engine) plus
 * intel-api's `intel_alert` under the blessed cross-realm withSystem-read
 * precedent (intel-api stays read-only and untouched — this worker polls,
 * it never queues). Writes: `ai_run` + `ai_usage_events` (this process,
 * apps/api-owned) and, in the `attach` posture only, two blessed cross-realm
 * WRITES into intel-api's own tables (agentic doc §2 Tier-2 + this plan's
 * M5.4): `intel_alert.evidence.enrichment.targetingBrief` (a targeted
 * jsonb_set — never clobbers sibling `enrichment` keys such as Tier-1 W-D's
 * `enrichment.impact`) and an `intel_action_item` row (kind='targeting_brief').
 * Never through a gated Meri write tool (the gate throws in unattended
 * contexts, by design — PD7).
 *
 * POSTURE (2026-07-10 hot-fix, W1.2 — R7 "new capability ships dark"):
 *   dry    — no `--commit`, no `--shadow`: lists qualifying alerts only
 *            (`INTEL_WORKFLOWS_DRYRUN` log line), makes ZERO LLM calls and
 *            ZERO writes of any kind. The pre-hot-fix default.
 *   shadow — `--shadow`, OR `--commit` without INTEL_WORKFLOWS_TARGETING_ENABLED
 *            set: runs the REAL targeting-brief pipeline (LLM cost; writes
 *            `ai_run` + `ai_usage_events`) but NEVER calls surfaceBrief — zero
 *            cross-realm writes into intel-api's tables. This is the CODE-LEVEL
 *            default for the deployed schedule, which hardcodes `--commit`
 *            (infra/cdk/lib/ingestion-schedule.ts): posture stays dark until
 *            the env flag is explicitly set on the task, independent of
 *            whichever deploy rail (CDK vs out-of-band task-def edit) applies
 *            it — the flag is the ONLY thing that can flip posture to attach.
 *   attach — `--commit` AND INTEL_WORKFLOWS_TARGETING_ENABLED=true|1|yes: the
 *            full pipeline, including the two blessed cross-realm writes.
 *
 *   pnpm --filter @capiro/api exec tsx scripts/run-intel-workflows.ts --commit
 *   pnpm --filter @capiro/api exec tsx scripts/run-intel-workflows.ts --shadow
 *
 * Liveness: wrapped in runWithSyncRun (2026-07-10 hot-fix, W1.2) — the SAME
 * SyncRun lifecycle + INGESTION_METRIC emission every other ingestion script
 * uses (source='run-intel-workflows'), rather than a bespoke duplicate. The
 * shared `IngestionErrorMetricFilter` (infra/cdk/lib/compute-stack.ts) + its
 * CloudWatch alarm already watch this pattern aggregate-wide, so a silent
 * per-alert failure here pages the same way a silent ingestion failure does.
 * `skipIfRunning: true` guards against an overlapping invocation (the
 * standard one-instance-per-job convention every other scheduled script
 * gets). (The plan's own text names this "sync-task-failures→SNS"; no
 * script by that name exists — this IS the real, already-built mechanism it
 * was describing.)
 */
import { config as dotenvConfig } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AnthropicLlmClient } from '@capiro/meriv2-core';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';

dotenvConfig();

const WANTS_COMMIT = process.argv.includes('--commit');
const WANTS_SHADOW = process.argv.includes('--shadow');
const TARGETING_ENABLED = ['true', '1', 'yes'].includes(
  (process.env.INTEL_WORKFLOWS_TARGETING_ENABLED ?? '').toLowerCase(),
);

export type Posture = 'dry' | 'shadow' | 'attach';

/** See the POSTURE doc block above — the code-level dark-by-default gate. */
export const POSTURE: Posture =
  !WANTS_COMMIT && !WANTS_SHADOW ? 'dry' : WANTS_COMMIT && TARGETING_ENABLED ? 'attach' : 'shadow';

const MAX_ALERTS_PER_RUN = Number(process.env.INTEL_WORKFLOWS_MAX_PER_RUN ?? '25');
const LOOKBACK_HOURS = Number(process.env.INTEL_WORKFLOWS_LOOKBACK_HOURS ?? '48');

interface QualifyingAlert {
  id: string;
  tenant_id: string;
  client_id: string;
  source_type: string;
  source_ref: string;
  title: string;
  severity: string;
}

async function loadNest(): Promise<{
  AppModule: any;
  PrismaService: any;
  AiCredentialResolverService: any;
  TargetingBriefService: any;
}> {
  for (const base of ['../dist', '../src']) {
    try {
      const app = await import(`${base}/app.module.js`);
      const prisma = await import(`${base}/prisma/prisma.service.js`);
      const cred = await import(`${base}/engagement/ai-credential-resolver.service.js`);
      const brief = await import(`${base}/agentic/targeting-brief.service.js`);
      return {
        AppModule: app.AppModule,
        PrismaService: prisma.PrismaService,
        AiCredentialResolverService: cred.AiCredentialResolverService,
        TargetingBriefService: brief.TargetingBriefService,
      };
    } catch {
      // try next base
    }
  }
  throw new Error('Could not load AppModule from dist or src');
}

// Exported as a named const (2026-07-10 hot-fix, W1.1 durable safety net) so
// a DB-free static spec can assert every table it references exists in the
// union of apps/api + apps/intel-api's @@map table-name sets — this is the
// query that referenced the non-existent `client_facility` (now
// `client_facilities`, the real ClientFacility model's mapped name).
export const FIND_QUALIFYING_ALERTS_SQL = `SELECT a.id, a.tenant_id, a.client_id, a.source_type, a.source_ref, a.title, a.severity
       FROM intel_alert a
       WHERE a.source_type IN ('bill', 'state_bill')
         AND a.severity IN ('critical', 'notable')
         AND a.created_at > now() - ($1 * interval '1 hour')
         AND a.client_id IS NOT NULL
         -- LANDMINE (PG 42883, "operator does not exist: uuid = text"): every
         -- intel_* client_id/tenant_id column is TEXT while apps/api's own
         -- client_facilities.client_id is UUID — cast the UUID side (same
         -- convention as intel-api's own RLS-hold migration).
         AND EXISTS (
           SELECT 1 FROM client_facilities cf WHERE cf.client_id::text = a.client_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM intel_action_item ai
           WHERE ai.alert_id = a.id AND ai.kind = 'targeting_brief'
         )
         -- W2.3: the action-item NOT EXISTS above only excludes a brief that
         -- reached attach and surfaced. A QA-held (qaStatus=pending) or
         -- zero-target (brief.targets.length===0) brief never creates that
         -- row, so without this second guard it silently regenerates --
         -- burning BYOK spend and an ai_usage_events row -- on EVERY run until
         -- a human clears QA or the inputs change. ai_run has no alert_id or
         -- client_id column (see the model), so this keys on the coarser
         -- (workflow, subjectKey=billKey, tenant) instead -- a bill shared by
         -- two clients in the same tenant is a known, accepted narrowing of
         -- this guard's granularity vs. the per-alert one above.
         AND NOT EXISTS (
           SELECT 1 FROM ai_run r
           WHERE r.workflow = 'intel_targeting'
             AND r.subject_key = a.source_ref
             AND r.tenant_id::text = a.tenant_id
             AND r.created_at > now() - ($1 * interval '1 hour')
         )
       ORDER BY a.created_at ASC
       LIMIT ${MAX_ALERTS_PER_RUN}`;

/**
 * Cross-realm read (the blessed withSystem precedent — apps/api has no
 * Prisma model for intel_* tables): bill/state_bill alerts from the last
 * `LOOKBACK_HOURS`, severity high enough to be worth a targeting brief, that
 * don't already have one (idempotent re-runs never duplicate work). Client
 * must have at least one facility (a targeting brief with no facility
 * footprint would have nothing to say about district overlap) — cheap
 * pre-filter via apps/api's OWN client_facilities table, joined by client_id.
 */
export async function findQualifyingAlerts(prisma: any): Promise<QualifyingAlert[]> {
  return prisma.withSystem((tx: any) =>
    tx.$queryRawUnsafe(FIND_QUALIFYING_ALERTS_SQL, LOOKBACK_HOURS),
  );
}

// 2026-07-10 hot-fix (W1.3): targeted jsonb_set at `{enrichment,targetingBrief}`
// instead of a top-level `evidence || $1` merge — the old shallow merge
// replaced the ENTIRE `enrichment` object on every write, clobbering sibling
// keys another writer (e.g. Tier-1 W-D's alert-enrichment endpoint, which
// writes `enrichment.impact`) had already set on the same alert row.
// jsonb_set's 4th arg (create_missing, default true) creates the `enrichment`
// object automatically when it doesn't exist yet — no separate "does
// enrichment exist" branch needed.
export const SURFACE_BRIEF_UPDATE_SQL = `UPDATE intel_alert
       SET evidence = jsonb_set(
         COALESCE(evidence, '{}'::jsonb),
         '{enrichment,targetingBrief}',
         $1::jsonb,
         true
       )
       WHERE id = $2 AND tenant_id = $3`;

// intel_action_item.id is a plain TEXT column with an application-level
// (Prisma cuid()) default, not a DB default — this raw insert generates its
// own id value (a UUID string is valid TEXT content, just a cosmetically
// different format from Prisma-driven rows' cuid()s). The ON CONFLICT
// predicate must exactly match a real partial unique index — widened by
// apps/intel-api's 20260710050000_intel_action_item_targeting_brief
// migration, which MUST be deployed before this worker's `attach` posture is
// ever enabled (structurally enforced by the default-dark posture above).
export const SURFACE_BRIEF_INSERT_SQL = `INSERT INTO intel_action_item (id, tenant_id, client_id, alert_id, kind, title, created_by, created_at, updated_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'targeting_brief', $4, 'run-intel-workflows', now(), now())
       ON CONFLICT (alert_id, kind) WHERE kind IN ('memo', 'report', 'targeting_brief')
       DO UPDATE SET title = EXCLUDED.title, updated_at = now()`;

/**
 * The two blessed cross-realm writes (agentic doc §2 Tier-2 + M5.4), called
 * ONLY in the `attach` posture. Both under withSystem with an explicit
 * tenant_id bind — RLS is satisfied via the bypass branch regardless of
 * whether intel-api's own RLS-hold migration has actually landed yet.
 */
export async function surfaceBrief(
  prisma: any,
  alert: QualifyingAlert,
  brief: { targets: unknown[]; recommendedSequence: string[] },
): Promise<void> {
  await prisma.withSystem(async (tx: any) => {
    await tx.$executeRawUnsafe(
      SURFACE_BRIEF_UPDATE_SQL,
      JSON.stringify(brief),
      alert.id,
      alert.tenant_id,
    );
    await tx.$executeRawUnsafe(
      SURFACE_BRIEF_INSERT_SQL,
      alert.tenant_id,
      alert.client_id,
      alert.id,
      `Targeting brief: ${alert.title}`.slice(0, 200),
    );
  });
}

export type BriefOutcome = 'skip_zero_target' | 'held' | 'surface' | 'shadow';

/**
 * Decide what the worker does with a generated brief, given the run posture.
 * Pure + exported so the W2.3 idempotency-adjacent invariant — a QA-held
 * (`qaStatus==='pending'`) or zero-target brief NEVER surfaces a cross-realm
 * write, and only `attach` posture surfaces at all — is unit-testable without
 * booting Nest. Pairs with the SQL guard (FIND_QUALIFYING_ALERTS_SQL): the SQL
 * stops a bill from being re-generated once it has a recent `ai_run`; this
 * decides, per generation, whether the result surfaces.
 */
export function classifyBriefOutcome(
  brief: { targets: unknown[]; qaStatus: string },
  posture: Posture,
): BriefOutcome {
  if (!brief.targets.length) return 'skip_zero_target';
  if (brief.qaStatus === 'pending') return 'held';
  return posture === 'attach' ? 'surface' : 'shadow';
}

export async function main(): Promise<void> {
  const logger = new Logger('run-intel-workflows');
  const { AppModule, PrismaService, AiCredentialResolverService, TargetingBriefService } =
    await loadNest();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  try {
    const prisma = app.get(PrismaService);
    const aiCreds = app.get(AiCredentialResolverService);
    const targetingBrief = app.get(TargetingBriefService);

    await runWithSyncRun(
      prisma,
      'run-intel-workflows',
      async () => {
        let processed = 0;
        let surfaced = 0;
        let shadowed = 0;
        let held = 0;
        let roundErrors = 0;

        const alerts: QualifyingAlert[] = await findQualifyingAlerts(prisma);
        logger.log(`${alerts.length} qualifying alert(s) for targeting-brief; posture=${POSTURE}`);
        if (POSTURE === 'dry') {
          // eslint-disable-next-line no-console
          console.log(
            'INTEL_WORKFLOWS_DRYRUN ' +
              JSON.stringify({
                posture: POSTURE,
                count: alerts.length,
                alerts: alerts.map((a) => ({ id: a.id, billKey: a.source_ref, title: a.title })),
              }),
          );
          return { inserted: 0, updated: 0, skipped: alerts.length, errors: 0 };
        }

        for (const alert of alerts) {
          processed += 1;
          try {
            const resolved = await aiCreds.resolveProvider(
              { tenantId: alert.tenant_id },
              'anthropic',
            );
            if (!resolved?.apiKey) {
              logger.warn(`[alert ${alert.id}] no Anthropic credential; skipping`);
              continue;
            }
            const llm = new AnthropicLlmClient({ apiKey: resolved.apiKey, model: resolved.model });
            const brief = await targetingBrief.generate(
              {
                alertId: alert.id,
                tenantId: alert.tenant_id,
                clientId: alert.client_id,
                billKey: alert.source_ref,
                billTitle: alert.title,
              },
              llm,
              { model: resolved.model, usedTenantKey: resolved.usedTenantKey },
            );
            const outcome = classifyBriefOutcome(brief, POSTURE);
            if (outcome === 'skip_zero_target') continue;
            if (outcome === 'held') {
              held += 1;
              continue; // ai_run already carries the pending brief; nothing surfaces yet
            }
            if (outcome === 'surface') {
              await surfaceBrief(prisma, alert, brief);
              surfaced += 1;
            } else {
              // shadow: generate() already ran for real (ai_run + ai_usage_events
              // written) — the cross-realm write is intentionally skipped (R7).
              shadowed += 1;
            }
          } catch (err) {
            roundErrors += 1;
            logger.warn(`[alert ${alert.id}] targeting-brief failed: ${(err as Error).message}`);
          }
        }

        logger.log(
          `done: posture=${POSTURE} processed=${processed} surfaced=${surfaced} shadowed=${shadowed} ` +
            `held_for_qa=${held} errors=${roundErrors}`,
        );
        return { inserted: surfaced, updated: held + shadowed, skipped: 0, errors: roundErrors };
      },
      { skipIfRunning: true },
    );
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[run-intel-workflows] FAILED', err);
    process.exit(1);
  });
}
