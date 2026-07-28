/**
 * Funding Opportunities — offline producer for EXACT-IDENTIFIER federal
 * contractor mappings.
 *
 *   tsx scripts/match-contractor-identifiers.ts                       # dry run
 *   tsx scripts/match-contractor-identifiers.ts --commit
 *   tsx scripts/match-contractor-identifiers.ts --commit --tenant <id>
 *
 * DRY-RUN BY DEFAULT.
 *
 * ── What it does, and the one thing it deliberately cannot do ────────────────
 *
 * Runs the SAME tiering policy the request path uses
 * (`EntityResolutionService.resolveContractorIdentifiersForTenant`, which
 * delegates to the pure `decideContractorCandidates`), so an overnight sweep and
 * a click in Settings reach identical verdicts. It writes candidates and
 * auto-confirms ONLY an unambiguous tier-1 identifier match.
 *
 * It CANNOT confirm a name match, by construction rather than by convention:
 * `candidateDecision` consults the identity tier rather than the confidence score
 * for source='contracting', and tiers 2-4 have no auto-confirm branch to reach.
 * That is the whole reason this producer is safe to schedule.
 *
 * ── Why it reuses the Nest service instead of re-implementing the SQL ────────
 *
 * The alternative — a standalone copy of the matcher — is how two code paths end
 * up disagreeing about which company a client is. The service is constructed here
 * with a real PrismaService so the tenant-scope extension applies exactly as it
 * does in the API process; there is no `withBypass` in this file precisely because
 * it is not needed when the scoped client is used properly.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { EntityResolutionService, type ResolutionSummary } from '../src/intelligence/entity-resolution.service.js';
import { FUNDING_OPPORTUNITIES_FEATURE } from '../src/funding-opportunities/funding-opportunities-flag.guard.js';

dotenvConfig();

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function flagValue(argv: string[], name: string): string | undefined {
  const withEq = argv.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.slice(`--${name}=`.length);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

export interface ParsedArgs {
  commit: boolean;
  tenantId: string | null;
}

export function parseArgs(argv: string[]): ParsedArgs {
  return {
    commit: hasFlag(argv, 'commit'),
    tenantId: flagValue(argv, 'tenant') ?? null,
  };
}

/**
 * Tenants in scope: the one named by `--tenant`, else every tenant with an
 * ENABLED `funding_opportunities` flag.
 *
 * No internal-tenant hardcode, matching FundingOpportunitiesFlagGuard: writing
 * mappings for a tenant whose read path 404s would be work nobody can see.
 */
export async function resolveTenantIds(
  prisma: PrismaService,
  explicitTenantId: string | null,
): Promise<string[]> {
  if (explicitTenantId) return [explicitTenantId];
  const rows = await prisma.withSystem((tx) =>
    tx.$queryRaw<Array<{ tenant_id: string }>>`
      SELECT DISTINCT tenant_id FROM intel_feature_flag
      WHERE feature = ${FUNDING_OPPORTUNITIES_FEATURE} AND enabled = true
    `,
  );
  return Array.from(new Set(rows.map((r) => r.tenant_id).filter(Boolean)));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const t0 = Date.now();
  console.log(
    `[contractor-identifiers] starting (${args.commit ? 'COMMIT' : 'DRY-RUN'})` +
      (args.tenantId ? ` tenant=${args.tenantId}` : ''),
  );

  const prisma = new PrismaService();
  await prisma.onModuleInit?.();
  try {
    const tenantIds = await resolveTenantIds(prisma, args.tenantId);
    if (tenantIds.length === 0) {
      console.warn(
        `[contractor-identifiers] no tenant has an enabled '${FUNDING_OPPORTUNITIES_FEATURE}' flag — nothing to do. ` +
          `Pass --tenant <id> to run for a specific tenant regardless of flag state.`,
      );
    }

    if (!args.commit) {
      // A DRY RUN THAT LIES IS WORSE THAN NO DRY RUN.
      //
      // The service's write path is a single method that persists as it goes, so
      // there is no honest way to invoke it "without writing". Rather than call it
      // and hope, this reports the read-only candidate view per client — the exact
      // verdicts a --commit run would act on, including which ones would
      // auto-confirm — and writes nothing.
      let clientsSeen = 0;
      let wouldAutoConfirm = 0;
      let wouldReview = 0;
      for (const tenantId of tenantIds) {
        const clients = await prisma.withTenant(tenantId, (tx) =>
          tx.client.findMany({ select: { id: true, name: true } }),
        );
        const entityResolution = new EntityResolutionService(prisma);
        for (const c of clients) {
          clientsSeen += 1;
          const view = await entityResolution.contractorCandidatesForClient(tenantId, c.id);
          for (const cand of view.candidates) {
            if (cand.autoConfirmEligible) {
              wouldAutoConfirm += 1;
              console.log(
                `[contractor-identifiers] WOULD AUTO-CONFIRM  ${c.name} → ${cand.contractorName} ` +
                  `(${cand.matchBasis}, tier ${cand.matchTier})`,
              );
            } else {
              wouldReview += 1;
            }
          }
        }
      }
      console.log(
        `[contractor-identifiers] DRY-RUN complete: ${tenantIds.length} tenant(s), ${clientsSeen} client(s), ` +
          `${wouldAutoConfirm} would auto-confirm, ${wouldReview} would land in review. Nothing written.`,
      );
      return;
    }

    const entityResolution = new EntityResolutionService(prisma);
    const totals: ResolutionSummary = {
      totalClients: 0,
      mappingsCreated: 0,
      autoConfirmed: 0,
      needsReview: 0,
    };
    for (const tenantId of tenantIds) {
      const r = await entityResolution.resolveContractorIdentifiersForTenant(tenantId);
      totals.totalClients += r.totalClients;
      totals.mappingsCreated += r.mappingsCreated;
      totals.autoConfirmed += r.autoConfirmed;
      totals.needsReview += r.needsReview;
      console.log(
        `[contractor-identifiers] ${tenantId}: clients=${r.totalClients} mappings=${r.mappingsCreated} ` +
          `autoConfirmed=${r.autoConfirmed} needsReview=${r.needsReview}`,
      );
    }
    console.log(
      `[contractor-identifiers] COMMITTED: ${tenantIds.length} tenant(s), clients=${totals.totalClients} ` +
        `mappings=${totals.mappingsCreated} autoConfirmed=${totals.autoConfirmed} ` +
        `needsReview=${totals.needsReview} in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

const isDirectRun = (() => {
  try {
    const invoked = process.argv[1] ?? '';
    return /match-contractor-identifiers(\.[cm]?[tj]s)?$/.test(invoked.replace(/\\/g, '/'));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  void main().catch((err) => {
    console.error('[contractor-identifiers] FAILED', err);
    process.exit(1);
  });
}

export { main };
