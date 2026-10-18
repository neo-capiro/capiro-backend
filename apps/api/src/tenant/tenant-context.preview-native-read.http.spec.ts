import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { ClerkService } from '../auth/clerk.service.js';
import { coreRosterPreviewHttpGate } from '../auth/core-roster-preview-http-gate.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { TenantContextMiddleware } from './tenant-context.middleware.js';
import { TenantContextStore } from './tenant-context.store.js';

jest.mock('@clerk/backend', () => ({
  __esModule: true,
  createClerkClient: () => ({}),
  verifyToken: async () => ({}),
}));

const previewHost = 'first-chat-preview.app-dev.capiro.ai';
const rosterHost = 'core-roster-preview.capiro.ai';
const priorPreviewSetting = process.env.PREVIEW_NATIVE_GETS_ENABLED;
const priorRosterSetting = process.env.CORE_ROSTER_PREVIEW_ENABLED;
const user = { id: 'actor_preview', clerkUserId: 'clerk_preview_actor' };
const tenant = { id: 'tenant_preview', clerkOrgId: 'org_preview', slug: 'preview', status: 'active' };
const membership = {
  id: 'member_preview', userId: user.id, tenantId: tenant.id,
  role: 'standard_user', status: 'active', tenant,
};

function fixture() {
  const tx: any = {
    user: {
      findUnique: jest.fn(async () => user), findFirst: jest.fn(),
      create: jest.fn(), update: jest.fn(), upsert: jest.fn(), delete: jest.fn(),
    },
    tenantMembership: {
      findMany: jest.fn(async () => [membership]), findUnique: jest.fn(), findFirst: jest.fn(),
      create: jest.fn(), update: jest.fn(), upsert: jest.fn(), delete: jest.fn(),
    },
    tenant: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    auditLog: { create: jest.fn() },
    impersonationSession: { findFirst: jest.fn() },
  };
  const mutations = [
    tx.user.create, tx.user.update, tx.user.upsert, tx.user.delete,
    tx.tenantMembership.create, tx.tenantMembership.update,
    tx.tenantMembership.upsert, tx.tenantMembership.delete,
    tx.tenant.create, tx.tenant.update, tx.auditLog.create,
  ];
  const verifySessionToken = jest.fn(async (token: string) => ({
    sub: user.clerkUserId, iss: 'https://clerk.app.capiro.ai',
    sid: token === 'sidless-token' || token === 'marked-control' ? undefined : 'sess_preview',
    exp: Math.floor(Date.now() / 1000) + 1800,
    ...(token === 'marked-control' || token === 'marked-with-sid'
      ? { meri_control_credential: true, iat: Math.floor(Date.now() / 1000) - 60,
        jti: 'control_preview' } : {}),
    org_id: tenant.clerkOrgId,
    capiro_tenant_id: tenant.id, capiro_tenant_slug: tenant.slug,
  }));
  const assertActiveApplicationAuthoritySession = jest.fn(async () => ({ id: 'session_preview' }));
  const clerk = { verifySessionToken, assertActiveApplicationAuthoritySession } as unknown as ClerkService;
  const withSystem = jest.fn(async (fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx));
  const prisma = { withSystem } as unknown as PrismaService;
  const middleware = new TenantContextMiddleware(clerk, prisma, new TenantContextStore());
  const app = express();
  app.use(coreRosterPreviewHttpGate(
    process.env.CORE_ROSTER_PREVIEW_ENABLED === 'true',
    process.env.PREVIEW_NATIVE_GETS_ENABLED === 'true',
  ));
  const excludedReached = jest.fn();
  app.get('/health', (_req, res) => { excludedReached(); res.status(200).end(); });
  app.post('/webhooks/clerk', (_req, res) => { excludedReached(); res.status(200).end(); });
  app.use((req, res, next) => { void middleware.use(req, res, next).catch(next); });
  const reached = jest.fn();
  const reply = (req: express.Request, res: express.Response) => {
    reached(req.method, req.path);
    const ctx = (req as express.Request & { tenantContext?: { userId: string } }).tenantContext;
    res.status(200).json({ actorId: ctx?.userId });
  };
  app.get('/api/me', reply);
  app.get('/api/clients', reply);
  app.get('/api/clients/:id', reply);
  app.get('/api/memory/candidates/mine', reply);
  app.get('/api/memory/candidates/mine/:id/status', reply);
  app.get('/api/memory/owner/items', reply);
  app.use((error: { getStatus?: () => number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.getStatus?.() ?? 500).end();
  });
  return { app, reached, excludedReached, verifySessionToken, assertActiveApplicationAuthoritySession, withSystem, mutations };
}

async function send(server: Server, method: string, target: string, host = previewHost,
  bearer = 'native-session') {
  const address = server.address() as AddressInfo;
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: address.port, method, path: target,
      headers: { Host: host, Authorization: `Bearer ${bearer}` } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function start(app: express.Express): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

describe('preview native reads through real Node HTTP and Express routing', () => {
  afterEach(() => {
    if (priorPreviewSetting === undefined) delete process.env.PREVIEW_NATIVE_GETS_ENABLED;
    else process.env.PREVIEW_NATIVE_GETS_ENABLED = priorPreviewSetting;
    if (priorRosterSetting === undefined) delete process.env.CORE_ROSTER_PREVIEW_ENABLED;
    else process.env.CORE_ROSTER_PREVIEW_ENABLED = priorRosterSetting;
  });

  it('routes all six GETs and HEAD through online native authority without a local write', async () => {
    process.env.PREVIEW_NATIVE_GETS_ENABLED = 'true';
    const h = fixture();
    const server = await start(h.app);
    try {
      for (const [method, target] of ([
        ['GET', '/api/me'], ['GET', '/api/clients?includeArchived=false'],
        ['GET', '/api/clients/11111111-1111-4111-8111-111111111111'], ['HEAD', '/api/me'],
        ['GET', '/api/memory/candidates/mine?limit=25'],
        ['GET', '/api/memory/candidates/mine/11111111-1111-4111-8111-111111111111/status'],
        ['GET', '/api/memory/owner/items?limit=25'],
        ['HEAD', `http://${previewHost}/api/me`],
      ] as const)) {
        const result = await send(server, method, target);
        expect(result.status).toBe(200);
        expect(result.headers['cache-control']).toBe('no-store');
      }
      expect(h.reached).toHaveBeenCalledTimes(8);
      expect(h.verifySessionToken).toHaveBeenCalledTimes(8);
      expect(h.assertActiveApplicationAuthoritySession).toHaveBeenCalledTimes(8);
      for (const mutation of h.mutations) expect(mutation).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15000);

  it('refuses sidless and marked control credentials on GET, HEAD and absolute-form targets before DB', async () => {
    process.env.PREVIEW_NATIVE_GETS_ENABLED = 'true';
    const h = fixture();
    const server = await start(h.app);
    try {
      for (const bearer of ['sidless-token', 'marked-control', 'marked-with-sid']) {
        for (const [method, target] of ([
          ['GET', '/api/me'], ['HEAD', '/api/clients'],
          ['GET', '/api/memory/candidates/mine'], ['HEAD', '/api/memory/owner/items'],
          ['GET', `http://${previewHost}/api/me`], ['HEAD', `http://${previewHost}/api/me`],
        ] as const)) {
          const result = await send(server, method, target, previewHost, bearer);
          expect(result.status).toBe(401);
          expect(result.headers['cache-control']).toBe('no-store');
        }
      }
      expect(h.reached).not.toHaveBeenCalled();
      expect(h.withSystem).not.toHaveBeenCalled();
      for (const mutation of h.mutations) expect(mutation).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15000);

  it('does not let an absolute-form preview GET pass through the ordinary write path', async () => {
    process.env.PREVIEW_NATIVE_GETS_ENABLED = 'true';
    const h = fixture();
    const server = await start(h.app);
    try {
      const result = await send(server, 'GET', `http://${previewHost}/api/me`);
      expect(result.status).toBe(200);
      expect(h.assertActiveApplicationAuthoritySession).toHaveBeenCalledTimes(1);
      expect(result.headers['cache-control']).toBe('no-store');
      for (const mutation of h.mutations) expect(mutation).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15000);

  it('denies a preview Host/flag mismatch before Clerk or database access', async () => {
    process.env.PREVIEW_NATIVE_GETS_ENABLED = 'false';
    const h = fixture();
    const server = await start(h.app);
    try {
      const result = await send(server, 'GET', '/api/me');
      expect(result.status).toBe(503);
      expect(result.headers['cache-control']).toBe('no-store');
      expect(h.reached).not.toHaveBeenCalled();
      expect(h.verifySessionToken).not.toHaveBeenCalled();
      expect(h.withSystem).not.toHaveBeenCalled();
      for (const mutation of h.mutations) expect(mutation).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15000);

  it('routes the exact roster GET through live native membership without ordinary writes', async () => {
    process.env.PREVIEW_NATIVE_GETS_ENABLED = 'true';
    process.env.CORE_ROSTER_PREVIEW_ENABLED = 'true';
    const h = fixture();
    const server = await start(h.app);
    try {
      const result = await send(server, 'GET',
        '/api/clients?profileStatus=ACTIVE&sectorTag=defense&includeArchived=false', rosterHost);
      expect(result.status).toBe(200);
      expect(result.headers['cache-control']).toBe('no-store');
      expect(h.reached).toHaveBeenCalledWith('GET', '/api/clients');
      expect(h.verifySessionToken).toHaveBeenCalledTimes(1);
      expect(h.assertActiveApplicationAuthoritySession).toHaveBeenCalledTimes(1);
      expect(h.withSystem).toHaveBeenCalledTimes(1);
      for (const mutation of h.mutations) expect(mutation).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15000);

  it('keeps first-chat HEAD and absolute-form native reads on the composed task', async () => {
    process.env.PREVIEW_NATIVE_GETS_ENABLED = 'true';
    process.env.CORE_ROSTER_PREVIEW_ENABLED = 'true';
    const h = fixture();
    const server = await start(h.app);
    try {
      for (const [method, target] of ([
        ['HEAD', '/api/me'],
        ['GET', `http://${previewHost}/api/memory/owner/items`],
      ] as const)) {
        const result = await send(server, method, target, previewHost);
        expect(result.status).toBe(200);
        expect(result.headers['cache-control']).toBe('no-store');
      }
      expect(h.assertActiveApplicationAuthoritySession).toHaveBeenCalledTimes(2);
      for (const mutation of h.mutations) expect(mutation).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15000);

  it('blocks roster Host methods, other paths and excluded handlers before Clerk or DB', async () => {
    process.env.PREVIEW_NATIVE_GETS_ENABLED = 'true';
    process.env.CORE_ROSTER_PREVIEW_ENABLED = 'true';
    const h = fixture();
    const server = await start(h.app);
    try {
      for (const [method, target] of ([
        ['HEAD', '/api/clients'], ['POST', '/api/clients'],
        ['GET', '/api/clients/client-id'], ['GET', '/api/me'],
        ['GET', '/api/memory/owner/items'], ['GET', '/health'],
        ['POST', '/webhooks/clerk'], ['GET', `http://${rosterHost}/api/clients`],
      ] as const)) {
        const result = await send(server, method, target, rosterHost);
        expect(result.status).toBe(404);
        expect(result.headers['cache-control']).toBe('no-store');
      }
      expect(h.reached).not.toHaveBeenCalled();
      expect(h.excludedReached).not.toHaveBeenCalled();
      expect(h.verifySessionToken).not.toHaveBeenCalled();
      expect(h.withSystem).not.toHaveBeenCalled();
      for (const mutation of h.mutations) expect(mutation).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15000);

  it('holds the exact roster Host when its flag is off, without ordinary fallback', async () => {
    process.env.PREVIEW_NATIVE_GETS_ENABLED = 'true';
    process.env.CORE_ROSTER_PREVIEW_ENABLED = 'false';
    const h = fixture();
    const server = await start(h.app);
    try {
      const result = await send(server, 'GET', '/api/clients', rosterHost);
      expect(result.status).toBe(503);
      expect(result.headers['cache-control']).toBe('no-store');
      expect(h.reached).not.toHaveBeenCalled();
      expect(h.verifySessionToken).not.toHaveBeenCalled();
      expect(h.withSystem).not.toHaveBeenCalled();
      for (const mutation of h.mutations) expect(mutation).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15000);

  it('denies a roster absolute-form target with an ordinary Host before tenant writes', async () => {
    process.env.PREVIEW_NATIVE_GETS_ENABLED = 'true';
    process.env.CORE_ROSTER_PREVIEW_ENABLED = 'true';
    const h = fixture();
    const server = await start(h.app);
    try {
      const result = await send(server, 'GET', `http://${rosterHost}/api/clients`,
        'portfolio-preview.app.capiro.ai');
      expect(result.status).toBe(404);
      expect(result.headers['cache-control']).toBe('no-store');
      expect(h.reached).not.toHaveBeenCalled();
      expect(h.verifySessionToken).not.toHaveBeenCalled();
      expect(h.withSystem).not.toHaveBeenCalled();
      for (const mutation of h.mutations) expect(mutation).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15000);
});
