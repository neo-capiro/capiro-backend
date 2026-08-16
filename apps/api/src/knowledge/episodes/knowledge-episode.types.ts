import type { KnowledgeJsonObject, KnowledgeRef } from '../knowledge.types.js';

/**
 * Phase 7 — Knowledge Episodes.
 *
 * An episode is a derived, materialized grouping of KnowledgeEvent /
 * KnowledgeAssertion / canonical-entity membership rows that were already
 * written by Phase 1-6. It is NOT a new source of truth, NOT a second graph,
 * and NOT a relationship-history database: every membership row points back
 * at the exact authoritative row it groups, and deleting the episode tables
 * loses only the grouping, never the underlying knowledge.
 *
 * The first production grouping strategy is deterministic mailbox-thread
 * identity (Phase 4/6's `mail_thread` entity ref). Topic/time/program/bill/PE
 * grouping is intentionally deferred — this file's `KNOWLEDGE_EPISODE_STRATEGIES`
 * list exists so a later phase can add a strategy value without a schema
 * change, not so this phase implements one.
 */

export const KNOWLEDGE_EPISODE_STRATEGIES = ['mailbox_thread_v1'] as const;
export type KnowledgeEpisodeStrategy = (typeof KNOWLEDGE_EPISODE_STRATEGIES)[number];

export const KNOWLEDGE_EPISODE_STATUSES = ['open', 'closed'] as const;
export type KnowledgeEpisodeStatus = (typeof KNOWLEDGE_EPISODE_STATUSES)[number];

export const KNOWLEDGE_EPISODE_PROJECTION_JOB_STATUSES = [
  'pending',
  'processing',
  'succeeded',
  'skipped',
  'failed',
  'dead_letter',
] as const;
export type KnowledgeEpisodeProjectionJobStatus =
  (typeof KNOWLEDGE_EPISODE_PROJECTION_JOB_STATUSES)[number];

/** A precise, minimal identity locator persisted in `KnowledgeEpisode.groupingKey`. */
export interface MailboxThreadEpisodeGroupingKey {
  strategy: 'mailbox_thread_v1';
  tenantId: string;
  /**
   * The security/mailbox-account namespace the provider thread ID lives in.
   * Using the connection UUID (not the raw account email) means the
   * deterministic key never embeds a private address, and two different
   * connected mailboxes can never collide even if their providers ever
   * reused an opaque thread ID (they don't, but the identity boundary
   * doesn't rely on trusting the provider to guarantee that).
   */
  connectionId: string;
  /** Provider-opaque thread id (Gmail threadId / Outlook conversationId). */
  providerThreadId: string;
  sensitivity: string;
  /** Stable JSON representation of the access scope, for hashing only. */
  accessScopeDigest: string;
  /** Sorted, de-duplicated client ref keys (`type:id`), for hashing only. */
  clientRefKeys: string[];
}

export interface KnowledgeEpisodeRecord {
  id: string;
  tenantId: string;
  strategy: KnowledgeEpisodeStrategy;
  identityKey: string;
  status: KnowledgeEpisodeStatus;
  sensitivity: string;
  accessScope: KnowledgeJsonObject;
  clientRefs: KnowledgeRef[];
  groupingKey: KnowledgeJsonObject;
  eventCount: number;
  assertionCount: number;
  entityCount: number;
  firstEventAt: Date;
  lastEventAt: Date;
  metadata: KnowledgeJsonObject;
  createdAt: Date;
  updatedAt: Date;
}

export interface KnowledgeEpisodeEventRecord {
  id: string;
  tenantId: string;
  episodeId: string;
  eventId: string;
  occurredAt: Date;
  createdAt: Date;
}

export interface KnowledgeEpisodeAssertionRecord {
  id: string;
  tenantId: string;
  episodeId: string;
  assertionId: string;
  originEventId: string;
  createdAt: Date;
}

export interface KnowledgeEpisodeEntityRecord {
  id: string;
  tenantId: string;
  episodeId: string;
  canonicalEntityId: string;
  createdAt: Date;
}

/** Durable, tenant-bound operational state for the Phase 7 projection queue. */
export interface KnowledgeEpisodeProjectionJobRecord {
  id: string;
  tenantId: string;
  eventId: string;
  status: KnowledgeEpisodeProjectionJobStatus;
  attemptCount: number;
  availableAt: Date;
  lockedAt: Date | null;
  lockedBy: string | null;
  lastError: string | null;
  episodeId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface KnowledgeEpisodeProjectionDrainResult {
  claimed: number;
  succeeded: number;
  skipped: number;
  failed: number;
}
