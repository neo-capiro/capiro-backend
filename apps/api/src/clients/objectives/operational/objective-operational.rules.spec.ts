import { createHash } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import {
  canonicalJson,
  operationalDigest,
  operationalFailure,
  parseOperationalCommand,
  parseOperationalReadQuery,
  parseOperationalReceiptQuery,
} from './objective-operational.rules.js';
import type { OperationalCycle, OperationalErrorCode } from './objective-operational.types.js';

const clientId = 'abcdefab-1234-4567-89ab-abcdefabcdef';
const objectiveId = '22222222-2222-4222-8222-222222222222';
const requestId = '33333333-3333-4333-8333-333333333333';
const resourceId = '44444444-4444-4444-8444-444444444444';
const contextId = '55555555-5555-4555-8555-555555555555';

function annotation(fiscalYear = 2027): OperationalCycle {
  return {
    fiscalYear,
    authorityTrack: '  authorizations  ',
    basis: 'human_annotation',
    context: null,
  };
}
function link(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    requestId,
    clientId,
    objectiveId,
    expectedObjectiveVersion: 7,
    expectedAssociationSetVersion: 0,
    action: 'link',
    resource: { kind: 'strategy', id: resourceId },
    cycles: [],
    ...overrides,
  };
}
function query(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: '1', objectiveId, limit: '20', ...overrides };
}
function failureOf(action: () => unknown): HttpException {
  try {
    action();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(HttpException);
    return error as HttpException;
  }
  throw new Error('Expected a fixed operational failure');
}
describe('Objective operational command wire boundary', () => {
  it('normalizes every UUID without trimming or rewriting annotations', () => {
    const cycle = {
      ...annotation(),
      context: { kind: 'budget_package', id: clientId.toUpperCase() },
    };
    const parsed = parseOperationalCommand(
      link({
        requestId: clientId.toUpperCase(),
        clientId: clientId.toUpperCase(),
        objectiveId: clientId.toUpperCase(),
        resource: { kind: 'strategy', id: clientId.toUpperCase() },
        cycles: [cycle],
      }),
      clientId,
    );
    expect(parsed).toEqual(
      link({
        requestId: clientId,
        objectiveId: clientId,
        resource: { kind: 'strategy', id: clientId },
        cycles: [{ ...cycle, context: { kind: 'budget_package', id: clientId } }],
      }),
    );
    expect(cycle.context.id).toBe(clientId.toUpperCase());
  });

  it.each(['strategy', 'planner_project', 'planner_task', 'outreach_session', 'meeting'])(
    'accepts an explicit %s resource with no invented resource cap',
    (kind) => {
      expect(
        parseOperationalCommand(link({ resource: { kind, id: resourceId } }), clientId),
      ).toMatchObject({ action: 'link', resource: { kind, id: resourceId }, cycles: [] });
    },
  );

  it('parses the closed unlink variant with independent CAS versions', () => {
    const { resource: _resource, cycles: _cycles, ...base } = link();
    expect(
      parseOperationalCommand(
        {
          ...base,
          action: 'unlink',
          associationId: contextId,
          expectedObjectiveVersion: 2147483647,
          expectedAssociationSetVersion: 2147483647,
        },
        clientId,
      ),
    ).toEqual({
      ...base,
      action: 'unlink',
      associationId: contextId,
      expectedObjectiveVersion: 2147483647,
      expectedAssociationSetVersion: 2147483647,
    });
  });

  it.each(['tenantId', 'actor', 'provenance', 'objectiveStatus', 'taskCap', 'expectedVersion'])(
    'rejects caller-supplied %s',
    (key) => {
      const error = failureOf(() =>
        parseOperationalCommand(link({ [key]: 'untrusted' }), clientId),
      );
      expect(error.getStatus()).toBe(400);
      expect(error.getResponse()).toEqual({
        schemaVersion: 1,
        status: 400,
        code: 'MALFORMED_REQUEST',
        outcome: 'rejected',
        requestId,
      });
    },
  );

  it('rejects path/body mismatch and fields from the other command variant', () => {
    for (const body of [
      link({ clientId: contextId }),
      link({ associationId: contextId }),
      link({ schemaVersion: '1' }),
    ]) {
      expect(failureOf(() => parseOperationalCommand(body, clientId)).getStatus()).toBe(400);
    }
  });

  it.each(['\n', '\r', '\r\n', '\u2028', '\u2029'])(
    'rejects terminal line delimiters in UUIDs (%p)',
    (suffix) => {
      expect(
        failureOf(() =>
          parseOperationalCommand(link({ requestId: requestId + suffix }), clientId),
        ).getResponse(),
      ).toMatchObject({ status: 400, requestId: null });
      expect(
        failureOf(() =>
          parseOperationalCommand(link({ objectiveId: objectiveId + suffix }), clientId),
        ).getStatus(),
      ).toBe(400);
      expect(
        failureOf(() => parseOperationalReadQuery(clientId + suffix, query())).getStatus(),
      ).toBe(400);
    },
  );

  it.each([0, -1, 1.5, NaN, Infinity, 2147483648, '7', null])(
    'rejects invalid Objective CAS %p',
    (value) => {
      expect(
        failureOf(() =>
          parseOperationalCommand(link({ expectedObjectiveVersion: value }), clientId),
        ).getStatus(),
      ).toBe(400);
    },
  );

  it.each([-1, 0.5, Infinity, 2147483648, '0', null])(
    'rejects invalid association CAS %p',
    (value) => {
      expect(
        failureOf(() =>
          parseOperationalCommand(link({ expectedAssociationSetVersion: value }), clientId),
        ).getStatus(),
      ).toBe(400);
    },
  );

  it.each(['budget_package', 'defense_budget_cycle'])(
    'refuses %s as an independent work item',
    (kind) => {
      const error = failureOf(() =>
        parseOperationalCommand(link({ resource: { kind, id: resourceId } }), clientId),
      );
      expect(error.getStatus()).toBe(422);
      expect(error.getResponse()).toMatchObject({
        code: 'UNSUPPORTED_RESOURCE',
        outcome: 'rejected',
        requestId,
      });
    },
  );

  it('rejects unknown, nested or expanded resource fields', () => {
    for (const resource of [
      { kind: 'question', id: resourceId },
      { kind: 'strategy', id: resourceId, tenantId: clientId },
      { kind: 'strategy', id: [resourceId] },
      { kind: 'strategy', id: ' ' + resourceId },
    ]) {
      expect(
        failureOf(() => parseOperationalCommand(link({ resource }), clientId)).getStatus(),
      ).toBe(400);
    }
  });

  it('accepts multiple Strategy annotations in submitted order and exact owner context selections', () => {
    const cycles = [
      { ...annotation(2029), context: { kind: 'defense_budget_cycle', id: contextId } },
      annotation(2027),
      { ...annotation(2028), context: { kind: 'budget_package', id: contextId } },
    ];
    expect(parseOperationalCommand(link({ cycles }), clientId)).toMatchObject({ cycles });
  });

  it('rejects duplicate canonical annotations, including UUID case aliases', () => {
    const first = { ...annotation(), context: { kind: 'budget_package', id: clientId } };
    const alias = {
      context: { id: clientId.toUpperCase(), kind: 'budget_package' },
      basis: 'human_annotation',
      authorityTrack: first.authorityTrack,
      fiscalYear: first.fiscalYear,
    };
    expect(
      failureOf(() =>
        parseOperationalCommand(link({ cycles: [first, alias] }), clientId),
      ).getStatus(),
    ).toBe(400);
  });

  it('allows annotations only on Strategy and validates the closed annotation shape', () => {
    const invalid = [
      { ...annotation(), fiscalYear: 0 },
      { ...annotation(), fiscalYear: 10000 },
      { ...annotation(), fiscalYear: 2027.5 },
      { ...annotation(), authorityTrack: '' },
      { ...annotation(), authorityTrack: 'a'.repeat(601) },
      { ...annotation(), basis: 'inferred' },
      { ...annotation(), context: { kind: 'meeting', id: contextId } },
      { ...annotation(), context: { kind: 'budget_package', id: contextId, official: true } },
      { ...annotation(), active: true },
      undefined,
    ];
    for (const value of invalid) {
      expect(
        failureOf(() => parseOperationalCommand(link({ cycles: [value] }), clientId)).getStatus(),
      ).toBe(400);
    }
    expect(
      failureOf(() =>
        parseOperationalCommand(
          link({ resource: { kind: 'planner_task', id: resourceId }, cycles: [annotation()] }),
          clientId,
        ),
      ).getStatus(),
    ).toBe(400);
    expect(
      failureOf(() =>
        parseOperationalCommand(link({ cycles: new Array(1) }), clientId),
      ).getStatus(),
    ).toBe(400);
  });

  it('counts string lengths as Unicode characters and preserves content', () => {
    const authorityTrack = '🧭'.repeat(600);
    expect(
      parseOperationalCommand(link({ cycles: [{ ...annotation(), authorityTrack }] }), clientId),
    ).toMatchObject({ cycles: [{ authorityTrack }] });
  });

  it('rejects non-JSON objects and accessors without executing them', () => {
    const getter = jest.fn(() => requestId);
    const input = link();
    Object.defineProperty(input, 'requestId', { enumerable: true, get: getter });
    for (const raw of [null, [], new Date(), Object.create({ requestId }), input]) {
      expect(failureOf(() => parseOperationalCommand(raw, clientId)).getStatus()).toBe(400);
    }
    const cycles: OperationalCycle[] = [];
    Object.defineProperty(cycles, '0', { enumerable: true, get: getter });
    expect(failureOf(() => parseOperationalCommand(link({ cycles }), clientId)).getStatus()).toBe(
      400,
    );
    expect(() => canonicalJson(cycles)).toThrow(TypeError);
    expect(getter).not.toHaveBeenCalled();
  });
});

describe('Objective operational GET query boundary', () => {
  it('decodes canonical strings and supplies every named absent cursor as null', () => {
    expect(
      parseOperationalReadQuery(
        clientId.toUpperCase(),
        query({ objectiveId: clientId.toUpperCase(), limit: '100' }),
      ),
    ).toEqual({
      schemaVersion: 1,
      clientId,
      objectiveId: clientId,
      limit: 100,
      cursors: { strategies: null, projects: null, decisions: null, engagements: null },
    });
    expect(
      parseOperationalReadQuery(
        clientId,
        query({
          limit: '1',
          strategiesCursor: 'a',
          projectsCursor: 'b',
          decisionsCursor: 'c',
          engagementsCursor: 'd',
        }),
      ),
    ).toMatchObject({
      limit: 1,
      cursors: { strategies: 'a', projects: 'b', decisions: 'c', engagements: 'd' },
    });
  });

  it.each([
    '01',
    '+1',
    '-1',
    '1.0',
    '1e1',
    ' 1',
    '1 ',
    '0',
    '101',
    '',
    '20\n',
    '20\r',
    '20\r\n',
    '20\u2028',
    '20\u2029',
    1,
    ['20'],
  ])('rejects noncanonical limit %p', (limit) => {
    expect(failureOf(() => parseOperationalReadQuery(clientId, query({ limit }))).getStatus()).toBe(
      400,
    );
  });

  it('rejects duplicate, unknown, nested and caller scope query fields', () => {
    for (const raw of [
      query({ schemaVersion: ['1', '1'] }),
      query({ schemaVersion: 1 }),
      query({ objectiveId: [objectiveId, objectiveId] }),
      query({ strategiesCursor: ['a', 'b'] }),
      query({ cursors: { strategies: 'a' } }),
      query({ clientId }),
      query({ tenantId: clientId }),
      query({ taskCap: '1' }),
      query({ strategiesCursor: '' }),
      query({ projectsCursor: null }),
      query({ decisionsCursor: undefined }),
      query({ engagementsCursor: 'a'.repeat(2049) }),
    ]) {
      expect(failureOf(() => parseOperationalReadQuery(clientId, raw)).getStatus()).toBe(400);
    }
  });

  it('supports query objects without an Object prototype and requires all required fields', () => {
    expect(
      parseOperationalReadQuery(clientId, Object.assign(Object.create(null), query())),
    ).toMatchObject({ limit: 20 });
    for (const raw of [
      { schemaVersion: '1', objectiveId },
      { objectiveId, limit: '20' },
      { schemaVersion: '1', limit: '20' },
    ]) {
      expect(failureOf(() => parseOperationalReadQuery(clientId, raw)).getStatus()).toBe(400);
    }
  });

  it('looks up exactly the path request and Objective, with no present-version parameter', () => {
    expect(
      parseOperationalReceiptQuery(clientId.toUpperCase(), clientId.toUpperCase(), {
        schemaVersion: '1',
        objectiveId,
      }),
    ).toEqual({
      schemaVersion: 1,
      clientId,
      requestId: clientId,
      objectiveId,
    });
    for (const extra of [
      { requestId },
      { clientId },
      { expectedObjectiveVersion: '7' },
      { limit: '20' },
      { objectiveId: [objectiveId] },
    ]) {
      const error = failureOf(() =>
        parseOperationalReceiptQuery(clientId, requestId, {
          schemaVersion: '1',
          objectiveId,
          ...extra,
        }),
      );
      expect(error.getStatus()).toBe(400);
      expect(error.getResponse()).toMatchObject({ requestId });
    }
  });
});

describe('Objective operational request identity and safe failures', () => {
  it('sorts object keys recursively, retains numeric-looking key order lexically, strings and arrays', () => {
    expect(
      canonicalJson({ z: [3, { b: '  unchanged\n', a: true }], '2': 2, '10': 10, a: null }),
    ).toBe('{"10":10,"2":2,"a":null,"z":[3,{"a":true,"b":"  unchanged\\n"}]}');
    expect(operationalDigest({ b: 2, a: 1 })).toBe(
      createHash('sha256').update('{"a":1,"b":2}', 'utf8').digest('hex'),
    );
  });

  it('changes request identity when annotation order changes, and retains equal object-key identity', () => {
    const first = parseOperationalCommand(
      link({ cycles: [annotation(2027), annotation(2028)] }),
      clientId,
    );
    const reversed = parseOperationalCommand(
      link({ cycles: [annotation(2028), annotation(2027)] }),
      clientId,
    );
    expect(operationalDigest(first)).not.toBe(operationalDigest(reversed));
    expect(operationalDigest({ z: first, a: 'é' })).toBe(operationalDigest({ a: 'é', z: first }));
  });

  it('refuses values that cannot be represented by canonical JSON', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    for (const value of [
      undefined,
      NaN,
      Infinity,
      BigInt(1),
      () => 1,
      new Date(),
      [undefined],
      new Array(1),
      cyclic,
    ]) {
      expect(() => canonicalJson(value)).toThrow(TypeError);
    }
  });

  it.each<[OperationalErrorCode, number, 'rejected' | 'unknown']>([
    ['MALFORMED_REQUEST', 400, 'rejected'],
    ['UNAUTHENTICATED', 401, 'rejected'],
    ['FORBIDDEN', 403, 'rejected'],
    ['NOT_AVAILABLE', 404, 'unknown'],
    ['RECEIPT_NOT_AVAILABLE', 404, 'unknown'],
    ['OBJECTIVE_VERSION_CONFLICT', 409, 'rejected'],
    ['ASSOCIATION_VERSION_CONFLICT', 409, 'rejected'],
    ['CURSOR_STALE', 409, 'rejected'],
    ['REQUEST_CONFLICT', 409, 'rejected'],
    ['UNSUPPORTED_RESOURCE', 422, 'rejected'],
    ['OWNER_UNAVAILABLE', 503, 'unknown'],
    ['RECEIPT_UNVERIFIABLE', 503, 'unknown'],
  ])('exposes only the fixed %s envelope', (code, status, outcome) => {
    const error = failureOf(() => operationalFailure(code, clientId.toUpperCase()));
    expect(error.getStatus()).toBe(status);
    expect(error.getResponse()).toEqual({
      schemaVersion: 1,
      status,
      code,
      outcome,
      requestId: clientId,
    });
  });

  it('does not echo an unsafe request identity or an unrecognized runtime error', () => {
    expect(
      failureOf(() => operationalFailure('RECEIPT_UNVERIFIABLE', 'SQL secret')).getResponse(),
    ).toEqual({
      schemaVersion: 1,
      status: 503,
      code: 'RECEIPT_UNVERIFIABLE',
      outcome: 'unknown',
      requestId: null,
    });
    expect(
      failureOf(() => operationalFailure('SQL secret' as OperationalErrorCode)).getResponse(),
    ).toEqual({
      schemaVersion: 1,
      status: 503,
      code: 'OWNER_UNAVAILABLE',
      outcome: 'unknown',
      requestId: null,
    });
    expect(
      failureOf(() => operationalFailure('NOT_AVAILABLE', requestId + '\n')).getResponse(),
    ).toMatchObject({ status: 404, requestId: null });
  });
});
