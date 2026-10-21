import 'reflect-metadata';
import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  All, Controller, HttpCode, Injectable, MiddlewareConsumer, Module, NestModule, Req, ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NextFunction, Request, Response } from 'express';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import { ClerkService } from '../auth/clerk.service.js';
import { createInProcessEd25519Signer } from '../auth/core-ed25519-signer.js';
import { meriExecutionRequestOf } from '../auth/meri-execution-request.js';
import { delegationPath, sha256Hex } from '../auth/read-delegation/read-delegation.contract.js';
import { signReadToken } from '../auth/read-delegation/read-delegation-token.js';
import { configureApiHttpApp } from '../bootstrap/configure-api-http-app.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantContextMiddleware } from './tenant-context.middleware.js';
import { TenantContextStore } from './tenant-context.store.js';

jest.mock('@clerk/backend', () => ({ __esModule: true, createClerkClient: () => ({}), verifyToken: async () => ({}) }));

const T = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';
const M = '33333333-3333-4333-8333-333333333333';
const C = '44444444-4444-4444-8444-444444444444';
const V = '55555555-5555-4555-8555-555555555555';
const R = '66666666-6666-4666-8666-666666666666';
const D = '77777777-7777-4777-8777-777777777777';
const keys = generateKeyPairSync('ed25519');
const issuer = 'capiro-core:mounted-test:v1';
const kid = 'mounted-authority-test';
const serviceSecret = 'local-mounted-authority-test';
const historyPath = '/api/clio/application-authority/history-release';
const executionPath = '/api/clio/tools/create_task';
const retained: Array<[string, string]> = [
  ['/api/clio/retained-reads/research-portfolio', 'CapiroRetained'],
  ['/api/clio/retained-reads/research-portfolio-changes', 'CapiroRetained'],
  ['/api/clio/application-authority/retained-florida-current', 'CapiroRetained'],
  ['/api/clio/application-authority/retained-florida-native-current', 'CapiroRetainedAuthority'],
];
const servicePosts = [
  '/api/clio/routines/unattended-grant',
  '/api/clio/application-authority/read-delegations',
  `/api/clio/application-authority/read-delegations/${D}/tokens`,
  `/api/clio/application-authority/read-delegations/${D}/revocations`,
  `/api/clio/application-authority/read-delegation-consents/${D}/state`,
];
const heldMemory: Array<[string, string]> = [
  ['/api/clio/tools/search_memory_eligibility', 'Passive memory helper unavailable'],
  ['/api/clio/tools/search_memory', 'Passive memory page unavailable'],
  ['/api/clio/tools/memory.list_own_proposals', 'Memory proposal page unavailable'],
];

let configureProductionMiddleware: (consumer: MiddlewareConsumer) => void;
beforeAll(async () => {
  // Execute the actual AppModule.configure without constructing its broad DI
  // graph. Import-time validation uses local placeholders, then restores env.
  const defaults = {
    DATABASE_URL: 'postgresql://capiro:local@127.0.0.1:5432/mounted_authority_spec',
    CLERK_SECRET_KEY: 'sk_test_mounted_authority_spec', CLERK_WEBHOOK_SIGNING_SECRET: 'whsec_mounted_authority_spec',
  };
  const prior = Object.fromEntries(Object.keys(defaults).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(defaults)) process.env[key] ??= value;
    const { AppModule } = await import('../app.module.js');
    configureProductionMiddleware = (consumer) => new AppModule().configure(consumer);
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}, 60_000);

function executionToken() {
  const iat = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'capiro-meri-execution+jwt', kid })).toString('base64url');
  const payload = Buffer.from(canonicalizeCoreRetainedJson({
    iss: issuer, aud: 'meri-gateway', iat, nbf: iat, exp: iat + 60, jti: D,
    capability: { binding: { tenantId: T, actorId: A } }, execution: {},
  })).toString('base64url');
  const input = `${header}.${payload}`;
  return `${input}.${nodeSign(null, Buffer.from(input, 'ascii'), keys.privateKey).toString('base64url')}`;
}

async function currentReadToken() {
  const iat = Math.floor(Date.now() / 1000);
  const signer = createInProcessEd25519Signer({ issuer, kid, privateKey: keys.privateKey });
  return (await signReadToken(signer, {
    sub: D, iat, nbf: iat, exp: iat + 60, kind: 'current', callKey: 'current', method: 'POST',
    path: delegationPath(D, 'current'), bodySha256: sha256Hex(Buffer.from('{}')),
    operation: null, toolRequestSha256: null, referenceSha256: null,
    tenantId: T, actorId: A, clientId: C, conversationId: V, runId: R,
  })).token;
}

async function fixture(options: { rewrittenTarget?: string; historyLeaf?: boolean; unavailableReadTransaction?: boolean } = {}) {
  const mounts: Array<{ baseUrl: string; path: string; originalUrl: string }> = [];
  const queries: string[] = [];
  const user = { id: A, clerkUserId: 'user_mounted' };
  const tenant = { id: T, slug: 'mounted', status: 'active', clerkOrgId: 'org_mounted' };
  const membership = { id: M, tenantId: T, userId: A, role: 'standard_user', status: 'active', updatedAt: new Date(10), tenant };
  const tx = {
    user: { findUnique: jest.fn(async () => user), findFirst: jest.fn(async () => user), update: jest.fn(async () => user) },
    tenantMembership: { findMany: jest.fn(async () => [membership]), findFirst: jest.fn(async () => membership) },
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?'); queries.push(sql);
      if (sql.includes('FROM users')) return [{ id: A }];
      if (sql.includes('FROM tenants')) return [{ id: T }];
      if (sql.includes('FROM tenant_memberships')) return [{ id: M }];
      throw new Error('Unexpected mounted fixture query');
    }),
  };
  const withSystem = jest.fn(async (fn: (transaction: typeof tx) => unknown) => {
    if (options.unavailableReadTransaction) throw new ServiceUnavailableException('Mounted read transaction reached');
    return fn(tx);
  });
  const verify = jest.fn(async (token: string) => {
    if (token !== 'native') throw new Error('Not a native Clerk test token');
    return { sub: user.clerkUserId, sid: 'session_mounted', iss: 'https://clerk.app.capiro.ai',
      exp: Math.floor(Date.now() / 1000) + 120, capiro_tenant_id: T, capiro_tenant_slug: tenant.slug, org_id: tenant.clerkOrgId };
  });
  const activeSession = jest.fn(async () => ({ id: 'session_mounted', userId: user.clerkUserId, status: 'active',
    createdAt: 1, expireAt: Date.now() + 120_000, abandonAt: Date.now() + 120_000,
    expiresAtMs: Date.now() + 120_000, actor: null }));

  @Injectable()
  class ObserveMountedRequest {
    use(req: Request, _res: Response, next: NextFunction) {
      if (options.rewrittenTarget !== undefined) req.originalUrl = options.rewrittenTarget;
      mounts.push({ baseUrl: req.baseUrl, path: req.path, originalUrl: req.originalUrl });
      next();
    }
  }
  @Injectable()
  class ReadHistoryWhileMounted {
    constructor(private readonly authority: TenantContextMiddleware) {}
    async use(req: Request & { tenantContext?: any }, _res: Response, next: NextFunction) {
      if (options.historyLeaf) {
        await this.authority.lockOriginalApplicationAuthorityInTransaction(req, req.tenantContext, tx as any);
        await this.authority.readFreshApplicationAuthorityInTransaction(req, req.tenantContext, tx as any);
      }
      next();
    }
  }
  @Controller()
  class ReceiverProbe {
    @All('*') @HttpCode(200) receive(@Req() req: Request & { tenantContext?: any }) {
      return { reached: true, actorId: req.tenantContext?.userId ?? null,
        executionActor: meriExecutionRequestOf(req)?.actorId ?? null };
    }
  }
  @Module({ controllers: [ReceiverProbe], providers: [TenantContextMiddleware, TenantContextStore,
    { provide: ClerkService, useValue: { verifySessionToken: verify, assertActiveApplicationAuthoritySession: activeSession } },
    { provide: PrismaService, useValue: { withSystem } }] })
  class ProbeModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
      consumer.apply(ObserveMountedRequest).forRoutes('*');
      configureProductionMiddleware(consumer);
      consumer.apply(ReadHistoryWhileMounted).forRoutes('*');
    }
  }
  const module = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
  const app = module.createNestApplication({ logger: false });
  configureApiHttpApp(app, { includeClerkRawBody: true, includeRecallRawBody: true, includeTangoRawBody: true,
    includeObjectiveDecisionRawBody: true, includeMeriReadDelegationRawBody: true,
    includeEmailSignatureLargeBody: true, defaultJsonLimit: '1mb' });
  await app.init();
  const send = async (target: string, options: { method?: string; authorization?: string; host?: string } = {}) => {
    const server = app.getHttpServer();
    if (!server.listening) await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: (server.address() as AddressInfo).port,
        method: options.method ?? 'POST', path: target,
        headers: { Host: options.host ?? 'core.invalid', 'Content-Type': 'application/json', 'Content-Length': 2,
          'x-internal-service-secret': serviceSecret, Connection: 'close',
          ...(options.authorization ? { Authorization: options.authorization } : {}) },
      }, (res) => {
        let body = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => { resolve({ status: res.statusCode!, body: body ? JSON.parse(body) : null }); });
      });
      req.on('error', reject); req.end('{}');
    });
  };
  return { app, send, mounts, verify, withSystem, activeSession, tx, queries };
}

describe('fixed authority routes through production AppModule middleware mounting', () => {
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  const envKeys = ['RETAINED_READS_ENABLED', 'PREVIEW_NATIVE_GETS_ENABLED', 'CORE_ROSTER_PREVIEW_ENABLED', 'INTERNAL_SERVICE_SECRET',
    ...['MERI_EXECUTION_SIGNER', 'MERI_READ_DELEGATION_SIGNER'].flatMap((prefix) =>
      ['ISSUER', 'KID', 'KMS_KEY_ARN', 'PUBLIC_KEY_X'].map((suffix) => `${prefix}_${suffix}`))];
  let prior: Record<string, string | undefined>;
  beforeEach(() => {
    prior = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    process.env.RETAINED_READS_ENABLED = 'true';
    process.env.PREVIEW_NATIVE_GETS_ENABLED = 'false'; process.env.CORE_ROSTER_PREVIEW_ENABLED = 'false';
    process.env.INTERNAL_SERVICE_SECRET = serviceSecret;
    for (const prefix of ['MERI_EXECUTION_SIGNER', 'MERI_READ_DELEGATION_SIGNER']) {
      process.env[`${prefix}_ISSUER`] = issuer; process.env[`${prefix}_KID`] = kid;
      // Synthetic config for in-process Ed25519 verification; no KMS call.
      process.env[`${prefix}_KMS_KEY_ARN`] = 'arn:aws:kms:us-east-1:123456789012:key/00000000-0000-4000-8000-000000000000';
      process.env[`${prefix}_PUBLIC_KEY_X`] = keys.publicKey.export({ format: 'jwk' }).x!;
    }
  });
  afterEach(async () => {
    await f?.app.close(); f = undefined;
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it.each(retained)('passes exact retained target %s to its signature-verifying receiver', async (path, scheme) => {
    f = await fixture();
    expect((await f.send(path, { authorization: `${scheme} synthetic` })).status).toBe(200);
    expect((await f.send(`${path}?source=retained`, { authorization: `${scheme} synthetic` })).status).toBe(200);
    expect(f.mounts[0]).toEqual({ baseUrl: path, path: '/', originalUrl: path });
    expect(f.verify).not.toHaveBeenCalled(); expect(f.withSystem).not.toHaveBeenCalled();
  });

  it.each(retained)('refuses nearby, trailed, rewritten and absolute retained target %s', async (path, scheme) => {
    f = await fixture({ rewrittenTarget: '/api/rewritten' });
    expect((await f.send(path, { authorization: `${scheme} synthetic` })).status).toBe(401);
    await f.app.close(); f = await fixture();
    for (const target of [`${path}/`, `${path}-other`, `http://core.invalid${path}`]) {
      expect((await f.send(target, { authorization: `${scheme} synthetic` })).status).toBe(401);
    }
    expect((await f.send(path, { method: 'GET', authorization: `${scheme} synthetic` })).status).toBe(401);
    expect((await f.send(path, { authorization: 'CapiroWrong synthetic' })).status).toBe(401);
    expect(f.withSystem).not.toHaveBeenCalled();
  });

  it('verifies execution identity on the exact mounted receiver and refuses alternate targets', async () => {
    f = await fixture(); const authorization = `Bearer ${executionToken()}`;
    expect(await f.send(executionPath, { authorization })).toEqual({ status: 200,
      body: { reached: true, actorId: A, executionActor: A } });
    expect(f.mounts[0]).toEqual({ baseUrl: executionPath, path: '/', originalUrl: executionPath });
    expect(f.verify).not.toHaveBeenCalled();
    const reads = f.withSystem.mock.calls.length;
    for (const target of [`${executionPath}/`, `${executionPath}?x=1`, `${executionPath}-other`, `http://core.invalid${executionPath}`]) {
      expect((await f.send(target, { authorization })).status).toBe(401);
    }
    expect(f.withSystem).toHaveBeenCalledTimes(reads);
  });

  it.each(servicePosts)('passes exact bearer-less service target %s without Clerk provisioning', async (path) => {
    f = await fixture();
    expect((await f.send(path)).status).toBe(200);
    expect(f.mounts[0]).toEqual({ baseUrl: path, path: '/', originalUrl: path });
    for (const target of [`${path}/`, `${path}?x=1`, `${path}-other`, `http://core.invalid${path}`]) {
      expect((await f.send(target)).status).toBe(401);
    }
    expect((await f.send(path, { method: 'GET' })).status).toBe(401);
    expect(f.verify).not.toHaveBeenCalled(); expect(f.withSystem).not.toHaveBeenCalled();
  });

  it('reaches read-token current facts only after the exact mounted path and raw-body checks', async () => {
    f = await fixture({ unavailableReadTransaction: true });
    const path = delegationPath(D, 'current'); const authorization = `CapiroMeriRead ${await currentReadToken()}`;
    const valid = await f.send(path, { authorization });
    expect(valid.status).toBe(503); expect(valid.body.message).toBe('Mounted read transaction reached');
    expect(f.withSystem).toHaveBeenCalledTimes(1); expect(f.verify).not.toHaveBeenCalled();
    for (const target of [`${path}/`, `${path}?x=1`, `${path}-other`, `http://core.invalid${path}`]) {
      expect((await f.send(target, { authorization })).status).toBe(403);
    }
    expect(f.withSystem).toHaveBeenCalledTimes(1);
  });

  it.each(heldMemory)('keeps held signed-memory target %s closed before token consumption', async (path, message) => {
    f = await fixture(); const authorization = 'CapiroMeriRead synthetic';
    const result = await f.send(path, { authorization });
    expect(result.status).toBe(503); expect(result.body.message).toBe(message);
    expect(f.mounts[0]).toEqual({ baseUrl: path, path: '/', originalUrl: path });
    for (const target of [`${path}/`, `${path}?x=1`, `${path}-other`, `http://core.invalid${path}`]) {
      expect((await f.send(target, { authorization })).status).toBe(401);
    }
    expect(f.verify).not.toHaveBeenCalled(); expect(f.withSystem).not.toHaveBeenCalled();
  });

  it('admits the exact mounted roster GET and rejects malformed targets before identity work', async () => {
    process.env.CORE_ROSTER_PREVIEW_ENABLED = 'true'; process.env.PREVIEW_NATIVE_GETS_ENABLED = 'true';
    f = await fixture();
    const options = { method: 'GET', host: 'core-roster-preview.capiro.ai', authorization: 'Bearer native' };
    expect((await f.send('/api/clients?sectorTag=defense', options)).status).toBe(200);
    expect(f.activeSession).toHaveBeenCalledTimes(1); expect(f.tx.user.update).not.toHaveBeenCalled();
    for (const target of ['/api/clients/', '/api/clients?unknown=x', '/api/clients-other',
      'http://core-roster-preview.capiro.ai/api/clients']) {
      expect((await f.send(target, options)).status).toBe(404);
    }
    expect((await f.send('/api/clients', { ...options, method: 'HEAD' })).status).toBe(404);
    expect(f.activeSession).toHaveBeenCalledTimes(1); expect(f.verify).toHaveBeenCalledTimes(1);
  });

  it('keeps preview protection on mounted native reads instead of falling into ordinary writes', async () => {
    process.env.PREVIEW_NATIVE_GETS_ENABLED = 'true';
    f = await fixture();
    const options = { method: 'GET', host: 'first-chat-preview.app-dev.capiro.ai', authorization: 'Bearer native' };
    expect((await f.send('/api/memory/owner/items', options)).status).toBe(200);
    expect(f.activeSession).toHaveBeenCalledTimes(1); expect(f.tx.user.update).not.toHaveBeenCalled();
  });

  it('checks native history provenance while the real consumer mount still has path slash', async () => {
    f = await fixture({ historyLeaf: true });
    expect((await f.send(historyPath, { authorization: 'Bearer native' })).status).toBe(200);
    expect(f.mounts[0]).toEqual({ baseUrl: historyPath, path: '/', originalUrl: historyPath });
    expect(f.queries).toHaveLength(3); expect(f.queries.every((sql) => sql.includes('FOR SHARE'))).toBe(true);
    expect(f.activeSession).toHaveBeenCalledTimes(1);
    for (const target of [`${historyPath}/`, `${historyPath}?x=1`, `${historyPath}-other`, `http://core.invalid${historyPath}`]) {
      expect((await f.send(target, { authorization: 'Bearer native' })).status).toBe(403);
    }
    expect(f.queries).toHaveLength(3); expect(f.activeSession).toHaveBeenCalledTimes(1);
  });

  it('refuses rewritten history provenance before any lock or online currentness read', async () => {
    f = await fixture({ historyLeaf: true, rewrittenTarget: '/api/rewritten' });
    expect((await f.send(historyPath, { authorization: 'Bearer native' })).status).toBe(403);
    expect(f.queries).toHaveLength(0); expect(f.activeSession).not.toHaveBeenCalled();
  });
});
