import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RolesGuard } from '../auth/roles.guard.js';
import { ToolServiceSecretGuard } from './tool-service-secret.guard.js';
import { BillingController } from '../billing/billing.controller.js';
import { BillingAdminGuard } from '../billing/billing-admin.guard.js';
import { BillingService } from '../billing/billing.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantContextMiddleware } from '../tenant/tenant-context.middleware.js';
import { SavedRecordReadController } from './saved-record-read.controller.js';
import { SavedRecordReadService } from './saved-record-read.service.js';
import {
  readSavedRecordJson,
  receiveCoreSavedRecord,
  receiveWorkspaceSavedRecord,
  SAVED_RECORD_MAX_BYTES,
} from './saved-record-read.receiver.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const versionId = '33333333-3333-4333-8333-333333333333';
const secret = 'synthetic-read-service';
jest.mock('@clerk/backend', () => ({
  __esModule: true,
  createClerkClient: () => ({}),
  verifyToken: async () => ({}),
}));

const ctx = {
  tenantId,
  tenantSlug: 'current-org',
  userId: actorId,
  clerkUserId: 'user_current',
  role: 'user_admin',
};
const summary = {
  billingEnabled: true,
  status: 'active',
  slots: 3,
  usedSlots: 2,
  pricePerSlotUsd: 10,
  llmAllowanceUsd: 20,
  llmUsedUsd: 1.25,
  llmOverageUsd: 0,
  llmWarn: false,
  llmHardCapUsd: null,
  currentPeriodEnd: null,
  hasSubscription: true,
};
const envelope = (kind: string, data: unknown) => ({
  version: '0.1.0',
  kind,
  data,
  coverage: { basis: 'current_owner_read', limitations: ['Fixture current owner observation.'] },
  maxOutputBytes: SAVED_RECORD_MAX_BYTES,
});
const version = envelope('saved_version', {
  draftId: actorId,
  versionId,
  label: null,
  authorId: 'user_author',
  authorKind: 'person',
  savedAt: '2026-10-27T00:00:00.000Z',
  snapshot: { text: '完整 saved' },
});

async function fixture() {
  const state = {
    member: true,
    billingAdmin: true,
    role: 'user_admin',
    preview: false,
    currentSlug: ctx.tenantSlug,
  };
  const middleware = new TenantContextMiddleware(
    {
      verifySessionToken: async () => ({
        sub: ctx.clerkUserId,
        org_id: 'org_current',
        capiro_tenant_id: tenantId,
        sid: 'session_current',
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
      assertActiveApplicationAuthoritySession: async () => ({}),
    } as any,
    {
      withSystem: async (run: (tx: unknown) => unknown) =>
        run({
          user: {
            findUnique: async () => ({ id: actorId, clerkUserId: ctx.clerkUserId }),
            update: async () => ({}),
          },
          tenant: {
            findUnique: async () => ({
              id: tenantId,
              clerkOrgId: 'org_current',
              slug: state.currentSlug,
              status: 'active',
            }),
          },
          tenantMembership: {
            findMany: async () =>
              state.member
                ? [
                    {
                      id: 'membership_current',
                      tenantId,
                      role: state.role,
                      status: 'active',
                      tenant: {
                        id: tenantId,
                        clerkOrgId: 'org_current',
                        slug: state.currentSlug,
                        status: 'active',
                      },
                    },
                  ]
                : [],
            findUnique: async () => ({ status: state.member ? 'active' : 'suspended' }),
          },
          auditLog: { create: async () => ({}) },
        }),
    } as any,
    { run: (_ctx: unknown, next: () => void) => next() } as any,
  );
  const getSummary = jest.fn(async () => summary);
  const config = {
    get: (name: string) =>
      name === 'PREVIEW_NATIVE_GETS_ENABLED'
        ? state.preview
        : (
            {
              API_PORT: 4000,
              WORKSPACE_API_BASE_URL: 'http://workspace.synthetic',
              NODE_ENV: 'production',
              MERI_TOOLS_REQUIRE_SERVICE_SECRET: true,
              INTERNAL_SERVICE_SECRET: secret,
            } as Record<string, unknown>
          )[name],
  };
  const module = await Test.createTestingModule({
    controllers: [SavedRecordReadController, BillingController],
    providers: [
      SavedRecordReadService,
      RolesGuard,
      ToolServiceSecretGuard,
      BillingAdminGuard,
      { provide: ConfigService, useValue: config },
      { provide: BillingService, useValue: { getSummary } },
      {
        provide: PrismaService,
        useValue: {
          withTenant: async (_tenant: string, run: (tx: unknown) => unknown) =>
            run({
              tenantMembership: {
                findUnique: async () => ({
                  status: state.member ? 'active' : 'suspended',
                  billingAdmin: state.billingAdmin,
                }),
              },
            }),
        },
      },
    ],
  }).compile();
  const app = module.createNestApplication({ logger: ['error'] });
  app.setGlobalPrefix('api');
  await app.init();
  const router = app.getHttpAdapter().getInstance()._router;
  // Same socket-free Nest route seam as the existing private SQL HTTP gate.
  // Only the outer already-admitted tool context is injected. Forwarded Core
  // GETs execute the real tenant resolver before their canonical route guards.
  async function dispatch(
    path: string,
    method: string,
    body: unknown,
    headers: Record<string, string>,
  ) {
    const response: any = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headers: {} as Record<string, string>,
      body: undefined as unknown,
      writableEnded: false,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      setHeader(key: string, value: string) {
        this.headers[key.toLowerCase()] = value;
        return this;
      },
      set(key: string, value: string) {
        return this.setHeader(key, value);
      },
      getHeader(key: string) {
        return this.headers[key.toLowerCase()];
      },
      json(value: unknown) {
        this.body = value;
        this.writableEnded = true;
        return this;
      },
      send(value: unknown) {
        return this.json(value);
      },
    });
    const request: any = Object.assign(new EventEmitter(), {
      method,
      url: path,
      path,
      originalUrl: path,
      body,
      headers,
      rawHeaders: ['Host', headers.host ?? '127.0.0.1:4000'],
      hostname: headers.host ?? '127.0.0.1',
      baseUrl: '',
      header: (name: string) => headers[name.toLowerCase()],
      ...(method === 'POST' ? { tenantContext: { ...ctx, role: state.role } } : {}),
      res: response,
    });
    if (method === 'GET') {
      try {
        await middleware.use(request, response, () => {});
      } catch (error) {
        response
          .status((error as { getStatus?: () => number }).getStatus?.() ?? 500)
          .json({ message: 'Owner authentication refused' });
        return response;
      }
    }
    const layer = router.stack.find(
      (item: any) => item.route?.path === path && item.route.methods[method.toLowerCase()],
    );
    expect(layer).toBeDefined();
    await layer.route.stack[0].handle(request, response, () => {});
    return response;
  }
  const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    expect(String(url)).toBe('http://127.0.0.1:4000/api/billing/summary');
    expect(options).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: {
        authorization: 'Bearer synthetic-current',
        'x-capiro-tenant': ctx.tenantSlug,
        accept: 'application/json',
      },
    });
    expect(options?.headers).not.toHaveProperty('x-internal-service-secret');
    const result = await dispatch(
      '/api/billing/summary',
      'GET',
      undefined,
      options!.headers as Record<string, string>,
    );
    return new Response(JSON.stringify(result.body), {
      status: result.statusCode,
      headers: { 'content-type': 'application/json' },
    });
  });
  const send = (
    body: unknown = { source: 'core', kind: 'billing_summary' },
    overrides: Record<string, string> = {},
  ) =>
    dispatch('/api/clio/tools/read_saved_record', 'POST', body, {
      authorization: 'Bearer synthetic-current',
      'x-internal-service-secret': secret,
      ...overrides,
    });
  return { app, state, getSummary, fetchSpy, send };
}

describe('saved-record mounted fixed-route bridge', () => {
  const priorPreview = process.env.PREVIEW_NATIVE_GETS_ENABLED;
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeEach(async () => {
    process.env.PREVIEW_NATIVE_GETS_ENABLED = 'false';
    f = await fixture();
  });
  afterEach(async () => {
    if (priorPreview === undefined) delete process.env.PREVIEW_NATIVE_GETS_ENABLED;
    else process.env.PREVIEW_NATIVE_GETS_ENABLED = priorPreview;
    jest.restoreAllMocks();
    await f.app.close();
  });
  it('executes the existing billing HTTP guards and bounded receiver, then observes revoked billing permission', async () => {
    const result = await f.send();
    expect(result.statusCode).toBe(200);
    expect(result.body.data).toEqual(summary);
    expect(result.headers['cache-control']).toBe('private, no-store');
    f.state.billingAdmin = false;
    expect((await f.send()).statusCode).toBe(403);
    expect(f.getSummary).toHaveBeenCalledTimes(1);
  });
  it.each(['inactive-member', 'standard-user'])(
    'does not bypass canonical summary guards for %s',
    async (reason) => {
      if (reason === 'inactive-member') f.state.member = false;
      else f.state.role = 'standard_user';
      expect((await f.send()).statusCode).toBe(403);
      expect(f.getSummary).not.toHaveBeenCalled();
    },
  );
  it('uses the real tenant resolver in preview billing and refuses a stale outer tenant slug', async () => {
    f.state.preview = true;
    process.env.PREVIEW_NATIVE_GETS_ENABLED = 'true';
    expect((await f.send()).statusCode).toBe(200);
    expect(f.fetchSpy.mock.calls[0]![1]!.headers).toHaveProperty(
      'host',
      'first-chat-preview.app-dev.capiro.ai',
    );
    f.state.currentSlug = 'different-current-org';
    expect((await f.send()).statusCode).toBe(403);
    expect(f.getSummary).toHaveBeenCalledTimes(1);
  });
  it.each(['core', 'workspace'])(
    'refuses impersonated %s reads before any transport',
    async (source) => {
      const body =
        source === 'core' ? { source, kind: 'billing_summary' } : { source, kind: 'newsletters' };
      expect((await f.send(body, { 'x-capiro-impersonate-tenant': 'other-org' })).statusCode).toBe(
        403,
      );
      expect(f.fetchSpy).not.toHaveBeenCalled();
    },
  );
  it.each<Record<string, string>>([
    { 'x-internal-service-secret': 'wrong' },
    { authorization: 'CapiroMeriRead synthetic' },
  ])('refuses unverified service or non-session authority before transport', async (headers) => {
    expect((await f.send(undefined, headers)).statusCode).toBe(403);
    expect(f.fetchSpy).not.toHaveBeenCalled();
  });
  it('forwards exact Workspace selectors and only user bearer, preserving full saved snapshot', async () => {
    f.fetchSpy.mockImplementationOnce(async (url, options) => {
      expect(String(url)).toBe('http://workspace.synthetic/workspace-api/saved-records/read');
      expect(options).toMatchObject({
        method: 'POST',
        redirect: 'error',
        headers: { authorization: 'Bearer synthetic-current' },
      });
      expect(Object.keys(options!.headers!)).toEqual(['authorization', 'accept', 'content-type']);
      expect(JSON.parse(String(options?.body))).toEqual({
        kind: 'saved_version',
        draftId: actorId,
        versionId,
      });
      return new Response(JSON.stringify(version), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const result = await f.send({
      source: 'workspace',
      kind: 'saved_version',
      input: { draftId: actorId, versionId },
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual(version);
  });
  it('refuses model authority and transport keys without issuing a request', async () => {
    expect(
      (
        await f.send({
          source: 'workspace',
          kind: 'newsletter',
          input: { documentId: actorId, actorId },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await f.send({ source: 'core', kind: 'tenant_contact', url: 'https://untrusted.invalid' }))
        .statusCode,
    ).toBe(400);
    expect(f.fetchSpy).not.toHaveBeenCalled();
  });
  it('retains owner refusal without leaking its body or retrying', async () => {
    f.fetchSpy.mockResolvedValueOnce(new Response('sensitive driver failure', { status: 404 }));
    const result = await f.send();
    expect(result.statusCode).toBe(404);
    expect(JSON.stringify(result.body)).not.toContain('sensitive');
    expect(f.fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe('saved-record response boundary', () => {
  it('projects only canonical contact fields and truthfully reports omitted legacy extras', () => {
    const result = receiveCoreSavedRecord(
      'tenant_contact',
      { name: 'Firm', email: 'contact@example.invalid', legacySecret: 'never return' },
      tenantId,
    );
    expect(result.data).toEqual({ name: 'Firm', email: 'contact@example.invalid' });
    expect(result.coverage.limitations.join(' ')).toContain('legacy extra keys are omitted');
    expect(() =>
      receiveCoreSavedRecord('tenant_contact', { name: { secret: 'object' } }, tenantId),
    ).toThrow();
  });
  it('keeps integer onboarding version and exact decimal strings without floating conversion', () => {
    expect(
      receiveCoreSavedRecord(
        'billing_state',
        {
          billingEnabled: true,
          status: 'active',
          slots: 1,
          usedSlots: 0,
          trialEndsAt: null,
          onboardingFlowVersion: 2,
          locked: false,
        },
        tenantId,
      ).data,
    ).toHaveProperty('onboardingFlowVersion', 2);
    const row = {
      id: actorId,
      tenantId,
      userId: null,
      workflow: 'saved',
      provider: 'anthropic',
      model: 'saved',
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: '900719.123456',
      usedTenantKey: false,
      promptSpecVersion: null,
      createdAt: '2026-10-27T00:00:00.000Z',
    };
    expect(receiveCoreSavedRecord('usage_events', [row], tenantId).data).toEqual([row]);
    expect(() =>
      receiveCoreSavedRecord('usage_events', [{ ...row, tenantId: actorId }], tenantId),
    ).toThrow();
  });
  it('refuses wrong Workspace selected identity, kind and envelope bounds', () => {
    for (const wrong of [
      { ...version, kind: 'newsletter' },
      { ...version, maxOutputBytes: 999999 },
      { ...version, data: { ...(version.data as object), versionId: actorId } },
    ]) {
      expect(() =>
        receiveWorkspaceSavedRecord('saved_version', { draftId: actorId, versionId }, wrong),
      ).toThrow();
    }
  });
  it('preserves empty library continuation and nullable exact-stage absence', () => {
    expect(
      receiveWorkspaceSavedRecord(
        'library',
        {},
        envelope('library', { items: [], nextCursor: 'opaque-continuation' }),
      ).data,
    ).toEqual({ items: [], nextCursor: 'opaque-continuation' });
    expect(
      receiveWorkspaceSavedRecord(
        'newsletter_stage',
        { documentId: actorId, revision: 2 },
        envelope('newsletter_stage', null),
      ).data,
    ).toBeNull();
  });
  it('bounds actual multibyte stream before parsing despite misleading Content-Length', async () => {
    const bytes = Buffer.from(JSON.stringify({ text: '界'.repeat(90_000) }));
    await expect(
      readSavedRecordJson(new Response(bytes, { headers: { 'content-length': '1' } })),
    ).rejects.toMatchObject({ status: 413 });
    await expect(readSavedRecordJson(new Response('not JSON'))).rejects.toMatchObject({
      status: 503,
    });
  });
});
