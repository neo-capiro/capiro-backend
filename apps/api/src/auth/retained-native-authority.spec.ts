import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, Script } from 'node:vm';
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { authDeniedEvent, ROLE_RANK, TENANT_HEADER } from '@capiro/shared';
import ts from 'typescript';

const root = resolve(__dirname, '../../../..');
const source = (name: string) => readFileSync(resolve(root, 'apps/api/src', name), 'utf8');
class Refusal extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const decorator = () => () => undefined;
const nest = { Injectable: decorator, Logger: class { log() {} warn() {} error() {} },
  ForbiddenException: class extends Refusal { constructor(message: string) { super(403, message); } },
  UnauthorizedException: class extends Refusal { constructor(message: string) { super(401, message); } },
  ConflictException: class extends Refusal { constructor(message: string) { super(409, message); } },
  BadRequestException: class extends Refusal { constructor(message: string) { super(400, message); } },
};

function owners() {
  // All source owners share one isolated VM realm. No SDK, DB client or app starts.
  const vm = createContext({ Buffer, Date, Promise, console: { log() {} } });
  function load(text: string, ports: Record<string, unknown>) {
    const module = { exports: {} as any };
    const output = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS, experimentalDecorators: true, esModuleInterop: true }, reportDiagnostics: true });
    expect(output.diagnostics?.filter(row => row.category === ts.DiagnosticCategory.Error)).toEqual([]);
    const execute = new Script(`(function(require,module,exports){${output.outputText}\n})`).runInContext(vm);
    execute((id: string) => {
      if (Object.hasOwn(ports, id)) return ports[id];
      throw new Error(`Unexpected runtime import: ${id}`);
    }, module, module.exports);
    return module.exports;
  }
  const shared = { authDeniedEvent, ROLE_RANK, TENANT_HEADER };
  const authority = load(source('auth/application-authority.ts'), { '@nestjs/common': nest, 'node:crypto': { createHash }, 'node:util': { types } });
  const native = load(source('auth/retained-native-authority.ts'), { '@nestjs/common': nest, '@capiro/shared': shared, 'node:util': { types } });
  const middleware = load(source('tenant/tenant-context.middleware.ts'), {
    '@nestjs/common': nest, '@capiro/shared': shared, '../auth/application-authority.js': authority,
    '../auth/retained-native-authority.js': native,
    '../auth/clerk-role.util.js': { mapClerkRoleToCapiro() { throw new Error('No self-heal in this fixture'); } },
  }).TenantContextMiddleware;
  const json = <T>(value: T): T => new Script(`JSON.parse(${JSON.stringify(JSON.stringify(value))})`).runInContext(vm);
  return { native, middleware, json };
}

async function fixture(impersonating = false) {
  const o = owners();
  const tenantId = '00000000-0000-7000-8000-000000000001';
  const actorId = '00000000-0000-0000-0000-000000000002';
  const targetId = '00000000-0000-8000-8000-000000000003';
  const now = Date.now();
  const user = { id: actorId, clerkUserId: 'user_native' };
  const tenant = { id: tenantId, slug: 'tenant', status: 'active', clerkOrgId: 'org_native' };
  const membership = { id: '00000000-0000-4000-8000-000000000004', tenantId, userId: actorId,
    status: 'active', role: impersonating ? 'capiro_admin' : 'standard_user', tenant, updatedAt: new Date(1) };
  const impersonation = { id: '00000000-0000-4000-8000-000000000005', actorUserId: actorId,
    tenantId: targetId, startedAt: new Date(now - 1000), expiresAt: new Date(now + 17_000), endedAt: null as Date | null,
    tenant: { id: targetId, slug: 'other', status: 'active', clerkOrgId: 'org_other' } };
  const claims = { sub: user.clerkUserId, sid: 'sess_native', iss: 'https://verified.example.invalid',
    exp: Math.floor((now + 90_000) / 1000), org_id: tenant.clerkOrgId,
    capiro_tenant_id: tenantId, capiro_tenant_slug: tenant.slug, email: 'not-retained@example.invalid',
    org_role: 'not-retained', rawTokenMarker: 'not-retained', nestedClaim: { secret: 'not-retained' } };
  const session = { id: claims.sid, userId: claims.sub, status: 'active', createdAt: now - 1000,
    expireAt: now + 60_000, abandonAt: now + 70_000, actor: null, expiresAtMs: now + 60_000 };
  const events: string[] = [];
  let removed = false;
  const update = jest.fn(async () => user);
  const tx = {
    user: { findUnique: jest.fn(async () => user), findFirst: jest.fn(async () => { events.push('local-user'); return removed ? null : user; }), update },
    tenantMembership: { findMany: jest.fn(async () => [membership]), findFirst: jest.fn(async () => { events.push('local-membership'); return membership; }) },
    impersonationSession: { findFirst: jest.fn(async () => impersonation) },
  };
  const clerk = {
    verifySessionToken: jest.fn(async (_token: string) => claims),
    assertRetainedApplicationAuthorityIssuer: jest.fn((issuer: string) => {
      events.push('issuer');
      if (issuer !== claims.iss) throw new Refusal(401, 'Application authority unavailable');
    }),
    assertActiveApplicationAuthoritySession: jest.fn(async (_claims: unknown) => { events.push('online'); return session; }),
  };
  const owner = new o.middleware(clerk, { withSystem: async (fn: any) => fn(tx) }, { run: (_ctx: unknown, fn: () => void) => fn() });
  const headers: Record<string, string> = { authorization: 'Bearer synthetic-native-token', 'x-capiro-tenant': 'tenant',
    ...(impersonating ? { 'x-capiro-impersonate-tenant': 'other' } : {}) };
  const req: any = { headers, path: '/api/clio/application-authority/retained-florida-budget',
    originalUrl: '/api/clio/application-authority/retained-florida-budget', hostname: 'localhost',
    header: (name: string) => headers[name] };
  await owner.use(req, { setHeader() {} }, () => {});
  const capture = () => owner.captureRetainedNativeAuthority(req, req.tenantContext);
  const bounds = (cutoff: number) => o.json({ nowMs: Date.now(), deadlineMs: cutoff,
    expectedDigests: { rawRequestSha256: 'a'.repeat(64), normalizedArgsSha256: 'b'.repeat(64), normalizationContextSha256: 'c'.repeat(64) } });
  const verify = (captured: any, transform = (value: any) => value) => {
    const codec = { verifyCryptographically: jest.fn((_header: unknown, _bounds: unknown) => transform(captured)) };
    const receiver = o.native.createRetainedNativeAuthorityReceiver(codec);
    return { proof: receiver.verifyCryptographically('signed-data-fixture', bounds(captured.originalExpiresAtMs)), codec };
  };
  return { ...o, owner, req, user, tenant, membership, impersonation, claims, session, clerk, tx, update, events, capture, verify, bounds,
    removeUser() { removed = true; } };
}

describe('actual native capture and codec-gated current-owner recheck source', () => {
  it('requires the actual request and identical WeakMap context, then filters closed Core provenance', async () => {
    const f = await fixture();
    await expect(f.owner.captureRetainedNativeAuthority({ ...f.req }, f.req.tenantContext)).rejects.toMatchObject({ status: 403 });
    await expect(f.owner.captureRetainedNativeAuthority(f.req, { ...f.req.tenantContext })).rejects.toMatchObject({ status: 403 });
    const captured = await f.capture();
    expect(Object.keys(captured).sort()).toEqual(['currentAuthority', 'identityRevision', 'originalExpiresAtMs', 'principal']);
    const frame = JSON.parse(captured.currentAuthority);
    expect(Object.keys(frame.claims).sort()).toEqual(['capiro_tenant_id', 'capiro_tenant_slug', 'exp', 'iss', 'org_id', 'sid', 'sub']);
    expect(frame.context).toEqual(f.req.tenantContext);
    expect(frame.claims.iss).toBe(f.claims.iss);
    expect(frame.authorityExpiresAtMs).toBe(f.session.expiresAtMs);
    for (const absent of ['synthetic-native-token', 'not-retained', 'authorization', 'headers', 'recheckCurrent']) {
      expect(captured.currentAuthority).not.toContain(absent);
    }
    expect(f.clerk.assertActiveApplicationAuthoritySession).toHaveBeenCalledTimes(1);
    expect(f.update).toHaveBeenCalledTimes(1); // existing native pipeline only
  });

  it('rejects unmarked/copied projections and repeats fresh Clerk/local reads on every delegated invocation', async () => {
    const f = await fixture(); const captured = await f.capture();
    await expect(f.owner.requiresVerifiedRetainedNativeAuthority(captured)).rejects.toMatchObject({ status: 401 });
    const { proof, codec } = f.verify(captured);
    await expect(f.owner.requiresVerifiedRetainedNativeAuthority({ ...proof })).rejects.toMatchObject({ status: 401 });
    f.events.length = 0;
    const first = await f.owner.requiresVerifiedRetainedNativeAuthority(proof);
    const second = await f.owner.requiresVerifiedRetainedNativeAuthority(proof);
    expect(first.identity).toEqual(second.identity);
    expect(first.identity.expiresAtMs).toBe(captured.originalExpiresAtMs);
    expect(Object.isFrozen(first.context)).toBe(true);
    expect(f.clerk.assertActiveApplicationAuthoritySession).toHaveBeenCalledTimes(3);
    expect(f.tx.tenantMembership.findFirst).toHaveBeenCalledTimes(3);
    expect(f.clerk.verifySessionToken).toHaveBeenCalledTimes(1);
    expect(codec.verifyCryptographically).toHaveBeenCalledTimes(1);
    expect(f.update).toHaveBeenCalledTimes(1);
    expect(f.clerk.assertRetainedApplicationAuthorityIssuer).toHaveBeenCalledTimes(2);
    expect(f.clerk.assertRetainedApplicationAuthorityIssuer).toHaveBeenNthCalledWith(1, f.claims.iss);
    expect(f.clerk.assertRetainedApplicationAuthorityIssuer).toHaveBeenNthCalledWith(2, f.claims.iss);
    expect(f.events).toEqual(['issuer', 'online', 'local-user', 'local-membership', 'issuer', 'online', 'local-user', 'local-membership']);
    const lastClaims = f.clerk.assertActiveApplicationAuthoritySession.mock.calls[2]?.[0];
    expect(Object.keys(lastClaims ?? {}).sort()).toEqual(['capiro_tenant_id', 'capiro_tenant_slug', 'exp', 'iss', 'org_id', 'sid', 'sub']);
  });

  it('passes original signed issuer to the canonical pin and refuses its mismatch before online/local I/O', async () => {
    const f = await fixture(); const captured = await f.capture();
    const frame = JSON.parse(captured.currentAuthority);
    frame.claims.iss = 'https://wrong-instance.example.invalid';
    const { proof } = f.verify({ ...captured, currentAuthority: JSON.stringify(frame) });
    f.events.length = 0;
    await expect(f.owner.requiresVerifiedRetainedNativeAuthority(proof)).rejects.toMatchObject({ status: 401 });
    expect(f.clerk.assertRetainedApplicationAuthorityIssuer).toHaveBeenCalledWith(frame.claims.iss);
    expect(f.events).toEqual(['issuer']);
    expect(f.clerk.assertActiveApplicationAuthoritySession).toHaveBeenCalledTimes(1);
    expect(f.tx.user.findFirst).toHaveBeenCalledTimes(1);
    expect(f.tx.tenantMembership.findFirst).toHaveBeenCalledTimes(1);
    expect(f.update).toHaveBeenCalledTimes(1);
  });

  it('preserves canonical removed-user/session refusals and returns409 for changed successful identity evidence', async () => {
    const f = await fixture(); const { proof } = f.verify(await f.capture());
    f.membership.updatedAt = new Date(2);
    await expect(f.owner.requiresVerifiedRetainedNativeAuthority(proof)).rejects.toMatchObject({ status: 409 });
    f.removeUser();
    await expect(f.owner.requiresVerifiedRetainedNativeAuthority(proof)).rejects.toMatchObject({ status: 403 });
    f.clerk.assertActiveApplicationAuthoritySession.mockRejectedValueOnce(new Refusal(401, 'revoked'));
    await expect(f.owner.requiresVerifiedRetainedNativeAuthority(proof)).rejects.toMatchObject({ status: 401 });
  });

  it('preserves original membership/home tenant and impersonation identity with its minimum cutoff', async () => {
    const f = await fixture(true); const captured = await f.capture();
    const frame = JSON.parse(captured.currentAuthority);
    expect(frame.membershipTenantId).toBe(f.tenant.id);
    expect(frame.context.tenantId).toBe(f.impersonation.tenantId);
    expect(frame.impersonationId).toBe(f.impersonation.id);
    expect(captured.originalExpiresAtMs).toBe(f.impersonation.expiresAt.getTime());
    const { proof } = f.verify(captured);
    expect((await f.owner.requiresVerifiedRetainedNativeAuthority(proof)).context).toEqual(f.req.tenantContext);
    f.impersonation.endedAt = new Date();
    await expect(f.owner.requiresVerifiedRetainedNativeAuthority(proof)).rejects.toMatchObject({ status: 403 });
  });

  it('never extends a shortened signed cutoff and refuses its expiry after the online await', async () => {
    const f = await fixture(); const captured = await f.capture();
    const cutoff = Date.now() + 1000;
    const { proof } = f.verify({ ...captured, originalExpiresAtMs: cutoff });
    expect((await f.owner.requiresVerifiedRetainedNativeAuthority(proof)).identity.expiresAtMs).toBe(cutoff);
    const clock = jest.spyOn(Date, 'now');
    f.clerk.assertActiveApplicationAuthoritySession.mockImplementationOnce(async () => { clock.mockReturnValue(cutoff); return f.session; });
    try { await expect(f.owner.requiresVerifiedRetainedNativeAuthority(proof)).rejects.toMatchObject({ status: 401 }); }
    finally { clock.mockRestore(); }
  });

  it.each(['extra', 'duplicate', 'wrongPrincipal', 'oversized', 'extended'])('rejects signed but invalid closed provenance: %s', async kind => {
    const f = await fixture(); const captured = await f.capture();
    const frame = JSON.parse(captured.currentAuthority);
    let changed = { ...captured };
    if (kind === 'extra') changed.currentAuthority = JSON.stringify({ ...frame, token: 'not-allowed' });
    if (kind === 'duplicate') changed.currentAuthority = captured.currentAuthority.replace('{', '{"schemaVersion":1,');
    if (kind === 'wrongPrincipal') { frame.context.userId = f.tenant.id; changed.currentAuthority = JSON.stringify(frame); }
    if (kind === 'oversized') changed.currentAuthority = ' '.repeat(4097);
    if (kind === 'extended') changed.originalExpiresAtMs++;
    try {
      const { proof } = f.verify(changed);
      await expect(f.owner.requiresVerifiedRetainedNativeAuthority(proof)).rejects.toMatchObject({ status: 401 });
    } catch (error) { expect(error).toMatchObject({ status: 401 }); }
    expect(f.clerk.assertActiveApplicationAuthoritySession).toHaveBeenCalledTimes(1);
  });

  it('keeps probe and data bounds distinct while using the same verified native-only recheck', async () => {
    const f = await fixture(); const captured = await f.capture();
    const selector = f.json({ schemaVersion: 1, sessionKey: '', folderId: null, clientSelector: null });
    const probeBounds = f.json({ nowMs: Date.now(), deadlineMs: captured.originalExpiresAtMs, selector });
    const codec = { verifyCryptographically: jest.fn(() => captured) };
    const probe = f.native.createRetainedNativeAuthorityProbeReceiver(codec);
    expect(() => probe.verifyCryptographically('probe', f.bounds(captured.originalExpiresAtMs))).toThrow();
    const data = f.native.createRetainedNativeAuthorityReceiver(codec);
    expect(() => data.verifyCryptographically('data', probeBounds)).toThrow();
    const proof = probe.verifyCryptographically('signed-probe-fixture', probeBounds);
    expect((await f.owner.requiresVerifiedRetainedNativeAuthority(proof)).identity.identityRevision).toBe(captured.identityRevision);
    expect(codec.verifyCryptographically).toHaveBeenCalledTimes(1);
    expect(codec.verifyCryptographically).toHaveBeenCalledWith('signed-probe-fixture', probeBounds);
  });
});
