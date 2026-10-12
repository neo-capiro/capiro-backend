import { createHash } from 'node:crypto';
import { canonicalWorkspaceSnapshot, workspaceSavedOutreachRevisionWithinTx, workspaceCanRead } from '@capiro/shared';
import type { TenantContext } from '@capiro/shared';
import { OutreachCommandEngineService } from './outreach-command-engine.service.js';
import { createBlankCampaignSpecV1, hashCampaignSpecV1 } from '../state/outreach-campaign-spec.v1.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ctx = { tenantId: id(1), userId: id(2), clerkUserId: 'user_test', tenantSlug: 'test', role: 'standard_user' } as TenantContext;
const draftId = id(3), versionId = id(4), sessionId = id(5), requestId = id(6), clientId = id(7);
const snapshot = { docTitle: 'Saved newsletter', config: { sections: ['Update'], sectionContent: { Update: '<p>Exact saved text.</p>' } }, documents: [{ id: id(8), body: { blocks: [] } }], ask: null };
const hash = (value: unknown) => createHash('sha256').update(canonicalWorkspaceSnapshot(value)).digest('hex');

function harness(client = false) {
  const state = {
    tenant: true, member: true, ownerId: ctx.clerkUserId, role: 'viewer' as string | null,
    source: false, prospectId: null as string | null, versionExists: true, draftExists: true,
    memoryWall: true, grant: true, clientExists: true, authorized: true,
    clientDisplay: null as string | null, currentConfig: client ? { clientId } : {}, snapshot: structuredClone(snapshot) as any,
    session: { id: sessionId, tenantId: ctx.tenantId, createdByUserId: ctx.userId, status: 'active', currentStateVersion: 1 },
    spec: createBlankCampaignSpecV1(), events: [] as any[], writes: 0,
  };
  if (client) state.snapshot.config.clientId = clientId;
  state.spec.sponsor = client ? { kind: 'client', label: null, clientRefs: [{ clientId }] } : { kind: 'firm', label: null, clientRefs: [] };
  const sql: Array<{ text: string; params: unknown[] }> = [];
  const tx = {
    $queryRawUnsafe: jest.fn(async (text: string, ...params: unknown[]) => {
      sql.push({ text, params });
      if (text.includes('set_config')) return [];
      if (text.includes('SELECT (NOT c.memory_wall')) return [{ allowed: state.authorized }];
      if (text.includes('FROM clients ')) return state.clientExists ? [{ memoryWall: state.memoryWall }] : [];
      if (text.includes('FROM client_memory_access')) return state.grant ? [{ id: 'grant' }] : [];
      if (text.includes('FROM tenants ')) return state.tenant && params[0] === ctx.tenantId ? [{ id: ctx.tenantId }] : [];
      if (text.includes('FROM tenant_memberships')) return state.member && params[0] === ctx.tenantId && params[1] === ctx.clerkUserId && (params[2] == null || params[2] === ctx.userId) ? [{ userId: ctx.userId }] : [];
      if (text.includes('FROM ws_draft')) return state.draftExists && params[1] === draftId ? [{ ownerId: state.ownerId, prospectId: state.prospectId, config: state.currentConfig, client: state.clientDisplay }] : [];
      if (text.includes('FROM ws_source_action')) return state.source ? [{ sourceType: 'legiwatch_editorial' }] : [];
      if (text.includes('FROM ws_collaborator')) return state.role ? [{ role: state.role }] : [];
      if (text.includes('FROM ws_doc_version')) return state.versionExists && params[1] === draftId && params[2] === versionId ? [{ id: versionId, snapshot: state.snapshot, authorId: 'user_original', authorKind: 'person', createdAt: new Date('2026-10-12T00:00:00Z') }] : [];
      throw new Error(`Unmocked SQL ${text}`);
    }),
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const text = strings.join('?'); sql.push({ text, params: [] });
      if (text.includes('FROM clients')) return state.clientExists ? [{ memoryWall: state.memoryWall }] : [];
      if (text.includes('FROM client_memory_access')) return state.grant ? [{ id: 'grant' }] : [];
      throw new Error(`Unmocked SQL ${text}`);
    }),
  };
  let queue = Promise.resolve();
  const prisma = { withTenantUser: jest.fn((_t, _u, fn) => {
    const call = queue.then(async () => {
      const before = structuredClone({ session: state.session, spec: state.spec, events: state.events, writes: state.writes });
      try { return await fn(tx); } catch (error) { Object.assign(state, before); throw error; }
    }); queue = call.then(() => undefined, () => undefined); return call;
  }) };
  const repository = {
    lockOwnedSession: jest.fn(async (_tx, actor, selectedSessionId) => {
      if (actor.userId !== state.session.createdByUserId || actor.tenantId !== state.session.tenantId || selectedSessionId !== state.session.id) throw new Error('SESSION_NOT_FOUND');
      return structuredClone(state.session);
    }),
    findBatchResult: jest.fn(async (_tx, _ctx, _session, batch) => state.events.find((e) => e.commandBatchId === batch && e.eventType === 'command_batch_result') ?? null),
    loadStateVersion: jest.fn(async () => ({ specJsonb: structuredClone(state.spec), specHash: hashCampaignSpecV1(state.spec) })),
    insertStateVersion: jest.fn(async (_tx, _ctx, input) => { state.spec = input.specJsonb; state.writes++; }),
    updateCurrentVersion: jest.fn(async (_tx, _ctx, _id, before, after) => { if (state.session.currentStateVersion !== before) throw new Error('CAS'); state.session.currentStateVersion = after; }),
    appendEvent: jest.fn(async (_tx, _ctx, _session, input) => {
      const event = { id: id(100 + state.events.length), eventType: input.eventType, commandBatchId: input.commandBatchId ?? null, payloadHash: input.payloadHash, safeMetadataJsonb: input.safeMetadata };
      state.events.push(event); return event;
    }),
    supersedeStaleProposals: jest.fn(async () => 0),
  };
  const authorization = { authorizeClientWithinTx: jest.fn(async () => { if (!state.authorized) throw new Error('AUTH_DENIED'); return { id: clientId }; }) };
  const service = new OutreachCommandEngineService(prisma as any, repository as any, authorization as any, {} as any, {} as any);
  const input = () => ({ requestId, draftId, versionId, snapshotHash: hash(state.snapshot), expectedStateVersion: 1 });
  const stage = (override = {}, actor = ctx, selectedSession = sessionId) => service.stageSavedNewsletter(actor, selectedSession, { ...input(), ...override });
  return { state, tx, sql, service, stage, input, repository, authorization, prisma };
}

describe('saved newsletter staging through canonical Workspace and Outreach owners', () => {
  it('pins saved snapshot and author provenance in the one durable command receipt', async () => {
    const h = harness(); const result = await h.stage();
    expect(h.state.spec.contentSkeleton).toEqual({ subject: 'Saved newsletter', body: 'Update\nExact saved text.', slots: [] });
    expect(result.staged).toMatchObject({ draftId, versionId, snapshotHash: hash(snapshot), authorId: 'user_original', authorKind: 'person', expectedStateVersion: 1 });
    expect(result.stateVersion).toBe(2); expect(result.receiptId).toBeTruthy();
    expect(h.state.events.filter((e) => e.commandBatchId === requestId)).toHaveLength(1);
    expect(h.state.events.find((e) => e.commandBatchId === requestId).safeMetadataJsonb.savedRevisionStaging).toEqual(result.staged);
    expect(h.sql.every((entry) => !entry.text.includes('INSERT') && !entry.text.includes('UPDATE'))).toBe(true);
  });
  it('keeps selected saved bytes after the live working content changes', async () => {
    const h = harness(); h.state.currentConfig = { sectionContent: { Update: 'Live unsaved text' } } as any;
    await h.stage(); expect(h.state.spec.contentSkeleton?.body).toContain('Exact saved text.');
  });
  it('returns the same receipt without another state mutation on exact retry', async () => {
    const h = harness(); const first = await h.stage(); const retry = await h.stage();
    expect(retry.receiptId).toBe(first.receiptId); expect(retry.replayed).toBe(true); expect(h.state.writes).toBe(1);
  });
  it('serializes duplicate retries into one state mutation in the synthetic session-lock harness', async () => {
    const h = harness(); const [a, b] = await Promise.all([h.stage(), h.stage()]);
    expect(a.receiptId).toBe(b.receiptId); expect(h.state.writes).toBe(1);
  });
  it('serializes competing requests and rejects the stale version', async () => {
    const h = harness(); const results = await Promise.allSettled([h.stage(), h.stage({ requestId: id(9) })]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']); expect(h.state.writes).toBe(1);
  });
  it('rejects changed expected version on the same request identity', async () => {
    const h = harness(); await h.stage(); await expect(h.stage({ expectedStateVersion: 2 })).rejects.toMatchObject({ code: 'OUTREACH_COMMAND_ID_REUSE' });
  });
  it('cannot upgrade a preexisting generic command result into a saved-revision receipt', async () => {
    const h = harness(); h.state.events.push({ eventType: 'command_batch_result', commandBatchId: requestId, safeMetadataJsonb: {} });
    await expect(h.stage()).rejects.toMatchObject({ code: 'OUTREACH_COMMAND_ID_REUSE' }); expect(h.state.writes).toBe(0);
  });
  it('rejects a wrong snapshot hash before writing', async () => {
    const h = harness(); await expect(h.stage({ snapshotHash: '0'.repeat(64) })).rejects.toMatchObject({ code: 'OUTREACH_STATE_CONFLICT' }); expect(h.state.writes).toBe(0);
  });
  it.each(['tenant', 'member', 'draftExists', 'versionExists'])('fails closed when current %s is absent', async (key) => {
    const h = harness(); (h.state as any)[key] = false;
    await expect(h.stage()).rejects.toMatchObject({ code: 'OUTREACH_REFERENCE_UNAUTHORIZED' }); expect(h.state.writes).toBe(0);
  });
  it.each(['prospect', 'Intel'])('retains the %s-origin transfer restriction', async (kind) => {
    const h = harness(); if (kind === 'prospect') h.state.prospectId = id(10); else h.state.source = true;
    await expect(h.stage()).rejects.toMatchObject({ code: 'OUTREACH_REFERENCE_UNAUTHORIZED' }); expect(h.state.writes).toBe(0);
  });
  it.each([null, 'unknown', 'pending'])('refuses absent/unsupported draft role %s', async (role) => {
    const h = harness(); h.state.ownerId = 'user_other'; h.state.role = role;
    await expect(h.stage()).rejects.toMatchObject({ code: 'OUTREACH_REFERENCE_UNAUTHORIZED' });
  });
  it('supports current viewer read/export rights and rechecks revocation before replay', async () => {
    const h = harness(); h.state.ownerId = 'user_other'; await h.stage(); h.state.role = null;
    await expect(h.stage()).rejects.toMatchObject({ code: 'OUTREACH_REFERENCE_UNAUTHORIZED' }); expect(h.state.writes).toBe(1);
  });
  it('requires the exact current actor, tenant and selected existing session', async () => {
    const h = harness();
    for (const [actor, selected] of [[{ ...ctx, userId: id(99) }, sessionId], [{ ...ctx, tenantId: id(99) }, sessionId], [ctx, id(99)]] as const) {
      await expect(h.stage({}, actor, selected)).rejects.toThrow('SESSION_NOT_FOUND');
    }
    expect(h.state.writes).toBe(0);
  });
  it('rejects an actor UUID with another Clerk subject', async () => {
    const h = harness(); await expect(h.stage({}, { ...ctx, clerkUserId: 'user_other' })).rejects.toMatchObject({ code: 'OUTREACH_REFERENCE_UNAUTHORIZED' });
  });
  it('locks same-client wall and its live grant, then delegates canonical client authorization', async () => {
    const h = harness(true); await h.stage();
    expect(h.authorization.authorizeClientWithinTx).toHaveBeenCalledWith(h.tx, expect.anything(), clientId);
    expect(h.sql.filter((q) => q.text.includes('FROM clients') || q.text.includes('FROM client_memory_access')).every((q) => q.text.includes('FOR SHARE'))).toBe(true);
  });
  it.each(['grant', 'clientExists', 'authorized'])('refuses current client %s failure before state change', async (key) => {
    const h = harness(true); (h.state as any)[key] = false; await expect(h.stage()).rejects.toThrow(); expect(h.state.writes).toBe(0);
  });
  it('refuses cross-client sponsor and refuses a changed live client assignment', async () => {
    const h = harness(true); h.state.spec.sponsor.clientRefs = [{ clientId: id(99) }];
    await expect(h.stage()).rejects.toMatchObject({ code: 'OUTREACH_REFERENCE_UNAUTHORIZED' });
    h.state.spec.sponsor.clientRefs = [{ clientId }]; h.state.currentConfig = { clientId: id(99) };
    await expect(h.stage()).rejects.toMatchObject({ code: 'OUTREACH_REFERENCE_UNAUTHORIZED' });
  });
  it('refuses firm content into a client sponsor', async () => {
    const h = harness(); h.state.spec.sponsor = { kind: 'client', label: null, clientRefs: [{ clientId }] };
    await expect(h.stage()).rejects.toMatchObject({ code: 'OUTREACH_REFERENCE_UNAUTHORIZED' });
  });
  it('blocks new archived mutations while permitting authorized receipt recovery', async () => {
    const h = harness(); await h.stage(); h.state.session.status = 'archived';
    expect((await h.stage()).replayed).toBe(true);
    await expect(h.stage({ requestId: id(9), expectedStateVersion: 2 })).rejects.toMatchObject({ code: 'OUTREACH_SESSION_ARCHIVED' });
  });
  it.each(['empty', 'oversized', 'slots'])('refuses %s saved content rather than truncating or inventing slots', async (kind) => {
    const h = harness(); h.state.snapshot.config.sectionContent.Update = kind === 'empty' ? '' : kind === 'oversized' ? 'a'.repeat(8001) : '{{generated_slot}}';
    await expect(h.stage()).rejects.toMatchObject({ code: 'OUTREACH_REFERENCE_UNAUTHORIZED' }); expect(h.state.writes).toBe(0);
  });
  it('rolls command state and receipt back together when receipt persistence fails', async () => {
    const h = harness(); h.repository.appendEvent.mockImplementation(async () => { throw new Error('WRITE_FAILED'); });
    await expect(h.stage()).rejects.toThrow('WRITE_FAILED'); expect(h.state.writes).toBe(0); expect(h.state.session.currentStateVersion).toBe(1); expect(h.state.events).toHaveLength(0);
  });
  it('normalizes UUID case and rejects arbitrary injected fields and commands', async () => {
    const h = harness(); await h.stage({ draftId: draftId.toUpperCase(), versionId: versionId.toUpperCase(), requestId: requestId.toUpperCase() });
    await expect(h.stage({ commands: [] })).rejects.toThrow(); await expect(h.stage({ snapshot: {} })).rejects.toThrow();
  });
  it('uses parameter-bound UUIDs and locks each current authority through command commit', async () => {
    const h = harness(); await h.stage();
    expect(h.sql.filter((q) => (q.text.includes('FROM ws_') && !q.text.includes('FROM ws_source_action')) || q.text.includes('FROM tenant_memberships') || q.text.includes('FROM tenants')).every((q) => q.text.includes('FOR SHARE'))).toBe(true);
    expect(h.sql.every((q) => !q.text.includes(ctx.clerkUserId))).toBe(true);
  });
  it('canonicalizes snapshot object keys while retaining ordered arrays', () => {
    expect(hash({ b: 2, a: 1 })).toBe(hash({ a: 1, b: 2 })); expect(hash([1, 2])).not.toBe(hash([2, 1]));
    expect(workspaceCanRead(null)).toBe(false); expect(workspaceCanRead('alien')).toBe(false);
  });
  it.each(['draft display', 'saved display', 'current display', 'saved people', 'current association'])('refuses unresolved legacy %s client hints into firm', async (kind) => {
    const h = harness();
    if (kind === 'draft display') h.state.clientDisplay = 'Walled client';
    if (kind === 'saved display') h.state.snapshot.config.client = 'Walled client';
    if (kind === 'current display') h.state.currentConfig = { client: 'Walled client' } as any;
    if (kind === 'saved people') h.state.snapshot.config.clientPersons = ['private contact'];
    if (kind === 'current association') h.state.currentConfig = { clientAssociated: true } as any;
    await expect(h.stage()).rejects.toMatchObject({ code: 'OUTREACH_REFERENCE_UNAUTHORIZED' });
    expect(h.state.writes).toBe(0);
  });
  it('refuses the saved-revision chooser itself when canonical client authority is revoked', async () => {
    const h = harness(true); h.state.grant = false;
    await expect(workspaceSavedOutreachRevisionWithinTx(h.tx, { ...ctx, draftId, versionId })).rejects.toThrow();
  });
  it('requires exact version/draft/tenant binding in the Workspace owner seam', async () => {
    const h = harness(); await expect(workspaceSavedOutreachRevisionWithinTx(h.tx, { ...ctx, draftId, versionId: id(99) })).rejects.toThrow();
  });
});
