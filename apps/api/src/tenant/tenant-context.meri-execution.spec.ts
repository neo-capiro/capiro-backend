import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { generateKeyPairSync, sign as nodeSign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ForbiddenException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import type { ClerkService } from '../auth/clerk.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { meriExecutionRequestOf } from '../auth/meri-execution-request.js';
import { TenantContextMiddleware } from './tenant-context.middleware.js';
import type { TenantContextStore } from './tenant-context.store.js';

jest.mock('@clerk/backend', () => ({
  __esModule: true,
  createClerkClient: () => ({}),
  verifyToken: async () => ({}),
}));

const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const ISSUER = 'capiro-core:meri-execution:v1';
const KID = 'meri-execution-synthetic-1';
const PATH = '/api/clio/tools/create_task';
const ENV = ['ISSUER', 'KID', 'KMS_KEY_ARN', 'PUBLIC_KEY_X'].map((k) => `MERI_EXECUTION_SIGNER_${k}`);

const keys = generateKeyPairSync('ed25519');
const otherKeys = generateKeyPairSync('ed25519');

function token(privateKey: KeyObject = keys.privateKey, overrides: Record<string, unknown> = {}) {
  const iat = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'capiro-meri-execution+jwt', kid: KID })).toString('base64url');
  const payload = Buffer.from(canonicalizeCoreRetainedJson({
    iss: ISSUER, aud: 'meri-gateway', iat, nbf: iat, exp: iat + 60, jti: '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a',
    capability: { binding: { tenantId, actorId } }, execution: {}, ...overrides,
  }), 'utf8').toString('base64url');
  const signature = nodeSign(null, Buffer.from(`${header}.${payload}`, 'ascii'), privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

function fixture(authorization: string, options: { path?: string; headers?: Record<string, string>; role?: string; tenantStatus?: string; member?: boolean } = {}) {
  const path = options.path ?? PATH;
  const verify = jest.fn(async () => { throw new Error('Clerk must not be reached for an execution capability'); });
  const clerk = { verifySessionToken: verify } as unknown as ClerkService;
  const tx = {
    user: { findUnique: jest.fn(async () => ({ id: actorId, clerkUserId: 'user_synthetic' })) },
    tenantMembership: {
      findFirst: jest.fn(async () => (options.member === false ? null : {
        tenantId, userId: actorId, role: options.role ?? 'standard_user', status: 'active',
        tenant: { status: options.tenantStatus ?? 'active', slug: 'synthetic' },
      })),
    },
  };
  const system = jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx));
  const prisma = { withSystem: system } as unknown as PrismaService;
  const run = jest.fn((_ctx: unknown, continuation: () => void) => continuation());
  const store = { run } as unknown as TenantContextStore;
  const middleware = new TenantContextMiddleware(clerk, prisma, store);
  const headers: Record<string, string> = { authorization, host: 'core.example.invalid', ...(options.headers ?? {}) };
  const req = {
    method: 'POST', path, originalUrl: path, url: path, baseUrl: '', hostname: 'core.example.invalid', headers,
    header: jest.fn((name: string) => headers[name.toLowerCase()]),
  } as unknown as Request & { tenantContext?: unknown };
  const seen = new Map<string, string>();
  const res = { setHeader: (name: string, value: string) => { seen.set(name.toLowerCase(), value); } } as unknown as Response;
  const next = jest.fn();
  return { middleware, req, res, next, verify, system, run, seen };
}

describe('Meri execution capability admission in the tenant middleware (create_task only)', () => {
  const previous = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  const configure = () => {
    process.env.MERI_EXECUTION_SIGNER_ISSUER = ISSUER;
    process.env.MERI_EXECUTION_SIGNER_KID = KID;
    process.env.MERI_EXECUTION_SIGNER_KMS_KEY_ARN = 'arn:aws:kms:us-east-1:123456789012:key/00000000-0000-4000-8000-000000000000';
    process.env.MERI_EXECUTION_SIGNER_PUBLIC_KEY_X = keys.publicKey.export({ format: 'jwk' }).x!;
  };
  beforeEach(() => { for (const k of ENV) delete process.env[k]; });
  afterEach(() => { for (const k of ENV) { if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k]; } });

  it('admits an active standard member from the signed binding without Clerk and marks the request', async () => {
    configure();
    const credential = token();
    const f = fixture(`Bearer ${credential}`);
    await f.middleware.use(f.req, f.res, f.next);
    expect(f.next).toHaveBeenCalledTimes(1);
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.req.tenantContext).toMatchObject({ tenantId, userId: actorId, role: 'standard_user' });
    expect(meriExecutionRequestOf(f.req)).toMatchObject({ token: credential, tenantId, actorId });
    expect(f.seen.get('cache-control')).toBe('no-store');
  });

  it('answers 503 when the execution key is not configured', async () => {
    const f = fixture(`Bearer ${token()}`);
    await expect(f.middleware.use(f.req, f.res, f.next)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(f.next).not.toHaveBeenCalled();
    expect(f.system).not.toHaveBeenCalled();
  });

  it.each([
    ['another key', () => token(otherKeys.privateKey)],
    ['another issuer', () => token(keys.privateKey, { iss: 'capiro-core:other:v1' })],
    ['expired', () => token(keys.privateKey, { iat: 1_700_000_000, nbf: 1_700_000_000, exp: 1_700_000_060 })],
    ['lifetime over 120 s', () => { const iat = Math.floor(Date.now() / 1000); return token(keys.privateKey, { iat, nbf: iat, exp: iat + 121 }); }],
  ])('refuses %s with 401 before any database read', async (_label, make) => {
    configure();
    const f = fixture(`Bearer ${make()}`);
    await expect(f.middleware.use(f.req, f.res, f.next)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(f.system).not.toHaveBeenCalled();
    expect(f.next).not.toHaveBeenCalled();
  });

  it.each([
    ['a tenant header', { headers: { 'x-capiro-tenant': tenantId } }],
    ['an impersonation header', { headers: { 'x-capiro-impersonate-tenant': tenantId } }],
    ['no membership', { member: false }],
    ['a role below standard_user', { role: 'viewer' }],
    ['an inactive tenant', { tenantStatus: 'suspended' }],
  ])('refuses %s with 403', async (_label, options) => {
    configure();
    const f = fixture(`Bearer ${token()}`, options);
    await expect(f.middleware.use(f.req, f.res, f.next)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.next).not.toHaveBeenCalled();
    expect(meriExecutionRequestOf(f.req)).toBeUndefined();
  });

  it('keeps the authority closure SDK-free: the middleware imports only the pure key config and request helper', () => {
    const read = (path: string) => readFileSync(resolve(__dirname, '..', path), 'utf8');
    const middleware = read('tenant/tenant-context.middleware.ts');
    expect(middleware).toContain("from '../auth/core-ed25519-key-config.js'");
    expect(middleware).not.toContain('core-ed25519-kms-config');
    for (const path of ['auth/core-ed25519-key-config.ts', 'auth/meri-execution-request.ts', 'auth/core-ed25519-signer.ts',
      'auth/read-delegation/read-delegation-request.ts', 'auth/read-delegation/read-delegation-token.ts',
      'auth/read-delegation/read-delegation-facts.ts', 'auth/read-delegation/read-delegation.contract.ts']) {
      const source = read(path);
      const imports = [...source.matchAll(/^(?:import|export)[^;]*?from '([^']+)'/gm)].map((m) => m[1]!);
      expect({ path, imports: imports.filter((id) => id.startsWith('@aws-sdk/') || id.includes('/meri/') || id.startsWith('@capiro/meriv2')) })
        .toEqual({ path, imports: [] });
    }
  });

  it('never admits the capability on another path: that request stays on Clerk verification', async () => {
    configure();
    const f = fixture(`Bearer ${token()}`, { path: '/api/clio/tools/update_task' });
    await expect(f.middleware.use(f.req, f.res, f.next)).rejects.toThrow();
    expect(f.verify).toHaveBeenCalled();
    expect(meriExecutionRequestOf(f.req)).toBeUndefined();
  });
});
