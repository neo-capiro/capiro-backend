import { Injectable } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  OutreachStateRepository,
  type OutreachStateVersionRow,
} from '../persistence/outreach-state.repository.js';
import {
  createBlankCampaignSpecV1,
  hashCampaignSpecV1,
  OUTREACH_CAMPAIGN_SPEC_SCHEMA_VERSION,
  parseCampaignSpecV1,
} from '../state/outreach-campaign-spec.v1.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import {
  deriveOutreachReadiness,
  PHASE5_OUTREACH_FEATURE_AVAILABILITY,
} from '../state/outreach-readiness.contract.js';

@Injectable()
export class OutreachSessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: OutreachStateRepository,
  ) {}

  async createSession(ctx: TenantContext, input?: { title?: string | null }) {
    const title = input?.title?.trim() || null;
    if (title && title.length > 240) {
      throw new OutreachCommandError(
        'OUTREACH_COMMAND_INVALID',
        'Session title exceeds the allowed length.',
        400,
      );
    }
    const spec = createBlankCampaignSpecV1();
    const specHash = hashCampaignSpecV1(spec);

    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const session = await this.repository.createSessionWithinTx(tx, ctx, {
        title,
        schemaVersion: OUTREACH_CAMPAIGN_SPEC_SCHEMA_VERSION,
        specJsonb: spec,
        specHash,
      });
      return {
        session,
        currentStateVersion: 1,
        spec,
        specHash,
        readiness: deriveOutreachReadiness(spec, PHASE5_OUTREACH_FEATURE_AVAILABILITY),
        pendingProposalCount: 0,
      };
    });
  }

  async listSessions(
    ctx: TenantContext,
    input: { limit?: number; offset?: number; includeArchived?: boolean } = {},
  ) {
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
    const offset = Math.max(input.offset ?? 0, 0);
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      this.repository.listOwnedSessions(tx, ctx, {
        limit,
        offset,
        includeArchived: input.includeArchived ?? false,
      }),
    );
  }

  async getSession(ctx: TenantContext, sessionId: string) {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const session = await this.repository.getOwnedSession(tx, ctx, sessionId);
      const version = await this.repository.loadStateVersion(
        tx,
        ctx,
        session.id,
        session.currentStateVersion,
      );
      const spec = this.parseAndVerifyVersion(version);
      const pendingProposalCount = await this.repository.countPendingProposals(
        tx,
        ctx,
        session.id,
      );
      return {
        session,
        currentStateVersion: version.version,
        spec,
        specHash: version.specHash,
        readiness: deriveOutreachReadiness(spec, PHASE5_OUTREACH_FEATURE_AVAILABILITY),
        pendingProposalCount,
      };
    });
  }

  async archiveSession(ctx: TenantContext, sessionId: string) {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const session = await this.repository.lockOwnedSession(tx, ctx, sessionId);
      await this.repository.archiveSession(tx, ctx, session);
      await tx.$executeRaw`
        UPDATE outreach_command_proposals
        SET status = 'superseded', decided_at = NOW(), rejection_code = 'session_archived'
        WHERE tenant_id = CAST(${ctx.tenantId} AS uuid)
          AND session_id = CAST(${session.id} AS uuid)
          AND status = 'pending'
      `;
      return {
        id: session.id,
        status: 'archived' as const,
        currentStateVersion: session.currentStateVersion,
      };
    });
  }

  async listVersions(ctx: TenantContext, sessionId: string, limit = 100) {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, (tx) =>
      this.repository.listStateVersions(tx, ctx, sessionId, Math.min(Math.max(limit, 1), 200)),
    );
  }

  async getVersion(ctx: TenantContext, sessionId: string, version: number) {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      await this.repository.getOwnedSession(tx, ctx, sessionId);
      const row = await this.repository.loadStateVersion(tx, ctx, sessionId, version);
      return { ...row, specJsonb: this.parseAndVerifyVersion(row) };
    });
  }

  async listEvents(ctx: TenantContext, sessionId: string, limit = 100) {
    return this.prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
      const rows = await this.repository.listEvents(
        tx,
        ctx,
        sessionId,
        Math.min(Math.max(limit, 1), 200),
      );
      return rows.map((row) => ({ ...row, sequence: row.sequence.toString() }));
    });
  }

  private parseAndVerifyVersion(row: OutreachStateVersionRow) {
    let spec;
    try {
      spec = parseCampaignSpecV1(row.specJsonb);
    } catch {
      throw new OutreachCommandError(
        'OUTREACH_STATE_CORRUPT',
        'The stored outreach state could not be validated.',
        500,
        { version: row.version },
      );
    }
    const computedHash = hashCampaignSpecV1(spec);
    if (computedHash !== row.specHash) {
      throw new OutreachCommandError(
        'OUTREACH_STATE_CORRUPT',
        'The stored outreach state hash does not match its canonical content.',
        500,
        { version: row.version },
      );
    }
    return spec;
  }
}
