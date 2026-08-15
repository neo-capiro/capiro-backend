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

interface MeriRetrievalRunState {
  plan: MeriRetrievalPlan;
  observations: MeriToolCoverageObservation[];
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
    return this.storage.run({ plan, observations: [] }, execute);
  }

  currentPlan(): MeriRetrievalPlan | null {
    return this.storage.getStore()?.plan ?? null;
  }

  observe(tool: string, input: Record<string, unknown>, result: unknown): void {
    const state = this.storage.getStore();
    if (!state) return;
    const observation = observeMeriToolCoverage(tool, input, result);
    if (
      BOUNDED_WITHOUT_COMPLETENESS.has(tool) &&
      observation.status === 'complete' &&
      !hasExplicitCompleteness(result)
    ) {
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
    // A composite recipe reports the overall fan-out, but it must never wash
    // out a partial source underneath it. For example, a relationship recipe
    // can succeed while search_research_sources remains top-k or Google mail is
    // unavailable. Preserve every such required-domain limitation.
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
}
