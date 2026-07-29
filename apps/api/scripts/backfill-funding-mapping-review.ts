/**
 * Repair legacy confirmed award mappings after the reviewed-identity migration.
 *
 * Dry-run by default. The only automatic repair is an exact client UEI ↔ source
 * UEI match, which proves the mapped federal entity is the client itself. Name
 * matches, manual pins without a relationship, parents and subsidiaries remain
 * review-required and are never guessed here.
 */
import { config as dotenvConfig } from 'dotenv';
import { Prisma, PrismaClient } from '@prisma/client';
import { emptyCounts, runWithSyncRun, type RunCounts } from '../src/ingestion/sync-run.helper.js';

dotenvConfig();

const SOURCE = 'backfill-funding-mapping-review';

export interface BackfillMappingReviewArgs {
  commit: boolean;
  tenantId: string | null;
}

function flag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}
function value(argv: string[], name: string): string | null {
  const eq = argv.find((item) => item.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1]! : null;
}
export function parseMappingReviewArgs(argv: string[]): BackfillMappingReviewArgs {
  return { commit: flag(argv, 'commit'), tenantId: value(argv, 'tenant') };
}

function normalizedUei(value: string | null | undefined): string | null {
  const candidate = (value ?? '').trim().toUpperCase();
  return /^[A-Z0-9]{12}$/.test(candidate) ? candidate : null;
}
function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function withBypass<T>(prisma: PrismaClient, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as PrismaClient;
    await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
    return fn(tx);
  });
}

export async function resolveMappingReviewTenantIds(
  prisma: PrismaClient,
  explicitTenantId: string | null,
): Promise<string[]> {
  if (explicitTenantId) return [explicitTenantId];
  const rows = await withBypass(prisma, (tx) =>
    tx.$queryRaw<Array<{ tenant_id: string }>>`
      SELECT DISTINCT tenant_id
      FROM client_intel_mapping
      WHERE source IN ('contracting', 'assistance_recipient')
        AND confirmed = true
    `,
  );
  return [...new Set(rows.map((row) => row.tenant_id).filter(Boolean))];
}

export interface BackfillMappingReviewResult extends RunCounts {
  evaluated: number;
  exactIdentifierRepairs: number;
  needsHumanReview: number;
}

export async function backfillFundingMappingReview(
  prisma: PrismaClient,
  options: { tenantIds: string[]; commit: boolean },
): Promise<BackfillMappingReviewResult> {
  const counts = emptyCounts();
  let evaluated = 0;
  let exactIdentifierRepairs = 0;
  let needsHumanReview = 0;

  for (const tenantId of options.tenantIds) {
    const { clients, mappings } = await withBypass(prisma, async (tx) => {
      const clients = await tx.client.findMany({
        where: { tenantId, status: { not: 'archived' } },
        select: { id: true, uei: true },
      });
      const clientIds = clients.map((client) => client.id);
      const mappings = clientIds.length
        ? await tx.clientIntelMapping.findMany({
            where: {
              tenantId,
              clientId: { in: clientIds },
              source: { in: ['contracting', 'assistance_recipient'] },
              confirmed: true,
              reviewStatus: 'confirmed',
              rollUpAwards: null,
            },
            select: {
              id: true,
              tenantId: true,
              clientId: true,
              source: true,
              externalId: true,
              externalName: true,
              matchBasis: true,
              matchTier: true,
              relationshipType: true,
              rollUpAwards: true,
              reviewStatus: true,
            },
          })
        : [];
      return { clients, mappings };
    });

    const clientUeiById = new Map(
      clients.map((client) => [client.id, normalizedUei(client.uei)]),
    );
    const contractorIds = mappings
      .filter((mapping) => mapping.source === 'contracting' && uuid(mapping.externalId))
      .map((mapping) => mapping.externalId);
    const contractors = contractorIds.length
      ? await prisma.federalContractor.findMany({
          where: { id: { in: contractorIds } },
          select: { id: true, uei: true },
        })
      : [];
    const contractorUeiById = new Map(
      contractors.map((contractor) => [contractor.id, normalizedUei(contractor.uei)]),
    );

    for (const mapping of mappings) {
      evaluated += 1;
      try {
        const clientUei = clientUeiById.get(mapping.clientId) ?? null;
        const sourceUei =
          mapping.source === 'contracting'
            ? (contractorUeiById.get(mapping.externalId) ?? null)
            : normalizedUei(mapping.externalId);
        const exact = clientUei != null && sourceUei != null && clientUei === sourceUei;
        if (!exact) {
          needsHumanReview += 1;
          counts.skipped += 1;
          continue;
        }

        exactIdentifierRepairs += 1;
        counts.updated += 1;
        if (!options.commit) continue;

        await withBypass(prisma, async (tx) => {
          const saved = await tx.clientIntelMapping.update({
            where: { id: mapping.id },
            data: {
              confirmed: true,
              reviewStatus: 'confirmed',
              matchBasis: 'exact_uei',
              matchTier: 1,
              relationshipType: 'self',
              rollUpAwards: true,
              reviewedBy: null,
              reviewedAt: new Date(),
              rejectionReason: null,
            },
          });
          await tx.auditLog.create({
            data: {
              tenantId,
              actorUserId: null,
              actorRole: 'system',
              action: 'intelligence_mapping.exact_identifier_backfilled',
              entityType: 'client_intel_mapping',
              entityId: mapping.id,
              before: mapping as unknown as Prisma.InputJsonValue,
              after: saved as unknown as Prisma.InputJsonValue,
            },
          });
        });
      } catch (error) {
        counts.errors += 1;
        console.warn(`[${SOURCE}] failed mapping ${mapping.id}: ${(error as Error).message}`);
      }
    }
  }

  return { ...counts, evaluated, exactIdentifierRepairs, needsHumanReview };
}

async function main(): Promise<void> {
  const args = parseMappingReviewArgs(process.argv);
  const prisma = new PrismaClient();
  try {
    const tenantIds = await resolveMappingReviewTenantIds(prisma, args.tenantId);
    // Report inside the closure: evaluated/exactIdentifierRepairs/
    // needsHumanReview are on this script's result type, not on the bare
    // RunCounts that runWithSyncRun resolves to. The repair count in
    // particular is the operator's only evidence of what was changed, so it
    // must come from a real pass rather than from the helper's skip path.
    const execute = async (): Promise<RunCounts> => {
      const result = await backfillFundingMappingReview(prisma, {
        tenantIds,
        commit: args.commit,
      });
      console.log(
        `[${SOURCE}] ${args.commit ? 'COMMITTED' : 'DRY RUN'} tenants=${tenantIds.length} ` +
          `evaluated=${result.evaluated} repaired=${result.exactIdentifierRepairs} ` +
          `needsReview=${result.needsHumanReview} errors=${result.errors}`,
      );
      return result;
    };
    if (args.commit) {
      await runWithSyncRun(prisma as never, SOURCE, execute);
    } else {
      await execute();
    }
  } finally {
    await prisma.$disconnect();
  }
}

const direct = /backfill-funding-mapping-review(\.[cm]?[tj]s)?$/.test(
  (process.argv[1] ?? '').replace(/\\/g, '/'),
);
if (direct) {
  void main().catch((error) => {
    console.error(`[${SOURCE}] FAILED`, error);
    process.exit(1);
  });
}

export { main };
