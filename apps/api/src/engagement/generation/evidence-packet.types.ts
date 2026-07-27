/**
 * Evidence Packet v2 contracts (Phase 1 §3.a3).
 *
 * The packet is the trust boundary of Engagement generation. It records, for one
 * generation operation, exactly four kinds of input — and the type system is what
 * keeps them apart, because collapsing them is the bug this phase closes:
 *
 *   authoritative_structured  server-rehydrated canonical truth (bill status,
 *                             PE funding series). Quotable as fact.
 *   server_record             a server-owned record (recipient identity, prep,
 *                             debrief, directory row). Quotable, but describes
 *                             our own data, not the world.
 *   external_untrusted        email excerpts, extracted documents, press. ALWAYS
 *                             rendered inside spotlight markers; instruction-like
 *                             text inside it is data, never a directive.
 *   user_authored             text the AUTHENTICATED user typed. May become a
 *                             directive (see AuthenticatedDirective) but still
 *                             cannot override the system/output contract.
 *   standing_memory           Context Compiler steering output. Style/framing
 *                             only — it can never prove that an event occurred.
 *
 * Nothing in this module may ever carry an API key, an OAuth token, a raw
 * provider response, or unbounded binary data: a packet is persisted, readable
 * by tenant admins through the provenance panel, and retained.
 */

/** How much authority a piece of packet content carries. */
export type EvidenceTrust =
  | 'authoritative_structured'
  | 'server_record'
  | 'external_untrusted'
  | 'user_authored'
  | 'standing_memory';

/** Where one piece of evidence came from, and how fresh it is. */
export interface EvidenceSourceRef {
  /** Stable machine type: 'bill' | 'stateBill' | 'programElement' | 'email' | … */
  sourceType: string;
  /** The SERVER's id for the source (never a browser-supplied composite). */
  sourceId: string;
  title: string;
  clientId?: string | null;
  /** Recipient keys this source is scoped to ([] = shared across the batch). */
  recipientKeys?: string[];
  /** When the underlying record was created (ISO), if known. */
  sourceCreatedAt?: string | null;
  /**
   * The as-of date of the FACTS in this source (ISO) — a bill's statusAt, a PE
   * series' cycle, a thread's last activity. Distinct from retrievedAt: a source
   * fetched a second ago can still assert a six-month-old fact.
   */
  authoritativeAsOf?: string | null;
  /** When THIS packet read the source (ISO). */
  retrievedAt: string;
  trust: EvidenceTrust;
  /** Small scalar provenance detail (row counts, statuses, truncation flags). */
  provenance?: Record<string, string | number | boolean | null>;
}

/** One included piece of evidence: a ref plus its bounded rendered text. */
export interface EvidenceItem {
  ref: EvidenceSourceRef;
  /** The bounded excerpt/rendering handed to the model. Never unbounded. */
  evidenceText: string;
  /**
   * Machine-readable canonical truth behind `evidenceText`, when the source is
   * authoritative_structured. The deterministic verifier compares drafted
   * numbers and stages against THIS, not against the prose.
   */
  structuredTruth?: Record<string, unknown>;
  /** 'all' = shared across every recipient; else a recipient key. */
  scope: 'all' | string;
  relevanceScore?: number;
  relevanceReasons?: string[];
}

/**
 * Something the AUTHENTICATED user told us to do. This is the only channel the
 * prompt renders as an instruction — external evidence never is, no matter what
 * it contains. A directive still cannot override the system prompt, the output
 * contract, or the compliance guardrails.
 */
export interface AuthenticatedDirective {
  id: string;
  kind: 'objective' | 'template' | 'tone' | 'length' | 'item_instruction' | 'custom_note';
  text: string;
  scope: 'all' | string;
  /** The user whose session supplied it. Never a value read out of evidence. */
  authenticatedUserId: string;
}

/**
 * A source that could not be used. Recorded, surfaced, and (when critical)
 * blocking — never silently converted into an empty string, which is how the
 * pre-Phase-1 path turned a failed lookup into a confidently ungrounded draft.
 */
export interface SourceFailure {
  sourceType: string;
  sourceId?: string;
  severity: 'informational' | 'important' | 'critical';
  /** Stable machine code for tests/telemetry (SCREAMING_SNAKE). */
  code: string;
  /** What the user should see and do about it. No internal detail, no PII. */
  userMessage: string;
}

/** A steering-memory item the Context Compiler included (trace reference only). */
export interface StandingMemoryRef {
  layer: string;
  id: string;
  type: string;
  slug: string;
  chars: number;
}

/** A steering-memory item the Context Compiler deliberately excluded. */
export interface StandingMemoryExclusion {
  layer: string;
  id: string;
  type: string;
  slug: string;
  reason: string;
}

/** The resolved government-affairs policy identity for this generation. */
export interface PacketPolicyRef {
  jurisdiction: string;
  audienceType: string;
  policyId: string;
  version: string;
}

/**
 * The pinned provider/model identity. Resolved ONCE per operation (or per async
 * job) BEFORE the first LLM call, so a mid-campaign fallback can never split one
 * send across two provider voices, and so the packet records what actually ran.
 */
export interface PacketModelPolicy {
  provider: string | null;
  model: string | null;
  /** The planning model, when the plan ran on a different (fast) model. */
  planModel?: string | null;
  promptSpecVersion: string;
  usedTenantKey?: boolean;
}

/** Which generation surface a packet was compiled for. */
export type GenerationSurface =
  | 'outreach_email'
  | 'meeting_prep'
  | 'meeting_debrief'
  | 'talking_points';

/**
 * The complete, immutable record of what one generation was grounded in.
 *
 * Persisted to `context_packet` (packet_version=2). For external outreach the
 * write is SYNCHRONOUS and fail-closed: without a durable packet there is no
 * provenance for a message that leaves the building, so generation stops.
 */
export interface EvidencePacketV2 {
  packetId: string;
  packetVersion: 2;
  tenantId: string;
  userId: string;
  clientId: string | null;
  surface: GenerationSurface;
  /** Surface-local anchor: { outreachRecordId?, meetingId?, campaignId? }. */
  ref: Record<string, string | null>;

  directives: AuthenticatedDirective[];
  evidence: EvidenceItem[];
  standingMemory: StandingMemoryRef[];
  standingMemoryExclusions: StandingMemoryExclusion[];
  failures: SourceFailure[];

  policy: PacketPolicyRef;
  modelPolicy: PacketModelPolicy;

  /** Denormalized from `failures` so gates need no JSONB scan. */
  criticalFailureCount: number;
  freshestSourceAt: string | null;
  stalestSourceAt: string | null;
  compiledAt: string;
  /** sha256 over the canonical, stable-key-ordered packet JSON. */
  packetHash: string;
  /**
   * How the mailbox that contributed email evidence was scoped. Surfaced to the
   * user verbatim ("My mailbox" / "Firm-shared client history") so the provenance
   * panel never has to guess.
   */
  emailScope: EmailContextScope;
}

/** Mailbox breadth for email evidence. Defaults to the current user's mailbox. */
export type EmailContextScope = 'mine' | 'firm_shared';

export const EMAIL_SCOPE_LABELS: Record<EmailContextScope, string> = {
  mine: 'My mailbox',
  firm_shared: 'Firm-shared client history',
};

// ── Bounds (Phase 1 §3.h3) ──────────────────────────────────────────────────
// Exported so the resolvers, the extractor, and the tests share ONE definition
// rather than three drifting copies of "how much is too much".

/** Max characters of any single evidence item's text inside a packet. */
export const MAX_EVIDENCE_ITEM_CHARS = 20_000;
/** Max characters an extraction may store/return for document inspection. */
export const MAX_EXTRACTED_CHARS = 100_000;
/** Max pages read from a paginated document (PDF / PPTX-like). */
export const MAX_EXTRACTION_PAGES = 200;
/** Max spreadsheet rows / columns read. */
export const MAX_SPREADSHEET_ROWS = 5_000;
export const MAX_SPREADSHEET_COLS = 50;
/** Wall-clock ceiling for one extraction. */
export const EXTRACTION_TIMEOUT_MS = 30_000;

/** Max characters of an authenticated per-item instruction. */
export const MAX_USER_INSTRUCTION_CHARS = 2_000;
/** Max characters of a user-authored custom note. */
export const MAX_CUSTOM_NOTE_CHARS = 8_000;

/**
 * Truncate to a bound and report whether it bit. The caller records the flag in
 * provenance so the packet's source manifest can SAY the item was truncated —
 * silent truncation reads to the model (and the reviewer) as a complete document.
 */
export function boundEvidenceText(
  text: string,
  max = MAX_EVIDENCE_ITEM_CHARS,
): { text: string; truncated: boolean } {
  const trimmed = text.trim();
  if (trimmed.length <= max) return { text: trimmed, truncated: false };
  return { text: `${trimmed.slice(0, max - 1).trim()}…`, truncated: true };
}

/** Build a SourceFailure with a stable code. */
export function sourceFailure(
  sourceType: string,
  code: string,
  severity: SourceFailure['severity'],
  userMessage: string,
  sourceId?: string,
): SourceFailure {
  return { sourceType, code, severity, userMessage, ...(sourceId ? { sourceId } : {}) };
}

/**
 * Deterministic evidence ordering: scope, then source type, then source date
 * DESCENDING (newest first), then source id. Two identical requests must produce
 * a byte-identical packet — that is what makes the packet hash meaningful, and
 * what lets the cacheable prompt prefix actually hit.
 */
export function compareEvidence(a: EvidenceItem, b: EvidenceItem): number {
  if (a.scope !== b.scope) {
    // 'all' (shared) sorts before recipient-scoped items.
    if (a.scope === 'all') return -1;
    if (b.scope === 'all') return 1;
    return a.scope < b.scope ? -1 : 1;
  }
  if (a.ref.sourceType !== b.ref.sourceType) {
    return a.ref.sourceType < b.ref.sourceType ? -1 : 1;
  }
  const aAt = a.ref.authoritativeAsOf ?? a.ref.sourceCreatedAt ?? '';
  const bAt = b.ref.authoritativeAsOf ?? b.ref.sourceCreatedAt ?? '';
  if (aAt !== bAt) return aAt > bAt ? -1 : 1; // newest first
  if (a.ref.sourceId === b.ref.sourceId) return 0;
  return a.ref.sourceId < b.ref.sourceId ? -1 : 1;
}

/** Deterministic directive ordering: kind, then scope, then id. */
const DIRECTIVE_KIND_ORDER: Record<AuthenticatedDirective['kind'], number> = {
  objective: 0,
  template: 1,
  tone: 2,
  length: 3,
  item_instruction: 4,
  custom_note: 5,
};

export function compareDirectives(a: AuthenticatedDirective, b: AuthenticatedDirective): number {
  const ka = DIRECTIVE_KIND_ORDER[a.kind];
  const kb = DIRECTIVE_KIND_ORDER[b.kind];
  if (ka !== kb) return ka - kb;
  if (a.scope !== b.scope) {
    if (a.scope === 'all') return -1;
    if (b.scope === 'all') return 1;
    return a.scope < b.scope ? -1 : 1;
  }
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** Deterministic failure ordering: severity (critical first), type, code, id. */
const SEVERITY_ORDER: Record<SourceFailure['severity'], number> = {
  critical: 0,
  important: 1,
  informational: 2,
};

export function compareFailures(a: SourceFailure, b: SourceFailure): number {
  const sa = SEVERITY_ORDER[a.severity];
  const sb = SEVERITY_ORDER[b.severity];
  if (sa !== sb) return sa - sb;
  if (a.sourceType !== b.sourceType) return a.sourceType < b.sourceType ? -1 : 1;
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  const ia = a.sourceId ?? '';
  const ib = b.sourceId ?? '';
  if (ia === ib) return 0;
  return ia < ib ? -1 : 1;
}

/**
 * Canonical JSON with STABLE key ordering at every depth. `JSON.stringify` emits
 * keys in insertion order, so two structurally identical packets built by
 * different code paths would otherwise hash differently — which would make the
 * packet hash useless as an identity.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined) continue; // undefined is not representable in JSON
    out[key] = canonicalize(v);
  }
  return out;
}
