import 'reflect-metadata';
import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  Controller, Get, HttpCode, Injectable, MiddlewareConsumer, Module, NestModule, Post,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { ClerkService } from './clerk.service.js';
import { CapiroThrottlerGuard } from './capiro-throttler.guard.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { applicationAuthorityThrottleKey, TenantContextMiddleware } from '../tenant/tenant-context.middleware.js';
import { TenantContextStore } from '../tenant/tenant-context.store.js';
import { configureApiHttpApp } from '../bootstrap/configure-api-http-app.js';

// Only provider I/O is synthetic. Nest runs the actual middleware, global
// guard, routing, and the installed throttler's storage and limits.
jest.mock('@clerk/backend', () => ({
  __esModule: true,
  createClerkClient: () => ({}),
  verifyToken: async () => ({}),
}));

const authorityPaths = ['identity', 'context', 'membership', 'current'];
const now = 1_800_000_000_000;
let configureProductionMiddleware: (consumer: MiddlewareConsumer) => void;

beforeAll(async () => {
  // Import the actual module for its configure method without constructing its
  // broad provider graph. Import-time config validation receives local dummies;
  // no database or SDK connection is created, and prior env values are restored.
  const defaults = {
    DATABASE_URL: 'postgresql://capiro:local@127.0.0.1:5432/p6_throttle_spec',
    CLERK_SECRET_KEY: 'sk_test_p6_throttle_spec',
    CLERK_WEBHOOK_SIGNING_SECRET: 'whsec_p6_throttle_spec',
  };
  const prior = Object.fromEntries(Object.keys(defaults).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(defaults)) process.env[key] ??= value;
    const { AppModule } = await import('../app.module.js');
    configureProductionMiddleware = (consumer) => new AppModule().configure(consumer);
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}, 60_000);

@Controller('clio/application-authority')
class AuthorityProbeController {
  @Post('identity') @HttpCode(200) identity() { return { ok: true }; }
  @Post('context') @HttpCode(200) context() { return { ok: true }; }
  @Post('membership') @HttpCode(200) membership() { return { ok: true }; }
  @Post('current') @HttpCode(200) current() { return { ok: true }; }
  @Get('identity') readIdentity() { return { ok: true }; }
  @Post('identity-extra') @HttpCode(200) otherAuthority() { return { ok: true }; }
}

@Controller('ordinary')
class OrdinaryProbeController {
  @Post() @HttpCode(200) ordinary() { return { ok: true }; }
}

async function fixture(authenticate = true, rewrittenTarget?: string) {
  const events: string[] = [];
  const trackers: string[] = [];
  const tenant = { id: 'tenant_test', slug: 'test', status: 'active', clerkOrgId: 'org_test' };
  const user = (clerkUserId: string) => ({ id: `actor_${clerkUserId}`, clerkUserId });
  const tx = {
    user: {
      findUnique: async ({ where }: any) => user(where.clerkUserId),
      update: async ({ where }: any) => ({ id: where.id }),
    },
    tenantMembership: {
      findMany: async ({ where }: any) => [{
        id: `member_${where.userId}`, userId: where.userId, tenantId: tenant.id,
        role: 'standard_user', status: 'active', updatedAt: new Date(2), tenant,
      }],
    },
  };
  const prisma = { withSystem: async (fn: (transaction: typeof tx) => unknown) => fn(tx) };
  const clerk = {
    verifySessionToken: async (token: string) => {
      events.push('verified');
      const [kind, name] = token.split('-');
      return {
        sub: `user_${name}`, iss: 'https://clerk.app.capiro.ai', exp: now / 1000 + 120,
        capiro_tenant_id: tenant.id, capiro_tenant_slug: tenant.slug, org_id: tenant.clerkOrgId,
        ...(kind === 'control'
          ? { meri_control_credential: true, jti: `control_${name}`, iat: now / 1000 }
          : { sid: `sess_${name}` }),
      };
    },
    assertActiveMeriControlCredentialSession: async (claims: { sub: string; jti?: string }) => ({
      id: `meri-template:${claims.jti}`, userId: claims.sub, status: 'active', createdAt: 1,
      expireAt: now + 120_000, abandonAt: now + 120_000, expiresAtMs: now + 120_000, actor: null,
    }),
  };

  @Injectable()
  class ObservedThrottlerGuard extends CapiroThrottlerGuard {
    protected async getTracker(req: Record<string, any>): Promise<string> {
      const tracker = await super.getTracker(req);
      events.push('guard');
      trackers.push(tracker);
      return tracker;
    }
  }

  // Deliberately forge public request fields. Neither a request DTO nor an
  // earlier middleware can manufacture the private authority provenance.
  @Injectable()
  class SpoofPublicRequestFields {
    use(req: Request, _res: Response, next: NextFunction) {
      events.push(`request-path:${req.path}:${req.originalUrl}`);
      if (rewrittenTarget !== undefined) req.originalUrl = rewrittenTarget;
      Object.assign(req, {
        claims: { sub: 'forged_user' }, user: { sub: 'forged_user' },
        tenantContext: { clerkUserId: 'forged_user' },
        applicationAuthorityRequests: { claims: { sub: 'forged_user' } },
      });
      next();
    }
  }

  @Module({
    imports: [ThrottlerModule.forRoot([
      { name: 'short', ttl: 1000, limit: 30 },
      { name: 'long', ttl: 60_000, limit: 600 },
    ])],
    controllers: [AuthorityProbeController, OrdinaryProbeController],
    providers: [
      TenantContextMiddleware, TenantContextStore,
      { provide: ClerkService, useValue: clerk },
      { provide: PrismaService, useValue: prisma },
      { provide: APP_GUARD, useClass: ObservedThrottlerGuard },
    ],
  })
  class ProbeModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
      consumer.apply(SpoofPublicRequestFields).forRoutes('*');
      if (authenticate) configureProductionMiddleware(consumer);
    }
  }

  const module = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
  const app = module.createNestApplication({ logger: false });
  configureApiHttpApp(app, {
    includeClerkRawBody: true, includeRecallRawBody: true, includeTangoRawBody: true,
    includeObjectiveDecisionRawBody: true, includeMeriReadDelegationRawBody: true,
    includeEmailSignatureLargeBody: true, defaultJsonLimit: '1mb',
  });
  await app.init();
  const post = (path: string, token = 'native-a') => request(app.getHttpServer())
    .post(`/api/${path}`).set('Authorization', `Bearer ${token}`).send({ claims: { sub: 'body_forgery' } });
  const rawPost = async (target: string) => {
    const server = app.getHttpServer();
    if (!server.listening) await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    return new Promise<number>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1', port, method: 'POST', path: target,
        headers: { Authorization: 'Bearer control-a', Connection: 'close' },
      }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject);
      req.end();
    });
  };
  return { app, events, trackers, post, rawPost };
}

describe('authority throttling through the real Nest middleware/guard pipeline', () => {
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  beforeEach(() => { jest.spyOn(Date, 'now').mockReturnValue(now); });
  afterEach(async () => { await f?.app.close(); f = undefined; jest.restoreAllMocks(); });

  it.each(authorityPaths)('uses verified user provenance before the guard on POST %s', async (path) => {
    f = await fixture();
    const route = `clio/application-authority/${path}`;
    for (let hit = 0; hit < 30; hit++) expect((await f.post(route, 'control-a')).status).toBe(200);
    expect((await f.post(route, 'control-a')).status).toBe(429);
    expect((await f.post(route, 'control-b')).status).toBe(200);
    expect(f.events.slice(1, 4)).toEqual(['verified', 'guard', 'guard']);
    expect(f.trackers.slice(0, 2)).toEqual(['authority-user:user_a', 'authority-user:user_a']);
    expect(f.trackers.slice(-2)).toEqual(['authority-user:user_b', 'authority-user:user_b']);
  });

  it('shares one user bucket between native and control credentials', async () => {
    f = await fixture();
    const route = 'clio/application-authority/current';
    for (let hit = 0; hit < 30; hit++) expect((await f.post(route, 'native-a')).status).toBe(200);
    expect((await f.post(route, 'control-a')).status).toBe(429);
    expect((await f.post(route, 'native-b')).status).toBe(200);
  });

  it('observes consumer-mounted native provenance before the global guard', async () => {
    f = await fixture();
    expect((await f.post('clio/application-authority/current')).status).toBe(200);
    expect(f.events.slice(1, 4)).toEqual(['verified', 'guard', 'guard']);
    expect(f.trackers).toEqual(['authority-user:user_a', 'authority-user:user_a']);
  });

  it('admits a marked control credential through AppModule mounting with a query', async () => {
    f = await fixture();
    expect((await f.post('clio/application-authority/current?source=control', 'control-a')).status).toBe(200);
    expect(f.events[0]).toBe('request-path:/:/api/clio/application-authority/current?source=control');
    expect(f.trackers).toEqual(['authority-user:user_a', 'authority-user:user_a']);
  });

  it.each(['ordinary', 'clio/application-authority/identity/', 'clio/application-authority/IDENTITY',
    'clio/application-authority/identity-extra'])('refuses marked control credentials on %s', async (path) => {
    f = await fixture();
    expect((await f.post(path, 'control-a')).status).toBe(401);
    expect(f.trackers).toEqual([]);
  });

  it('refuses marked control credentials on an authority GET', async () => {
    f = await fixture();
    expect((await request(f.app.getHttpServer()).get('/api/clio/application-authority/identity')
      .set('Authorization', 'Bearer control-a')).status).toBe(401);
    expect(f.trackers).toEqual([]);
  });

  it('refuses an absolute-form control target through the actual HTTP pipeline', async () => {
    f = await fixture();
    expect(await f.rawPost('http://app.capiro.ai/api/clio/application-authority/current')).toBe(401);
    expect(f.trackers).toEqual([]);
  });

  it('refuses an original target rewritten to a different route', async () => {
    f = await fixture(true, '/api/ordinary');
    expect((await f.post('clio/application-authority/current', 'control-a')).status).toBe(401);
    expect(f.trackers).toEqual([]);
  });

  it('retains shared IP limits on non-authority routes even with verified users', async () => {
    f = await fixture();
    for (let hit = 0; hit < 30; hit++) expect((await f.post('ordinary', 'native-a')).status).toBe(200);
    expect((await f.post('ordinary', 'native-b')).status).toBe(429);
    expect(new Set(f.trackers).size).toBe(1);
    expect(f.trackers[0]).not.toMatch(/^authority-user:/);
  });

  it('falls back to IP without provenance despite forged claims, context, and body', async () => {
    f = await fixture(false);
    const route = 'clio/application-authority/current';
    for (let hit = 0; hit < 30; hit++) expect((await f.post(route, `native-${hit}`)).status).toBe(200);
    expect((await f.post(route, 'native-another').set('X-Forwarded-For', '203.0.113.12')).status).toBe(429);
    expect(new Set(f.trackers).size).toBe(1);
    expect(f.trackers[0]).not.toMatch(/^authority-user:/);
  });

  it.each(['identity/', 'IDENTITY', 'identity-extra'])('retains IP tracking for non-exact authority path %s', async (path) => {
    f = await fixture();
    expect((await f.post(`clio/application-authority/${path}`)).status).toBe(200);
    expect(f.trackers).toHaveLength(2);
    expect(f.trackers.every((tracker) => !tracker.startsWith('authority-user:'))).toBe(true);
  });

  it('retains IP tracking for an authority GET', async () => {
    f = await fixture();
    expect((await request(f.app.getHttpServer()).get('/api/clio/application-authority/identity')
      .set('Authorization', 'Bearer native-a')).status).toBe(200);
    expect(f.trackers.every((tracker) => !tracker.startsWith('authority-user:'))).toBe(true);
  });

  it('cannot manufacture provenance by copying public request fields', () => {
    expect(applicationAuthorityThrottleKey({
      method: 'POST', path: '/api/clio/application-authority/current',
      originalUrl: '/api/clio/application-authority/current',
      claims: { sub: 'forged_user' }, tenantContext: { clerkUserId: 'forged_user' },
    } as unknown as Request)).toBeNull();
  });

  it('delegates IP normalization to the installed framework guard', async () => {
    const requestShape = { ip: '2001:db8:1234:5678::9', method: 'GET', path: '/other' };
    const options = [{ name: 'short', ttl: 1000, limit: 30 }];
    const base = new ThrottlerGuard(options, {} as any, {} as any);
    const custom = new CapiroThrottlerGuard(options, {} as any, {} as any);
    await base.onModuleInit();
    await custom.onModuleInit();
    expect(await (custom as any).getTracker(requestShape)).toBe(await (base as any).getTracker(requestShape));
  });
});
