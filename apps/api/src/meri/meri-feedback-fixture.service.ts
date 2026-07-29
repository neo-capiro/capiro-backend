import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import {
  createFeedbackFixtureCandidate,
  normalizeFeedbackReason,
  reviewFeedbackFixtureCandidate,
  type FeedbackFixtureCandidate,
  type FeedbackReasonCode,
} from '@capiro/meriv2-core';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { FEEDBACK_ANONYMIZATION_VERSION } from './meri-feedback-anonymize.js';

/**
 * The REVIEWED + ANONYMIZED feedback-to-eval-fixture workflow.
 *
 * packages/meriv2-core/src/assurance/feedback-fixtures.ts already encodes the rule
 * that matters — feedback never becomes golden truth automatically; acceptance
 * requires a NAMED reviewer plus completed anonymization — and had no caller. The
 * live path stored a thumbs-down in clio_message.metadata and exported a raw
 * response excerpt. This connects the two.
 *
 * WHAT IS AND IS NOT STORED. A candidate references the message, the trace, the
 * context packet and the claim-ledger hash, plus a bounded reviewer-facing summary.
 * It does NOT store the prompt or the response body: a regression fixture needs to
 * identify a case, not reproduce a client's conversation.
 *
 * Every invariant is enforced twice on purpose — once here (so the API returns a
 * clear 4xx) and once as a DB CHECK in
 * 20260811030000_assurance_feedback_fixtures (so a future route that writes rows
 * directly cannot bypass it).
 */
@Injectable()
export class MeriFeedbackFixtureService {
  private readonly logger = new Logger(MeriFeedbackFixtureService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Raise a candidate from a thumbs-down.
   *
   * Idempotent per message: a repeated click updates nothing and returns the
   * existing candidate rather than flooding the review queue (matching the partial
   * unique index on (tenant_id, source_message_id)).
   *
   * NEVER THROWS INTO THE FEEDBACK PATH. Recording a candidate is a downstream
   * nicety; a user clicking thumbs-down must always succeed. So a failure here is
   * logged and swallowed, and the caller's feedback write is unaffected.
   */
  async recordFromFeedback(
    ctx: TenantContext,
    input: {
      messageId: string;
      reasons: readonly string[];
      surface: string;
      traceId?: string | null;
      contextPacketId?: string | null;
      claimLedgerHash?: string | null;
      /** Bounded, reviewer-facing. Must NOT be a prompt or response body. */
      summary?: string | null;
    },
  ): Promise<{ id: string } | null> {
    try {
      const reasonCodes = normalizeReasons(input.reasons);
      // No recognized reason ⇒ nothing an evaluator could turn into a fixture.
      if (!reasonCodes.length) return null;
      // Build through the pure module so the shape (and its validation) is the one
      // the assurance layer defines, not a second local interpretation.
      const candidate = createFeedbackFixtureCandidate({
        reasonCodes,
        surface: input.surface,
        ...(input.traceId ? { traceId: input.traceId } : {}),
        ...(input.contextPacketId ? { contextPacketId: input.contextPacketId } : {}),
        ...(input.claimLedgerHash ? { claimLedgerHash: input.claimLedgerHash } : {}),
        ...(input.summary ? { summary: input.summary } : {}),
        createdByUserId: ctx.userId,
      });
      return await this.prisma.withTenant(ctx.tenantId, async (tx) => {
        const client = tx as unknown as FixtureTx;
        const existing = await client.assuranceFeedbackCandidate.findFirst({
          where: { tenantId: ctx.tenantId, sourceMessageId: input.messageId },
        });
        if (existing) return { id: existing.id };
        const created = await client.assuranceFeedbackCandidate.create({
          data: {
            tenantId: ctx.tenantId,
            status: 'pending_review',
            reasonCodes: candidate.reasonCodes,
            surface: candidate.surface,
            sourceMessageId: input.messageId,
            traceId: candidate.traceId ?? null,
            contextPacketId: candidate.contextPacketId ?? null,
            claimLedgerHash: candidate.claimLedgerHash ?? null,
            summary: candidate.summary ?? null,
            createdByUserId: candidate.createdByUserId,
            anonymized: false,
          },
        });
        return { id: created.id };
      });
    } catch (error) {
      this.logger.warn(
        `[assurance] feedback candidate not recorded (non-fatal): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /**
   * ACCEPT or REJECT a candidate, and on acceptance mint the regression fixture.
   *
   * Both rows are written in ONE transaction: a fixture without its accepted
   * candidate (or an accepted candidate with no fixture) is a half-state that would
   * later read as either unattributable golden truth or a lost decision.
   *
   * The decision itself is computed by `reviewFeedbackFixtureCandidate`, so the
   * refusal rules (already-decided, unnamed reviewer, missing reason, missing
   * anonymization, missing dataset version) live in ONE place.
   */
  async review(
    ctx: TenantContext,
    candidateId: string,
    input:
      | { decision: 'accept'; reviewReason: string; datasetVersion: string }
      | { decision: 'reject'; reviewReason: string },
  ): Promise<{ status: string; fixtureKey: string | null }> {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const client = tx as unknown as FixtureTx;
      const row = await client.assuranceFeedbackCandidate.findFirst({
        where: { id: candidateId, tenantId: ctx.tenantId },
      });
      if (!row) throw new BadRequestException('Feedback candidate not found.');
      // SEGREGATION OF DUTIES. Enforced here for a clear 403, and again as a DB
      // CHECK so it holds for any future writer.
      if (row.createdByUserId === ctx.userId) {
        throw new ForbiddenException(
          'The reviewer of a feedback candidate must not be the person who raised it.',
        );
      }
      const candidate: FeedbackFixtureCandidate = {
        id: row.id,
        status: row.status as FeedbackFixtureCandidate['status'],
        reasonCodes: row.reasonCodes as FeedbackReasonCode[],
        surface: row.surface,
        ...(row.traceId ? { traceId: row.traceId } : {}),
        ...(row.contextPacketId ? { contextPacketId: row.contextPacketId } : {}),
        ...(row.claimLedgerHash ? { claimLedgerHash: row.claimLedgerHash } : {}),
        ...(row.summary ? { summary: row.summary } : {}),
        createdAt: row.createdAt.toISOString(),
        createdByUserId: row.createdByUserId,
        anonymized: row.anonymized,
      };

      let outcome: ReturnType<typeof reviewFeedbackFixtureCandidate>;
      try {
        outcome =
          input.decision === 'accept'
            ? reviewFeedbackFixtureCandidate(candidate, {
                decision: 'accept',
                reviewerUserId: ctx.userId,
                reviewReason: input.reviewReason,
                // The version the export path actually applied. Passing a constant
                // here is what lets a later redaction change be distinguishable.
                anonymizationVersion: FEEDBACK_ANONYMIZATION_VERSION,
                datasetVersion: input.datasetVersion,
              })
            : reviewFeedbackFixtureCandidate(candidate, {
                decision: 'reject',
                reviewerUserId: ctx.userId,
                reviewReason: input.reviewReason,
              });
      } catch (error) {
        throw new BadRequestException(error instanceof Error ? error.message : String(error));
      }

      await client.assuranceFeedbackCandidate.update({
        where: { id: row.id },
        data: {
          status: outcome.candidate.status,
          anonymized: outcome.candidate.anonymized,
          anonymizationVersion: outcome.candidate.anonymizationVersion ?? null,
          reviewedByUserId: outcome.candidate.reviewedByUserId ?? null,
          reviewedAt: outcome.candidate.reviewedAt ? new Date(outcome.candidate.reviewedAt) : null,
          reviewReason: outcome.candidate.reviewReason ?? null,
          fixtureId: outcome.candidate.fixtureId ?? null,
        },
      });
      if (!outcome.fixture) return { status: outcome.candidate.status, fixtureKey: null };
      await client.assuranceEvalFixture.create({
        data: {
          tenantId: ctx.tenantId,
          fixtureKey: outcome.fixture.id,
          sourceCandidateId: row.id,
          datasetVersion: outcome.fixture.datasetVersion,
          category: outcome.fixture.category,
          surface: outcome.fixture.surface,
          traceRef: outcome.fixture.traceRef ?? null,
          contextPacketRef: outcome.fixture.contextPacketRef ?? null,
          claimLedgerHash: outcome.fixture.claimLedgerHash ?? null,
          anonymizationVersion: outcome.fixture.anonymizationVersion,
          acceptedByUserId: outcome.fixture.acceptedByUserId,
          acceptedAt: new Date(outcome.fixture.acceptedAt),
        },
      });
      return { status: outcome.candidate.status, fixtureKey: outcome.fixture.id };
    });
  }
}

/**
 * Normalize incoming reason codes through the assurance module, accepting BOTH
 * spellings and dropping anything unrecognized. This is the reconciliation that
 * used to be missing: the live codes (`wrong_tone_or_format`,
 * `tool_or_action_failed`) were silently filtered out, so a thumbs-down carrying
 * only one of them made candidate creation throw.
 */
export function normalizeReasons(reasons: readonly string[]): FeedbackReasonCode[] {
  return [
    ...new Set(
      reasons
        .map((reason) => normalizeFeedbackReason(reason))
        .filter((reason): reason is FeedbackReasonCode => reason !== null),
    ),
  ];
}

interface CandidateRow {
  id: string;
  status: string;
  reasonCodes: string[];
  surface: string;
  traceId: string | null;
  contextPacketId: string | null;
  claimLedgerHash: string | null;
  summary: string | null;
  createdAt: Date;
  createdByUserId: string;
  anonymized: boolean;
}

/** Minimal structural view of the tenant-scoped client this service needs. */
interface FixtureTx {
  assuranceFeedbackCandidate: {
    findFirst(args: unknown): Promise<CandidateRow | null>;
    create(args: unknown): Promise<{ id: string }>;
    update(args: unknown): Promise<unknown>;
  };
  assuranceEvalFixture: { create(args: unknown): Promise<unknown> };
}
