import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { sameJson, type NativeApprovalProposal } from './native-approval.contract.js';

interface PreparedApproval {
  proposal_id: string;
  command_id: string;
  idempotency_key: string;
  command_sha256: string;
  record: unknown;
}

interface RunFactsRow {
  tenant_id: string;
  conversation_id: string;
  run_id: string;
  run_binding: unknown;
  prepared_approvals: unknown;
  prepared_approvals_overflow: boolean;
}

const unavailable = () => new ServiceUnavailableException('Approval metadata unavailable');
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

/**
 * Cross-checks a forwarded proposal against Meri's bounded, proposal-keyed
 * prepared-approval projection on `meri_read_delegation_facts.run_facts_v1`.
 * Meri's migrator owns the base metadata and the security-barrier facts view;
 * Core needs only the existing facts-view SELECT grant. Missing, malformed or
 * overflowing projection data is unavailable, never authority from the body.
 */
@Injectable()
export class NativeApprovalMetadataVerifier {
  constructor(private readonly prisma: PrismaService) {}

  /** Passing the caller's tenant transaction keeps issuance verification under
   * its proposal lock. Approval recording uses its own tenant transaction. */
  async verify(proposal: NativeApprovalProposal, transaction?: Prisma.TransactionClient): Promise<void> {
    const { tenantId, actorId, conversationId, runId } = proposal.command.binding;
    const read = (tx: Prisma.TransactionClient) => tx.$queryRaw<RunFactsRow[]>(Prisma.sql`
      SELECT tenant_id::text AS tenant_id, conversation_id::text AS conversation_id,
             run_id::text AS run_id, run_binding, prepared_approvals, prepared_approvals_overflow
        FROM meri_read_delegation_facts.run_facts_v1
       WHERE tenant_id = ${tenantId} AND conversation_id = ${conversationId}::uuid
         AND run_id = ${runId}::uuid AND run_binding->>'tenantId' = ${tenantId}
         AND run_binding->>'actorId' = ${actorId}
         AND run_binding->>'conversationId' = ${conversationId}
         AND run_binding->>'runId' = ${runId}
       LIMIT 2`);
    let rows: RunFactsRow[];
    try {
      rows = transaction ? await read(transaction) : await this.prisma.withTenant(tenantId, read);
    } catch {
      throw unavailable();
    }
    if (!Array.isArray(rows) || rows.length !== 1) throw unavailable();
    const view = rows[0]!;
    if (view.tenant_id !== tenantId || view.conversation_id !== conversationId || view.run_id !== runId ||
        !object(view.run_binding) || view.run_binding.tenantId !== tenantId ||
        view.run_binding.actorId !== actorId || view.run_binding.conversationId !== conversationId ||
        view.run_binding.runId !== runId ||
        view.prepared_approvals_overflow !== false || !Array.isArray(view.prepared_approvals) ||
        view.prepared_approvals.length > 64) throw unavailable();

    let selected: PreparedApproval | null = null;
    const seen = new Set<string>();
    for (const item of view.prepared_approvals) {
      if (!object(item) || !exactKeys(item, ['proposal_id', 'command_id', 'idempotency_key', 'command_sha256', 'record']) ||
          typeof item.proposal_id !== 'string' || typeof item.command_id !== 'string' ||
          typeof item.idempotency_key !== 'string' || typeof item.command_sha256 !== 'string' ||
          !object(item.record) || !exactKeys(item.record, ['proposalId', 'commandId', 'idempotencyKey',
            'createdAt', 'expiresAt', 'requiredApprover', 'binding', 'scopes']) ||
          seen.has(item.proposal_id)) throw unavailable();
      seen.add(item.proposal_id);
      if (item.proposal_id === proposal.proposalId) selected = item as unknown as PreparedApproval;
    }
    if (!selected) throw new ConflictException('Approval proposal is not prepared');
    const stored = selected.record as Record<string, unknown>;
    const command = proposal.command;
    if (
      selected.command_sha256 !== proposal.commandSha256 ||
      selected.command_id !== command.commandId ||
      selected.idempotency_key !== command.idempotencyKey ||
      stored.proposalId !== selected.proposal_id ||
      stored.commandId !== selected.command_id ||
      stored.idempotencyKey !== selected.idempotency_key ||
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
