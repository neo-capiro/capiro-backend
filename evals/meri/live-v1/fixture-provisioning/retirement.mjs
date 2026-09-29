import { sha256Stable } from '../lib/stable.mjs';
import { assertManifest } from './manifest.mjs';
import {
  RETIRE_CONFIRMATION,
  FixtureProvisioningError,
  assertReceiptHash,
  receiptWithHash,
} from './contract.mjs';

const PLAN = 'meri-synthetic-fixture-retirement-plan';
const RECEIPT = 'meri-synthetic-fixture-retirement-receipt';
const VERIFY = 'meri-synthetic-fixture-retirement-verify-receipt';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const fail = (code, message) => {
  throw new FixtureProvisioningError(code, message);
};
const same = (left, right) => sha256Stable(left) === sha256Stable(right);
const version = (value) =>
  typeof value === 'string' && /^[0-9]{1,10}$/u.test(value) && Number(value) <= 0xffffffff;

function inputs({ manifest, replacementManifest, seedReceipt, adapter }) {
  assertManifest(manifest);
  assertManifest(replacementManifest);
  if (
    !replacementManifest.fixtureInstanceId ||
    replacementManifest.fixtureInstanceId === manifest.fixtureInstanceId
  ) {
    fail('RETIREMENT_INSTANCE_REQUIRED', 'replacement requires a distinct fixture instance');
  }
  for (const key of [
    'fixtureNamespace',
    'fixtureVersion',
    'fixtureSha256',
    'contractSourceSha256',
    'tenants',
    'clients',
    'actors',
    'uploaderActors',
  ]) {
    if (!same(manifest[key], replacementManifest[key]))
      fail('RETIREMENT_REPLACEMENT_MISMATCH', key);
  }
  const logical = ({ physicalId: _physical, ownership: _ownership, ...record }) => record;
  if (!same(manifest.records.map(logical), replacementManifest.records.map(logical))) {
    fail('RETIREMENT_REPLACEMENT_MISMATCH', 'logical records or owner availability changed');
  }
  const seed = assertReceiptHash(seedReceipt, 'meri-synthetic-fixture-seed-receipt');
  if (
    seed.status !== 'complete' ||
    seed.manifestContentSha256 !== manifest.contentSha256 ||
    !Array.isArray(seed.records)
  ) {
    fail('RETIREMENT_SEED_INVALID', 'complete matching seed receipt required');
  }
  if (
    adapter?.authority !== 'canonical_readback' ||
    ['inspect', 'retireOwned', 'inspectRetirement'].some(
      (method) => typeof adapter[method] !== 'function',
    )
  ) {
    fail('RETIREMENT_OWNER_REQUIRED', 'canonical retirement and readback owner required');
  }
  const available = manifest.records.filter((record) => record.availability.status === 'available');
  const unavailable = manifest.records
    .filter((record) => record.availability.status !== 'available')
    .map(({ logicalId, owner, availability }) => ({
      logicalId,
      owner,
      reason: availability.reason,
    }));
  if (!same(seed.unavailable, unavailable) || seed.records.length !== available.length) {
    fail('RETIREMENT_SEED_COVERAGE', 'seed must account for every available record exactly once');
  }
  const seeded = new Map(seed.records.map((record) => [record.logicalId, record]));
  if (seeded.size !== available.length) fail('RETIREMENT_SEED_COVERAGE', 'duplicate seed record');
  const next = new Map(replacementManifest.records.map((record) => [record.logicalId, record]));
  const operations = available.map((record) => {
    const row = seeded.get(record.logicalId);
    if (
      !row ||
      row.physicalId !== record.physicalId ||
      row.tenantId !== record.tenantId ||
      row.owner !== record.owner
    ) {
      fail('RETIREMENT_SEED_JOIN', record.logicalId);
    }
    const absent = record.expectedPresence === 'absent';
    if (
      absent
        ? row.outcome !== 'verified_absent'
        : row.outcome !== 'committed' ||
          row.payloadSha256 !== record.payloadSha256 ||
          !version(row.rowVersion)
    ) {
      fail('RETIREMENT_SEED_INVALID', record.logicalId);
    }
    // Each additional owner must define its own terminal state and proof contract.
    if (!absent && record.owner !== 'memory_candidate')
      fail('RETIREMENT_OWNER_UNSUPPORTED', record.owner);
    if (next.get(record.logicalId).physicalId === record.physicalId)
      fail('RETIREMENT_INSTANCE_COLLISION', record.logicalId);
    return {
      action: absent ? 'verify_absent' : 'withdraw_pending',
      logicalId: record.logicalId,
      physicalId: record.physicalId,
      owner: record.owner,
      tenantId: record.tenantId,
      replacementPhysicalId: next.get(record.logicalId).physicalId,
      expectedOwnershipMarkerSha256: record.ownership.markerSha256,
      expectedPayloadSha256: record.payloadSha256,
      expectedRowVersion: absent ? null : row.rowVersion,
    };
  });
  return {
    operations,
    unavailable,
    records: new Map(available.map((record) => [record.logicalId, record])),
  };
}

function binding({ manifest, replacementManifest, seedReceipt }) {
  return {
    manifestContentSha256: manifest.contentSha256,
    replacementManifestContentSha256: replacementManifest.contentSha256,
    seedReceiptContentSha256: seedReceipt.contentSha256,
  };
}

function assertPending(record, operation, row) {
  if (
    !row ||
    row.physicalId !== record.physicalId ||
    row.tenantId !== record.tenantId ||
    row.owner !== record.owner ||
    !same(row.ownership, record.ownership) ||
    row.payloadSha256 !== record.payloadSha256 ||
    row.rowVersion !== operation.expectedRowVersion
  ) {
    fail('RETIREMENT_ROW_CHANGED', record.logicalId);
  }
}

function retained(record, operation, row) {
  if (
    !row ||
    row.retained !== true ||
    row.status !== 'withdrawn' ||
    row.governedStatus !== 'rejected' ||
    row.physicalId !== record.physicalId ||
    row.tenantId !== record.tenantId ||
    row.owner !== record.owner ||
    !same(row.ownership, record.ownership) ||
    row.payloadSha256 !== record.payloadSha256 ||
    row.priorRowVersion !== operation.expectedRowVersion ||
    !version(row.rowVersion) ||
    row.rowVersion === operation.expectedRowVersion ||
    !UUID.test(row.transitionAuditId ?? '')
  ) {
    fail('RETIREMENT_PROOF_MISMATCH', record.logicalId);
  }
  return {
    logicalId: record.logicalId,
    replacementPhysicalId: operation.replacementPhysicalId,
    outcome: 'retained_terminal',
    physicalId: row.physicalId,
    tenantId: row.tenantId,
    owner: row.owner,
    ownership: row.ownership,
    payloadSha256: row.payloadSha256,
    rowVersion: row.rowVersion,
    priorRowVersion: row.priorRowVersion,
    retained: true,
    status: row.status,
    governedStatus: row.governedStatus,
    transitionAuditId: row.transitionAuditId,
  };
}

async function assertAbsent(adapter, record, operation) {
  if (await adapter.inspect(record)) fail('RETIREMENT_EXPECTED_ABSENT', record.logicalId);
  return {
    logicalId: record.logicalId,
    physicalId: record.physicalId,
    replacementPhysicalId: operation.replacementPhysicalId,
    outcome: 'verified_absent',
  };
}

function assertPlan(args, data) {
  const plan = assertReceiptHash(args.retirementPlan, PLAN);
  if (
    plan.dryRun !== true ||
    plan.authority !== 'canonical_readback' ||
    Object.entries(binding(args)).some(([key, value]) => plan[key] !== value) ||
    !same(plan.operations, data.operations) ||
    !same(plan.unavailable, data.unavailable)
  ) {
    fail('RETIREMENT_PLAN_MISMATCH', 'plan must exactly match both manifests and seed coverage');
  }
}

/** Content addresses bind inputs; only current canonical readback authorizes writes. */
export async function planOwnedRetirement(args) {
  const data = inputs(args);
  for (const operation of data.operations) {
    const record = data.records.get(operation.logicalId);
    if (operation.action === 'verify_absent') await assertAbsent(args.adapter, record, operation);
    else assertPending(record, operation, await args.adapter.inspect(record));
  }
  return receiptWithHash({
    kind: PLAN,
    ...binding(args),
    dryRun: true,
    authority: 'canonical_readback',
    operations: data.operations,
    unavailable: data.unavailable,
  });
}

/** Resume the SAME plan after partial/unknown outcomes, using audit-bound readback. */
export async function applyOwnedRetirement(args) {
  const data = inputs(args);
  assertPlan(args, data);
  if (args.confirmation !== RETIRE_CONFIRMATION)
    fail('RETIREMENT_CONFIRMATION_REQUIRED', 'exact retirement confirmation required');
  const records = [];
  let status = 'complete';
  for (const operation of data.operations) {
    const record = data.records.get(operation.logicalId);
    let mutationAttempted = false;
    try {
      if (operation.action === 'verify_absent') {
        records.push(await assertAbsent(args.adapter, record, operation));
        continue;
      }
      let prior;
      try {
        prior = await args.adapter.inspectRetirement(record);
      } catch (error) {
        if (error?.code !== 'MEMORY_CANDIDATE_RETIREMENT_UNVERIFIED') throw error;
      }
      if (prior) {
        records.push(retained(record, operation, prior));
        continue;
      }
      assertPending(record, operation, await args.adapter.inspect(record));
      mutationAttempted = true;
      await args.adapter.retireOwned(record, {
        tenantId: record.tenantId,
        physicalId: record.physicalId,
        expectedOwnershipMarkerSha256: operation.expectedOwnershipMarkerSha256,
        expectedRowVersion: operation.expectedRowVersion,
      });
      // Never trust only the writer's return value for retained-state evidence.
      records.push(retained(record, operation, await args.adapter.inspectRetirement(record)));
    } catch (error) {
      status = mutationAttempted || error?.unknownCommit === true ? 'unknown_outcome' : 'failed';
      records.push({
        logicalId: record.logicalId,
        physicalId: record.physicalId,
        outcome: status,
        errorCode: error?.code ?? 'RETIREMENT_OWNER_FAILED',
      });
      break;
    }
  }
  return receiptWithHash({
    kind: RECEIPT,
    ...binding(args),
    retirementPlanContentSha256: args.retirementPlan.contentSha256,
    status,
    records,
    unavailable: data.unavailable,
    fixtureComplete: false,
    completenessStatement:
      'retirement of available prior rows only; replacement seeding, query isolation and LIVE acceptance require separate evidence',
  });
}

export async function verifyOwnedRetirement(args) {
  const data = inputs(args);
  assertPlan(args, data);
  const receipt = assertReceiptHash(args.retirementReceipt, RECEIPT);
  if (
    receipt.status !== 'complete' ||
    receipt.retirementPlanContentSha256 !== args.retirementPlan.contentSha256 ||
    Object.entries(binding(args)).some(([key, value]) => receipt[key] !== value) ||
    !same(receipt.unavailable, data.unavailable) ||
    !Array.isArray(receipt.records) ||
    receipt.records.length !== data.operations.length
  ) {
    fail('RETIREMENT_RECEIPT_MISMATCH', 'complete receipt must cover this exact plan');
  }
  const records = [];
  let status = 'complete';
  for (const [index, operation] of data.operations.entries()) {
    const record = data.records.get(operation.logicalId);
    try {
      const actual =
        operation.action === 'verify_absent'
          ? await assertAbsent(args.adapter, record, operation)
          : retained(record, operation, await args.adapter.inspectRetirement(record));
      if (!same(actual, receipt.records[index]))
        fail('RETIREMENT_READBACK_CHANGED', record.logicalId);
      records.push(actual);
    } catch (error) {
      status = 'failed';
      records.push({
        logicalId: record.logicalId,
        physicalId: record.physicalId,
        outcome: 'failed',
        errorCode: error?.code ?? 'RETIREMENT_READBACK_FAILED',
      });
    }
  }
  return receiptWithHash({
    kind: VERIFY,
    ...binding(args),
    retirementReceiptContentSha256: args.retirementReceipt.contentSha256,
    status,
    records,
    unavailable: data.unavailable,
    fixtureComplete: false,
  });
}
