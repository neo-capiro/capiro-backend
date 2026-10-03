import { randomUUID } from 'node:crypto';
import { sha256Stable, stableJson } from '../artifact-collector.mjs';
import { FixtureProvisioningError } from './contract.mjs';
import { case01MemoryMaintenanceSnapshotInTx, reconcileCase01MetadataInTx } from './case01-memory-reconciliation.mjs';

const need = (value) => { if (!value) throw new FixtureProvisioningError('CASE01_PROJECTION_CLEANUP_REFUSED', '01'); };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

/** Internal owner port only. Execute the six existing retirement jobs without
 * replaying retirement, changing canonical memory, or draining a global queue.
 * Every effect uses this transaction; preview and verification failure undo it. */
export async function cleanupCase01ProjectionsInTx(tx, ctx, input) {
  const { previousManifest, currentManifest, tenant, options, verify, completeJob } = input;
  need(options && ['preview', 'execute'].includes(options.mode));
  need(Object.keys(options).sort().join('|') === (options.mode === 'preview' ? 'mode' : 'expectedPlanSha256|mode'));
  if (options.mode === 'execute') need(/^[a-f0-9]{64}$/.test(options.expectedPlanSha256));
  need(typeof completeJob === 'function');
  await tx.$executeRawUnsafe('SAVEPOINT case01_projection_cleanup');
  let succeeded = false;
  try {
    const before = await case01MemoryMaintenanceSnapshotInTx(tx, ctx, input);
    const targets = before.expected.filter((row) => row.state !== 'active').map((target) => {
      const item = before.rows.find((row) => row.id === target.id).body;
      need(item.status === target.state && item.legal_hold === false && item.instructions_allowed === false);
      let clioId = null;
      if (target.state === 'revoked' && !target.correction) {
        const candidate = before.candidates.find((row) => row.body.id === target.candidateId)?.body;
        clioId = candidate?.committed_memory_id;
        need(uuid.test(clioId ?? '') && candidate.committed_memory_item_id === target.id && item.slug === `clio:${clioId}`);
      }
      return { id: target.id, state: target.state, clioId,
        operation: target.state === 'superseded' ? 'supersede_projections' : 'revoke_projections',
        key: target.state === 'superseded' ? `supersede_projections:${target.id}:${target.replacementId}` : `revoke:${target.id}` };
    }).sort((a, b) => a.id.localeCompare(b.id));
    need(targets.length === 6);
    const ids = targets.map((row) => row.id);
    const jobs = await tx.$queryRawUnsafe(`SELECT xmin::text AS version,to_jsonb(o) AS body,
      next_attempt_at <= now() AS due FROM memory_cleanup_outbox o
      WHERE tenant_id=$1::uuid AND memory_item_id=ANY($2::uuid[])
        AND operation IN ('revoke_projections','supersede_projections') ORDER BY id FOR UPDATE`, ctx.tenantId, ids);
    need(jobs.length === 6);
    for (const target of targets) {
      const matches = jobs.filter(({ body }) => body.memory_item_id === target.id);
      need(matches.length === 1);
      const { body, due } = matches[0];
      need(body.operation === target.operation && body.idempotency_key === target.key && body.clio_memory_id === target.clioId);
      need(['pending', 'failed'].includes(body.status) && due && body.lease_owner === null && body.lease_expires_at === null);
      need(body.expected_source_version === null && body.expected_content_hash === null && body.completed_at === null && body.dead_lettered_at === null);
    }
    // Canonical forget has already removed these Clio sources. Refuse a present
    // source BEFORE deletion: post-effect proof alone could hide tampered data.
    const clioIds = targets.map((row) => row.clioId).filter(Boolean);
    const clio = await tx.$queryRawUnsafe(`SELECT xmin::text AS version,to_jsonb(c) AS body FROM clio_memory c
      WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE`, clioIds);
    need(clio.length === 0);
    const projections = await tx.$queryRawUnsafe(`SELECT xmin::text AS version,to_jsonb(e) AS body FROM context_embeddings e
      WHERE tenant_id=$1::uuid AND source_type='memory_item' AND source_id=ANY($2::text[])
      ORDER BY source_id,model FOR UPDATE`, ctx.tenantId, ids);
    const plan = { kind: 'case01-exact-terminal-projection-cleanup', version: 1,
      tenantId: ctx.tenantId, actorUserId: ctx.userId, clientId: currentManifest.clients.ASTER.physicalId,
      previousFixtureInstanceId: previousManifest.fixtureInstanceId, currentFixtureInstanceId: currentManifest.fixtureInstanceId,
      tenantSha256: sha256Stable(tenant), canonicalBeforeSha256: sha256Stable(before),
      projectionBeforeSha256: sha256Stable(projections), clioBeforeSha256: sha256Stable(clio),
      jobs: jobs.map(({ body, version }) => ({ id: body.id, itemId: body.memory_item_id, operation: body.operation,
        idempotencyKey: body.idempotency_key, clioId: body.clio_memory_id, beforeXmin: version, beforeSha256: sha256Stable(body) })),
      projectionCount: projections.length };
    const planSha256 = sha256Stable(plan);
    if (options.mode === 'execute') need(planSha256 === options.expectedPlanSha256);
    const effects = [];
    for (const { body, version } of jobs) effects.push(await completeJob(tx, { ...body, row_version: version }));
    need(effects.length === 6 && effects.every((row) => row.status === 'completed' && !row.vanished && row.clioDeleted === 0));
    need(effects.reduce((sum, row) => sum + row.embeddingsDeleted, 0) === projections.length);
    const requiresMetadataReconciliation = before.rows.some((row) => !row.retention_sql_null ||
      row.body.governed_status !== before.expected.find((target) => target.id === row.id).state);
    const proof = requiresMetadataReconciliation
      ? (await reconcileCase01MetadataInTx(tx, ctx, { previousManifest, currentManifest, tenant, options: { mode: 'preview' }, verify })).proof
      : await verify();
    need(proof.fixtureReady === true && proof.missing.length === 0);
    // The nested metadata preview must restore every source byte and version.
    need(stableJson(await case01MemoryMaintenanceSnapshotInTx(tx, ctx, input)) === stableJson(before));
    const remaining = await tx.$queryRawUnsafe(`SELECT source_id FROM context_embeddings
      WHERE tenant_id=$1::uuid AND source_type='memory_item' AND source_id=ANY($2::text[])`, ctx.tenantId, ids);
    need(remaining.length === 0);
    let auditId = null;
    if (options.mode === 'execute') {
      auditId = randomUUID();
      await tx.$executeRawUnsafe(`INSERT INTO audit_logs(id,tenant_id,actor_user_id,actor_role,action,entity_type,entity_id,before_jsonb,after_jsonb)
        VALUES($1::uuid,$2::uuid,$3::uuid,$4,'synthetic_memory_projections_cleaned','case01_memory_corpus',$5,$6::jsonb,$7::jsonb)`,
        auditId, ctx.tenantId, ctx.userId, ctx.role, currentManifest.fixtureInstanceId,
        stableJson({ planSha256, plan }), stableJson({ effects, requiresMetadataReconciliation,
          conditionalVerifySha256: proof.currentVerifySha256 }));
    }
    succeeded = true;
    return { status: options.mode === 'preview' ? 'PROJECTION_CLEANUP_PREVIEW_ROLLED_BACK' : 'PROJECTIONS_CLEANED',
      plan, planSha256, effects, auditId, conditionalVerification: { requiresMetadataReconciliation, proof },
      proofIsTentative: options.mode === 'preview' || requiresMetadataReconciliation,
      corpusReadiness: 'REQUIRES_SEPARATE_CURRENT_READ', captureAuthority: false, providerAuthority: false, liveAcceptance: 'NOT_RUN' };
  } finally {
    if (!succeeded || options.mode === 'preview') await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT case01_projection_cleanup');
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT case01_projection_cleanup');
  }
}
