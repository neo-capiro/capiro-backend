import { resolvePendingMemorySetupRecipe } from './memory-pending-execution.mjs';
import { expectedMemoryCandidatePayload } from './memory-candidate-owner.mjs';
import {
  AUTHORIZED_TENANTS,
  FIXTURE_NAMESPACE,
  receiptWithHash,
  fixtureReceiptId,
  assertReceiptHash,
} from './contract.mjs';
import { randomUUID } from 'node:crypto';
import { sha256Stable, stableJson } from '../lib/stable.mjs';

const fail = () => {
  throw new Error('CASE14_CURRENT_CANONICAL_OWNER_REQUIRED');
};
const hash = /^[a-f0-9]{64}$/u;

/** This fixed owner is composed only by the API's source-owned loader. Ports are
 * actual application guard/authorization functions; no HTTP caller supplies them.
 * The stored locator identifies the case-specific seed, never authorizes a read.
 */
export async function readCase14MemoryOwnerInTx(tx, ctx, ports, { candidateId } = {}) {
  if (
    process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE !== FIXTURE_NAMESPACE ||
    ctx.tenantId !== AUTHORIZED_TENANTS.T1.id ||
    ctx.tenantSlug !== AUTHORIZED_TENANTS.T1.slug ||
    ctx.role !== 'user_admin'
  )
    return null;
  const tenants = await tx.$queryRawUnsafe(
    'SELECT settings_jsonb AS settings FROM tenants WHERE id=$1::uuid AND slug=$2',
    ctx.tenantId,
    ctx.tenantSlug,
  );
  const operation = tenants[0]?.settings?.meriFoundationFixture?.pendingMemorySetups?.['14'];
  if (tenants.length !== 1 || operation?.status !== 'SETUP_COMPLETE' || !operation.locator)
    return null;
  const spec = await resolvePendingMemorySetupRecipe(operation.locator);
  if (spec.input.caseId !== '14' || spec.selection.reviewerUserId !== ctx.userId) return null;
  const record = spec.selection.records[0];
  if (candidateId !== undefined && candidateId !== record.physicalId) return null;
  if (
    spec.selection.records.length !== 1 ||
    record.logicalId !== 'MEM-PROPOSAL-14' ||
    operation.recipeSha256 !== sha256Stable(spec.input) ||
    operation.fixtureInstanceId !== spec.input.fixtureInstanceId ||
    !hash.test(operation.planSha256 ?? '') ||
    !hash.test(operation.receiptSha256 ?? '')
  )
    fail();
  const members = await tx.$queryRawUnsafe(
    `SELECT tm.role,u.clerk_user_id AS "clerkUserId" FROM tenant_memberships tm JOIN users u ON u.id=tm.user_id
     WHERE tm.tenant_id=$1::uuid AND tm.user_id=$2::uuid AND tm.status='active'`,
    ctx.tenantId,
    ctx.userId,
  );
  if (
    members.length !== 1 ||
    members[0].role !== ctx.role ||
    members[0].clerkUserId !== ctx.clerkUserId
  )
    fail();
  const candidates = await tx.$queryRawUnsafe(
    `SELECT id::text,proposed_by::text,client_id::text,status,governed_status,revision_number,
       approved_by_user_id::text,committed_memory_id::text,committed_memory_item_id::text,xmin::text AS row_version
     FROM memory_candidate WHERE tenant_id=$1::uuid AND id=$2::uuid`,
    ctx.tenantId,
    record.physicalId,
  );
  const candidate = candidates[0];
  if (
    candidates.length !== 1 ||
    candidate.proposed_by !== spec.selection.proposerUserId ||
    candidate.client_id !== record.clientPhysicalId ||
    candidate.revision_number !== 1 ||
    !/^[0-9]{1,10}$/u.test(candidate.row_version)
  )
    fail();
  const expectedPayload = expectedMemoryCandidatePayload(
    record,
    spec.selection.proposerUserId,
    stableJson({ ownership: record.ownership, payload: record.payload }),
  );
  const base = {
    kind: 'meri-case14-current-memory-owner',
    schemaVersion: 1,
    caseId: '14',
    fixtureNamespace: FIXTURE_NAMESPACE,
    fixtureVersion: spec.manifest.fixtureVersion,
    fixtureInstanceId: spec.input.fixtureInstanceId,
    manifestContentSha256: spec.manifest.contentSha256,
    recipeSha256: operation.recipeSha256,
    seedPlanSha256: operation.planSha256,
    setupReceiptSha256: operation.receiptSha256,
    tenantId: ctx.tenantId,
    clientId: record.clientPhysicalId,
    proposerUserId: spec.selection.proposerUserId,
    reviewerUserId: ctx.userId,
    reviewerRole: ctx.role,
    logicalSourceId: record.logicalId,
    candidateId: record.physicalId,
    candidateRowVersion: candidate.row_version,
    revision: 1,
    ownershipMarkerSha256: record.ownership.markerSha256,
    payloadSha256: record.payloadSha256,
    text: record.payload.facts.proposedText,
  };
  if (candidate.status === 'pending') {
    await ports.assertSyntheticCandidateWithdrawalInTx(
      tx,
      ctx.tenantId,
      spec.selection.proposerUserId,
      record.physicalId,
      { expectedRowVersion: candidate.row_version, expectedPayload },
    );
    const current = await ports.readCase14ReviewerPreflightInTx(tx, {
      authorization: ports.authorization,
      ctx,
      candidateId: record.physicalId,
      proposerUserId: spec.selection.proposerUserId,
      clientId: record.clientPhysicalId,
    });
    if (current.rowVersion !== candidate.row_version) fail();
    const proof = {
      ...base,
      state: 'pending',
      approvalBasis: current.basis,
      item: null,
      decision: null,
    };
    return { ...proof, currentVerifySha256: sha256Stable(proof) };
  }
  if (
    candidate.status !== 'approved' ||
    candidate.governed_status !== 'active' ||
    candidate.approved_by_user_id !== ctx.userId ||
    !candidate.committed_memory_item_id ||
    !candidate.committed_memory_id
  )
    fail();
  const items = await tx.$queryRawUnsafe(
    `SELECT id::text,xmin::text AS row_version,source_version,source_content_hash,status,governed_status
     FROM memory_items WHERE tenant_id=$1::uuid AND id=$2::uuid`,
    ctx.tenantId,
    candidate.committed_memory_item_id,
  );
  const item = items[0];
  if (items.length !== 1 || !item) fail();
  await ports.assertSyntheticApprovedMemoryInTx(tx, ctx, item.id, {
    candidateId: record.physicalId,
    expectedRowVersion: candidate.row_version,
    expectedItemRowVersion: item.row_version,
    expectedPayload,
  });
  const subject = await ports.authorization.loadItemInTx(tx, ctx.tenantId, item.id);
  if (
    !subject ||
    !(
      await ports.authorization.evaluateInTx(tx, ctx, subject, 'read', { emitDenialMetrics: false })
    ).allowed
  )
    fail();
  const audits = await tx.$queryRawUnsafe(
    `SELECT id::text FROM memory_transition_audit WHERE tenant_id=$1::uuid AND memory_candidate_id=$2::uuid
       AND actor_user_id=$3::uuid AND client_id=$4::uuid AND effective_tenant_id=$1::uuid
       AND reason_code='approved' AND from_status='pending_review' AND to_status='active'
       AND metadata_jsonb->>'memoryItemId'=$5 AND metadata_jsonb->>'clioMemoryId'=$6
       AND metadata_jsonb->>'legacyStatus'='approved'`,
    ctx.tenantId,
    record.physicalId,
    ctx.userId,
    record.clientPhysicalId,
    item.id,
    candidate.committed_memory_id,
  );
  if (
    audits.length !== 1 ||
    !hash.test(item.source_content_hash ?? '') ||
    item.source_version !== 'candidate:' + record.physicalId
  )
    fail();
  const proof = {
    ...base,
    state: 'approved',
    item: {
      id: item.id,
      clioMemoryId: candidate.committed_memory_id,
      rowVersion: item.row_version,
      sourceVersion: item.source_version,
      contentSha256: item.source_content_hash,
      status: item.status,
      governedStatus: item.governed_status,
    },
    decision: { transitionAuditId: audits[0].id, actorUserId: ctx.userId, decision: 'approved' },
  };
  return { ...proof, currentVerifySha256: sha256Stable(proof) };
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
async function approvedCurrent(tx, ctx, ports, input) {
  if (
    input.caseId !== '14' ||
    !UUID.test(input.captureRunId ?? '') ||
    !UUID.test(input.clientId ?? '')
  )
    fail();
  const rows = await tx.$queryRawUnsafe(
    'SELECT settings_jsonb AS settings,xmin::text AS version FROM tenants WHERE id=$1::uuid FOR UPDATE',
    ctx.tenantId,
  );
  const owner = await readCase14MemoryOwnerInTx(tx, ctx, ports);
  if (rows.length !== 1 || owner?.state !== 'approved' || owner.clientId !== input.clientId) fail();
  const sourceMap = {
    'MEM-PROPOSAL-14': {
      frozenFixtureId: 'MEM-PROPOSAL-14',
      kind: 'memory',
      physicalId: owner.item.id,
      tenantPhysicalId: ctx.tenantId,
      clientPhysicalId: owner.clientId,
      version: owner.item.sourceVersion,
    },
  };
  return { row: rows[0], owner, sourceMap, physicalMapSha256: sha256Stable(sourceMap) };
}
function bindingPlan(ctx, input, current) {
  return {
    kind: 'meri-case14-recall-binding-plan',
    schemaVersion: 1,
    caseId: '14',
    captureRunId: input.captureRunId,
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    clientId: input.clientId,
    tenantRowVersion: current.row.version,
    priorSettingsSha256: sha256Stable(current.row.settings),
    approvedOwnerSha256: current.owner.currentVerifySha256,
    physicalMapSha256: current.physicalMapSha256,
    sharedCorpusWrites: 0,
    approvalDecisions: 0,
    liveAcceptance: 'NOT_RUN',
  };
}

/** Post-decision source binding only: cannot approve, reseed, reset, or send. */
export async function inspectCase14RecallBindingInTx(tx, ctx, ports, input) {
  const plan = bindingPlan(ctx, input, await approvedCurrent(tx, ctx, ports, input));
  return { ...plan, planSha256: sha256Stable(plan) };
}

export async function qualifyCase14RecallInTx(tx, ctx, ports, input) {
  const current = await approvedCurrent(tx, ctx, ports, input);
  const fixture = current.row.settings.meriFoundationFixture;
  const locator = fixture.case14RecallOwner;
  if (
    !locator ||
    locator.kind !== 'meri-case14-recall-owner' ||
    locator.schemaVersion !== 1 ||
    locator.captureRunId !== input.captureRunId ||
    locator.actorUserId !== ctx.userId ||
    locator.clientId !== input.clientId ||
    locator.approvedOwnerSha256 !== current.owner.currentVerifySha256 ||
    locator.physicalMapSha256 !== current.physicalMapSha256
  )
    fail();
  const seed = assertReceiptHash(locator.seedReceipt, 'meri-synthetic-fixture-seed-receipt');
  const reset = assertReceiptHash(locator.resetReceipt, 'meri-synthetic-fixture-reset-receipt');
  if (
    seed.owner !== 'meri_case14_canonical_approval_v1' ||
    reset.owner !== seed.owner ||
    seed.operationId !== reset.operationId ||
    !UUID.test(seed.operationId ?? '') ||
    seed.tenantId !== ctx.tenantId ||
    seed.actorUserId !== ctx.userId ||
    seed.clientId !== input.clientId ||
    seed.captureRunId !== input.captureRunId ||
    seed.caseId !== '14' ||
    seed.approvedOwnerSha256 !== current.owner.currentVerifySha256 ||
    seed.physicalMapSha256 !== current.physicalMapSha256 ||
    seed.setupReceiptSha256 !== current.owner.setupReceiptSha256 ||
    seed.transitionAuditId !== current.owner.decision.transitionAuditId ||
    reset.scope !== 'replace_owned_capture_binding_only_after_canonical_approval' ||
    reset.sharedCorpusWrites !== 0 ||
    !hash.test(reset.priorSettingsSha256 ?? '') ||
    fixture.case14RecallRuns?.[input.captureRunId] !== seed.operationId
  )
    fail();
  const currentVerify = {
    kind: 'meri-case14-current-approved-source',
    schemaVersion: 1,
    canonicalOwner: current.owner,
    seedReceiptSha256: locator.seedReceipt.contentSha256,
    resetReceiptSha256: locator.resetReceipt.contentSha256,
  };
  return {
    fixtureReady: true,
    missing: [],
    liveAcceptance: 'NOT_RUN',
    fixtureNamespace: FIXTURE_NAMESPACE,
    fixtureVersion: current.owner.fixtureVersion,
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    clientId: input.clientId,
    caseId: '14',
    captureRunId: input.captureRunId,
    sourceMap: current.sourceMap,
    physicalMapSha256: current.physicalMapSha256,
    currentVerify,
    currentVerifySha256: sha256Stable(currentVerify),
    seedReceiptId: fixtureReceiptId(locator.seedReceipt, 'meri-synthetic-fixture-seed-receipt'),
    resetReceiptId: fixtureReceiptId(locator.resetReceipt, 'meri-synthetic-fixture-reset-receipt'),
  };
}

export async function installCase14RecallBindingInTx(tx, ctx, ports, input) {
  if (input.confirmation !== 'BIND_EXISTING_CASE14_CANONICAL_APPROVAL') fail();
  const current = await approvedCurrent(tx, ctx, ports, input);
  if (input.expectedPlanSha256 !== sha256Stable(bindingPlan(ctx, input, current))) fail();
  const settings = structuredClone(current.row.settings),
    fixture = settings.meriFoundationFixture;
  const runs = fixture.case14RecallRuns ?? {};
  if (
    !runs ||
    typeof runs !== 'object' ||
    Array.isArray(runs) ||
    Object.keys(runs).length >= 200 ||
    Object.hasOwn(runs, input.captureRunId) ||
    fixture.captureEvidence?.captureRunId === input.captureRunId
  )
    fail();
  const operationId = randomUUID();
  const resetReceipt = receiptWithHash({
    kind: 'meri-synthetic-fixture-reset-receipt',
    owner: 'meri_case14_canonical_approval_v1',
    operationId,
    scope: 'replace_owned_capture_binding_only_after_canonical_approval',
    priorSettingsSha256: sha256Stable(current.row.settings),
    sharedCorpusWrites: 0,
  });
  const seedReceipt = receiptWithHash({
    kind: 'meri-synthetic-fixture-seed-receipt',
    owner: 'meri_case14_canonical_approval_v1',
    operationId,
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    clientId: input.clientId,
    caseId: '14',
    captureRunId: input.captureRunId,
    approvedOwnerSha256: current.owner.currentVerifySha256,
    physicalMapSha256: current.physicalMapSha256,
    setupReceiptSha256: current.owner.setupReceiptSha256,
    transitionAuditId: current.owner.decision.transitionAuditId,
  });
  fixture.case14RecallOwner = {
    kind: 'meri-case14-recall-owner',
    schemaVersion: 1,
    captureRunId: input.captureRunId,
    actorUserId: ctx.userId,
    clientId: input.clientId,
    approvedOwnerSha256: current.owner.currentVerifySha256,
    physicalMapSha256: current.physicalMapSha256,
    seedReceipt,
    resetReceipt,
  };
  fixture.case14RecallRuns = { ...runs, [input.captureRunId]: operationId };
  fixture.captureEvidence = null;
  fixture.captureProviderBudget = null;
  const written = await tx.$queryRawUnsafe(
    'UPDATE tenants SET settings_jsonb=$1::jsonb WHERE id=$2::uuid AND xmin::text=$3 AND settings_jsonb=$4::jsonb RETURNING xmin::text AS version',
    stableJson(settings),
    ctx.tenantId,
    current.row.version,
    stableJson(current.row.settings),
  );
  if (written.length !== 1) fail();
  const proof = await qualifyCase14RecallInTx(tx, ctx, ports, input);
  const binding = {
    caseId: '14',
    captureRunId: input.captureRunId,
    fixtureVersion: proof.fixtureVersion,
    physicalMapSha256: proof.physicalMapSha256,
    seedReceiptId: proof.seedReceiptId,
    resetReceiptId: proof.resetReceiptId,
    fixtureNamespace: FIXTURE_NAMESPACE,
    actorUserId: ctx.userId,
    clientId: input.clientId,
    currentVerifySha256: proof.currentVerifySha256,
  };
  const rows = await tx.$queryRawUnsafe(
    "UPDATE tenants SET settings_jsonb=jsonb_set(settings_jsonb,'{meriFoundationFixture,captureEvidence}',$1::jsonb,true) WHERE id=$2::uuid AND xmin::text=$3 RETURNING settings_jsonb AS settings",
    stableJson(binding),
    ctx.tenantId,
    written[0].version,
  );
  if (
    rows.length !== 1 ||
    stableJson(rows[0].settings.meriFoundationFixture.captureEvidence) !== stableJson(binding)
  )
    fail();
  return {
    status: 'CASE14_RECALL_BOUND',
    operationId,
    binding,
    sourceMap: proof.sourceMap,
    seedReceipt,
    resetReceipt,
    sharedCorpusWrites: 0,
    approvalDecisions: 0,
    synthesisSubmissionCount: 0,
    liveAcceptance: 'NOT_RUN',
  };
}
