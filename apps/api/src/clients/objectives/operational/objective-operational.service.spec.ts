import { HttpException } from '@nestjs/common';
import {
  lockObjectivePlanResource,
  readObjectivePlanResource,
  type ObjectiveOperationalSelection,
  type ObjectiveOperationalSourceRead,
  type ObjectiveOperationalTx,
  type TenantContext,
} from '@capiro/shared';
import type { PrismaService } from '../../../prisma/prisma.service.js';
import {
  lockObjectiveLocalResource,
  readObjectiveLocalResource,
  validateObjectiveCycleContext,
  type ObjectiveLocalResourceGate,
} from './objective-local-resources.js';
import { ObjectiveOperationalCursors } from './objective-operational.cursor.js';
import { assembleOperationalProjection } from './objective-operational.projection.js';
import { operationalDigest, operationalFailure } from './objective-operational.rules.js';
import {
  commitOperationalCommand,
  findOperationalReceipt,
  listOperationalLinks,
  loadCurrentOperationalScopeWithinTx,
  matchOperationalReplay,
  readOperationalSetVersion,
  type OperationalLinkRecord,
} from './objective-operational.store.js';
import { ObjectiveOperationalService } from './objective-operational.service.js';
import type {
  OperationalAssociationReceipt,
  OperationalLinkCommand,
  OperationalReadRequest,
  OperationalReceiptRequest,
  OperationalScope,
  OperationalUnlinkCommand,
} from './objective-operational.types.js';

// This suite exercises orchestration only. No real Prisma/owner/provider module
// is instantiated and no SQL, network, or resource mutation is performed.
jest.mock('@capiro/shared', () => ({
  lockObjectivePlanResource: jest.fn(),
  readObjectivePlanResource: jest.fn(),
}));
jest.mock('../../../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock('./objective-local-resources.js', () => ({
  lockObjectiveLocalResource: jest.fn(),
  readObjectiveLocalResource: jest.fn(),
  validateObjectiveCycleContext: jest.fn(),
}));
jest.mock('./objective-operational.store.js', () => ({
  commitOperationalCommand: jest.fn(),
  findOperationalReceipt: jest.fn(),
  listOperationalLinks: jest.fn(),
  loadCurrentOperationalScopeWithinTx: jest.fn(),
  matchOperationalReplay: jest.fn(),
  readOperationalSetVersion: jest.fn(),
}));
jest.mock('./objective-operational.projection.js', () => ({
  assembleOperationalProjection: jest.fn(),
}));

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ctx: TenantContext = {
  tenantId: uuid(1),
  tenantSlug: 'tenant',
  userId: uuid(2),
  clerkUserId: 'clerk-user-2',
  role: 'standard_user',
};
const scope: OperationalScope = {
  clientId: uuid(3),
  objectiveId: uuid(4),
  currentRevisionId: uuid(5),
  objectiveVersion: 9,
  objectiveStatus: 'ready',
  ownerUserId: ctx.userId,
};
const fixedAsOf = '2026-10-15T12:00:00.000Z';
const projected = { observed: 'projection-result' } as unknown as ReturnType<
  typeof assembleOperationalProjection
>;
const planLock = jest.mocked(lockObjectivePlanResource);
const localLock = jest.mocked(lockObjectiveLocalResource);
const planRead = jest.mocked(readObjectivePlanResource);
const localRead = jest.mocked(readObjectiveLocalResource);
const validateCycle = jest.mocked(validateObjectiveCycleContext);
const loadScope = jest.mocked(loadCurrentOperationalScopeWithinTx);
const findReceipt = jest.mocked(findOperationalReceipt);
const matchReplay = jest.mocked(matchOperationalReplay);
const commit = jest.mocked(commitOperationalCommand);
const listLinks = jest.mocked(listOperationalLinks);
const setVersion = jest.mocked(readOperationalSetVersion);
const project = jest.mocked(assembleOperationalProjection);

function command(): OperationalLinkCommand {
  return {
    schemaVersion: 1,
    requestId: uuid(6),
    clientId: scope.clientId,
    objectiveId: scope.objectiveId,
    expectedObjectiveVersion: scope.objectiveVersion,
    expectedAssociationSetVersion: 4,
    action: 'link',
    resource: { kind: 'strategy', id: uuid(7) },
    cycles: [],
  };
}
function receipt(input = command()): OperationalAssociationReceipt {
  const revision = {
    id: input.expectedObjectiveVersion === 2 ? uuid(8) : scope.currentRevisionId,
    version: input.expectedObjectiveVersion,
  };
  return {
    schemaVersion: 1,
    requestId: input.requestId,
    clientId: input.clientId,
    objectiveId: input.objectiveId,
    commandRevision: revision,
    associationLinkedRevision: { ...revision },
    associationId: uuid(9),
    resultSetVersion: input.expectedAssociationSetVersion + 1,
    payloadDigest: operationalDigest(input),
    committedAt: fixedAsOf,
    action: 'link',
    outcome: 'linked',
  };
}
function request(): OperationalReadRequest {
  return {
    schemaVersion: 1,
    clientId: scope.clientId,
    objectiveId: scope.objectiveId,
    limit: 2,
    cursors: { strategies: null, projects: null, decisions: null, engagements: null },
  };
}
function receiptRequest(): OperationalReceiptRequest {
  return {
    schemaVersion: 1,
    requestId: uuid(6),
    clientId: scope.clientId,
    objectiveId: scope.objectiveId,
  };
}
function observation(selection: ObjectiveOperationalSelection): ObjectiveOperationalSourceRead {
  return {
    resource: {
      selection,
      title: null,
      ownerVersion: { kind: 'counter', value: 12 },
      observedAt: fixedAsOf,
    },
  };
}
function link(
  n: number,
  resourceKind: OperationalLinkRecord['resourceKind'] = 'strategy',
): OperationalLinkRecord {
  return {
    id: uuid(1000 + n),
    resourceId: uuid(2000 + n),
    resourceKind,
    linkedRevisionId: uuid(8),
    linkedObjectiveVersion: 2,
    linkedAt: new Date(fixedAsOf),
    cycles: [],
    removedAt: null,
  };
}
function decodedCursor(asOf: string): ReturnType<ObjectiveOperationalCursors['decode']> {
  return {
    v: 1,
    tenant: ctx.tenantId,
    actor: ctx.userId,
    client: scope.clientId,
    objective: scope.objectiveId,
    revision: scope.currentRevisionId,
    set: 4,
    section: 'strategies',
    snapshot: 'a'.repeat(64),
    asOf,
    limit: 2,
    offset: 2,
  };
}

function harness() {
  const events: string[] = [];
  const sql: Array<{ text: string; values: unknown[] }> = [];
  const transactions: ObjectiveOperationalTx[] = [];
  const query = jest.fn(() => {
    throw new Error('Service must delegate source/store SQL');
  });
  const execute = jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    sql.push({ text, values });
    events.push(
      text.includes('pg_advisory_xact_lock_shared')
        ? 'set:shared'
        : text.includes('pg_advisory_xact_lock(')
          ? 'set:exclusive'
          : 'timeout',
    );
    return 1;
  });
  const withTenant = jest.fn(
    async (
      _tenant: string,
      fn: (tx: ObjectiveOperationalTx) => Promise<unknown>,
      _options?: unknown,
    ) => {
      const tx = { $queryRaw: query, $executeRaw: execute } as unknown as ObjectiveOperationalTx;
      transactions.push(tx);
      events.push('transaction:begin');
      try {
        const value = await fn(tx);
        events.push('transaction:commit');
        return value;
      } catch (error) {
        events.push('transaction:rollback');
        throw error;
      }
    },
  );
  loadScope.mockImplementation(async () => {
    events.push('current-authority');
    return scope;
  });
  findReceipt.mockImplementation(async () => {
    events.push('receipt:lookup');
    return null;
  });
  matchReplay.mockImplementation((found) => {
    events.push('receipt:match');
    return found;
  });
  planLock.mockImplementation(async (_tx, _actor, selection) => {
    events.push(`owner:plan:${selection.kind}:${selection.id}`);
  });
  localLock.mockImplementation(async (_tx, _actor, selection) => {
    events.push(`owner:local:${selection.kind}:${selection.id}`);
    return undefined;
  });
  planRead.mockImplementation(async (_tx, _actor, _binding, selection) => {
    events.push(`read:plan:${selection.kind}:${selection.id}`);
    return observation(selection);
  });
  localRead.mockImplementation(async (_tx, _actor, _binding, selection) => {
    events.push(`read:local:${selection.kind}:${selection.id}`);
    return observation(selection);
  });
  validateCycle.mockImplementation(async () => {
    events.push('cycle:validate');
    return true;
  });
  commit.mockImplementation(async (_tx, _actor, _scope, input, validate) => {
    events.push('commit:cas');
    await validate();
    events.push('commit:persist');
    return receipt(input as OperationalLinkCommand);
  });
  setVersion.mockImplementation(async () => {
    events.push('set:version');
    return 4;
  });
  listLinks.mockImplementation(async () => {
    events.push('links:list');
    return [];
  });
  project.mockImplementation(() => {
    events.push('projection');
    return projected;
  });
  const prisma = { withTenant } as unknown as PrismaService;
  return {
    service: new ObjectiveOperationalService(prisma),
    events,
    sql,
    query,
    execute,
    withTenant,
    transactions,
  };
}

async function failure(
  work: Promise<unknown>,
): Promise<{ exception: HttpException; response: Record<string, unknown> }> {
  try {
    await work;
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    const exception = error as HttpException;
    return { exception, response: exception.getResponse() as Record<string, unknown> };
  }
  throw new Error('Expected an operational failure');
}

describe('Objective operational service authority and transaction orchestration', () => {
  beforeEach(() => jest.resetAllMocks());
  afterEach(() => jest.restoreAllMocks());

  it('recovers a historical receipt only after fresh current authority, without source gates or present CAS', async () => {
    const h = harness();
    const historicalCommand = {
      ...command(),
      expectedObjectiveVersion: 2,
      expectedAssociationSetVersion: 0,
    };
    const saved = receipt(historicalCommand);
    findReceipt.mockImplementationOnce(async () => {
      h.events.push('receipt:lookup');
      return saved;
    });
    expect(await h.service.command(ctx, historicalCommand)).toBe(saved);
    expect(h.withTenant).toHaveBeenCalledTimes(1);
    expect(loadScope).toHaveBeenCalledWith(
      h.transactions[0],
      ctx,
      scope.clientId,
      scope.objectiveId,
    );
    expect(findReceipt).toHaveBeenCalledWith(
      h.transactions[0],
      ctx,
      scope,
      historicalCommand.requestId,
    );
    expect(matchReplay).toHaveBeenCalledWith(saved, historicalCommand);
    expect(h.events.indexOf('current-authority')).toBeLessThan(h.events.indexOf('receipt:lookup'));
    expect(commit).not.toHaveBeenCalled();
    expect(planLock).not.toHaveBeenCalled();
    expect(localLock).not.toHaveBeenCalled();
    expect(planRead).not.toHaveBeenCalled();
    expect(localRead).not.toHaveBeenCalled();
    expect(h.sql.every((q) => !q.text.includes('pg_advisory'))).toBe(true);
  });

  it('does not expose a historical receipt after current client or Objective authority is lost', async () => {
    const h = harness();
    findReceipt.mockResolvedValue(receipt());
    loadScope.mockImplementationOnce(async () => operationalFailure('NOT_AVAILABLE'));
    const result = await failure(
      h.service.command(ctx, { ...command(), expectedObjectiveVersion: 2 }),
    );
    expect(result.response).toEqual({
      schemaVersion: 1,
      requestId: null,
      status: 404,
      code: 'NOT_AVAILABLE',
      outcome: 'unknown',
    });
    expect(findReceipt).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(planLock).not.toHaveBeenCalled();
    expect(localLock).not.toHaveBeenCalled();
    expect(h.withTenant).toHaveBeenCalledTimes(1);
  });

  it('takes source/context gates before fresh Core authority and the exclusive association gate on a new link', async () => {
    const h = harness();
    const input = command();
    input.cycles = [
      {
        fiscalYear: 2028,
        authorityTrack: 'authorization',
        basis: 'human_annotation',
        context: { kind: 'defense_budget_cycle', id: uuid(20) },
      },
      {
        fiscalYear: 2027,
        authorityTrack: null,
        basis: 'human_annotation',
        context: { kind: 'budget_package', id: uuid(21) },
      },
      {
        fiscalYear: 2027,
        authorityTrack: 'authorization',
        basis: 'human_annotation',
        context: { kind: 'budget_package', id: uuid(21) },
      },
    ];
    expect(await h.service.command(ctx, input)).toMatchObject({
      action: 'link',
      outcome: 'linked',
    });
    expect(h.withTenant).toHaveBeenCalledTimes(2);
    expect(h.transactions[0]).not.toBe(h.transactions[1]);
    expect(loadScope).toHaveBeenCalledTimes(2);
    expect(planLock).toHaveBeenCalledWith(h.transactions[1], ctx, input.resource);
    expect(localLock.mock.calls.map((args) => args[2])).toEqual([
      { kind: 'budget_package', id: uuid(21) },
      { kind: 'defense_budget_cycle', id: uuid(20) },
    ]);
    const sourceGate = h.events.indexOf(`owner:plan:strategy:${input.resource.id}`);
    const contextGate = h.events.indexOf(`owner:local:defense_budget_cycle:${uuid(20)}`);
    const authority = h.events.lastIndexOf('current-authority');
    expect(sourceGate).toBeLessThan(contextGate);
    expect(contextGate).toBeLessThan(authority);
    expect(authority).toBeLessThan(h.events.indexOf('set:exclusive'));
    expect(h.events.indexOf('set:exclusive')).toBeLessThan(h.events.indexOf('commit:cas'));
    expect(h.events.indexOf('commit:cas')).toBeLessThan(
      h.events.indexOf(`read:plan:strategy:${input.resource.id}`),
    );
    expect(h.events.indexOf('cycle:validate')).toBeLessThan(h.events.indexOf('commit:persist'));
    expect(validateCycle).toHaveBeenCalledTimes(3);
    expect(commit).toHaveBeenCalledWith(h.transactions[1], ctx, scope, input, expect.any(Function));
    expect(planRead.mock.calls[0]![2]).toEqual({
      clientId: scope.clientId,
      objectiveId: scope.objectiveId,
      objectiveVersion: scope.objectiveVersion,
      objectiveRevisionId: scope.currentRevisionId,
    });
    expect(
      h.withTenant.mock.calls.every(
        (args) => JSON.stringify(args[2]) === JSON.stringify({ timeoutMs: 15000 }),
      ),
    ).toBe(true);
    expect(h.sql.every((q) => q.text.startsWith('SELECT'))).toBe(true);
    expect(h.query).not.toHaveBeenCalled();
  });

  it('uses the local source owner gate for a meeting link and rechecks source eligibility within the commit', async () => {
    const h = harness();
    const input: OperationalLinkCommand = {
      ...command(),
      resource: { kind: 'meeting', id: uuid(30) },
    };
    await h.service.command(ctx, input);
    expect(planLock).not.toHaveBeenCalled();
    expect(planRead).not.toHaveBeenCalled();
    expect(localLock).toHaveBeenCalledWith(h.transactions[1], ctx, input.resource, input.clientId);
    expect(localRead).toHaveBeenCalledWith(
      h.transactions[1],
      ctx,
      expect.objectContaining({
        clientId: scope.clientId,
        objectiveVersion: scope.objectiveVersion,
      }),
      input.resource,
      expect.any(String),
      expect.any(String),
    );
    const readCall = localRead.mock.calls[0]!;
    expect(readCall[4]).toBe(readCall[5]);
  });

  it('passes the same opaque meeting gate only to final write validation, while ordinary reads receive no gate', async () => {
    const h = harness();
    const input: OperationalLinkCommand = {
      ...command(),
      resource: { kind: 'meeting', id: uuid(30) },
    };
    const gate: ObjectiveLocalResourceGate = {
      kind: 'meeting',
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      clientId: scope.clientId,
      meetingId: input.resource.id,
      lockedPersonIds: [uuid(35)],
      lockedAttendeeIds: [uuid(36)],
    };
    Object.freeze(gate);
    localLock.mockResolvedValueOnce(gate);
    await h.service.command(ctx, input);
    expect(localLock).toHaveBeenCalledWith(h.transactions[1], ctx, input.resource, input.clientId);
    expect(localRead.mock.calls[0]![6]).toBe(gate);
    expect(localRead).toHaveBeenCalledWith(
      h.transactions[1],
      ctx,
      {
        clientId: scope.clientId,
        objectiveId: scope.objectiveId,
        objectiveVersion: scope.objectiveVersion,
        objectiveRevisionId: scope.currentRevisionId,
      },
      input.resource,
      expect.any(String),
      expect.any(String),
      gate,
    );

    localRead.mockClear();
    localLock.mockClear();
    listLinks.mockResolvedValueOnce([{ ...link(31, 'meeting'), resourceId: input.resource.id }]);
    expect(await h.service.read(ctx, request())).toBe(projected);
    expect(localLock).not.toHaveBeenCalled();
    expect(localRead).toHaveBeenCalledTimes(1);
    expect(localRead.mock.calls[0]).toHaveLength(6);
    expect(localRead.mock.calls[0]![6]).toBeUndefined();
    expect(localRead.mock.calls[0]![0]).toBe(h.transactions[2]);
  });

  it('passes the reloaded current scope to CAS when the Objective advances after replay lookup', async () => {
    const h = harness();
    const input = command();
    const advanced = { ...scope, objectiveVersion: 10, currentRevisionId: uuid(34) };
    loadScope.mockResolvedValueOnce(scope).mockResolvedValueOnce(advanced);
    commit.mockImplementationOnce(async (_tx, _actor, current, submitted) => {
      expect(current).toBe(advanced);
      expect(submitted.expectedObjectiveVersion).toBe(9);
      operationalFailure('OBJECTIVE_VERSION_CONFLICT', submitted.requestId);
    });
    const result = await failure(h.service.command(ctx, input));
    expect(result.response).toMatchObject({
      status: 409,
      code: 'OBJECTIVE_VERSION_CONFLICT',
      outcome: 'rejected',
    });
    expect(loadScope).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledWith(
      h.transactions[1],
      ctx,
      advanced,
      input,
      expect.any(Function),
    );
    expect(planLock).toHaveBeenCalledTimes(1);
    expect(planRead).not.toHaveBeenCalled();
    expect(h.events).not.toContain('commit:persist');
  });

  it('fails with safe 503 when the owner gate cannot be established, before second Core authority or CAS', async () => {
    const h = harness();
    const input = command();
    planLock.mockRejectedValueOnce(new Error('SQL lock table private_schema password=secret'));
    const result = await failure(h.service.command(ctx, input));
    expect(result.response).toEqual({
      schemaVersion: 1,
      requestId: input.requestId,
      status: 503,
      code: 'OWNER_UNAVAILABLE',
      outcome: 'unknown',
    });
    expect(loadScope).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    expect(planRead).not.toHaveBeenCalled();
    expect(h.events).not.toContain('set:exclusive');
    expect(h.events[h.events.length - 1]).toBe('transaction:rollback');
  });

  it('fails closed on source unavailability before any association persistence or underlying resource write', async () => {
    const h = harness();
    planRead.mockResolvedValueOnce(null);
    const input = command();
    const result = await failure(h.service.command(ctx, input));
    expect(result.response).toEqual({
      schemaVersion: 1,
      requestId: input.requestId,
      status: 404,
      code: 'NOT_AVAILABLE',
      outcome: 'unknown',
    });
    expect(h.events).not.toContain('commit:persist');
    expect(h.events[h.events.length - 1]).toBe('transaction:rollback');
    expect(validateCycle).not.toHaveBeenCalled();
    expect(h.sql.every((q) => q.text.startsWith('SELECT'))).toBe(true);
    expect(h.query).not.toHaveBeenCalled();
  });

  it('awaits asynchronous cycle validation and refuses a changed or unavailable cycle context', async () => {
    const h = harness();
    const input = command();
    input.cycles = [
      {
        fiscalYear: 2027,
        authorityTrack: 'authorization',
        basis: 'human_annotation',
        context: { kind: 'defense_budget_cycle', id: uuid(31) },
      },
    ];
    validateCycle.mockResolvedValueOnce(false);
    const result = await failure(h.service.command(ctx, input));
    expect(result.response).toMatchObject({
      status: 404,
      code: 'NOT_AVAILABLE',
      outcome: 'unknown',
      requestId: input.requestId,
    });
    expect(validateCycle).toHaveBeenCalledWith(h.transactions[1], ctx, input.cycles[0]);
    expect(h.events).not.toContain('commit:persist');
    expect(h.events[h.events.length - 1]).toBe('transaction:rollback');
    expect(h.sql.every((q) => q.text.startsWith('SELECT'))).toBe(true);
  });

  it('preserves the fixed store conflict when immutable annotations changed', async () => {
    const h = harness();
    const input = command();
    commit.mockImplementationOnce(async () =>
      operationalFailure('REQUEST_CONFLICT', input.requestId),
    );
    const result = await failure(h.service.command(ctx, input));
    expect(result.response).toEqual({
      schemaVersion: 1,
      requestId: input.requestId,
      status: 409,
      code: 'REQUEST_CONFLICT',
      outcome: 'rejected',
    });
    expect(h.events).not.toContain('commit:persist');
    expect(planRead).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
  });

  it('delegates new unlink CAS to the store without acquiring or reading the removed resource owner', async () => {
    const h = harness();
    const input: OperationalUnlinkCommand = {
      schemaVersion: 1,
      requestId: uuid(32),
      clientId: scope.clientId,
      objectiveId: scope.objectiveId,
      expectedObjectiveVersion: scope.objectiveVersion,
      expectedAssociationSetVersion: 4,
      action: 'unlink',
      associationId: uuid(33),
    };
    const saved = {
      ...receipt(),
      requestId: input.requestId,
      action: 'unlink' as const,
      outcome: 'unlinked' as const,
    };
    commit.mockImplementationOnce(async (_tx, _actor, _scope, _input, validate) => {
      await validate();
      return saved;
    });
    expect(await h.service.command(ctx, input)).toBe(saved);
    expect(commit).toHaveBeenCalledWith(h.transactions[1], ctx, scope, input, expect.any(Function));
    expect(planLock).not.toHaveBeenCalled();
    expect(localLock).not.toHaveBeenCalled();
    expect(planRead).not.toHaveBeenCalled();
    expect(localRead).not.toHaveBeenCalled();
    expect(validateCycle).not.toHaveBeenCalled();
    expect(h.events).toContain('set:exclusive');
  });

  it.each(['transaction', 'owner', 'store', 'projection'] as const)(
    'maps an unexpected %s error to a fixed safe 503 without SQL or connection details',
    async (location) => {
      const h = harness();
      const secret =
        'postgres://private:password@internal/db SELECT secret_token FROM hidden_table';
      const thrown = new Error(secret);
      if (location === 'transaction') h.withTenant.mockRejectedValueOnce(thrown);
      if (location === 'owner') {
        listLinks.mockResolvedValueOnce([link(1)]);
        planRead.mockRejectedValueOnce(thrown);
      }
      if (location === 'store') listLinks.mockRejectedValueOnce(thrown);
      if (location === 'projection')
        project.mockImplementationOnce(() => {
          throw thrown;
        });
      const result = await failure(h.service.read(ctx, request()));
      expect(result.exception.getStatus()).toBe(503);
      expect(result.response).toEqual({
        schemaVersion: 1,
        requestId: null,
        status: 503,
        code: 'OWNER_UNAVAILABLE',
        outcome: 'unknown',
      });
      expect(JSON.stringify(result.response)).not.toMatch(
        /postgres|password|secret_token|hidden_table|SELECT/,
      );
    },
  );

  it('does not trust an arbitrary HttpException body supplied by an owner port', async () => {
    const h = harness();
    listLinks.mockResolvedValueOnce([link(1)]);
    planRead.mockRejectedValueOnce(
      new HttpException({ message: 'SQL password=secret FROM private_schema' }, 503),
    );
    const result = await failure(h.service.read(ctx, request()));
    expect(result.response).toEqual({
      schemaVersion: 1,
      requestId: null,
      status: 503,
      code: 'OWNER_UNAVAILABLE',
      outcome: 'unknown',
    });
  });

  it('returns an absent receipt as fixed 404 unknown after current authority', async () => {
    const h = harness();
    const input = receiptRequest();
    const result = await failure(h.service.receipt(ctx, input));
    expect(result.response).toEqual({
      schemaVersion: 1,
      requestId: input.requestId,
      status: 404,
      code: 'RECEIPT_NOT_AVAILABLE',
      outcome: 'unknown',
    });
    expect(h.events.indexOf('current-authority')).toBeLessThan(h.events.indexOf('receipt:lookup'));
    expect(findReceipt).toHaveBeenCalledWith(h.transactions[0], ctx, scope, input.requestId);
    expect(commit).not.toHaveBeenCalled();
    expect(planLock).not.toHaveBeenCalled();
    expect(localLock).not.toHaveBeenCalled();
  });

  it('checks current authority on receipt GET even when a historical receipt exists', async () => {
    const h = harness();
    loadScope.mockImplementationOnce(async () => operationalFailure('NOT_AVAILABLE'));
    findReceipt.mockResolvedValue(receipt());
    const result = await failure(h.service.receipt(ctx, receiptRequest()));
    expect(result.response).toMatchObject({
      status: 404,
      code: 'NOT_AVAILABLE',
      outcome: 'unknown',
    });
    expect(findReceipt).not.toHaveBeenCalled();
    expect(JSON.stringify(result.response)).not.toContain('associationLinkedRevision');
  });

  it('rejects mixed cursor cutoffs as 409 before opening a transaction or reading authority', async () => {
    const h = harness();
    const input = request();
    input.cursors.strategies = 'first-token';
    input.cursors.projects = 'second-token';
    jest
      .spyOn(ObjectiveOperationalCursors.prototype, 'decode')
      .mockReturnValueOnce(decodedCursor(fixedAsOf))
      .mockReturnValueOnce(decodedCursor('2026-10-15T12:01:00.000Z'));
    const result = await failure(h.service.read(ctx, input));
    expect(result.response).toEqual({
      schemaVersion: 1,
      requestId: null,
      status: 409,
      code: 'CURSOR_STALE',
      outcome: 'rejected',
    });
    expect(h.withTenant).not.toHaveBeenCalled();
    expect(loadScope).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
    expect(project).not.toHaveBeenCalled();
  });

  it('reads current authority before a shared association gate and resolves all associated sources before projection', async () => {
    const h = harness();
    const kinds: OperationalLinkRecord['resourceKind'][] = [
      'strategy',
      'planner_project',
      'planner_task',
      'meeting',
      'outreach_session',
    ];
    const associated = Array.from({ length: 305 }, (_, n) => link(n, kinds[n % kinds.length]!));
    listLinks.mockImplementationOnce(async () => {
      h.events.push('links:list');
      return associated;
    });
    const input = request();
    input.cursors.strategies = 'one-cutoff';
    jest
      .spyOn(ObjectiveOperationalCursors.prototype, 'decode')
      .mockReturnValue(decodedCursor(fixedAsOf));
    localRead.mockImplementationOnce(async () => null);
    expect(await h.service.read(ctx, input)).toBe(projected);
    expect(h.withTenant).toHaveBeenCalledTimes(1);
    expect(h.events.indexOf('current-authority')).toBeLessThan(h.events.indexOf('set:shared'));
    expect(h.events.indexOf('set:shared')).toBeLessThan(h.events.indexOf('set:version'));
    expect(h.events.indexOf('set:version')).toBeLessThan(h.events.indexOf('links:list'));
    expect(h.events.indexOf('links:list')).toBeLessThan(h.events.indexOf('projection'));
    expect(planRead).toHaveBeenCalledTimes(183);
    expect(localRead).toHaveBeenCalledTimes(122);
    expect(planLock).not.toHaveBeenCalled();
    expect(localLock).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    const passed = project.mock.calls[0]![0];
    expect(passed).toMatchObject({
      actor: ctx,
      scope,
      setVersion: 4,
      request: input,
      asOf: fixedAsOf,
    });
    expect(passed.observations).toHaveLength(305);
    expect(passed.observations.map((entry) => entry.link)).toEqual(associated);
    expect(passed.observations.filter((entry) => entry.source === null)).toHaveLength(1);
    for (const args of [...planRead.mock.calls, ...localRead.mock.calls]) {
      expect(args[0]).toBe(h.transactions[0]);
      expect(args[1]).toBe(ctx);
      expect(args[2]).toEqual({
        clientId: scope.clientId,
        objectiveId: scope.objectiveId,
        objectiveVersion: scope.objectiveVersion,
        objectiveRevisionId: scope.currentRevisionId,
      });
      expect(args[5]).toBe(fixedAsOf);
    }
    expect(h.sql.some((q) => q.text.includes('pg_advisory_xact_lock_shared'))).toBe(true);
    expect(h.sql.every((q) => q.text.startsWith('SELECT'))).toBe(true);
    expect(h.query).not.toHaveBeenCalled();
  });

  it('does not enumerate associations or read sources after current read authority is denied', async () => {
    const h = harness();
    loadScope.mockImplementationOnce(async () => operationalFailure('NOT_AVAILABLE'));
    const result = await failure(h.service.read(ctx, request()));
    expect(result.response).toMatchObject({
      status: 404,
      outcome: 'unknown',
      code: 'NOT_AVAILABLE',
    });
    expect(setVersion).not.toHaveBeenCalled();
    expect(listLinks).not.toHaveBeenCalled();
    expect(planRead).not.toHaveBeenCalled();
    expect(localRead).not.toHaveBeenCalled();
    expect(project).not.toHaveBeenCalled();
    expect(h.sql.every((q) => !q.text.includes('pg_advisory'))).toBe(true);
  });
});
