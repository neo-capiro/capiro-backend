/**
 * Mounted seam check for the MO-06 watch slice.
 *
 * This file mounts the REAL WatchActionService over the REAL MeriActionProposalService
 * ledger with the REAL tool-service identity guard, and drives the controller methods.
 * Only the infrastructure edges are synthetic:
 *  - the owner ports (the four WatchFamilyAdapter leaves) are simple synthetic owners,
 *    because the real ones call live owners;
 *  - the prisma transaction is an in-memory ledger with the same call shapes the
 *    proposal service uses (create / findFirst / findFirstOrThrow / findMany /
 *    updateMany plus complianceCheck.create);
 *  - the tools port is the executor token for `watch_action` only, and dispatches to the
 *    same WatchActionRegistry leaf path as meri-tools.service.ts.
 *
 * What it proves end to end: prepare -> exact ledger row -> explicit approval -> one
 * canonical owner call -> truthful receipt read; an unconfirmed owner acknowledgement
 * stays UNKNOWN with no resend; a rejected decision dispatches no owner effect; inspect
 * reads owner state without touching the ledger.
 */
import { randomUUID } from 'node:crypto';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { TenantContext } from '@capiro/shared';
import type { AppConfig } from '../../config/config.schema.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { ApplicationCurrentService } from '../../auth/application-current.service.js';
import { ToolServiceSecretGuard } from '../../auth/tool-service-secret.guard.js';
import type { Request } from 'express';
import type { MeriToolsService } from '../meri-tools.service.js';
import type {
  AuthoritativePolicyDecision,
  MeriPolicyPackService,
} from '../meri-policy-pack.service.js';
import type { ResearchPortfolioMeriScopeService } from '../../research-portfolios/research-portfolio-meri-scope.service.js';
import { MeriActionProposalService } from '../meri-action-proposal.service.js';
import { withMeriToolRequestControl } from '../meri-tool-request-control.js';
import { ROLES_KEY } from '../../auth/roles.decorator.js';
import {
  WATCH_ACTION,
  WATCH_SCOPE_KEY,
  WATCH_SUPPORTED_OPERATIONS,
  WATCH_TARGET_KINDS,
  watchBinding,
  watchInput,
  watchRequestOf,
  type WatchAdapterEffect,
  type WatchFamilyAdapter,
  type WatchReceiptPayload,
  type WatchRequest,
  type WatchState,
  type WatchTarget,
} from './watch-action.contract.js';
import { WatchActionController } from './watch-action.controller.js';
import { WatchActionRegistry } from './watch-action.registry.js';
import { WatchActionService } from './watch-action.service.js';

// The heavy Nest graphs behind these two are covered by their own suites; the seam
// under test needs the classes only as injected collaborators.
jest.mock('../meri-tools.service.js', () => ({ MeriToolsService: class {} }));
jest.mock('../meri-policy-pack.service.js', () => ({ MeriPolicyPackService: class {} }));

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const FOREIGN_CLIENT = '44444444-4444-4444-8444-444444444444';
const REV_A = 'a'.repeat(64);
const REV_B = 'b'.repeat(64);
const REV_C = 'c'.repeat(64);
const SECRET = 'synthetic-internal-service-secret';
const FAMILY = 'legiwatch_keyword' as const;
const TARGET_KIND = WATCH_TARGET_KINDS[FAMILY][0] as string;
const OPERATION = 'subscribe' as const;

const ctx = {
  tenantId: TENANT,
  tenantSlug: 'seam',
  userId: USER,
  clerkUserId: 'clerk_seam',
  role: 'standard_user',
} as unknown as TenantContext;

const selection = { conversationId: CONVERSATION, selectedClientId: null };
const scope = {
  ...selection,
  identityRevision: REV_A,
  membershipRevision: REV_B,
  contextRevision: REV_C,
};

function watchRequest(overrides: Partial<WatchRequest> = {}): WatchRequest {
  return {
    family: FAMILY,
    clientId: null,
    targetKind: TARGET_KIND,
    targetKey: 'rule-1',
    operation: OPERATION,
    expectedVersion: 2,
    sourceRevision: 'preview-run-1',
    reason: null,
    enabled: null,
    requestKey: 'sdk:' + '0'.repeat(60) + '1',
    ...overrides,
  };
}

function receiptPayload(request: WatchRequest): WatchReceiptPayload {
  return {
    owner: request.family,
    binding: watchBinding(request),
    operation: request.operation,
    targetKey: request.targetKey,
    identity: 'rule-1',
    state: request.operation === 'pause' ? 'paused' : 'active',
    version: request.expectedVersion + 1,
    deliveryEnabled: true,
    eventId: 'sdk:' + '0'.repeat(60) + '2',
    alreadyInState: false,
  };
}

const policyDecision = {
  outcome: 'WARN',
  packId: 'capiro-generic-action-approval',
  packVersion: '2026.10.1',
  ruleId: 'watch-requires-approval',
  reason: 'Watch changes require explicit approval.',
  code: null,
  tier: 'moderate',
  simulated: false,
  mode: 'off',
  source: 'static',
  verified: true,
  bindable: true,
  policyPackRowId: '55555555-5555-4555-8555-555555555555',
  binding: REV_A,
  contextHash: REV_B,
  decisionHash: REV_C,
  context: {
    channel: 'crm',
    recipientType: null,
    clientId: null,
    jurisdiction: 'US',
    effectiveUserId: USER,
    effectiveAt: '2026-10-27T00:00:00.000Z',
    actorUserId: USER,
    actorRole: 'standard_user',
  },
} as unknown as AuthoritativePolicyDecision;

type Row = Record<string, unknown> & {
  id: string;
  createdAt: Date;
  status: string;
  attemptCount: number;
  resultSummary: unknown;
  input: Record<string, unknown>;
  preview: Record<string, unknown>;
};

function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
  return Object.entries(where ?? {}).every(([key, expected]) => {
    const actual = (row as Record<string, unknown>)[key];
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      // Recognised Prisma filters only: an unrecognised operator would silently match
      // everything, which is exactly how a ledger double lies.
      const query = expected as Record<string, unknown>;
      const operators = Object.keys(query);
      const unknown = operators.filter(
        (operator) =>
          !['in', 'notIn', 'gt', 'gte', 'lt', 'lte', 'equals', 'not'].includes(operator),
      );
      if (unknown.length)
        throw new Error(`seam ledger does not implement filter: ${unknown.join(', ')}`);
      if (Array.isArray(query.in) && !query.in.includes(actual)) return false;
      if (Array.isArray(query.notIn) && query.notIn.includes(actual)) return false;
      if ('equals' in query && actual !== query.equals) return false;
      if ('not' in query && actual === query.not) return false;
      if ('gt' in query && !((actual as Date) > (query.gt as Date))) return false;
      if ('gte' in query && !((actual as Date) >= (query.gte as Date))) return false;
      if ('lt' in query && !((actual as Date) < (query.lt as Date))) return false;
      if ('lte' in query && !((actual as Date) <= (query.lte as Date))) return false;
      return true;
    }
    return actual === expected;
  });
}

function write(row: Row, data: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (value && typeof value === 'object' && 'increment' in (value as Record<string, unknown>)) {
      row[key] = Number(row[key] ?? 0) + Number((value as { increment: number }).increment);
      continue;
    }
    row[key] = value;
  }
}

/** The in-memory stand-in for the proposal ledger the service already owns. */
function ledger() {
  const rows: Row[] = [];
  const model = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = {
        id: randomUUID(),
        createdAt: new Date(),
        updatedAt: new Date(),
        status: 'proposed',
        attemptCount: 0,
        approvedAt: null,
        approvedBy: null,
        executedAt: null,
        executionStartedAt: null,
        resultSummary: null,
        lastErrorCode: null,
        lastErrorMessage: null,
        ...data,
      } as unknown as Row;
      rows.push(row);
      return row;
    },
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      rows.find((row) => matches(row, where)) ?? null,
    findFirstOrThrow: async ({ where }: { where: Record<string, unknown> }) => {
      const found = rows.find((row) => matches(row, where));
      if (!found) throw new NotFoundException('proposal not found');
      return found;
    },
    findMany: async ({
      where,
      orderBy,
      take,
    }: {
      where?: Record<string, unknown>;
      orderBy?: { createdAt?: 'asc' | 'desc' };
      take?: number;
    }) => {
      const found = rows.filter((row) => matches(row, where));
      if (orderBy?.createdAt === 'desc')
        found.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
      return take === undefined ? found : found.slice(0, take);
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => {
      let count = 0;
      for (const row of rows)
        if (matches(row, where)) {
          write(row, data);
          row.updatedAt = new Date();
          count += 1;
        }
      return { count };
    },
  };
  const tx = {
    meriActionProposal: model,
    complianceCheck: { create: async () => ({}) },
    client: { findFirst: async () => null },
    $queryRaw: async () => [],
  };
  return { rows, tx };
}

function makeRequest(header: Record<string, string>): Request {
  return {
    method: 'POST',
    path: '/api/clio/tools/prepare_watch_action',
    aborted: false,
    headers: {
      authorization: 'Bearer synthetic',
      'x-meri-read-correlation': 'x',
      'x-meri-deadline-at': String(Date.now() + 60_000),
      ...header,
    },
    once: () => undefined,
    removeListener: () => undefined,
    res: {
      writableEnded: false,
      destroyed: false,
      once: () => undefined,
      removeListener: () => undefined,
    },
  } as unknown as Request;
}

function mount(owner: {
  apply?: (request: WatchRequest) => Promise<WatchAdapterEffect>;
  inspect?: (target: WatchTarget) => Promise<WatchState>;
} = {}) {
  const book = ledger();
  const prisma = {
    withTenant: async (_tenantId: string, callback: (tx: unknown) => unknown) =>
      callback(book.tx),
  } as unknown as PrismaService;
  const config = {
    get: (key: string) =>
      key === 'MERIV2_ACTION_PROPOSALS_ENABLED'
        ? true
        : key === 'MERIV2_ACTION_PROPOSAL_TTL_MINUTES'
          ? 30
          : undefined,
  } as unknown as ConfigService<AppConfig, true>;
  const policyPacks = {
    decideForAction: async () => policyDecision,
    recordDecisionInTx: async () => undefined,
  } as unknown as MeriPolicyPackService;
  // The real ApplicationCurrentService fails closed when the caller's expectation no
  // longer matches the current authority, so this port enforces the same contract.
  const current = {
    read: async (
      _ctx: TenantContext,
      _req: Request,
      args?: {
        expect?: {
          identityRevision: string;
          membershipRevision: string;
          contextRevision: string;
        };
      },
    ) => {
      if (
        args?.expect &&
        (args.expect.identityRevision !== REV_A ||
          args.expect.membershipRevision !== REV_B ||
          args.expect.contextRevision !== REV_C)
      )
        throw new ForbiddenException('Current application authority changed');
      return {
        identityRevision: REV_A,
        membershipRevision: REV_B,
        contextRevision: REV_C,
        clientIds: [],
      };
    },
  } as unknown as ApplicationCurrentService;

  const calls: { apply: WatchRequest[]; inspect: WatchTarget[] } = { apply: [], inspect: [] };
  const families = Object.keys(WATCH_SUPPORTED_OPERATIONS) as Array<
    keyof typeof WATCH_SUPPORTED_OPERATIONS
  >;
  const adapters: WatchFamilyAdapter[] = families.map((family) => ({
    family,
    operations: WATCH_SUPPORTED_OPERATIONS[family],
    async inspect(_owner, target) {
      calls.inspect.push(target);
      return (
        (await owner.inspect?.(target)) ?? {
          family: target.family,
          clientId: target.clientId,
          targetKind: target.targetKind,
          targetKey: target.targetKey,
          identity: 'rule-1',
          state: 'active',
          version: 3,
          deliveryEnabled: true,
          facts: { nextRun: null },
        }
      );
    },
    async apply(_owner, request) {
      calls.apply.push(request);
      return (
        (await owner.apply?.(request)) ?? { request, receipt: receiptPayload(request) }
      );
    },
  }));

  let service: WatchActionService;
  const tools = {
    // The real MeriToolsService applies the tool schema; for the watch token that
    // schema is the contract's own parser, so the seam keeps the same validation.
    validateSideEffectingInput: (_name: string, raw: unknown) => watchInput(watchRequestOf(raw)),
    executeFromAuthenticatedUser: async (
      ownerCtx: TenantContext,
      name: string,
      input: Record<string, unknown>,
      execution?: { actionProposalId?: string },
    ) => {
      expect(name).toBe(WATCH_ACTION);
      const request = watchRequestOf(input);
      const effect = await registry.adapter(request.family).apply(ownerCtx, request, {
        actionProposalId: execution?.actionProposalId as string,
      });
      return {tool: WATCH_ACTION, result: effect.receipt};
    },
  } as unknown as MeriToolsService;

  const proposals = new MeriActionProposalService(
    prisma,
    tools,
    config,
    policyPacks,
    {} as unknown as ResearchPortfolioMeriScopeService,
  );
  // The registry takes the four concrete family leaves; the synthetic owners satisfy
  // the same adapter contract, so the tuple is cast once at this boundary.
  const registry = new WatchActionRegistry(
    ...(adapters as unknown as ConstructorParameters<typeof WatchActionRegistry>),
  );
  service = new WatchActionService(current, proposals, registry);

  const guard = new ToolServiceSecretGuard(
    {
      get: (key: string) =>
        key === 'INTERNAL_SERVICE_SECRET'
          ? SECRET
          : key === 'MERI_TOOLS_REQUIRE_SERVICE_SECRET'
            ? true
            : key === 'NODE_ENV'
              ? 'test'
              : undefined,
    } as unknown as ConfigService<AppConfig, true>,
  );
  const request = makeRequest({ 'x-internal-service-secret': SECRET });
  // The real guard is what records service identity for this request.
  guard.verifyRequest(request);
  const anonymous = makeRequest({});

  const run = <T>(req: Request, work: () => Promise<T>) =>
    withMeriToolRequestControl(req, work);
  const prepareBody = (request_: WatchRequest = watchRequest()) => ({
    version: 1,
    context: selection,
    request: request_,
  });

  return {
    rows: book.rows,
    calls,
    service,
    proposals,
    controller: new WatchActionController(service),
    request,
    anonymous,
    run,
    prepareBody,
  };
}

describe('watch action mounted seam', () => {
  it('prepare stores one bound proposal and calls no owner', async () => {
    const m = mount();
    const request = watchRequest();
    const result = await m.run(m.request, () => m.service.prepare(ctx, m.request, m.prepareBody(request)));

    expect(result.status).toBe('proposed');
    expect(result.request).toEqual(request);
    expect(result.receipt).toBeNull();
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0]!.status).toBe('proposed');
    expect(m.rows[0]!.tool).toBe(WATCH_ACTION);
    expect(m.rows[0]!.input).toEqual(watchInput(request));
    expect(m.rows[0]!.preview[WATCH_SCOPE_KEY]).toEqual(scope);
    expect(m.calls.apply).toHaveLength(0);
  });

  it('approval records exactly one canonical owner receipt', async () => {
    const m = mount();
    const request = watchRequest();
    const prepared = await m.run(m.request, () =>
      m.service.prepare(ctx, m.request, m.prepareBody(request)),
    );
    const decided = await m.run(m.request, () =>
      m.service.decide(ctx, m.request, {
        version: 1,
        proposalId: prepared.proposalId as string,
        context: scope,
        decision: 'approved',
      }),
    );

    expect(m.calls.apply).toHaveLength(1);
    expect(decided.status).toBe('succeeded');
    const receipt = (decided as unknown as { receipt: Record<string, unknown> }).receipt;
    expect(receipt).not.toBeNull();
    expect(receipt.owner).toBe(FAMILY);
    expect(receipt.operation).toBe(OPERATION);
    expect(receipt.targetKey).toBe('rule-1');
    expect(receipt.identity).toBe('rule-1');
    expect(receipt.binding).toBe(watchBinding(request));
  });

  it('read releases only the receipt of the exact proposed target', async () => {
    const m = mount();
    const request = watchRequest();
    const prepared = await m.run(m.request, () =>
      m.service.prepare(ctx, m.request, m.prepareBody(request)),
    );
    await m.run(m.request, () =>
      m.service.decide(ctx, m.request, {
        version: 1,
        proposalId: prepared.proposalId as string,
        context: scope,
        decision: 'approved',
      }),
    );
    const read = await m.run(m.request, () =>
      m.service.read(ctx, m.request, {
        version: 1,
        proposalId: prepared.proposalId as string,
        context: scope,
      }),
    );

    expect(read.status).toBe('succeeded');
    expect((read as unknown as { request: WatchRequest }).request.targetKey).toBe('rule-1');
    const receipt = (read as unknown as { receipt: Record<string, unknown> }).receipt;
    expect(receipt.targetKey).toBe('rule-1');

    // A different stored authority is refused rather than answered.
    await expect(
      m.run(m.request, () =>
        m.service.read(ctx, m.request, {
          version: 1,
          proposalId: prepared.proposalId as string,
          context: {
            ...scope,
            identityRevision: 'd'.repeat(64),
          },
        }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('an unconfirmed owner acknowledgement stays UNKNOWN with no resend', async () => {
    const m = mount({ apply: async (request) => ({ request, receipt: null }) });
    const request = watchRequest();
    const prepared = await m.run(m.request, () =>
      m.service.prepare(ctx, m.request, m.prepareBody(request)),
    );
    const decided = await m.run(m.request, () =>
      m.service.decide(ctx, m.request, {
        version: 1,
        proposalId: prepared.proposalId as string,
        context: scope,
        decision: 'approved',
      }),
    );

    expect(m.calls.apply).toHaveLength(1);
    expect(decided.status).toBe('outcome_unknown');
    const read = await m.run(m.request, () =>
      m.service.read(ctx, m.request, {
        version: 1,
        proposalId: prepared.proposalId as string,
        context: scope,
      }),
    );
    expect((read as unknown as { receipt: unknown }).receipt).toBeNull();
    expect(m.calls.apply).toHaveLength(1);
  });

  it('a rejected decision dispatches no owner effect', async () => {
    const m = mount();
    const prepared = await m.run(m.request, () =>
      m.service.prepare(ctx, m.request, m.prepareBody(watchRequest())),
    );
    const decided = await m.run(m.request, () =>
      m.service.decide(ctx, m.request, {
        version: 1,
        proposalId: prepared.proposalId as string,
        context: scope,
        decision: 'rejected',
      }),
    );

    expect(m.calls.apply).toHaveLength(0);
    expect(decided.status).toBe('dismissed');
  });

  it('inspect reads owner state without preparing or deciding anything', async () => {
    const m = mount();
    const target = { family: FAMILY, clientId: null, targetKind: TARGET_KIND, targetKey: 'rule-1' };
    const state = await m.run(m.request, () =>
      m.service.inspect(ctx, m.request, { version: 1, context: selection, target }),
    );

    expect(m.calls.inspect).toHaveLength(1);
    expect(m.calls.apply).toHaveLength(0);
    expect(m.rows).toHaveLength(0);
    expect((state as unknown as { state: WatchState }).state.targetKey).toBe('rule-1');

    // A target outside the current selection is refused, not answered.
    await expect(
      m.run(m.request, () =>
        m.service.inspect(ctx, m.request, {
          version: 1,
          context: selection,
          target: { ...target, clientId: FOREIGN_CLIENT },
        }),
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(m.calls.inspect).toHaveLength(1);
  });

  it('the attended routes exist, are guarded and reach the owner only with service identity', async () => {
    const m = mount();
    const paths = {
      prepare: Reflect.getMetadata('path', m.controller.prepare) as unknown,
      read: Reflect.getMetadata('path', m.controller.read) as unknown,
      decide: Reflect.getMetadata('path', m.controller.decide) as unknown,
      inspect: Reflect.getMetadata('path', m.controller.inspect) as unknown,
    };
    expect([paths.prepare, paths.read, paths.decide, paths.inspect]).toEqual([
      'prepare_watch_action',
      'read_watch_action_proposal',
      'decide_watch_action',
      'inspect_watch_state',
    ]);
    expect(Reflect.getMetadata('__guards__', WatchActionController)).toHaveLength(2);
    expect(Reflect.getMetadata(ROLES_KEY, WatchActionController)).toEqual(['standard_user']);

    await expect(
      m.run(m.anonymous, () => m.controller.prepare(ctx, m.anonymous, m.prepareBody(watchRequest()))),
    ).rejects.toThrow(ForbiddenException);
    expect(m.rows).toHaveLength(0);

    await m.run(m.request, () => m.controller.prepare(ctx, m.request, m.prepareBody(watchRequest())));
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0]!.status).toBe('proposed');
  });
});
