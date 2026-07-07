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
  /** Up to `sampleLimit` changed/new rows for eyeballing. */
  samples: MarkDiffSample[];
}

const EPSILON_MILLIONS = 0.0005; // half a $K — below artifact precision

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
    samples: [],
  };

  for (const r of records) {
    if (r.mark === null) {
      result.noMark += 1;
      continue;
    }
    const incomingMillions = r.mark / 1_000_000;
    if (!knownPeCodes.has(r.peCode)) {
      result.missingPe += 1;
      pushSample(result, sampleLimit, {
        peCode: r.peCode,
        currentMillions: null,
        incomingMillions,
        kind: 'missing_pe',
      });
      continue;
    }
    const current = existing.get(r.peCode)?.currentMillions ?? null;
    if (current === null) {
      result.newValue += 1;
      pushSample(result, sampleLimit, {
        peCode: r.peCode,
        currentMillions: null,
        incomingMillions,
        kind: 'new_value',
      });
    } else if (Math.abs(current - incomingMillions) <= EPSILON_MILLIONS) {
      result.unchanged += 1;
    } else {
      result.changed += 1;
      pushSample(result, sampleLimit, {
        peCode: r.peCode,
        currentMillions: current,
        incomingMillions,
        kind: 'changed',
      });
    }
  }
  return result;
}

function pushSample(result: MarkDiffResult, limit: number, s: MarkDiffSample): void {
  if (result.samples.length < limit) result.samples.push(s);
}
