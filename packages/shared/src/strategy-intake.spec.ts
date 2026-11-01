import { emptyStrategyIntake, objectiveIntentFromSnapshot, objectiveStrategyDraftInput,
  parseStrategyIntake, strategyIntakeReadiness, STRATEGY_INTAKE_TYPES } from './strategy-intake.js';

describe('shared Strategy questionnaire contract', () => {
  const answers = () => ({ ...emptyStrategyIntake('user_synthetic'), type: 'authorization' as const,
    goal: ' G'.repeat(2000), meriContext: ' C'.repeat(4000), targetDate: '2028-02-29' });
  test('every historical type and exact full-length answer round-trips without legacy synthesis', () => {
    for (const type of STRATEGY_INTAKE_TYPES) {
      const value = { ...answers(), type };
      expect(parseStrategyIntake(value, { requireComplete: true })).toEqual(value);
      const intent = objectiveIntentFromSnapshot({ strategyIntake: value });
      expect(intent).toEqual({ kind: 'strategy-intake', strategyIntake: value });
      const { schemaVersion: _version, ...fields } = value;
      expect(objectiveStrategyDraftInput('client', type, intent)).toEqual({ clientId: 'client', ...fields });
    }
  });
  test('partial saved draft uses the same three required answers', () => {
    expect(parseStrategyIntake(emptyStrategyIntake())).toEqual(emptyStrategyIntake());
    expect(strategyIntakeReadiness(emptyStrategyIntake())).toEqual({ checklist: { type: false, goal: false,
      ownerUserId: false }, completedFields: 0, requiredFields: 3, isReady: false });
    expect(() => parseStrategyIntake(emptyStrategyIntake(), { requireComplete: true })).toThrow();
  });
  test.each([
    { goal: 'x'.repeat(4001) }, { meriContext: 'x'.repeat(8001) }, { targetDate: '2027-02-29' },
    { targetDate: '2027-02-28\n' }, { ownerUserId: '' }, { type: 'invented' }, { schemaVersion: 2 },
    { extra: true },
  ])('refuses invalid answer %j', changes => expect(() => parseStrategyIntake({ ...answers(), ...changes })).toThrow());
  test('old snapshots stay old and an invalid present intake never falls back to legacy fields', () => {
    const legacy = { outcome: 'O', governmentProblem: 'P', askType: 'funding', minimumWin: 'M', limits: '' };
    expect(objectiveIntentFromSnapshot(legacy)).toEqual(legacy);
    expect(objectiveStrategyDraftInput('client', 'appropriations', legacy)).toEqual({ clientId: 'client',
      type: 'appropriations', goal: 'O' });
    expect(() => objectiveIntentFromSnapshot({ ...legacy, strategyIntake: null })).toThrow();
  });
  test('closed fields never invoke accessor answers', () => {
    const getter = jest.fn();
    const value = Object.defineProperty(answers(), 'goal', { enumerable: true, get: getter });
    expect(() => parseStrategyIntake(value)).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
});
