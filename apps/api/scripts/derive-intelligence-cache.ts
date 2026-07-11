/**
 * derive-intelligence-cache (BL-0): runs the pure intelligence engines over
 * every live budget line and writes catalog-sortable outputs to
 * program_element_intelligence_cache — lineType, maturity ladder (F19),
 * appropriability (F27), latest signal, valley-of-death flag (F24), posture,
 * anomalies. The per-PE intelligence endpoint still computes live; this cache
 * exists so the catalog can filter/sort thousands of lines per request.
 *
 * Runs LAST in the derive DAG (needs budget_action + budget_line_relationship
 * + capability matches). Wholesale delete-and-rewrite; stamps computedAt.
 *
 * Valley-of-death rule (F24, deterministic): an RDT&E line at prototype /
 * system-development stage with NO procurement edge, NO O&M edge, and NO award
 * evidence — development money with no path to a buy.
 *
 *   derive-intelligence-cache [--commit]
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';
import { buildIntelligence } from '../src/program-element/intelligence/build-intelligence.js';
import { buildMaturityLadder } from '../src/program-element/intelligence/maturity-ladder.js';
import { scoreAppropriability } from '../src/program-element/intelligence/appropriability.js';

dotenvConfig();

const num = (v: Prisma.Decimal | null): number | null => (v === null ? null : Number(v));

function lineTypeFor(appropriationType: string | null): string | null {
  const t = (appropriationType ?? '').toUpperCase();
  if (t.startsWith('RDT')) return 'RDTE_PE';
  if (t === 'PROC') return 'PROCUREMENT_BLIN';
  if (t === 'OM') return 'OM_BLI';
  return null;
}

const TONE: Record<string, string> = {
  add: 'notable',
  cut: 'critical',
  new_start: 'info',
  termination: 'critical',
  hold: 'notable',
  transfer: 'info',
};

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    const lines = await prisma.programElement.findMany({
      where: { retiredAt: null },
      select: {
        peCode: true,
        appropriationType: true,
        budgetActivity: true,
        description: true,
        years: {
          select: {
            fy: true,
            request: true,
            hascMark: true,
            sascMark: true,
            hacDMark: true,
            sacDMark: true,
            ndaaConference: true,
            enacted: true,
          },
        },
      },
    });

    // Bulk-load graph signals (one query each, grouped in memory).
    const [rels, capMatches, awards, performers, sources, activePeople, confirmedCandidates] =
      await Promise.all([
        prisma.budgetLineRelationship.findMany({
          where: { status: 'accepted' },
          select: { fromPeCode: true, toPeCode: true, relType: true },
        }),
        prisma.capabilityBudgetLineMatch.groupBy({ by: ['peCode'], _count: { peCode: true } }),
        prisma.federalAward.groupBy({
          by: ['peCode'],
          where: { peCode: { not: null } },
          _count: { peCode: true },
        }),
        prisma.programElementPerformer.groupBy({
          by: ['peCode'],
          where: { isNamedCompany: true },
          _count: { peCode: true },
        }),
        prisma.programElementSource.groupBy({ by: ['peCode'], _count: { peCode: true } }),
        // People link two ways: direct pePrimary/peSecondary on the person row,
        // and review-confirmed candidates. Both count toward office clarity.
        prisma.acquisitionPersonnel.findMany({
          where: { supersededAt: null, status: 'active' },
          select: { pePrimary: true, peSecondary: true },
        }),
        prisma.programElementPersonCandidate.groupBy({
          by: ['peCode'],
          where: { status: 'confirmed' },
          _count: { peCode: true },
        }),
      ]);
    const latestActions = await prisma.budgetAction.findMany({
      orderBy: [{ fy: 'desc' }, { updatedAt: 'desc' }],
      select: { peCode: true, fy: true, action: true },
    });

    const countMap = (rows: Array<{ peCode: string | null; _count: { peCode: number } }>) => {
      const m = new Map<string, number>();
      for (const r of rows) if (r.peCode) m.set(r.peCode, r._count.peCode);
      return m;
    };
    const capCount = countMap(capMatches);
    const awardCount = countMap(awards);
    const performerCount = countMap(performers);
    const sourceCount = countMap(sources);
    const personCount = countMap(confirmedCandidates);
    for (const p of activePeople) {
      if (p.pePrimary) personCount.set(p.pePrimary, (personCount.get(p.pePrimary) ?? 0) + 1);
      for (const code of p.peSecondary) {
        personCount.set(code, (personCount.get(code) ?? 0) + 1);
      }
    }

    const procLink = new Set<string>();
    const omLink = new Set<string>();
    const relCount = new Map<string, number>();
    const lineTypeByCode = new Map(lines.map((l) => [l.peCode, lineTypeFor(l.appropriationType)]));
    for (const r of rels) {
      relCount.set(r.fromPeCode, (relCount.get(r.fromPeCode) ?? 0) + 1);
      relCount.set(r.toPeCode, (relCount.get(r.toPeCode) ?? 0) + 1);
      // A line "has a procurement link" when an accepted edge connects it to a
      // PROCUREMENT_BLIN (either direction); same for O&M.
      const fromType = lineTypeByCode.get(r.fromPeCode);
      const toType = lineTypeByCode.get(r.toPeCode);
      if (toType === 'PROCUREMENT_BLIN') procLink.add(r.fromPeCode);
      if (fromType === 'PROCUREMENT_BLIN') procLink.add(r.toPeCode);
      if (toType === 'OM_BLI') omLink.add(r.fromPeCode);
      if (fromType === 'OM_BLI') omLink.add(r.toPeCode);
    }
    const latestSignal = new Map<string, { action: string; fy: number }>();
    for (const a of latestActions) {
      if (!latestSignal.has(a.peCode)) latestSignal.set(a.peCode, { action: a.action, fy: a.fy });
    }

    const rows = lines.map((l) => {
      const years = l.years.map((y) => ({
        fy: y.fy,
        request: num(y.request),
        hascMark: num(y.hascMark),
        sascMark: num(y.sascMark),
        hacDMark: num(y.hacDMark),
        sacDMark: num(y.sacDMark),
        // Intelligence "conference" signal = the NDAA conference (see build-intelligence).
        conference: num(y.ndaaConference),
        enacted: num(y.enacted),
      }));
      const intel = buildIntelligence({
        appropriationType: l.appropriationType,
        budgetActivity: l.budgetActivity,
        years,
      });
      const ladder = buildMaturityLadder({
        appropriationType: l.appropriationType,
        budgetActivity: l.budgetActivity,
        hasProcurementLink: procLink.has(l.peCode),
        hasOmLink: omLink.has(l.peCode),
        awardCount: awardCount.get(l.peCode) ?? 0,
      });
      const approp = scoreAppropriability({
        appropriationType: l.appropriationType,
        years: years.map((y) => ({ fy: y.fy, request: y.request, enacted: y.enacted })),
        posture: intel.posture,
        ladder,
        capabilityCount: capCount.get(l.peCode) ?? 0,
        relationshipCount: relCount.get(l.peCode) ?? 0,
        awardIncumbentCount: awardCount.get(l.peCode) ?? 0,
        performerCount: performerCount.get(l.peCode) ?? 0,
        officeLinkCount: personCount.get(l.peCode) ?? 0,
        hasNarrative: !!l.description && l.description.trim().length > 0,
        sourceCount: sourceCount.get(l.peCode) ?? 0,
      });
      const signal = latestSignal.get(l.peCode) ?? null;
      const lineType = lineTypeFor(l.appropriationType);
      const valleyOfDeath =
        lineType === 'RDTE_PE' &&
        ladder !== null &&
        ladder.current >= 1 &&
        ladder.current <= 2 &&
        !procLink.has(l.peCode) &&
        !omLink.has(l.peCode) &&
        (awardCount.get(l.peCode) ?? 0) === 0;

      return {
        peCode: l.peCode,
        lineType,
        maturity: ladder?.current ?? null,
        maturityJson: (ladder ?? {}) as Prisma.InputJsonValue,
        appropTier: approp.tier,
        appropScore: approp.score,
        appropJson: approp as unknown as Prisma.InputJsonValue,
        signalType: signal?.action ?? null,
        signalTone: signal ? (TONE[signal.action] ?? 'info') : null,
        signalFy: signal?.fy ?? null,
        valleyOfDeath,
        postureJson: (intel.posture ?? {}) as Prisma.InputJsonValue,
        anomaliesJson: intel.anomalies as unknown as Prisma.InputJsonValue,
      };
    });

    const summary = {
      verb: 'derive-intelligence-cache@v1',
      commit,
      lines: rows.length,
      byLineType: rows.reduce<Record<string, number>>((a, r) => {
        const k = r.lineType ?? 'unclassified';
        a[k] = (a[k] ?? 0) + 1;
        return a;
      }, {}),
      withMaturity: rows.filter((r) => r.maturity !== null).length,
      withApprop: rows.filter((r) => r.appropScore !== null).length,
      withSignal: rows.filter((r) => r.signalType !== null).length,
      valleyOfDeath: rows.filter((r) => r.valleyOfDeath).length,
    };
    console.log(JSON.stringify(summary, null, 2));

    if (!commit) {
      console.log('DRY RUN — re-run with --commit to write.');
      return;
    }
    await prisma.$transaction(
      async (tx) => {
        await tx.programElementIntelligenceCache.deleteMany({});
        for (let i = 0; i < rows.length; i += 500) {
          await tx.programElementIntelligenceCache.createMany({ data: rows.slice(i, i + 500) });
        }
        // Fat JSONB rows over ~10k lines — Prisma's default 5s interactive-
        // transaction timeout would abort mid-write. Explicit ceiling.
      },
      { timeout: 600_000, maxWait: 30_000 },
    );
    console.log(JSON.stringify({ written: rows.length }));
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
