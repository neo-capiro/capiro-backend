import { createProspectDraft } from './prospect-draft-create.js';
import { requireProspectDraftInTx, withProspectInvitation, requireProspectInvitee } from './prospect-draft-access.js';
import { prospectNotificationVisible } from './prospect-notification-access.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { ShareLinkService } from '../delivery/share-link.service.js';
import { MemoryPromotionService } from '../generation/memory-promotion.service.js';
import { canEdit, canRead } from '../collaborators/role-policy.js';

const tenant = '11111111-1111-4111-8111-111111111111';
const prospect = '22222222-2222-4222-8222-222222222222';
const client = '33333333-3333-4333-8333-333333333333';
const draftId = '44444444-4444-4444-8444-444444444444';
const requestId = '55555555-5555-4555-8555-555555555555';
const coreUser = '66666666-6666-4666-8666-666666666666';
const owner = 'user_owner';
const invitee = 'user_invitee';

// Deliberately independent from author fixtures: enforce transaction GUC setup,
// exact tenant/subject selection and query predicates; no database/provider exists.
function fixture() {
  const state = { member: true, role: 'standard_user', flag: true, status: 'active',
    archived: false, wall: false, grant: false, exists: true, linked: false,
    collaborator: null as null | { subjectId: string; status: string; role: string },
    tenantGuc: '', actorGuc: '' };
  const draft = { id: draftId, tenantId: tenant, ownerId: owner, prospectId: prospect,
    docTitle: 'private-name', documents: [], config: {} };
  const receipts: any[] = [];
  const writes: string[] = [];
  const tx: any = {
    $executeRaw: jest.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      if (parts.join('?').includes('app.current_tenant')) state.tenantGuc = String(values[0]);
      return 1;
    }),
    $queryRawUnsafe: jest.fn(async (sql: string, ...args: any[]) => {
      if (sql.includes('set_config')) { state.actorGuc = args[0]; return []; }
      if (state.tenantGuc !== tenant || args[0] !== tenant) throw Error('unscoped Core read');
      if (sql.includes('FROM business_development_prospects'))
        return args[1] === prospect ? [{ status: state.status, dismissedAt: null, linkedClientId: state.linked ? client : null }] : [];
      if (sql.includes('FROM tenants')) return [{ settings: { clioFeatureFlags: { 'businessDevelopment.enabled': state.flag } } }];
      if (sql.includes('FROM tenant_memberships')) {
        const permitted = state.member && (args[2] === owner || args[2] === invitee)
          && ['standard_user', 'user_admin', 'capiro_admin'].includes(state.role);
        return permitted ? [{ userId: coreUser, clerkUserId: args[2] }] : [];
      }
      if (sql.includes('SELECT status,memory_wall')) return args[1] === client ? [{ status: state.archived ? 'archived' : 'active', memoryWall: state.wall }] : [];
      if (sql.includes('SELECT id FROM client_memory_access')) return state.grant ? [{ id: 'current-grant' }] : [];
      if (sql.includes('AS allowed')) return [{ allowed: !state.wall || state.grant }];
      throw Error(sql);
    }),
    $queryRaw: jest.fn(async (parts: TemplateStringsArray, ...args: any[]) => {
      const sql = parts.join('?');
      if (sql.includes('FROM ws_document') && sql.includes('source_brief_version')) return [];
      if (sql.includes('FROM ws_draft')) return state.exists && args.includes(draftId) && args.includes(tenant) ? [draft] : [];
      if (sql.includes('FROM ws_collaborator')) {
        const c = state.collaborator;
        if (!c || !args.includes(c.subjectId)) return [];
        if (sql.includes("status::text='active'") && c.status !== 'active') return [];
        if (sql.includes("IN ('pending','active')") && !['pending', 'active'].includes(c.status)) return [];
        return [{ id: 'invite', role: c.role }];
      }
      throw Error(sql);
    }),
    wsDraft: { findFirst: jest.fn(async ({ where }: any) => state.exists &&
      (!where.tenantId || where.tenantId === tenant) && (!where.id || where.id === draftId) &&
      (where.prospectId === undefined || where.prospectId === prospect) ? draft : null) },
    wsProspectDraftReceipt: {
      findFirst: jest.fn(async () => receipts[0] ?? null),
      create: jest.fn(async ({ data }: any) => { receipts.push(data); writes.push('receipt'); return data; }),
    },
    wsCollaborator: { findFirst: jest.fn(async ({ where }: any) => {
      const c = state.collaborator;
      if (!c || c.subjectId !== where.subjectId) return null;
      return where.OR.some((p: any) => p.status === c.status && (!p.id || p.id === 'invite')) ? c : null;
    }) },
    wsNotification: {
      findMany: jest.fn(async () => [{ id: 'notice', draftId, collaboratorId: 'invite', kind: 'collab_invite', draftTitle: 'private-name', read: false }]),
      findFirst: jest.fn(async () => ({ id: 'notice', draftId, collaboratorId: 'invite', kind: 'collab_invite', draftTitle: 'private-name' })),
      update: jest.fn(async () => { writes.push('notification'); return {}; }),
      updateMany: jest.fn(async ({ where }: any) => ({ count: where.id.in.length })),
    },
  };
  const prisma = { ...tx, $transaction: jest.fn(async (fn: any) => {
    state.tenantGuc = ''; state.actorGuc = ''; return fn(tx);
  }) };
  const create = jest.fn(async (db: any) => { expect(db).toBe(tx); writes.push('draft'); return draft; });
  const dto = { prospectId: prospect, requestId, docTitle: 'private-name' };
  const run = (patch = {}) => createProspectDraft(prisma as never, tenant, owner, { ...dto, ...patch }, create);
  const authorize = (actor = owner, policy = canRead, mode: 'read' | 'write' = 'read') =>
    prisma.$transaction((db: any) => requireProspectDraftInTx(db, draft, actor, policy, mode));
  return { state, draft, tx, prisma, receipts, writes, create, run, authorize };
}

describe('independent prospect Workspace lifecycle and alternate-path controls', () => {
  it.each(['dismissed', 'archived'])('recovers an exact creation receipt after %s when historical read remains authorized', async (transition) => {
    const h = fixture(); const created = await h.run();
    if (transition === 'dismissed') h.state.status = 'dismissed';
    else { h.state.linked = true; h.state.archived = true; }
    await expect(h.authorize()).resolves.toBeUndefined();
    await expect(h.run()).resolves.toEqual(created);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.receipts).toHaveLength(1);
  });
  it.each(['dismissed', 'archived'])('still rejects new creation after %s', async (transition) => {
    const h = fixture();
    if (transition === 'dismissed') h.state.status = 'dismissed';
    else { h.state.linked = true; h.state.archived = true; }
    await expect(h.run()).rejects.toMatchObject({ status: 404 });
    expect(h.writes).toEqual([]);
  });
  it('does not silently accept changed input when a receipt exists', async () => {
    const h = fixture(); await h.run();
    await expect(h.run({ docTitle: 'different-command' })).rejects.toMatchObject({ status: 409 });
    expect(h.create).toHaveBeenCalledTimes(1);
  });
  it('does not recreate a draft removed after an acknowledged or lost response', async () => {
    const h = fixture(); await h.run(); h.state.exists = false;
    await expect(h.run()).rejects.toMatchObject({ status: 409 });
    expect(h.create).toHaveBeenCalledTimes(1);
  });
  it.each(['membership', 'portal_role', 'wall', 'flag'])('denies receipt replay after current %s revocation', async (revocation) => {
    const h = fixture(); await h.run();
    if (revocation === 'membership') h.state.member = false;
    if (revocation === 'portal_role') h.state.role = 'client_portal_user';
    if (revocation === 'wall') { h.state.linked = true; h.state.wall = true; }
    if (revocation === 'flag') h.state.flag = false;
    await expect(h.run()).rejects.toMatchObject({ status: 404 });
    expect(h.create).toHaveBeenCalledTimes(1);
  });
  it('preserves draft ACL independently from the current Core scope', async () => {
    const h = fixture();
    await expect(h.authorize(invitee)).rejects.toMatchObject({ status: 404 });
    h.state.collaborator = { subjectId: invitee, status: 'pending', role: 'editor' };
    await expect(h.authorize(invitee)).rejects.toMatchObject({ status: 404 });
    h.state.collaborator.status = 'active'; h.state.collaborator.role = 'viewer';
    await expect(h.authorize(invitee)).resolves.toBeUndefined();
    await expect(h.authorize(invitee, canEdit, 'write')).rejects.toMatchObject({ status: 404 });
  });
  it('requires exact addressed pending invitation and current Core scope for acceptance', async () => {
    const h = fixture(); const mutation = jest.fn(async () => 'accepted');
    h.state.collaborator = { subjectId: invitee, status: 'pending', role: 'editor' };
    await expect(withProspectInvitation(h.prisma as never, h.draft, owner, 'invite', mutation)).rejects.toMatchObject({ status: 404 });
    h.state.member = false;
    await expect(withProspectInvitation(h.prisma as never, h.draft, invitee, 'invite', mutation)).rejects.toMatchObject({ status: 404 });
    expect(mutation).not.toHaveBeenCalled();
    h.state.member = true;
    await expect(withProspectInvitation(h.prisma as never, h.draft, invitee, 'invite', mutation)).resolves.toBe('accepted');
  });
  it('refuses identity-free external invitees', async () => {
    const h = fixture();
    await expect(requireProspectInvitee(h.tx, h.draft, null)).rejects.toMatchObject({ status: 404 });
  });
  it('keeps only an addressed pending invitation visible without granting document read', async () => {
    const h = fixture(); h.state.collaborator = { subjectId: invitee, status: 'pending', role: 'editor' };
    const notice = { draftId, collaboratorId: 'invite', kind: 'collab_invite' };
    expect(await prospectNotificationVisible(h.prisma as never, tenant, invitee, notice)).toBe(true);
    await expect(h.authorize(invitee)).rejects.toMatchObject({ status: 404 });
    expect(await prospectNotificationVisible(h.prisma as never, tenant, invitee, { ...notice, collaboratorId: 'other' })).toBe(false);
    h.state.exists = false;
    expect(await prospectNotificationVisible(h.prisma as never, tenant, invitee, notice)).toBe(false);
  });
  it('hides deleted-draft notice text and counts on all notification read variants', async () => {
    const h = fixture(); h.state.exists = false;
    const service = new NotificationsService(h.prisma as never);
    await expect(service.list(tenant, owner)).resolves.toEqual({ items: [], unread: 0 });
    await expect(service.markRead(tenant, owner, 'notice')).rejects.toMatchObject({ status: 404 });
    await expect(service.markAllRead(tenant, owner)).resolves.toEqual({ updated: 0 });
    expect(h.writes).toEqual([]);
  });
  it('rejects public-share idempotency replay before looking up or returning token metadata', async () => {
    const h = fixture(); const lookup = jest.fn(async () => ({ id: 'old-public-share' }));
    const service = new ShareLinkService({ ...h.prisma, wsShareLink: { findFirst: lookup } } as never, {} as never);
    await expect(service.createShareLink(tenant, draftId, owner, { idempotencyKey: 'repeat' })).rejects.toMatchObject({ status: 403 });
    expect(lookup).not.toHaveBeenCalled();
  });
  it('refuses firm-memory promotion before making any external call', async () => {
    const h = fixture(); const remote = { promote: jest.fn() };
    const service = new MemoryPromotionService(h.prisma as never, remote as never);
    await expect(service.promoteDraft(tenant, owner, draftId)).rejects.toMatchObject({ status: 404 });
    expect(remote.promote).not.toHaveBeenCalled();
  });
});
