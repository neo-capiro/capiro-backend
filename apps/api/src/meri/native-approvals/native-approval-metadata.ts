import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { sameJson, type NativeApprovalProposal } from './native-approval.contract.js';

interface MetadataRow {
  command_id: string;
  idempotency_key: string;
  command_sha256: string;
  payload: unknown;
}

/**
 * Cross-checks a forwarded proposal against Meri's own prepared record in
 * `meri_commands.approval_metadata` (Meri migration
 * `commands/approval-metadata/migrations/0001_approval_metadata.sql`), keyed
 * by (tenant_id, actor_id, proposal_id). Core is a reader only. Until that
 * migration is applied and Core's database role is granted SELECT, every
 * approval fails closed (503) rather than trusting the forwarded JSON alone.
 */
@Injectable()
export class NativeApprovalMetadataVerifier {
  constructor(private readonly prisma: PrismaService) {}

  async verify(proposal: NativeApprovalProposal): Promise<void> {
    const { tenantId, actorId } = proposal.command.binding;
    let rows: MetadataRow[];
    try {
      rows = await this.prisma.withTenant(tenantId, (tx) => tx.$queryRaw<MetadataRow[]>(Prisma.sql`
        SELECT command_id::text AS command_id, idempotency_key, command_sha256::text AS command_sha256, payload
          FROM meri_commands.approval_metadata
         WHERE tenant_id = ${tenantId} AND actor_id = ${actorId} AND proposal_id = ${proposal.proposalId}::uuid
         LIMIT 2`));
    } catch {
      throw new ServiceUnavailableException('Approval metadata unavailable');
    }
    if (rows.length !== 1) throw new ConflictException('Approval proposal is not prepared');
    const row = rows[0]!;
    const command = proposal.command;
    const stored = (row.payload as { record?: Record<string, unknown> } | null)?.record;
    if (
      row.command_sha256 !== proposal.commandSha256 ||
      row.command_id !== command.commandId ||
      row.idempotency_key !== command.idempotencyKey ||
      !stored ||
      stored.proposalId !== proposal.proposalId ||
      stored.commandId !== command.commandId ||
      stored.idempotencyKey !== command.idempotencyKey ||
      typeof stored.createdAt !== 'string' || Date.parse(stored.createdAt) !== Date.parse(proposal.createdAt) ||
      typeof stored.expiresAt !== 'string' || Date.parse(stored.expiresAt) !== Date.parse(proposal.expiresAt) ||
      !sameJson(stored.requiredApprover, proposal.requiredApprover) ||
      !sameJson(stored.binding, command.binding) ||
      !sameJson(stored.scopes, command.scopes)
    ) {
      throw new ConflictException('Approval proposal does not match its prepared record');
    }
  }
}
