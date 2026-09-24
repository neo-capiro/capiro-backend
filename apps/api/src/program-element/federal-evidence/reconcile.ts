import { createHash } from 'node:crypto';

/** One publisher's text for one stable bill-version code. */
export interface FederalTextObservation {
  billId: string;
  provider: 'congress.gov' | 'govinfo';
  versionCode: string;
  sourceUrl: string;
  contentHash: string;
  observedAt: string;
  text: string;
  /** True only when the provider inventory for this bill was read completely. */
  inventoryComplete: boolean;
  mentions: FederalMentionObservation[];
}

export interface FederalMentionObservation {
  /** Stable locator within this version (for example section + normalized occurrence ordinal). */
  locator: string;
  rawCode: string;
  /** Canonical code when resolution succeeded; otherwise this mention remains pending. */
  canonicalCode: string | null;
  quote: string;
}

export interface FederalTextRevision {
  revisionKey: string;
  billId: string;
  provider: FederalTextObservation['provider'];
  versionCode: string;
  sourceUrl: string;
  contentHash: string;
  observedAt: string;
  text: string;
}

export interface FederalMentionState {
  mentionKey: string;
  billId: string;
  provider: FederalTextObservation['provider'];
  versionCode: string;
  locator: string;
  rawCode: string;
  canonicalCode: string | null;
  quote: string;
  status: 'active' | 'removed' | 'pending_unknown_code';
  lastRevisionKey: string;
}

export interface FederalEvidenceState {
  revisions: FederalTextRevision[];
  mentions: FederalMentionState[];
}

export interface FederalChangeEvent {
  eventKey: string;
  kind:
    | 'text_revision_added'
    | 'mention_added'
    | 'mention_changed'
    | 'mention_removed'
    | 'mention_reinstated'
    | 'mention_resolved';
  billId: string;
  revisionKey: string;
  mentionKey?: string;
  canonicalCode?: string;
  rawCode?: string;
  before?: { canonicalCode: string | null; quote: string };
  after?: { canonicalCode: string | null; quote: string };
}

export interface FederalOutboxItem {
  dedupeKey: string;
  eventKey: string;
  payload: FederalChangeEvent;
}

export interface FederalEvidencePlan {
  state: FederalEvidenceState;
  events: FederalChangeEvent[];
  outbox: FederalOutboxItem[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function tupleKey(...parts: string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join('|');
}

function revisionKeyFor(observation: FederalTextObservation): string {
  return sha256(
    tupleKey(
      'federal-text-revision-v1',
      observation.billId,
      observation.provider,
      observation.versionCode,
      observation.contentHash,
    ),
  );
}

function mentionKeyFor(
  observation: FederalTextObservation,
  mention: FederalMentionObservation,
): string {
  return sha256(
    tupleKey(
      'federal-mention-v1',
      observation.billId,
      observation.provider,
      observation.versionCode,
      mention.locator,
      mention.rawCode.trim().toUpperCase(),
    ),
  );
}

function event(
  kind: FederalChangeEvent['kind'],
  billId: string,
  revisionKey: string,
  mention?: FederalMentionState,
  before?: FederalMentionState,
): FederalChangeEvent {
  const eventKey = sha256(
    tupleKey('federal-change-event-v1', kind, billId, revisionKey, mention?.mentionKey ?? ''),
  );
  return {
    eventKey,
    kind,
    billId,
    revisionKey,
    ...(mention
      ? {
          mentionKey: mention.mentionKey,
          ...(mention.canonicalCode ? { canonicalCode: mention.canonicalCode } : {}),
          rawCode: mention.rawCode,
          ...(before
            ? {
                before: { canonicalCode: before.canonicalCode, quote: before.quote },
                after: { canonicalCode: mention.canonicalCode, quote: mention.quote },
              }
            : {}),
        }
      : {}),
  };
}

/**
 * Plan an append-only federal evidence reconciliation. This function performs no
 * I/O; callers persist the returned revision rows, latest mention projection,
 * events, and outbox rows transactionally. A caller must not infer removals from
 * an incomplete inventory.
 */
export function reconcileFederalEvidence(
  prior: FederalEvidenceState,
  observation: FederalTextObservation,
  codeResolutions: ReadonlyMap<string, string>,
): FederalEvidencePlan {
  if (!observation.billId.trim() || !observation.versionCode.trim()) {
    throw new Error('BILL_AND_VERSION_CODE_REQUIRED');
  }
  if (!/^[a-f0-9]{64}$/i.test(observation.contentHash)) {
    throw new Error('CONTENT_HASH_MUST_BE_SHA256');
  }

  const revisionKey = revisionKeyFor(observation);
  const revisionExists = prior.revisions.some((revision) => revision.revisionKey === revisionKey);
  const revisions = revisionExists
    ? [...prior.revisions]
    : [
        ...prior.revisions,
        {
          revisionKey,
          billId: observation.billId,
          provider: observation.provider,
          versionCode: observation.versionCode,
          sourceUrl: observation.sourceUrl,
          contentHash: observation.contentHash.toLowerCase(),
          observedAt: observation.observedAt,
          text: observation.text,
        },
      ];

  const events: FederalChangeEvent[] = [];
  if (!revisionExists) events.push(event('text_revision_added', observation.billId, revisionKey));

  const mentions = prior.mentions.map((mention) => ({ ...mention }));
  const seen = new Set<string>();
  for (const sourceMention of observation.mentions) {
    const mentionKey = mentionKeyFor(observation, sourceMention);
    if (seen.has(mentionKey)) continue;
    seen.add(mentionKey);
    const index = mentions.findIndex((mention) => mention.mentionKey === mentionKey);
    const normalizedRawCode = sourceMention.rawCode.trim().toUpperCase();
    const resolvedCode =
      codeResolutions.get(normalizedRawCode) ??
      (sourceMention.canonicalCode
        ? codeResolutions.get(sourceMention.canonicalCode.trim().toUpperCase()) ?? null
        : null);
    const previous = index >= 0 ? mentions[index] : null;
    const status: FederalMentionState['status'] = resolvedCode
      ? 'active'
      : 'pending_unknown_code';
    const next: FederalMentionState = {
      mentionKey,
      billId: observation.billId,
      provider: observation.provider,
      versionCode: observation.versionCode,
      locator: sourceMention.locator,
      rawCode: sourceMention.rawCode,
      canonicalCode: resolvedCode,
      quote: sourceMention.quote,
      status,
      lastRevisionKey: revisionKey,
    };

    if (!previous) {
      mentions.push(next);
      if (status === 'active') events.push(event('mention_added', observation.billId, revisionKey, next));
    } else {
      mentions[index] = next;
      if (previous.status === 'removed' && status === 'active') {
        events.push(event('mention_reinstated', observation.billId, revisionKey, next));
      } else if (previous.status === 'pending_unknown_code' && status === 'active') {
        events.push(event('mention_resolved', observation.billId, revisionKey, next));
      } else if (
        previous.status === 'active' &&
        status === 'active' &&
        (previous.quote !== next.quote || previous.canonicalCode !== next.canonicalCode)
      ) {
        events.push(event('mention_changed', observation.billId, revisionKey, next, previous));
      } else if (previous.status !== 'active' && status === 'active') {
        events.push(event('mention_added', observation.billId, revisionKey, next));
      }
    }
  }

  if (observation.inventoryComplete) {
    for (let index = 0; index < mentions.length; index += 1) {
      const mention = mentions[index]!;
      if (
        mention.billId !== observation.billId ||
        mention.provider !== observation.provider ||
        mention.versionCode !== observation.versionCode ||
        (mention.status !== 'active' && mention.status !== 'pending_unknown_code') ||
        seen.has(mention.mentionKey)
      )
        continue;
      const removed = { ...mention, status: 'removed' as const, lastRevisionKey: revisionKey };
      mentions[index] = removed;
      events.push(event('mention_removed', observation.billId, revisionKey, removed));
    }
  }

  const outbox = events.map((item) => ({
    dedupeKey: `federal-evidence:${item.eventKey}`,
    eventKey: item.eventKey,
    payload: item,
  }));
  return { state: { revisions, mentions }, events, outbox };
}
