/**
 * mark-dry-run-diff — pure diff for the parse-verb dry-run gate (PE Watch
 * auto-update plan, Phase 4). Given the artifact's mark records (DOLLARS) and
 * the current program_element_year values (MILLIONS), report what a load would
 * actually change — the "diff report" a human inspects before --commit.
 */
import type { CommitteeReportMarkRecord } from './committee-report-parser.js';

export interface ExistingMark {
  /** Current stored value in $MILLIONS (canonical unit), null when unset. */
  currentMillions: number | null;
}

export interface MarkDiffSample {
  peCode: string;
  currentMillions: number | null;
  incomingMillions: number | null;
  kind: 'new_value' | 'changed' | 'unchanged' | 'missing_pe' | 'no_mark';
}

export interface MarkDiffResult {
  total: number;
  /** Rows whose mark is null — the loader skips these. */
  noMark: number;
  /** PE exists, no current value → the load fills a blank. */
  newValue: number;
  /** PE exists, current value differs → the load overwrites. INSPECT THESE. */
  changed: number;
  /** PE exists, value already equal → load is a no-op for this row. */
  unchanged: number;
  /** peCode not in program_element → the writer would quarantine. */
  missingPe: number;
  /**
   * Largest absolute overwrite among `changed` rows, in $MILLIONS. This is the
   * ceiling a human checks: if it's a few $K it's rounding precision; if it's
   * millions, a real number is moving. null when nothing changed.
   */
  maxAbsDeltaMillions: number | null;
  /** Sample rows, MOST MATERIAL FIRST (biggest delta / magnitude), capped at `sampleLimit`. */
  samples: MarkDiffSample[];
}

const EPSILON_MILLIONS = 0.0005; // half a $K — below artifact precision

/** Sort magnitude: how big a movement this row represents, in $MILLIONS. */
function sampleMagnitude(s: MarkDiffSample): number {
  if (s.kind === 'changed' && s.currentMillions !== null && s.incomingMillions !== null) {
    return Math.abs(s.currentMillions - s.incomingMillions);
  }
  return Math.abs(s.incomingMillions ?? 0); // new_value / missing_pe: the value being written
}

export function diffMarks(
  records: CommitteeReportMarkRecord[],
  existing: Map<string, ExistingMark>,
  knownPeCodes: Set<string>,
  sampleLimit = 15,
): MarkDiffResult {
  const result: MarkDiffResult = {
    total: records.length,
    noMark: 0,
    newValue: 0,
    changed: 0,
    unchanged: 0,
    missingPe: 0,
    maxAbsDeltaMillions: null,
    samples: [],
  };
  const candidates: MarkDiffSample[] = [];

  for (const r of records) {
    if (r.mark === null) {
      result.noMark += 1;
      continue;
    }
    const incomingMillions = r.mark / 1_000_000;
    if (!knownPeCodes.has(r.peCode)) {
      result.missingPe += 1;
      candidates.push({ peCode: r.peCode, currentMillions: null, incomingMillions, kind: 'missing_pe' });
      continue;
    }
    const current = existing.get(r.peCode)?.currentMillions ?? null;
    if (current === null) {
      result.newValue += 1;
      candidates.push({ peCode: r.peCode, currentMillions: null, incomingMillions, kind: 'new_value' });
    } else if (Math.abs(current - incomingMillions) <= EPSILON_MILLIONS) {
      result.unchanged += 1;
    } else {
      result.changed += 1;
      const abs = Math.abs(current - incomingMillions);
      if (result.maxAbsDeltaMillions === null || abs > result.maxAbsDeltaMillions) {
        result.maxAbsDeltaMillions = abs;
      }
      candidates.push({ peCode: r.peCode, currentMillions: current, incomingMillions, kind: 'changed' });
    }
  }

  // Most material first, so a capped sample still proves the ceiling.
  candidates.sort((a, b) => sampleMagnitude(b) - sampleMagnitude(a));
  result.samples = candidates.slice(0, sampleLimit);
  return result;
}
