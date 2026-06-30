/**
 * Parity diff engine (SC0.3). Compares a flag-OFF response (today's in-process
 * path) with a flag-ON response (the orchestrator path) for the same input.
 *
 * Field policy:
 *   - deterministic: must be DEEP-EQUAL (ids, counts, structured data, scoping-
 *     sensitive fields). Any difference is a hard fail.
 *   - graded: model-generated prose; compared with a semantic tolerance (the
 *     default grader is conservative — same type + non-empty; the live harness
 *     swaps in the apps/api/src/meri/evals LLM-judge grader).
 *
 * Pure + deterministic so it unit-tests under test/**.spec.ts.
 */
export type ParityFieldKind = 'deterministic' | 'graded';

export interface ParityFieldPolicy {
  path: string; // dot path, e.g. 'reply' or 'edits.length'
  kind: ParityFieldKind;
}

export interface ParityMismatch {
  path: string;
  kind: ParityFieldKind;
  off: unknown;
  on: unknown;
  reason: string;
}

export interface ParityResult {
  fixtureId: string;
  pass: boolean;
  checked: number;
  mismatches: ParityMismatch[];
}

export type Grader = (path: string, off: unknown, on: unknown) => boolean;

/** Conservative default grader: same JS type and (for strings) both non-empty. */
export const defaultGrader: Grader = (_path, off, on) => {
  if (typeof off !== typeof on) return false;
  if (typeof off === 'string') return off.trim().length > 0 && (on as string).trim().length > 0;
  return true;
};

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc == null) return undefined;
    if (key === 'length' && Array.isArray(acc)) return acc.length;
    if (typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function diffResponses(
  fixtureId: string,
  off: unknown,
  on: unknown,
  policy: ParityFieldPolicy[],
  grader: Grader = defaultGrader,
): ParityResult {
  const mismatches: ParityMismatch[] = [];
  for (const field of policy) {
    const offVal = getPath(off, field.path);
    const onVal = getPath(on, field.path);
    if (field.kind === 'deterministic') {
      if (!deepEqual(offVal, onVal)) {
        mismatches.push({
          path: field.path,
          kind: field.kind,
          off: offVal,
          on: onVal,
          reason: 'deterministic field differs',
        });
      }
    } else {
      if (!grader(field.path, offVal, onVal)) {
        mismatches.push({
          path: field.path,
          kind: field.kind,
          off: offVal,
          on: onVal,
          reason: 'graded field outside tolerance',
        });
      }
    }
  }
  return { fixtureId, pass: mismatches.length === 0, checked: policy.length, mismatches };
}
