/**
 * Step 0.2 — extraction-totals reconciliation core (plan §4.2).
 *
 * Validates that the funding totals loaded into program_element_year match independent
 * control totals (scripts/__data__/control_totals.json). Pure + DB-light so it is unit-tested
 * and shared by scripts/verify-budget-reconciliation.ts AND scripts/preflight-ingestion.ts.
 *
 * Iteration is DB-DRIVEN: we sum the value fields actually present in program_element_year,
 * grouped by (fiscalYear, field→budgetCycle, component-from-peCode), and compare each group to
 * its control total. Groups with no DB data are never iterated (a fresh/partial DB does not
 * FAIL); a DB group with no matching control total is reported SKIP (cannot validate), not FAIL.
 */
import { serviceFromPeCode } from '../jbook/jbook-extract.js';

/** Relative-delta tolerance for a PASS (0.5%, absorbs $-rounding to Decimal(14,2)). */
export const TOLERANCE_PCT = 0.005;

/** program_element_year numeric fields that map to a budget cycle (skip reprogrammed/executed). */
export const RECON_FIELDS = [
  'request',
  'hascMark',
  'sascMark',
  'hacDMark',
  'sacDMark',
  // The published 'conference' control totals are the NDAA conference, which now lives
  // in ndaaConference — so reconcile that field against the 'conference' cycle.
  'ndaaConference',
  'enacted',
] as const;
export type ReconField = (typeof RECON_FIELDS)[number];

/** field → budgetCycle label used in control_totals.json. */
export const FIELD_TO_CYCLE: Record<ReconField, string> = {
  request: 'pb',
  hascMark: 'hasc',
  sascMark: 'sasc',
  hacDMark: 'hac_d',
  sacDMark: 'sac_d',
  ndaaConference: 'conference',
  enacted: 'enacted',
};

/** Component bucket for a PE (ARMY|NAVY|AF|SF|DARPA|USMC|DW), or 'UNKNOWN'. */
export function componentForPeCode(peCode: string): string {
  return serviceFromPeCode(peCode).service ?? 'UNKNOWN';
}

export interface ControlGroup {
  fiscalYear: number;
  budgetCycle: string;
  component: string;
  field: string;
  totalMillions: number;
  source?: string;
}

export interface ControlTotals {
  _provenance?: Record<string, unknown>;
  groups: ControlGroup[];
}

export interface ExtractedGroup {
  fiscalYear: number;
  component: string;
  field: ReconField;
  sumMillions: number;
  count: number;
}

export interface GroupResult {
  fiscalYear: number;
  budgetCycle: string;
  component: string;
  field: string;
  extractedMillions: number;
  controlMillions: number | null;
  deltaMillions: number | null;
  deltaPct: number | null;
  status: 'PASS' | 'FAIL' | 'SKIP';
  reason?: string;
}

export interface ReconResult {
  ok: boolean;
  checked: number;
  passed: number;
  failed: number;
  skipped: number;
  results: GroupResult[];
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(typeof v === 'object' ? (v as { toString(): string }).toString() : v);
  return Number.isFinite(n) ? n : null;
}

/** Sum each PE-year row's value fields into (fiscalYear, component, field) groups. Pure. */
export function summarizeExtractedTotals(rows: Array<Record<string, unknown>>): ExtractedGroup[] {
  const acc = new Map<string, ExtractedGroup>();
  for (const row of rows) {
    const peCode = String(row.peCode ?? '');
    const fy = Number(row.fy);
    if (!peCode || !Number.isFinite(fy)) continue;
    const component = componentForPeCode(peCode);
    for (const field of RECON_FIELDS) {
      const val = toNumber(row[field]);
      if (val === null) continue;
      const key = `${fy}|${component}|${field}`;
      const cur = acc.get(key) ?? { fiscalYear: fy, component, field, sumMillions: 0, count: 0 };
      cur.sumMillions += val;
      cur.count += 1;
      acc.set(key, cur);
    }
  }
  return [...acc.values()];
}

/** Relative delta of extracted vs control, using control as the reference. */
function relativeDelta(extracted: number, control: number): number {
  if (control === 0) return extracted === 0 ? 0 : 1;
  return Math.abs(extracted - control) / Math.abs(control);
}

/** Compare one extracted group to its control total (or null when absent). Pure. */
export function computeGroupResult(
  group: ExtractedGroup,
  controlMillions: number | null,
): GroupResult {
  const budgetCycle = FIELD_TO_CYCLE[group.field];
  const base = {
    fiscalYear: group.fiscalYear,
    budgetCycle,
    component: group.component,
    field: group.field,
    extractedMillions: round2(group.sumMillions),
  };
  if (controlMillions === null) {
    return {
      ...base,
      controlMillions: null,
      deltaMillions: null,
      deltaPct: null,
      status: 'SKIP',
      reason: 'no control total for group',
    };
  }
  const deltaPct = relativeDelta(group.sumMillions, controlMillions);
  return {
    ...base,
    controlMillions: round2(controlMillions),
    deltaMillions: round2(group.sumMillions - controlMillions),
    deltaPct: Math.round(deltaPct * 1e5) / 1e5,
    status: deltaPct <= TOLERANCE_PCT ? 'PASS' : 'FAIL',
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function controlKey(fy: number, cycle: string, component: string, field: string): string {
  return `${fy}|${cycle}|${component}|${field}`;
}

/** Index control groups for O(1) lookup by (fy, cycle, component, field). */
export function indexControl(control: ControlTotals): Map<string, number> {
  const idx = new Map<string, number>();
  for (const g of control.groups ?? []) {
    idx.set(controlKey(g.fiscalYear, g.budgetCycle, g.component, g.field), g.totalMillions);
  }
  return idx;
}

export interface BudgetReconPrisma {
  programElementYear: {
    findMany(args: unknown): Promise<Array<Record<string, unknown>>>;
  };
  // Step 1.3 — optional: when present, position cycles are ALSO reconciled to their
  // control totals. Optional so the existing year-only callers/specs are untouched and
  // a DB without the table degrades gracefully.
  programElementBudgetPosition?: {
    findMany(args: unknown): Promise<Array<Record<string, unknown>>>;
  };
}

/**
 * Step 1.3 — reconcile loaded BUDGET POSITIONS to control totals. Parallel to
 * summarizeExtractedTotals but for the position dimension: sum value_kind='total'
 * positions into (assertedFy, positionCycle→budgetCycle/fy, component) groups so each
 * loaded cycle can be checked against its control total. Pure.
 *
 * positionCycle (e.g. 'pb_fy2027', 'hasc_fy2027', 'enacted_fy2026') splits into a
 * budgetCycle prefix ('pb'|'hasc'|...) used for the control-total key; assertedFy is the
 * fiscal year the dollars are FOR. Returns [] when no positions are loaded, so the
 * harness is a graceful no-op until Step 1.3 data lands.
 */
export interface PositionExtractedGroup {
  fiscalYear: number;
  budgetCycle: string;
  component: string;
  sumMillions: number;
  count: number;
}

/** Split 'pb_fy2027' → 'pb'; 'hac_d_fy2026' → 'hac_d'; unknown → the whole string. */
export function budgetCycleFromPositionCycle(positionCycle: string): string {
  return positionCycle.replace(/_fy\d{4}$/i, '');
}

export function summarizePositionTotals(
  rows: Array<Record<string, unknown>>,
): PositionExtractedGroup[] {
  const acc = new Map<string, PositionExtractedGroup>();
  for (const row of rows) {
    if (String(row.valueKind ?? 'total') !== 'total') continue;
    const peCode = String(row.peCode ?? '');
    const fy = Number(row.assertedFy);
    const cycle = String(row.positionCycle ?? '');
    const amount = toNumber(row.amount);
    if (!peCode || !Number.isFinite(fy) || !cycle || amount === null) continue;
    const component = componentForPeCode(peCode);
    const budgetCycle = budgetCycleFromPositionCycle(cycle);
    const key = `${fy}|${budgetCycle}|${component}`;
    const cur = acc.get(key) ?? {
      fiscalYear: fy,
      budgetCycle,
      component,
      sumMillions: 0,
      count: 0,
    };
    cur.sumMillions += amount;
    cur.count += 1;
    acc.set(key, cur);
  }
  return [...acc.values()];
}

/**
 * Compare a summarized position group to its control total. Control totals are keyed
 * (fy, cycle, component, field) where field is the year-table field for that cycle
 * (e.g. cycle 'pb' → field 'request'). We map cycle→field via FIELD_TO_CYCLE's inverse.
 * Pure.
 */
const CYCLE_TO_FIELD: Record<string, string> = Object.fromEntries(
  Object.entries(FIELD_TO_CYCLE).map(([field, cycle]) => [cycle, field]),
);

export function computePositionGroupResult(
  group: PositionExtractedGroup,
  controlMillions: number | null,
): GroupResult {
  const base = {
    fiscalYear: group.fiscalYear,
    budgetCycle: group.budgetCycle,
    component: group.component,
    field: CYCLE_TO_FIELD[group.budgetCycle] ?? group.budgetCycle,
    extractedMillions: round2(group.sumMillions),
  };
  if (controlMillions === null) {
    return {
      ...base,
      controlMillions: null,
      deltaMillions: null,
      deltaPct: null,
      status: 'SKIP',
      reason: 'no control total for position cycle',
    };
  }
  const deltaPct = relativeDelta(group.sumMillions, controlMillions);
  return {
    ...base,
    controlMillions: round2(controlMillions),
    deltaMillions: round2(group.sumMillions - controlMillions),
    deltaPct: Math.round(deltaPct * 1e5) / 1e5,
    status: deltaPct <= TOLERANCE_PCT ? 'PASS' : 'FAIL',
  };
}

/**
 * Reconcile loaded budget positions to control totals. Graceful no-op (empty result)
 * when the table is absent or carries no positions, so the harness keeps passing until
 * Step 1.3 data lands. DB-driven, same contract as checkBudgetReconciliation.
 */
export async function checkPositionReconciliation(
  prisma: BudgetReconPrisma,
  control: ControlTotals,
): Promise<ReconResult> {
  const empty: ReconResult = {
    ok: true,
    checked: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    results: [],
  };
  if (!prisma.programElementBudgetPosition) return empty;

  let rows: Array<Record<string, unknown>>;
  try {
    rows = await prisma.programElementBudgetPosition.findMany({
      select: {
        peCode: true,
        positionCycle: true,
        assertedFy: true,
        amount: true,
        valueKind: true,
      },
    });
  } catch {
    // Table not present yet (migration not applied) — no-op rather than fail.
    return empty;
  }
  if (rows.length === 0) return empty;

  const idx = indexControl(control);
  const results = summarizePositionTotals(rows)
    .map((g) =>
      computePositionGroupResult(
        g,
        idx.get(
          controlKey(
            g.fiscalYear,
            g.budgetCycle,
            g.component,
            CYCLE_TO_FIELD[g.budgetCycle] ?? g.budgetCycle,
          ),
        ) ?? null,
      ),
    )
    .sort(
      (a, b) =>
        a.fiscalYear - b.fiscalYear ||
        a.component.localeCompare(b.component) ||
        a.budgetCycle.localeCompare(b.budgetCycle),
    );

  const failed = results.filter((r) => r.status === 'FAIL').length;
  const passed = results.filter((r) => r.status === 'PASS').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  return { ok: failed === 0, checked: passed + failed, passed, failed, skipped, results };
}

/**
 * Sum program_element_year groups and compare to control totals. DB-driven: only groups
 * that have loaded data are checked. Returns per-group results + an overall ok flag.
 */
export async function checkBudgetReconciliation(
  prisma: BudgetReconPrisma,
  control: ControlTotals,
): Promise<ReconResult> {
  const rows = await prisma.programElementYear.findMany({
    select: {
      peCode: true,
      fy: true,
      request: true,
      hascMark: true,
      sascMark: true,
      hacDMark: true,
      sacDMark: true,
      ndaaConference: true,
      enacted: true,
    },
  });

  const idx = indexControl(control);
  const extracted = summarizeExtractedTotals(rows);
  const results = extracted
    .map((g) =>
      computeGroupResult(
        g,
        idx.get(controlKey(g.fiscalYear, FIELD_TO_CYCLE[g.field], g.component, g.field)) ?? null,
      ),
    )
    .sort(
      (a, b) =>
        a.fiscalYear - b.fiscalYear ||
        a.component.localeCompare(b.component) ||
        a.budgetCycle.localeCompare(b.budgetCycle),
    );

  const failed = results.filter((r) => r.status === 'FAIL').length;
  const passed = results.filter((r) => r.status === 'PASS').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  return { ok: failed === 0, checked: passed + failed, passed, failed, skipped, results };
}
