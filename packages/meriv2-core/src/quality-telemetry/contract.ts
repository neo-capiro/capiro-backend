/**
 * QualityTelemetryEvent — Phase 27E canonical schema (Institutional Learning
 * quality telemetry).
 *
 * A telemetry event records that a product operation happened and, where
 * knowable, which ContextPacket and which memory items fed it. It is
 * strictly OBSERVE-ONLY: recording an event must never write to
 * `learning_signal`, `memory_candidate`, or `memory_items`, and never
 * changes what a product surface does. It also never asserts causation — a
 * packet being included and an output being accepted are two independent
 * facts recorded side by side, not "the packet caused the acceptance" (see
 * the Phase 27E handoff §21). Causal/evaluation work is a later phase.
 *
 * The one deliberate divergence from `../learning/contract.ts`'s capture
 * pattern: `LearningSignalCaptureService.capture()` throws on bad input by
 * design, because a signal is evidence that must commit atomically with the
 * product action it describes (§ its own doc comment). Quality telemetry has
 * no such atomicity requirement and an explicit failure-semantics rule of
 * its own (Phase 27E handoff §27: "telemetry must never break the user
 * workflow"), so the safety net (catch everything, never throw) lives inside
 * `QualityTelemetryCaptureService` itself rather than being left to each of
 * six call sites to remember.
 */
import { assertKnownSteeringLayer } from '../learning/contract.js';
import type { SteeringLayer } from '../context/contract.js';

/**
 * Product surfaces a telemetry event can originate from. Closed list —
 * adding one is a deliberate follow-up (adapter + this array), not a silent
 * runtime addition, matching `LEARNING_SIGNAL_SOURCE_SURFACES`.
 */
export const QUALITY_TELEMETRY_SURFACES = [
  'outreach',
  'workspace',
  'crm_fill',
  'meetings',
  'strategies',
  'meri',
] as const;
export type QualityTelemetrySurface = (typeof QUALITY_TELEMETRY_SURFACES)[number];

/**
 * Canonical outcome vocabulary (Phase 27E handoff §19). Deliberately small
 * and shared across every surface — do not add product-specific detail here
 * (e.g. "duplicate", "informational" for CRM Fill); put that in
 * `provenance.reasonCode` instead. `unknown` is a legitimate, recordable
 * value: it means "we observed this event but could not classify its
 * outcome," never "skip recording."
 */
export const QUALITY_TELEMETRY_EVENT_TYPES = [
  'generated',
  'edited',
  'regenerated',
  'approved',
  'rejected',
  'held',
  'superseded',
  'corrected',
  'feedback_positive',
  'feedback_negative',
  'ignored',
  'unknown',
] as const;
export type QualityTelemetryEventType = (typeof QUALITY_TELEMETRY_EVENT_TYPES)[number];

/**
 * Bare polymorphic artifact-type discriminator (paired with a bare
 * `artifactId` string — see the Prisma model doc comment for why this can
 * never be a real FK). Closed list for the same reason the event-type
 * vocabulary is closed: a new surface is a deliberate addition here, not an
 * ad hoc string a caller invents.
 */
export const QUALITY_TELEMETRY_ARTIFACT_TYPES = [
  'outreach_draft_version',
  'workspace_doc_version',
  'crm_fill_finding',
  'meeting_prep',
  'meeting_debrief',
  'strategy_node',
  'strategy_change_set',
  'meri_message',
] as const;
export type QualityTelemetryArtifactType = (typeof QUALITY_TELEMETRY_ARTIFACT_TYPES)[number];

/** One memory item included in the packet behind a telemetry event. */
export interface QualityTelemetryMemoryItemUseInput {
  readonly memoryItemId: string;
  readonly contextLayer: SteeringLayer;
}

/** Safe, numeric-only edit-burden metrics. See `assertNoConfidentialContent`. */
export interface QualityTelemetryEditMetrics {
  readonly percentChanged?: number;
  readonly normalizedEditDistance?: number;
  readonly versionsCount?: number;
  readonly timeToNextEditMs?: number;
  readonly timeToApprovalMs?: number;
  readonly sectionReplacementCount?: number;
  readonly regenerateCount?: number;
}

/** Counts only, never item bodies. Any layer omitted is treated as unknown, not zero. */
export interface QualityTelemetryContextLayerCounts {
  readonly firmIdentity?: number;
  readonly firmPlaybook?: number;
  readonly userVoice?: number;
  readonly clientSteering?: number;
  readonly clientPeople?: number;
}

/**
 * Input to `QualityTelemetryCaptureService.recordEvent()`. `actorUserId`
 * must come from the caller's authenticated context, never a client-supplied
 * payload field, same rule as `CaptureLearningSignalInput.actorUserId`.
 */
export interface RecordQualityTelemetryEventInput {
  readonly tenantId: string;
  readonly actorUserId?: string | null;
  readonly clientId?: string | null;
  readonly surface: QualityTelemetrySurface;
  readonly operation: string;
  readonly eventType: QualityTelemetryEventType;
  readonly artifactType?: QualityTelemetryArtifactType | null;
  readonly artifactId?: string | null;
  readonly artifactVersionSeq?: number | null;
  readonly contextPacketId?: string | null;
  readonly contextLayerCounts?: QualityTelemetryContextLayerCounts | null;
  readonly memoryItemUses?: readonly QualityTelemetryMemoryItemUseInput[];
  readonly learningSignalId?: string | null;
  readonly memoryCandidateId?: string | null;
  readonly editMetrics?: QualityTelemetryEditMetrics | null;
  /** Short safe reason codes / correlation ids only — see `assertNoConfidentialContent`. */
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly traceId?: string | null;
  /** When the underlying product event happened (not when it was recorded). */
  readonly generatedAt?: Date | null;
  readonly observedAt: Date;
}

/**
 * Field-name and value-shape denylist enforced at write time (Phase 27E
 * handoff §10: "no confidential-body analytics"). This is a defense-in-depth
 * runtime guard, not the only control — reviewers must still catch a caller
 * that, say, puts a whole paragraph under an innocuous key. Two checks:
 *  1. No banned key names anywhere in `provenance`/`editMetrics`/
 *     `contextLayerCounts`, at any nesting depth (case-insensitive).
 *  2. No string value longer than `MAX_SAFE_STRING_LENGTH` anywhere in those
 *     same objects — long strings are the shape of a body, not a metric.
 */
const BANNED_CONTENT_KEYS = new Set([
  'body',
  'text',
  'content',
  'transcript',
  'prompt',
  'response',
  'message',
  'summary',
  'notes',
  'note',
  'excerpt',
  'draft',
  'subject',
]);
const MAX_SAFE_STRING_LENGTH = 200;

export function assertNoConfidentialContent(
  input: Pick<
    RecordQualityTelemetryEventInput,
    'provenance' | 'editMetrics' | 'contextLayerCounts'
  >,
): void {
  for (const [label, value] of [
    ['provenance', input.provenance],
    ['editMetrics', input.editMetrics],
    ['contextLayerCounts', input.contextLayerCounts],
  ] as const) {
    if (value != null) walk(label, value);
  }

  function walk(path: string, value: unknown): void {
    if (value == null) return;
    if (typeof value === 'string') {
      if (value.length > MAX_SAFE_STRING_LENGTH) {
        throw new Error(
          `assertNoConfidentialContent: "${path}" carries a string of ${value.length} chars — quality telemetry stores metadata (ids, hashes, counts, enums, reason codes), never document/message bodies.`,
        );
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(`${path}[${i}]`, item));
      return;
    }
    if (typeof value === 'object') {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        if (BANNED_CONTENT_KEYS.has(key.toLowerCase())) {
          throw new Error(
            `assertNoConfidentialContent: "${path}.${key}" uses a banned field name — quality telemetry must never carry a body/text/content/transcript/prompt/response/message/summary/note/excerpt/draft/subject field, even if the value looks short today.`,
          );
        }
        walk(`${path}.${key}`, nested);
      }
    }
  }
}

/**
 * Runtime guard against a sixth context layer sneaking in through a JSON
 * boundary — delegates to the frozen definition in `../learning/contract.js`
 * rather than duplicating it, so there is exactly one place that lists the
 * five layers.
 */
export function assertKnownContextLayer(layer: SteeringLayer): void {
  assertKnownSteeringLayer(layer);
}

/**
 * Global capture kill switch. Unlike `learningSignalCaptureEnabled` (default
 * ON — capture is inert, nothing reads it yet), this defaults OFF: Phase 27E
 * is a new always-on write path across six product surfaces the moment it's
 * armed, so it follows `learningCandidateGenerationEnabled`'s dark-by-default
 * convention instead — only the literal `enabled` (case/whitespace
 * insensitive) turns it on. Pure function, env read passed in explicitly by
 * the caller so this stays trivially testable.
 */
export function qualityTelemetryEnabled(raw: string | undefined): boolean {
  return (
    String(raw ?? '')
      .trim()
      .toLowerCase() === 'enabled'
  );
}

/**
 * Deterministic dedupe key for idempotent recording (Phase 27E handoff §28).
 * Deliberately keyed on the underlying event/version relationship — the same
 * (surface, artifact, event type, version) tuple is one logical event no
 * matter how many times it's delivered (retry, at-least-once redelivery). A
 * genuinely new lifecycle step (e.g. version 2 generated after version 1 was
 * edited) has a different `artifactVersionSeq` or `eventType` and is
 * correctly a new row, not a dedupe collision.
 */
export function computeQualityTelemetryIdempotencyKey(
  input: Pick<
    RecordQualityTelemetryEventInput,
    'surface' | 'artifactType' | 'artifactId' | 'eventType' | 'artifactVersionSeq'
  >,
): string {
  return [
    input.surface,
    input.artifactType ?? 'none',
    input.artifactId ?? 'none',
    input.eventType,
    input.artifactVersionSeq != null ? String(input.artifactVersionSeq) : 'none',
  ].join(':');
}
