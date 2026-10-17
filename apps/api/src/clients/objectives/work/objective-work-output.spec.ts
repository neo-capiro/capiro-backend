import { parseWorkOutputRead, ObjectiveWorkError } from './objective-work-command.js';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const query = () => ({ workAction: 'objective.plan.prepare', sourceRevisionId: id(6),
  sourceObjectiveVersion: '3', canonicalBindingVersion: '2' });
const read = (raw: unknown) => parseWorkOutputRead(id(4), id(5), raw);

describe('public Planner receipt source selectors', () => {
  it('parses the exact source independently of the current Objective or binding counter', () => {
    expect(read(query())).toEqual({ clientId: id(4), objectiveId: id(5), workAction: 'objective.plan.prepare',
      source: { revision: { id: id(6), version: 3 }, canonicalBindingVersion: 2 } });
  });
  it('accepts the Strategy action for an explicit unavailable observation, never Planner fallback', () => {
    expect(read({ ...query(), workAction: 'objective.strategy.draft' }).workAction).toBe('objective.strategy.draft');
  });
  it.each(['0', '-1', '01', '+1', '1.0', '1e2', ' 1', '1 ', '2147483648', '99999999999', '', '\n1',
    '1\n', '1\r', '1\r\n', '1\u2028', '1\u2029'])
  ('rejects noncanonical/out-of-range source counter %j', value => {
    for (const key of ['sourceObjectiveVersion', 'canonicalBindingVersion'])
      expect(() => read({ ...query(), [key]: value })).toThrow(ObjectiveWorkError);
  });
  it.each([1, null, true, ['1'], { value: '1' }])('rejects an ambiguous/repeated counter %j', value => {
    expect(() => read({ ...query(), sourceObjectiveVersion: value })).toThrow(ObjectiveWorkError);
  });
  it.each(['requestId', 'operationId', 'attemptId', 'runId', 'projectId', 'receiptId', 'strategyType', 'snapshotHash'])
  ('rejects caller-selected private/output field %s', key => {
    expect(() => read({ ...query(), [key]: id(99) })).toThrow(ObjectiveWorkError);
  });
  it.each(['workAction', 'sourceRevisionId', 'sourceObjectiveVersion', 'canonicalBindingVersion'])
  ('requires source field %s', key => {
    const raw: Record<string, unknown> = query(); delete raw[key];
    expect(() => read(raw)).toThrow(ObjectiveWorkError);
  });
  it('rejects invalid UUID, action, prototype, hidden/symbol fields and getters without invoking them', () => {
    const getter = jest.fn(() => id(6));
    const accessor = Object.defineProperty({ ...query() }, 'sourceRevisionId', { get: getter, enumerable: true });
    const hidden = Object.defineProperty({ ...query() }, 'private', { value: id(99), enumerable: false });
    const symbol = { ...query(), [Symbol('secret')]: 'private' };
    for (const raw of [accessor, hidden, symbol, Object.create(query()), new Proxy(query(), {}),
      { ...query(), sourceRevisionId: 'not-an-id' }, { ...query(), workAction: 'other' }, null, []])
      expect(() => read(raw)).toThrow(ObjectiveWorkError);
    expect(getter).not.toHaveBeenCalled();
  });
  it('validates client and Objective route scope before a service receives the selector', () => {
    expect(() => parseWorkOutputRead('other', id(5), query())).toThrow(ObjectiveWorkError);
    expect(() => parseWorkOutputRead(id(4), 'other', query())).toThrow(ObjectiveWorkError);
  });
});
