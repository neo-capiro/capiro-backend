import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { MAX_CLEANUP_ATTEMPTS } from './memory-cleanup-outbox.service.js';

interface TerminalProjectionJob {
  tenant_id: string;
  memory_item_id: string;
  clio_memory_id: string | null;
}

/** The canonical terminal projection effect. No lifecycle or audit mutation. */
export async function deleteTerminalMemoryProjectionsInTx(
  tx: Prisma.TransactionClient,
  job: TerminalProjectionJob,
) {
  const present = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id::text AS id FROM memory_items
    WHERE id = ${job.memory_item_id}::uuid AND tenant_id = ${job.tenant_id}::uuid
    FOR UPDATE
  `;
  const embeddingsDeleted = await tx.$executeRaw`
    DELETE FROM context_embeddings
    WHERE tenant_id = ${job.tenant_id}::uuid
      AND source_type = 'memory_item' AND source_id = ${job.memory_item_id}
  `;
  let clioDeleted = 0;
  if (job.clio_memory_id) {
    clioDeleted = await tx.$executeRaw`
      DELETE FROM clio_memory
      WHERE id = ${job.clio_memory_id}::uuid AND tenant_id = ${job.tenant_id}::uuid
    `;
  }
  return { vanished: present.length === 0, embeddingsDeleted, clioDeleted };
}

export interface ExactOwnedTerminalCleanup extends TerminalProjectionJob {
  id: string;
  row_version: string;
  operation: 'revoke_projections' | 'supersede_projections';
  idempotency_key: string;
}

/** Internal owned-corpus port. The fixture owner derives and authenticates the
 * original job/audit binding, then supplies its already locked before version.
 * Claim, effect and completion stay in this SAME caller transaction; an outer
 * preview savepoint therefore rolls back every effect and job update together. */
export async function completeExactOwnedTerminalCleanupInTx(
  tx: Prisma.TransactionClient,
  job: ExactOwnedTerminalCleanup,
) {
  const leaseOwner = `memory-owned-cleanup:${randomUUID()}`;
  const expectedState = job.operation === 'revoke_projections' ? 'revoked' : 'superseded';
  if (!['revoke_projections', 'supersede_projections'].includes(job.operation)) {
    throw new Error('memory_owned_cleanup_operation_refused');
  }
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE memory_cleanup_outbox AS job
    SET status = 'running', attempts = job.attempts + 1,
        lease_owner = ${leaseOwner}, lease_expires_at = now() + interval '5 minutes',
        started_at = COALESCE(job.started_at, now()), last_error = NULL
    WHERE job.id = ${job.id}::uuid AND job.tenant_id = ${job.tenant_id}::uuid
      AND job.memory_item_id = ${job.memory_item_id}::uuid
      AND job.clio_memory_id IS NOT DISTINCT FROM ${job.clio_memory_id}::uuid
      AND job.operation = ${job.operation} AND job.idempotency_key = ${job.idempotency_key}
      AND job.xmin::text = ${job.row_version}
      AND job.status IN ('pending', 'failed') AND job.next_attempt_at <= now()
      AND job.attempts < ${MAX_CLEANUP_ATTEMPTS}
      AND job.expected_source_version IS NULL AND job.expected_content_hash IS NULL
      AND EXISTS (SELECT 1 FROM memory_items m WHERE m.id = job.memory_item_id
        AND m.tenant_id = job.tenant_id AND m.status = ${expectedState})
    RETURNING job.id::text AS id
  `;
  if (rows.length !== 1) throw new Error('memory_owned_cleanup_claim_refused');
  const result = await deleteTerminalMemoryProjectionsInTx(tx, job);
  if (result.vanished) throw new Error('memory_owned_cleanup_source_vanished');
  const changed = await tx.$executeRaw`
    UPDATE memory_cleanup_outbox
    SET status = 'completed', completed_at = now(), last_error = NULL,
        lease_owner = NULL, lease_expires_at = NULL
    WHERE id = ${job.id}::uuid AND tenant_id = ${job.tenant_id}::uuid
      AND memory_item_id = ${job.memory_item_id}::uuid
      AND status = 'running' AND lease_owner = ${leaseOwner}
  `;
  if (changed !== 1) throw new Error('memory_owned_cleanup_lease_lost');
  return { id: job.id, ...result, status: 'completed' as const };
}
