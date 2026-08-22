import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  classifyLearningSignalEligibility,
  proposeLearningSignalCandidateAuthority,
  describeMemoryConflictMatch,
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
      return this.recordOutcome(tenantId, signal, {
        eligibility: 'duplicate',
        reason: `An equivalent pending/active candidate already exists (memory_candidate ${duplicate}).`,
      });
    }

    // Phase 27C — the disclosed 27B gap: search ACTIVE memory for a
    // near-duplicate or probable contradiction, using the real fact text
    // (never persisted verbatim — fetched, embedded, discarded). Read-only:
    // never touches memory_items, never resolves anything itself.
    const factText = await this.resolveFactText(tenantId, signal, evidenceRefs);
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
          value: buildCandidateValueSummary(signal, provenance, authority),
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
  ): Promise<string | null> {
    if (signal.sourceSurface !== 'crm.fill_with_meri' || !signal.clientId) return null;
    const targetKey = typeof provenance.targetKey === 'string' ? provenance.targetKey : null;
    const kind = typeof provenance.kind === 'string' ? provenance.kind : null;
    if (!targetKey || !kind) return null;

    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRaw<Array<{ id: string }>>`
        SELECT id::text AS id
        FROM memory_candidate
        WHERE tenant_id = ${tenantId}::uuid
          AND source_kind = 'learning_signal'
          AND client_id = ${signal.clientId}::uuid
          AND status IN ('pending', 'approved', 'auto_committed')
          AND provenance_jsonb #>> '{kind}' = ${kind}
          AND provenance_jsonb #>> '{targetKey}' = ${targetKey}
        ORDER BY created_at ASC
        LIMIT 1
      `,
    );
    return rows[0]?.id ?? null;
  }

  /**
   * Resolves the real fact text for conflict detection ONLY — never
   * persisted anywhere by this service, used solely to compute a
   * throwaway embedding for one search query (`LearningSignalMemoryConflictService`).
   *
   * CRM: the accepted finding's `proposed_value_jsonb` is not confidential
   * free text — it is structured CRM enrichment data the finding row
   * already durably stores, so deriving searchable text from it here adds
   * no new exposure.
   *
   * Meri: deliberately narrower. The user's free-text feedback note lives
   * only on `clio_messages.metadata_jsonb.feedback.note` — 27A/27B's own
   * adapter explicitly never copied it into the signal ("never copies the
   * free-text note into the signal — only whether one was left"). Fetching
   * it here, ephemerally, for a single similarity query preserves that
   * principle (nothing new is written to disk); returns null (skipping
   * conflict detection entirely) whenever there is no note to fetch.
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
          where: { id: messageRef.id, tenantId },
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
 * special-case every kind, join every top-level string-valued field into
 * one embeddable line — good enough for a similarity search, not intended
 * to be a polished human-facing sentence.
 */
function factTextFromValue(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const parts = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => typeof v === 'string' && v.trim())
    .map(([k, v]) => `${k}: ${(v as string).trim()}`);
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
 * A safe, structured evidence summary — never the note/message body itself
 * (handoff §9: "store references... rather than duplicate content"). A
 * human reviewer sees enough to know what to go look at, not a
 * system-synthesized claim of what the remembered fact is.
 */
function buildCandidateValueSummary(
  signal: LoadedLearningSignal,
  provenance: Record<string, unknown>,
  authority: { memoryClass: string; memoryAuthority: string; proposedConfidence: number },
): string {
  return JSON.stringify({
    summary: `${signal.signalType} on ${signal.sourceSurface}, proposed layer ${signal.proposedMemoryLayer ?? 'unknown'}.`,
    proposedMemoryClass: authority.memoryClass,
    proposedMemoryAuthority: authority.memoryAuthority,
    proposedConfidence: authority.proposedConfidence,
    hasNote: provenance.hasNote === true,
    reasons: Array.isArray(provenance.reasons) ? provenance.reasons : [],
    sourceKind: typeof provenance.kind === 'string' ? provenance.kind : null,
    sourceSystem: typeof provenance.source === 'string' ? provenance.source : null,
    note: 'Review the referenced evidence objects for full context before approving.',
  });
}
