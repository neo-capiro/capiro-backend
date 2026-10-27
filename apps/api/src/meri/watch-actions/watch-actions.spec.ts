/**
 * Focused developer checks for the MO-06 canonical watch slice. No live owner,
 * provider, database or notification path is touched: the two intel-backed owners
 * are reached through a synthetic fetch and the two same-app owners through their
 * real service interfaces with synthetic state.
 */
import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { BizDevWatchService } from '../../business-development/bizdev-watch.service.js';
import { DefenseBudgetClientWatchService } from '../../defense-budget-client-watch/defense-budget-client-watch.service.js';
import { BizdevWatchAdapter } from './bizdev-watch.adapter.js';
import { ClientWatchlistAdapter } from './client-watchlist.adapter.js';
import { DefenseBudgetWatchAdapter } from './defense-budget-watch.adapter.js';
import {
  WATCH_ACTION,
  WATCH_SUPPORTED_OPERATIONS,
  watchBinding,
  watchReceipt,
  watchRequestOf,
  type WatchReceiptPayload,
  type WatchRequest,
} from './watch-action.contract.js';
import { KeywordWatchAdapter } from './keyword-watch.adapter.js';
import { WatchActionRegistry } from './watch-action.registry.js';
// WatchActionService/Controller are NOT imported here on purpose: importing the
// meri proposal/tools graph needs the built `@capiro/shared/workspace-share-lifecycle`
// subpath, which the retained read-only dependency overlay does not have. See
// HANDOFF: the executor/route leaves are reviewed but not executed in this overlay.

const TENANT = '11111111-1111-4111-8111-111111111111',
  CLIENT = '22222222-2222-4222-8222-222222222222',
  PROSPECT = '33333333-3333-4333-8333-333333333333',
  ctx = {
    tenantId: TENANT,
    tenantSlug: 'tenant',
    userId: 'user-1',
    clerkUserId: 'clerk-1',
    role: 'standard_user',
  } as unknown as TenantContext;

interface Call {
  url: string;
  payload: Record<string, never>;
}

function intelOwner(respond: (payload: any) => { status?: number; body?: unknown }) {
  const calls: Call[] = [];
  (globalThis as unknown as { fetch: unknown }).fetch = async (
    url: string,
    init: { body: string },
  ) => {
    const payload = JSON.parse(init.body);
    calls.push({ url, payload });
    const result = respond(payload),
      status = result.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      redirected: false,
      json: async () => result.body,
    } as unknown as Response;
  };
  return calls;
}

function request(over: Partial<WatchRequest>): WatchRequest {
  return watchRequestOf({
    family: 'legiwatch_keyword',
    clientId: null,
    targetKind: 'keyword_rule',
    targetKey: 'rule-1',
    operation: 'pause',
    expectedVersion: 4,
    sourceRevision: null,
    reason: null,
    enabled: null,
    requestKey: 'meri-watch-0123456789ab',
    ...over,
  });
}

beforeAll(() => {
  process.env.INTERNAL_SERVICE_SECRET = 'synthetic-service-secret';
  process.env.TRACKER_APP_BASE_URL = 'https://app.invalid';
});

describe('MO-06 watch capability matrix', () => {
  it('advertises only the effects each canonical owner actually has', () => {
    expect(WATCH_SUPPORTED_OPERATIONS.legiwatch_keyword).toEqual([
      'subscribe',
      'pause',
      'resume',
      'unsubscribe',
      'set_delivery',
    ]);
    // The defense-budget owner has no paused state and the tracker watchlist has no
    // delete: neither may be advertised as supported.
    expect(WATCH_SUPPORTED_OPERATIONS.defense_budget_target).not.toContain('pause');
    expect(WATCH_SUPPORTED_OPERATIONS.client_watchlist).not.toContain('unsubscribe');
    expect(WATCH_SUPPORTED_OPERATIONS.client_watchlist).not.toContain('resume');
    expect(() =>
      request({ family: 'defense_budget_target', targetKind: 'pe', operation: 'pause' }),
    ).toThrow(BadRequestException);
    expect(() =>
      request({
        family: 'client_watchlist',
        targetKind: 'client_tracker_watchlist',
        operation: 'unsubscribe',
      }),
    ).toThrow(BadRequestException);
    expect(() => request({ targetKind: 'hearing_watchlist' })).toThrow(BadRequestException);
  });
});

describe('LegiWatch keyword family leaf', () => {
  const adapter = new KeywordWatchAdapter();

  it('inspects through the owner read path only, and maps the owner state exactly', async () => {
    const calls = intelOwner(() => ({
      body: {
        version: 1,
        target: {
          identity: 'rule-1',
          state: 'paused',
          version: 4,
          deliveryEnabled: false,
          clientId: null,
          facts: { folderCount: 2, activationVersion: 3 },
        },
      },
    }));
    const state = await adapter.inspect(ctx, {
      family: 'legiwatch_keyword',
      clientId: null,
      targetKind: 'keyword_rule',
      targetKey: 'rule-1',
    });
    expect(state).toMatchObject({
      identity: 'rule-1',
      state: 'paused',
      version: 4,
      deliveryEnabled: false,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.payload).toMatchObject({ tool: 'watch_inspect', family: 'legiwatch_keyword' });
  });

  it('refuses activation without the owner preview run, before any owner call', async () => {
    const calls = intelOwner(() => ({ body: {} }));
    await expect(
      adapter.apply(
        ctx,
        {
          ...request({ operation: 'subscribe', expectedVersion: 1, sourceRevision: 'preview' }),
          sourceRevision: null,
        },
        {
          actionProposalId: 'proposal-1',
        },
      ),
    ).rejects.toThrow(BadRequestException);
    expect(calls).toHaveLength(0);
  });

  it('refuses a delivery switch without an explicit value', async () => {
    const calls = intelOwner(() => ({ body: {} }));
    await expect(
      adapter.apply(
        ctx,
        { ...request({ operation: 'set_delivery', enabled: true }), enabled: null },
        {
          actionProposalId: 'proposal-1',
        },
      ),
    ).rejects.toThrow(BadRequestException);
    expect(calls).toHaveLength(0);
  });

  it('binds a confirmed owner acknowledgement to this exact target and verb', async () => {
    intelOwner(() => ({
      body: {
        version: 1,
        applied: true,
        partial: false,
        acknowledgement: {
          identity: 'rule-1',
          state: 'active',
          version: 5,
          deliveryEnabled: false,
          eventId: null,
          alreadyInState: false,
        },
      },
    }));
    const input = request({ operation: 'pause' });
    const effect = await adapter.apply(ctx, input, { actionProposalId: 'proposal-1' });
    expect(effect.receipt).toMatchObject({
      owner: 'legiwatch_keyword',
      operation: 'pause',
      targetKey: 'rule-1',
      version: 5,
      alreadyInState: false,
    });
    expect(effect.receipt?.binding).toBe(watchBinding(input));
    expect(watchReceipt({ tool: WATCH_ACTION, result: effect.receipt }, input).request).toEqual(
      input,
    );
  });

  it('reports a partially applied unsubscribe as UNKNOWN, never as an applied change', async () => {
    intelOwner(() => ({
      body: { version: 1, applied: false, partial: true, acknowledgement: null },
    }));
    const input = request({ operation: 'unsubscribe' });
    const effect = await adapter.apply(ctx, input, { actionProposalId: 'proposal-1' });
    expect(effect.receipt).toBeNull();
    expect(() => watchReceipt({ tool: WATCH_ACTION, result: effect.receipt }, input)).toThrow(
      ServiceUnavailableException,
    );
  });

  it('preserves the exact client wall the owner reported', async () => {
    intelOwner(() => ({
      body: {
        version: 1,
        target: {
          identity: 'rule-1',
          state: 'active',
          version: 1,
          deliveryEnabled: true,
          clientId: null,
          facts: {},
        },
      },
    }));
    await expect(
      adapter.inspect(ctx, {
        family: 'legiwatch_keyword',
        clientId: CLIENT,
        targetKind: 'keyword_rule',
        targetKey: 'rule-1',
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('fails closed instead of inventing a state the owner did not publish', async () => {
    intelOwner(() => ({
      body: {
        version: 1,
        target: {
          identity: 'rule-1',
          state: 'archived',
          version: 1,
          deliveryEnabled: null,
          clientId: null,
          facts: {},
        },
      },
    }));
    await expect(
      adapter.inspect(ctx, {
        family: 'legiwatch_keyword',
        clientId: null,
        targetKind: 'keyword_rule',
        targetKey: 'rule-1',
      }),
    ).rejects.toThrow(ServiceUnavailableException);
  });
});

describe('client watchlist family leaf', () => {
  const adapter = new ClientWatchlistAdapter();

  it('requires the exact client and offers no unsubscribe', async () => {
    expect(adapter.operations).toEqual(['subscribe', 'pause']);
    await expect(
      adapter.inspect(ctx, {
        family: 'client_watchlist',
        clientId: null,
        targetKind: 'client_tracker_watchlist',
        targetKey: CLIENT,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('carries the exact client into the owner call and maps its state', async () => {
    const calls = intelOwner(() => ({
      body: {
        version: 1,
        target: {
          identity: CLIENT,
          state: 'active',
          version: 7,
          deliveryEnabled: true,
          clientId: CLIENT,
          facts: { topics: 3, terms: 9 },
        },
      },
    }));
    const state = await adapter.inspect(ctx, {
      family: 'client_watchlist',
      clientId: CLIENT,
      targetKind: 'client_tracker_watchlist',
      targetKey: CLIENT,
    });
    expect(state).toMatchObject({
      identity: CLIENT,
      state: 'active',
      version: 7,
      deliveryEnabled: true,
    });
    expect(calls[0]!.payload).toMatchObject({ tool: 'watch_inspect', input: { clientId: CLIENT } });
  });

  it('refuses an operation the owner does not have', async () => {
    intelOwner(() => ({ body: {} }));
    await expect(
      adapter.apply(
        ctx,
        request({
          family: 'client_watchlist',
          clientId: CLIENT,
          targetKind: 'client_tracker_watchlist',
          targetKey: CLIENT,
          operation: 'pause',
        }),
        { actionProposalId: 'proposal-1' },
      ),
    ).resolves.toMatchObject({ receipt: null });
  });
});

describe('business development prospect family leaf', () => {
  function owner(statusAfter: string, priorStatus: string | null = 'active') {
    const calls: string[] = [];
    const service = {
      async getWatch(_ctx: TenantContext, prospectId: string) {
        calls.push('getWatch');
        return {
          watch:
            priorStatus === null
              ? null
              : {
                  status: priorStatus,
                  categories: [],
                  ownerUserId: 'user-1',
                  mutedUntil: null,
                  createdAt: 'a',
                  updatedAt: 'b',
                },
          sources: [],
          lastCompletedCheckAt: null,
        };
      },
      async activateWatch() {
        calls.push('activateWatch');
        return {
          watch: {
            status: statusAfter,
            categories: [],
            ownerUserId: 'user-1',
            mutedUntil: null,
            createdAt: 'a',
            updatedAt: 'b',
          },
          sources: [],
          lastCompletedCheckAt: null,
        };
      },
      async updateWatch(_ctx: TenantContext, _prospectId: string, input: { status?: string }) {
        calls.push(`updateWatch:${input.status}`);
        return {
          watch: {
            status: statusAfter,
            categories: [],
            ownerUserId: 'user-1',
            mutedUntil: null,
            createdAt: 'a',
            updatedAt: 'b',
          },
          sources: [],
          lastCompletedCheckAt: null,
        };
      },
    } as unknown as BizDevWatchService;
    return { adapter: new BizdevWatchAdapter(service), calls };
  }

  it('maps unsubscribe onto the owner terminal state without deleting anything', async () => {
    const { adapter, calls } = owner('ended');
    const effect = await adapter.apply(
      ctx,
      request({
        family: 'business_development_prospect',
        targetKind: 'prospect',
        targetKey: PROSPECT,
        operation: 'unsubscribe',
      }),
      { actionProposalId: 'proposal-1' },
    );
    expect(calls).toContain('updateWatch:ended');
    // The owner's own identity is the prospect: no Meri-minted watch id.
    expect(effect.receipt).toMatchObject({ identity: PROSPECT, state: 'ended', version: null });
  });

  it('reports a no-op owner write as alreadyInState', async () => {
    const { adapter } = owner('paused', 'paused');
    const effect = await adapter.apply(
      ctx,
      request({
        family: 'business_development_prospect',
        targetKind: 'prospect',
        targetKey: PROSPECT,
        operation: 'pause',
      }),
      { actionProposalId: 'proposal-1' },
    );
    expect(effect.receipt?.alreadyInState).toBe(true);
  });

  it('fails closed on a status the owner never publishes', async () => {
    const { adapter } = owner('active', 'unknown_status');
    await expect(
      adapter.inspect(ctx, {
        family: 'business_development_prospect',
        clientId: null,
        targetKind: 'prospect',
        targetKey: PROSPECT,
      }),
    ).rejects.toThrow(ServiceUnavailableException);
  });
});

describe('defense budget target family leaf', () => {
  function owner(existing: boolean) {
    const calls: string[] = [];
    const watches = existing
      ? [
          {
            id: 'watch-1',
            targetType: 'pe',
            targetKey: '0603270A',
            events: [
              {
                id: 'event-1',
                eventType: 'subscribed',
                createdAt: new Date('2026-01-01T00:00:00.000Z'),
              },
            ],
          },
        ]
      : [];
    const service = {
      async list() {
        calls.push('list');
        return watches as never;
      },
      async subscribe(_ctx: TenantContext, input: { targetKey: string }) {
        calls.push('subscribe');
        return { id: 'watch-new', targetType: 'pe', targetKey: input.targetKey, events: [] };
      },
      async setSubscribed(_ctx: TenantContext, input: { watchId: string; subscribed: boolean }) {
        calls.push(`setSubscribed:${input.subscribed}`);
        return {
          id: input.subscribed ? 'event-2' : 'event-3',
          eventType: input.subscribed ? 'resubscribed' : 'unsubscribed',
        };
      },
    } as unknown as DefenseBudgetClientWatchService;
    return { adapter: new DefenseBudgetWatchAdapter(service), calls };
  }

  it('re-subscribes the existing watch instead of minting a duplicate', async () => {
    const { adapter, calls } = owner(true);
    const effect = await adapter.apply(
      ctx,
      request({
        family: 'defense_budget_target',
        clientId: CLIENT,
        targetKind: 'pe',
        targetKey: '0603270A',
        operation: 'subscribe',
        reason: 'Client asked for PE coverage',
      }),
      { actionProposalId: 'proposal-1' },
    );
    expect(calls).not.toContain('subscribe');
    expect(calls).toContain('setSubscribed:true');
    expect(effect.receipt).toMatchObject({
      identity: 'watch-1',
      state: 'active',
      eventId: 'event-2',
    });
  });

  it('creates once for a target with no existing watch and requires the owner reason', async () => {
    const { adapter, calls } = owner(false);
    await expect(
      adapter.apply(
        ctx,
        {
          ...request({
            family: 'defense_budget_target',
            clientId: CLIENT,
            targetKind: 'pe',
            targetKey: '0603270A',
            operation: 'subscribe',
            reason: 'Review',
          }),
          reason: null,
        },
        { actionProposalId: 'proposal-1' },
      ),
    ).rejects.toThrow(BadRequestException);
    expect(calls).not.toContain('subscribe');
    const effect = await adapter.apply(
      ctx,
      request({
        family: 'defense_budget_target',
        clientId: CLIENT,
        targetKind: 'pe',
        targetKey: '0603270A',
        operation: 'subscribe',
        reason: 'Client asked for PE coverage',
      }),
      { actionProposalId: 'proposal-1' },
    );
    expect(calls).toContain('subscribe');
    expect(effect.receipt).toMatchObject({ identity: 'watch-new', state: 'active', eventId: null });
  });

  it('reads the owner subscription event history as the canonical state', async () => {
    const { adapter } = owner(true);
    const state = await adapter.inspect(ctx, {
      family: 'defense_budget_target',
      clientId: CLIENT,
      targetKind: 'pe',
      targetKey: '0603270A',
    });
    expect(state).toMatchObject({ identity: 'watch-1', state: 'active', deliveryEnabled: true });
    const absent = await adapter.inspect(ctx, {
      family: 'defense_budget_target',
      clientId: CLIENT,
      targetKind: 'pe',
      targetKey: '9999999A',
    });
    expect(absent).toMatchObject({ identity: null, state: 'absent', deliveryEnabled: null });
  });
});

describe('registry and executor', () => {
  const registry = new WatchActionRegistry(
    new KeywordWatchAdapter(),
    new ClientWatchlistAdapter(),
    new BizdevWatchAdapter({} as never),
    new DefenseBudgetWatchAdapter({} as never),
  );

  it('holds exactly one leaf per canonical owner and refuses an unknown family', () => {
    for (const family of [
      'legiwatch_keyword',
      'business_development_prospect',
      'defense_budget_target',
      'client_watchlist',
    ] as const)
      expect(registry.adapter(family).family).toBe(family);
    expect(() => registry.adapter('hearing_watchlist' as never)).toThrow(BadRequestException);
  });

  it('routes an approved effect to exactly one owner call and returns UNKNOWN on a lost answer', async () => {
    const input = request({ operation: 'pause' });
    const calls = intelOwner(() => ({
      body: {
        version: 1,
        applied: true,
        partial: false,
        acknowledgement: {
          identity: 'rule-1',
          state: 'paused',
          version: 5,
          deliveryEnabled: false,
          eventId: null,
          alreadyInState: false,
        },
      },
    }));
    // This is exactly what watch-action.service.execute() performs per family.
    const effect = await registry.adapter(input.family).apply(ctx, input, {
      actionProposalId: 'proposal-1',
    });
    expect(effect.receipt).toMatchObject({
      operation: 'pause',
    } satisfies Partial<WatchReceiptPayload>);
    expect(calls.filter((call) => call.payload.tool === 'watch_apply')).toHaveLength(1);

    intelOwner(() => ({ status: 503, body: {} }));
    const unknown = await registry.adapter(input.family).apply(ctx, input, {
      actionProposalId: 'proposal-2',
    });
    expect(unknown.receipt).toBeNull();
  });
});

it.each([
  { operation: 'subscribe', sourceRevision: null },
  { operation: 'set_delivery', enabled: null },
  {
    family: 'defense_budget_target',
    clientId: CLIENT,
    targetKind: 'pe',
    operation: 'subscribe',
    reason: null,
  },
  {
    family: 'client_watchlist',
    clientId: null,
    targetKind: 'client_tracker_watchlist',
    operation: 'subscribe',
  },
] as Partial<WatchRequest>[])(
  'refuses incomplete owner input before an approval claim: %p',
  (selection) => {
    expect(() => request(selection)).toThrow(BadRequestException);
  },
);
