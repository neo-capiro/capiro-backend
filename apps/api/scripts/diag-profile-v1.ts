/** @cleanup-smoke noArgsExit=2 */
/**
 * Read-only diagnostic for the client Intelligence tab (profile-v1 aggregate).
 *
 *   pnpm --filter @capiro/api exec tsx scripts/diag-profile-v1.ts
 *   (in prod: entrypoint case `diag-profile-v1`, optional --client <uuid> --tenant <uuid>)
 *
 * Answers, WITHOUT guessing:
 *   1. Is every one of the 24 profile-v1 data sources functioning? (per-source
 *      OK/FAIL + the error message if it threw)
 *   2. Which sources actually returned data vs. came back empty (gated/no-data)?
 *   3. What is the true end-to-end latency of getClientProfileV1, and which
 *      individual source is the slow path? (per-source millis, sorted)
 *
 * Boots a Nest application context (no HTTP server) to exercise the REAL service
 * methods + PrismaService/RLS wiring, identical to what the controller calls.
 *
 * SAFE: read-only. Calls getters only; no writes. Exits non-zero only on a
 * fatal boot/selection error (individual source failures are reported, not thrown).
 */
import { config as dotenvConfig } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { parseArgs } from 'node:util';

dotenvConfig();

// Load from compiled dist for reliable decorator metadata (see sync-entity-resolution.ts).
async function loadNest(): Promise<{ AppModule: any; IntelligenceService: any; PrismaService: any }> {
  for (const base of ['../dist', '../src']) {
    try {
      const app = await import(`${base}/app.module.js`);
      const intel = await import(`${base}/intelligence/intelligence.service.js`);
      const prisma = await import(`${base}/prisma/prisma.service.js`);
      return {
        AppModule: app.AppModule,
        IntelligenceService: intel.IntelligenceService,
        PrismaService: prisma.PrismaService,
      };
    } catch {
      // try next base
    }
  }
  throw new Error('Could not load AppModule from dist or src');
}

type SourceResult = { name: string; ms: number; ok: boolean; shape: string; error?: string };

async function timeSource(
  name: string,
  fn: () => Promise<unknown>,
): Promise<SourceResult> {
  const t0 = Date.now();
  try {
    const v = await fn();
    const ms = Date.now() - t0;
    return { name, ms, ok: true, shape: describe(v) };
  } catch (err) {
    const ms = Date.now() - t0;
    return { name, ms, ok: false, shape: '-', error: err instanceof Error ? err.message : String(err) };
  }
}

/** Compact, non-PII description of what a source returned (counts, not contents). */
function describe(v: unknown): string {
  if (v == null) return 'null';
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    // surface the most telling count-ish keys without dumping data
    const hints: string[] = [];
    for (const k of ['alerts', 'bills', 'rails', 'committees', 'nodes', 'edges', 'capabilities', 'districts', 'lobbyists', 'issueCodes', 'total', 'totalBills', 'totalRegulations', 'totalAmount', 'totalAwards', 'lobbySpend', 'contractWins']) {
      const val = o[k];
      if (Array.isArray(val)) hints.push(`${k}=${val.length}`);
      else if (typeof val === 'number') hints.push(`${k}=${val}`);
    }
    return `obj{${hints.join(',') || Object.keys(o).slice(0, 4).join(',')}}`;
  }
  return typeof v;
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      client: { type: 'string' },
      tenant: { type: 'string' },
      all: { type: 'boolean' }, // run every client in the tenant (latency sweep)
    },
  });
  const logger = new Logger('diag-profile-v1');
  if (!process.env.DATABASE_URL) {
    console.error('Usage: diag-profile-v1 [--client <uuid>] [--tenant <uuid>] [--all] (requires DATABASE_URL)');
    process.exitCode = 2;
    return;
  }
  const { AppModule, IntelligenceService, PrismaService } = await loadNest();
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });

  try {
    const svc: any = app.get(IntelligenceService);
    const prisma: any = app.get(PrismaService);

    // Pick the tenant.
    const tenants = args.tenant
      ? [{ id: args.tenant, slug: args.tenant }]
      : await prisma.withSystem((tx: any) =>
          tx.tenant.findMany({ where: { status: 'active' }, select: { id: true, slug: true } }),
        );
    if (!tenants.length) throw new Error('no active tenants found');

    const out: any = { generatedAt: new Date().toISOString(), tenants: [] as any[] };

    for (const tenant of tenants) {
      // Pick the client: explicit, else the one with the most confirmed mappings
      // (most likely to light up every gated alert source), else the first client.
      let clientId = args.client;
      let clientPick = 'arg';
      if (!clientId) {
        const mapped = await prisma.withSystem((tx: any) =>
          tx.clientIntelMapping.groupBy({
            by: ['clientId'],
            where: { tenantId: tenant.id, confirmed: true },
            _count: { clientId: true },
            orderBy: { _count: { clientId: 'desc' } },
            take: 1,
          }),
        ).catch(() => [] as any[]);
        if (mapped?.[0]?.clientId) {
          clientId = mapped[0].clientId;
          clientPick = `most-confirmed-mappings(${mapped[0]._count.clientId})`;
        } else {
          const first = await prisma.withTenant(tenant.id, (tx: any) =>
            tx.client.findFirst({ where: { status: { not: 'archived' } }, select: { id: true } }),
          ).catch(() => null);
          clientId = first?.id;
          clientPick = 'first-active-client';
        }
      }
      if (!clientId) {
        out.tenants.push({ tenant: tenant.slug, skipped: 'no client found' });
        continue;
      }

      // 1) TRUE end-to-end latency of the exact method the controller calls.
      const e2e0 = Date.now();
      let e2eErr: string | undefined;
      let snapshotAlerts = -1;
      try {
        const profile: any = await svc.getClientProfileV1(clientId, tenant.id, undefined);
        const top = profile?.sections?.snapshot?.topAlerts;
        snapshotAlerts = Array.isArray(top) ? top.length : -1;
      } catch (err) {
        e2eErr = err instanceof Error ? err.message : String(err);
      }
      const e2eMs = Date.now() - e2e0;

      // 2) Per-source timing + OK/FAIL (run sequentially to get clean isolated
      // per-source millis; the real aggregate runs them in parallel, so the SUM
      // here over-counts wall time but pinpoints the slow source precisely).
      const now = new Date();
      const day7 = new Date(now.getTime() + 7 * 864e5);
      const day21 = new Date(now.getTime() + 21 * 864e5);
      const day30ago = new Date(now.getTime() - 30 * 864e5);

      const sources: SourceResult[] = [];
      const C = clientId as string;
      const T = tenant.id as string;
      sources.push(await timeSource('getClientProfile', () => svc.getClientProfile(C, T)));
      sources.push(await timeSource('getLobbyingRoi', () => svc.getLobbyingRoi(C, T)));
      sources.push(await timeSource('getFecMoneyFlow', () => svc.getFecMoneyFlow(C, T)));
      sources.push(await timeSource('getDistrictNexus', () => svc.getDistrictNexus(C, T)));
      sources.push(await timeSource('getTrackedBills', () => svc.getTrackedBills(C, T)));
      sources.push(await timeSource('getBillRegulationLinks', () => svc.getBillRegulationLinks(C, T)));
      sources.push(await timeSource('computeEngagementHealth', () => svc.computeEngagementHealth(C, T)));
      sources.push(await timeSource('getExStaffers', () => svc.getExStaffers(C, T)));
      sources.push(await timeSource('getCommentPeriodAlerts', () => svc.getCommentPeriodAlerts(T)));
      sources.push(await timeSource('getChanges', () => svc.getChanges(T, new Date(now.getTime() - 7 * 864e5).toISOString(), C)));
      sources.push(await timeSource('getDistrictNexusSpend', () => svc.getDistrictNexusSpend(C, T)));
      sources.push(await timeSource('getOverdueCommentAlerts', () => svc.getOverdueCommentAlerts(C, T, now, day7)));
      sources.push(await timeSource('getCompetitorLdaAlerts', () => svc.getCompetitorLdaAlerts(C, T, day30ago)));
      sources.push(await timeSource('getContractAwardAlerts', () => svc.getContractAwardAlerts(C, T, day30ago)));
      sources.push(await timeSource('getHearingAlerts', () => svc.getHearingAlerts(C, T, now, day21)));

      const failed = sources.filter((s) => !s.ok);
      const slowest = [...sources].sort((a, b) => b.ms - a.ms).slice(0, 5);

      out.tenants.push({
        tenant: tenant.slug,
        clientId: C,
        clientPick,
        endToEnd: { ms: e2eMs, error: e2eErr ?? null, snapshotTopAlerts: snapshotAlerts },
        sourcesTotal: sources.length,
        sourcesOk: sources.length - failed.length,
        sourcesFailed: failed.map((f) => ({ name: f.name, error: f.error })),
        slowestSources: slowest.map((s) => `${s.name}=${s.ms}ms`),
        perSource: sources.map((s) => ({ name: s.name, ms: s.ms, ok: s.ok, shape: s.shape, ...(s.error ? { error: s.error } : {}) })),
      });

      logger.log(`${tenant.slug}/${C}: e2e=${e2eMs}ms, ${sources.length - failed.length}/${sources.length} sources ok, slowest: ${slowest.map((s) => `${s.name}=${s.ms}ms`).join(', ')}`);
      if (!args.all) break; // default: just one tenant
    }

    console.log('DIAG_RESULT ' + JSON.stringify(out, null, 2));
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('DIAG_ERR', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
