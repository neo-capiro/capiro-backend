// Outreach v2 wizard, shared types.
//
// These mirror the data model in the design mockup. The context-item shape
// is the centerpiece of the v2 flow: every selected item carries a `scope`
// (either 'all' for shared, or a recipient id for per-recipient targeting)
// and an optional `note` that the user can write to bias the AI generation
// for that one item.

import type { OutreachRecipient } from '../../OutreachView.js';
import type { OutreachTarget } from './targets.js';

export type WizardDirection = 'on-behalf' | 'to-clients';

export type ContextKind =
  | 'bill'
  | 'stateBill'
  | 'intel'
  | 'email'
  | 'meeting'
  | 'note'
  | 'document'
  | 'debrief'
  | 'prep'
  | 'programElement';

export interface ContextPoolItem {
  id: string;
  kind: ContextKind;
  title: string;
  body?: string;
  sub?: string;
  tag?: string;
  // Recipient ids or client ids this item naturally maps to. The wizard uses
  // this for smart routing: when the user selects an item, we auto-set scope
  // to the matching recipient if there's exactly one match, else 'all'.
  matches?: string[];
  // Owning client (for the Docs/Notes, Debriefs, Preps tabs, which group their
  // pool by client). `clientId` null = unassigned; `clientName` is the resolved
  // display label. `date` (ISO) drives most-recent-first ordering.
  clientId?: string | null;
  clientName?: string;
  date?: string;
}

export interface SelectedContextItem extends ContextPoolItem {
  // 'all' = shared across every recipient. Otherwise a recipient.id.
  scope: 'all' | string;
  // Free-form instruction the user writes to the AI for this item only.
  note: string;
  /**
   * Phase 1 §3.b2 — for a CUSTOM NOTE only: whether the user's text is a FACT
   * the message may state, or an INSTRUCTION for how to write it.
   *
   * Defaults to 'instruction'. The default matters: "dinner last week went well"
   * as an instruction produces a warm reference, whereas as a fact it licenses
   * the model to narrate a dinner it knows nothing about.
   */
  noteUse?: 'fact' | 'instruction';
  /**
   * Phase 1 §3.d3 — set on AUTO-SUGGESTED email threads so the picker can explain
   * itself. Suggestions are never selected by default.
   */
  relevance?: 'high' | 'medium' | 'low';
  relevanceReasons?: string[];
  mailboxScope?: string;
}

// ── Phase 1: Context Used / source manifest (§3.j1) ─────────────────────────
// Mirrors apps/api/src/engagement/generation/generation-gateway.types.ts.

export interface SourceManifestEntry {
  sourceType: string;
  sourceId: string;
  title: string;
  trust: string;
  asOf: string | null;
  scope: string;
  relevance?: 'high' | 'medium' | 'low';
  relevanceReasons?: string[];
  truncated?: boolean;
}

export interface SourceFailure {
  sourceType: string;
  sourceId?: string;
  severity: 'informational' | 'important' | 'critical';
  code: string;
  userMessage: string;
}

export interface GenerationSourceManifest {
  contextPacketId: string;
  packetHash: string;
  evidenceCountsByType: Record<string, number>;
  included: SourceManifestEntry[];
  exclusions: Array<{ sourceType: string; sourceId?: string; reason: string }>;
  failures: SourceFailure[];
  criticalFailures: SourceFailure[];
  oldestSourceAt: string | null;
  newestSourceAt: string | null;
  policy: {
    policyId: string;
    version: string;
    label: string;
    jurisdiction: string;
    audienceType: string;
  };
  provider: string | null;
  model: string | null;
  planModel: string | null;
  promptSpecVersion: string;
  emailScopeLabel: string;
  standingMemoryCount: number;
  criticalMissingContext: string[];
  disclosures: string[];
}

/** The Phase 1 wire shape for one selected context item (§3.b1). */
export interface SelectedContextItemPayload {
  id: string;
  kind: ContextKind;
  scope: 'all' | string;
  userInstruction?: string;
  customNoteText?: string;
  noteUse?: 'fact' | 'instruction';
}

/**
 * Map wizard state onto the Phase 1 request payload.
 *
 * Sends IDENTIFIERS and the user's own words — never `title` or `body`. The
 * server rehydrates every server-backed source by id, so shipping a body would
 * at best be ignored and at worst be treated as authoritative text the browser
 * could edit. A custom note's text goes to `customNoteText`; on any other kind
 * the same `note` field is a per-item directive.
 */
export function toContextItemPayload(item: SelectedContextItem): SelectedContextItemPayload {
  const text = item.note?.trim() ?? '';
  if (item.kind === 'note') {
    return {
      id: item.id,
      kind: item.kind,
      scope: item.scope,
      ...(text ? { customNoteText: text } : {}),
      noteUse: item.noteUse === 'fact' ? 'fact' : 'instruction',
    };
  }
  return {
    id: item.id,
    kind: item.kind,
    scope: item.scope,
    ...(text ? { userInstruction: text } : {}),
  };
}

// ── Phase 0: server-owned draft lifecycle ────────────────────────────────────
// These mirror apps/api/src/engagement/outreach-draft.types.ts. The wizard is a
// READER of this lifecycle: it must never decide sendability itself, which is
// exactly the bug Phase 0 closes (a local edit used to flip a rejected draft to
// 'edited' and thereby make it sendable with no server verdict at all).

export type DraftGenerationStatus = 'generated' | 'manually_authored' | 'generation_failed';

export type DraftAuditStatus =
  | 'not_required'
  | 'pending'
  | 'passed'
  | 'warning'
  | 'held'
  | 'unavailable';

export type DraftApprovalStatus = 'not_required' | 'pending' | 'approved' | 'rejected';

/** One entry in a draft's version history strip (metadata only, no text). */
export interface DraftHistoryEntry {
  id: string;
  version: number;
  auditStatus: DraftAuditStatus;
  approvalStatus: DraftApprovalStatus;
  createdAt: string;
}

/**
 * One editable draft slot in wizard state.
 *
 * `versionId` + the three lifecycle fields are SERVER state. `dirty` and
 * `localStatus` are the only client-owned fields, and neither can make a draft
 * sendable — `dirty` can only ever make it LESS sendable, because unsaved text
 * has by definition not been audited.
 */
export interface GeneratedDraft {
  subject: string;
  body: string;

  /** The immutable server version this text came from. Absent = not persisted. */
  versionId?: string;
  artifactId?: string;
  version?: number;
  generationStatus?: DraftGenerationStatus;
  auditStatus?: DraftAuditStatus;
  approvalStatus?: DraftApprovalStatus;
  reviewRequestId?: string;
  /** Server-computed sendability of `versionId`. Never derived client-side. */
  sendable?: boolean;
  /** Internal note for the lobbyist only — never sent to the recipient. */
  contextNote?: string;
  /**
   * Why the LAST generation attempt for this slot failed, in the case where the
   * slot already held a draft and therefore KEPT it (see applyGenerationFailure).
   *
   * Presentation only. It deliberately says nothing about whether the retained
   * text is sendable — the version lifecycle above decides that, and a draft whose
   * regenerate failed is still backed by the audited version it already had.
   * Cleared once an attempt succeeds.
   */
  failureReason?: string;
  history?: DraftHistoryEntry[];
  /**
   * Phase 1 §3.j — what this draft was grounded in, what was excluded, and what
   * failed. A CRITICAL failure here blocks Send: the user must resolve it, and
   * the panel names the remediation.
   */
  manifest?: GenerationSourceManifest;

  /**
   * The editor has unsaved keystrokes. Set the instant a user types, cleared
   * only when the server returns a new audited version.
   */
  dirty?: boolean;
  /** Presentation-only hint; NOT a sendability signal. */
  localStatus?: 'saving' | 'conflict' | 'save_failed';

  /**
   * Pre-Phase-0 sendability signal, still used when the server reports
   * `versionedOutreachEnabled: false`. When `versionId` is present this is
   * ignored — the lifecycle fields above are authoritative.
   */
  status?: 'pending' | 'ready' | 'edited' | 'error' | 'held';

  /**
   * Prior text kept for one-click Revert after an "Improve" (W2.6). Under
   * versioning, Revert POSTs this text as a NEW version rather than restoring
   * it in place.
   */
  localHistory?: Array<{ subject: string; body: string }>;
}

export interface WizardV2State {
  direction: WizardDirection | null;
  clientId: string | null;
  campaignName: string;
  /**
   * Outreach 2.0 recipient model: mixed Individual/List/Group targets with
   * per-type cc/bcc (see targets.ts). Source of truth for who gets emailed.
   */
  targets: OutreachTarget[];
  /**
   * Legacy flat projection of `targets` (flattenTargets) consumed by the
   * not-yet-rebuilt downstream steps (context/generate/send). Derived —
   * never edit directly once targets exist.
   */
  recipients: OutreachRecipient[];
  contextItems: SelectedContextItem[];
  templateId: string | null;
  // Canonical lowercase tone — matches the values the template-create modal and
  // the backend prompt use, so one value flows end-to-end (display labels are
  // capitalized in the Select; resume lowercases legacy 'Professional' values).
  tone: 'professional' | 'friendly' | 'formal' | 'concise';
  /**
   * Per-target generated drafts, keyed by GenerationTargetKey (see
   * generation.ts): `individual:<rk>` | `list:<aid>:<rk>` | `group:<aid>`.
   * Individuals + list members get one draft each; a group gets one shared
   * draft. (`appliesTo` is derived from the key prefix, so the value shape is
   * unchanged.)
   */
  generatedEmails: Record<string, GeneratedDraft>;
  /** Generate & Review: the GenerationTargetKey of the draft being edited. */
  selectedGenerationKey: string | null;
  /** EngagementAttachment ids to attach to the generated emails on send. */
  attachmentIds: string[];
  /**
   * Signature of the generation inputs (context items + template + tone +
   * direction) captured at the last FULL generation. When the live inputs no
   * longer match this, Generate & Review shows a "context changed — regenerate"
   * banner. null = nothing generated yet (no banner).
   */
  generatedInputSig: string | null;
  /**
   * Phase 2 §3.g — recipient-collision acknowledgement. Only "Keep all
   * messages" needs persisting: "Remove …"/"Merge …" choices mutate `targets`
   * directly, which makes the collision disappear on its own. `fingerprint`
   * is collisionsFingerprint() of the collision set this was acknowledged
   * against (see targets.ts) — any target change that alters the collision
   * set invalidates it, so Send re-checks against the CURRENT fingerprint,
   * never a stale one. null = nothing acknowledged yet.
   */
  collisionResolution: { fingerprint: string; keepAllEmails: string[] } | null;
}

export const INITIAL_V2_STATE: WizardV2State = {
  direction: null,
  clientId: null,
  campaignName: '',
  targets: [],
  recipients: [],
  contextItems: [],
  templateId: null,
  tone: 'professional',
  generatedEmails: {},
  selectedGenerationKey: null,
  attachmentIds: [],
  generatedInputSig: null,
  collisionResolution: null,
};

export const WIZARD_STEPS = [
  { id: 'direction', label: 'Direction' },
  // Campaign Setup names the campaign AND chooses the template — the
  // standalone Template step was folded into this one.
  { id: 'setup', label: 'Campaign Setup' },
  { id: 'recipients', label: 'Recipients' },
  { id: 'context', label: 'Build Context' },
  { id: 'generate', label: 'Generate & Review' },
  { id: 'send', label: 'Send' },
] as const;

export type WizardStepId = (typeof WIZARD_STEPS)[number]['id'];

/** Stable id for a recipient, same logic used by the older wizard. */
export function recipientKey(r: OutreachRecipient): string {
  return r.id || r.directoryContactId || r.email || r.name || JSON.stringify(r);
}

/**
 * Canonicalize a persisted tone to the lowercase enum. Lowercases legacy
 * capitalized values ('Professional' → 'professional') saved before the enum
 * was canonicalized, and falls back to the default for anything unrecognized —
 * so resuming an old draft never silently resets or crashes on a bad tone.
 */
export function normalizeTone(raw: unknown): WizardV2State['tone'] {
  const lowered = typeof raw === 'string' ? raw.toLowerCase() : '';
  return lowered === 'professional' ||
    lowered === 'friendly' ||
    lowered === 'formal' ||
    lowered === 'concise'
    ? (lowered as WizardV2State['tone'])
    : INITIAL_V2_STATE.tone;
}
