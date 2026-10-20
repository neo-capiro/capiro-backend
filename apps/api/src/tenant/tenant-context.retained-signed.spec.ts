import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ClerkService } from '../auth/clerk.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { TenantContextMiddleware } from './tenant-context.middleware.js';
import type { TenantContextStore } from './tenant-context.store.js';

jest.mock('@clerk/backend', () => ({
  __esModule: true,
  createClerkClient: () => ({}),
  verifyToken: async () => ({}),
}));

const SIGNED = 'eyJzY2hlbWFWZXJzaW9uIjoxfQ';

function fixture(method: string, path: string, authorization: string | undefined, originalUrl = path) {
  const verify = jest.fn(async () => { throw new Error('Clerk must not be reached in this fixture'); });
  const clerk = { verifySessionToken: verify } as unknown as ClerkService;
  const system = jest.fn(async () => { throw new Error('no database access before admission'); });
  const prisma = { withSystem: system } as unknown as PrismaService;
  const run = jest.fn((_ctx: unknown, continuation: () => void) => continuation());
  const store = { run } as unknown as TenantContextStore;
  const middleware = new TenantContextMiddleware(clerk, prisma, store);
  const req = {
    method, path, originalUrl, url: originalUrl, baseUrl: '', hostname: 'core.example.invalid',
    headers: { ...(authorization === undefined ? {} : { authorization }), host: 'core.example.invalid' },
    header: jest.fn(() => undefined),
  } as unknown as Request & { tenantContext?: unknown };
  const headers = new Map<string, string>();
  const res = { setHeader: (name: string, value: string) => { headers.set(name.toLowerCase(), value); } } as unknown as Response;
  const next = jest.fn();
  return { middleware, req, res, next, verify, system, run, headers };
}

const DATA_PATH = '/api/clio/retained-reads/research-portfolio';
const NATIVE_CURRENT_PATH = '/api/clio/application-authority/retained-florida-native-current';
const ADMITTED: Array<[string, string]> = [
  ['/api/clio/retained-reads/research-portfolio', 'CapiroRetained'],
  ['/api/clio/retained-reads/research-portfolio-changes', 'CapiroRetained'],
  ['/api/clio/application-authority/retained-florida-current', 'CapiroRetained'],
  ['/api/clio/application-authority/retained-florida-native-current', 'CapiroRetainedAuthority'],
];

describe('exact signed retained-read admission in the tenant middleware', () => {
  const previous = process.env.RETAINED_READS_ENABLED;
  beforeEach(() => { process.env.RETAINED_READS_ENABLED = 'true'; });
  afterEach(() => {
    if (previous === undefined) delete process.env.RETAINED_READS_ENABLED;
    else process.env.RETAINED_READS_ENABLED = previous;
  });

  it.each(ADMITTED)('admits POST %s with %s without Clerk, DB or tenant context', async (path, scheme) => {
    const f = fixture('POST', path, `${scheme} ${SIGNED}`);
    await f.middleware.use(f.req, f.res, f.next);
    expect(f.next).toHaveBeenCalledTimes(1);
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.system).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.req.tenantContext).toBeUndefined();
    expect(f.headers.get('cache-control')).toBe('no-store');
  });

  it.each([
    ['disabled', 'POST', DATA_PATH, `CapiroRetained ${SIGNED}`, undefined, 'false'],
    ['GET', 'GET', DATA_PATH, `CapiroRetained ${SIGNED}`, undefined, 'true'],
    ['wrong scheme for data', 'POST', DATA_PATH, `CapiroRetainedAuthority ${SIGNED}`, undefined, 'true'],
    ['wrong scheme for native-current', 'POST', NATIVE_CURRENT_PATH, `CapiroRetained ${SIGNED}`, undefined, 'true'],
    ['scheme case variant', 'POST', DATA_PATH, `capiroretained ${SIGNED}`, undefined, 'true'],
    ['empty credential', 'POST', DATA_PATH, 'CapiroRetained ', undefined, 'true'],
    ['extra token', 'POST', DATA_PATH, `CapiroRetained ${SIGNED} extra`, undefined, 'true'],
    ['issuer route is native-only', 'POST', '/api/clio/application-authority/retained-research-portfolio-principal', `CapiroRetained ${SIGNED}`, undefined, 'true'],
    ['unlisted path', 'POST', '/api/clio/retained-reads/other', `CapiroRetained ${SIGNED}`, undefined, 'true'],
    ['trailing slash', 'POST', `${DATA_PATH}/`, `CapiroRetained ${SIGNED}`, undefined, 'true'],
    ['rewritten target', 'POST', DATA_PATH, `CapiroRetained ${SIGNED}`, '/api/clio/tools/search_federal_grants', 'true'],
  ] as Array<[string, string, string, string, string | undefined, string]>)(
    'does not admit %s; the request stays on the Bearer path', async (_label, method, path, authorization, originalUrl, enabled) => {
    process.env.RETAINED_READS_ENABLED = enabled;
    const f = fixture(method, path, authorization, originalUrl ?? path);
    await expect(f.middleware.use(f.req, f.res, f.next)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(f.next).not.toHaveBeenCalled();
    expect(f.verify).not.toHaveBeenCalled();
    expect(f.system).not.toHaveBeenCalled();
  });

  it('leaves Bearer requests on the signed paths to the ordinary Clerk verification', async () => {
    const f = fixture('POST', DATA_PATH, 'Bearer native-token');
    await expect(f.middleware.use(f.req, f.res, f.next)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(f.verify).toHaveBeenCalledTimes(1);
    expect(f.next).not.toHaveBeenCalled();
  });
});
