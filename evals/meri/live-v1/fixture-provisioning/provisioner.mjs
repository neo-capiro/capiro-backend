import { sha256Stable } from '../lib/stable.mjs';
import {
  APPLY_CONFIRMATION,
  RESET_CONFIRMATION,
  FixtureProvisioningError,
  assertReceiptHash,
  receiptWithHash,
} from './contract.mjs';
import { assertManifest } from './manifest.mjs';

function assertAdapter(adapter) {
  for (const method of ['inspect', 'createOwned', 'replaceOwned', 'deleteOwned']) {
    if (typeof adapter?.[method] !== 'function') {
      throw new FixtureProvisioningError(
        'ADAPTER_INVALID',
        `canonical owner adapter lacks ${method}`,
      );
    }
  }
}

function rowVersion(row) {
  if (row?.rowVersion === undefined || row?.rowVersion === null || row.rowVersion === '') {
    throw new FixtureProvisioningError(
      'ROW_VERSION_MISSING',
      'canonical readback omitted rowVersion',
    );
  }
  return String(row.rowVersion);
}

function assertExactOwnedRow(record, row) {
  if (row.tenantId !== record.tenantId) {
    throw new FixtureProvisioningError(
      'TENANT_GUARD_MISMATCH',
      `${record.logicalId} tenant guard mismatch`,
    );
  }
  if (row.physicalId !== record.physicalId || row.owner !== record.owner) {
    throw new FixtureProvisioningError(
      'OWNER_JOIN_MISMATCH',
      `${record.logicalId} canonical owner join mismatch`,
    );
  }
  if (
    row.ownership?.markerSha256 !== record.ownership.markerSha256 ||
    row.ownership?.marker?.logicalId !== record.logicalId
  ) {
    throw new FixtureProvisioningError(
      'UNOWNED_ROW_COLLISION',
      `${record.logicalId} is not owned by this manifest`,
    );
  }
  return rowVersion(row);
}

function assertAbsent(record, existing) {
  if (existing) {
    throw new FixtureProvisioningError(
      'EXPECTED_ABSENT_ROW_PRESENT',
      `${record.logicalId} must start absent; automatic deletion is forbidden`,
    );
  }
}

function operationFor(record, existing) {
  if (record.expectedPresence === 'absent') {
    assertAbsent(record, existing);
    return {
      action: 'assert_absent',
      logicalId: record.logicalId,
      physicalId: record.physicalId,
      owner: record.owner,
      tenantId: record.tenantId,
      expectedRowVersion: null,
      expectedPayloadSha256: record.payloadSha256,
      expectedOwnershipMarkerSha256: record.ownership.markerSha256,
    };
  }
  if (!existing) {
    return {
      action: 'create',
      logicalId: record.logicalId,
      physicalId: record.physicalId,
      owner: record.owner,
      tenantId: record.tenantId,
      expectedRowVersion: null,
      expectedPayloadSha256: record.payloadSha256,
      expectedOwnershipMarkerSha256: record.ownership.markerSha256,
    };
  }
  const version = assertExactOwnedRow(record, existing);
  return {
    action: existing.payloadSha256 === record.payloadSha256 ? 'noop' : 'replace',
    logicalId: record.logicalId,
    physicalId: record.physicalId,
    owner: record.owner,
    tenantId: record.tenantId,
    expectedRowVersion: version,
    expectedPayloadSha256: record.payloadSha256,
    expectedOwnershipMarkerSha256: record.ownership.markerSha256,
  };
}

function planBody(manifest, operations, unavailable, authority) {
  return {
    kind: 'meri-synthetic-fixture-plan',
    manifestContentSha256: manifest.contentSha256,
    fixtureNamespace: manifest.fixtureNamespace,
    fixtureVersion: manifest.fixtureVersion,
    dryRun: true,
    authority,
    operations,
    unavailable,
    summary: {
      absent: operations.filter((entry) => entry.action === 'assert_absent').length,
      creates: operations.filter((entry) => entry.action === 'create').length,
      replacements: operations.filter((entry) => entry.action === 'replace').length,
      stable: operations.filter((entry) => entry.action === 'noop').length,
      unavailable: unavailable.length,
    },
  };
}

export async function planFixture({ manifest, adapter }) {
  assertManifest(manifest);
  assertAdapter(adapter);
  const operations = [];
  const unavailable = [];
  for (const record of manifest.records) {
    if (record.availability.status !== 'available') {
      unavailable.push({
        logicalId: record.logicalId,
        owner: record.owner,
        reason: record.availability.reason,
      });
      continue;
    }
    const existing = await adapter.inspect(record);
    operations.push(operationFor(record, existing));
  }
  return receiptWithHash(
    planBody(manifest, operations, unavailable, adapter.authority ?? 'canonical_readback'),
  );
}

function assertPlan(plan, manifest) {
  const body = assertReceiptHash(plan, 'meri-synthetic-fixture-plan');
  if (body.manifestContentSha256 !== manifest.contentSha256 || body.dryRun !== true) {
    throw new FixtureProvisioningError(
      'PLAN_MANIFEST_MISMATCH',
      'plan is not bound to this manifest',
    );
  }
  return body;
}

function guardsFor(operation) {
  return Object.freeze({
    tenantId: operation.tenantId,
    physicalId: operation.physicalId,
    expectedOwnershipMarkerSha256: operation.expectedOwnershipMarkerSha256,
    expectedRowVersion: operation.expectedRowVersion,
  });
}

function appliedRecord(record, row) {
  const version = assertExactOwnedRow(record, row);
  if (row.payloadSha256 !== record.payloadSha256) {
    throw new FixtureProvisioningError(
      'ACTUAL_READBACK_MISMATCH',
      `${record.logicalId} canonical readback payload does not match the frozen fixture`,
    );
  }
  if (record.payload.sourceAsset) {
    if (
      row.byteSha256 !== record.payload.sourceAsset.byteSha256 ||
      row.byteSize !== record.payload.sourceAsset.byteSize ||
      !row.storageReceiptId
    ) {
      throw new FixtureProvisioningError(
        'ASSET_READBACK_MISMATCH',
        `${record.logicalId} storage owner did not prove immutable uploaded bytes`,
      );
    }
  }
  return {
    logicalId: record.logicalId,
    physicalId: row.physicalId,
    owner: row.owner,
    tenantId: row.tenantId,
    payloadSha256: row.payloadSha256,
    rowVersion: version,
    byteSha256: row.byteSha256 ?? null,
    storageReceiptId: row.storageReceiptId ?? null,
  };
}

function failureResult(operation, error, mutationAttempted = false) {
  return {
    logicalId: operation.logicalId,
    physicalId: operation.physicalId,
    action: operation.action,
    outcome: mutationAttempted || error?.unknownCommit === true ? 'unknown_outcome' : 'failed',
    errorCode: error?.code ?? 'CANONICAL_OWNER_WRITE_FAILED',
  };
}

export async function applyFixture({ manifest, plan, adapter, confirmation }) {
  assertManifest(manifest);
  assertAdapter(adapter);
  const planData = assertPlan(plan, manifest);
  if (planData.authority !== 'canonical_readback') {
    throw new FixtureProvisioningError(
      'CANONICAL_PLAN_REQUIRED',
      'apply requires a plan produced from authoritative canonical readback',
    );
  }
  if (confirmation !== APPLY_CONFIRMATION) {
    throw new FixtureProvisioningError(
      'APPLY_CONFIRMATION_REQUIRED',
      'exact apply confirmation is required',
    );
  }
  const records = new Map(manifest.records.map((record) => [record.logicalId, record]));
  const results = [];
  let terminalStatus = 'complete';

  for (const operation of planData.operations) {
    const record = records.get(operation.logicalId);
    if (!record) throw new FixtureProvisioningError('PLAN_RECORD_MISSING', operation.logicalId);
    try {
      const before = await adapter.inspect(record);
      if (record.expectedPresence === 'absent') {
        if (operation.action !== 'assert_absent') {
          throw new FixtureProvisioningError('PLAN_PRESENCE_MISMATCH', record.logicalId);
        }
        assertAbsent(record, before);
        results.push({
          action: 'assert_absent',
          outcome: 'verified_absent',
          logicalId: record.logicalId,
          physicalId: record.physicalId,
          tenantId: record.tenantId,
          owner: record.owner,
        });
        continue;
      }
      if (!['create', 'replace', 'noop'].includes(operation.action)) {
        throw new FixtureProvisioningError('PLAN_ACTION_INVALID', record.logicalId);
      }
      if (operation.action === 'create') {
        if (before) assertExactOwnedRow(record, before);
        if (before) {
          if (before.payloadSha256 !== record.payloadSha256) {
            throw new FixtureProvisioningError(
              'CREATE_PRECONDITION_FAILED',
              `${record.logicalId} appeared after planning with different content`,
            );
          }
        } else {
          await adapter.createOwned(record, guardsFor(operation));
        }
      } else {
        if (!before) {
          throw new FixtureProvisioningError(
            'EXPECTED_ROW_MISSING',
            `${record.logicalId} disappeared after planning`,
          );
        }
        const actualVersion = assertExactOwnedRow(record, before);
        if (actualVersion !== operation.expectedRowVersion) {
          throw new FixtureProvisioningError(
            'ROW_VERSION_CHANGED',
            `${record.logicalId} changed after planning`,
          );
        }
        if (operation.action === 'replace') {
          await adapter.replaceOwned(record, guardsFor(operation));
        }
      }
      const actual = await adapter.inspect(record);
      if (!actual) {
        const error = new FixtureProvisioningError(
          'WRITE_OUTCOME_UNKNOWN',
          `${record.logicalId} is absent after the canonical owner returned`,
        );
        error.unknownCommit = true;
        throw error;
      }
      results.push({
        action: operation.action,
        outcome: 'committed',
        ...appliedRecord(record, actual),
      });
    } catch (error) {
      const result = failureResult(operation, error);
      results.push(result);
      terminalStatus = result.outcome;
      break;
    }
  }

  return receiptWithHash({
    kind: 'meri-synthetic-fixture-seed-receipt',
    manifestContentSha256: manifest.contentSha256,
    planContentSha256: plan.contentSha256,
    status: terminalStatus,
    records: results,
    unavailable: planData.unavailable,
    fixtureComplete: false,
    completenessStatement:
      planData.unavailable.length === 0
        ? 'all manifest-listed available records were attempted; acceptance remains separately unqualified'
        : 'subset only; unavailable canonical sources/adapters are listed and no full-fixture claim is made',
  });
}

export async function verifyFixture({ manifest, adapter }) {
  assertManifest(manifest);
  assertAdapter(adapter);
  const records = [];
  const unavailable = [];
  let status = 'complete';
  for (const record of manifest.records) {
    if (record.availability.status !== 'available') {
      unavailable.push({
        logicalId: record.logicalId,
        owner: record.owner,
        reason: record.availability.reason,
      });
      continue;
    }
    try {
      const actual = await adapter.inspect(record);
      if (record.expectedPresence === 'absent') {
        assertAbsent(record, actual);
        records.push({
          logicalId: record.logicalId,
          physicalId: record.physicalId,
          outcome: 'verified_absent',
        });
        continue;
      }
      if (!actual) throw new FixtureProvisioningError('EXPECTED_ROW_MISSING', record.logicalId);
      records.push({ outcome: 'verified', ...appliedRecord(record, actual) });
    } catch (error) {
      status = 'failed';
      records.push({
        logicalId: record.logicalId,
        physicalId: record.physicalId,
        outcome: 'failed',
        errorCode: error?.code ?? 'VERIFY_FAILED',
      });
    }
  }
  return receiptWithHash({
    kind: 'meri-synthetic-fixture-verify-receipt',
    manifestContentSha256: manifest.contentSha256,
    status,
    records,
    unavailable,
    fixtureComplete: false,
  });
}

export async function planOwnedReset({ manifest, seedReceipt, adapter }) {
  assertManifest(manifest);
  assertAdapter(adapter);
  const seed = assertReceiptHash(seedReceipt, 'meri-synthetic-fixture-seed-receipt');
  if (seed.manifestContentSha256 !== manifest.contentSha256 || seed.status !== 'complete') {
    throw new FixtureProvisioningError(
      'SEED_RECEIPT_NOT_RESETTABLE',
      'only a complete matching seed receipt can reset',
    );
  }
  const manifestRecords = new Map(manifest.records.map((record) => [record.logicalId, record]));
  const operations = [];
  for (const seeded of [...seed.records].reverse()) {
    if (seeded.outcome !== 'committed') continue;
    const record = manifestRecords.get(seeded.logicalId);
    if (!record || record.physicalId !== seeded.physicalId) {
      throw new FixtureProvisioningError('RESET_MANIFEST_JOIN_FAILED', seeded.logicalId);
    }
    const actual = await adapter.inspect(record);
    if (!actual) continue;
    const actualVersion = assertExactOwnedRow(record, actual);
    if (actualVersion !== String(seeded.rowVersion)) {
      throw new FixtureProvisioningError(
        'RESET_ROW_VERSION_CHANGED',
        `${record.logicalId} changed since apply`,
      );
    }
    operations.push({
      action: 'delete_owned',
      logicalId: record.logicalId,
      physicalId: record.physicalId,
      owner: record.owner,
      tenantId: record.tenantId,
      expectedRowVersion: actualVersion,
      expectedOwnershipMarkerSha256: record.ownership.markerSha256,
    });
  }
  return receiptWithHash({
    kind: 'meri-synthetic-fixture-reset-plan',
    manifestContentSha256: manifest.contentSha256,
    seedReceiptContentSha256: seedReceipt.contentSha256,
    dryRun: true,
    operations,
  });
}

export async function applyOwnedReset({ manifest, seedReceipt, resetPlan, adapter, confirmation }) {
  assertManifest(manifest);
  assertAdapter(adapter);
  assertReceiptHash(seedReceipt, 'meri-synthetic-fixture-seed-receipt');
  const plan = assertReceiptHash(resetPlan, 'meri-synthetic-fixture-reset-plan');
  if (confirmation !== RESET_CONFIRMATION) {
    throw new FixtureProvisioningError(
      'RESET_CONFIRMATION_REQUIRED',
      'exact reset confirmation is required',
    );
  }
  if (
    plan.manifestContentSha256 !== manifest.contentSha256 ||
    plan.seedReceiptContentSha256 !== seedReceipt.contentSha256
  ) {
    throw new FixtureProvisioningError(
      'RESET_PLAN_MISMATCH',
      'reset plan is not bound to seed receipt',
    );
  }
  const records = new Map(manifest.records.map((record) => [record.logicalId, record]));
  const results = [];
  let status = 'complete';
  for (const operation of plan.operations) {
    const record = records.get(operation.logicalId);
    if (!record)
      throw new FixtureProvisioningError('RESET_MANIFEST_JOIN_FAILED', operation.logicalId);
    let mutationAttempted = false;
    try {
      const actual = await adapter.inspect(record);
      if (!actual) {
        results.push({ logicalId: record.logicalId, outcome: 'already_absent' });
        continue;
      }
      const actualVersion = assertExactOwnedRow(record, actual);
      if (actualVersion !== operation.expectedRowVersion) {
        throw new FixtureProvisioningError(
          'RESET_ROW_VERSION_CHANGED',
          `${record.logicalId} changed after reset plan`,
        );
      }
      mutationAttempted = true;
      await adapter.deleteOwned(record, guardsFor(operation));
      const after = await adapter.inspect(record);
      if (after) {
        const error = new FixtureProvisioningError('DELETE_OUTCOME_UNKNOWN', record.logicalId);
        error.unknownCommit = true;
        throw error;
      }
      results.push({
        logicalId: record.logicalId,
        physicalId: record.physicalId,
        outcome: 'deleted',
      });
    } catch (error) {
      const failed = failureResult(operation, error, mutationAttempted);
      results.push(failed);
      status = failed.outcome;
      break;
    }
  }
  return receiptWithHash({
    kind: 'meri-synthetic-fixture-reset-receipt',
    manifestContentSha256: manifest.contentSha256,
    seedReceiptContentSha256: seedReceipt.contentSha256,
    resetPlanContentSha256: resetPlan.contentSha256,
    status,
    records: results,
  });
}

export function planFingerprint(plan) {
  return sha256Stable(plan.operations ?? []);
}
