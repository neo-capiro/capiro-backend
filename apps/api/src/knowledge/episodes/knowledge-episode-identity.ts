import { BadRequestException } from '@nestjs/common';
import { sha256Identity, stableStringify } from '../knowledge.helpers.js';
import type { KnowledgeEventRecord, KnowledgeJsonObject, KnowledgeRef } from '../knowledge.types.js';
import type { MailboxThreadEpisodeGroupingKey } from './knowledge-episode.types.js';

/**
 * Deterministic mailbox-thread episode identity (Phase 7 first slice).
 *
 * Every input here is read from the immutable KnowledgeEvent, never from a
 * mutable message/thread row, so an episode's security partition can never
 * silently widen if a message is later re-associated with a different
 * client/thread in the CRM. Grouping identity depends only on:
 *
 *   - connectionId (namespaces the provider-opaque thread id by connected
 *     mailbox/account, so Gmail/Outlook opaque IDs from different accounts
 *     can never collide even on the same tenant)
 *   - providerThreadId (Gmail threadId / Outlook conversationId)
 *   - sensitivity (exact, never widened/narrowed)
 *   - accessScope (exact, never widened/narrowed)
 *   - clientRefs, canonicalized as an order/duplicate-independent SET
 *
 * The identity hash purposefully excludes the raw account email address and
 * any message/thread subject or body text: none of that is required for
 * grouping identity, and keeping it out of the deterministic key means it
 * never needs to be persisted (or reasoned about for retention/purge) on
 * `knowledge_episodes.identity_key`.
 */
export function mailboxThreadGroupingKeyFromEvent(
  event: KnowledgeEventRecord,
): MailboxThreadEpisodeGroupingKey | null {
  const connectionId = readNonEmptyString(event.evidenceLocator, 'connectionId');
  const providerThreadId = readNonEmptyString(event.evidenceLocator, 'providerThreadId');
  if (!connectionId || !providerThreadId) return null;

  return {
    strategy: 'mailbox_thread_v1',
    tenantId: event.tenantId,
    connectionId,
    providerThreadId,
    sensitivity: event.sensitivity,
    accessScopeDigest: stableStringify(event.accessScope),
    clientRefKeys: canonicalClientRefKeys(event.clientRefs),
  };
}

/**
 * Canonicalizes client refs into a sorted, de-duplicated set of `type:id`
 * keys. Order and duplicates in the source array must never change episode
 * identity — this is the function that guarantees that. Ref `label`/
 * `metadata` are intentionally excluded from the key (they can carry
 * display text without being part of the *scope* identity), which also
 * keeps the persisted grouping key small and free of incidental text.
 */
export function canonicalClientRefKeys(refs: KnowledgeRef[]): string[] {
  const keys = new Set<string>();
  for (const ref of refs) {
    keys.add(`${ref.type}:${ref.id}`);
  }
  return [...keys].sort();
}

/**
 * SHA-256 identity for a `KnowledgeEpisode` row. Two grouping keys that are
 * identical after canonicalization (same tenant, same connection, same
 * provider thread id, same sensitivity, same access scope, same client-ref
 * SET) always produce the same key regardless of client-ref order or
 * duplicates in the source event, and the key changes if either sensitivity
 * or access scope changes, which fails the row closed into a *new* episode
 * (never a widened merge) rather than silently reusing the old one.
 */
export function mailboxThreadEpisodeIdentityKey(
  groupingKey: MailboxThreadEpisodeGroupingKey,
): string {
  return sha256Identity(groupingKey as unknown as KnowledgeJsonObject);
}

function readNonEmptyString(value: KnowledgeJsonObject, key: string): string | null {
  const candidate = value[key];
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Fail-closed guard used before any episode membership write. Refuses to
 * proceed when the event's scope fields are not the exact JSON-object shape
 * the episode schema requires — ambiguity in scope/source identity must
 * block grouping, never default to a permissive interpretation.
 */
export function requireUnambiguousEventScope(event: KnowledgeEventRecord): void {
  if (!event.sensitivity || typeof event.sensitivity !== 'string') {
    throw new BadRequestException(
      'KnowledgeEvent sensitivity is ambiguous; refusing episode projection.',
    );
  }
  if (!event.accessScope || typeof event.accessScope !== 'object' || Array.isArray(event.accessScope)) {
    throw new BadRequestException(
      'KnowledgeEvent accessScope is ambiguous; refusing episode projection.',
    );
  }
}
