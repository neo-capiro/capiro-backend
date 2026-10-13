import type { TenantContext } from '@capiro/shared';
import { ClientProfileFillCompletionService } from '../../src/clients/client-profile-fill-completion.service.js';
import type { AdvocacySourceBackfillState } from '../../src/clients/client-profile-fill-advocacy-health.js';
import {
  createPrisma,
  type Captures,
  type IoState,
  type Options,
} from './client-profile-fill-advocacy-history.io.js';
export {
  ldaRow,
  faraRow,
  testimonyRow,
  communityRow,
  submissionRow,
  privateRow,
  federalSuggestion,
} from './client-profile-fill-advocacy-history.rows.js';
export type {
  SqlCall,
  FindingWrite,
  CursorWrite,
  Options,
} from './client-profile-fill-advocacy-history.io.js';

export const ctx = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  role: 'user_admin',
} as unknown as TenantContext;
export const clientId = '33333333-3333-3333-3333-333333333333';
export const runId = '44444444-4444-4444-4444-444444444444';
export const now = new Date('2026-10-13T12:00:00.000Z');

interface RailResult {
  count: number;
  backfill: AdvocacySourceBackfillState;
}
interface HistoryResult {
  count: number;
  overallStatus: string;
  overallHealth: string;
  sources: Record<string, AdvocacySourceBackfillState>;
}
interface WatermarkInput {
  currentCount?: number;
  priorState?: Record<string, unknown>;
}
interface DiscoveryFacade {
  gatherFaraAdvocacyCandidates(
    ctx: TenantContext,
    clientId: string,
    runId: string,
    currentCount: number,
  ): Promise<RailResult>;
}

interface HistoryOwner {
  gather(ctx: TenantContext, clientId: string, runId: string): Promise<HistoryResult>;
  testimony: {
    gather(
      ctx: TenantContext,
      clientId: string,
      runId: string,
      currentCount: number,
      lastSyncedAt: string | null,
      lastKey: string | null,
      priorState: Record<string, unknown>,
    ): Promise<RailResult & { newestSyncedAt: string | null; newestKey: string | null }>;
  };
  communityFunding: {
    gather(
      ctx: TenantContext,
      clientId: string,
      runId: string,
      currentCount: number,
      lastCreatedAt: string | null,
      lastKey: string | null,
      priorState: Record<string, unknown>,
    ): Promise<RailResult & { newestCreatedAt: string | null; newestKey: string | null }>;
  };
  tenantHistory: {
    gatherClientSubmissions(
      ctx: TenantContext,
      clientId: string,
      runId: string,
      currentCount: number,
      lastCreatedAt: string | null,
      priorState: Record<string, unknown>,
    ): Promise<RailResult & { newestCreatedAt: string | null }>;
    gatherPrivateCandidates(
      ctx: TenantContext,
      clientId: string,
      runId: string,
      currentCount: number,
      lastAppliedAt: string | null,
      priorState: Record<string, unknown>,
    ): Promise<RailResult & { newestAppliedAt: string | null }>;
  };
  federalRegister: {
    gather(
      ctx: TenantContext,
      clientId: string,
      runId: string,
      priorState: Record<string, unknown>,
    ): Promise<AdvocacySourceBackfillState>;
  };
}

function matterStub(state: IoState) {
  return {
    suggestFederalRegisterCorrelations: jest.fn(async (...args: unknown[]) => {
      state.captures.correlations.push(args);
      state.captures.phases.push('outside:correlation');
      const result = state.options.correlationRows?.[args[2] as string];
      if (result instanceof Error) throw result;
      if (state.options.correlationError) throw state.options.correlationError;
      return result ?? [];
    }),
  };
}

function facades(service: ClientProfileFillCompletionService) {
  const discovery = service as unknown as DiscoveryFacade;
  const history = (service as unknown as { owners: { advocacyHistory: HistoryOwner } }).owners
    .advocacyHistory;
  return {
    discover: (actor = ctx, client = clientId, run = runId) => history.gather(actor, client, run),
    fara: (currentCount = 0) =>
      discovery.gatherFaraAdvocacyCandidates(ctx, clientId, runId, currentCount),
    testimony: (
      input: WatermarkInput & { lastSyncedAt?: string | null; lastKey?: string | null } = {},
    ) =>
      history.testimony.gather(
        ctx,
        clientId,
        runId,
        input.currentCount ?? 0,
        input.lastSyncedAt ?? null,
        input.lastKey ?? null,
        input.priorState ?? {},
      ),
    community: (
      input: WatermarkInput & { lastCreatedAt?: string | null; lastKey?: string | null } = {},
    ) =>
      history.communityFunding.gather(
        ctx,
        clientId,
        runId,
        input.currentCount ?? 0,
        input.lastCreatedAt ?? null,
        input.lastKey ?? null,
        input.priorState ?? {},
      ),
    submissions: (input: WatermarkInput & { lastCreatedAt?: string | null } = {}) =>
      history.tenantHistory.gatherClientSubmissions(
        ctx,
        clientId,
        runId,
        input.currentCount ?? 0,
        input.lastCreatedAt ?? null,
        input.priorState ?? {},
      ),
    privateEvidence: (input: WatermarkInput & { lastAppliedAt?: string | null } = {}) =>
      history.tenantHistory.gatherPrivateCandidates(
        ctx,
        clientId,
        runId,
        input.currentCount ?? 0,
        input.lastAppliedAt ?? null,
        input.priorState ?? {},
      ),
    federalRegister: (priorState: Record<string, unknown> = {}) =>
      history.federalRegister.gather(ctx, clientId, runId, priorState),
  };
}

// The actual seven-argument Completion facade and ledger execute unchanged.
// Every withTenant has a distinct transaction; no database/provider is called.
export function harness(options: Options = {}) {
  const captures: Captures = {
    global: [],
    tenant: [],
    models: [],
    findings: [],
    cursors: [],
    phases: [],
    warnings: [],
    correlations: [],
  };
  const state: IoState = {
    options,
    captures,
    nextTransaction: 0,
    nextInsert: 0,
    nextTerminal: 0,
    scope: options.scope ?? { tenantId: ctx.tenantId, clientId, runId },
  };
  const prisma = createPrisma(state);
  const matters = matterStub(state);
  const service = new ClientProfileFillCompletionService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    matters as never,
  );
  const logger = (service as unknown as { logger: { warn(message: string): void } }).logger;
  const warning = jest.spyOn(logger, 'warn').mockImplementation((message: string) => {
    captures.warnings.push(message);
    captures.phases.push('outside:warning');
  });
  return {
    service,
    prisma,
    matters,
    warning,
    captures,
    ...facades(service),
    callsOf: (rail: string) =>
      [...captures.global, ...captures.tenant].filter((call) => call.rail === rail),
    clearCaptures: () => {
      for (const value of Object.values(captures)) value.splice(0);
    },
  };
}

export function installHooks() {
  let priorApiKey: string | undefined;
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    priorApiKey = process.env.REGULATIONS_GOV_API_KEY;
    delete process.env.REGULATIONS_GOV_API_KEY;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('Provider calls forbidden by characterization');
    });
  });
  afterEach(() => {
    if (priorApiKey === undefined) delete process.env.REGULATIONS_GOV_API_KEY;
    else process.env.REGULATIONS_GOV_API_KEY = priorApiKey;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
}
