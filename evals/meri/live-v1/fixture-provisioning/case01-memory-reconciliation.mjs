import { randomUUID } from 'node:crypto';
import { sha256Stable, stableJson } from '../artifact-collector.mjs';
import { readCase01HydrationInputsInTx } from './case01-memory-hydration.mjs';
import { lifecycleSeedMemoryDefinitions, selectedApprovedMemoryDefinitions } from './approved-memory-runtime.mjs';
import { FixtureProvisioningError } from './contract.mjs';

const need = (value) => { if (!value) throw new FixtureProvisioningError('CASE01_METADATA_RECONCILIATION_REFUSED', '01'); };

/** Internal helper; only the existing owner's authenticated locator reconstruction calls this.
 * Every tentative write is rolled back unless unchanged canonical verification succeeds.
 * Neither a caller ID nor a desired lifecycle is accepted as repair authority. */
export async function reconcileCase01MetadataInTx(tx, ctx, { previousManifest, currentManifest, tenant, options, verify }) {
  need(options && ['preview', 'execute'].includes(options.mode));
  need(Object.keys(options).sort().join('|') === (options.mode === 'preview' ? 'mode' : 'expectedPlanSha256|mode'));
  if (options.mode === 'execute') need(/^[a-f0-9]{64}$/.test(options.expectedPlanSha256));
  await tx.$executeRawUnsafe('SAVEPOINT case01_metadata_reconciliation');
  let succeeded = false;
  try {
    const expected = [], candidateIds = [];
    for (const [manifest, retired] of [[previousManifest, true], [currentManifest, false]]) {
      const definitions = new Map([...lifecycleSeedMemoryDefinitions(manifest, ['MA1-v1', 'MA3']),
        ...selectedApprovedMemoryDefinitions(manifest, ['MB1'])].map((row) => [row.logicalId, row.candidate]));
      const pendingRecord = manifest.records.find((row) => row.logicalId === 'MA2');
      const seeded = await readCase01HydrationInputsInTx(tx, { tenantId: ctx.tenantId, definitions, pendingRecord,
        proposerId: ctx.userId, content: manifest.records.find((row) => row.logicalId === 'MA1-v2').payload.facts.text, retired });
      candidateIds.push(...[...definitions.values()].map((row) => row.physicalId), pendingRecord.physicalId, seeded.correctionCandidateId);
      for (const [id, state, candidateId] of [
        [seeded.original.physicalId, 'superseded', seeded.original.candidateId],
        [seeded.correctedItemId, retired ? 'revoked' : 'active', seeded.original.candidateId],
        [seeded.revoked.physicalId, 'revoked', seeded.revoked.candidateId],
        [seeded.bluehaven.physicalId, retired ? 'revoked' : 'active', seeded.bluehaven.candidateId],
      ]) expected.push({ id, state, candidateId });
    }
    need(new Set(expected.map((row) => row.id)).size === 8 && new Set(candidateIds).size === 10);
    const ids = expected.map((row) => row.id).sort();
    const rows = await tx.$queryRawUnsafe(`SELECT id::text,xmin::text AS version,to_jsonb(m) AS body,
      retention_policy_jsonb IS NULL AS retention_sql_null FROM memory_items m
      WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`, ctx.tenantId, ids);
    need(rows.length === 8);
    const candidates = await tx.$queryRawUnsafe(`SELECT to_jsonb(c) AS body,xmin::text AS version FROM memory_candidate c
      WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`, ctx.tenantId, candidateIds);
    need(candidates.length === 10);
    const audits = await tx.$queryRawUnsafe(`SELECT to_jsonb(a) AS body,xmin::text AS version FROM memory_transition_audit a
      WHERE tenant_id=$1::uuid AND (memory_item_id=ANY($2::uuid[]) OR memory_candidate_id=ANY($3::uuid[]))
      ORDER BY id FOR UPDATE`, ctx.tenantId, ids, candidateIds);
    const changes = [];
    for (const row of rows) {
      const target = expected.find((entry) => entry.id === row.id), body = row.body;
      need(body.status === target.state && body.legal_hold === false && body.instructions_allowed === false);
      need(body.retention_policy_jsonb === null);
      need(body.governed_status === target.state || (body.governed_status === 'active' && target.state !== 'active'));
      if (target.state !== 'active') need(audits.filter(({ body: a }) => a.memory_item_id === row.id &&
        a.from_status === 'active' && a.to_status === target.state && a.reason_code === target.state &&
        a.metadata_jsonb?.syntheticFixtureCandidateId === target.candidateId).length === 1);
      if (body.governed_status !== target.state || !row.retention_sql_null) changes.push({ id: row.id,
        beforeSha256: sha256Stable(row), beforeXmin: row.version, fromGovernedStatus: body.governed_status,
        toGovernedStatus: target.state, normalizeRetentionNull: !row.retention_sql_null });
    }
    need(changes.length > 0);
    const plan = { kind: 'case01-exact-metadata-reconciliation', version: 1, tenantId: ctx.tenantId, actorUserId: ctx.userId,
      clientId: currentManifest.clients.ASTER.physicalId, previousFixtureInstanceId: previousManifest.fixtureInstanceId,
      currentFixtureInstanceId: currentManifest.fixtureInstanceId, tenantSha256: sha256Stable(tenant),
      sourceSha256: sha256Stable({ rows, candidates, audits }), changes };
    const planSha256 = sha256Stable(plan);
    if (options.mode === 'execute') need(planSha256 === options.expectedPlanSha256);
    for (const change of changes) {
      const updated = await tx.$queryRawUnsafe(`UPDATE memory_items SET governed_status=$1,retention_policy_jsonb=NULL
        WHERE tenant_id=$2::uuid AND id=$3::uuid AND xmin::text=$4 RETURNING id::text`,
        change.toGovernedStatus, ctx.tenantId, change.id, change.beforeXmin);
      need(updated.length === 1);
    }
    const proof = await verify();
    need(proof.fixtureReady === true && proof.missing.length === 0);
    const after = await tx.$queryRawUnsafe(`SELECT id::text,xmin::text AS version,to_jsonb(m) AS body,
      retention_policy_jsonb IS NULL AS retention_sql_null FROM memory_items m
      WHERE tenant_id=$1::uuid AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`, ctx.tenantId, ids);
    need(after.length === rows.length);
    for (let i = 0; i < rows.length; i++) {
      const expectedBody = { ...rows[i].body }, change = changes.find((entry) => entry.id === rows[i].id);
      if (change) expectedBody.governed_status = change.toGovernedStatus;
      need(stableJson(after[i].body) === stableJson(expectedBody) && after[i].retention_sql_null);
      if (!change) need(after[i].version === rows[i].version);
    }
    let auditId = null;
    if (options.mode === 'execute') {
      auditId = randomUUID();
      await tx.$executeRawUnsafe(`INSERT INTO audit_logs(id,tenant_id,actor_user_id,actor_role,action,entity_type,entity_id,before_jsonb,after_jsonb)
        VALUES($1::uuid,$2::uuid,$3::uuid,$4,'synthetic_memory_metadata_reconciled','case01_memory_corpus',$5,$6::jsonb,$7::jsonb)`,
        auditId, ctx.tenantId, ctx.userId, ctx.role, currentManifest.fixtureInstanceId,
        stableJson({ planSha256, plan }), stableJson({ currentVerifySha256: proof.currentVerifySha256,
          rows: after.map((row) => ({ id: row.id, xmin: row.version, sha256: sha256Stable(row) })) }));
    }
    succeeded = true;
    return { status: options.mode === 'preview' ? 'METADATA_RECONCILIATION_PREVIEW_ROLLED_BACK' : 'METADATA_RECONCILED',
      plan, planSha256, auditId, proof, proofIsTentative: options.mode === 'preview',
      captureAuthority: false, providerAuthority: false, liveAcceptance: 'NOT_RUN' };
  } finally {
    if (!succeeded || options.mode === 'preview') await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT case01_metadata_reconciliation');
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT case01_metadata_reconciliation');
  }
}
