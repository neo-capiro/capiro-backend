/**
 * Generation Gateway request/result contracts, including the Context-Used source
 * manifest returned to the UI (Phase 1 §3.g1 / §3.j1).
 *
 * Separate from the service so the web app's contract tests and the controller
 * DTOs can import the shapes without pulling in Nest providers.
 */
import type { GenerationSurface, SourceFailure } from './evidence-packet.types.js';
import type { SelectedContextItemRef } from './evidence-source.service.js';
import type { GaAudience } from './government-affairs-policy.registry.js';
import type { PlanValidationIssue } from './message-plan.schema.js';

export interface GenerationRequest {
  surface: GenerationSurface;
  clientId: string | null;
  /** Phase 0 parent record (required for outreach_email). */
  outreachRecordId?: string | null;
  /** Surface anchor persisted on the packet. */
  ref?: Record<string, string | null>;
  items: SelectedContextItemRef[];
  /** The system/custom template driving the message. */
  templateId: string;
  /** Resolved template prompt text (an authenticated directive). */
  templatePrompt: string;
  /** Freeform objective, when the caller supplies one instead of a template. */
  objective?: string | null;
  tone: 'professional' | 'friendly' | 'formal' | 'concise';
  length?: 'short' | 'standard' | 'long' | null;
  direction?: 'on-behalf' | 'to-clients' | null;
  audienceKind: 'individual' | 'group';
  groupMemberCount?: number;
  /** An explicit audience choice, when the user made one. */
  explicitAudience?: GaAudience | null;
  /** The server-resolved recipient (never a browser assertion for identity). */
  recipient: GatewayRecipient;
  /** Revision mode. */
  existingSubject?: string | null;
  existingBody?: string | null;
  reviseInstruction?: string | null;
  /** Pinned identity from the job, when this is an async chunk (§3.k). */
  pinned?: PinnedGenerationIdentity | null;
  /** Injected for determinism in tests. */
  now?: Date;
  packetId?: string;
}

export interface GatewayRecipient {
  /** Stable slot key (the wizard's GenerationTargetKey). */
  generationKey: string;
  /** Every identifier this recipient may be scoped by. */
  scopeKeys: string[];
  recipientKey: string;
  name: string | null;
  email: string | null;
  title: string | null;
  office: string | null;
  state: string | null;
  district: string | null;
  /** Server-resolved directory source type, drives policy selection. */
  sourceType: string | null;
  chamber: string | null;
  defenseAcquisition?: boolean;
  /** The full snapshot persisted on the Phase 0 artifact. */
  snapshot: Record<string, unknown>;
}

/**
 * The provider/model identity pinned for a whole operation or async job (§3.k).
 * Resolved ONCE, before the first LLM call, and reused by every chunk.
 */
export interface PinnedGenerationIdentity {
  provider: string;
  model: string;
  planModel: string | null;
  promptSpecVersion: string;
  policyId: string;
  policyVersion: string;
  /** The campaign-static packet, when the job pinned one. */
  contextPacketId?: string | null;
}

/** One included source, as the UI shows it. Never carries restricted content. */
export interface SourceManifestEntry {
  sourceType: string;
  sourceId: string;
  title: string;
  trust: string;
  asOf: string | null;
  scope: string;
  /** Present for ranked email. */
  relevance?: 'high' | 'medium' | 'low';
  relevanceReasons?: string[];
  truncated?: boolean;
}

/**
 * Everything the Context Used panel needs (§3.j1).
 *
 * Deliberately carries SUMMARIES: titles, ids, counts, dates. Not bodies. The
 * panel is rendered to whoever can see the draft, which is a wider audience than
 * whoever may read a restricted debrief or a colleague's mailbox.
 */
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
  policy: { policyId: string; version: string; label: string; jurisdiction: string; audienceType: string };
  provider: string | null;
  model: string | null;
  planModel: string | null;
  promptSpecVersion: string;
  /** Mailbox breadth, verbatim: "My mailbox" | "Firm-shared client history". */
  emailScopeLabel: string;
  /** Standing-memory items applied (style/framing only). */
  standingMemoryCount: number;
  /** What the user must resolve before this can be sent. */
  criticalMissingContext: string[];
  /** Attachment/scan disclosures the UI must show. */
  disclosures: string[];
}

export type GenerationOutcome = 'ready' | 'held' | 'blocked' | 'error';

export interface GenerationResult {
  outcome: GenerationOutcome;
  generationKey: string;
  recipientKey: string;
  subject: string;
  body: string;
  /** Internal note for the author only. Never sent to a recipient. */
  contextNote?: string;
  manifest: GenerationSourceManifest;
  /** Phase 0 version refs, when a version was persisted. */
  artifactId?: string;
  versionId?: string;
  version?: number;
  generationStatus?: string;
  auditStatus?: string;
  approvalStatus?: string;
  reviewRequestId?: string;
  /** Server-computed. Callers MUST NOT derive sendability themselves. */
  sendable: boolean;
  /** Set when outcome==='blocked' | 'error'. */
  error?: string;
  /** Structured reasons a plan was rejected, for a reviewable error. */
  planIssues?: PlanValidationIssue[];
  /** The identity this unit actually ran on, for the job to pin (§3.k). */
  pinned: PinnedGenerationIdentity;
}
