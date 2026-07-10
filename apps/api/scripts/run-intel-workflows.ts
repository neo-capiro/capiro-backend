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
 * apps/api-owned) and, for an approved (non-QA-held) brief, two NEW blessed
 * cross-realm WRITES into intel-api's own tables (agentic doc §2 Tier-2 +
 * this plan's M5.4): `intel_alert.evidence.enrichment` (a jsonb merge) and
 * an `intel_action_item` row (kind='targeting_brief'). Never through a
 * gated Meri write tool (the gate throws in unattended contexts, by design
 * — PD7).
 *
 *   pnpm --filter @capiro/api exec tsx scripts/run-intel-workflows.ts --commit
 *
 * Liveness (not just ai_run/ai_usage_events accounting): on failure, emits
 * the SAME `INGESTION_METRIC {...error_count...}` log-line convention every
 * other apps/api sync script uses (sync-regulations.ts et al) — the shared
 * `IngestionErrorMetricFilter` (infra/cdk/lib/compute-stack.ts) + its
 * CloudWatch alarm already watch this pattern aggregate-wide, so a silent
 * failure here pages the same way a silent ingestion failure does. (The
 * plan's own text names this "sync-task-failures→SNS"; no script by that
 * name exists — this IS the real, already-built mechanism it was
 * describing.)
 */
import { config as dotenvConfig } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AnthropicLlmClient } from '@capiro/meriv2-core';

dotenvConfig();

const DRY_RUN = !process.argv.includes('--commit');
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

/**
 * Cross-realm read (the blessed withSystem precedent — apps/api has no
 * Prisma model for intel_* tables): bill/state_bill alerts from the last
 * `LOOKBACK_HOURS`, severity high enough to be worth a targeting brief, that
 * don't already have one (idempotent re-runs never duplicate work). Client
 * must have at least one facility (a targeting brief with no facility
 * footprint would have nothing to say about district overlap) — cheap
 * pre-filter via apps/api's OWN client_facility table, joined by client_id.
 */
async function findQualifyingAlerts(prisma: any): Promise<QualifyingAlert[]> {
  return prisma.withSystem((tx: any) =>
    tx.$queryRawUnsafe(
      `SELECT a.id, a.tenant_id, a.client_id, a.source_type, a.source_ref, a.title, a.severity
       FROM intel_alert a
       WHERE a.source_type IN ('bill', 'state_bill')
         AND a.severity IN ('critical', 'notable')
         AND a.created_at > now() - ($1 * interval '1 hour')
         AND a.client_id IS NOT NULL
         -- LANDMINE (PG 42883, "operator does not exist: uuid = text"): every
         -- intel_* client_id/tenant_id column is TEXT while apps/api's own
         -- client_facility.client_id is UUID — cast the UUID side (same
         -- convention as intel-api's own RLS-hold migration).
         AND EXISTS (
           SELECT 1 FROM client_facility cf WHERE cf.client_id::text = a.client_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM intel_action_item ai
           WHERE ai.alert_id = a.id AND ai.kind = 'targeting_brief'
         )
       ORDER BY a.created_at ASC
       LIMIT ${MAX_ALERTS_PER_RUN}`,
      LOOKBACK_HOURS,
    ),
  );
}

/**
 * The two blessed cross-realm writes (agentic doc §2 Tier-2 + M5.4): a
 * jsonb MERGE onto intel_alert.evidence (never clobbers sibling keys) + an
 * intel_action_item insert. Both under withSystem with an explicit
 * tenant_id bind — RLS is satisfied via the bypass branch regardless of
 * whether intel-api's own RLS-hold migration has actually landed yet.
 */
async function surfaceBrief(
  prisma: any,
  alert: QualifyingAlert,
  brief: { targets: unknown[]; recommendedSequence: string[] },
): Promise<void> {
  await prisma.withSystem(async (tx: any) => {
    await tx.$executeRawUnsafe(
      `UPDATE intel_alert
       SET evidence = evidence || $1::jsonb
       WHERE id = $2 AND tenant_id = $3`,
      JSON.stringify({ enrichment: { targetingBrief: brief } }),
      alert.id,
      alert.tenant_id,
    );
    // intel_action_item.id is a plain TEXT column with an application-level
    // (Prisma cuid()) default, not a DB default — this raw insert generates
    // its own id value (a UUID string is valid TEXT content, just a
    // cosmetically different format from Prisma-driven rows' cuid()s).
    await tx.$executeRawUnsafe(
      `INSERT INTO intel_action_item (id, tenant_id, client_id, alert_id, kind, title, created_by, created_at, updated_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'targeting_brief', $4, 'run-intel-workflows', now(), now())
       ON CONFLICT (alert_id, kind) WHERE kind IN ('memo', 'report', 'targeting_brief')
       DO UPDATE SET title = EXCLUDED.title, updated_at = now()`,
      alert.tenant_id,
      alert.client_id,
      alert.id,
      `Targeting brief: ${alert.title}`.slice(0, 200),
    );
  });
}

async function main(): Promise<void> {
  const logger = new Logger('run-intel-workflows');
  const t0 = Date.now();
  const { AppModule, PrismaService, AiCredentialResolverService, TargetingBriefService } =
    await loadNest();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
  let errorCount = 0;
  let processed = 0;
  let surfaced = 0;
  let held = 0;
  try {
    const prisma = app.get(PrismaService);
    const aiCreds = app.get(AiCredentialResolverService);
    const targetingBrief = app.get(TargetingBriefService);

    const alerts: QualifyingAlert[] = await findQualifyingAlerts(prisma);
    logger.log(`${alerts.length} qualifying alert(s) for targeting-brief; dryRun=${DRY_RUN}`);
    if (DRY_RUN) {
      // eslint-disable-next-line no-console
      console.log(
        'INTEL_WORKFLOWS_DRYRUN ' +
          JSON.stringify({
            count: alerts.length,
            alerts: alerts.map((a) => ({ id: a.id, billKey: a.source_ref, title: a.title })),
          }),
      );
      return;
    }

    for (const alert of alerts) {
      processed += 1;
      try {
        const resolved = await aiCreds.resolveProvider({ tenantId: alert.tenant_id }, 'anthropic');
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
        if (!brief.targets.length) continue;
        if (brief.qaStatus === 'pending') {
          held += 1;
          continue; // ai_run already carries the pending brief; nothing surfaces yet
        }
        await surfaceBrief(prisma, alert, brief);
        surfaced += 1;
      } catch (err) {
        errorCount += 1;
        logger.warn(`[alert ${alert.id}] targeting-brief failed: ${(err as Error).message}`);
      }
    }

    logger.log(
      `done: processed=${processed} surfaced=${surfaced} held_for_qa=${held} errors=${errorCount} in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
  } catch (err) {
    errorCount += 1;
    logger.error(`run-intel-workflows FAILED: ${(err as Error).message}`);
    throw err;
  } finally {
    // eslint-disable-next-line no-console
    console.log(
      `INGESTION_METRIC ${JSON.stringify({
        source: 'run-intel-workflows',
        rows_inserted: surfaced,
        rows_updated: held,
        error_count: errorCount,
        duration_seconds: Math.round((Date.now() - t0) / 1000),
      })}`,
    );
    await app.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[run-intel-workflows] FAILED', err);
  process.exit(1);
});
