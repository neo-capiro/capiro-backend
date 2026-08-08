import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { outreachNotFound, OutreachCommandError } from '../state/outreach-command-errors.js';

export type OutreachSessionStatus = 'active' | 'completed' | 'archived';
export type OutreachProposalStatus = 'pending' | 'applied' | 'rejected' | 'superseded';
export type OutreachEventSource = 'user_control' | 'user_proposal' | 'future_model' | 'system';

export interface OutreachSessionRow {
  id: string;
  tenantId: string;
  createdByUserId: string;
  status: OutreachSessionStatus;
  currentStateVersion: number;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface OutreachStateVersionRow {
  id: string;
  tenantId: string;
  sessionId: string;
  version: number;
  schemaVersion: string;
  specJsonb: unknown;
  specHash: string;
  mutationBatchId: string | null;
  createdByUserId: string;
  createdAt: Date;
}

export interface OutreachEventRow {
  id: string;
  sequence: bigint;
  eventType: string;
  actorUserId: string;
  source: OutreachEventSource;
  stateVersionBefore: number | null;
  stateVersionAfter: number | null;
  commandBatchId: string | null;
  commandType: string | null;
  payloadHash: string | null;
  safeMetadataJsonb: unknown;
  createdAt: Date;
}

export interface OutreachProposalRow {
  id: string;
  tenantId: string;
  sessionId: string;
  createdByUserId: string;
  source: 'user' | 'future_model' | 'system';
  expectedStateVersion: number;
  commandsJsonb: unknown;
  commandsHash: string;
  status: OutreachProposalStatus;
  createdAt: Date;
  decidedAt: Date | null;
  decidedByUserId: string | null;
  appliedStateVersion: number | null;
  rejectionCode: string | null;
}

export interface AppendOutreachEventInput {
  eventType: string;
  source: OutreachEventSource;
  stateVersionBefore?: number | null;
  stateVersionAfter?: number | null;
  commandBatchId?: string | null;
  commandType?: string | null;
  payloadHash?: string | null;
  safeMetadata?: Record<string, unknown> | null;
}

@Injectable()
export class OutreachStateRepository {
  async createSessionWithinTx(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    input: {
      title: string | null;
      schemaVersion: string;
      specJsonb: unknown;
      specHash: string;
    },
  ): Promise<OutreachSessionRow> {
    const specJson = JSON.stringify(input.specJsonb);
    const sessions = await tx.$queryRaw<OutreachSessionRow[]>`
      INSERT INTO outreach_sessions (
        tenant_id, created_by_user_id, status, current_state_version, title
      ) VALUES (
        CAST(${ctx.tenantId} AS uuid), CAST(${ctx.userId} AS uuid), 'active', 1, ${input.title}
      )
      RETURNING
        id,
        tenant_id AS "tenantId",
        created_by_user_id AS "createdByUserId",
        status,
        current_state_version AS "currentStateVersion",
        title,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        archived_at AS "archivedAt"
    `;
    const session = sessions[0];
    if (!session) throw new Error('OUTREACH_SESSION_CREATE_FAILED');

    await tx.$executeRaw`
      INSERT INTO outreach_state_versions (
        tenant_id, session_id, version, schema_version, spec_jsonb, spec_hash,
        mutation_batch_id, created_by_user_id
      ) VALUES (
        CAST(${ctx.tenantId} AS uuid), CAST(${session.id} AS uuid), 1,
        ${input.schemaVersion}, CAST(${specJson} AS jsonb), ${input.specHash},
        NULL, CAST(${ctx.userId} AS uuid)
      )
    `;

    await this.appendEvent(tx, ctx, session, {
      eventType: 'session_created',
      source: 'user_control',
      stateVersionBefore: null,
      stateVersionAfter: 1,
      safeMetadata: { status: 'active', specHash: input.specHash },
    });
    return session;
  }

  async getOwnedSession(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    sessionId: string,
  ): Promise<OutreachSessionRow> {
    const rows = await tx.$queryRaw<OutreachSessionRow[]>`
      SELECT
        id,
        tenant_id AS "tenantId",
        created_by_user_id AS "createdByUserId",
        status,
        current_state_version AS "currentStateVersion",
        title,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        archived_at AS "archivedAt"
      FROM outreach_sessions
      WHERE id = CAST(${sessionId} AS uuid)
        AND tenant_id = CAST(${ctx.tenantId} AS uuid)
        AND created_by_user_id = CAST(${ctx.userId} AS uuid)
      LIMIT 1
    `;
    const session = rows[0];
    if (!session) throw outreachNotFound();
    return session;
  }

  async lockOwnedSession(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    sessionId: string,
  ): Promise<OutreachSessionRow> {
    const rows = await tx.$queryRaw<OutreachSessionRow[]>`
      SELECT
        id,
        tenant_id AS "tenantId",
        created_by_user_id AS "createdByUserId",
        status,
        current_state_version AS "currentStateVersion",
        title,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        archived_at AS "archivedAt"
      FROM outreach_sessions
      WHERE id = CAST(${sessionId} AS uuid)
        AND tenant_id = CAST(${ctx.tenantId} AS uuid)
        AND created_by_user_id = CAST(${ctx.userId} AS uuid)
      FOR UPDATE
    `;
    const session = rows[0];
    if (!session) throw outreachNotFound();
    return session;
  }

  async listOwnedSessions(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    input: { limit: number; offset: number; includeArchived: boolean },
  ): Promise<OutreachSessionRow[]> {
    return tx.$queryRaw<OutreachSessionRow[]>`
      SELECT
        id,
        tenant_id AS "tenantId",
        created_by_user_id AS "createdByUserId",
        status,
        current_state_version AS "currentStateVersion",
        title,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        archived_at AS "archivedAt"
      FROM outreach_sessions
      WHERE tenant_id = CAST(${ctx.tenantId} AS uuid)
        AND created_by_user_id = CAST(${ctx.userId} AS uuid)
        AND (${input.includeArchived} OR status <> 'archived')
      ORDER BY updated_at DESC, id DESC
      LIMIT ${input.limit}
      OFFSET ${input.offset}
    `;
  }

  async loadStateVersion(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    sessionId: string,
    version: number,
  ): Promise<OutreachStateVersionRow> {
    const rows = await tx.$queryRaw<OutreachStateVersionRow[]>`
      SELECT
        v.id,
        v.tenant_id AS "tenantId",
        v.session_id AS "sessionId",
        v.version,
        v.schema_version AS "schemaVersion",
        v.spec_jsonb AS "specJsonb",
        v.spec_hash AS "specHash",
        v.mutation_batch_id AS "mutationBatchId",
        v.created_by_user_id AS "createdByUserId",
        v.created_at AS "createdAt"
      FROM outreach_state_versions v
      INNER JOIN outreach_sessions s ON s.id = v.session_id
      WHERE v.tenant_id = CAST(${ctx.tenantId} AS uuid)
        AND v.session_id = CAST(${sessionId} AS uuid)
        AND v.version = ${version}
        AND s.created_by_user_id = CAST(${ctx.userId} AS uuid)
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      throw new OutreachCommandError(
        'OUTREACH_STATE_VERSION_NOT_FOUND',
        'The requested outreach state version was not found.',
        404,
      );
    }
    return row;
  }

  async listStateVersions(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    sessionId: string,
    limit: number,
  ): Promise<Array<Omit<OutreachStateVersionRow, 'specJsonb'>>> {
    await this.getOwnedSession(tx, ctx, sessionId);
    return tx.$queryRaw<Array<Omit<OutreachStateVersionRow, 'specJsonb'>>>`
      SELECT
        id,
        tenant_id AS "tenantId",
        session_id AS "sessionId",
        version,
        schema_version AS "schemaVersion",
        spec_hash AS "specHash",
        mutation_batch_id AS "mutationBatchId",
        created_by_user_id AS "createdByUserId",
        created_at AS "createdAt"
      FROM outreach_state_versions
      WHERE tenant_id = CAST(${ctx.tenantId} AS uuid)
        AND session_id = CAST(${sessionId} AS uuid)
      ORDER BY version DESC
      LIMIT ${limit}
    `;
  }

  async insertStateVersion(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    input: {
      sessionId: string;
      version: number;
      schemaVersion: string;
      specJsonb: unknown;
      specHash: string;
      mutationBatchId: string | null;
    },
  ): Promise<void> {
    const specJson = JSON.stringify(input.specJsonb);
    await tx.$executeRaw`
      INSERT INTO outreach_state_versions (
        tenant_id, session_id, version, schema_version, spec_jsonb, spec_hash,
        mutation_batch_id, created_by_user_id
      ) VALUES (
        CAST(${ctx.tenantId} AS uuid), CAST(${input.sessionId} AS uuid), ${input.version},
        ${input.schemaVersion}, CAST(${specJson} AS jsonb), ${input.specHash},
        CAST(${input.mutationBatchId} AS uuid), CAST(${ctx.userId} AS uuid)
      )
    `;
  }

  async updateCurrentVersion(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    sessionId: string,
    expectedVersion: number,
    nextVersion: number,
  ): Promise<void> {
    const changed = await tx.$executeRaw`
      UPDATE outreach_sessions
      SET current_state_version = ${nextVersion}
      WHERE id = CAST(${sessionId} AS uuid)
        AND tenant_id = CAST(${ctx.tenantId} AS uuid)
        AND created_by_user_id = CAST(${ctx.userId} AS uuid)
        AND current_state_version = ${expectedVersion}
        AND status = 'active'
    `;
    if (changed !== 1) {
      throw new OutreachCommandError(
        'OUTREACH_STATE_CONFLICT',
        'The outreach session changed before the command could be committed.',
        409,
      );
    }
  }

  async archiveSession(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    session: OutreachSessionRow,
  ): Promise<void> {
    if (session.status === 'archived') return;
    await tx.$executeRaw`
      UPDATE outreach_sessions
      SET status = 'archived', archived_at = NOW()
      WHERE id = CAST(${session.id} AS uuid)
        AND tenant_id = CAST(${ctx.tenantId} AS uuid)
        AND created_by_user_id = CAST(${ctx.userId} AS uuid)
    `;
    await this.appendEvent(tx, ctx, session, {
      eventType: 'session_archived',
      source: 'user_control',
      stateVersionBefore: session.currentStateVersion,
      stateVersionAfter: session.currentStateVersion,
    });
  }

  /** Caller must hold the outreach_sessions row lock before allocating sequence. */
  private async nextEventSequence(
    tx: Prisma.TransactionClient,
    sessionId: string,
  ): Promise<bigint> {
    const rows = await tx.$queryRaw<Array<{ sequence: bigint }>>`
      SELECT COALESCE(MAX(sequence), 0)::bigint + 1::bigint AS sequence
      FROM outreach_events
      WHERE session_id = CAST(${sessionId} AS uuid)
    `;
    return rows[0]?.sequence ?? 1n;
  }

  async appendEvent(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    session: Pick<OutreachSessionRow, 'id'>,
    input: AppendOutreachEventInput,
  ): Promise<OutreachEventRow> {
    const sequence = await this.nextEventSequence(tx, session.id);
    const safeMetadata = input.safeMetadata ? JSON.stringify(input.safeMetadata) : null;
    const rows = await tx.$queryRaw<OutreachEventRow[]>`
      INSERT INTO outreach_events (
        tenant_id, session_id, sequence, event_type, actor_user_id, source,
        state_version_before, state_version_after, command_batch_id, command_type,
        payload_jsonb, payload_hash, safe_metadata_jsonb
      ) VALUES (
        CAST(${ctx.tenantId} AS uuid), CAST(${session.id} AS uuid), ${sequence},
        ${input.eventType}, CAST(${ctx.userId} AS uuid), ${input.source},
        ${input.stateVersionBefore ?? null}, ${input.stateVersionAfter ?? null},
        CAST(${input.commandBatchId ?? null} AS uuid), ${input.commandType ?? null},
        NULL, ${input.payloadHash ?? null}, CAST(${safeMetadata} AS jsonb)
      )
      RETURNING
        id,
        sequence,
        event_type AS "eventType",
        actor_user_id AS "actorUserId",
        source,
        state_version_before AS "stateVersionBefore",
        state_version_after AS "stateVersionAfter",
        command_batch_id AS "commandBatchId",
        command_type AS "commandType",
        payload_hash AS "payloadHash",
        safe_metadata_jsonb AS "safeMetadataJsonb",
        created_at AS "createdAt"
    `;
    const event = rows[0];
    if (!event) throw new Error('OUTREACH_EVENT_APPEND_FAILED');
    return event;
  }

  async findBatchResult(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    sessionId: string,
    batchId: string,
  ): Promise<OutreachEventRow | null> {
    const rows = await tx.$queryRaw<OutreachEventRow[]>`
      SELECT
        id,
        sequence,
        event_type AS "eventType",
        actor_user_id AS "actorUserId",
        source,
        state_version_before AS "stateVersionBefore",
        state_version_after AS "stateVersionAfter",
        command_batch_id AS "commandBatchId",
        command_type AS "commandType",
        payload_hash AS "payloadHash",
        safe_metadata_jsonb AS "safeMetadataJsonb",
        created_at AS "createdAt"
      FROM outreach_events
      WHERE tenant_id = CAST(${ctx.tenantId} AS uuid)
        AND session_id = CAST(${sessionId} AS uuid)
        AND event_type = 'command_batch_result'
        AND command_batch_id = CAST(${batchId} AS uuid)
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async listEvents(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    sessionId: string,
    limit: number,
  ): Promise<OutreachEventRow[]> {
    await this.getOwnedSession(tx, ctx, sessionId);
    return tx.$queryRaw<OutreachEventRow[]>`
      SELECT
        id,
        sequence,
        event_type AS "eventType",
        actor_user_id AS "actorUserId",
        source,
        state_version_before AS "stateVersionBefore",
        state_version_after AS "stateVersionAfter",
        command_batch_id AS "commandBatchId",
        command_type AS "commandType",
        payload_hash AS "payloadHash",
        safe_metadata_jsonb AS "safeMetadataJsonb",
        created_at AS "createdAt"
      FROM outreach_events
      WHERE tenant_id = CAST(${ctx.tenantId} AS uuid)
        AND session_id = CAST(${sessionId} AS uuid)
      ORDER BY sequence DESC
      LIMIT ${limit}
    `;
  }

  async createProposal(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    session: OutreachSessionRow,
    input: { expectedStateVersion: number; commands: unknown; commandsHash: string },
  ): Promise<OutreachProposalRow> {
    const commandsJson = JSON.stringify(input.commands);
    const rows = await tx.$queryRaw<OutreachProposalRow[]>`
      INSERT INTO outreach_command_proposals (
        tenant_id, session_id, created_by_user_id, source, expected_state_version,
        commands_jsonb, commands_hash, status
      ) VALUES (
        CAST(${ctx.tenantId} AS uuid), CAST(${session.id} AS uuid),
        CAST(${ctx.userId} AS uuid), 'user', ${input.expectedStateVersion},
        CAST(${commandsJson} AS jsonb), ${input.commandsHash}, 'pending'
      )
      RETURNING
        id,
        tenant_id AS "tenantId",
        session_id AS "sessionId",
        created_by_user_id AS "createdByUserId",
        source,
        expected_state_version AS "expectedStateVersion",
        commands_jsonb AS "commandsJsonb",
        commands_hash AS "commandsHash",
        status,
        created_at AS "createdAt",
        decided_at AS "decidedAt",
        decided_by_user_id AS "decidedByUserId",
        applied_state_version AS "appliedStateVersion",
        rejection_code AS "rejectionCode"
    `;
    const proposal = rows[0];
    if (!proposal) throw new Error('OUTREACH_PROPOSAL_CREATE_FAILED');
    return proposal;
  }

  async lockOwnedProposal(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    sessionId: string,
    proposalId: string,
  ): Promise<OutreachProposalRow> {
    const rows = await tx.$queryRaw<OutreachProposalRow[]>`
      SELECT
        p.id,
        p.tenant_id AS "tenantId",
        p.session_id AS "sessionId",
        p.created_by_user_id AS "createdByUserId",
        p.source,
        p.expected_state_version AS "expectedStateVersion",
        p.commands_jsonb AS "commandsJsonb",
        p.commands_hash AS "commandsHash",
        p.status,
        p.created_at AS "createdAt",
        p.decided_at AS "decidedAt",
        p.decided_by_user_id AS "decidedByUserId",
        p.applied_state_version AS "appliedStateVersion",
        p.rejection_code AS "rejectionCode"
      FROM outreach_command_proposals p
      INNER JOIN outreach_sessions s ON s.id = p.session_id
      WHERE p.id = CAST(${proposalId} AS uuid)
        AND p.session_id = CAST(${sessionId} AS uuid)
        AND p.tenant_id = CAST(${ctx.tenantId} AS uuid)
        AND s.created_by_user_id = CAST(${ctx.userId} AS uuid)
      FOR UPDATE OF p
    `;
    const proposal = rows[0];
    if (!proposal) {
      throw new OutreachCommandError(
        'OUTREACH_PROPOSAL_NOT_FOUND',
        'The requested outreach proposal was not found.',
        404,
      );
    }
    return proposal;
  }

  async listOwnedProposals(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    sessionId: string,
    limit: number,
  ): Promise<OutreachProposalRow[]> {
    await this.getOwnedSession(tx, ctx, sessionId);
    return tx.$queryRaw<OutreachProposalRow[]>`
      SELECT
        p.id,
        p.tenant_id AS "tenantId",
        p.session_id AS "sessionId",
        p.created_by_user_id AS "createdByUserId",
        p.source,
        p.expected_state_version AS "expectedStateVersion",
        p.commands_jsonb AS "commandsJsonb",
        p.commands_hash AS "commandsHash",
        p.status,
        p.created_at AS "createdAt",
        p.decided_at AS "decidedAt",
        p.decided_by_user_id AS "decidedByUserId",
        p.applied_state_version AS "appliedStateVersion",
        p.rejection_code AS "rejectionCode"
      FROM outreach_command_proposals p
      INNER JOIN outreach_sessions s ON s.id = p.session_id
      WHERE p.session_id = CAST(${sessionId} AS uuid)
        AND p.tenant_id = CAST(${ctx.tenantId} AS uuid)
        AND s.created_by_user_id = CAST(${ctx.userId} AS uuid)
      ORDER BY p.created_at DESC
      LIMIT ${limit}
    `;
  }

  async markProposalApplied(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    proposalId: string,
    appliedStateVersion: number,
  ): Promise<void> {
    const changed = await tx.$executeRaw`
      UPDATE outreach_command_proposals
      SET status = 'applied', decided_at = NOW(), decided_by_user_id = CAST(${ctx.userId} AS uuid),
          applied_state_version = ${appliedStateVersion}, rejection_code = NULL
      WHERE id = CAST(${proposalId} AS uuid)
        AND tenant_id = CAST(${ctx.tenantId} AS uuid)
        AND status = 'pending'
    `;
    if (changed !== 1) {
      throw new OutreachCommandError(
        'OUTREACH_PROPOSAL_ALREADY_DECIDED',
        'The outreach proposal is no longer pending.',
        409,
      );
    }
  }

  async rejectProposal(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    proposalId: string,
    rejectionCode: string | null,
  ): Promise<void> {
    const changed = await tx.$executeRaw`
      UPDATE outreach_command_proposals
      SET status = 'rejected', decided_at = NOW(), decided_by_user_id = CAST(${ctx.userId} AS uuid),
          rejection_code = ${rejectionCode}
      WHERE id = CAST(${proposalId} AS uuid)
        AND tenant_id = CAST(${ctx.tenantId} AS uuid)
        AND status = 'pending'
    `;
    if (changed !== 1) {
      throw new OutreachCommandError(
        'OUTREACH_PROPOSAL_ALREADY_DECIDED',
        'The outreach proposal is no longer pending.',
        409,
      );
    }
  }

  async supersedeStaleProposals(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    sessionId: string,
    currentStateVersion: number,
    excludeProposalId: string | null = null,
  ): Promise<number> {
    return tx.$executeRaw`
      UPDATE outreach_command_proposals
      SET status = 'superseded', decided_at = NOW(), rejection_code = 'state_advanced'
      WHERE tenant_id = CAST(${ctx.tenantId} AS uuid)
        AND session_id = CAST(${sessionId} AS uuid)
        AND status = 'pending'
        AND expected_state_version < ${currentStateVersion}
        AND (${excludeProposalId}::text IS NULL OR id <> CAST(${excludeProposalId} AS uuid))
    `;
  }

  async countPendingProposals(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    sessionId: string,
  ): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM outreach_command_proposals
      WHERE tenant_id = CAST(${ctx.tenantId} AS uuid)
        AND session_id = CAST(${sessionId} AS uuid)
        AND status = 'pending'
    `;
    return Number(rows[0]?.count ?? 0n);
  }
}
