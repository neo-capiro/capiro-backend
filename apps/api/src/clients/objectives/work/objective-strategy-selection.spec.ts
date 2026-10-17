import { parseWorkCommand, workDigest } from './objective-work-command.js';
import { objectiveStrategyRequestCodec, objectiveStrategySelectedDraft, objectiveStrategySelectionDigest,
  parseObjectiveStrategySelection } from './objective-strategy-selection.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const body = () => ({ schemaVersion: 2, command: { schemaVersion: 1, requestId: id(1), command: 'retry',
  workAction: 'objective.strategy.draft', expectedObjectiveVersion: 2, expectedControlVersion: 0,
  expectedCanonicalBindingVersion: 3, targetAuthorizationRequestId: null },
selection: { type: 'appropriations', generationRequestId: id(2) } });
describe('additive selected Strategy command', () => {
  test('preserves the exact v1 work command and digest while binding explicit selection separately', () => {
    const wire = body(), selected = parseObjectiveStrategySelection(id(3), id(4), wire);
    expect(selected.work).toEqual(parseWorkCommand(id(3), id(4), wire.command));
    expect(workDigest(selected.work)).toBe(workDigest(parseWorkCommand(id(3), id(4), wire.command)));
    const changed = body(); changed.selection.type = 'authorization';
    expect(objectiveStrategySelectionDigest(selected)).not.toBe(objectiveStrategySelectionDigest(
      parseObjectiveStrategySelection(id(3), id(4), changed)));
    changed.selection.type = 'appropriations'; changed.selection.generationRequestId = id(5);
    expect(objectiveStrategySelectionDigest(selected)).not.toBe(objectiveStrategySelectionDigest(
      parseObjectiveStrategySelection(id(3), id(4), changed)));
  });
  test.each(['appropriations', 'authorization', 'regulatory', 'coalition', 'procurement', 'earmark', 'amendment'])(
    'uses the actual shared request codec for %s', type => {
      const wire = body(); wire.selection.type = type;
      const r = parseObjectiveStrategySelection(id(3), id(4), wire);
      const draft = objectiveStrategySelectedDraft(r, { sourceObjectiveVersion: 2, canonicalBindingVersion: 3 } as any);
      expect(draft).toEqual({ requestId: id(2), clientId: id(3), objective: { objectiveId: id(4), objectiveVersion: 2 }, type });
      expect(objectiveStrategyRequestCodec.requestKey(id(6), 'user_original', draft.requestId)).toMatch(/^objective-v1:[0-9a-f]{64}$/);
    });
  test.each([
    (v: any) => { delete v.selection; }, (v: any) => { v.selection.type = 'meri_propose'; },
    (v: any) => { v.selection.generationRequestId += '\n'; }, (v: any) => { v.selection.extra = true; },
    (v: any) => { v.command.workAction = 'objective.plan.prepare'; }, (v: any) => { v.command.command = 'cancel'; },
    (v: any) => { v.schemaVersion = 1; }, (v: any) => { v.actorUserId = id(7); },
  ])('rejects unapproved or ambiguous selection input %#', mutate => {
    const wire = body(); mutate(wire);
    expect(() => parseObjectiveStrategySelection(id(3), id(4), wire)).toThrow('INVALID_REQUEST');
  });
  test('rejects accessors and proxies before observing caller properties', () => {
    const wire = body(), get = jest.fn(() => 'appropriations');
    Object.defineProperty(wire.selection, 'type', { enumerable: true, get });
    expect(() => parseObjectiveStrategySelection(id(3), id(4), wire)).toThrow('INVALID_REQUEST');
    expect(get).not.toHaveBeenCalled();
    const trap = jest.fn();
    expect(() => parseObjectiveStrategySelection(id(3), id(4), new Proxy(body(), { ownKeys: trap }))).toThrow('INVALID_REQUEST');
    expect(trap).not.toHaveBeenCalled();
  });
  test('captures an independent normalized command before asynchronous work', () => {
    const wire = body(), r = parseObjectiveStrategySelection(id(3), id(4), wire), digest = objectiveStrategySelectionDigest(r);
    wire.selection.type = 'authorization'; wire.command.expectedObjectiveVersion = 99;
    expect(r.selection.type).toBe('appropriations'); expect(r.work.command.expectedObjectiveVersion).toBe(2);
    expect(objectiveStrategySelectionDigest(r)).toBe(digest);
  });
});
