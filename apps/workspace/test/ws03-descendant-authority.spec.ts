import type { INestApplication } from '@nestjs/common';
import { createDescendantApp, createDescendantHarness, DESCENDANT_ROUTES, WS03_IDS, type DescendantRoute } from './support/ws03-descendant-harness.js';

describe('WS-03 direct Workspace descendant authority (synthetic database)', () => {
  const h = createDescendantHarness();
  let app: INestApplication;
  let origin: string;
  beforeAll(async () => {
    app = await createDescendantApp(h);
    await app.listen(0, '127.0.0.1');
    origin = await app.getUrl();
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(() => h.reset());
  const call = async (route: DescendantRoute, path = route.path, body = route.body) => {
    const response = await fetch(`${origin}/workspace-api/${path}`, {
      method: route.method.toUpperCase(),
      headers: { 'x-user-id': 'user_owner', 'x-tenant-id': WS03_IDS.tenantId, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };

  it.each(DESCENDANT_ROUTES)('refuses unrelated member at $name before descendant reads or effects', async route => {
    h.reset({ actorId: 'user_unrelated' });
    const response = await call(route);
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE_DESCENDANT_CONTENT');
    expect(h.reads).toEqual([]);
    expect(h.effects).toEqual([]);
  });

  it.each(DESCENDANT_ROUTES)('allows the active ordinary owner at $name', async route => {
    const response = await call(route);
    expect(response.status).toBe(route.status);
  });

  const roles = ['owner', 'editor', 'reviewer', 'commenter', 'viewer'] as const;
  const matrix = roles.flatMap(role => DESCENDANT_ROUTES.map(route => ({ role, route })));
  it.each(matrix)('retains $role permissions for $route.name', async ({ role, route }) => {
    h.reset({ actorId: `user_${role}` });
    const allowed = route.policy === 'read'
      || (route.policy === 'comment' && role !== 'viewer')
      || (route.policy === 'review' && ['owner', 'editor', 'reviewer'].includes(role))
      || (route.policy === 'edit' && ['owner', 'editor'].includes(role));
    const response = await call(route);
    expect(response.status).toBe(allowed ? route.status : 403);
    if (!allowed) {
      expect(h.effects).toEqual([]);
      // A commenter is an admitted reader; deletion needs the target author
      // before deciding whether the existing self-delete exception applies.
      expect(h.reads).toEqual(route.name === 'comment delete' && role === 'commenter' ? ['comment.read'] : []);
    }
  });

  const revocations = [
    { name: 'membership removed', override: { member: false } },
    { name: 'tenant inactive', override: { tenantActive: false } },
    { name: 'client inactive or archived', override: { clientActive: false } },
    { name: 'client wall revoked', override: { wallAllowed: false } },
    { name: 'wrong tenant', override: { tenantId: WS03_IDS.foreignTenantId } },
    { name: 'missing actor', override: { actorId: '' } },
  ];
  it.each(revocations.flatMap(reason => DESCENDANT_ROUTES.map(route => ({ ...reason, route }))))('refuses $name at $route.name without data or effects', async ({ override, route }) => {
    h.reset(override);
    expect((await call(route)).status).toBe(404);
    expect(h.reads).toEqual([]);
    expect(h.effects).toEqual([]);
  });

  it.each(DESCENDANT_ROUTES)('refuses forged parent identity at $name', async route => {
    const forged = route.path.replace(WS03_IDS.draftId, WS03_IDS.foreignId).replace(WS03_IDS.documentId, WS03_IDS.foreignId);
    expect((await call(route, forged)).status).toBe(404);
    expect(h.reads).toEqual([]);
    expect(h.effects).toEqual([]);
  });

  it.each(DESCENDANT_ROUTES.filter(route => route.path.includes(WS03_IDS.commentId)))('binds forged comment IDs to the admitted document at $name', async route => {
    expect((await call(route, route.path.replace(WS03_IDS.commentId, WS03_IDS.foreignId))).status).toBe(404);
    expect(h.effects).toEqual([]);
  });

  it('binds reply parent IDs to the admitted document', async () => {
    const route = DESCENDANT_ROUTES.find(entry => entry.name === 'comment create')!;
    expect((await call(route, route.path, { body: 'Reply', parentId: WS03_IDS.foreignId })).status).toBe(404);
    expect(h.effects).toEqual([]);
  });

  it('allows a commenter to delete only their own comment', async () => {
    const remove = DESCENDANT_ROUTES.find(entry => entry.name === 'comment delete')!;
    h.reset({ actorId: 'user_commenter' });
    expect((await call(remove)).status).toBe(403);
    expect(h.effects).toEqual([]);
    h.setCommentAuthor('user_commenter');
    expect((await call(remove)).status).toBe(200);
    expect(h.effects).toEqual(['comment.delete']);
  });

  it.each(DESCENDANT_ROUTES)('gives the same opaque refusal for inaccessible, absent and wrong-tenant parents at $name', async route => {
    h.reset({ actorId: 'user_unrelated' });
    const inaccessible = await call(route);
    h.reset({ exists: false });
    const absent = await call(route);
    h.reset({ tenantId: WS03_IDS.foreignTenantId });
    const wrongTenant = await call(route);
    expect(inaccessible.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(wrongTenant.status).toBe(404);
    expect(absent.body).toEqual(inaccessible.body);
    expect(wrongTenant.body).toEqual(inaccessible.body);
  });

  it.each(DESCENDANT_ROUTES)('retains owner-only held legacy access at $name', async route => {
    h.reset({ held: true, actorId: 'user_editor' });
    expect((await call(route)).status).toBe(404);
    expect(h.reads).toEqual([]);
    expect(h.effects).toEqual([]);
    h.reset({ held: true });
    expect((await call(route)).status).toBe(route.status);
  });

  it.each(DESCENDANT_ROUTES)('rechecks collaborator revocation on the next $name call', async route => {
    h.reset({ actorId: 'user_editor' });
    expect((await call(route)).status).toBe(route.status);
    h.clearObservations();
    h.state.revokedCollaborator = true;
    expect((await call(route)).status).toBe(404);
    expect(h.reads).toEqual([]);
    expect(h.effects).toEqual([]);
  });

  it.each(DESCENDANT_ROUTES.filter(route => route.name !== 'comment suggestion'))('preserves prospect-owner access at $name', async route => {
    h.reset({ prospect: true });
    expect((await call(route)).status).toBe(route.status);
  });

  it.each(DESCENDANT_ROUTES.filter(route => ['checks', 'anonymization'].includes(route.name)))('refuses an invalid copied-brief receipt at $name before full content reads', async route => {
    h.reset({ prospect: true, invalidCopiedBrief: true });
    expect((await call(route)).status).toBe(404);
    expect(h.reads).toEqual([]);
    expect(h.effects).toEqual([]);
  });

  it.each(DESCENDANT_ROUTES)('refuses unrelated prospect actor at $name', async route => {
    h.reset({ prospect: true, actorId: 'user_unrelated' });
    expect((await call(route)).status).toBe(404);
    expect(h.reads).toEqual([]);
    expect(h.effects).toEqual([]);
  });

  it('preserves the prospect suggestion transfer refusal without provider work', async () => {
    h.reset({ prospect: true });
    const route = DESCENDANT_ROUTES.find(entry => entry.name === 'comment suggestion')!;
    expect((await call(route)).status).toBe(403);
    expect(h.reads).toEqual([]);
    expect(h.effects).toEqual([]);
  });

  it.each(DESCENDANT_ROUTES)('retains private source-author authority at $name', async route => {
    h.reset({ sourceRows: [{ source_key: 'private-source', owner_id: 'user_other', source_type: 'legiwatch_research' }] });
    expect((await call(route)).status).toBe(404);
    expect(h.reads).toEqual([]);
    expect(h.effects).toEqual([]);
  });
});
