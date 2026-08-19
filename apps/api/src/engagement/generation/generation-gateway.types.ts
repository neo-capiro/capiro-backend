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
import type { ReasoningEffort } from './reasoning-effort.js';

export interface GenerationRequest {
  /** Exact runtime authority for provider and credential boundaries. */
  runtimeAction?: 'outreach_generate' | 'outreach_v3_generate';
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
  /**
   * User-supplied example emails, used as few-shot exemplars for VOICE ONLY.
   *
   * Deliberately a first-class request field rather than another
   * `SelectedContextItemRef`: an evidence item flows into the Evidence Packet,
   * the Message Plan's claim pool and the deterministic claim verifier, and a
   * pasted old email is none of those things. Routing it through `items` would
   * let last quarter's numbers become this campaign's "supported claims". The
   * prompt renders these inside the untrusted-content spotlight and says
   * explicitly that they establish no facts.
   */
  styleSamples?: GatewayStyleSample[];
  /** Revision mode. */
  existingSubject?: string | null;
  existingBody?: string | null;
  reviseInstruction?: string | null;
  /** Pinned identity from the job, when this is an async chunk (§3.k). */
  pinned?: PinnedGenerationIdentity | null;
  /** Injected for determinism in tests. */
  now?: Date;
  packetId?: string;
  /**
   * The inbound request's own Authorization header, forwarded so an 'intel' item
   * can be rehydrated from intel-api's alert-packet endpoint under the caller's
   * already-verified identity (AlertPacketClientService).
   *
   * This is NOT optional in practice for a caller that lets users select intel
   * items: AlertPacketClientService returns null without it, which
   * resolveIntelAlert records as a CRITICAL failure, which blocks the whole
   * draft. The legacy path threaded it (enrichOutreachContextItems); the gateway
   * accepted it two hops up and dropped it here, so every intel item became a
   * blocked draft the moment ENGAGEMENT_GENERATION_GATEWAY was turned on.
   */
  authHeader?: string;
}

/** One user-supplied exemplar email. Voice only; never evidence. */
export interface GatewayStyleSample {
  /** Derived content hash, so the manifest can name a sample without its text. */
  sampleKey: string;
  label: string | null;
  subject: string | null;
  body: string;
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
  /** Server-resolved source types for a shared recipient group. */
  sourceTypes?: string[];
  /** Server-resolved government level for an individual or homogeneous group. */
  governmentLevel?: 'federal' | 'state' | 'local' | 'agency' | 'corporate' | 'unknown' | null;
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
  /**
   * Reasoning depth pinned for the whole operation, alongside provider/model and
   * for the same reason: an async job's later chunks must reason as deeply as its
   * first one, or one campaign's drafts vary in quality by whichever container
   * happened to claim them. `null` means no reasoning parameter was requested.
   */
  reasoningEffort?: ReasoningEffort | null;
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
  /** The reasoning depth actually requested, or null when the model takes none. */
  reasoningEffort: string | null;
  promptSpecVersion: string;
  /** Mailbox breadth, verbatim: "My mailbox" | "Firm-shared client history". */
  emailScopeLabel: string;
  /** Standing-memory items applied (style/framing only). */
  standingMemoryCount: number;
  /**
   * User-supplied exemplars applied (voice only). A COUNT, matching
   * standingMemoryCount's precedent: the manifest is rendered to everyone who
   * can see the draft, and an exemplar is verbatim prior correspondence.
   */
  styleSampleCount: number;
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
