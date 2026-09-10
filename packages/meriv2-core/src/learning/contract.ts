/**
 * LearningSignal — Phase 27A canonical schema (Institutional Learning & Quality).
 *
 * A LearningSignal is evidence that Capiro MAY have learned something worth
 * considering for future reuse. It is captured directly from existing product
 * behavior (explicit feedback, accept/reject decisions) — it is NEVER itself
 * active memory. Capturing a signal must never write to `memory_items`,
 * `memory_candidate`, or `clio_memory`; promotion into governed institutional
 * memory is a later, separate phase (27B+) that goes through the existing
 * MemoryCandidateService / governance lifecycle in `../memory/governance.ts`.
 * This module only defines what gets captured and how — not what happens to
 * it afterward.
 *
 * Reuses the existing governance vocabulary (`MemoryClass`, `MemoryAuthority`,
 * `MemorySensitivity`) and the frozen five-layer `SteeringLayer` union rather
 * than inventing parallel ones, so a signal's "proposed" fields are always
 * expressible in terms the existing governance system already understands.
 */
import {
  MEMORY_AUTHORITIES,
  type MemoryAuthority,
  type MemoryClass,
  type MemorySensitivity,
} from '../memory/governance.js';
import type { SteeringLayer } from '../context/contract.js';

/**
 * Product surfaces a LearningSignal can originate from. Closed list, enforced
 * by a DB CHECK constraint — adding a new surface (meetings, outreach,
 * workspace, strategies, meri.research, ...) is a deliberate follow-up
 * migration + adapter, not a silent runtime addition. Only the two 27A
 * adapters are listed; see the Phase 27 handoff for the intended rollout
 * order of the rest.
 */
export const LEARNING_SIGNAL_SOURCE_SURFACES = ['meri.chat', 'crm.fill_with_meri'] as const;
export type LearningSignalSourceSurface = (typeof LEARNING_SIGNAL_SOURCE_SURFACES)[number];

/**
 * Canonical signal types. Each maps to exactly one capture adapter. Adding a
 * value requires a migration (CHECK constraint) plus a new adapter — never
 * inferred ad hoc from free-form strings.
 */
export const LEARNING_SIGNAL_TYPES = [
  'meri_feedback_positive',
  'meri_feedback_negative',
  'crm_finding_accepted',
  'crm_finding_rejected',
] as const;
export type LearningSignalType = (typeof LEARNING_SIGNAL_TYPES)[number];

/**
 * How this signal came to exist. This is the field the anti-feedback-loop
 * guard below keys off: an AI's own output, with no human confirmation, can
 * never by itself justify a human-tier `sourceAuthority`.
 */
export const LEARNING_SIGNAL_PROVENANCE_KINDS = [
  /** A human directly stated or decided this (thumbs-down + reason, accept, reject). */
  'human_explicit',
  /** Inferred from a human action that wasn't a direct statement (e.g. a silent regenerate). Reserved — no 27A adapter emits this yet. */
  'human_implicit',
  /** Produced by a model call with no human confirmation. Must never carry human-tier authority. */
  'ai_generated_only',
  /** Computed by a Capiro pipeline (e.g. repetition detection), not a single human action or a single AI call. Reserved for 27B+. */
  'system_derived',
] as const;
export type LearningSignalProvenanceKind = (typeof LEARNING_SIGNAL_PROVENANCE_KINDS)[number];

const HUMAN_PROVENANCE_KINDS: ReadonlySet<LearningSignalProvenanceKind> = new Set([
  'human_explicit',
  'human_implicit',
]);

/**
 * Subset of `MEMORY_AUTHORITIES` that represents a human (or an authoritative
 * external system) standing behind a claim, as opposed to `working_draft`,
 * `model_inferred`, or `legacy_unclassified`. Only these may be paired with a
 * human provenance kind — see {@link assertNoAiSelfCorroboration}.
 */
export const HUMAN_TIER_MEMORY_AUTHORITIES: ReadonlySet<MemoryAuthority> = new Set([
  'firm_approved',
  'client_approved',
  'external_authoritative',
  'user_asserted',
  'analyst_verified',
]);

// Sanity check that the human-tier set only references real MemoryAuthority values.
void (MEMORY_AUTHORITIES satisfies readonly MemoryAuthority[]);

/**
 * Whether a promoted-memory decision on this signal needs a human in the
 * loop. Fail-closed default is `human_required` — nothing in 27A ever
 * computes `auto_eligible` (no promotion logic exists yet); it exists in the
 * vocabulary so 27D's governance-policy work has somewhere to write a real
 * decision without a schema change.
 */
export const LEARNING_SIGNAL_GOVERNANCE_REQUIREMENTS = [
  'human_required',
  'auto_eligible',
  'unknown',
] as const;
export type LearningSignalGovernanceRequirement =
  (typeof LEARNING_SIGNAL_GOVERNANCE_REQUIREMENTS)[number];

/**
 * Lifecycle status of the signal row itself (not of any downstream memory).
 * 27A only ever writes `captured`. `discarded` exists for a future
 * housekeeping pass (e.g. withdrawn feedback); later phases add
 * `candidate_created` / `promoted` / `rejected` / `superseded` once 27B/27C
 * ship — adding those is a migration, not a silent enum widening.
 */
export const LEARNING_SIGNAL_STATUSES = ['captured', 'discarded'] as const;
export type LearningSignalStatus = (typeof LEARNING_SIGNAL_STATUSES)[number];

/** A pointer to an authoritative source object — never a copy of its content. */
export interface LearningSignalEvidenceRef {
  readonly type: string;
  readonly id: string;
}

const FROZEN_STEERING_LAYERS: ReadonlySet<SteeringLayer> = new Set([
  'firm-identity',
  'firm-playbook',
  'user-voice',
  'client-steering',
  'client-people',
]);

/**
 * Runtime guard against a sixth context layer sneaking in through a JSON
 * boundary (adapters build this object from request/DB data, not from a
 * statically-checked literal, so the TS union alone isn't enough).
 */
export function assertKnownSteeringLayer(layer: SteeringLayer | null | undefined): void {
  if (layer != null && !FROZEN_STEERING_LAYERS.has(layer)) {
    throw new Error(
      `assertKnownSteeringLayer: "${layer}" is not one of the five frozen context layers (firm-identity, firm-playbook, user-voice, client-steering, client-people).`,
    );
  }
}

/**
 * The core invariant from the Phase 27 handoff: "self-learning != self-
 * approving" and "AI output cannot self-corroborate." A signal whose
 * provenance is AI-only (no human confirmed it) must never carry a
 * human-tier `sourceAuthority` — that would let a model's own claim, fed
 * back through repeated exposure, look like independent human evidence.
 */
export function assertNoAiSelfCorroboration(
  input: Pick<CaptureLearningSignalInput, 'provenanceKind' | 'sourceAuthority'>,
): void {
  if (
    input.sourceAuthority &&
    HUMAN_TIER_MEMORY_AUTHORITIES.has(input.sourceAuthority) &&
    !HUMAN_PROVENANCE_KINDS.has(input.provenanceKind)
  ) {
    throw new Error(
      `assertNoAiSelfCorroboration: sourceAuthority "${input.sourceAuthority}" is human-tier but provenanceKind is "${input.provenanceKind}" — AI-generated content cannot be its own evidence. A human must explicitly confirm before this authority level may be used.`,
    );
  }
}

/**
 * "Missing evidence fails where required" (Phase 27 handoff §24): a signal
 * that proposes a memory layer without pointing at anything is not usable
 * evidence for anything downstream — reject it at capture time rather than
 * letting an evidence-less proposal reach 27B's candidate stage.
 */
export function assertEvidencePresentWhenProposingMemory(
  input: Pick<CaptureLearningSignalInput, 'proposedMemoryLayer' | 'evidenceRefs'>,
): void {
  if (
    input.proposedMemoryLayer != null &&
    (!input.evidenceRefs || input.evidenceRefs.length === 0)
  ) {
    throw new Error(
      'assertEvidencePresentWhenProposingMemory: a signal proposing a memory layer must carry at least one evidence reference.',
    );
  }
}

/**
 * Input to `LearningSignalCaptureService.capture()`. `actorUserId` must
 * always come from the caller's authenticated `TenantContext`, never from a
 * client-supplied payload field — a signal is only ever attributed to the
 * person who actually took the action.
 */
export interface CaptureLearningSignalInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly clientId?: string | null;
  readonly sourceSurface: LearningSignalSourceSurface;
  readonly sourceObjectType: string;
  readonly sourceObjectId: string;
  readonly sourceRunId?: string | null;
  readonly signalType: LearningSignalType;
  readonly proposedMemoryLayer?: SteeringLayer | null;
  readonly proposedMemoryClass?: MemoryClass | null;
  readonly evidenceRefs: readonly LearningSignalEvidenceRef[];
  readonly confidence?: number | null;
  readonly sourceAuthority?: MemoryAuthority | null;
  readonly sensitivity?: MemorySensitivity;
  readonly provenanceKind: LearningSignalProvenanceKind;
  /** Safe structured metadata only — never a raw message/document body. */
  readonly provenance?: Readonly<Record<string, unknown>>;
  readonly governanceRequirement?: LearningSignalGovernanceRequirement;
  /** When the underlying product event happened (not when it was captured). */
  readonly observedAt: Date;
}

/**
 * Global capture kill switch (Phase 27 handoff §27: "production
 * signal-capture can be disabled/rolled back independently"). Unlike the
 * governance flags in `governance.ts` (dark-by-default, armed only by the
 * literal `'enforce'`), this defaults to ON: capturing a signal is inert —
 * no downstream effect, nothing else reads `learning_signal` yet — so the
 * safer default is capturing, with an explicit same-day escape hatch
 * (`LEARNING_SIGNAL_CAPTURE=disabled`, no redeploy) if capture itself ever
 * needs to stop. Pure function, same style as `governedMemoryLifecycleEnabled`
 * — callers pass `process.env.LEARNING_SIGNAL_CAPTURE` explicitly rather
 * than this module reading it internally, so it stays trivially testable.
 */
export function learningSignalCaptureEnabled(raw: string | undefined): boolean {
  return (
    String(raw ?? '')
      .trim()
      .toLowerCase() !== 'disabled'
  );
}

/**
 * Deterministic dedupe key for idempotent capture. Deliberately narrow: the
 * same (surface, source object, signal type, actor) tuple is one logical
 * event no matter how many times it's delivered (retry, double-submit). A
 * genuinely different judgment (e.g. the user flips their rating from up to
 * down) has a different `signalType` and is correctly a new row, not a
 * dedupe collision.
 */
export function computeLearningSignalIdempotencyKey(
  input: Pick<
    CaptureLearningSignalInput,
    'sourceSurface' | 'sourceObjectType' | 'sourceObjectId' | 'signalType' | 'actorUserId'
  >,
): string {
  return [
    input.sourceSurface,
    input.sourceObjectType,
    input.sourceObjectId,
    input.signalType,
    input.actorUserId,
  ].join(':');
}
