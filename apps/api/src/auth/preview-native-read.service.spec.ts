import { EventEmitter } from 'node:events';
import { describe, expect, it } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import type { Request, Response } from 'express';
import type { ApplicationMembershipReceipt } from './application-membership.js';
import { PreviewNativeReadService } from './preview-native-read.service.js';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const actorId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const firstClient = '11111111-1111-4111-8111-111111111111';
const secondClient = '22222222-2222-4222-8222-222222222222';
const previewHost = 'first-chat-preview.app-dev.capiro.ai';
const rosterHost = 'core-roster-preview.capiro.ai';

const ctx = {
  tenantId, userId: actorId, tenantSlug: 'preview-test', clerkUserId: 'user_preview_test', role: 'standard_user',
} as TenantContext;

function receipt(overrides: Partial<ApplicationMembershipReceipt> = {}): ApplicationMembershipReceipt {
  return {
    tenantId, actorId, role: 'standard_user', status: 'active', permissions: [],
    clientIds: [firstClient, secondClient], membershipRevision: 'a'.repeat(64),
    checkedAtMs: Date.now(), expiresAtMs: Date.now() + 60_000,
    ...overrides,
  };
}

function fixture(options: {
  host?: string;
  enabled?: boolean;
  rosterEnabled?: boolean;
  method?: string;
  target?: string;
  reads?: ApplicationMembershipReceipt[];
} = {}) {
  const headers = new Map<string, string>();
  const host = options.host ?? previewHost;
  const target = options.target ?? '/api/clients';
  const request = Object.assign(new EventEmitter(), {
    method: options.method ?? 'GET', path: target.split('?')[0],
    originalUrl: target, url: target,
    headers: { host }, rawHeaders: ['Host', host],
    aborted: false,
  }) as unknown as Request;
  const response = Object.assign(new EventEmitter(), {
    destroyed: false, writableFinished: false,
    setHeader(name: string, value: string) { headers.set(name.toLowerCase(), value); },
    getHeader(name: string) { return headers.get(name.toLowerCase()); },
  }) as unknown as Response;
  const calls: Array<{ request: Request; selected: TenantContext; deadlineMs: number }> = [];
  const reads = options.reads ?? [receipt(), receipt()];
  const membership = {
    async read(selectedRequest: Request, selected: TenantContext, control: { deadlineMs: number; assertActive(): void }) {
      control.assertActive();
      calls.push({ request: selectedRequest, selected, deadlineMs: control.deadlineMs });
      const next = reads[calls.length - 1];
      if (!next) throw new Error('Unexpected extra membership read');
      return next;
    },
  };
  const config = { get(key: string) {
    if (key === 'PREVIEW_NATIVE_GETS_ENABLED') return options.enabled ?? true;
    if (key === 'CORE_ROSTER_PREVIEW_ENABLED') return options.rosterEnabled ?? false;
    throw new Error(`Unexpected config ${key}`);
  } };
  const service = new PreviewNativeReadService(config as never, membership as never);
  return { service, request, response, calls, headers };
}

const postReadChanges: Array<[Partial<ApplicationMembershipReceipt>, number]> = [
  [{ membershipRevision: 'b'.repeat(64) }, 409],
  [{ role: 'user_admin' }, 403],
  [{ clientIds: [firstClient] }, 409],
  [{ clientIds: [secondClient, firstClient] }, 409],
  [{ tenantId: secondClient }, 403],
  [{ actorId: secondClient }, 403],
  [{ status: 'inactive' as ApplicationMembershipReceipt['status'] }, 403],
];

describe('Preview native GET read gate', () => {
  it('enables only the exact configured preview Host and sets no-store before reading', async () => {
    const h = fixture();
    expect(h.service.mode(h.request, h.response)).toBe(true);
    const value = { id: firstClient };
    let observed: readonly string[] | undefined;
    const result = await h.service.run(h.request, h.response, ctx, async (ids) => {
      expect(h.headers.get('cache-control')).toBe('no-store');
      observed = ids;
      return value;
    });
    expect(result).toBe(value);
    expect(observed).toEqual([firstClient, secondClient]);
    expect(h.calls).toHaveLength(2);
    for (const call of h.calls) {
      expect(call.request).toBe(h.request);
      expect(call.selected).toBe(ctx);
      expect(call.deadlineMs).toBeGreaterThan(Date.now());
    }
    expect(h.request.listenerCount('aborted')).toBe(0);
    expect(h.response.listenerCount('close')).toBe(0);
  });

  it('refuses the preview Host when the task-specific setting is off', async () => {
    const h = fixture({ enabled: false });
    expect(() => h.service.mode(h.request, h.response)).toThrow();
    expect(h.headers.get('cache-control')).toBe('no-store');
    await expect(h.service.run(h.request, h.response, ctx, async () => 'unreachable')).rejects.toMatchObject({ status: 503 });
    expect(h.calls).toEqual([]);
  });

  it('runs the exact roster Host through the same two current membership reads', async () => {
    const h = fixture({ host: rosterHost, rosterEnabled: true });
    await expect(h.service.run(h.request, h.response, ctx, async (ids) => ids))
      .resolves.toEqual([firstClient, secondClient]);
    expect(h.calls).toHaveLength(2);
    expect(h.headers.get('cache-control')).toBe('no-store');
  });

  it('does not release a roster result after the membership revision changes', async () => {
    const h = fixture({ host: rosterHost, rosterEnabled: true,
      reads: [receipt(), receipt({ membershipRevision: 'b'.repeat(64) })] });
    await expect(h.service.run(h.request, h.response, ctx, async () => [firstClient]))
      .rejects.toMatchObject({ status: 409 });
    expect(h.calls).toHaveLength(2);
  });

  it('holds roster reads when either setting is off or the target is not the list GET', () => {
    for (const options of [
      { rosterEnabled: false, enabled: true },
      { rosterEnabled: true, enabled: false },
      { rosterEnabled: true, enabled: true, method: 'HEAD' },
      { rosterEnabled: true, enabled: true, target: '/api/clients/client-id' },
    ]) {
      const h = fixture({ host: rosterHost, ...options });
      expect(() => h.service.mode(h.request, h.response)).toThrow();
      expect(h.calls).toHaveLength(0);
      expect(h.headers.get('cache-control')).toBe('no-store');
    }
  });

  it.each([previewHost.toUpperCase(), `${previewHost}:443`, 'app.capiro.ai', 'localhost'])
  ('never enables a configured preview task under a different raw Host (%s)', (host) => {
    const h = fixture({ host });
    if (host.toLowerCase() === previewHost) {
      expect(h.service.mode(h.request, h.response)).toBe(true);
    } else {
      expect(() => h.service.mode(h.request, h.response)).toThrow();
      expect(h.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('ignores proxy forwarded Host and leaves ordinary hosts in ordinary mode when disabled', () => {
    const h = fixture({ host: 'app.capiro.ai', enabled: false });
    (h.request.headers as Record<string, string>)['x-forwarded-host'] = previewHost;
    expect(h.service.mode(h.request, h.response)).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it.each(postReadChanges)('refuses a changed post-read native receipt %#', async (change, expectedStatus) => {
    const h = fixture({ reads: [receipt(), receipt(change)] });
    let operationCalls = 0;
    await expect(h.service.run(h.request, h.response, ctx, async () => {
      operationCalls++;
      return { id: firstClient };
    })).rejects.toMatchObject({ status: expectedStatus });
    expect(operationCalls).toBe(1);
    expect(h.calls).toHaveLength(2);
    expect(h.headers.get('cache-control')).toBe('no-store');
  });

  it.each([
    { expiresAtMs: Date.now() - 1 },
    { tenantId: secondClient },
    { actorId: secondClient },
    { role: 'user_admin' as const },
  ])('refuses an invalid initial native receipt before application data I/O %#', async (change) => {
    const h = fixture({ reads: [receipt(change)] });
    let operationCalls = 0;
    await expect(h.service.run(h.request, h.response, ctx, async () => {
      operationCalls++;
      return 'unreachable';
    })).rejects.toMatchObject({ status: 403 });
    expect(operationCalls).toBe(0);
    expect(h.calls).toHaveLength(1);
  });

  it('refuses an expired post-read receipt instead of releasing the loaded result', async () => {
    const h = fixture({ reads: [receipt(), receipt({ expiresAtMs: Date.now() - 1 })] });
    await expect(h.service.run(h.request, h.response, ctx, async () => ({ id: firstClient })))
      .rejects.toMatchObject({ status: 403 });
    expect(h.calls).toHaveLength(2);
  });

  it('propagates native membership refusal without running the application read', async () => {
    const h = fixture({ reads: [] });
    let operationCalls = 0;
    await expect(h.service.run(h.request, h.response, ctx, async () => {
      operationCalls++;
      return 'unreachable';
    })).rejects.toThrow('Unexpected extra membership read');
    expect(operationCalls).toBe(0);
  });

  it('refuses a cancelled request during application I/O and skips the second native read', async () => {
    const h = fixture({ reads: [receipt()] });
    await expect(h.service.run(h.request, h.response, ctx, async () => {
      h.request.emit('aborted');
      return { id: firstClient };
    })).rejects.toMatchObject({ status: 408 });
    expect(h.calls).toHaveLength(1);
    expect(h.request.listenerCount('aborted')).toBe(0);
    expect(h.response.listenerCount('close')).toBe(0);
  });
});
