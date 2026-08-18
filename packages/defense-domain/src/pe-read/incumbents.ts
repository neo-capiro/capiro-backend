/**
 * Incumbent-map tiering (F20) — the pure merge of USAspending award evidence and
 * R-3 exhibit named performers into one honest, tiered contractor list.
 *
 * Hoisted from `BudgetLinesReadService.getIncumbents` in
 * `apps/api/src/program-element/budget-lines-read.service.ts`. Everything after
 * the two DB reads is pure, so it lives here and both the service and the parity
 * suite call the SAME function — the test cannot pass by re-describing the logic.
 *
 * HONESTY RULES preserved exactly:
 *  - `incumbent` requires STRONG matched award evidence (uei-confirmed prime,
 *    DoD acquisition-program attribution, confidence >= 0.8, or an unambiguous
 *    single-candidate resolution). Weak award links are `candidate`, never
 *    incumbent.
 *  - R-3 named companies with no matched award are `performer`
 *    (budget-justification evidence), never `incumbent`.
 *  - The award<->performer merge uses ONE symmetric normalized key so the same
 *    company does not appear as two rows.
 */

export interface IncumbentAwardRow {
  contractorName: string | null;
  /** Prisma Decimal | string | number — coerced with Number() exactly as apps/api does. */
  amount: unknown;
  peCodeSource: string | null;
  peCodeConfidence: number | null;
  peCodeCandidateCount: number | null;
  awardingSubTier: string | null;
  fundingFy: number | null;
}

export interface IncumbentPerformerRow {
  performer: string;
  performerNormalized: string;
  location: string | null;
  costCategory: string | null;
  /** Prisma Decimal | string | number. */
  totalCostM: unknown;
  fy: number;
  tableType: string | null;
  sourceUrl: string | null;
  pageNumber: number | null;
}

export interface IncumbentRow {
  company: string;
  tier: 'incumbent' | 'performer' | 'candidate';
  confidence: 'high' | 'med' | 'low';
  awardsTotal: number | null;
  awardCount: number;
  office: string | null;
  role: string | null;
  evidence: string;
  sourceUrl: string | null;
}

/**
 * One symmetric match key for the award<->performer merge: uppercase and strip
 * EVERYTHING but letters/digits (spaces included). Award names and
 * performerNormalized come from different normalizers (JS vs the exhibit
 * extractor), so comparing raw stored forms splits "Lockheed-Martin ..." from
 * "LOCKHEED MARTIN ..." into two rows. Prefix-12 on the shared key survives
 * suffix drift (CORP vs CORPORATION).
 */
export function incumbentMatchKey(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** True when the PE attribution on an award is strong enough to say "incumbent". */
export function isStrongAwardAttribution(award: IncumbentAwardRow): boolean {
  return (
    award.peCodeSource === 'uei_confirmed_r3_prime' ||
    award.peCodeSource === 'dod_acquisition_program' ||
    (award.peCodeConfidence ?? 0) >= 0.8 ||
    award.peCodeCandidateCount === 1
  );
}

export function buildIncumbentRows(input: {
  awards: readonly IncumbentAwardRow[];
  performers: readonly IncumbentPerformerRow[];
}): IncumbentRow[] {
  const byContractor = new Map<
    string,
    {
      name: string;
      total: number;
      count: number;
      strong: boolean;
      sources: Set<string>;
      office: string | null;
      fys: Set<number>;
    }
  >();
  for (const a of input.awards) {
    const name = (a.contractorName ?? '').trim();
    if (!name) continue;
    const key = name.toUpperCase();
    const strong = isStrongAwardAttribution(a);
    const g = byContractor.get(key) ?? {
      name,
      total: 0,
      count: 0,
      strong: false,
      sources: new Set<string>(),
      office: null as string | null,
      fys: new Set<number>(),
    };
    g.total += Number(a.amount ?? 0);
    g.count += 1;
    g.strong = g.strong || strong;
    if (a.peCodeSource) g.sources.add(a.peCodeSource);
    if (!g.office && a.awardingSubTier) g.office = a.awardingSubTier;
    if (a.fundingFy) g.fys.add(a.fundingFy);
    byContractor.set(key, g);
  }

  const performerByName = new Map<
    string,
    { name: string; roles: Set<string>; fys: Set<number>; totalM: number; cite: string | null }
  >();
  for (const p of input.performers) {
    const key = p.performerNormalized;
    const g = performerByName.get(key) ?? {
      name: p.performer,
      roles: new Set<string>(),
      fys: new Set<number>(),
      totalM: 0,
      cite: null as string | null,
    };
    if (p.costCategory) g.roles.add(p.costCategory);
    g.fys.add(p.fy);
    g.totalM += Number(p.totalCostM ?? 0);
    if (!g.cite && p.sourceUrl) g.cite = `${p.sourceUrl}#page=${p.pageNumber}`;
    performerByName.set(key, g);
  }

  const rows: IncumbentRow[] = [];

  const performerKeys = [...performerByName.keys()].map(incumbentMatchKey);
  for (const g of byContractor.values()) {
    const norm = incumbentMatchKey(g.name);
    const alsoPerformer = performerKeys.some(
      (k) => k.startsWith(norm.slice(0, 12)) || norm.startsWith(k.slice(0, 12)),
    );
    rows.push({
      company: g.name,
      tier: g.strong ? 'incumbent' : 'candidate',
      confidence: g.strong ? (alsoPerformer ? 'high' : 'med') : 'low',
      awardsTotal: g.total || null,
      awardCount: g.count,
      office: g.office,
      role: null,
      evidence: g.strong
        ? `${g.count} award${g.count === 1 ? '' : 's'} resolved to this line (${[...g.sources].join(', ') || 'attribution stored'})${alsoPerformer ? '; also an R-3 named performer' : ''}.`
        : `Award link is low-confidence (${[...g.sources].join(', ') || 'ambiguous account/PA attribution'}) — needs review before treating as an incumbent.`,
      sourceUrl: null,
    });
  }

  const contractorKeys = [...byContractor.values()].map((g) => incumbentMatchKey(g.name));
  for (const [key, g] of performerByName) {
    const norm = incumbentMatchKey(key);
    const hasAwardRow = contractorKeys.some(
      (k) => k.startsWith(norm.slice(0, 12)) || norm.startsWith(k.slice(0, 12)),
    );
    if (hasAwardRow) continue; // already represented by the award row
    rows.push({
      company: g.name,
      tier: 'performer',
      confidence: 'med',
      awardsTotal: null,
      awardCount: 0,
      office: null,
      role: [...g.roles].slice(0, 2).join('; ') || null,
      evidence: `Named in the R-3 exhibit (${[...g.fys]
        .sort()
        .map((f) => `FY${f}`)
        .join(', ')}) — budget-justification performer; no matched award yet.`,
      sourceUrl: g.cite,
    });
  }

  rows.sort((a, b) => {
    const tierRank = { incumbent: 0, performer: 1, candidate: 2 } as const;
    if (tierRank[a.tier] !== tierRank[b.tier]) return tierRank[a.tier] - tierRank[b.tier];
    return (b.awardsTotal ?? 0) - (a.awardsTotal ?? 0);
  });
  return rows;
}
