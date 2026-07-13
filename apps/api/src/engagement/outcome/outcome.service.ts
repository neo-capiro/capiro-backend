import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';

export const OUTCOME_KINDS = [
  'response_received',
  'meeting_scheduled',
  'meeting_held',
  'language_included',
  'funding_changed',
  'filing_completed',
  'commitment_secured',
  'no_action',
] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

export const OUTCOME_SOURCE_TYPES = [
  'outreach',
  'meeting',
  'artifact',
  'campaign',
  'submission',
  'manual',
] as const;
export type OutcomeSourceType = (typeof OUTCOME_SOURCE_TYPES)[number];

export interface RecordOutcomeInput {
  kind: OutcomeKind;
  sourceType: OutcomeSourceType;
  sourceId?: string | null;
  clientId?: string | null;
  evidence?: Record<string, unknown>;
  notes?: string | null;
  observedAt?: Date | null;
}

/**
 * G3 — structured advocacy outcomes (blueprint §3.1 stage 5). The write/read
 * surface for `outcome_event`: what happened as a RESULT of the firm's work,
 * linked (loosely, polymorphically) to the outreach/meeting/artifact/
 * submission that produced it. This is the signal the operating-memory
 * flywheel compounds on — collect it from day one, derive analytics later.
 *
 * Two writer classes:
 *  - `record` (user-attributed; the manual REST route)
 *  - `recordSystem` (system mirrors, e.g. a ClientSubmissionHistory outcome
 *    landing as funding_changed/language_included; recorded_by NULL,
 *    fail-open — a mirror failure never breaks the source write).
 */
@Injectable()
export class OutcomeService {
  private readonly logger = new Logger(OutcomeService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(ctx: TenantContext, input: RecordOutcomeInput) {
    validate(input);
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.outcomeEvent.create({
        data: {
          tenantId: ctx.tenantId,
          clientId: input.clientId ?? null,
          kind: input.kind,
          sourceType: input.sourceType,
          sourceId: input.sourceId ?? null,
          evidence: (input.evidence ?? {}) as Prisma.InputJsonValue,
          notes: input.notes ?? null,
          recordedBy: ctx.userId,
          ...(input.observedAt ? { observedAt: input.observedAt } : {}),
        },
      }),
    );
  }

  /** System mirror — fail-open by contract; never breaks the source write. */
  async recordSystem(tenantId: string, input: RecordOutcomeInput): Promise<void> {
    try {
      validate(input);
      await this.prisma.withTenant(tenantId, (tx) =>
        tx.outcomeEvent.create({
          data: {
            tenantId,
            clientId: input.clientId ?? null,
            kind: input.kind,
            sourceType: input.sourceType,
            sourceId: input.sourceId ?? null,
            evidence: (input.evidence ?? {}) as Prisma.InputJsonValue,
            notes: input.notes ?? null,
            recordedBy: null,
            ...(input.observedAt ? { observedAt: input.observedAt } : {}),
          },
        }),
      );
    } catch (e) {
      this.logger.warn(`outcome mirror failed (non-fatal): ${(e as Error).message}`);
    }
  }

  async list(
    ctx: TenantContext,
    filter?: { clientId?: string; kind?: string; limit?: number },
  ) {
    const take = Math.min(Math.max(filter?.limit ?? 50, 1), 200);
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.outcomeEvent.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...(filter?.clientId ? { clientId: filter.clientId } : {}),
          ...(filter?.kind ? { kind: filter.kind } : {}),
        },
        orderBy: { observedAt: 'desc' },
        take,
      }),
    );
  }
}

function validate(input: RecordOutcomeInput): void {
  if (!OUTCOME_KINDS.includes(input.kind)) {
    throw new BadRequestException(`Unknown outcome kind: ${input.kind}`);
  }
  if (!OUTCOME_SOURCE_TYPES.includes(input.sourceType)) {
    throw new BadRequestException(`Unknown outcome sourceType: ${input.sourceType}`);
  }
}
