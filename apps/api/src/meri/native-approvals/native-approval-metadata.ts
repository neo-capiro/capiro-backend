import { ConflictException, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { nativeCanonicalSha256, sameJson, type NativeApprovalProposal } from './native-approval.contract.js';

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
 * Checks document proposals against the actual control metadata and native run.
 * Existing task proposals retain their applied facts-view reader. Neither path
 * treats a forwarded proposal as authority or publishes its requested effect.
 */
@Injectable()
export class NativeApprovalMetadataVerifier {
  constructor(private readonly prisma: PrismaService, @Optional() private readonly config?: ConfigService) {}

  /** Passing the caller's tenant transaction keeps issuance verification under
   * its proposal lock. Approval recording uses its own tenant transaction. */
  async verify(proposal: NativeApprovalProposal, transaction?: Prisma.TransactionClient): Promise<void> {
    if (proposal.command.action === 'document.draft') {
      // A private network read never holds a caller's database transaction.
      if (transaction) throw unavailable();
      return this.document(proposal);
    }
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

  /** Actual immutable control metadata, under the existing service identity.
   * The fixed endpoint validates canonical native run/scope/retention custody;
   * Core compares the complete payload and retains the user decision itself. */
  private async document(proposal: NativeApprovalProposal): Promise<void> {
    const origin = this.config?.get<string>('MERI_CONTROL_ORIGIN');
    const secret = this.config?.get<string>('INTERNAL_SERVICE_SECRET');
    let base: URL;
    try { base = new URL(origin ?? ''); } catch { throw unavailable(); }
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash ||
        base.pathname !== '/' || !secret || /[\r\n]/.test(secret)) throw unavailable();
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 3000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(new URL('/v1/internal/approval-metadata/read', base), {
        method: 'POST', redirect: 'error', signal: abort.signal,
        headers: { 'content-type': 'application/json', 'x-internal-service-secret': secret },
        body: JSON.stringify({ schemaVersion: 1, proposalId: proposal.proposalId, binding: proposal.command.binding }),
      });
      if (response.status !== 200 || !response.body) throw unavailable();
      reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 256 * 1024) throw unavailable();
        chunks.push(next.value);
      }
      const actual = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      const c = proposal.command;
      const metadata = { record: { operation: { id: 'create_word', version: '0.2.0' }, action: c.action,
        binding: c.binding, request: c.arguments, inputSha256: nativeCanonicalSha256({ arguments: c.arguments, attachments: [] }),
        commandId: c.commandId, idempotencyKey: c.idempotencyKey, proposalId: proposal.proposalId,
        scopes: c.scopes, createdAt: proposal.createdAt, expiresAt: proposal.expiresAt, requiredApprover: proposal.requiredApprover },
        commandContext: { binding: c.binding, scopes: c.scopes }, commandSha256: proposal.commandSha256 };
      if (abort.signal.aborted) throw unavailable();
      if (!object(actual) || !exactKeys(actual, ['schemaVersion', 'commandSha256', 'metadata', 'run']) ||
          actual.schemaVersion !== 1 || actual.commandSha256 !== proposal.commandSha256 || !sameJson(actual.metadata, metadata) ||
          !object(actual.run) || !sameJson(actual.run.binding, c.binding) || !sameJson(actual.run.scopes, c.scopes) ||
          !['queued', 'starting', 'running', 'paused', 'waiting-for-approval', 'completed'].includes(actual.run.state as string))
        throw new ConflictException('Approval proposal does not match its prepared record');
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw unavailable();
    } finally {
      clearTimeout(timer); abort.abort();
      if (reader) await reader.cancel().catch(() => undefined);
    }
  }
}
