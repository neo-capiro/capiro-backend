import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  classifyLearningSignalEligibility,
  proposeLearningSignalCandidateAuthority,
  describeMemoryConflictMatch,
  learningTenantSelected,
  type LearningSignalCandidateEligibility,
} from '@capiro/meriv2-core';
import type { SteeringLayer } from '@capiro/meriv2-core';
import { PrismaService } from '../prisma/prisma.service.js';
import { MemoryCandidateService } from '../memory/memory-candidate.service.js';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';
import {
  LearningSignalMemoryConflictService,
  type MemoryConflictMatch,
} from './learning-signal-memory-conflict.service.js';

const LEARNING_SIGNAL_SOURCE_TYPE = 'learning_signal_capture';
const RAW_QUERY_FAILED = 'P2010';
const POSTGRES_UNIQUE_VIOLATION = '23505';

export interface LearningSignalCandidateOutcomeResult {
  learningSignalId: string;
  eligibility: LearningSignalCandidateEligibility;
  reason: string;
  memoryCandidateId: string | null;
}

interface LoadedLearningSignal {
  id: string;
  tenantId: string;
  actorUserId: string;
  clientId: string | null;
  sourceSurface: string;
  signalType: string;
  proposedMemoryLayer: string | null;
  evidenceJsonb: unknown;
  sensitivity: string;
  provenanceKind: string;
  provenanceJsonb: unknown;
}

/**
 * Global control (Phase 27B handoff §23): candidate generation must be
 * independently disableable from signal capture (LEARNING_SIGNAL_CAPTURE).
 * Dark-by-default — the OPPOSITE default from capture's kill switch,
 * deliberately: capturing a signal is inert, but generating a candidate
 * writes a real row into the governed review queue a human may see, so the
 * safer default here is off until explicitly armed. Pure function, same
 * style as `learningSignalCaptureEnabled`/`governedMemoryLifecycleEnabled` —
 * callers pass `process.env.LEARNING_CANDIDATE_GENERATION` explicitly.
 */
export function learningCandidateGenerationEnabled(raw: string | undefined): boolean {
  return String(raw ?? '').trim().toLowerCase() === 'enabled';
}

/**
 * Phase 27B — the ONE path from a captured LearningSignal to a governed
 * memory_candidate. Product adapters (meri-feedback.adapter.ts,
 * crm-fill-finding.adapter.ts) only ever produce LearningSignals; nothing
 * outside this service creates a memory_candidate FROM a learning_signal
 * (enforced by check-learning-signal-new-bypasses.mjs's Phase 27B guard).
 *
 * Every signal this service looks at gets exactly one
 * `learning_signal_candidate_outcome` row, recording whether it produced a
 * candidate and why/why not — never silently dropped. Processing the same
 * signal again is a no-op (idempotent): the outcome row is checked first,
 * and the `memory_candidate_learning_signal_source_unique` partial index is
 * a database-level backstop against a concurrent double-process race.
 *
 * Never writes `memory_items`, `clio_memory`, or any *active* state —
 * `MemoryCandidateService.proposeSaveMemory` always lands this service's
 * candidates `pending` (memory-candidate-rules.ts's
 * `memory.learning_signal.requires_review` rule), regardless of scope.
 */
@Injectable()
export class LearningSignalCandidateService {
  private readonly logger = new Logger(LearningSignalCandidateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly candidates: MemoryCandidateService,
    private readonly conflictDetection: LearningSignalMemoryConflictService,
  ) {}

  /**
   * Process one signal. Safe to call repeatedly (idempotent) and safe to
   * call from a batch job, a manual admin trigger, or a test — this method
   * has no opinion on *when* it runs, only on producing one correct outcome
   * per signal. Returns null if candidate generation is globally disabled
   * (no outcome row is written in that case — this is "not processed yet",
   * not a decision).
   */
  async generateForSignal(
    tenantId: string,
    learningSignalId: string,
  ): Promise<LearningSignalCandidateOutcomeResult | null> {
    if (!learningCandidateGenerationEnabled(process.env.LEARNING_CANDIDATE_GENERATION)) {
      return null;
    }
    // Phase 27G rollout bound — see learningTenantSelected. Same null
    // return as the global switch above, and for the same reason: a tenant
    // outside the allowlist is "not processed yet", not a decision, so no
    // outcome row is written for it either.
    if (!learningTenantSelected(tenantId)) {
      return null;
    }

    const existing = await this.prisma.withTenant(tenantId, (tx) =>
      tx.learningSignalCandidateOutcome.findUnique({ where: { learningSignalId } }),
    );
    if (existing) {
      return {
        learningSignalId,
        eligibility: existing.eligibility as LearningSignalCandidateEligibility,
        reason: existing.reason,
        memoryCandidateId: existing.memoryCandidateId,
      };
    }

    const signal = await this.prisma.withTenant(tenantId, (tx) =>
      tx.learningSignal.findFirst({ where: { id: learningSignalId, tenantId } }),
    );
    if (!signal) {
      throw new NotFoundException(`learning_signal ${learningSignalId} not found for this tenant.`);
    }

    // Ethical wall: a client-scoped signal whose client the originating
    // actor can no longer see must not silently produce a client-steering
    // candidate anyway. Fails closed, same as memory recall.
    if (signal.clientId) {
      const allowed = await this.prisma.withTenant(tenantId, (tx) =>
        clientMemoryAllowed(tx, tenantId, signal.actorUserId, signal.clientId as string),
      );
      if (!allowed) {
        return this.recordOutcome(tenantId, signal, {
          eligibility: 'blocked_by_policy',
          reason: 'The originating actor no longer has ethical-wall access to this client.',
        });
      }
    }

    const evidenceRefs = Array.isArray(signal.evidenceJsonb) ? signal.evidenceJsonb : [];
    const provenance =
      signal.provenanceJsonb && typeof signal.provenanceJsonb === 'object'
        ? (signal.provenanceJsonb as Record<string, unknown>)
        : {};
    const reasons = Array.isArray(provenance.reasons) ? provenance.reasons : [];

    const intrinsic = classifyLearningSignalEligibility({
      signalType: signal.signalType as never,
      provenanceKind: signal.provenanceKind as never,
      proposedMemoryLayer: (signal.proposedMemoryLayer as SteeringLayer | null) ?? null,
      evidenceRefCount: evidenceRefs.length,
      sensitivity: signal.sensitivity as 'normal' | 'confidential' | 'restricted',
      hasNote: provenance.hasNote === true,
      reasonCount: reasons.length,
    });

    if (intrinsic.eligibility !== 'eligible') {
      return this.recordOutcome(tenantId, signal, intrinsic);
    }

    const duplicate = await this.findExactDuplicate(tenantId, signal, provenance);
    if (duplicate) {
      // Phase 27D §17: a same-proposition candidate that was already
      // REJECTED must stay suppressed — the next identical signal must not
      // silently recreate the exact candidate a reviewer already turned
      // down, as though the rejection never happened. Reusing the
      // 'duplicate' eligibility (rather than a new taxonomy value) keeps
      // this auditable without a migration: memoryCandidateId on the
      // outcome row links straight to the earlier candidate, whose own
      // status distinguishes "already pending/active" from "already
      // rejected" for anyone reviewing this outcome. Deliberately no
      // automatic "stronger independent evidence" override here — that
      // would need a real evidence-strength comparison with no product
      // surface to drive it yet; a genuinely new candidate for the same
      // proposition remains possible, just not automatic (handoff §17's
      // own "that must be explicit and auditable" — nothing here is either,
      // so nothing here does it).
      return this.recordOutcome(tenantId, signal, {
        eligibility: 'duplicate',
        reason:
          duplicate.status === 'rejected'
            ? `A reviewer already rejected this exact proposition (memory_candidate ${duplicate.id}); suppressed rather than resubmitted.`
            : `An equivalent pending/active candidate already exists (memory_candidate ${duplicate.id}).`,
      });
    }

    // Phase 27C — the disclosed 27B gap: search ACTIVE memory for a
    // near-duplicate or probable contradiction, using the real fact text
    // (never persisted verbatim — fetched, embedded, discarded). Read-only:
    // never touches memory_items, never resolves anything itself.
    const factText = await this.resolveFactText(tenantId, signal, evidenceRefs);
    if (signal.sourceSurface === 'crm.fill_with_meri' && !factText) {
      return this.recordOutcome(tenantId, signal, {
        eligibility: 'insufficient_evidence',
        reason: 'The accepted client finding has no available fact content in the same client scope; no metadata-only memory candidate was created.',
      });
    }
    const conflictMatch = factText
      ? await this.conflictDetection.findBestActiveMemoryMatch(
          { tenantId, clientId: signal.clientId, actorUserId: signal.actorUserId },
          factText,
        )
      : null;

    if (conflictMatch?.kind === 'duplicate') {
      return this.recordOutcome(tenantId, signal, {
        eligibility: 'duplicate',
        reason: describeMemoryConflictMatch(
          'duplicate',
          `memory_items ${conflictMatch.memoryItemId} ("${conflictMatch.title}")`,
          conflictMatch.score,
        ),
      });
    }

    const authority = proposeLearningSignalCandidateAuthority({
      signalType: signal.signalType as never,
      hasNote: provenance.hasNote === true,
      reasonCount: reasons.length,
      evidenceRefCount: evidenceRefs.length,
      crmSource: typeof provenance.source === 'string' ? provenance.source : null,
    });

    const candidateKey = `learning-signal:${signal.sourceSurface}:${signal.signalType}:${signal.id}`;
    const scope: 'firm' | 'user_private' | 'client' = signal.clientId ? 'client' : 'user_private';

    // Only 'probable_contradiction' | 'possible_related' can reach here —
    // 'duplicate' already returned above, and findBestActiveMemoryMatch
    // never returns an 'unrelated' match (it returns null instead). Neither
    // remaining kind becomes a stronger claim than the evidence supports:
    // the pending CANDIDATE is flagged (conflictStatus='open',
    // contradictsMemoryItemId points at the active item) — the active item
    // itself is never touched. Supersession (flipping the active item's own
    // status) is a human governance decision, 27D's job — this only
    // preserves the lineage for it.
    const conflictFields = conflictMatch
      ? { contradictsMemoryItemId: conflictMatch.memoryItemId, conflictStatus: 'open' }
      : {};
    const conflictReasonSuffix = conflictMatch
      ? ` ${describeMemoryConflictMatch(conflictMatch.kind, `memory_items ${conflictMatch.memoryItemId} ("${conflictMatch.title}")`, conflictMatch.score)}`
      : '';

    try {
      const result = await this.candidates.proposeSaveMemory(
        tenantId,
        signal.actorUserId,
        {
          scope,
          ownerUserId: scope === 'user_private' ? signal.actorUserId : null,
          clientId: signal.clientId,
          key: candidateKey,
          value: buildCandidateValueSummary(signal, provenance, authority, factText),
          sourceExcerpt: factText,
          source: 'learning_signal',
          confidence: authority.proposedConfidence,
          sourceType: LEARNING_SIGNAL_SOURCE_TYPE,
          sourceId: signal.id,
          proposedMemoryClass: authority.memoryClass,
          proposedMemoryAuthority: authority.memoryAuthority,
          ...conflictFields,
        },
        false,
        'learning_signal',
      );

      if (result.status !== 'pending') {
        // Should be unreachable: memory.learning_signal.requires_review
        // always wins first-match. Fail loudly rather than silently letting
        // a generated candidate reach active memory.
        throw new Error(
          `LearningSignal ${signal.id} candidate unexpectedly resolved '${result.status}' — ` +
            'the learning_signal candidate-generation guard did not fire.',
        );
      }

      return this.recordOutcome(
        tenantId,
        signal,
        {
          eligibility: 'eligible',
          reason: `${authority.confidenceReasons.join(' ')}${conflictReasonSuffix}`,
        },
        result.candidateId,
      );
    } catch (error) {
      if (isSourceUniqueViolation(error)) {
        // Lost a concurrent race to create this exact candidate. Re-read
        // and record against whichever candidate won — never a second one.
        const winner = await this.prisma.withTenant(tenantId, (tx) =>
          tx.memoryCandidate.findFirst({
            where: { tenantId, sourceType: LEARNING_SIGNAL_SOURCE_TYPE, sourceId: signal.id },
            select: { id: true },
          }),
        );
        return this.recordOutcome(
          tenantId,
          signal,
          {
            eligibility: 'eligible',
            reason: 'A concurrent process created this candidate first; no duplicate was created.',
          },
          winner?.id ?? null,
        );
      }
      throw error;
    }
  }

  /** Convenience batch entry point for a scheduled/manual trigger — see
   *  scripts/run-learning-signal-candidate-generation.mjs. Processes the
   *  oldest not-yet-decided captured signals for one tenant first. */
  async processBatch(tenantId: string, limit = 50): Promise<LearningSignalCandidateOutcomeResult[]> {
    if (!learningCandidateGenerationEnabled(process.env.LEARNING_CANDIDATE_GENERATION)) {
      return [];
    }
    // Phase 27G rollout bound. generateForSignal enforces this too, so this
    // check is about not doing the batch READ at all for a tenant that
    // could not produce an outcome anyway.
    if (!learningTenantSelected(tenantId)) {
      return [];
    }
    const pending = await this.prisma.withTenant(tenantId, (tx) =>
      tx.learningSignal.findMany({
        where: { tenantId, status: 'captured', candidateOutcome: null },
        orderBy: { createdAt: 'asc' },
        take: Math.min(limit, 200),
        select: { id: true },
      }),
    );
    const results: LearningSignalCandidateOutcomeResult[] = [];
    for (const row of pending) {
      try {
        const outcome = await this.generateForSignal(tenantId, row.id);
        if (outcome) results.push(outcome);
      } catch (error) {
        // One bad signal must never abort the rest of the batch.
        this.logger.warn(
          `Candidate generation failed for learning_signal ${row.id}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return results;
  }

  /** Exact-duplicate check (handoff §12) — conservative and CRM-only in
   *  27B: a Fill-with-Meri finding is naturally keyed by (clientId, kind,
   *  targetKey), so two acceptances of "the same fact" collapse onto one
   *  pending candidate. Meri feedback has no such structured key without
   *  reading message content (which 27B deliberately never copies into a
   *  signal) — semantic near-duplicate detection for that surface is left
   *  for a later phase's embedding-backed pass (handoff §13), not attempted
   *  here rather than approximated unsafely. */
  private async findExactDuplicate(
    tenantId: string,
    signal: LoadedLearningSignal,
    provenance: Record<string, unknown>,
  ): Promise<{ id: string; status: string } | null> {
    if (signal.sourceSurface !== 'crm.fill_with_meri' || !signal.clientId) return null;
    const targetKey = typeof provenance.targetKey === 'string' ? provenance.targetKey : null;
    const kind = typeof provenance.kind === 'string' ? provenance.kind : null;
    if (!targetKey || !kind) return null;

    // Phase 27D: 'rejected' joins the prior pending/approved/auto_committed
    // set so a rejected proposition's next identical signal is suppressed
    // too (see the rejection-durability comment at the call site), not just
    // an already-live one. ORDER BY created_at DESC so the MOST RECENT
    // candidate for this exact (clientId, kind, targetKey) governs — e.g. if
    // an old rejected row and a newer pending row both match (a rejection
    // followed by a fresh proposal before this change shipped), the newer
    // pending row's status is what should suppress/permit the next signal,
    // not whichever row happens to be oldest.
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT id::text AS id, status
        FROM memory_candidate
        WHERE tenant_id = ${tenantId}::uuid
          AND source_kind = 'learning_signal'
          AND client_id = ${signal.clientId}::uuid
          AND status IN ('pending', 'approved', 'auto_committed', 'rejected')
          AND provenance_jsonb #>> '{kind}' = ${kind}
          AND provenance_jsonb #>> '{targetKey}' = ${targetKey}
        ORDER BY created_at DESC
        LIMIT 1
      `,
    );
    return rows[0] ?? null;
  }

  /**
   * Resolves the real fact text for BOTH conflict detection AND the
   * candidate's own body (`buildCandidateValueSummary`) — the one place this
   * service ever reads the underlying fact/note content, reused for both
   * purposes rather than fetched twice.
   *
   * CRM: the accepted finding's `proposed_value_jsonb` is not confidential
   * free text — it is structured CRM enrichment data the finding row
   * already durably stores, so deriving text from it here adds no new
   * exposure; it was already reachable by anyone with the finding's id.
   *
   * Meri: the user's free-text feedback note lives on
   * `clio_messages.metadata_jsonb.feedback.note` — 27A/27B's adapter never
   * copies it into the `learning_signal` row itself ("never copies the
   * free-text note into the signal — only whether one was left"), and that
   * remains true; this method fetches it fresh from the message at
   * candidate-generation time instead. As of the Phase 27 post-launch P0 fix
   * (Neo, 2026-08-22) that resolved text is no longer discarded after
   * conflict detection — it becomes the candidate's proposed fact, gated by
   * the same human-review step every candidate already requires before
   * reaching active memory. Returns null (skipping conflict detection, and
   * falling back to reason codes in the candidate body) whenever there is no
   * note to fetch.
   */
  private async resolveFactText(
    tenantId: string,
    signal: LoadedLearningSignal,
    evidenceRefs: unknown[],
  ): Promise<string | null> {
    if (signal.sourceSurface === 'crm.fill_with_meri') {
      const findingRef = evidenceRefs.find(
        (ref): ref is { type: string; id: string } =>
          Boolean(ref) &&
          typeof ref === 'object' &&
          (ref as { type?: unknown }).type === 'client_profile_fill_finding',
      );
      if (!findingRef?.id) return null;
      const rows = await this.prisma.withTenant(tenantId, (tx) =>
        tx.$queryRaw<Array<{ proposedValue: unknown }>>`
          SELECT proposed_value_jsonb AS "proposedValue"
          FROM client_profile_fill_finding
          WHERE id = ${findingRef.id}::uuid AND tenant_id = ${tenantId}::uuid
            AND client_id = ${signal.clientId}::uuid AND status = 'accepted'
          LIMIT 1
        `,
      );
      const value = rows[0]?.proposedValue;
      return value !== undefined ? factTextFromValue(value) : null;
    }

    if (signal.sourceSurface === 'meri.chat') {
      const messageRef = evidenceRefs.find(
        (ref): ref is { type: string; id: string } =>
          Boolean(ref) && typeof ref === 'object' && (ref as { type?: unknown }).type === 'clio_message',
      );
      if (!messageRef?.id) return null;
      const message = await this.prisma.withTenant(tenantId, (tx) =>
        tx.clioMessage.findFirst({
          where: { id: messageRef.id, tenantId, userId: signal.actorUserId },
          select: { metadata: true },
        }),
      );
      const metadata =
        message?.metadata && typeof message.metadata === 'object' && !Array.isArray(message.metadata)
          ? (message.metadata as Record<string, unknown>)
          : null;
      const feedback =
        metadata?.feedback && typeof metadata.feedback === 'object' && !Array.isArray(metadata.feedback)
          ? (metadata.feedback as Record<string, unknown>)
          : null;
      const note = typeof feedback?.note === 'string' ? feedback.note.trim() : null;
      return note && note.length >= 10 ? note : null;
    }

    return null;
  }

  private async recordOutcome(
    tenantId: string,
    signal: LoadedLearningSignal,
    decision: { eligibility: LearningSignalCandidateEligibility; reason: string },
    memoryCandidateId: string | null = null,
  ): Promise<LearningSignalCandidateOutcomeResult> {
    const reason = decision.reason.slice(0, 240);
    try {
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.learningSignalCandidateOutcome.create({
          data: {
            tenantId,
            learningSignalId: signal.id,
            eligibility: decision.eligibility,
            reason,
            memoryCandidateId,
          },
        }),
      );
    } catch (error) {
      // Idempotent retry: another process already recorded this signal's
      // outcome between our existence-check and this insert. Its decision
      // wins, not ours — re-read and return it rather than erroring.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
        throw error;
      }
    }
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.learningSignalCandidateOutcome.findUniqueOrThrow({
        where: { learningSignalId: signal.id },
      }),
    );
    return {
      learningSignalId: signal.id,
      eligibility: row.eligibility as LearningSignalCandidateEligibility,
      reason: row.reason,
      memoryCandidateId: row.memoryCandidateId,
    };
  }
}

/**
 * `client_profile_fill_finding.proposed_value_jsonb` has no single fixed
 * shape — it varies by `kind` (a person finding carries name/email/role, a
 * capability finding carries name/type/description, ...). Rather than
 * special-case every kind, preserve structured field values, including lists and numeric attributes, in
 * one embeddable line — good enough for a similarity search, not intended
 * to be a polished human-facing sentence.
 */
function factTextFromValue(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  if (!value || typeof value !== 'object') return null;
  const parts = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v != null && (typeof v !== 'string' || v.trim()))
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v.trim() : JSON.stringify(v)}`);
  return parts.length ? parts.join('; ') : null;
}

function isSourceUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === RAW_QUERY_FAILED &&
    typeof error.meta?.code === 'string' &&
    error.meta.code === POSTGRES_UNIQUE_VIOLATION
  );
}

/**
 * This string is BOTH what a human reviewer reads in the approval queue
 * (memory-candidate-review.service.ts's `proposal.value`, rendered verbatim)
 * AND, once approved, the durable `memory_items.sections_jsonb` body a
 * ContextPacket exposes to Meri (memory-canonical-activation.helpers.ts
 * falls back to `record.value` as the sole 'Memory' section when no
 * `canonicalItem` is supplied — which the learning-signal path never
 * supplies). It must therefore lead with the actual learned proposition, not
 * metadata about the act of learning it — a reviewer approving "crm_finding
 * accepted, proposed layer client-steering" has no way to judge whether the
 * underlying fact is even right, and Meri recalling that same text has no
 * usable content to act on (see the Phase 27G canary's "honest limitation").
 *
 * `factText` is the same safe fact text `resolveFactText()` already resolves
 * for conflict detection — reused here rather than discarded. For a CRM Fill
 * finding this is the finding's own `proposed_value_jsonb` fields (already
 * documented there as non-confidential structured data). For Meri feedback
 * it is the human's own rating note — durably stored on `clio_messages`
 * already, and reaching a governed memory here only after the same
 * human-review gate every candidate already requires before this content
 * becomes active memory (Neo, 2026-08-22 P0 decision: include the note
 * rather than leave it out of the fact any candidate is judged and recalled
 * on).
 */
function buildCandidateValueSummary(
  signal: LoadedLearningSignal,
  provenance: Record<string, unknown>,
  authority: { memoryClass: string; memoryAuthority: string; proposedConfidence: number },
  factText: string | null,
): string {
  const reasons = Array.isArray(provenance.reasons)
    ? provenance.reasons.filter((reason): reason is string => typeof reason === 'string')
    : [];
  const fact =
    factText ??
    (reasons.length
      ? `Reason code(s) selected on this rating: ${reasons.join(', ')}.`
      : 'No structured fact text was available for this signal — review the linked evidence before approving.');
  const reasonsTrailer = factText && reasons.length ? ` Reason code(s): ${reasons.join(', ')}.` : '';
  const sourceLabel = describeCandidateSourceForBody(signal, provenance);

  return (
    `${fact}\n\n` +
    `Source: ${sourceLabel}. Proposed as ${authority.memoryClass} (${authority.memoryAuthority}), ` +
    `confidence ${authority.proposedConfidence.toFixed(2)}.${reasonsTrailer}`
  );
}

function describeCandidateSourceForBody(
  signal: LoadedLearningSignal,
  provenance: Record<string, unknown>,
): string {
  if (signal.sourceSurface === 'crm.fill_with_meri') {
    const kind = typeof provenance.kind === 'string' ? provenance.kind.replace(/_/g, ' ') : 'finding';
    const source = typeof provenance.source === 'string' ? provenance.source : 'unknown';
    return `Fill-with-Meri ${kind} finding accepted (${source})`;
  }
  if (signal.sourceSurface === 'meri.chat') {
    return signal.signalType === 'meri_feedback_positive'
      ? 'Positive rating on a Meri response'
      : 'Negative rating on a Meri response';
  }
  return signal.sourceSurface;
}
