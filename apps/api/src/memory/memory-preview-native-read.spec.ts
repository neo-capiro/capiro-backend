import { EventEmitter } from 'node:events';
import { describe, expect, it, jest } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import type { Request, Response } from 'express';
import type { ApplicationMembershipReceipt } from '../auth/application-membership.js';
import { PreviewNativeReadService } from '../auth/preview-native-read.service.js';
import { MemoryController } from './memory.controller.js';
import { MemoryOwnerItemsController } from './memory-owner-items.controller.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const clientId = '33333333-3333-4333-8333-333333333333';
const candidateId = '44444444-4444-4444-8444-444444444444';
const ctx = {
  tenantId, userId: actorId, tenantSlug: 'test', clerkUserId: 'clerk_actor', role: 'standard_user',
} as TenantContext;

function receipt(change: Partial<ApplicationMembershipReceipt> = {}): ApplicationMembershipReceipt {
  return {
    tenantId, actorId, role: 'standard_user', status: 'active', permissions: [],
    clientIds: [clientId], membershipRevision: 'a'.repeat(64),
    checkedAtMs: Date.now(), expiresAtMs: Date.now() + 60_000,
    ...change,
  };
}

function fixture(options: {
  host?: string;
  enabled?: boolean;
  reads?: ApplicationMembershipReceipt[];
} = {}) {
  const headers = new Map<string, string>();
  const req = Object.assign(new EventEmitter(), {
    headers: { host: options.host ?? 'first-chat-preview.app-dev.capiro.ai' }, aborted: false,
  }) as unknown as Request;
  const res = Object.assign(new EventEmitter(), {
    destroyed: false, writableFinished: false,
    setHeader(name: string, value: string) { headers.set(name.toLowerCase(), value); },
  }) as unknown as Response;
  const reads = options.reads ?? Array.from({ length: 6 }, () => receipt());
  const read = jest.fn(async () => {
    const value = reads[read.mock.calls.length - 1];
    if (!value) throw new Error('Unexpected membership read');
    return value;
  });
  const preview = new PreviewNativeReadService(
    { get: () => options.enabled ?? true } as never,
    { read } as never,
  );
  const page = jest.fn(async () => ({ version: 1, candidates: [], nextCursor: null }));
  const status = jest.fn(async () => ({ version: 1, id: candidateId, status: 'pending', terminal: false }));
  const list = jest.fn(async () => ({ schemaVersion: 1, items: [], nextCursor: null }));
  const controller = new MemoryController(
    {} as never, {} as never, {} as never, {} as never,
    { pageOwnPersonalPending: page, ownPersonalCandidateStatus: status } as never,
    {} as never, {} as never, {} as never, {} as never, {} as never, preview,
  );
  const history = { list: jest.fn(async () => { throw new Error('Unexpected memory history read'); }) };
  const evidence = { list: jest.fn(async () => { throw new Error('Unexpected memory evidence read'); }) };
  const owner = new MemoryOwnerItemsController({ list } as never, history as never, evidence as never, preview);
  return { req, res, headers, read, page, status, list, controller, owner };
}

describe('preview native memory GET controller gates', () => {
  it('rechecks native membership around each read and binds the client roster', async () => {
    const h = fixture();
    await expect(h.controller.listOwnCandidates(ctx, h.req, h.res, '25', 'cursor'))
      .resolves.toMatchObject({ version: 1 });
    await expect(h.controller.ownCandidateStatus(ctx, candidateId, h.req, h.res))
      .resolves.toMatchObject({ id: candidateId });
    await expect(h.owner.list(ctx, h.req, h.res, 'cursor', '25'))
      .resolves.toMatchObject({ schemaVersion: 1 });
    expect(h.page).toHaveBeenCalledWith(ctx, { limit: '25', cursor: 'cursor', visibleClientIds: [clientId] });
    expect(h.status).toHaveBeenCalledWith(ctx, candidateId, [clientId]);
    expect(h.list).toHaveBeenCalledWith(ctx, { cursor: 'cursor', limit: '25', visibleClientIds: [clientId] });
    expect(h.read).toHaveBeenCalledTimes(6);
    expect(h.headers.get('cache-control')).toBe('no-store');
  });

  it.each([
    { host: 'first-chat-preview.app-dev.capiro.ai', enabled: false },
    { host: 'app.capiro.ai', enabled: true },
  ])('refuses a Host/flag mismatch before any memory read (%#)', async (options) => {
    const h = fixture(options);
    await expect(h.controller.listOwnCandidates(ctx, h.req, h.res)).rejects.toMatchObject({ status: 503 });
    await expect(h.controller.ownCandidateStatus(ctx, candidateId, h.req, h.res)).rejects.toMatchObject({ status: 503 });
    expect(() => h.owner.list(ctx, h.req, h.res)).toThrow('Preview reads unavailable');
    expect(h.read).not.toHaveBeenCalled();
    expect(h.page).not.toHaveBeenCalled();
    expect(h.status).not.toHaveBeenCalled();
    expect(h.list).not.toHaveBeenCalled();
    expect(h.headers.get('cache-control')).toBe('no-store');
  });

  it('withholds a loaded candidate page when membership changes during the read', async () => {
    const h = fixture({ reads: [receipt(), receipt({ membershipRevision: 'b'.repeat(64) })] });
    await expect(h.controller.listOwnCandidates(ctx, h.req, h.res))
      .rejects.toMatchObject({ status: 409 });
    expect(h.page).toHaveBeenCalledTimes(1);
    expect(h.read).toHaveBeenCalledTimes(2);
  });

  it('refuses a revoked initial membership before the owner-item read', async () => {
    const h = fixture({ reads: [receipt({ status: 'inactive' as ApplicationMembershipReceipt['status'] })] });
    await expect(h.owner.list(ctx, h.req, h.res)).rejects.toMatchObject({ status: 403 });
    expect(h.list).not.toHaveBeenCalled();
    expect(h.read).toHaveBeenCalledTimes(1);
  });

  it('preserves ordinary GET delegation without adding a preview roster', async () => {
    const h = fixture({ host: 'app.capiro.ai', enabled: false });
    await h.controller.listOwnCandidates(ctx, h.req, h.res, '25', 'cursor');
    await h.controller.ownCandidateStatus(ctx, candidateId, h.req, h.res);
    await h.owner.list(ctx, h.req, h.res, 'cursor', '25');
    expect(h.page).toHaveBeenCalledWith(ctx, { limit: '25', cursor: 'cursor' });
    expect(h.status).toHaveBeenCalledWith(ctx, candidateId);
    expect(h.list).toHaveBeenCalledWith(ctx, { cursor: 'cursor', limit: '25' });
    expect(h.read).not.toHaveBeenCalled();
  });
});
