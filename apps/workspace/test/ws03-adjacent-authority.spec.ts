import type { INestApplication } from '@nestjs/common';
import { ADJACENT_ROUTES, createDescendantApp, createDescendantHarness, WS03_IDS, type DescendantRoute } from './support/ws03-descendant-harness.js';

/** The real controllers/services/authority execute; identity and Prisma are
 * synthetic. No claim is made about native SQL, RLS or total authority bytes. */
describe('WS-03 direct adjacent descendant authority (synthetic database)', () => {
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
  const deniedStatus = (route: DescendantRoute) => route.name.startsWith('version') ? 403 : 404;
  function expectNoDescendantAccess(response: { body: unknown }) {
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE_DESCENDANT_CONTENT');
    expect(h.reads).toEqual([]);
    expect(h.effects).toEqual([]);
  }

  it.each(ADJACENT_ROUTES)('refuses unrelated trusted actor before protected reads/effects at $name', async route => {
    h.reset({ actorId: 'user_unrelated' });
    const response = await call(route);
    expect(response.status).toBe(deniedStatus(route));
    expectNoDescendantAccess(response);
  });

  const roles = ['owner', 'editor', 'reviewer', 'commenter', 'viewer'] as const;
  it.each(roles.flatMap(role => ADJACENT_ROUTES.map(route => ({ role, route }))))('retains $role policy at $route.name', async ({ role, route }) => {
    h.reset({ actorId: `user_${role}` });
    const allowed = route.policy === 'read' || ['owner', 'editor'].includes(role);
    const response = await call(route);
    expect(response.status).toBe(allowed ? route.status : 403);
    if (!allowed) expectNoDescendantAccess(response);
    else if (route.name === 'quality fix') {
      expect(response.body).toEqual({ proposalId: '00000000-0000-4000-8000-00000000000d' });
      expect(h.effects).toEqual(['proposal.create']);
    } else if (route.name === 'version create') expect(h.effects).toEqual(['version.create']);
    else if (route.name === 'version restore') expect(h.effects).toEqual(['draft.update', 'document.update']);
    else {
      expect(JSON.stringify(response.body)).toContain('PRIVATE_DESCENDANT_CONTENT');
      expect(h.effects).toEqual([]);
    }
  });

  const revocations = [
    { name: 'membership removed', override: { member: false } },
    { name: 'tenant inactive', override: { tenantActive: false } },
    { name: 'client inactive or archived', override: { clientActive: false } },
    { name: 'client wall revoked', override: { wallAllowed: false } },
    { name: 'collaborator revoked', override: { actorId: 'user_editor', revokedCollaborator: true } },
    { name: 'private source held by another author', override: { sourceRows: [{ source_key: 'private-source', owner_id: 'user_other', source_type: 'legiwatch_research' }] } },
  ];
  it.each(revocations.flatMap(reason => ADJACENT_ROUTES.map(route => ({ ...reason, route }))))('refuses $name at $route.name without protected reads/effects', async ({ override, route }) => {
    h.reset(override);
    const response = await call(route);
    expect(response.status).toBe(deniedStatus(route));
    expectNoDescendantAccess(response);
  });

  it.each(ADJACENT_ROUTES)('refuses a forged parent before protected reads/effects at $name', async route => {
    const response = await call(route, route.path.replace(WS03_IDS.draftId, WS03_IDS.foreignId));
    expect(response.status).toBe(404);
    expectNoDescendantAccess(response);
  });

  it.each(ADJACENT_ROUTES)('refuses the wrong tenant before protected reads/effects at $name', async route => {
    h.reset({ tenantId: WS03_IDS.foreignTenantId });
    const response = await call(route);
    expect(response.status).toBe(404);
    expectNoDescendantAccess(response);
  });

  it.each(ADJACENT_ROUTES)('keeps held legacy access owner-only at $name', async route => {
    h.reset({ held: true, actorId: 'user_editor' });
    const response = await call(route);
    expect(response.status).toBe(deniedStatus(route));
    expectNoDescendantAccess(response);
    h.reset({ held: true });
    expect((await call(route)).status).toBe(route.status);
  });

  it.each(ADJACENT_ROUTES)('rechecks ordinary collaborator revocation on the next $name call', async route => {
    h.reset({ actorId: 'user_editor' });
    expect((await call(route)).status).toBe(route.status);
    h.clearObservations();
    h.state.revokedCollaborator = true;
    const response = await call(route);
    expect(response.status).toBe(deniedStatus(route));
    expectNoDescendantAccess(response);
  });

  it.each(ADJACENT_ROUTES.filter(route => route.name !== 'quality fix'))('preserves prospect-owner control at $name', async route => {
    h.reset({ prospect: true });
    expect((await call(route)).status).toBe(route.status);
  });

  it.each(ADJACENT_ROUTES.filter(route => route.name !== 'quality fix'))('rejects invalid copied-brief source before protected reads at $name', async route => {
    h.reset({ prospect: true, invalidCopiedBrief: true });
    const response = await call(route);
    expect(response.status).toBe(404);
    expectNoDescendantAccess(response);
  });

  it.each(ADJACENT_ROUTES)('rejects unrelated prospect actor before protected reads/effects at $name', async route => {
    h.reset({ prospect: true, actorId: 'user_unrelated' });
    const response = await call(route);
    expect(response.status).toBe(deniedStatus(route));
    expectNoDescendantAccess(response);
  });

  it('preserves prospect transfer refusal for an owner quality fix with no proposal', async () => {
    h.reset({ prospect: true });
    const response = await call(ADJACENT_ROUTES.find(route => route.name === 'quality fix')!);
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ code: 'PROSPECT_RESOURCE_TRANSFER_UNSUPPORTED' });
    expectNoDescendantAccess(response);
  });

  it('makes document list refusal opaque for unrelated, absent and wrong-tenant parents', async () => {
    const route = ADJACENT_ROUTES.find(entry => entry.name === 'document list')!;
    h.reset({ actorId: 'user_unrelated' });
    const unrelated = await call(route);
    h.reset({ exists: false });
    const absent = await call(route);
    h.reset({ tenantId: WS03_IDS.foreignTenantId });
    const foreign = await call(route);
    expect(unrelated.status).toBe(404);
    expect(absent).toEqual(unrelated);
    expect(foreign).toEqual(unrelated);
  });

  it('binds a restore version ID to its admitted parent without writes on a forgery', async () => {
    const route = ADJACENT_ROUTES.find(entry => entry.name === 'version restore')!;
    const response = await call(route, route.path.replace(WS03_IDS.versionId, WS03_IDS.foreignId));
    expect(response.status).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain('PRIVATE_DESCENDANT_CONTENT');
    expect(h.effects).toEqual([]);
  });

  it('does not permit a quality request to supply its creator identity', async () => {
    const route = ADJACENT_ROUTES.find(entry => entry.name === 'quality fix')!;
    h.reset({ actorId: 'user_unrelated' });
    const response = await call(route, route.path, { ...route.body, createdById: 'user_owner' });
    expect(response.status).toBe(400);
    expectNoDescendantAccess(response);
  });
});
