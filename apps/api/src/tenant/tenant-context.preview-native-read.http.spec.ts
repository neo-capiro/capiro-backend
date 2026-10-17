import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { ClerkService } from '../auth/clerk.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { TenantContextMiddleware } from './tenant-context.middleware.js';
import { TenantContextStore } from './tenant-context.store.js';

jest.mock('@clerk/backend', () => ({
  __esModule: true,
  createClerkClient: () => ({}),
  verifyToken: async () => ({}),
}));

const previewHost = 'first-chat-preview.app-dev.capiro.ai';
const priorPreviewSetting = process.env.PREVIEW_NATIVE_GETS_ENABLED;
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
  const verifySessionToken = jest.fn(async () => ({
    sub: user.clerkUserId, org_id: tenant.clerkOrgId,
    capiro_tenant_id: tenant.id, capiro_tenant_slug: tenant.slug,
  }));
  const assertActiveApplicationAuthoritySession = jest.fn(async () => ({ id: 'session_preview' }));
  const clerk = { verifySessionToken, assertActiveApplicationAuthoritySession } as unknown as ClerkService;
  const withSystem = jest.fn(async (fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx));
  const prisma = { withSystem } as unknown as PrismaService;
  const middleware = new TenantContextMiddleware(clerk, prisma, new TenantContextStore());
  const app = express();
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
  app.use((error: { getStatus?: () => number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.getStatus?.() ?? 500).end();
  });
  return { app, reached, verifySessionToken, assertActiveApplicationAuthoritySession, withSystem, mutations };
}

async function send(server: Server, method: string, target: string, host = previewHost) {
  const address = server.address() as AddressInfo;
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: address.port, method, path: target,
      headers: { Host: host, Authorization: 'Bearer native-session' } }, (res) => {
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
  });

  it('routes all three GETs and HEAD through online native authority without a local write', async () => {
    process.env.PREVIEW_NATIVE_GETS_ENABLED = 'true';
    const h = fixture();
    const server = await start(h.app);
    try {
      for (const [method, target] of ([
        ['GET', '/api/me'], ['GET', '/api/clients?includeArchived=false'],
        ['GET', '/api/clients/11111111-1111-4111-8111-111111111111'], ['HEAD', '/api/me'],
      ] as const)) {
        const result = await send(server, method, target);
        expect(result.status).toBe(200);
        expect(result.headers['cache-control']).toBe('no-store');
      }
      expect(h.reached).toHaveBeenCalledTimes(4);
      expect(h.verifySessionToken).toHaveBeenCalledTimes(4);
      expect(h.assertActiveApplicationAuthoritySession).toHaveBeenCalledTimes(4);
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
});
