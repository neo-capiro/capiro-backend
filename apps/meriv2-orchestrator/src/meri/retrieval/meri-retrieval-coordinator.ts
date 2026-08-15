import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import {
  buildMeriCoverageManifest,
  observeMeriToolCoverage,
  type MeriCoverageManifest,
  type MeriToolCoverageObservation,
} from './meri-retrieval-coverage.js';
import {
  MERI_RETRIEVAL_RECIPE_TOOLS,
  type MeriRetrievalPlan,
} from './meri-retrieval-plan.js';

export interface MeriRetrievalToolTrace {
  tool: string;
  durationMs: number;
  returned: number;
  status: MeriToolCoverageObservation['status'];
  hasMore: boolean;
}

export interface MeriRetrievalTrace {
  version: 1;
  startedAt: string;
  durationMs: number;
  modelTools: string[];
  recipeFirst: boolean | null;
  outOfPlanModelTools: string[];
  observedToolCalls: number;
  uniqueTools: string[];
  /** Sum of observed tool/recipe wall times. Nested recipe calls can overlap/double-count. */
  cumulativeToolMs: number;
  partialToolCount: number;
  errorToolCount: number;
  paginationDebt: string[];
  tools: MeriRetrievalToolTrace[];
}

interface MeriRetrievalRunState {
  plan: MeriRetrievalPlan;
  observations: MeriToolCoverageObservation[];
  startedAtMs: number;
  startedAtIso: string;
  modelTools: string[];
  toolTraces: MeriRetrievalToolTrace[];
}

const RECIPE_TOOLS = new Set<string>(MERI_RETRIEVAL_RECIPE_TOOLS);
const MAX_MAILBOX_STALENESS_MS = 48 * 60 * 60 * 1000;

/**
 * These readers return bounded arrays but do not currently expose a durable
 * cursor/total contract. Even when the returned page is small, Meri cannot
 * prove that it enumerated the source, so exhaustive negative claims must stay
 * provisional until the API supplies explicit completeness metadata.
 */
const BOUNDED_WITHOUT_COMPLETENESS = new Set([
  'find_contacts',
  'list_emails',
  'list_upcoming_meetings',
  'query_action_items',
  'query_debriefs',
  'query_outreach',
  'query_tasks',
  'search_memory',
  'search_research_sources',
  'search_tracked_bills',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExplicitCompleteness(result: unknown): boolean {
  if (!isRecord(result)) return false;
  if (result.paginationComplete === true) return true;
  return isRecord(result.coverage) && result.coverage.complete === true;
}

function mailboxCoverageIssue(result: unknown, now = Date.now()): string | null {
  if (!isRecord(result) || !Array.isArray(result.searchedMailboxes)) return null;
  if (result.searchedMailboxes.length === 0) return 'No connected mailbox was searched.';
  for (const raw of result.searchedMailboxes) {
    if (!isRecord(raw)) return 'Mailbox coverage returned an invalid record.';
    const provider = typeof raw.provider === 'string' ? raw.provider : 'mailbox';
    const account = typeof raw.accountEmail === 'string' ? raw.accountEmail : provider;
    const status = typeof raw.status === 'string' ? raw.status.toLowerCase() : '';
    if (/error|failed|disabled|unavailable|needs_configuration/.test(status)) {
      return `${account} is ${status || 'unavailable'}.`;
    }
    const syncedMessages =
      typeof raw.syncedMessages === 'number' && Number.isFinite(raw.syncedMessages)
        ? raw.syncedMessages
        : 0;
    if (syncedMessages <= 0) return `${account} has no synchronized messages.`;
    const lastSyncAt =
      raw.lastSyncAt instanceof Date
        ? raw.lastSyncAt
        : typeof raw.lastSyncAt === 'string'
          ? new Date(raw.lastSyncAt)
          : null;
    if (!lastSyncAt || !Number.isFinite(lastSyncAt.getTime())) {
      return `${account} has no verifiable last-sync timestamp.`;
    }
    if (now - lastSyncAt.getTime() > MAX_MAILBOX_STALENESS_MS) {
      return `${account} has not synchronized within the last 48 hours.`;
    }
  }
  return null;
}

@Injectable()
export class MeriRetrievalCoordinator {
  private readonly storage = new AsyncLocalStorage<MeriRetrievalRunState>();

  run<T>(plan: MeriRetrievalPlan, execute: () => Promise<T>): Promise<T> {
    const startedAtMs = Date.now();
    return this.storage.run(
      {
        plan,
        observations: [],
        startedAtMs,
        startedAtIso: new Date(startedAtMs).toISOString(),
        modelTools: [],
        toolTraces: [],
      },
      execute,
    );
  }

  currentPlan(): MeriRetrievalPlan | null {
    return this.storage.getStore()?.plan ?? null;
  }

  recordModelTool(tool: string): void {
    const state = this.storage.getStore();
    if (!state) return;
    state.modelTools.push(tool);
  }

  observe(
    tool: string,
    input: Record<string, unknown>,
    result: unknown,
    durationMs = 0,
  ): void {
    const state = this.storage.getStore();
    if (!state) return;
    const observation = observeMeriToolCoverage(tool, input, result);
    if (BOUNDED_WITHOUT_COMPLETENESS.has(tool) && !hasExplicitCompleteness(result)) {
      observation.status = 'partial';
      observation.detail =
        observation.detail ?? 'Bounded result without a cursor/total completeness contract.';
    }
    if (tool === 'search_emails') {
      const issue = mailboxCoverageIssue(result);
      if (issue) {
        observation.status = 'partial';
        observation.detail = issue;
      }
    }
    state.observations.push(observation);
    state.toolTraces.push({
      tool,
      durationMs: Math.max(0, Math.round(durationMs)),
      returned: observation.returned,
      status: observation.status,
      hasMore: observation.hasMore,
    });
  }

  observations(): readonly MeriToolCoverageObservation[] {
    return this.storage.getStore()?.observations ?? [];
  }

  coverage(): MeriCoverageManifest {
    const state = this.storage.getStore();
    if (!state) {
      throw new Error('Meri retrieval coverage requested outside an active retrieval run');
    }
    const manifest = buildMeriCoverageManifest(state.plan, state.observations);
    const underlyingPartial = state.plan.requiredDomains.filter((domain) =>
      state.observations.some(
        (observation) =>
          !RECIPE_TOOLS.has(observation.tool) &&
          observation.domains.includes(domain) &&
          observation.status !== 'complete',
      ),
    );
    if (!underlyingPartial.length) return manifest;
    return {
      ...manifest,
      complete: false,
      partialDomains: [...new Set([...manifest.partialDomains, ...underlyingPartial])],
      stopReason: 'partial',
    };
  }

  trace(now = Date.now()): MeriRetrievalTrace {
    const state = this.storage.getStore();
    if (!state) throw new Error('Meri retrieval trace requested outside an active retrieval run');
    const allowed = new Set([
      ...state.plan.recommendedTools,
      ...(state.plan.recipeTool ? [state.plan.recipeTool] : []),
    ]);
    const outOfPlanModelTools = [...new Set(state.modelTools.filter((tool) => !allowed.has(tool)))];
    const paginationDebt = [
      ...new Set(
        state.observations
          .filter((observation) =>
            /cursor\/total completeness contract|bounded result/i.test(observation.detail ?? ''),
          )
          .map((observation) => observation.tool),
      ),
    ];
    return {
      version: 1,
      startedAt: state.startedAtIso,
      durationMs: Math.max(0, now - state.startedAtMs),
      modelTools: [...state.modelTools],
      recipeFirst: state.plan.recipeTool
        ? state.modelTools.length > 0 && state.modelTools[0] === state.plan.recipeTool
        : null,
      outOfPlanModelTools,
      observedToolCalls: state.toolTraces.length,
      uniqueTools: [...new Set(state.toolTraces.map((trace) => trace.tool))],
      cumulativeToolMs: state.toolTraces.reduce((sum, trace) => sum + trace.durationMs, 0),
      partialToolCount: state.toolTraces.filter((trace) => trace.status === 'partial').length,
      errorToolCount: state.toolTraces.filter(
        (trace) => trace.status === 'error' || trace.status === 'unavailable',
      ).length,
      paginationDebt,
      tools: [...state.toolTraces],
    };
  }
}
