import { sha256Stable as evidenceHash } from '../artifact-collector.mjs';
import { sha256Stable, stableJson } from '../lib/stable.mjs';
import { assertManifest } from './manifest.mjs';
import {
  FIXTURE_NAMESPACE,
  FixtureProvisioningError,
  receiptWithHash,
  fixtureReceiptId,
} from './contract.mjs';
import {
  createApprovedMemoryFixtureRuntime,
  lifecycleSeedMemoryDefinitions,
  selectedApprovedMemoryDefinitions,
} from './approved-memory-runtime.mjs';
import {
  createMemoryCandidateOwnerPort,
  expectedMemoryCandidatePayload,
} from './memory-candidate-owner.mjs';

const fail = (code) => {
  throw new FixtureProvisioningError(code, code);
};
const clone = (value) => structuredClone(value);

/** Trusted server composition for the exact original case01 corpus. No route or
 * public receipt submission exists. Canonical services own every lifecycle write.
 * A fresh instance needs an independently re-read predecessor retirement before
 * it can qualify a capture binding; initial seed alone is deliberately NOT_READY.
 */
export function createCase01MemoryFixtureRuntime({
  manifest: inputManifest,
  prisma,
  memoryCandidates,
  memoryStore,
  memoryVersions,
  tenantContext,
  proposerForTenant,
  reviewerForTenant,
  clientMemoryAllowed,
  previousOwner,
  assertSyntheticCandidateWithdrawalInTx,
  assertSyntheticApprovedMemoryInTx,
  readSyntheticMemoryRetirementInTx,
  readSyntheticCorrectionInTx,
  readSyntheticCorrectionRetirementInTx,
  memoryAuthorization,
}) {
  const manifest = clone(inputManifest);
  assertManifest(manifest);
  if (
    !manifest.fixtureInstanceId ||
    [
      memoryCandidates?.withdrawSyntheticFixture,
      memoryVersions?.proposeSyntheticCorrection,
      memoryVersions?.approveSyntheticCorrection,
      memoryStore?.forgetSyntheticCorrection,
      assertSyntheticCandidateWithdrawalInTx,
      assertSyntheticApprovedMemoryInTx,
      readSyntheticMemoryRetirementInTx,
      readSyntheticCorrectionInTx,
      readSyntheticCorrectionRetirementInTx,
      memoryAuthorization?.loadItemInTx,
      memoryAuthorization?.evaluateInTx,
    ].some((value) => typeof value !== 'function')
  )
    fail('CASE01_CANONICAL_OWNER_INCOMPLETE');
  const tenant = manifest.tenants.T1,
    client = manifest.clients.ASTER;
  const records = new Map(manifest.records.map((row) => [row.logicalId, row]));
  const defs = new Map(
    [
      ...lifecycleSeedMemoryDefinitions(manifest, ['MA1-v1', 'MA3']),
      ...selectedApprovedMemoryDefinitions(manifest, ['MB1']),
    ].map((row) => [row.logicalId, row.candidate]),
  );
  const pendingRecord = records.get('MA2');
  const content = records.get('MA1-v2').payload.facts.text;
  if (
    pendingRecord?.owner !== 'memory_candidate' ||
    pendingRecord.payload.facts.lifecycle !== 'pending'
  )
    fail('CASE01_CORPUS_INVALID');
  const deps = {
    manifest,
    prisma,
    memoryCandidates,
    memoryStore,
    tenantContext,
    proposerForTenant,
    reviewerForTenant,
    clientMemoryAllowed,
  };
  const initial = createApprovedMemoryFixtureRuntime({
    ...deps,
    lifecycleSeedSourceIds: ['MA1-v1', 'MA3'],
  });
  const bluehaven = createApprovedMemoryFixtureRuntime({ ...deps, sourceIds: ['MB1'] });
  const pending = createMemoryCandidateOwnerPort({
    prisma,
    memoryCandidates,
    actorForTenant: proposerForTenant,
    clientMemoryAllowed,
  });
  const configuration = {
    fixtureNamespace: manifest.fixtureNamespace,
    fixtureVersion: manifest.fixtureVersion,
    fixtureSha256: manifest.fixtureSha256,
    contractSourceSha256: manifest.contractSourceSha256,
    tenants: manifest.tenants,
    clients: manifest.clients,
    actors: manifest.actors,
  };
  const configurationSha256 = sha256Stable(configuration);
  let operationStarted = false,
    seeded = null,
    retirementStarted = false,
    retired = false;

  async function context(review = false) {
    const userId = await (review ? reviewerForTenant : proposerForTenant)(tenant.id);
    return prisma.withTenantUser(tenant.id, userId, async (tx) => {
      const rows = await tx.$queryRawUnsafe(
        `SELECT tm.role FROM tenant_memberships tm JOIN tenants t ON t.id=tm.tenant_id
        WHERE tm.tenant_id=$1::uuid AND tm.user_id=$2::uuid AND tm.status='active' AND t.slug=$3 FOR SHARE OF tm,t`,
        tenant.id,
        userId,
        tenant.slug,
      );
      if (
        rows.length !== 1 ||
        !['standard_user', 'user_admin', 'capiro_admin'].includes(rows[0].role)
      )
        fail('CASE01_CURRENT_ACTOR_REQUIRED');
      return { tenantId: tenant.id, tenantSlug: tenant.slug, userId, role: rows[0].role };
    });
  }
  async function rootGuard(logicalId, binding) {
    const definition = defs.get(logicalId),
      proposer = await proposerForTenant(tenant.id);
    return {
      candidateId: definition.physicalId,
      expectedRowVersion: binding.candidateRowVersion,
      expectedItemRowVersion: binding.itemRowVersion,
      expectedPayload: expectedMemoryCandidatePayload(
        definition,
        proposer,
        stableJson({ ownership: definition.ownership, payload: definition.payload }),
      ),
    };
  }
  function sourceMap(proof) {
    return {
      'MA1-v2': {
        frozenFixtureId: 'MA1-v2',
        physicalId: proof.itemId,
        tenantPhysicalId: tenant.id,
        clientPhysicalId: client.physicalId,
        kind: 'memory',
        version: proof.sourceVersion,
      },
    };
  }
  async function currentInTx(tx, ctx) {
    if (!seeded || retired || ctx.tenantId !== tenant.id) fail('CASE01_SEED_NOT_CURRENT');
    const correction = await readSyntheticCorrectionInTx(
      tx,
      ctx,
      seeded.correctionGuard,
      seeded.correctionCandidateId,
    );
    if (correction.itemId !== seeded.correctedItemId) fail('CASE01_CORRECTION_ID_MISMATCH');
    const approved = await assertSyntheticApprovedMemoryInTx(
      tx,
      ctx,
      seeded.bluehaven.physicalId,
      seeded.bluehavenGuard,
    );
    const revoked = await readSyntheticMemoryRetirementInTx(
      tx,
      ctx,
      seeded.revoked.physicalId,
      seeded.revokedGuard,
    );
    const proposed = await assertSyntheticCandidateWithdrawalInTx(
      tx,
      tenant.id,
      seeded.proposerId,
      pendingRecord.physicalId,
      seeded.pendingGuard,
    );
    const subject = await memoryAuthorization.loadItemInTx(tx, tenant.id, correction.itemId);
    if (
      !subject ||
      !(
        await memoryAuthorization.evaluateInTx(tx, ctx, subject, 'read', {
          emitDenialMetrics: false,
        })
      ).allowed
    )
      fail('CASE01_CURRENT_READ_DENIED');
    const extra = await tx.$queryRawUnsafe(
      `SELECT id::text,client_id::text,status,governed_status,xmin::text AS row_version
      FROM memory_items WHERE tenant_id=$1::uuid AND id IN ($2::uuid,$3::uuid) ORDER BY id FOR UPDATE`,
      tenant.id,
      seeded.bluehaven.physicalId,
      seeded.revoked.physicalId,
    );
    const blue = extra.find((row) => row.id === seeded.bluehaven.physicalId),
      dead = extra.find((row) => row.id === seeded.revoked.physicalId);
    if (
      extra.length !== 2 ||
      blue?.client_id !== manifest.clients.BLUEHAVEN.physicalId ||
      blue.client_id === client.physicalId ||
      dead?.client_id !== client.physicalId ||
      dead.status !== 'revoked' ||
      blue.status !== 'active'
    )
      fail('CASE01_NEGATIVE_CORPUS_MISMATCH');
    for (const row of extra) {
      const negativeSubject = await memoryAuthorization.loadItemInTx(tx, tenant.id, row.id);
      if (
        !negativeSubject ||
        !(
          await memoryAuthorization.evaluateInTx(tx, ctx, negativeSubject, 'read', {
            emitDenialMetrics: false,
          })
        ).allowed
      )
        fail('CASE01_NEGATIVE_CORPUS_READ_DENIED');
    }
    return { correction, approved, revoked, proposed, negativeVersions: extra };
  }

  async function seed() {
    if (seeded?.receipt) return clone(seeded.receipt);
    if (operationStarted) fail('CASE01_PARTIAL_SEED_REQUIRES_RECONCILIATION');
    operationStarted = true;
    try {
      const proposer = await context(),
        reviewer = await context(true);
      if (proposer.userId === reviewer.userId) fail('CASE01_INDEPENDENT_REVIEWER_REQUIRED');
      const original = await initial.create('MA1-v1');
      const correctionGuard = {
        sourceItemId: original.physicalId,
        source: await rootGuard('MA1-v1', original),
        expectedContent: content,
        proposerUserId: proposer.userId,
      };
      const proposed = await memoryVersions.proposeSyntheticCorrection(
        proposer,
        original.physicalId,
        content,
        correctionGuard,
      );
      if (proposed.status !== 'pending_review') fail('CASE01_CORRECTION_PROPOSAL_REQUIRED');
      const candidate = await prisma.withTenantUser(tenant.id, proposer.userId, (tx) =>
        tx.$queryRawUnsafe(
          'SELECT xmin::text AS version FROM memory_candidate WHERE tenant_id=$1::uuid AND id=$2::uuid',
          tenant.id,
          proposed.candidateId,
        ),
      );
      if (candidate.length !== 1) fail('CASE01_CORRECTION_PROPOSAL_UNKNOWN');
      correctionGuard.expectedCandidateRowVersion = candidate[0].version;
      const corrected = await memoryVersions.approveSyntheticCorrection(
        reviewer,
        proposed.candidateId,
        correctionGuard,
      );
      if (corrected.outcome !== 'activated') fail('CASE01_CORRECTION_ACTIVATION_REQUIRED');
      const other = await bluehaven.create('MB1');
      const revoked = await initial.create('MA3');
      await initial.retire('MA3', revoked);
      await pending.create(pendingRecord, {
        tenantId: tenant.id,
        physicalId: pendingRecord.physicalId,
        expectedOwnershipMarkerSha256: pendingRecord.ownership.markerSha256,
        expectedRowVersion: null,
      });
      const pendingProof = await pending.read(pendingRecord);
      if (!pendingProof || pendingProof.payloadSha256 !== pendingRecord.payloadSha256)
        fail('CASE01_PENDING_READBACK_REQUIRED');
      const pendingGuard = {
        expectedRowVersion: pendingProof.rowVersion,
        expectedPayload: expectedMemoryCandidatePayload(
          pendingRecord,
          proposer.userId,
          stableJson({ ownership: pendingRecord.ownership, payload: pendingRecord.payload }),
        ),
      };
      seeded = {
        original,
        correctionGuard,
        correctionCandidateId: proposed.candidateId,
        correctedItemId: corrected.memoryItemId,
        bluehaven: other,
        bluehavenGuard: await rootGuard('MB1', other),
        revoked,
        revokedGuard: await rootGuard('MA3', revoked),
        pendingGuard,
        proposerId: proposer.userId,
      };
      const current = await prisma.withTenantUser(tenant.id, proposer.userId, (tx) =>
        currentInTx(tx, proposer),
      );
      seeded.receipt = receiptWithHash({
        kind: 'meri-synthetic-fixture-seed-receipt',
        scope: 'case01-canonical-memory',
        status: 'complete',
        fixtureInstanceId: manifest.fixtureInstanceId,
        manifestContentSha256: manifest.contentSha256,
        configurationSha256,
        tenantId: tenant.id,
        records: [
          {
            logicalId: 'MA1-v1',
            physicalId: original.physicalId,
            lifecycle: 'superseded',
            evidence: current.correction,
          },
          {
            logicalId: 'MA1-v2',
            physicalId: corrected.memoryItemId,
            lifecycle: 'approved',
            evidence: current.correction,
          },
          {
            logicalId: 'MA2',
            physicalId: pendingRecord.physicalId,
            lifecycle: 'pending',
            evidence: current.proposed,
          },
          {
            logicalId: 'MA3',
            physicalId: revoked.physicalId,
            lifecycle: 'revoked',
            evidence: current.revoked,
          },
          {
            logicalId: 'MB1',
            physicalId: other.physicalId,
            lifecycle: 'approved',
            evidence: current.approved,
          },
        ],
        liveAcceptance: 'NOT_RUN',
      });
      return clone(seeded.receipt);
    } catch (error) {
      error.unknownCommit = true;
      throw error;
    }
  }

  async function retirementInTx(tx, ctx) {
    if (!seeded || !retired || ctx.tenantId !== tenant.id) fail('CASE01_RESET_NOT_COMPLETE');
    const correction = await readSyntheticCorrectionRetirementInTx(
      tx,
      ctx,
      seeded.correctedItemId,
      seeded.correctionRetirement,
    );
    const blue = await readSyntheticMemoryRetirementInTx(
      tx,
      ctx,
      seeded.bluehaven.physicalId,
      seeded.bluehavenGuard,
    );
    const dead = await readSyntheticMemoryRetirementInTx(
      tx,
      ctx,
      seeded.revoked.physicalId,
      seeded.revokedGuard,
    );
    const pendingProof = await pending.readRetirementInTx(tx, pendingRecord);
    if (pendingProof.priorRowVersion !== seeded.pendingGuard.expectedRowVersion)
      fail('CASE01_PENDING_RESET_NOT_VERIFIED');
    return receiptWithHash({
      kind: 'meri-synthetic-fixture-reset-receipt',
      scope: 'case01-canonical-retirement',
      status: 'complete',
      fixtureInstanceId: manifest.fixtureInstanceId,
      configurationSha256,
      manifestContentSha256: manifest.contentSha256,
      seedReceiptContentSha256: seeded.receipt.contentSha256,
      tenantId: tenant.id,
      records: [
        { logicalId: 'MA1-v1', lifecycle: 'superseded', physicalId: seeded.original.physicalId },
        { logicalId: 'MA1-v2', lifecycle: 'revoked', evidence: correction },
        { logicalId: 'MA2', lifecycle: 'withdrawn', evidence: pendingProof },
        { logicalId: 'MA3', lifecycle: 'revoked', evidence: dead },
        { logicalId: 'MB1', lifecycle: 'revoked', evidence: blue },
      ],
      retained: true,
      liveAcceptance: 'NOT_RUN',
    });
  }

  async function retire() {
    if (!seeded?.receipt || retirementStarted) fail('CASE01_RESET_REQUIRES_RECONCILIATION');
    retirementStarted = true;
    const reviewer = await context(true);
    const current = await prisma.withTenantUser(tenant.id, reviewer.userId, (tx) =>
      currentInTx(tx, reviewer),
    );
    seeded.correctionRetirement = {
      correction: seeded.correctionGuard,
      candidateId: seeded.correctionCandidateId,
      expectedItemRowVersion: current.correction.itemRowVersion,
    };
    const result = await tenantContext.run(reviewer, () =>
      memoryStore.forgetSyntheticCorrection(seeded.correctedItemId, seeded.correctionRetirement),
    );
    if (result.found !== true || result.blockedByLegalHold) fail('CASE01_RESET_CORRECTION_REFUSED');
    await bluehaven.retire('MB1', seeded.bluehaven);
    await pending.retire(pendingRecord, {
      tenantId: tenant.id,
      physicalId: pendingRecord.physicalId,
      expectedOwnershipMarkerSha256: pendingRecord.ownership.markerSha256,
      expectedRowVersion: seeded.pendingGuard.expectedRowVersion,
      action: 'withdraw_pending',
    });
    retired = true;
    return prisma.withTenantUser(tenant.id, reviewer.userId, (tx) => retirementInTx(tx, reviewer));
  }

  return Object.freeze({
    seed,
    retire,
    readResetInTx: retirementInTx,
    async qualifyInTx(tx, ctx, { caseId, clientId }) {
      if (caseId !== '01' || clientId !== client.physicalId || ctx.tenantId !== tenant.id)
        fail('CASE01_CAPTURE_SCOPE_MISMATCH');
      const current = await currentInTx(tx, ctx),
        sources = sourceMap(current.correction);
      const missing = [];
      let reset = null;
      if (!previousOwner) missing.push('CANONICAL_RESET_RECEIPT_OWNER_MISSING');
      else {
        if (typeof previousOwner.readResetInTx !== 'function') fail('CASE01_RESET_OWNER_INVALID');
        reset = await previousOwner.readResetInTx(tx, ctx);
        if (
          reset.configurationSha256 !== configurationSha256 ||
          reset.fixtureInstanceId === manifest.fixtureInstanceId ||
          reset.status !== 'complete' ||
          reset.scope !== 'case01-canonical-retirement' ||
          reset.tenantId !== tenant.id
        )
          fail('CASE01_RESET_SCOPE_MISMATCH');
      }
      const verify = {
        kind: 'meri-case01-canonical-current-verification',
        fixtureInstanceId: manifest.fixtureInstanceId,
        manifestContentSha256: manifest.contentSha256,
        tenantId: tenant.id,
        actorUserId: ctx.userId,
        clientId,
        caseId,
        current,
        resetReceiptSha256: reset?.contentSha256 ?? null,
        seedReceiptSha256: seeded.receipt.contentSha256,
      };
      return {
        fixtureReady: missing.length === 0,
        missing,
        liveAcceptance: 'NOT_RUN',
        fixtureNamespace: FIXTURE_NAMESPACE,
        fixtureVersion: manifest.fixtureVersion,
        tenantId: tenant.id,
        actorUserId: ctx.userId,
        clientId,
        caseId,
        sourceMap: sources,
        physicalMapSha256: evidenceHash(sources),
        currentVerify: verify,
        currentVerifySha256: evidenceHash(verify),
        seedReceiptId: fixtureReceiptId(seeded.receipt, 'meri-synthetic-fixture-seed-receipt'),
        resetReceiptId: reset
          ? fixtureReceiptId(reset, 'meri-synthetic-fixture-reset-receipt')
          : null,
      };
    },
  });
}
