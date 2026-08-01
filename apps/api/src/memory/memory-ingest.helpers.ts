// Institutional Memory — Phase 2 ingestion renderers (plan §3).
//
// Pure functions that map source-system records (email threads, meetings,
// debriefs, Meri sessions) into canonical MemoryItems. The ingestion WORKER
// (separate, I/O layer) fetches rows + makes the client-scoping decision, then
// calls these to produce items; MemoryStoreService.upsertSystem persists them.
//
// Keeping the mapping pure makes the highest-risk behavior testable without a
// DB: client-scoping fidelity (#4), one-canonical-location routing (#7), and
// machine-vs-human section ownership.
//
// CLIENT-SCOPING (#4): we do NOT re-implement relevance here. The worker passes
// the already-decided `clientId` (from the product's existing client-scoping
// function) plus the participant domains it deemed in-scope. These renderers
// only record that decision — they never widen it. A thread with clientId=null
// stays user-private (routed to the user vault by vaultPathForItem).

import type { MemoryItem, MemorySource } from './memory.types.js';
import { MEMORY_SCHEMA_VERSION, defaultMemoryGovernanceFields } from './memory.types.js';

function base(
  tenantId: string,
  source: MemorySource,
  sourceRef: string,
  ts: string,
): Pick<
  MemoryItem,
  | 'id'
  | 'tenantId'
  | 'aliases'
  | 'source'
  | 'sourceRef'
  | 'provenance'
  | 'createdAt'
  | 'updatedAt'
  | 'schemaVersion'
  | 'status'
  | 'lastConfirmedAt'
  | 'reviewCadenceDays'
  | 'supersedesId'
  | 'contradictsId'
  | 'sensitivity'
  | 'retentionPolicy'
  | 'legalHold'
  | 'revokedAt'
  | 'revokedBy'
  | 'exportable'
  | 'trainingUse'
> {
  return {
    id: '',
    tenantId,
    aliases: [],
    source,
    sourceRef,
    provenance: `ingest@${MEMORY_SCHEMA_VERSION}`,
    createdAt: ts,
    updatedAt: ts,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    ...defaultMemoryGovernanceFields(),
  };
}

export interface EmailThreadInput {
  tenantId: string;
  threadId: string;
  subject: string;
  /** Decided by the product's client-scoping logic; null => user-private. */
  clientId: string | null;
  /** The user who owns this inbox (always set; thread is theirs). */
  ownerUserId: string;
  /** Participant domains the scoping logic deemed in-scope (#4 audit trail). */
  inScopeDomains: string[];
  messageCount: number;
  lastMessageAt: string;
  /** Machine summary of the thread (generated, engine-owned). */
  summary: string;
  /** Linked entities the worker resolved, rendered as wikilinks. */
  wikilinks: string[];
}

/**
 * Email thread -> MemoryItem.
 * - client-linked  => visibility 'tenant', clientId set (routes to client vault)
 * - not client-linked => visibility 'user', clientId null (stays user-private)
 * This is the structural enforcement of #7 (one canonical location) and #4
 * (scope is recorded, never widened).
 */
export function emailThreadToItem(input: EmailThreadInput): MemoryItem {
  const isClientScoped = input.clientId !== null;
  const summaryBody = [
    input.summary.trim(),
    '',
    `_Messages: ${input.messageCount} · Last: ${input.lastMessageAt}_`,
    input.wikilinks.length ? `\nRelated: ${input.wikilinks.join(' ')}` : '',
  ]
    .join('\n')
    .trimEnd();

  return {
    ...base(input.tenantId, 'graph-email', input.threadId, input.lastMessageAt),
    clientId: input.clientId,
    ownerUserId: isClientScoped ? null : input.ownerUserId,
    type: 'thread',
    visibility: isClientScoped ? 'tenant' : 'user',
    entityId: null,
    slug: input.threadId,
    title: input.subject || '(no subject)',
    tags: ['email', ...(isClientScoped ? ['client'] : ['private'])],
    sections: [
      { key: 'summary', heading: 'Thread summary', owner: 'engine', body: summaryBody },
      {
        key: 'scope',
        heading: 'Scope',
        owner: 'engine',
        body: `In-scope domains: ${input.inScopeDomains.join(', ') || '(none)'}`,
      },
      { key: 'analyst-notes', heading: 'Analyst notes', owner: 'human', body: '' },
    ],
  };
}

export interface MeetingInput {
  tenantId: string;
  meetingId: string;
  clientId: string; // meetings are always client-scoped in the product
  title: string;
  date: string; // yyyy-mm-dd
  prep: string; // machine-assembled prep (engine-owned)
  wikilinks: string[];
  /** Decrypted debrief content, ONLY for tenant-readable debriefs. Rendered as
   *  an engine-owned section so it is never treated as human md and never
   *  embedded (embeddableText only embeds human sections). Omit to leave blank. */
  debriefBody?: string;
}

/** Meeting prep -> MemoryItem under the client's meetings/ folder (#7). */
export function meetingToItem(input: MeetingInput): MemoryItem {
  const slug = `${input.date}-${slugify(input.title)}`;
  return {
    ...base(input.tenantId, 'meeting-service', input.meetingId, `${input.date}T00:00:00.000Z`),
    clientId: input.clientId,
    ownerUserId: null,
    type: 'meeting',
    visibility: 'tenant',
    entityId: input.meetingId,
    slug,
    title: input.title,
    tags: ['meeting', 'prep'],
    sections: [
      {
        key: 'prep',
        heading: 'Prep',
        owner: 'engine',
        body: [
          input.prep.trim(),
          input.wikilinks.length ? `\nRelated: ${input.wikilinks.join(' ')}` : '',
        ]
          .join('\n')
          .trimEnd(),
      },
      { key: 'debrief', heading: 'Debrief', owner: 'human', body: '' },
      ...(input.debriefBody && input.debriefBody.trim()
        ? [
            {
              key: 'debrief-recorded',
              heading: 'Debrief (recorded)',
              owner: 'engine' as const,
              body: `${input.debriefBody.trim()}\n\n_Projected from the meeting debrief (tenant-visible). Not embedded._`,
            },
          ]
        : []),
    ],
  };
}

export interface MeriSessionInput {
  tenantId: string;
  sessionId: string;
  ownerUserId: string;
  clientId: string | null;
  title: string;
  endedAt: string;
  transcriptSummary: string; // distilled, NOT the raw transcript
  wikilinks: string[];
}

/**
 * Meri session -> MemoryItem, ALWAYS user-private (plan §12.1). Promotion to
 * firm memory is a separate, human-confirmed step — never auto from here.
 */
export function meriSessionToItem(input: MeriSessionInput): MemoryItem {
  return {
    ...base(input.tenantId, 'meri', input.sessionId, input.endedAt),
    clientId: input.clientId,
    ownerUserId: input.ownerUserId,
    type: 'meri-session',
    visibility: 'user', // private by default — promotion is human-gated
    entityId: null,
    slug: input.sessionId,
    title: input.title || 'Meri session',
    tags: ['meri', 'private'],
    sections: [
      {
        key: 'summary',
        heading: 'Session summary',
        owner: 'engine',
        body: [
          input.transcriptSummary.trim(),
          input.wikilinks.length ? `\nRelated: ${input.wikilinks.join(' ')}` : '',
        ]
          .join('\n')
          .trimEnd(),
      },
      { key: 'analyst-notes', heading: 'Analyst notes', owner: 'human', body: '' },
    ],
  };
}

/**
 * A candidate firm-memory promotion distilled from a private item (plan §12.1).
 * The distiller proposes this; the user confirms before it is appended to a
 * firm note. Pure shaping only — no auto-write.
 */
export interface PromotionCandidate {
  fromItemId: string;
  targetType: 'client-soul' | 'client-people' | 'playbook';
  targetClientId: string | null;
  distilledText: string;
}

export function buildPromotionCandidate(
  fromItem: MemoryItem,
  targetType: PromotionCandidate['targetType'],
  distilledText: string,
): PromotionCandidate {
  return {
    fromItemId: fromItem.id,
    targetType,
    targetClientId: fromItem.clientId,
    distilledText: distilledText.trim(),
  };
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'untitled'
  );
}
