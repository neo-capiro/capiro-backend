import { FixtureProvisioningError } from './contract.mjs';
import { stableJson } from '../lib/stable.mjs';
import { expectedMemoryCandidatePayload } from './memory-candidate-owner.mjs';

const fail = () => {
  throw new FixtureProvisioningError('CASE01_HYDRATION_UNVERIFIED', '01');
};
const one = (rows) => {
  if (rows.length !== 1) fail();
  return rows[0];
};
const version = (value) => {
  if (typeof value !== 'string' || !/^[0-9]{1,10}$/u.test(value) || Number(value) > 0xffffffff)
    fail();
  return value;
};

/** Reconstruct only guard inputs from locked source rows. The runtime must then
 * call every canonical guard/readback before exposing a seed/reset or readiness.
 * No saved receipt, desired lifecycle, or caller-supplied version is consumed.
 */
export async function readCase01HydrationInputsInTx(
  tx,
  { tenantId, definitions, pendingRecord, proposerId, content, retired },
) {
  const result = {};
  for (const logicalId of ['MA1-v1', 'MA3', 'MB1']) {
    const definition = definitions.get(logicalId);
    const row = one(
      await tx.$queryRawUnsafe(
        `SELECT c.committed_memory_item_id::text AS item_id,c.xmin::text AS candidate_version,
        m.xmin::text AS item_version,m.status
       FROM memory_candidate c JOIN memory_items m ON m.tenant_id=c.tenant_id AND m.id=c.committed_memory_item_id
       WHERE c.tenant_id=$1::uuid AND c.id=$2::uuid ORDER BY c.id FOR UPDATE OF c,m`,
        tenantId,
        definition.physicalId,
      ),
    );
    let itemVersion = row.item_version;
    if (logicalId === 'MA1-v1' || logicalId === 'MA3' || retired) {
      const audit = one(
        await tx.$queryRawUnsafe(
          `SELECT metadata_jsonb AS metadata FROM memory_transition_audit
         WHERE tenant_id=$1::uuid AND memory_item_id=$2::uuid AND from_status='active'
           AND to_status=$3 AND reason_code=$4
           AND metadata_jsonb->>'syntheticFixtureCandidateId'=$5 ORDER BY id FOR UPDATE`,
          tenantId,
          row.item_id,
          logicalId === 'MA1-v1' ? 'superseded' : 'revoked',
          logicalId === 'MA1-v1' ? 'superseded' : 'revoked',
          definition.physicalId,
        ),
      );
      itemVersion = audit.metadata.syntheticFixtureItemRowVersion;
      if (logicalId === 'MA1-v1') result.correctionMetadata = audit.metadata;
    }
    const binding = {
      physicalId: row.item_id,
      candidateId: definition.physicalId,
      candidateRowVersion: version(row.candidate_version),
      itemRowVersion: version(itemVersion),
    };
    result[logicalId] = {
      binding,
      guard: {
        candidateId: definition.physicalId,
        expectedRowVersion: binding.candidateRowVersion,
        expectedItemRowVersion: binding.itemRowVersion,
        expectedPayload: expectedMemoryCandidatePayload(
          definition,
          proposerId,
          stableJson({ ownership: definition.ownership, payload: definition.payload }),
        ),
      },
    };
  }
  const original = result['MA1-v1'];
  const correction = one(
    await tx.$queryRawUnsafe(
      `SELECT c.id::text AS candidate_id,m.id::text AS item_id
     FROM memory_candidate c JOIN memory_items m ON m.tenant_id=c.tenant_id AND m.id=c.committed_memory_item_id
     WHERE c.tenant_id=$1::uuid AND c.source_kind='memory_correction' AND c.source_id=$2
       AND m.supersedes_id=$2::uuid ORDER BY c.id FOR UPDATE OF c,m`,
      tenantId,
      original.binding.physicalId,
    ),
  );
  const correctionGuard = {
    sourceItemId: original.binding.physicalId,
    source: original.guard,
    expectedContent: content,
    proposerUserId: proposerId,
    expectedCandidateRowVersion: version(
      result.correctionMetadata.syntheticFixtureCorrectionCandidateRowVersion,
    ),
  };
  const pendingRow = one(
    await tx.$queryRawUnsafe(
      'SELECT xmin::text AS version FROM memory_candidate WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE',
      tenantId,
      pendingRecord.physicalId,
    ),
  );
  let pendingVersion = pendingRow.version;
  if (retired) {
    const audit = one(
      await tx.$queryRawUnsafe(
        `SELECT metadata_jsonb AS metadata FROM memory_transition_audit
       WHERE tenant_id=$1::uuid AND memory_candidate_id=$2::uuid AND reason_code='withdrawn_by_proposer'
         AND to_status='rejected' ORDER BY id FOR UPDATE`,
        tenantId,
        pendingRecord.physicalId,
      ),
    );
    pendingVersion = audit.metadata.syntheticFixturePriorRowVersion;
  }
  const seeded = {
    original: original.binding,
    correctionGuard,
    correctionCandidateId: correction.candidate_id,
    correctedItemId: correction.item_id,
    bluehaven: result.MB1.binding,
    bluehavenGuard: result.MB1.guard,
    revoked: result.MA3.binding,
    revokedGuard: result.MA3.guard,
    pendingGuard: {
      expectedRowVersion: version(pendingVersion),
      expectedPayload: expectedMemoryCandidatePayload(
        pendingRecord,
        proposerId,
        stableJson({ ownership: pendingRecord.ownership, payload: pendingRecord.payload }),
      ),
    },
    proposerId,
  };
  if (retired) {
    const audit = one(
      await tx.$queryRawUnsafe(
        `SELECT metadata_jsonb AS metadata FROM memory_transition_audit
       WHERE tenant_id=$1::uuid AND memory_item_id=$2::uuid AND reason_code='revoked'
         AND from_status='active' AND to_status='revoked' AND metadata_jsonb->>'verb'='forget'
       ORDER BY id FOR UPDATE`,
        tenantId,
        correction.item_id,
      ),
    );
    seeded.correctionRetirement = {
      correction: correctionGuard,
      candidateId: correction.candidate_id,
      expectedItemRowVersion: version(audit.metadata.syntheticFixtureItemRowVersion),
    };
  }
  return seeded;
}
