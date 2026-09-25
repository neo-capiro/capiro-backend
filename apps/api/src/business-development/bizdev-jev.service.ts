import {
  BD_ENTITY_QUESTION_VERSION,
  BD_SIGNAL_QUESTION_VERSION,
  JEV_TASK_REGISTRY,
  JEV_TASK_REGISTRY_VERSION,
  DEFAULT_JEV_MODEL,
  type EvidenceEnvelope,
  type EvidenceQuestion,
  type JevChoiceTaskDecision,
  type JevChoiceTaskProvider,
} from '@capiro/meriv2-core';
import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { resolveBdJevModes, bdJevGlobalEnabled, type BdJevMode, type BdJevTask } from './bizdev-jev-mode.js';
import type { EvidenceItem } from './bizdev-evidence.types.js';
import {
  bdJevIdempotencyKey,
  buildBdSignalQuestionFromCards,
  candidateInventoryHash,
  canonicalCandidateEvidenceItem,
  bdSourceHashesForTask,
  signalItemOutcome,
  stagedSignals,
} from './bizdev-jev-envelope.js';
import type { BdCandidateProjection } from './bizdev-jev-envelope.js';
import { buildBdEntityProspectQuestion } from './bizdev-jev-envelope-entity.js';

/**
 * Business Development Phase 3 — Jev shadow/canary evaluation service.
 *
 * Phase 2 dossier reads remain AUTHORITATIVE: the deterministic dossier JSON
 * is built first, byte-identically, and the caller returns it unchanged. This
 * service only launches DETACHED, budgeted evaluations (shadow) or composes
 * registry-gated canary PROJECTIONS that can never resolve, merge, or write
 * identity. One provider decision maximum per task per opened relevant
 * section, enforced by the shared registry budget (maxCalls: 1) plus the
 * persisted (tenant, idempotency-key) uniqueness: a re-open of the SAME
 * envelope is a no-op, a changed envelope (new source versions/candidates) is
 * a new key. No provider or source fetch happens in search, and no targeted
 * source lookup exists in this path at all (paired shadow is analysis-only).
 *
 * BD-ENTITY evaluates the UNRESOLVED PROSPECT organization (display name
 * only) against ONE bounded canonical candidate per opened identity section;
 * the evaluated candidate's UUID is stored in the trace's canonicalEntityId so
 * the identity-resolution review event can classify the decision (accepted
 * only when the evaluated candidate IS the resolved canonical id and the
 * outcome proposed same_legal_entity; otherwise corrected).
 *
 * Persistence: a redacted pending → completed/failed/skipped trace row per
 * evaluation under PrismaService.withTenant. No prompts, no passages, no
 * source text — only hashes, public source ids, typed outcomes, budgets and
 * review state. Packet-precondition failures (no explicitly staged source)
 * persist an explicit skipped trace, never a silent no-op.
 */

export type BizDevJevOperationalState =
  | 'not_checked'
  | 'provider_timeout'
  | 'malformed_result'
  | 'source_unavailable'
  | 'budget_exhausted';

/** Approved provider rate for BD tasks (USD per input token, registry priceVersion). */
const BD_JEV_INPUT_TOKEN_PRICE_USD = 0.042 / 1_000_000;

/** Map shared provider failure states to explicit BD operational states (never `unrelated`). */
function toBdOperationalState(state: string, reasonCodes: string[]): BizDevJevOperationalState {
  if (state === 'timeout' || state === 'cancelled') return 'provider_timeout';
  if (state === 'malformed_response') return 'malformed_result';
  if (state === 'document_unavailable') return 'source_unavailable';
  if (state === 'repair_budget_exhausted') return 'budget_exhausted';
  if (state === 'scope_refused') return 'not_checked';
  if (state === 'judge_unavailable') {
    return reasonCodes.includes('auth_failed') ? 'not_checked' : 'source_unavailable';
  }
  return 'not_checked';
}

/** Stable hash of a source-hash inventory (not the count): any change in the
 * source/candidate inventory or versions produces a different skipped-trace
 * idempotency key. */
function hashStrings(values: string[]): string {
  return values.length === 0
    ? 'empty'
    : createHash('sha256').update(values.join('\n'), 'utf8').digest('hex').slice(0, 24);
}

const QUESTION_VERSIONS: Record<BdJevTask, string> = {
  bd_entity: BD_ENTITY_QUESTION_VERSION,
  bd_signal: BD_SIGNAL_QUESTION_VERSION,
};

export const BIZDEV_JEV_FACTORY = Symbol('BIZDEV_JEV_FACTORY');

/** Review-event hook DI token — bound to BizDevJevService via useExisting in
 * the module; injectable as the BizDevJevReviewHook interface type. */
export const BIZDEV_JEV_REVIEW_HOOK = Symbol('BIZDEV_JEV_REVIEW_HOOK');

/** Concrete-class DI token for BizDevDossierService's optional dependency. */
export const BIZDEV_JEV_SERVICE = Symbol('BIZDEV_JEV_SERVICE');

/** Review-event hook contract (implemented by BizDevJevService). */
export interface BizDevJevReviewHook {
  recordIdentityReviewOutcome(input: {
    tenantId: string;
    prospectId: string;
    resolvedCanonicalEntityId: string;
    userId: string | null;
  }): Promise<void>;
}

/** Contract for the API-side provider factory (see bizdev-jev.factory.ts). */
export interface BizDevJevFactory {
  /** Envelope-bound choice provider for a task; unavailable config → null (refused). */
  createProvider(task: BdJevTask, tenantId: string): JevChoiceTaskProvider | null;
}

export interface BdJevProjection {
  task: BdJevTask;
  suggestion: 'review_required_candidate_match' | 'direct_fit' | 'possible_fit';
  effect: 'reorder_unresolved_review_candidates' | 'labeled_suggestion';
  downgradedFrom?: 'direct_fit';
  suggestedCandidateId?: string;
  requiresHumanReview: boolean;
  confidence: number;
}

export interface BdJevEvaluationRequest {
  ctx: TenantContext;
  task: BdJevTask;
  mode: Exclude<BdJevMode, 'off'>;
  subjectType: 'prospect' | 'company';
  subjectId: string;
  prospectId: string | null;
  canonicalEntityId: string | null;
  /** bd_entity: the ONE candidate being evaluated against the prospect. */
  candidate?: BdCandidateProjection;
  /** bd_entity: prospect display name (public, bounded). */
  prospectDisplayName?: string;
  evidence: EvidenceItem[];
  /**
   * Phase 2 BASELINE for the evaluated item (bd_signal: the mapped
   * deterministic relationship-strength classification of the ONE staged
   * evidence item sent to the provider — never a generic section status;
   * bd_entity: the deterministic identity-section state). This makes the
   * provider decision comparable to what the dossier already shows.
   */
  deterministicOutcome: string | null;
  companyName: string;
}

/** Explicit env injection token — never a bare Object dependency for Nest. */
export const BIZDEV_JEV_ENV = Symbol('BIZDEV_JEV_ENV');

@Injectable()
export class BizDevJevService {
  private readonly logger = new Logger(BizDevJevService.name);
  private readonly env: Record<string, string | undefined>;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(BIZDEV_JEV_FACTORY)
    private readonly providerFactory: BizDevJevFactory | null,
    @Optional() @Inject(BIZDEV_JEV_ENV) env?: Record<string, string | undefined>,
  ) {
    this.env = env ?? process.env;
  }

  /**
   * Test/pure construction helper — avoids optional un-tokened constructor
   * dependencies in the production Nest provider entirely.
   */
  static forTest(
    prisma: PrismaService,
    providerFactory: BizDevJevFactory | null,
    env: Record<string, string | undefined> = {},
  ): BizDevJevService {
    return new BizDevJevService(prisma, providerFactory, env);
  }

  /**
   * Fully detached launch: the ENTIRE chain — tenant mode resolution and the
   * budgeted evaluation — runs fire-and-forget. No awaited tenant-settings
   * read is ever on the dossier response path; shadow adds zero visible
   * latency and the off-mode dossier is returned byte-for-byte unchanged.
   *
   * The DEFAULT-OFF global kill switch (BIZDEV_JEV_ENABLED) is checked
   * SYNCHRONOUSLY here — before the detached chain, before any tenant
   * settings DB read, provider factory work or trace write — so the dark
   * deployment costs one boolean check and touches nothing else.
   */
  launchForSubject(input: BdJevEvaluationRequest): void {
    if (!bdJevGlobalEnabled(this.env)) return; // default-off: synchronous short-circuit
    void (async () => {
      try {
        const modes = await this.resolveModesForTenant(input.ctx.tenantId);
        const mode = modes[input.task].mode;
        if (mode === 'off') return;
        await this.runEvaluation({ ...input, mode });
      } catch (error) {
        this.logger.warn(
          `bizdev jev detached chain failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
  }

  /** Effective modes for a tenant (least-permissive combination; see bizdev-jev-mode.ts). */
  async resolveModesForTenant(tenantId: string) {
    const tenant = await this.prisma.withTenant(tenantId, (tx) =>
      tx.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } }),
    );
    return resolveBdJevModes({ env: this.env, tenantSettings: tenant?.settings ?? null });
  }

  /**
   * Detached, budgeted shadow/canary evaluation (mode pre-resolved by the
   * caller). Prefer launchForSubject, which resolves the mode internally.
   */
  launchDetachedEvaluation(input: BdJevEvaluationRequest): void {
    void this.runEvaluation(input).catch((error) => {
      // Never surface in the caller: shadow is observability-only.
      this.logger.warn(
        `bizdev jev detached evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  private async runEvaluation(input: BdJevEvaluationRequest) {
    const { ctx, task } = input;
    const provider = this.providerFactory?.createProvider(task, ctx.tenantId) ?? null;
    const registration = JEV_TASK_REGISTRY[task];
    const questionVersion = QUESTION_VERSIONS[task];
    const modelVersion = registration?.modelVersion ?? DEFAULT_JEV_MODEL;

    // bd_entity: the Phase 2 unresolved identity section has no evidence
    // cards, so build ONE minimal provider-only canonical-registry evidence
    // item from the evaluated candidate (public registry data only).
    const entityEvidence: EvidenceItem[] = task === 'bd_entity' && input.candidate
      ? [canonicalCandidateEvidenceItem(input.candidate)]
      : input.evidence;

    let envelope: EvidenceEnvelope | null = null;
    let question: EvidenceQuestion | null = null;
    let envelopeHash = '';
    let evaluatedCanonicalEntityId = input.canonicalEntityId;
    /** Phase 2 baseline for the evaluated item (see deterministicOutcome). */
    let baselineOutcome = input.deterministicOutcome;
    /** bd_signal: the ONE staged evidence item actually sent to the provider. */
    let evaluatedSignal: EvidenceItem | null = null;
    if (task === 'bd_entity') {
      if (input.candidate && input.prospectDisplayName) {
        const built = buildBdEntityProspectQuestion({
          tenantId: ctx.tenantId,
          prospectId: input.prospectId ?? input.subjectId,
          prospectDisplayName: input.prospectDisplayName,
          candidate: input.candidate,
          evidence: entityEvidence,
        });
        if (built) {
          envelope = built.envelope;
          question = built.question;
          envelopeHash = built.envelopeHash;
          evaluatedCanonicalEntityId = input.candidate.canonicalEntityId;
        }
      }
    } else {
      // BD-SIGNAL is ONE company + ONE specific signal/source passage: only
      // the FIRST deterministically ordered explicitly staged evidence item
      // is sent. The whole rest of the dossier signal list never reaches the
      // provider. The Phase 2 BASELINE persisted for the comparison is the
      // mapped deterministic classification of THAT item — never a generic
      // section availability status.
      const [single] = stagedSignals(input.evidence);
      evaluatedSignal = single ?? null;
      const baseline = single ? signalItemOutcome(single) : null;
      // The persisted baseline for bd_signal is ALWAYS the Phase 2 mapping of
      // the ONE staged item (null when nothing is staged) — never the generic
      // section availability status carried on the request.
      baselineOutcome = baseline;
      const built = single
        ? buildBdSignalQuestionFromCards({
            tenantId: ctx.tenantId,
            prospectId: input.prospectId,
            canonicalEntityId: input.canonicalEntityId,
            companyName: input.companyName,
            signals: [single],
          })
        : null;
      if (built) {
        envelope = built.envelope;
        question = built.question;
        envelopeHash = built.envelopeHash;
        baselineOutcome = baseline;
      }
    }

    // Hash exactly the evidence sent to the provider. For BD-SIGNAL that is the
    // single deterministically selected staged item, not later dossier items
    // that were never evaluated. This keeps the trace and cache key faithful to
    // the decision packet while still invalidating when that selected source
    // revision changes.
    const evaluatedEvidence = evaluatedSignal ? [evaluatedSignal] : entityEvidence;
    const sourceHashes = bdSourceHashesForTask(task, evaluatedEvidence);

    // Entity idempotency candidate hash: candidateInventoryHash over the
    // evaluated candidate (bdSourceHashesForTask cannot hash entity inventory).
    const candidateHash = task === 'bd_entity' && input.candidate
      ? candidateInventoryHash([input.candidate])
      : null;
    const idempotencyKey = envelope
      ? bdJevIdempotencyKey({
          tenantId: ctx.tenantId,
          task,
          mode: input.mode,
          questionVersion,
          modelVersion,
          registryVersion: JEV_TASK_REGISTRY_VERSION,
          envelopeHash,
          sourceHashes,
          candidateInventoryHash: candidateHash,
        })
      : null;

    // Idempotency source ids: EXACTLY the evidence that reaches the provider —
    // for bd_signal the ONE staged item; for bd_entity the candidate item.
    const sourceIds = evaluatedEvidence
      .map((item) => item.recordId ?? item.originalSourceId ?? 'unknown')
      .slice(0, 16);
    if (!idempotencyKey || !envelope || !question) {
      // Packet preconditions failed (no explicitly staged source, or a missing
      // prospect/candidate pair): persist an EXPLICIT skipped trace so the
      // coverage gap is auditable — never a silent no-op. The key is
      // version-sensitive (question/model/registry) AND source-revision
      // sensitive (bdSourceHashesForTask covers version/date/stage/locator),
      // so a re-open after a source revision or a registry/question version
      // bump records a NEW auditable gap rather than silently deduping.
      const skippedKey = [
        'skipped',
        ctx.tenantId,
        task,
        input.mode,
        input.subjectId,
        questionVersion,
        modelVersion,
        JEV_TASK_REGISTRY_VERSION,
        hashStrings(sourceHashes),
        envelopeHash || 'none',
      ].join('|');
      await this.prisma
        .withTenant(ctx.tenantId, async (tx) => {
          const existing = await tx.businessDevelopmentJevDecision.findFirst({
            where: { tenantId: ctx.tenantId, idempotencyKey: skippedKey },
            select: { id: true },
          });
          if (existing) return null; // duplicate skipped trace → idempotent no-op
          try {
            return await tx.businessDevelopmentJevDecision.create({
            data: {
              tenantId: ctx.tenantId,
              subjectType: input.subjectType,
              subjectId: input.subjectId,
              prospectId: input.prospectId,
              canonicalEntityId: evaluatedCanonicalEntityId,
              task,
              mode: input.mode,
              status: 'skipped',
              operationalState: 'source_unavailable',
              providerName: 'jev',
              modelVersion,
              registryVersion: JEV_TASK_REGISTRY_VERSION,
              questionVersion,
              envelopeHash: envelopeHash || 'not_computed',
              sourceIds,
              sourceHashesJsonb: JSON.parse(JSON.stringify(sourceHashes)) as Prisma.InputJsonValue,
              deterministicOutcome: baselineOutcome,
              reasonCodes: ['no_explicit_financial_stage_or_candidate'],
              idempotencyKey: skippedKey,
              completedAt: new Date(),
            },
            select: { id: true },
          });
          } catch (error) {
            // Unique-key race on the skipped trace → idempotent no-op, NOT a
            // write failure: another detached worker already recorded this gap.
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
              return null;
            }
            throw error;
          }
        })
        .catch((error) => {
          this.logger.warn(
            `bizdev jev skipped-trace write failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      this.logStructured('skipped', {
        tenantId: ctx.tenantId,
        task,
        mode: input.mode,
        operationalState: 'source_unavailable',
        reason: 'packet_preconditions_failed',
      });
      return;
    }

    // Pending trace first (tenant-scoped, redacted). Idempotent: a duplicate
    // insert (re-open or unique-key race) is caught and skipped entirely —
    // one provider call per envelope.
    const inserted = await this.prisma
      .withTenant(ctx.tenantId, async (tx) => {
        const existing = await tx.businessDevelopmentJevDecision.findFirst({
          where: { tenantId: ctx.tenantId, idempotencyKey },
          select: { id: true },
        });
        if (existing) return null;
        try {
          return await tx.businessDevelopmentJevDecision.create({
            data: {
              tenantId: ctx.tenantId,
              subjectType: input.subjectType,
              subjectId: input.subjectId,
              prospectId: input.prospectId,
              canonicalEntityId: evaluatedCanonicalEntityId,
              task,
              mode: input.mode,
              status: 'pending',
              providerName: 'jev',
              modelVersion,
              registryVersion: JEV_TASK_REGISTRY_VERSION,
              questionVersion,
              envelopeHash,
              candidateInventoryHash: candidateHash,
              sourceIds,
              sourceHashesJsonb: JSON.parse(JSON.stringify(sourceHashes)) as Prisma.InputJsonValue,
              deterministicOutcome: baselineOutcome,
              idempotencyKey,
            },
            select: { id: true },
          });
        } catch (error) {
          // Unique-key race (concurrent double-open of the same dossier):
          // another worker already owns this envelope — do nothing.
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            return null;
          }
          throw error;
        }
      })
      .catch((error) => {
        this.logger.warn(
          `bizdev jev pending-trace write failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      });
    if (!inserted) {
      this.logStructured('deduped', { tenantId: ctx.tenantId, task, mode: input.mode, envelopeHash });
      return;
    }

    if (!provider) {
      await this.completeTrace(ctx.tenantId, inserted.id, {
        status: 'failed',
        operationalState: 'not_checked',
        reasonCodes: ['provider_unavailable'],
      });
      return;
    }

    const decision = await provider.assess(envelope, question);
    await this.completeTrace(
      ctx.tenantId,
      inserted.id,
      this.traceUpdate(decision, task, input.mode, evaluatedCanonicalEntityId, evaluatedSignal),
    );
    this.logStructured('decision', {
      tenantId: ctx.tenantId,
      task,
      mode: input.mode,
      kind: decision.kind,
      outcome: decision.kind === 'outcome' ? decision.outcome : null,
      operationalState: decision.kind === 'failure'
        ? toBdOperationalState(decision.state, decision.reasonCodes)
        : null,
      envelopeHash,
      latencyMs: decision.latencyMs,
    });
  }

  private traceUpdate(
    decision: JevChoiceTaskDecision,
    task: BdJevTask,
    mode: Exclude<BdJevMode, 'off'>,
    evaluatedCanonicalEntityId: string | null = null,
    evaluatedSignal: EvidenceItem | null = null,
  ) {
    let projection = decision.kind === 'outcome'
      ? this.canaryProjection(decision, task, evaluatedCanonicalEntityId)
      : null;
    // The STORED projection must describe the effect deterministic code will
    // actually permit, never an ungated candidate label: a bd_signal
    // explicit_link projection is direct_fit ONLY when the deterministic
    // predicate passes for the ONE evaluated signal/source passage; otherwise
    // it is stored as the possible_fit downgrade. (Shadow still persists
    // visibleEffectJsonb = null; the canary remains registry-blocked today.)
    if (
      projection
      && task === 'bd_signal'
      && projection.suggestion === 'direct_fit'
      && !this.directSignalLabelAllowed({
        resolvedCanonicalEntityId: evaluatedCanonicalEntityId,
        signal: evaluatedSignal as EvidenceItem,
      })
    ) {
      projection = { ...projection, suggestion: 'possible_fit', downgradedFrom: 'direct_fit' };
    }
    if (decision.kind === 'failure') {
      return {
        status: 'failed' as const,
        operationalState: toBdOperationalState(decision.state, decision.reasonCodes),
        reasonCodes: decision.reasonCodes,
        latencyMs: decision.latencyMs,
      };
    }
    const inputTokens = decision.usage?.inputTokens ?? null;
    return {
      status: 'completed' as const,
      outcome: decision.outcome,
      probabilitiesJsonb: JSON.parse(JSON.stringify(decision.probabilities)) as Prisma.InputJsonValue,
      confidence: decision.confidence,
      reasonCodes: decision.reasonCodes,
      inputTokens,
      outputTokens: decision.usage?.outputTokens ?? null,
      // Actual usage at the approved registry price (USD per input token).
      estimatedCostUsd: inputTokens != null
        ? new Prisma.Decimal(inputTokens * BD_JEV_INPUT_TOKEN_PRICE_USD)
        : null,
      latencyMs: decision.latencyMs,
      visibleEffectJsonb: mode === 'internal_canary'
        ? (JSON.parse(JSON.stringify(projection ?? null)) as Prisma.InputJsonValue)
        : null,
    };
  }

  private async completeTrace(
    tenantId: string,
    id: string,
    data: Record<string, unknown>,
  ) {
    await this.prisma
      .withTenant(tenantId, (tx) =>
        tx.businessDevelopmentJevDecision.update({
          where: { id },
          data: { ...data, completedAt: new Date() } as never,
        }),
      )
      .catch((error) => {
        this.logger.warn(
          `bizdev jev trace completion failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  /**
   * Canary projection — SEMANTICS ONLY. bd_entity may suggest reordering
   * unresolved review candidates with an explicit review-required flag; it
   * can never resolve/merge/write identity. bd_signal may attach a labeled
   * suggestion; a DIRECT label requires deterministic verification (resolved
   * canonical company id + allowed official source record + locator +
   * relationship/stage preconditions), otherwise it is downgraded to
   * conditional/possible fit. The projection is stored on the trace
   * (visible_effect_jsonb); it reaches dossier output ONLY through
   * applyCanaryProjection, and only when the canary mode is actually armed
   * (resolveBdJevTaskMode already refused arming unless the registry allows
   * it AND the evaluation set is approved).
   */
  canaryProjection(
    decision: JevChoiceTaskDecision & { kind: 'outcome' },
    task: BdJevTask,
    evaluatedCanonicalEntityId: string | null = null,
  ): BdJevProjection | null {
    if (decision.kind !== 'outcome' || decision.action === 'abstain') return null;
    if (task === 'bd_entity') {
      if (decision.outcome === 'same_legal_entity') {
        return {
          task: 'bd_entity',
          suggestion: 'review_required_candidate_match',
          effect: 'reorder_unresolved_review_candidates',
          // The EVALUATED candidate id: the projection proposes reordering so
          // exactly this candidate moves first in the unchanged full list.
          suggestedCandidateId: evaluatedCanonicalEntityId ?? undefined,
          requiresHumanReview: true,
          confidence: decision.confidence,
        };
      }
      return null;
    }
    const signal = decision.outcome;
    if (signal === 'explicit_link') {
      // direct_fit is the CANDIDATE projection for an explicit-link outcome;
      // applyCanaryProjection still downgrades it to possible_fit unless the
      // deterministic predicate actually returns true. The downgrade default
      // therefore stays enforced at the application boundary, not here.
      return {
        task: 'bd_signal',
        suggestion: 'direct_fit',
        effect: 'labeled_suggestion',
        requiresHumanReview: true,
        confidence: decision.confidence,
      };
    }
    if (signal === 'conditional_alignment' || signal === 'thematic_fit') {
      return {
        task: 'bd_signal',
        suggestion: 'possible_fit',
        effect: 'labeled_suggestion',
        requiresHumanReview: true,
        confidence: decision.confidence,
      };
    }
    return null;
  }

  /**
   * Deterministic gate for a DIRECT bd_signal label. The provider decision is
   * NEVER sufficient on its own: the company identity must be resolved to a
   * canonical id, the source must be an allowed official record with a
   * locator, and the relationship/stage preconditions must hold
   * deterministically. Otherwise the caller keeps the downgraded projection.
   */
  directSignalLabelAllowed(input: {
    resolvedCanonicalEntityId: string | null;
    signal: EvidenceItem;
  }): boolean {
    if (!input.resolvedCanonicalEntityId) return false;
    const allowedFamilies = ['usaspending_contract', 'usaspending_assistance', 'sam_entity'];
    if (!allowedFamilies.includes(input.signal.sourceFamily)) return false;
    if (input.signal.relationshipStrength !== 'direct') return false;
    if (input.signal.stage !== 'awarded' && input.signal.stage !== 'obligated') return false;
    if (!input.signal.locator || !input.signal.recordId) return false;
    return true;
  }

  /**
   * Apply a canary projection to a Phase 2 dossier section. Returns the
   * section UNCHANGED unless the canary mode is actually armed. A Jev failure
   * yields the unchanged Phase 2 output; `not_evaluated` semantics appear
   * only when the canary is actually armed (a projection was possible but the
   * decision failed/abstained). bd_entity may only REORDER unresolved review
   * candidates + attach a review-required suggestion (never remove, resolve,
   * or merge); bd_signal may only attach a clearly labeled semantic
   * suggestion.
   */
  applyCanaryProjection(input: {
    mode: BdJevMode;
    task: BdJevTask;
    projection: BdJevProjection | null;
    decisionFailed: boolean;
    section: { evidence: EvidenceItem[]; detail: Record<string, unknown> };
    directLabelAllowed?: (signal: EvidenceItem) => boolean;
  }): { evidence: EvidenceItem[]; detail: Record<string, unknown> } {
    if (input.mode !== 'internal_canary') return input.section;
    if (!input.projection) {
      return input.task === 'bd_signal' && input.decisionFailed
        ? { ...input.section, detail: { ...input.section.detail, jevSuggestion: 'not_evaluated', jevSuggestionRequiresReview: true } }
        : input.section;
    }
    if (input.task === 'bd_entity') {
      const candidates = input.section.detail.candidates;
      if (!Array.isArray(candidates)) return input.section;
      const suggested = input.projection.suggestedCandidateId;
      if (!suggested) return input.section;
      return {
        ...input.section,
        detail: {
          ...input.section.detail,
          // Reorder only: the full candidate list is preserved; the suggested
          // match moves first WITH an explicit review-required suggestion.
          candidates: [...(candidates as BdCandidateProjection[])].sort((a, b) =>
            a.canonicalEntityId === suggested ? -1 : b.canonicalEntityId === suggested ? 1 : 0),
          // Stable enum-like contract for the web: only recognized values are
          // ever emitted, so the renderer can whitelist exactly these.
          jevSuggestion: 'identity_review_required',
          jevSuggestionRequiresReview: true,
        },
      };
    }
    // bd_signal: attach a clearly labeled semantic suggestion. The value is a
    // small stable enum. 'direct_fit' requires the deterministic predicate to
    // be present AND to return true for at least one applicable evidence item
    // in this section; otherwise the projection is downgraded to possible_fit.
    let label: BdJevProjection['suggestion'] =
      input.projection.suggestion === 'direct_fit' ? 'possible_fit' : input.projection.suggestion;
    if (input.projection.suggestion === 'direct_fit' && input.directLabelAllowed) {
      const applicable = input.section.evidence.find((item) => input.directLabelAllowed!(item));
      if (applicable) label = 'direct_fit';
    }
    return {
      evidence: input.section.evidence,
      detail: {
        ...input.section.detail,
        jevSuggestion: label,
        jevSuggestionRequiresReview: true,
      },
    };
  }

  /**
   * Review-event hook: when the existing explicit prospect identity-resolution
   * action runs, update the LATEST matching UNREVIEWED tenant decision trace
   * as review metadata. The latest-row selection is a plain read; the WRITE
   * is an updateMany whose predicate re-checks `reviewStatus: 'unreviewed'`
   * at write time, so a row reviewed between the two statements updates ZERO
   * rows (no double-apply, no overwrite of another reviewer's result — the
   * unreviewed predicate is part of the write itself). No single-statement
   * atomicity is claimed beyond that guarded write. Exactly one row (the
   * latest, by requestedAt desc) is ever a candidate for update.
   *
   * Classification is RELATIVE to the evaluated candidate stored on the trace:
   * `accepted` + `same_legal_entity` only when the trace's evaluated candidate
   * IS the resolved canonical id AND the recorded outcome proposed
   * same_legal_entity. Otherwise `corrected` and the reviewedOutcome expresses
   * what the human actually resolved to — the same candidate when the human
   * picked it despite the provider outcome (`same_legal_entity`), else an
   * explicit `different` (a different candidate was resolved).
   *
   * Never the whole history, never a global promotion, never training. Called
   * OUTSIDE (after) the resolution transaction so the original transaction
   * semantics and duplicate-safe behavior are untouched; the update itself is
   * idempotent (unreviewed filter in the atomic predicate).
   */
  async recordIdentityReviewOutcome(input: {
    tenantId: string;
    prospectId: string;
    resolvedCanonicalEntityId: string;
    userId: string | null;
  }): Promise<void> {
    try {
      const latest = await this.prisma.withTenant(input.tenantId, (tx) =>
        tx.businessDevelopmentJevDecision.findFirst({
          where: {
            tenantId: input.tenantId,
            prospectId: input.prospectId,
            task: 'bd_entity',
            reviewStatus: 'unreviewed',
          },
          orderBy: { requestedAt: 'desc' },
          select: { id: true, canonicalEntityId: true, outcome: true },
        }),
      );
      if (!latest) return; // nothing unreviewed → no-op (duplicate re-resolve, already reviewed)
      const sameCandidate = latest.canonicalEntityId === input.resolvedCanonicalEntityId;
      const accepted = sameCandidate && latest.outcome === 'same_legal_entity';
      // Human outcome RELATIVE to the evaluated candidate: same candidate →
      // same_legal_entity; a different candidate → explicit `different`.
      const reviewedOutcome = sameCandidate ? 'same_legal_entity' : 'different';
      // Atomic latest-only update: the unreviewed predicate is part of the
      // WRITE, so a racing reviewer's commit makes this a zero-row no-op.
      await this.prisma.withTenant(input.tenantId, (tx) =>
        tx.businessDevelopmentJevDecision.updateMany({
          where: {
            id: latest.id,
            tenantId: input.tenantId,
            reviewStatus: 'unreviewed',
          },
          data: {
            reviewStatus: accepted ? 'accepted' : 'corrected',
            reviewedOutcome: accepted ? 'same_legal_entity' : reviewedOutcome,
            reviewedByUserId: input.userId,
            reviewedAt: new Date(),
          },
        }),
      );
    } catch (error) {
      // Review metadata is best-effort: it must never break identity resolution.
      this.logger.warn(
        `bizdev jev review metadata update failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

/** One-line JSON structured log; source text is never included (hashes only). */
private logStructured(event: string, fields: Record<string, unknown>) {
  this.logger.log(JSON.stringify({ channel: 'bizdev.jev', event, ...fields }));
}
}
