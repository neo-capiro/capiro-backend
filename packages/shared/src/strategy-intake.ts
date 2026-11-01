/** Browser-safe questionnaire shared by Objectives and Strategies > Fill with Meri. */
export const STRATEGY_INTAKE_TYPES = ['appropriations', 'authorization', 'regulatory', 'coalition',
  'procurement', 'earmark', 'amendment'] as const;
export type StrategyIntakeType = (typeof STRATEGY_INTAKE_TYPES)[number];
export const STRATEGY_INTAKE_TYPE_LABELS: Record<StrategyIntakeType, string> = {
  appropriations: 'Appropriations ask', authorization: 'Authorization', regulatory: 'Regulatory / policy',
  coalition: 'Coalition / positioning', procurement: 'Contract / procurement', earmark: 'Grant / earmark',
  amendment: 'Amendment',
};
export const STRATEGY_INTAKE_FIELDS = {
  clientId: { label: 'Client', required: true },
  type: { label: 'Objective type', required: true },
  goal: { label: 'Goal statement', required: true, maxLength: 4000 },
  ownerUserId: { label: 'Owner', required: true, maxLength: 120 },
  targetDate: { label: 'Target outcome date', required: false },
  meriContext: { label: 'Context for Meri', required: false, maxLength: 8000 },
} as const;
export interface StrategyIntakeDraft {
  schemaVersion: 1; type: StrategyIntakeType | null; goal: string;
  /** The same opaque Clerk member identifier used by the Strategy owner selector. */
  ownerUserId: string | null; targetDate: string | null; meriContext: string;
}
export interface StrategyIntakeAnswers extends StrategyIntakeDraft {
  type: StrategyIntakeType; ownerUserId: string;
}
export class StrategyIntakeValidationError extends Error {
  readonly field: keyof StrategyIntakeDraft | 'strategyIntake';
  constructor(field: keyof StrategyIntakeDraft | 'strategyIntake', message: string) { super(message); this.field = field; }
}
export function emptyStrategyIntake(ownerUserId: string | null = null): StrategyIntakeDraft {
  return { schemaVersion: 1, type: null, goal: '', ownerUserId, targetDate: null, meriContext: '' };
}
export function strategyIntakeReadiness(value: StrategyIntakeDraft) {
  const checklist = { type: value.type !== null && STRATEGY_INTAKE_TYPES.includes(value.type),
    goal: !!value.goal.trim(), ownerUserId: !!value.ownerUserId?.trim() };
  const completedFields = Object.values(checklist).filter(Boolean).length;
  return { checklist, completedFields, requiredFields: 3 as const, isReady: completedFields === 3 };
}
export function parseStrategyIntake(raw: unknown, options: { requireComplete: true }): StrategyIntakeAnswers;
export function parseStrategyIntake(raw: unknown, options?: { requireComplete?: boolean }): StrategyIntakeDraft;
export function parseStrategyIntake(raw: unknown, options: { requireComplete?: boolean } = {}): StrategyIntakeDraft {
  const fail = (field: keyof StrategyIntakeDraft | 'strategyIntake', message: string): never => {
    throw new StrategyIntakeValidationError(field, message);
  };
  const keys = ['schemaVersion', 'type', 'goal', 'ownerUserId', 'targetDate', 'meriContext'] as const;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) ||
      Reflect.ownKeys(raw).length !== keys.length || Reflect.ownKeys(raw).some(k => !keys.includes(k as typeof keys[number])))
    return fail('strategyIntake', 'Invalid Strategy intake');
  const value: Record<string, any> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return fail(key, 'Invalid Strategy intake field');
    value[key] = descriptor.value;
  }
  if (value.schemaVersion !== 1) return fail('schemaVersion', 'Unsupported Strategy intake version');
  if (value.type !== null && !STRATEGY_INTAKE_TYPES.includes(value.type)) return fail('type', 'Select an objective type');
  for (const key of ['goal', 'meriContext'] as const) {
    if (typeof value[key] !== 'string' || value[key].length > STRATEGY_INTAKE_FIELDS[key].maxLength)
      return fail(key, `${STRATEGY_INTAKE_FIELDS[key].label} exceeds its maximum length`);
  }
  if (value.ownerUserId !== null && (typeof value.ownerUserId !== 'string' || !value.ownerUserId.trim() ||
      value.ownerUserId.length > 120)) return fail('ownerUserId', 'Select an owner');
  if (value.targetDate !== null) {
    const date = typeof value.targetDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.targetDate) ? new Date(value.targetDate) : null;
    if (!date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value.targetDate)
      return fail('targetDate', 'Enter a valid target outcome date');
  }
  const parsed = value as StrategyIntakeDraft;
  if (options.requireComplete && !strategyIntakeReadiness(parsed).isReady)
    return fail('strategyIntake', 'Complete objective type, goal statement and owner first');
  // Preserve answers exactly. Readiness trims only to detect blank required fields.
  return parsed;
}

export interface LegacyObjectiveIntent {
  outcome: string; governmentProblem: string; askType: string; minimumWin: string; limits: string;
}
export type ObjectiveGenerationIntent = LegacyObjectiveIntent |
  { kind: 'strategy-intake'; strategyIntake: StrategyIntakeAnswers };
export function parseObjectiveGenerationIntent(raw: unknown): ObjectiveGenerationIntent {
  const fail = (): never => { throw new StrategyIntakeValidationError('strategyIntake', 'Invalid saved Objective intent'); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return fail();
  const keys = Object.hasOwn(raw, 'kind') ? ['kind', 'strategyIntake'] :
    ['outcome', 'governmentProblem', 'askType', 'minimumWin', 'limits'];
  if (Reflect.ownKeys(raw).length !== keys.length || Reflect.ownKeys(raw).some(k => !keys.includes(k as string))) return fail();
  const value: Record<string, any> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(raw, key);
    if (!d?.enumerable || !('value' in d)) return fail();
    value[key] = d.value;
  }
  if ('kind' in value) {
    if (value.kind !== 'strategy-intake') return fail();
    return { kind: 'strategy-intake', strategyIntake: parseStrategyIntake(value.strategyIntake, { requireComplete: true }) };
  }
  for (const [key, maximum] of Object.entries({ outcome: 2000, governmentProblem: 4000, minimumWin: 2000, limits: 4000 })) {
    if (typeof value[key] !== 'string' || value[key].length > maximum || key !== 'limits' && !value[key].trim()) return fail();
  }
  if (!['funding', 'policy_authority', 'both', 'protect_funding', 'meri_propose'].includes(value.askType)) return fail();
  return value as LegacyObjectiveIntent;
}
export function objectiveIntentGoal(intent: ObjectiveGenerationIntent): string {
  return 'kind' in intent ? intent.strategyIntake.goal : intent.outcome;
}
/** Projection only; the caller owns current authorization and snapshot validation. */
export function objectiveIntentFromSnapshot(snapshot: Record<string, any>): ObjectiveGenerationIntent {
  if (Object.hasOwn(snapshot, 'strategyIntake')) return {
    kind: 'strategy-intake', strategyIntake: parseStrategyIntake(snapshot.strategyIntake, { requireComplete: true }),
  };
  return { outcome: snapshot.outcome, governmentProblem: snapshot.governmentProblem,
    askType: snapshot.askType, minimumWin: snapshot.minimumWin, limits: snapshot.limits };
}
/** Exact saved answers become the existing Strategy DTO; legacy records retain their original shape. */
export function objectiveStrategyDraftInput(clientId: string, selectedType: StrategyIntakeType, intent: ObjectiveGenerationIntent,
  mode: 'initial' | 'regenerate' = 'initial') {
  if ('kind' in intent) {
    const answers = parseStrategyIntake(intent.strategyIntake, { requireComplete: true });
    if (mode !== 'regenerate' && answers.type !== selectedType)
      throw new StrategyIntakeValidationError('type', 'Saved objective type changed');
    const { schemaVersion: _version, ...fields } = answers;
    // Regeneration's selected type is resolved from the saved canonical Strategy by the owner.
    return { clientId, ...fields, type: selectedType };
  }
  return { clientId, type: selectedType, goal: intent.outcome };
}
