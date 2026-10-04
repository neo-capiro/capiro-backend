import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { MemoryAuthorizationService } from './memory-authorization.service.js';
import { assertSyntheticApprovedMemoryInTx } from './synthetic-approved-memory.helpers.js';
import { canonicalProjectionSnapshot } from './strict-memory-projector.service.js';
import { exactProjectionIdempotencyKey } from './exact-memory-cleanup-outbox.service.js';
import { researchJsonSha256 } from '../meri/meri-research-durable-result.js';

const TENANT = 'f2d6cf8f-057c-479a-8110-62fe5086d43f';
const UUID4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const UUID5 = /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
function need(value: unknown): asserts value {
  if (!value) throw new Error('meri_case12_setup_terminal_not_verified');
}
const iso = (value: Date | string): string => new Date(value).toISOString();
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const instant = (value: unknown): value is string =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

export interface Case12SetupTerminalRowInput {
  fixtureInstanceId: string;
  logicalId: string;
  candidateId: string;
  itemId: string;
  clientId: string;
  proposerUserId: string;
  reviewerUserId: string;
  expectedCandidateRowVersion: string;
  expectedItemRowVersion: string;
  expectedPayload: Record<string, unknown>;
  admittedAt: string;
  deadlineAt: string;
}

/** Private native transaction reader: no providers, writes, retries, or serialized authority. */
export async function inspectCase12SetupTerminalRowInTx(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  supplied: Case12SetupTerminalRowInput,
  authorization: MemoryAuthorizationService,
) {
  need(record(supplied) && record(ctx));
  const input = structuredClone(supplied);
  need(
    ctx.tenantId === TENANT && ctx.role === 'standard_user' && ctx.userId === input.proposerUserId,
  );
  need(
    [
      input.fixtureInstanceId,
      input.itemId,
      input.clientId,
      input.proposerUserId,
      input.reviewerUserId,
    ].every((id) => typeof id === 'string' && UUID4.test(id)),
  );
  need(
    typeof input.candidateId === 'string' &&
      UUID5.test(input.candidateId) &&
      input.proposerUserId !== input.reviewerUserId,
  );
  need(
    typeof input.logicalId === 'string' &&
      (input.logicalId === 'MA510' || /^MA510-DISTRACTOR-0[0-5][0-9]{2}$/u.test(input.logicalId)),
  );
  if (input.logicalId !== 'MA510')
    need(Number(input.logicalId.slice(-4)) >= 1 && Number(input.logicalId.slice(-4)) <= 509);
  need(
    instant(input.admittedAt) &&
      instant(input.deadlineAt) &&
      Date.parse(input.deadlineAt) > Date.parse(input.admittedAt),
  );
  need(
    [input.expectedCandidateRowVersion, input.expectedItemRowVersion].every(
      (version) => typeof version === 'string' && /^[0-9]+$/u.test(version),
    ) && record(input.expectedPayload),
  );
  need(
    input.expectedPayload.key ===
      `meri-foundation-20260928:${input.fixtureInstanceId}:APPROVED-${input.logicalId}` &&
      input.expectedPayload.clientId === input.clientId &&
      input.expectedPayload.scope === 'client',
  );
  await assertSyntheticApprovedMemoryInTx(tx, ctx, input.itemId, {
    candidateId: input.candidateId,
    expectedRowVersion: input.expectedCandidateRowVersion,
    expectedItemRowVersion: input.expectedItemRowVersion,
    expectedPayload: input.expectedPayload,
  });
  const subject = await authorization.loadItemInTx(tx, TENANT, input.itemId);
  need(subject);
  const decision = await authorization.evaluateInTx(tx, ctx, subject, 'read', {
    emitDenialMetrics: false,
  });
  need(decision.allowed === true);
  const candidates = await tx.$queryRaw<
    Array<{ clioId: string; proposer: string; reviewer: string; approvedAt: Date }>
  >`
    SELECT committed_memory_id::text AS "clioId", proposed_by::text AS proposer,
      approved_by_user_id::text AS reviewer, approved_at AS "approvedAt"
    FROM memory_candidate WHERE tenant_id=${TENANT}::uuid AND id=${input.candidateId}::uuid
      AND committed_memory_item_id=${input.itemId}::uuid FOR UPDATE`;
  need(candidates.length === 1);
  const candidate = candidates[0]!;
  need(
    UUID4.test(candidate.clioId) &&
      candidate.proposer === input.proposerUserId &&
      candidate.reviewer === input.reviewerUserId,
  );
  const clios = await tx.$queryRaw<
    Array<{
      id: string;
      clientId: string | null;
      ownerUserId: string | null;
      scope: string;
      key: string;
      value: string;
      source: string;
      createdAt: Date;
      updatedAt: Date;
      dimensions: number | null;
    }>
  >`
    SELECT id::text,client_id::text AS "clientId",owner_user_id::text AS "ownerUserId",scope,key,value,source,
      created_at AS "createdAt",updated_at AS "updatedAt",vector_dims(embedding) AS dimensions
    FROM clio_memory WHERE tenant_id=${TENANT}::uuid AND id=${candidate.clioId}::uuid FOR UPDATE`;
  const items = await tx.$queryRaw<
    Array<{
      id: string;
      clientId: string | null;
      ownerUserId: string | null;
      slug: string;
      title: string;
      sections: unknown;
      sourceVersion: string;
      sourceContentHash: string;
      rowVersion: string;
    }>
  >`
    SELECT id::text,client_id::text AS "clientId",owner_user_id::text AS "ownerUserId",slug,title,sections_jsonb AS sections,
      source_version AS "sourceVersion",source_content_hash AS "sourceContentHash",xmin::text AS "rowVersion"
    FROM memory_items WHERE tenant_id=${TENANT}::uuid AND id=${input.itemId}::uuid FOR UPDATE`;
  const vectors = await tx.$queryRaw<
    Array<{
      clientId: string | null;
      ownerUserId: string | null;
      model: string;
      contentHash: string;
      contentText: string;
      dimensions: number | null;
      createdAt: Date;
      updatedAt: Date;
    }>
  >`
    SELECT client_id::text AS "clientId",owner_user_id::text AS "ownerUserId",model,content_hash AS "contentHash",
      content_text AS "contentText",vector_dims(embedding) AS dimensions,created_at AS "createdAt",updated_at AS "updatedAt"
    FROM context_embeddings WHERE tenant_id=${TENANT}::uuid AND source_type='memory_item' AND source_id=${input.itemId}
    LIMIT 3 FOR SHARE`;
  const jobs = await tx.$queryRaw<
    Array<{
      id: string;
      memoryItemId: string | null;
      clioMemoryId: string | null;
      operation: string;
      idempotencyKey: string;
      status: string;
      attempts: number;
      createdAt: Date;
      completedAt: Date | null;
      lastError: string | null;
      expectedSourceVersion: Date | null;
      expectedContentHash: string | null;
      leaseOwner: string | null;
      leaseExpiresAt: Date | null;
    }>
  >`
    SELECT id::text,memory_item_id::text AS "memoryItemId",clio_memory_id::text AS "clioMemoryId",operation,
      idempotency_key AS "idempotencyKey",status,attempts,created_at AS "createdAt",completed_at AS "completedAt",last_error AS "lastError",
      expected_source_version AS "expectedSourceVersion",expected_content_hash AS "expectedContentHash",lease_owner::text AS "leaseOwner",
      lease_expires_at AS "leaseExpiresAt"
    FROM memory_cleanup_outbox WHERE tenant_id=${TENANT}::uuid AND (memory_item_id=${input.itemId}::uuid OR clio_memory_id=${candidate.clioId}::uuid)
    LIMIT 3 FOR SHARE`;
  // Observe real DB time after all locks. No frozen semantic clock is substituted.
  const clocks = await tx.$queryRaw<Array<{ observedAt: Date; transactionId: string }>>`
    SELECT clock_timestamp() AS "observedAt",txid_current()::text AS "transactionId"`;
  need(
    clios.length === 1 &&
      items.length === 1 &&
      vectors.length === 1 &&
      jobs.length === 1 &&
      clocks.length === 1,
  );
  const clio = clios[0]!,
    item = items[0]!,
    vector = vectors[0]!,
    job = jobs[0]!,
    clock = clocks[0]!;
  const observedAt = iso(clock.observedAt),
    start = Date.parse(input.admittedAt),
    deadline = Date.parse(input.deadlineAt),
    now = Date.parse(observedAt);
  need(now >= start);
  const inWindow = (value: Date | string) => {
    const n = Date.parse(iso(value));
    return n >= start && n <= now;
  };
  need(inWindow(candidate.approvedAt) && Date.parse(iso(candidate.approvedAt)) <= deadline);
  need(
    clio.id === candidate.clioId &&
      clio.clientId === input.clientId &&
      clio.ownerUserId === null &&
      clio.scope === 'client' &&
      clio.key === input.expectedPayload.key &&
      clio.value === input.expectedPayload.value &&
      clio.source === 'meri_synthetic_fixture' &&
      clio.dimensions === 1536 &&
      inWindow(clio.createdAt) &&
      inWindow(clio.updatedAt) &&
      iso(clio.updatedAt) >= iso(clio.createdAt),
  );
  need(
    item.id === input.itemId &&
      item.clientId === input.clientId &&
      item.ownerUserId === null &&
      item.slug === `clio:${clio.id}` &&
      item.title === input.expectedPayload.key &&
      item.rowVersion === input.expectedItemRowVersion &&
      item.sourceVersion === `candidate:${input.candidateId}`,
  );
  const projection = canonicalProjectionSnapshot(item);
  need(
    projection.embeddingRequired &&
      vector.clientId === input.clientId &&
      vector.ownerUserId === null &&
      vector.model === 'amazon.titan-embed-text-v2:0' &&
      vector.dimensions === 1024 &&
      vector.contentHash === projection.contentHash &&
      vector.contentText === projection.text &&
      inWindow(vector.createdAt) &&
      inWindow(vector.updatedAt) &&
      iso(vector.updatedAt) >= iso(vector.createdAt),
  );
  need(
    UUID4.test(job.id) &&
      job.memoryItemId === item.id &&
      job.clioMemoryId === clio.id &&
      job.operation === 'index_memory_item' &&
      job.status === 'completed' &&
      job.attempts === 0 &&
      job.lastError === null &&
      job.leaseOwner === null &&
      job.leaseExpiresAt === null &&
      job.expectedSourceVersion &&
      iso(job.expectedSourceVersion) === iso(clio.updatedAt) &&
      job.expectedContentHash === projection.contentHash &&
      job.idempotencyKey ===
        exactProjectionIdempotencyKey(clio.id, iso(clio.updatedAt), projection.contentHash) &&
      inWindow(job.createdAt) &&
      job.completedAt &&
      inWindow(job.completedAt) &&
      iso(job.completedAt) >= iso(job.createdAt),
  );
  const proof = {
    kind: 'meri-case12-setup-terminal-row',
    version: 1,
    fixtureInstanceId: input.fixtureInstanceId,
    logicalId: input.logicalId,
    candidateId: input.candidateId,
    itemId: item.id,
    clioMemoryId: clio.id,
    tenantId: TENANT,
    clientId: input.clientId,
    proposerUserId: input.proposerUserId,
    reviewerUserId: input.reviewerUserId,
    candidateRowVersion: input.expectedCandidateRowVersion,
    itemRowVersion: item.rowVersion,
    sourceVersion: item.sourceVersion,
    sourceContentHash: item.sourceContentHash,
    projectionContentHash: projection.contentHash,
    legacyDimensions: 1536,
    institutionalDimensions: 1024,
    institutionalModel: vector.model,
    outboxId: job.id,
    outboxIdempotencyKey: job.idempotencyKey,
    outboxCompletedAt: iso(job.completedAt!),
    observedAt,
    databaseTransactionId: clock.transactionId,
    providerCalls: 0,
    databaseWrites: 0,
    captureAuthority: false,
    liveAcceptance: 'NOT_RUN',
  };
  return { ...proof, proofSha256: researchJsonSha256(proof) };
}
