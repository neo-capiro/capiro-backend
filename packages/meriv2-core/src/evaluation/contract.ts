/**
 * EvaluationRecord — Phase 27F canonical schema (institutional-context
 * effectiveness evaluation).
 *
 * Phase 27E (`../quality-telemetry/contract.ts`) proved "context X was
 * present, outcome Y followed" — an observational fact, never a causal
 * claim. Phase 27F adds the first CONTROLLED comparison: for a bounded,
 * deterministic sample of real requests, replay the same generation with
 * the five institutional SteeringLayers withheld (authoritative facts,
 * retrieval, and evidence stay identical) and record deterministic/product
 * metrics comparing the two outputs. This is still not proof of causation
 * for any single memory item — see `EvaluationRecord`'s doc comment — but it
 * is the first mechanism that can support "withholding institutional
 * context changed metric Z" for the sampled population.
 *
 * Hard invariants enforced across this module and its callers (never
 * relaxed, guarded again in `scripts/check-evaluation-new-bypasses.mjs`):
 *  1. An evaluation NEVER mutates a production ContextPacket, memory item,
 *     memory candidate, LearningSignal, or governed product artifact. The
 *     control arm is a disposable in-memory projection (see
 *     `buildInstitutionalContextControlProjection`), never a write.
 *  2. An evaluation's judgment/output can NEVER become a LearningSignal or
 *     MemoryCandidate — no AI-evaluates-AI feedback loop into memory.
 *  3. A control replay's PROMPT/output bodies are never persisted here —
 *     only hashes, ids, and numeric/enum metrics (same discipline as
 *     `../quality-telemetry/contract.ts`'s `assertNoConfidentialContent`).
 *  4. Evaluation failure must never surface to (or block) the real request
 *     it shadows — same never-throw contract as
 *     `QualityTelemetryCaptureService.recordEvent`.
 */
import type { SteeringLayer } from '../context/contract.js';
import {
  QUALITY_TELEMETRY_SURFACES,
  type QualityTelemetrySurface,
} from '../quality-telemetry/contract.js';

export { QUALITY_TELEMETRY_SURFACES as EVALUATION_SURFACES };
export type EvaluationSurface = QualityTelemetrySurface;

/**
 * Closed list of comparison designs. Only one exists today (Phase 27F
 * §12: "all institutional context vs no institutional context"). A future
 * per-layer ablation study (§12: "can come later") is a new value here, not
 * a reinterpretation of this one.
 */
export const EVALUATION_TYPES = ['institutional_context_ablation'] as const;
export type EvaluationType = (typeof EVALUATION_TYPES)[number];

export const EVALUATION_STATUSES = [
  'pending',
  'running',
  'completed',
  'skipped',
  'failed',
] as const;
export type EvaluationStatus = (typeof EVALUATION_STATUSES)[number];

/**
 * Closed reason vocabulary for BOTH "not eligible" and "eligible but not
 * sampled" (Phase 27F §15: "Not every request should generate a control...
 * Record the reason. Do not silently skip."). One shared vocabulary so
 * `EvaluationRecord.skip_reason` never needs a second CHECK constraint for
 * whichever stage produced the skip.
 */
export const EVALUATION_SKIP_REASONS = [
  'feature_disabled',
  'not_sampled',
  'missing_packet',
  'missing_context',
  'no_institutional_context',
  'unsupported_operation',
  'sensitive_operation',
  'insufficient_authoritative_input',
  'provider_unavailable',
  'budget_exceeded',
] as const;
export type EvaluationSkipReason = (typeof EVALUATION_SKIP_REASONS)[number];

export type EvaluationEligibilityDecision =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: EvaluationSkipReason };

/**
 * Bundled version string covering the eligibility policy, sampling policy,
 * control-projection policy, and metric rubric TOGETHER (Phase 27F §29 asks
 * for each to be independently versioned; this MVP bundles them into one
 * version so a first cut ships without four independent version tables —
 * a disclosed simplification. Bump this whenever ANY of the four changes,
 * even if the other three did not, so two records with the same version are
 * always safely comparable).
 */
export const EVALUATION_CONFIG_VERSION = 'evaluation-config-v1';

/** One control-projection policy exists today: strip all five layers. */
export const EVALUATION_PROJECTION_POLICIES = ['withhold_all_institutional_layers'] as const;
export type EvaluationProjectionPolicy = (typeof EVALUATION_PROJECTION_POLICIES)[number];

/**
 * Global kill switch, dark by default — same shape and polarity as
 * `qualityTelemetryEnabled` (a brand-new phase must never activate itself
 * merely by being deployed). Pure function; the caller passes
 * `process.env.LEARNING_EVALUATION` in explicitly so this stays testable
 * without env mutation.
 */
export function evaluationEnabled(raw: string | undefined): boolean {
  return (
    String(raw ?? '')
      .trim()
      .toLowerCase() === 'enabled'
  );
}

const DEFAULT_SAMPLE_RATE = 0;
const MIN_SAMPLE_RATE = 0;
const MAX_SAMPLE_RATE = 1;

/**
 * Bounded sampling rate in [0, 1], dark by default (0 — no sampling until a
 * rate is deliberately configured, independent of `evaluationEnabled`).
 * Pure function, explicit env-string input.
 */
export function evaluationSampleRate(raw: string | undefined): number {
  const parsed = Number(String(raw ?? '').trim());
  if (!Number.isFinite(parsed)) return DEFAULT_SAMPLE_RATE;
  return Math.min(MAX_SAMPLE_RATE, Math.max(MIN_SAMPLE_RATE, parsed));
}

export interface EvaluationEligibilityInput {
  readonly enabled: boolean;
  /** The operation's own ContextPacket id, if one was resolved for this request. */
  readonly contextPacketId: string | null;
  /** How many of the five institutional layers actually survived into the packet (0 = nothing to withhold). */
  readonly institutionalItemCount: number;
  /** True when the operation cannot be replayed deterministically from a frozen snapshot (Phase 27F §18). */
  readonly authoritativeInputReplayable: boolean;
  /** True when the surface/operation has a registered evaluation runner at all. */
  readonly operationSupported: boolean;
  /** True when this operation touches content an evaluation must never read (e.g. an ethical-wall-restricted turn). */
  readonly sensitive?: boolean;
  /** True when the configured provider/model for the control call is currently reachable. */
  readonly providerAvailable: boolean;
  /** True when the configured per-window evaluation spend/volume budget still has room. */
  readonly withinBudget: boolean;
}

/**
 * Pure eligibility gate, checked BEFORE the (also pure) sampling decision.
 * Order matters: a request that is not eligible at all must never consume a
 * sample slot or be recorded as "not_sampled" — the two reasons are
 * distinct facts (§15's own list keeps them separate).
 */
export function decideEvaluationEligibility(
  input: EvaluationEligibilityInput,
): EvaluationEligibilityDecision {
  if (!input.enabled) return { eligible: false, reason: 'feature_disabled' };
  if (!input.operationSupported) return { eligible: false, reason: 'unsupported_operation' };
  if (input.sensitive) return { eligible: false, reason: 'sensitive_operation' };
  if (!input.contextPacketId) return { eligible: false, reason: 'missing_packet' };
  if (!input.authoritativeInputReplayable) {
    return { eligible: false, reason: 'insufficient_authoritative_input' };
  }
  if (input.institutionalItemCount <= 0) {
    return { eligible: false, reason: 'no_institutional_context' };
  }
  if (!input.providerAvailable) return { eligible: false, reason: 'provider_unavailable' };
  if (!input.withinBudget) return { eligible: false, reason: 'budget_exceeded' };
  return { eligible: true };
}

/**
 * Deterministic sampling key. Same (tenant, operation, artifact) always
 * hashes to the same bucket, so a retry of the same underlying request
 * reaches the same sample decision (Phase 27F §16/§28) instead of flipping a
 * coin twice.
 */
export function computeEvaluationSamplingKey(input: {
  readonly tenantId: string;
  readonly operation: string;
  readonly artifactId: string;
}): string {
  return [input.tenantId, input.operation, input.artifactId].join(':');
}

/**
 * Maps a sampling key deterministically onto [0, 1) via SHA-256 — no
 * `Math.random()` (forbidden in this repo's tooling anyway, but also wrong
 * here: sampling must be reproducible for the same key, not merely random).
 */
export function deterministicUnitInterval(key: string): number {
  // Lazy require so this module has no hard Node-only import at the top of
  // a file otherwise usable from either runtime — matches
  // `../context/context-rollout.ts`'s own `createHash` usage style.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  const digest = createHash('sha256').update(key).digest('hex');
  const bucket = parseInt(digest.slice(0, 8), 16);
  return bucket / 0x100000000;
}

/** True with probability ~= `rate`, deterministically, for a given key. */
export function shouldSampleForEvaluation(key: string, rate: number): boolean {
  if (rate <= MIN_SAMPLE_RATE) return false;
  if (rate >= MAX_SAMPLE_RATE) return true;
  return deterministicUnitInterval(key) < rate;
}

/**
 * Structural, packet-shape-agnostic control projection (Phase 27F §32).
 * Strips every institutional SteeringLayer item — `items`, `rendered`,
 * `exclusions` — while leaving every other field (evidenceRefs,
 * coverageManifest, resolvedEntities, subjectScope, sourceHealth,
 * sourceFreshness, retrievalCompleteness, packetId, health, ...)
 * byte-identical, because those fields carry authoritative facts and
 * coverage truth, never steering-layer content (confirmed: every entry in
 * `items`/`rendered` in `../context/contract.ts` carries a `layer:
 * SteeringLayer` field; there is no non-layer item in either array).
 *
 * Never mutates its input — returns a new plain object via shallow spread,
 * matching `compileCoverageAwareContextPacket`'s own convention of
 * `{ ...packet, ... }` rather than mutating in place. The projection is
 * fed ONLY into a fresh prompt-render call for the control arm; it is never
 * persisted as a real ContextPacket and never replaces the original in any
 * store (§32: "Keep: original packet immutable, original packet id
 * referenced").
 */
export function buildInstitutionalContextControlProjection<
  T extends { items?: unknown; rendered?: unknown; exclusions?: unknown },
>(packet: T): T & { evaluationProjectionPolicy: EvaluationProjectionPolicy } {
  return {
    ...packet,
    items: [],
    rendered: [],
    exclusions: withheldExclusions(packet.exclusions),
    evaluationProjectionPolicy: 'withhold_all_institutional_layers',
  };
}

const FROZEN_STEERING_LAYERS: readonly SteeringLayer[] = [
  'firm-identity',
  'firm-playbook',
  'user-voice',
  'client-steering',
  'client-people',
];

function withheldExclusions(existing: unknown): unknown[] {
  const prior = Array.isArray(existing) ? existing : [];
  return [
    ...prior,
    ...FROZEN_STEERING_LAYERS.map((layer) => ({
      layer,
      reason: 'evaluation_control_withheld',
    })),
  ];
}

/**
 * Deterministic dedupe key (Phase 27F §28: retrying the same job must not
 * create a duplicate provider call or a duplicate record unless explicitly
 * configured as a new trial). Includes `configVersion` deliberately: a
 * deliberate re-evaluation under a new rubric/policy is a NEW row, not a
 * collision with the old one.
 */
export function computeEvaluationIdempotencyKey(input: {
  readonly surface: EvaluationSurface;
  readonly operation: string;
  readonly treatmentArtifactId: string;
  readonly treatmentArtifactVersionSeq?: number | null;
  readonly evaluationType: EvaluationType;
  readonly configVersion: string;
}): string {
  return [
    input.surface,
    input.operation,
    input.treatmentArtifactId,
    input.treatmentArtifactVersionSeq != null ? String(input.treatmentArtifactVersionSeq) : 'none',
    input.evaluationType,
    input.configVersion,
  ].join(':');
}

/** Safe, numeric/enum-only deterministic metrics. Never a diff or body. */
export interface EvaluationDeterministicMetrics {
  readonly [dimension: string]: number | boolean | string | null;
}

/**
 * Optional bounded model-judge result (Phase 27F §21). Only ever produced
 * for qualities that cannot be scored deterministically. `armOrder` records
 * whether treatment/control was presented first/second to the judge so a
 * later audit can check for position bias — it never reveals which arm was
 * treatment (the judge itself must be blinded, §21).
 */
export interface EvaluationJudgeResult {
  readonly judgeModel: string;
  readonly judgeVersion: string;
  readonly rubricVersion: string;
  readonly armOrder: 'treatment_first' | 'control_first';
  readonly dimensions: Readonly<Record<string, number>>;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

/**
 * Cost accounting for the ONE incremental provider call an evaluation adds
 * (Phase 27F §24). `null` means "unknown" and must never be coerced to 0 —
 * a provider that doesn't report usage is a gap in the cost model, not a
 * free call.
 */
export interface EvaluationCost {
  readonly model: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly providerDurationMs: number | null;
  readonly estimatedCostUsd: number | null;
}

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

/**
 * Same discipline as `../quality-telemetry/contract.ts`'s
 * `assertNoConfidentialContent`, scoped to the objects an EvaluationRecord
 * actually stores (`metrics`, `judge.dimensions`, `cost`) — never a prompt
 * or output body, only ids/hashes/numbers/enums.
 */
export function assertNoConfidentialEvaluationContent(input: {
  readonly metrics?: unknown;
  readonly judge?: unknown;
  readonly cost?: unknown;
}): void {
  for (const [label, value] of [
    ['metrics', input.metrics],
    ['judge', input.judge],
    ['cost', input.cost],
  ] as const) {
    if (value != null) walk(label, value);
  }

  function walk(path: string, value: unknown): void {
    if (value == null) return;
    if (typeof value === 'string') {
      if (value.length > MAX_SAFE_STRING_LENGTH) {
        throw new Error(
          `assertNoConfidentialEvaluationContent: "${path}" carries a string of ${value.length} chars — an evaluation record stores metadata (ids, hashes, counts, enums, scores), never prompt/output bodies.`,
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
            `assertNoConfidentialEvaluationContent: "${path}.${key}" uses a banned field name — an evaluation record must never carry a body/text/content/transcript/prompt/response/message/summary/note/excerpt/draft/subject field, even if the value looks short today.`,
          );
        }
        walk(`${path}.${key}`, nested);
      }
    }
  }
}

/**
 * Input to `EvaluationCaptureService`. Two-phase by construction: a caller
 * first records `status: 'pending'|'skipped'` synchronously (never blocking
 * the real request), then a worker later transitions the same row to
 * `'running'` and finally `'completed'|'failed'` once the control replay
 * finishes (Phase 27F §17).
 */
export interface RecordEvaluationInput {
  readonly tenantId: string;
  readonly clientId?: string | null;
  readonly surface: EvaluationSurface;
  readonly operation: string;
  readonly evaluationType: EvaluationType;
  readonly status: EvaluationStatus;
  readonly skipReason?: EvaluationSkipReason | null;
  readonly failureReason?: string | null;
  readonly contextPacketId?: string | null;
  readonly qualityTelemetryEventId?: string | null;
  readonly treatmentArtifactType?: string | null;
  readonly treatmentArtifactId: string;
  readonly treatmentArtifactVersionSeq?: number | null;
  readonly treatmentOutputHash?: string | null;
  readonly controlOutputHash?: string | null;
  readonly controlProjectionPolicy?: EvaluationProjectionPolicy | null;
  readonly metrics?: EvaluationDeterministicMetrics | null;
  readonly judge?: EvaluationJudgeResult | null;
  readonly cost?: EvaluationCost | null;
  readonly samplingKey: string;
  readonly configVersion: string;
  readonly traceId?: string | null;
  readonly observedAt: Date;
}
