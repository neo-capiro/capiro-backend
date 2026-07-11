/**
 * Pure assembly logic for the rebuild-from-source-log migration.
 *
 * Background: before the writer was fixed, every PE-year write OVERWROTE the whole
 * `program_element_year` row, so only the last source's field survived — and the
 * committee/appropriations parsers stored dollars in THOUSANDS while the UI assumes
 * MILLIONS. Both bugs are fixed in the live path, but rows already in the database
 * are still clobbered + mis-scaled.
 *
 * The fix doesn't need the original PDF artifacts: every source's per-field value
 * was logged to `program_element_year_source_value` (reconciliation, Step 29). This
 * module reassembles each PE-year FROM that log — picking the highest-priority
 * source per field and converting thousands→millions — so the canonical row becomes
 * the correct UNION across sources in the canonical unit.
 *
 * Kept pure (no Prisma) so it is unit-tested directly; scripts/rebuild-program-
 * element-years.ts is the thin DB wrapper.
 */
import { sourceBaseKey, sourceLabel, sourceRank } from '../source-priority.js';

export const REBUILD_VALUE_FIELDS = [
  'request',
  'hascMark',
  'sascMark',
  'hacDMark',
  'sacDMark',
  'conference',
  'ndaaConference',
  'enacted',
  'reprogrammed',
  'executed',
] as const;
export type RebuildValueField = (typeof REBUILD_VALUE_FIELDS)[number];

const VALUE_FIELD_SET = new Set<string>(REBUILD_VALUE_FIELDS);

/** One per-field value as logged by reconciliation for a single source. */
export interface SourceLogEntry {
  peCode: string;
  fy: number;
  fieldName: string;
  source: string; // may carry service/_fyNN suffix
  valueDecimal: number | null;
  recordedAt: string; // ISO timestamp
}

export interface RebuiltYear {
  peCode: string;
  fy: number;
  /** Winning value per field, in MILLIONS. Only fields with log data appear. */
  values: Partial<Record<RebuildValueField, number>>;
  /** Winning source tag per field — restores raw.fieldSources so future writes merge with correct priority. */
  fieldSources: Record<string, string>;
  /** Per-field provenance label + date for raw.sourceAttribution / raw.datesAdded. */
  sourceAttribution: Record<string, string>;
  datesAdded: Record<string, string>;
}

/**
 * Convert a logged value to the canonical MILLIONS unit, by source:
 *   - fixture  -> already millions (no scaling)
 *   - p_doc    -> P-1 procurement exhibits are THOUSANDS (÷1e3)
 *   - else     -> committee / conference / public-law artifacts are FULL DOLLARS
 *                 (÷1e6), verified against live data (0101224N enacted 60280000 =
 *                 $60.3M, committee 0101113F 931164000 = $931M).
 * The log holds pre-fix values — run the rebuild before any post-fix re-ingestion
 * so this holds; a 0 stays 0.
 */
export function normalizeLoggedValue(value: number, source: string): number {
  const base = sourceBaseKey(source);
  if (base === 'fixture') return value;
  if (base === 'p_doc') return value / 1_000;
  return value / 1_000_000;
}

/** True when `a` should beat `b` for a field: higher priority, else more recent. */
function beats(a: SourceLogEntry, b: SourceLogEntry): boolean {
  const ra = sourceRank(a.source);
  const rb = sourceRank(b.source);
  if (ra !== rb) return ra < rb;
  return a.recordedAt > b.recordedAt;
}

/**
 * Reassemble canonical PE-year rows from the per-field source-value log. For each
 * (peCode, fy, field) the highest-priority source wins (ties broken by recency),
 * its value normalized to millions. Entries with a null value or a non-value
 * field name (e.g. the legacy `__row__` audit rows) are ignored.
 */
export function assembleYearsFromSourceLog(entries: SourceLogEntry[]): RebuiltYear[] {
  const winners = new Map<string, Map<string, SourceLogEntry>>();

  for (const entry of entries) {
    if (entry.valueDecimal === null || entry.valueDecimal === undefined) continue;
    if (!VALUE_FIELD_SET.has(entry.fieldName)) continue;

    const yearKey = `${entry.peCode}::${entry.fy}`;
    let byField = winners.get(yearKey);
    if (!byField) {
      byField = new Map<string, SourceLogEntry>();
      winners.set(yearKey, byField);
    }
    const current = byField.get(entry.fieldName);
    if (!current || beats(entry, current)) {
      byField.set(entry.fieldName, entry);
    }
  }

  const out: RebuiltYear[] = [];
  for (const [yearKey, byField] of winners) {
    const sep = yearKey.lastIndexOf('::');
    const peCode = yearKey.slice(0, sep);
    const fy = Number(yearKey.slice(sep + 2));

    const values: Partial<Record<RebuildValueField, number>> = {};
    const fieldSources: Record<string, string> = {};
    const sourceAttribution: Record<string, string> = {};
    const datesAdded: Record<string, string> = {};

    for (const [field, win] of byField) {
      values[field as RebuildValueField] = normalizeLoggedValue(
        win.valueDecimal as number,
        win.source,
      );
      fieldSources[field] = win.source;
      sourceAttribution[field] = sourceLabel(win.source);
      datesAdded[field] = win.recordedAt.slice(0, 10);
    }

    out.push({ peCode, fy, values, fieldSources, sourceAttribution, datesAdded });
  }

  // Stable order so dry-run output and writes are deterministic.
  out.sort((a, b) => (a.peCode === b.peCode ? a.fy - b.fy : a.peCode < b.peCode ? -1 : 1));
  return out;
}
