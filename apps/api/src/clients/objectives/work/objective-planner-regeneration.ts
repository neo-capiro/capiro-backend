import { types as nodeTypes } from 'node:util';
import type { WorkAuthority, WorkSource, WorkState } from './objective-work-command.js';

/** Internal owner consistency witness. The historical operation stays
 * accounted/applied; this separately identifies NEW current source absence.
 * It is never accepted from a browser and grants no generation/effect authority. */
export interface ObjectivePlannerRegenerationWitness { state: 'not_started'; source: WorkSource }
const KEYS = ['canonicalPlanId', 'canonicalEpoch', 'canonicalStrategyId', 'canonicalProjectId', 'canonicalBindingVersion',
  'rootIntentId', 'sourceRevisionId', 'sourceObjectiveVersion', 'sourceSnapshotHash', 'rootActorUserId'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const invalid = (): never => { throw Error('Unverified Planner regeneration source'); };
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value), own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return invalid();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const d = descriptors[key]; if (!d?.enumerable || !Object.hasOwn(d, 'value')) return invalid(); result[key] = d.value;
  }
  return result;
}
function source(value: unknown): WorkSource {
  const s = closed(value, KEYS);
  for (const key of KEYS) {
    const field = s[key];
    if (['canonicalEpoch', 'canonicalBindingVersion', 'sourceObjectiveVersion'].includes(key)) {
      if (typeof field !== 'number' || !Number.isInteger(field) || field < 1 || field > 2147483647) invalid();
    } else if (typeof field !== 'string' || (key === 'sourceSnapshotHash' ? HASH : UUID).exec(field)?.[0] !== field) invalid();
  }
  if (s.canonicalEpoch !== 1) invalid();
  return s as WorkSource;
}
const equal = (a: WorkSource, b: WorkSource) => KEYS.every(key => a[key] === b[key]);

/** Structural current/old source distinction only. The owner must still verify
 * original native receipt lineage, full paired applied ancestry and exclusive
 * current-binding operation/effect absence before constructing a witness. */
export function objectivePlannerAdvancedSource(a: WorkAuthority, state: WorkState): WorkSource | null {
  const current = source(state.source);
  if (!state.consent) return null;
  const original = source(state.consent.source);
  if (equal(current, original)) return null;
  if (!state.control || state.control.currentConsentId !== state.consent.id || a.objectiveStatus !== 'ready' ||
      a.objectiveVersion !== current.sourceObjectiveVersion || a.objectiveRevisionId !== current.sourceRevisionId ||
      ['canonicalPlanId', 'canonicalEpoch', 'canonicalStrategyId', 'canonicalProjectId'].some(key =>
        current[key as keyof WorkSource] !== original[key as keyof WorkSource]) ||
      current.canonicalBindingVersion <= original.canonicalBindingVersion || current.sourceObjectiveVersion <= original.sourceObjectiveVersion ||
      current.rootIntentId === original.rootIntentId || current.sourceRevisionId === original.sourceRevisionId ||
      current.sourceSnapshotHash === original.sourceSnapshotHash) return invalid();
  return { ...current };
}
export function verifiedObjectivePlannerRegenerationWitness(value: unknown, a: WorkAuthority, state: WorkState): boolean {
  try {
    const witness = closed(value, ['state', 'source']), advanced = objectivePlannerAdvancedSource(a, state);
    return witness.state === 'not_started' && advanced !== null && equal(source(witness.source), advanced);
  } catch { return false; }
}
