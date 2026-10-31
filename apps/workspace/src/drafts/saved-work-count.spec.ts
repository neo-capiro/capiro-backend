import { BadRequestException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { savedWorkCount } from './saved-work-count.js';
import { CollaboratorsService } from '../collaborators/collaborators.service.js';
import { requireDraftClient, draftClientSourceAccess } from './draft-client-access.js';
import { assertProspectDraft, prospectDraftSourceAccess } from '../prospect-resources/prospect-draft-access.js';
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock('./draft-client-access.js', () => ({ requireDraftClient: jest.fn(), draftClientSourceAccess: jest.fn() }));
jest.mock('../prospect-resources/prospect-draft-access.js', () => ({ assertProspectDraft: jest.fn(), prospectDraftSourceAccess: jest.fn() }));

const tenant = '11111111-1111-4111-8111-111111111111', actor = 'actor';
const client = 'abcdefab-2222-4222-8222-222222222222';
function draft(id: string, extra = {}) {
  return { id, tenantId: tenant, ownerId: actor, clientId: null, prospectId: null, status: 'draft',
    updatedAt: new Date('2026-01-01T00:00:00Z'), ...extra };
}
function fixture(rows = [draft('one')]) {
  const state = { rows, grants: [] as Array<{ draftId: string; subjectId: string; tenantId: string; status: string; role: string }> };
  const prisma: any = {
    $executeRaw: jest.fn(), $queryRaw: jest.fn(async () => []),
    $transaction: jest.fn(async fn => fn(prisma)),
    wsDraft: {
      findMany: jest.fn(async ({ where }) => state.rows.filter(row => row.tenantId === where.tenantId &&
        where.status.in.includes(row.status) && (!where.clientId || row.clientId === where.clientId) &&
        (row.ownerId === where.OR[0].ownerId || state.grants.some(g => g.draftId === row.id &&
          Object.entries(where.OR[1].collaborators.some).every(([k, v]) => (g as any)[k] === v))))
        .map(row => ({ ...row }))),
      findFirst: jest.fn(async ({ where }) => state.rows.find(row => row.id === where.id && row.tenantId === where.tenantId)),
    },
    wsCollaborator: { findFirst: jest.fn(async ({ where }) => state.grants.find(g =>
      Object.entries(where).every(([k, v]) => (g as any)[k] === v))) },
  };
  (requireDraftClient as jest.Mock).mockResolvedValue(undefined);
  (draftClientSourceAccess as jest.Mock).mockResolvedValue(true);
  (prospectDraftSourceAccess as jest.Mock).mockResolvedValue(true);
  (assertProspectDraft as jest.Mock).mockResolvedValue(undefined);
  const collaborators = new CollaboratorsService(prisma, {} as never);
  const run = (query = {}) => savedWorkCount(prisma, collaborators, tenant, actor, query);
  const grant = (id: string, status = 'active', role = 'viewer') =>
    state.grants.push({ draftId: id, subjectId: actor, tenantId: tenant, status, role });
  return { state, prisma, collaborators, run, grant };
}
afterEach(() => { jest.resetAllMocks(); jest.restoreAllMocks(); });

describe('complete saved work product observation through Drafts authority', () => {
  it('counts the whole population beyond list sizes, including General and both saved statuses', async () => {
    const f = fixture(Array.from({ length: 1205 }, (_, i) => draft(`draft-${i}`, {
      status: i % 2 ? 'complete' : 'draft', clientId: i % 3 ? client : null,
    })));
    const response = await f.run();
    expect(response).toMatchObject({ metric: 'workspace.saved-work-products', version: 1,
      scope: { kind: 'actor', clientId: null }, count: 1205, complete: true, capped: false });
    expect(Date.parse(response.observedAt)).toBeGreaterThanOrEqual(Date.parse(response.observationStartedAt));
    for (const [query] of f.prisma.wsDraft.findMany.mock.calls) {
      expect(query).not.toHaveProperty('take'); expect(query).not.toHaveProperty('skip'); expect(query).not.toHaveProperty('cursor');
      expect(query.select).not.toHaveProperty('documents'); expect(query.select).not.toHaveProperty('versions');
      expect(query.select).not.toHaveProperty('docCount');
    }
  });
  it('counts owner plus shared packet only once, not children, versions, invitations or foreign rows', async () => {
    const f = fixture([draft('packet', { status: 'complete', docCount: 9, documents: Array(9), versions: Array(20) }),
      draft('shared', { ownerId: 'other' }), draft('pending', { ownerId: 'other' }),
      draft('removed', { ownerId: 'other' }), draft('foreign', { tenantId: 'other' }), draft('hidden', { ownerId: 'other' })]);
    f.grant('packet'); f.grant('shared'); f.grant('shared', 'active', 'editor'); f.grant('pending', 'pending'); f.grant('removed', 'removed');
    expect(await f.run()).toMatchObject({ count: 2 });
  });
  it('selects exact saved client identity and validates it even when no products exist', async () => {
    const f = fixture([draft('general'), draft('selected', { clientId: client }), draft('other', { clientId: tenant })]);
    expect(await f.run({ clientId: client.toUpperCase() })).toMatchObject({ count: 1, scope: { kind: 'client', clientId: client } });
    expect(requireDraftClient).toHaveBeenCalledWith(f.prisma, f.prisma, tenant, actor, client);
    f.state.rows = [];
    expect(await f.run({ clientId: client })).toMatchObject({ count: 0, complete: true, capped: false });
  });
  it.each(['editor', 'reviewer', 'commenter', 'viewer'])('keeps the canonical readable %s collaborator role', async role => {
    const f = fixture([draft('shared', { ownerId: 'other' })]); f.grant('shared', 'active', role);
    expect(await f.run()).toMatchObject({ count: 1 });
  });
  it('excludes currently denied client/source/prospect products and deleted parents', async () => {
    const f = fixture([draft('client-denied'), draft('source-denied'), draft('prospect-denied', { prospectId: tenant }), draft('visible')]);
    (draftClientSourceAccess as jest.Mock).mockImplementation(async (_p, row) => row.id !== 'client-denied');
    (prospectDraftSourceAccess as jest.Mock).mockImplementation(async (_p, row) => row.id !== 'source-denied');
    (assertProspectDraft as jest.Mock).mockImplementation(async (_p, row) => { if (row.id === 'prospect-denied') throw new NotFoundException(); });
    expect(await f.run()).toMatchObject({ count: 1 });
    f.state.rows = [];
    expect(await f.run()).toMatchObject({ count: 0 });
  });
  it.each([{}, { clientId: client }])('never reports zero for scope denial: %j', async query => {
    const f = fixture([]); (requireDraftClient as jest.Mock).mockRejectedValue(new NotFoundException());
    await expect(f.run(query)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.prisma.wsDraft.findMany).not.toHaveBeenCalled();
  });
  it('withholds a result when membership or selected client is revoked at completion', async () => {
    const f = fixture(); (requireDraftClient as jest.Mock).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new NotFoundException());
    await expect(f.run()).rejects.toMatchObject({ response: { code: 'WORKSPACE_SAVED_WORK_ACCESS_DENIED' } });
  });
  it.each(['collaborator', 'client', 'source', 'prospect'])('detects earlier %s access revoked while observing a later product', async kind => {
    const f = fixture([draft('early', { ownerId: 'other' }), draft('late')]); f.grant('early');
    let revoked = false;
    (assertProspectDraft as jest.Mock).mockImplementation(async (_p, row) => {
      if (row.id === 'late') { revoked = true; if (kind === 'collaborator') f.state.grants = []; }
      if (row.id === 'early' && revoked && kind === 'prospect') throw new NotFoundException();
    });
    (draftClientSourceAccess as jest.Mock).mockImplementation(async (_p, row) => !(row.id === 'early' && revoked && kind === 'client'));
    (prospectDraftSourceAccess as jest.Mock).mockImplementation(async (_p, row) => !(row.id === 'early' && revoked && kind === 'source'));
    await expect(f.run()).rejects.toMatchObject({ response: { code: 'WORKSPACE_SAVED_WORK_INCOMPLETE' } });
  });
  it.each(['insert', 'delete', 'associate', 'edit'])('withholds changed parent population: %s', async change => {
    const f = fixture(); (assertProspectDraft as jest.Mock).mockImplementationOnce(async () => {
      if (change === 'insert') f.state.rows.push(draft('new'));
      if (change === 'delete') f.state.rows = [];
      if (change === 'associate') f.state.rows[0]!.clientId = client as never;
      if (change === 'edit') f.state.rows[0]!.updatedAt = new Date();
    });
    await expect(f.run()).rejects.toMatchObject({ response: { code: 'WORKSPACE_SAVED_WORK_INCOMPLETE' } });
  });
  it('withholds count on infrastructure failure, including a failed final population observation', async () => {
    const f = fixture(); f.prisma.wsDraft.findMany.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(f.run()).rejects.toMatchObject({ response: { code: 'WORKSPACE_SAVED_WORK_UNAVAILABLE' } });
    const g = fixture(); (assertProspectDraft as jest.Mock).mockRejectedValueOnce(new Error('authority unavailable'));
    await expect(g.run()).rejects.toBeInstanceOf(ServiceUnavailableException);
    const h = fixture(); h.prisma.wsDraft.findMany.mockResolvedValueOnce(h.state.rows).mockResolvedValueOnce(h.state.rows).mockRejectedValueOnce(new Error('read failed'));
    await expect(h.run()).rejects.toMatchObject({ response: { code: 'WORKSPACE_SAVED_WORK_UNAVAILABLE' } });
  });
  it('withholds unfinished observations when the time budget expires', async () => {
    const f = fixture(); const now = Date.now(); jest.spyOn(Date, 'now').mockReturnValue(now);
    (assertProspectDraft as jest.Mock).mockImplementationOnce(async () => { jest.spyOn(Date, 'now').mockReturnValue(now + 10000); });
    await expect(f.run()).rejects.toMatchObject({ response: { code: 'WORKSPACE_SAVED_WORK_INCOMPLETE' } });
    expect(f.prisma.wsDraft.findMany).toHaveBeenCalledTimes(1);
  });
  it('reports producer observation boundaries, not document modification time', async () => {
    const f = fixture(); const started = Date.parse('2026-10-31T01:02:03Z');
    const clock = jest.spyOn(Date, 'now').mockReturnValue(started);
    (assertProspectDraft as jest.Mock).mockImplementation(async () => { clock.mockReturnValue(started + 250); });
    expect(await f.run()).toMatchObject({ observationStartedAt: '2026-10-31T01:02:03.000Z', observedAt: '2026-10-31T01:02:03.250Z' });
  });
  it('withholds observation when the producer clock moves backward', async () => {
    const f = fixture(); const now = Date.now(); const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    (assertProspectDraft as jest.Mock).mockImplementationOnce(async () => { clock.mockReturnValue(now - 1); });
    await expect(f.run()).rejects.toMatchObject({ response: { code: 'WORKSPACE_SAVED_WORK_INCOMPLETE' } });
  });
  it.each([{ clientId: '' }, { clientId: null }, { clientId: 'Acme' }, { clientId: [client] }, { tenantId: tenant }, { limit: 1 }])('rejects invalid scope/filter %j', async query => {
    const f = fixture(); await expect(f.run(query)).rejects.toBeInstanceOf(BadRequestException);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
});
