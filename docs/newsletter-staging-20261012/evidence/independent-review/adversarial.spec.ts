import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  canonicalWorkspaceSnapshot,
  workspaceSavedOutreachRevisionWithinTx,
  workspaceCanRead,
} from '../../../../packages/shared/src/workspace-saved-revision';
import { OutreachCommandEngineService } from '../../../../apps/api/src/outreach-v3/services/outreach-command-engine.service';
import { createBlankCampaignSpecV1, hashCampaignSpecV1 } from '../../../../apps/api/src/outreach-v3/state/outreach-campaign-spec.v1';

// Audit the helper's TypeScript source, never a stale shared dist build.
jest.mock('@capiro/shared', () => ({
  ...jest.requireActual('@capiro/shared'),
  ...jest.requireActual('../../../../packages/shared/src/workspace-saved-revision.ts'),
}));

const id = (n: number) => `12345678-1234-4000-8000-${n.toString().padStart(12, '0')}`;
const ctx = { tenantId: id(1), userId: id(2), clerkUserId: 'user_independent', tenantSlug: 'test', role: 'standard_user' } as any;
const draftId = id(3), versionId = id(4), sessionId = id(5), requestId = id(6), clientId = id(7);
const hash = (snap: unknown) => createHash('sha256').update(canonicalWorkspaceSnapshot(snap)).digest('hex');

function harness() {
  const state = {
    tenantStatus: 'active', memberStatus: 'active', memberRole: 'standard_user', memberUserId: ctx.userId,
    memberSubject: ctx.clerkUserId, owner: ctx.clerkUserId, collaboratorStatus: 'active', collaboratorRole: 'viewer',
    draftTenant: ctx.tenantId, versionTenant: ctx.tenantId, versionDraft: draftId,
    sourceTypes: [] as string[], prospectId: null as string | null, versionExists: true,
    currentConfig: {} as any, draftClient: null as string | null,
    snapshot: { docTitle: 'Pinned title', config: {} as any, documents: [{ body: { blocks: [{ title: 'Update', content: '<p>Pinned text.</p>' }] } }], ask: null } as any,
    clientExists: true, clientStatus: 'active', wall: true, grant: true,
    session: { id: sessionId, tenantId: ctx.tenantId, createdByUserId: ctx.userId, status: 'active', currentStateVersion: 1 },
    spec: createBlankCampaignSpecV1(), events: [] as any[], writes: 0,
    enforceSourcePrivileges: false,
  };
  state.spec.sponsor = { kind: 'firm', label: null, clientRefs: [] };
  const sql: Array<{ text: string; params: unknown[] }> = [];
  const tx = {
    $queryRawUnsafe: jest.fn(async (text: string, ...params: unknown[]) => {
      sql.push({ text, params });
      if (text.includes("set_config('app.current_user'")) return [];
      if (text.includes('FROM tenants ')) return params[0] === ctx.tenantId && state.tenantStatus === 'active' ? [{ id: ctx.tenantId }] : [];
      if (text.includes('FROM tenant_memberships')) return params[0] === ctx.tenantId && params[1] === state.memberSubject && (params[2] == null || params[2] === state.memberUserId) && state.memberStatus === 'active' && ['standard_user', 'user_admin', 'capiro_admin'].includes(state.memberRole) ? [{ userId: state.memberUserId }] : [];
      if (text.includes('FROM ws_draft')) return params[0] === state.draftTenant && params[1] === draftId ? [{ ownerId: state.owner, prospectId: state.prospectId, config: state.currentConfig, client: state.draftClient }] : [];
      if (text.includes('FROM ws_source_action')) {
        if (state.enforceSourcePrivileges && /FOR\s+(?:SHARE|KEY\s+SHARE|UPDATE|NO\s+KEY\s+UPDATE)/i.test(text)) throw Object.assign(new Error('permission denied for table ws_source_action'), { code: '42501' });
        return state.sourceTypes.filter((type) => !text.includes('source_type IN') || text.includes(`'${type}'`)).map((sourceType) => ({ sourceType }));
      }
      if (text.includes('FROM ws_collaborator')) return params[2] === ctx.clerkUserId && state.collaboratorStatus === 'active' ? [{ role: state.collaboratorRole }] : [];
      if (text.includes('FROM ws_doc_version')) return state.versionExists && params[0] === state.versionTenant && params[1] === state.versionDraft && params[2] === versionId ? [{ id: versionId, authorId: 'user_original', authorKind: 'person', createdAt: new Date('2026-10-12T01:02:03Z'), snapshot: state.snapshot }] : [];
      if (text.includes('FROM clients c')) return state.clientExists ? [{ allowed: !state.wall || state.grant }] : [];
      if (text.includes('FROM clients')) return params[0] === ctx.tenantId && params[1] === clientId && state.clientExists && state.clientStatus !== 'archived' ? [{ id: clientId, memoryWall: state.wall }] : [];
      if (text.includes('FROM client_memory_access')) return state.grant ? [{ id: id(8) }] : [];
      throw new Error(`Unrecognized source SQL: ${text}`);
    }),
    $queryRaw: jest.fn(async (parts: TemplateStringsArray, ...params: unknown[]) => {
      const text = parts.join('?'); sql.push({ text, params });
      if (text.includes('FROM clients')) return state.clientExists && state.clientStatus !== 'archived' ? [{ id: clientId, memoryWall: state.wall }] : [];
      if (text.includes('FROM client_memory_access')) return state.grant ? [{ id: id(8) }] : [];
      throw new Error(`Unrecognized command SQL: ${text}`);
    }),
  };
  const repository = {
    lockOwnedSession: jest.fn(async (_tx, actor, selectedSession) => {
      if (actor.userId !== state.session.createdByUserId || actor.tenantId !== state.session.tenantId || selectedSession !== state.session.id) throw new Error('OWNED_SESSION_REQUIRED');
      return structuredClone(state.session);
    }),
    findBatchResult: jest.fn(async (_tx, _actor, _selectedSession, batchId) => state.events.find((e) => e.commandBatchId === batchId && e.eventType === 'command_batch_result') ?? null),
    loadStateVersion: jest.fn(async () => ({ specJsonb: structuredClone(state.spec), specHash: hashCampaignSpecV1(state.spec) })),
    insertStateVersion: jest.fn(async (_tx, _actor, selected) => { state.spec = selected.specJsonb; state.writes++; }),
    updateCurrentVersion: jest.fn(async (_tx, _actor, _selectedSession, previous, next) => {
      if (previous !== state.session.currentStateVersion) throw new Error('COMPARE_AND_SWAP');
      state.session.currentStateVersion = next;
    }),
    appendEvent: jest.fn(async (_tx, _actor, _session, event) => {
      const saved = { id: id(100 + state.events.length), eventType: event.eventType, commandBatchId: event.commandBatchId, payloadHash: event.payloadHash, safeMetadataJsonb: event.safeMetadata };
      state.events.push(saved); return saved;
    }),
    supersedeStaleProposals: jest.fn(async () => 0),
  };
  // Synthetic serialization only. Does not assert real database lock behavior.
  let queue = Promise.resolve();
  const prisma = { withTenantUser: jest.fn((_tenant, _user, work) => {
    const running = queue.then(async () => {
      const previous = structuredClone({ spec: state.spec, session: state.session, events: state.events, writes: state.writes });
      try { return await work(tx); } catch (e) { Object.assign(state, previous); throw e; }
    });
    queue = running.then(() => undefined, () => undefined); return running;
  }) };
  const authorization = { authorizeClientWithinTx: jest.fn(async () => { if (!state.grant && state.wall) throw new Error('WALL_DENIED'); }) };
  const engine = new OutreachCommandEngineService(prisma as any, repository as any, authorization as any, {} as any, {} as any);
  const input = () => ({ requestId, draftId, versionId, snapshotHash: hash(state.snapshot), expectedStateVersion: 1 });
  const stage = (overrides = {}, actor = ctx, selectedSession = sessionId) => engine.stageSavedNewsletter(actor, selectedSession, { ...input(), ...overrides });
  const read = (overrides = {}) => workspaceSavedOutreachRevisionWithinTx(tx, { tenantId: ctx.tenantId, clerkUserId: ctx.clerkUserId, draftId, versionId, ...overrides });
  const bindClient = () => { state.currentConfig = { clientId }; state.snapshot.config = { clientId }; state.spec.sponsor = { kind: 'client', label: null, clientRefs: [{ clientId }] }; };
  return { state, tx, sql, repository, authorization, engine, stage, read, input, bindClient };
}

describe('independent saved newsletter adversarial review', () => {
  it('respects existing SELECT/INSERT-only source receipt privileges', async () => {
    const migration = readFileSync(resolve(__dirname, '../../../../apps/workspace/prisma/migrations/20260913020000_legiwatch_preparation_actions/migration.sql'), 'utf8');
    expect(migration).toContain('REVOKE UPDATE,DELETE,TRUNCATE ON ws_source_action FROM capiro_app');
    const h = harness(); h.state.enforceSourcePrivileges = true;
    await expect(h.read()).resolves.toMatchObject({ versionId });
    expect(h.sql.find((q) => q.text.includes('FROM ws_source_action'))?.text).not.toMatch(/FOR\s+(?:SHARE|KEY\s+SHARE|UPDATE|NO\s+KEY\s+UPDATE)/i);
  });
  it.each(['legiwatch_research', 'legiwatch_editorial', 'legiwatch_preparation', 'unknown_source'])('denies %s receipt even after human edits', async (source) => {
    const h = harness(); h.state.sourceTypes = [source];
    await expect(h.stage()).rejects.toMatchObject({ code: 'OUTREACH_REFERENCE_UNAUTHORIZED' }); expect(h.state.writes).toBe(0);
  });
  it.each(['client', 'clientAssociated', 'clientPersons'])('never treats unbound legacy %s context as firm content', async (kind) => {
    const h = harness(); h.state.snapshot.config[kind] = kind === 'client' ? 'Walled client' : kind === 'clientAssociated' ? true : [{ id: id(20) }];
    h.state.currentConfig = structuredClone(h.state.snapshot.config);
    await expect(h.stage()).rejects.toMatchObject({ code: 'OUTREACH_REFERENCE_UNAUTHORIZED' }); expect(h.state.writes).toBe(0);
  });
  it('never treats current legacy draft.client as firm content when config client is absent', async () => {
    const h = harness(); h.state.draftClient = 'Walled client';
    await expect(h.stage()).rejects.toMatchObject({ code: 'OUTREACH_REFERENCE_UNAUTHORIZED' }); expect(h.state.writes).toBe(0);
  });
  it('checks source-owner client wall before returning a saved snapshot to the chooser', async () => {
    const h = harness(); h.bindClient(); h.state.grant = false;
    await expect(h.read()).rejects.toThrow();
  });
  it('checks source-owner client lifecycle before returning a saved snapshot', async () => {
    const h = harness(); h.bindClient(); h.state.clientStatus = 'archived';
    await expect(h.read()).rejects.toThrow();
  });
  it('supports exact same-client chooser and staging through current wall authority', async () => {
    const h = harness(); h.bindClient();
    const revision = await h.read(); expect(revision.clientId).toBe(clientId);
    const staged = await h.stage(); expect(staged.staged.clientId).toBe(clientId);
    expect(h.authorization.authorizeClientWithinTx).toHaveBeenCalledWith(h.tx, expect.objectContaining({ actorUserId: ctx.userId }), clientId);
    const userBindings = h.sql.filter((q) => q.text.includes("set_config('app.current_user'"));
    expect(userBindings).toHaveLength(2);
    expect(userBindings.every((q) => q.params[0] === ctx.userId)).toBe(true);
    expect(h.sql.filter((q) => q.text.includes('FROM clients WHERE') || q.text.includes('SELECT id FROM client_memory_access')).every((q) => q.text.includes('FOR SHARE'))).toBe(true);
    expect(h.sql.some((q) => q.text.includes('FROM clients c'))).toBe(true);
  });
  it('permits a current unwalled client without inventing a grant requirement', async () => {
    const h = harness(); h.bindClient(); h.state.wall = false; h.state.grant = false;
    await expect(h.stage()).resolves.toMatchObject({ status: 'applied' });
  });
  it('denies changed or missing canonical client assignment on the current draft', async () => {
    const h = harness(); h.bindClient(); h.state.currentConfig.clientId = id(95);
    await expect(h.stage()).rejects.toMatchObject({ code: 'OUTREACH_REFERENCE_UNAUTHORIZED' });
    h.state.currentConfig = {}; await expect(h.stage()).rejects.toMatchObject({ code: 'OUTREACH_REFERENCE_UNAUTHORIZED' });
  });
  it('rechecks current client wall and source collaboration before exact retry', async () => {
    const h = harness(); h.bindClient(); await h.stage(); h.state.grant = false;
    await expect(h.stage()).rejects.toMatchObject({ code: 'OUTREACH_REFERENCE_UNAUTHORIZED' });
    h.state.grant = true; h.state.owner = 'user_other'; h.state.collaboratorStatus = 'pending';
    await expect(h.stage()).rejects.toMatchObject({ code: 'OUTREACH_REFERENCE_UNAUTHORIZED' }); expect(h.state.writes).toBe(1);
  });
  it('never exposes a chooser revision under a spoofed optional actor UUID', async () => {
    const h = harness(); await expect(h.read({ userId: id(96) })).rejects.toThrow();
  });
  it.each(['empty_documents', 'oversized_documents', 'body_slots', 'subject_slots', 'body_over_limit'])('refuses %s without truncation, model generation or templating', async (kind) => {
    const h = harness();
    if (kind === 'empty_documents') h.state.snapshot.documents = [];
    else if (kind === 'oversized_documents') h.state.snapshot.documents = Array.from({ length: 101 }, () => ({ body: {} }));
    else if (kind === 'subject_slots') h.state.snapshot.docTitle = '{{slot}}';
    else h.state.snapshot.documents[0].body.blocks[0].content = kind === 'body_slots' ? '{{slot}}' : 'a'.repeat(8001);
    await expect(h.stage()).rejects.toMatchObject({ code: 'OUTREACH_REFERENCE_UNAUTHORIZED' }); expect(h.state.writes).toBe(0);
  });
  it.each(['suspended', 'removed'])('denies current %s membership before receipt replay', async (status) => {
    const h = harness(); await h.stage(); h.state.memberStatus = status;
    await expect(h.stage()).rejects.toMatchObject({ code: 'OUTREACH_REFERENCE_UNAUTHORIZED' }); expect(h.state.writes).toBe(1);
  });
  it('requires the actual UUID and Clerk subject to identify the same current member', async () => {
    const h = harness(); h.state.memberUserId = id(90);
    await expect(h.stage()).rejects.toMatchObject({ code: 'OUTREACH_REFERENCE_UNAUTHORIZED' });
  });
  it.each(['tenant_admin', 'client_user', 'guest'])('fails closed for unsupported current member role %s', async (role) => {
    const h = harness(); h.state.memberRole = role;
    await expect(h.stage()).rejects.toMatchObject({ code: 'OUTREACH_REFERENCE_UNAUTHORIZED' });
  });
  it('denies a foreign saved revision tenant and a saved revision from a different draft', async () => {
    const h = harness(); h.state.versionTenant = id(91);
    await expect(h.stage()).rejects.toMatchObject({ code: 'OUTREACH_REFERENCE_UNAUTHORIZED' });
    h.state.versionTenant = ctx.tenantId; h.state.versionDraft = id(92);
    await expect(h.stage()).rejects.toMatchObject({ code: 'OUTREACH_REFERENCE_UNAUTHORIZED' });
  });
  it('refuses replay after source deletion and never resurrects a receipt source', async () => {
    const h = harness(); await h.stage(); h.state.versionExists = false;
    await expect(h.stage()).rejects.toMatchObject({ code: 'OUTREACH_REFERENCE_UNAUTHORIZED' }); expect(h.state.writes).toBe(1);
  });
  it('refuses changed snapshot bytes even if plain text projection stays equal', async () => {
    const h = harness(); const selected = h.input(); await h.stage(); h.state.snapshot.ask = { changed: true };
    await expect(h.stage(selected)).rejects.toMatchObject({ code: 'OUTREACH_STATE_CONFLICT' }); expect(h.state.writes).toBe(1);
    await expect(h.stage()).rejects.toMatchObject({ code: 'OUTREACH_COMMAND_ID_REUSE' });
  });
  it('requires exact request identity as well as exact skeleton and snapshot', async () => {
    const h = harness(); await h.stage();
    await expect(h.stage({ expectedStateVersion: 2 })).rejects.toMatchObject({ code: 'OUTREACH_COMMAND_ID_REUSE' });
  });
  it('rejects a generic command receipt occupying the same durable ID', async () => {
    const h = harness(); h.state.events.push({ eventType: 'command_batch_result', commandBatchId: requestId, payloadHash: 'pretend', safeMetadataJsonb: {} });
    await expect(h.stage()).rejects.toMatchObject({ code: 'OUTREACH_COMMAND_ID_REUSE' }); expect(h.state.writes).toBe(0);
  });
  it('rejects forged or modified provenance rather than replaying it', async () => {
    const h = harness(); await h.stage(); h.state.events.find((e) => e.commandBatchId === requestId).safeMetadataJsonb.savedRevisionStaging.authorId = 'user_forged';
    await expect(h.stage()).rejects.toMatchObject({ code: 'OUTREACH_COMMAND_ID_REUSE' });
  });
  it('serializes one receipt for simultaneous identical synthetic retries', async () => {
    const h = harness(); const [a, b] = await Promise.all([h.stage(), h.stage()]);
    expect(a.receiptId).toBe(b.receiptId); expect(h.state.writes).toBe(1); expect(b.replayed).toBe(true);
  });
  it('refuses a simultaneous stale competitor in the synthetic session lock', async () => {
    const h = harness(); const calls = await Promise.allSettled([h.stage(), h.stage({ requestId: id(93) })]);
    expect(calls[0].status).toBe('fulfilled'); expect(calls[1].status).toBe('rejected'); expect(h.state.writes).toBe(1);
  });
  it('does not alter state or retain an event when final receipt readback fails', async () => {
    const h = harness(); h.repository.findBatchResult.mockResolvedValue(null);
    await expect(h.stage()).rejects.toMatchObject({ code: 'OUTREACH_STATE_CORRUPT' }); expect(h.state.writes).toBe(0); expect(h.state.events).toEqual([]);
  });
  it('restages identical text with a fresh identity as no_change plus a new exact receipt', async () => {
    const h = harness(); await h.stage(); const second = await h.stage({ requestId: id(94), expectedStateVersion: 2 });
    expect(second.status).toBe('no_change'); expect(second.receiptId).toBeTruthy(); expect(h.state.writes).toBe(1);
    expect(h.state.events.filter((e) => e.eventType === 'command_batch_result')).toHaveLength(2);
  });
  it('requires strict input and rejects caller-controlled source bytes, commands and recipient changes', async () => {
    const h = harness();
    for (const extra of [{ snapshot: {} }, { commands: [] }, { clientId }, { recipients: ['person@example.test'] }, { contentSkeleton: { body: 'injected' } }]) await expect(h.stage(extra)).rejects.toThrow();
    expect(h.state.writes).toBe(0);
  });
  it('leaves provider, upload and generation APIs outside the staging call graph', async () => {
    const h = harness(); await h.stage();
    expect(h.state.spec.contentSkeleton).toEqual({ subject: 'Pinned title', body: 'Update\nPinned text.', slots: [] });
    expect(h.state.spec.targeting.selectedTargetRefs).toEqual([]);
    expect(h.repository.appendEvent.mock.calls.every((call) => ['command_applied', 'command_batch_result'].includes(call[3].eventType))).toBe(true);
  });
  it('uses bounded actual role policy and parameter binds while locking mutable source authority', async () => {
    const h = harness(); await h.stage();
    expect(workspaceCanRead('viewer')).toBe(true); expect(workspaceCanRead('unknown')).toBe(false);
    for (const table of ['tenants ', 'tenant_memberships', 'ws_draft', 'ws_doc_version']) expect(h.sql.find((q) => q.text.includes(`FROM ${table}`))?.text).toContain('FOR SHARE');
    expect(h.sql.every((q) => !q.text.includes(ctx.clerkUserId))).toBe(true);
  });
});
