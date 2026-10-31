import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import {
  readClassicOutreachRecord, withClassicOutreachEligibleIds,
  ClassicOutreachObservationIncompleteError, ClassicOutreachObservationChangedError,
  type ClassicOutreachScope,
} from './classic-outreach-authority.js';

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const ctx = { tenantId: id(1), userId: id(2), clerkUserId: 'synthetic-clerk', role: 'standard_user' } as TenantContext;
const date = (n = 0) => new Date(1793404800000 + n);
const child = (n: number, changes: object = {}) => ({ id: id(n), tenantId: ctx.tenantId, clientId: null,
  createdAt: date(), generatedFrom: null, ...changes });
const row = (n: number, changes: object = {}) => ({ id: id(n), tenantId: ctx.tenantId,
  createdByUserId: ctx.userId, clientId: null, meetingId: null, meeting: null,
  type: 'follow_up', deletedAt: null, updatedAt: date(), body: 'Saved synthetic text', ...changes });
const linked = (changes: object = {}) => row(10, { meetingId: id(20), meeting: {
  id: id(20), tenantId: ctx.tenantId, clientId: null, preps: [child(30)], debriefs: [], ...changes,
} });

function matches(value: any, where: any): boolean {
  if (where === undefined) return true;
  if (where === null || typeof where !== 'object') return value === where;
  if ('not' in where) return !matches(value, where.not);
  if ('notIn' in where) return !where.notIn.includes(value);
  if ('in' in where) return where.in.includes(value);
  return Object.entries(where).every(([key, expected]: [string, any]) => {
    if (key === 'AND') return (Array.isArray(expected) ? expected : [expected]).every((p: any) => matches(value, p));
    if (key === 'OR') return expected.some((p: any) => matches(value, p));
    return matches(value?.[key], expected);
  });
}
function project(value: any, selection: any): any {
  if (value === null || value === undefined) return value;
  if (!selection) return structuredClone(value);
  return Object.fromEntries(Object.entries(selection).map(([key, options]: [string, any]) => {
    let field = value[key];
    if (Array.isArray(field)) {
      field = [...field];
      if (options.orderBy?.createdAt === 'desc') field.sort((a: any, b: any) => b.createdAt.getTime() - a.createdAt.getTime());
      field = field.slice(0, options.take).map((entry: any) => project(entry, options.select));
    } else field = project(field, options === true ? undefined : options.select);
    return [key, field];
  }));
}

function fixture(initial: any[] = [row(10)]) {
  const rows = structuredClone(initial);
  const visible = new Set([id(40), id(41)]);
  const state = { active: true, role: 'standard_user', native: true, connector: true, noteAuthor: ctx.userId };
  const tx: any = {
    tenantMembership: { findFirst: jest.fn(async ({ where }: any) =>
      state.active && where.tenantId === ctx.tenantId && where.userId === ctx.userId &&
      (!where.user || where.user.clerkUserId === ctx.clerkUserId) ? { id: id(3), role: state.role } : null) },
    outreachRecord: {
      findFirst: jest.fn(async ({ where, select }: any) => project(rows.find(r => matches(r, where)) ?? null, select)),
      findMany: jest.fn(async ({ where, select, take }: any) => rows.filter(r => matches(r, where))
        .sort((a, b) => a.id.localeCompare(b.id)).slice(0, take).map(r => project(r, select))),
    },
    client: {
      findFirst: jest.fn(async ({ where }: any) => visible.has(where.id) && where.tenantId === ctx.tenantId ? { id: where.id } : null),
      count: jest.fn(async ({ where }: any) => where.id.in.filter((clientId: string) => visible.has(clientId)).length),
    },
    $queryRawUnsafe: jest.fn(async (_sql: string, _tenant: string, clientId: string) => [{ allowed: visible.has(clientId) }]),
    $executeRaw: jest.fn(async () => 1),
    meeting: { count: jest.fn(async ({ where }: any) => state.native ? where.id.in.length : 0) },
    mailMessage: { count: jest.fn(async ({ where }: any) => state.native ? where.id.in.length : 0) },
    engagementTask: { count: jest.fn(async ({ where }: any) => state.native ? where.id.in.length : 0) },
    meetingNote: { findMany: jest.fn(async ({ where }: any) => where.id.in.map((noteId: string) => ({ id: noteId,
      confidential: true, accessLevel: 'tenant_admins_and_author', authorUserId: state.noteAuthor }))) },
    meetingDebrief: { findMany: jest.fn(async () => []) },
    clioMcpServer: { count: jest.fn(async () => Number(state.connector)) },
  };
  const prisma: any = { withTenant: jest.fn(async (tenant: string, run: any) => {
    expect(tenant).toBe(ctx.tenantId); return run(tx);
  }) };
  const control = { maxCandidates: 100, assertActive: jest.fn() };
  const query = jest.fn(async (ids: readonly string[]) => ({ count: ids.length }));
  const run = (scope: ClassicOutreachScope = { kind: 'personal_classic' }) =>
    withClassicOutreachEligibleIds(prisma, ctx, scope, control, query);
  const detail = () => readClassicOutreachRecord(tx, ctx, rows[0].id, async () => {
    const value = structuredClone(rows[0]);
    if (value.meeting) {
      value.meeting.preps = value.meeting.preps.slice().sort((a: any, b: any) => b.createdAt - a.createdAt).slice(0, 1);
      value.meeting.debriefs = value.meeting.debriefs.slice().sort((a: any, b: any) => b.createdAt - a.createdAt).slice(0, 1);
    }
    return value;
  });
  return { rows, visible, state, tx, prisma, control, query, run, detail };
}

test('complete server-owned universe excludes foreign, deleted and reserved records before count', async () => {
  const f = fixture([row(10), row(11, { clientId: id(40) }), row(12, { createdByUserId: id(9) }),
    row(13, { tenantId: id(9) }), row(14, { deletedAt: date() }), row(15, { type: 'outreach_v3' }), row(16, { clientId: id(99) })]);
  await expect(f.run()).resolves.toEqual({ count: 2 });
  expect(f.query).toHaveBeenLastCalledWith([id(10), id(11)]);
  expect(Object.isFrozen(f.query.mock.calls[0]![0])).toBe(true);
  await expect(f.run({ kind: 'client_associated' })).resolves.toEqual({ count: 1 });
  await expect(f.run({ kind: 'client', clientId: id(40) })).resolves.toEqual({ count: 1 });
  expect(f.tx.outreachRecord.findMany.mock.calls[0][0].select).not.toHaveProperty('body');
});

test.each(['inactive actor', 'wrong Clerk', 'hidden selected client'])('%s refuses the whole query', async (change) => {
  const f = fixture();
  if (change === 'inactive actor') f.state.active = false;
  if (change === 'wrong Clerk') f.tx.tenantMembership.findFirst.mockResolvedValue(null);
  await expect(f.run(change === 'hidden selected client' ? { kind: 'client', clientId: id(99) } : undefined)).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
});

test.each(['parent', 'meeting', 'prep', 'debrief', 'foreign meeting', 'foreign child', 'missing meeting'])(
  '%s association denial is shared by ordinary detail and pre-aggregate observation', async (change) => {
    const f = fixture([linked({ debriefs: [child(31)] })]);
    const r = f.rows[0];
    if (change === 'parent') r.clientId = id(99);
    if (change === 'meeting') r.meeting.clientId = id(99);
    if (change === 'prep') r.meeting.preps[0].clientId = id(99);
    if (change === 'debrief') r.meeting.debriefs[0].clientId = id(99);
    if (change === 'foreign meeting') r.meeting.tenantId = id(99);
    if (change === 'foreign child') r.meeting.preps[0].tenantId = id(99);
    if (change === 'missing meeting') r.meeting = null;
    await expect(f.detail()).rejects.toThrow('Outreach record not found');
    await expect(f.run()).resolves.toEqual({ count: 0 });
    expect(f.query).toHaveBeenCalledWith([]);
  },
);

test.each(['preps', 'debriefs'])('tied latest %s fail closed even if both clients are currently visible', async (kind) => {
  const f = fixture([linked({ [kind]: [child(30), child(31), child(32)] })]);
  await expect(f.detail()).rejects.toThrow();
  await expect(f.run()).resolves.toEqual({ count: 0 });
  const selection = f.tx.outreachRecord.findMany.mock.calls[0][0].select.meeting.select[kind];
  expect(selection).toMatchObject({ take: 2, orderBy: { createdAt: 'desc' } });
});

test('a distinctly older denied child cannot replace or revoke the authorized latest child', async () => {
  const f = fixture([linked({ preps: [child(30, { createdAt: date(2) }), child(31, { clientId: id(99) })] })]);
  await expect(f.detail()).resolves.toMatchObject({ id: id(10) });
  await expect(f.run()).resolves.toEqual({ count: 1 });
});

test('detail refuses a new tied child appearing while its projection loads', async () => {
  const f = fixture([linked()]);
  await expect(readClassicOutreachRecord(f.tx, ctx, id(10), async () => {
    const body = structuredClone(f.rows[0]);
    f.rows[0].meeting.preps.push(child(31));
    return body;
  })).rejects.toThrow('Outreach record not found');
});

test('the existing trash reader option stays separate from ordinary detail and the SQL universe', async () => {
  const f = fixture([row(10, { deletedAt: date() })]);
  await expect(f.detail()).rejects.toThrow();
  await expect(readClassicOutreachRecord(f.tx, ctx, id(10), async () => structuredClone(f.rows[0]), true))
    .resolves.toMatchObject({ id: id(10) });
  await expect(f.run()).resolves.toEqual({ count: 0 });
});

function native(f: ReturnType<typeof fixture>) {
  f.rows[0].meeting.preps[0].generatedFrom = { briefing: true, grounding: { accessSources: [{ access: {
    clients: [id(40)], meetings: [id(20)], mail: [id(50)], tasks: [id(51)], notes: [id(52)],
  } }] } };
}
test.each(['valid', 'revoked source', 'confidential note', 'missing provenance', 'wall loss'])(
  'actual saved native source oracle handles %s', async (change) => {
    const f = fixture([linked()]); native(f);
    if (change === 'revoked source') f.state.native = false;
    if (change === 'confidential note') f.state.noteAuthor = id(99);
    if (change === 'missing provenance') f.rows[0].meeting.preps[0].generatedFrom.grounding = {};
    if (change === 'wall loss') f.visible.delete(id(40));
    await expect(f.run()).resolves.toEqual({ count: change === 'valid' ? 1 : 0 });
    if (change === 'valid') await expect(f.detail()).resolves.toMatchObject({ id: id(10) });
    else await expect(f.detail()).rejects.toThrow();
  },
);

test('personal connector revocation hides the saved source and withholds an in-flight aggregate', async () => {
  const env = jest.replaceProperty(process, 'env', { ...process.env, MERI_MCP_MONDAY_ENABLED: 'true',
    MERI_MCP_MONDAY_ALLOWED_USER_IDS: ctx.userId, MERI_MCP_MONDAY_ALLOWED_TENANT_IDS: ctx.tenantId });
  try {
    const f = fixture([linked()]);
    f.rows[0].meeting.preps[0].generatedFrom = { briefing: true, grounding: { accessSources: [{ access: {
      clients: [id(40)], mondayUsers: [ctx.userId], mondayBoards: ['synthetic-board'],
    } }] } };
    f.query.mockImplementation(async () => { f.state.connector = false; return { count: 1 }; });
    await expect(f.run()).rejects.toBeInstanceOf(ClassicOutreachObservationChangedError);
    await expect(f.detail()).rejects.toThrow();
  } finally { env.restore(); }
});

test.each(['wall', 'source', 'membership', 'association', 'tie', 'new record', 'deleted', 'saved revision'])(
  '%s change during query withholds the entire aggregate', async (change) => {
    const f = fixture([linked()]); native(f);
    f.query.mockImplementation(async () => {
      if (change === 'wall') f.visible.delete(id(40));
      if (change === 'source') f.state.native = false;
      if (change === 'membership') f.state.active = false;
      if (change === 'association') f.rows[0].meeting.preps[0].generatedFrom = null;
      if (change === 'tie') f.rows[0].meeting.preps.push(child(31));
      if (change === 'new record') f.rows.push(row(11));
      if (change === 'deleted') f.rows[0].deletedAt = date();
      if (change === 'saved revision') f.rows[0].updatedAt = date(1);
      return { count: 1 };
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.query).toHaveBeenCalledTimes(1);
  },
);

test('candidate overflow refuses before aggregation even when excess candidates might be denied', async () => {
  const f = fixture([row(10), row(11, { clientId: id(99) })]); f.control.maxCandidates = 1;
  await expect(f.run()).rejects.toBeInstanceOf(ClassicOutreachObservationIncompleteError);
  expect(f.query).not.toHaveBeenCalled();
  expect(f.tx.outreachRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2 }));
});
test('a genuinely empty complete universe permits a zero aggregate', async () => {
  const f = fixture([]); await expect(f.run()).resolves.toEqual({ count: 0 });
  expect(f.query).toHaveBeenCalledWith([]);
});
test('deadline refusal and infrastructure failure never become an authorized empty set', async () => {
  const f = fixture([linked()]); native(f);
  f.tx.client.count.mockRejectedValue(new Error('source infrastructure unavailable'));
  await expect(f.run()).rejects.toThrow('source infrastructure unavailable');
  expect(f.query).not.toHaveBeenCalled();
  f.control.assertActive.mockImplementation(() => { throw new Error('request expired'); });
  await expect(f.run()).rejects.toThrow('request expired');
  expect(f.query).not.toHaveBeenCalled();
});

function research(f: ReturnType<typeof fixture>) {
  const bounded = { kind: 'research_portfolio', researchPortfolioId: id(60), researchPortfolioName: 'Synthetic', researchPortfolioRevision: 1 };
  const scope = { ...bounded, scopeVersion: createHash('sha256').update(JSON.stringify(bounded)).digest('hex') };
  const generated = { schemaVersion: 'research_portfolio_institutional_v1', artifactId: id(61), actorUserId: ctx.userId, meetingId: id(20) };
  const artifact = { id: id(61), tenantId: ctx.tenantId, userId: ctx.userId, clientId: null, conversationId: id(62), kind: 'research_portfolio_meeting',
    metadata: { schemaVersion: generated.schemaVersion, researchPortfolioScope: scope, sourceLineage: {}, meetingPrepId: id(30), meetingId: id(20) } };
  const conversation = { id: id(62), tenantId: ctx.tenantId, userId: ctx.userId, clientId: null, metadata: { researchPortfolioScope: scope } };
  const prep = { id: id(30), meetingId: id(20), clientId: null as string | null, generatedFrom: generated };
  f.rows[0].meeting.preps[0].generatedFrom = generated;
  f.tx.clioArtifact = { findFirst: jest.fn(async () => artifact) };
  f.tx.clioConversation = { findFirst: jest.fn(async () => conversation) };
  f.tx.researchPortfolio = { findFirst: jest.fn(async () => ({ id: id(60), grants: [{ role: 'viewer' }], clientLinks: [] })) };
  f.tx.meetingPrep = { findFirst: jest.fn(async () => prep) };
  f.tx.meeting.findFirst = jest.fn(async () => ({ id: id(20), clientId: null, isInternal: true }));
  return { artifact, conversation, prep };
}
test.each(['valid', 'grant', 'hash', 'actor', 'rebound conversation', 'meeting reassignment'])(
  'actual Research artifact/conversation oracle handles %s', async (change) => {
    const f = fixture([linked()]); const rp = research(f);
    if (change === 'grant') f.tx.researchPortfolio.findFirst.mockResolvedValue(null);
    if (change === 'hash') rp.artifact.metadata.researchPortfolioScope.scopeVersion = 'forged';
    if (change === 'actor') rp.artifact.userId = id(99);
    if (change === 'rebound conversation') rp.conversation.metadata.researchPortfolioScope = { ...rp.conversation.metadata.researchPortfolioScope, researchPortfolioId: id(99) };
    if (change === 'meeting reassignment') rp.prep.meetingId = id(99);
    await expect(f.run()).resolves.toEqual({ count: change === 'valid' ? 1 : 0 });
    if (change === 'valid') {
      await expect(f.detail()).resolves.toMatchObject({ id: id(10) });
      expect(f.tx.$executeRaw).toHaveBeenCalled();
    } else await expect(f.detail()).rejects.toThrow();
  },
);
test('Research grant revocation after preflight prevents aggregate release', async () => {
  const f = fixture([linked()]); research(f);
  f.query.mockImplementation(async () => { f.tx.researchPortfolio.findFirst.mockResolvedValue(null); return { count: 1 }; });
  await expect(f.run()).rejects.toBeInstanceOf(ClassicOutreachObservationChangedError);
});
