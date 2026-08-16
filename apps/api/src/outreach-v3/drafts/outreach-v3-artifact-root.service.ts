import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { OutreachSessionService } from '../services/outreach-session.service.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';

export const OUTREACH_V3_INTERNAL_RECORD_TYPE = 'outreach_v3' as const;
export const OUTREACH_V3_ARTIFACT_ROOT_SCHEMA_VERSION = 'outreach_v3_artifact_root_v1' as const;

/**
 * Compatibility parent for the mature immutable draft/send FK graph.
 *
 * The parent is NOT campaign state. Canonical Campaign Spec remains solely in
 * outreach_state_versions; this row stores only a stable parent identity and
 * safe pointer metadata. Classic access predicates explicitly exclude the
 * reserved type.
 */
@Injectable()
export class OutreachV3ArtifactRootService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: OutreachSessionService,
  ) {}

  async ensureRoot(ctx: TenantContext, sessionId: string): Promise<{ outreachRecordId: string }> {
    const current = await this.sessions.getSession(ctx, sessionId);
    if (current.session.status !== 'active') {
      throw new OutreachCommandError(
        'OUTREACH_SESSION_ARCHIVED',
        'Archived outreach sessions cannot create draft artifacts.',
        409,
      );
    }

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.outreachRecord.findFirst({
        where: { id: sessionId, tenantId: ctx.tenantId },
        select: {
          id: true,
          type: true,
          status: true,
          createdByUserId: true,
          deletedAt: true,
        },
      });
      if (existing) {
        if (
          existing.type !== OUTREACH_V3_INTERNAL_RECORD_TYPE ||
          existing.createdByUserId !== ctx.userId ||
          existing.deletedAt !== null
        ) {
          throw new OutreachCommandError(
            'OUTREACH_STATE_CORRUPT',
            'The campaign artifact root conflicts with an existing outreach record.',
            500,
          );
        }
        return { outreachRecordId: existing.id };
      }

      const created = await tx.outreachRecord.create({
        data: {
          // outreach_sessions.id is already UUID. Reusing it provides one stable
          // artifact parent per V3 campaign without another mapping table.
          id: sessionId,
          tenantId: ctx.tenantId,
          createdByUserId: ctx.userId,
          clientId: null,
          meetingId: null,
          type: OUTREACH_V3_INTERNAL_RECORD_TYPE,
          status: 'draft',
          title: current.session.title?.trim() || 'Outreach V3 campaign',
          metadata: {
            schemaVersion: OUTREACH_V3_ARTIFACT_ROOT_SCHEMA_VERSION,
            outreachV3SessionId: sessionId,
          },
          // Canonical recipients, subject, body and campaign state intentionally
          // do not live on this compatibility root.
          recipients: [],
          recipientCount: 0,
        },
        select: { id: true },
      });
      return { outreachRecordId: created.id };
    });
  }
}
