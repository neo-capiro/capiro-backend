import { createHash } from 'node:crypto';

import { sha256Stable, stableJson } from '../lib/stable.mjs';

export const PROVISIONING_SCHEMA_VERSION = 1;
export const PROVISIONING_CONTRACT_VERSION = 'meri-synthetic-fixture-provisioning-v1';
export const FIXTURE_NAMESPACE = 'meri-foundation-20260928';
export const OWNED_MARKER = `${FIXTURE_NAMESPACE}:${PROVISIONING_CONTRACT_VERSION}`;
export const APPLY_CONFIRMATION = 'APPLY_OWNED_MERI_SYNTHETIC_FIXTURE';
export const RESET_CONFIRMATION = 'RESET_MANIFEST_LISTED_MERI_SYNTHETIC_FIXTURE';

export const AUTHORIZED_TENANTS = Object.freeze({
  T1: Object.freeze({
    id: 'f2d6cf8f-057c-479a-8110-62fe5086d43f',
    slug: 'meri-foundation-20260928-t1',
  }),
  T2: Object.freeze({
    id: '52e91176-08f0-4d89-9633-bc212f5bdbbf',
    slug: 'meri-foundation-20260928-t2',
  }),
});

export class FixtureProvisioningError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'FixtureProvisioningError';
    this.code = code;
    this.details = details;
  }
}

export function deterministicUuid(...parts) {
  const bytes = createHash('sha256').update(stableJson(parts), 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function assertFixtureInstanceId(instanceId) {
  if (
    instanceId !== undefined &&
    (typeof instanceId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(instanceId))
  ) {
    throw new FixtureProvisioningError(
      'FIXTURE_INSTANCE_INVALID',
      'Fixture instance must be a lowercase UUIDv4',
    );
  }
}

export function fixtureRecordKey(logicalId, instanceId) {
  assertFixtureInstanceId(instanceId);
  return instanceId === undefined
    ? `${FIXTURE_NAMESPACE}:${logicalId}`
    : `${FIXTURE_NAMESPACE}:${instanceId}:${logicalId}`;
}

export function ownedIdentity(logicalId, tenantId, owner, fixtureVersion, instanceId) {
  assertFixtureInstanceId(instanceId);
  const marker = {
    contractVersion: PROVISIONING_CONTRACT_VERSION,
    fixtureNamespace: FIXTURE_NAMESPACE,
    fixtureVersion,
    logicalId,
    owner,
    tenantId,
    ...(instanceId === undefined ? {} : { fixtureInstanceId: instanceId }),
  };
  return Object.freeze({
    marker,
    markerSha256: sha256Stable(marker),
    physicalId: deterministicUuid(
      FIXTURE_NAMESPACE,
      fixtureVersion,
      tenantId,
      owner,
      logicalId,
      ...(instanceId === undefined ? [] : [instanceId]),
    ),
  });
}

export function contentAddress(kind, value) {
  return Object.freeze({ kind, sha256: sha256Stable(value) });
}

export function receiptWithHash(body) {
  const normalized = {
    schemaVersion: PROVISIONING_SCHEMA_VERSION,
    contractVersion: PROVISIONING_CONTRACT_VERSION,
    ...body,
  };
  return Object.freeze({ ...normalized, contentSha256: sha256Stable(normalized) });
}

export function assertReceiptHash(receipt, expectedKind) {
  const { contentSha256, ...body } = receipt ?? {};
  if (
    body.schemaVersion !== PROVISIONING_SCHEMA_VERSION ||
    body.contractVersion !== PROVISIONING_CONTRACT_VERSION
  ) {
    throw new FixtureProvisioningError(
      'RECEIPT_VERSION_MISMATCH',
      'receipt contract version is not current',
    );
  }
  if (body.kind !== expectedKind) {
    throw new FixtureProvisioningError('RECEIPT_KIND_MISMATCH', `expected ${expectedKind} receipt`);
  }
  if (contentSha256 !== sha256Stable(body)) {
    throw new FixtureProvisioningError(
      'RECEIPT_HASH_MISMATCH',
      `${expectedKind} receipt content hash mismatch`,
    );
  }
  return body;
}

export function assertAuthorizedTenant(tenantKey, tenant) {
  const authorized = AUTHORIZED_TENANTS[tenantKey];
  if (!authorized || tenant?.id !== authorized.id || tenant?.slug !== authorized.slug) {
    throw new FixtureProvisioningError(
      'TENANT_NOT_AUTHORIZED',
      `tenant ${tenantKey} is not the exact authorized synthetic tenant`,
    );
  }
}

const RECEIPT_KINDS = new Set([
  'meri-synthetic-fixture-plan',
  'meri-synthetic-fixture-seed-receipt',
  'meri-synthetic-fixture-verify-receipt',
  'meri-synthetic-fixture-reset-plan',
  'meri-synthetic-fixture-reset-receipt',
]);

/** Content identity only: a valid hash never substitutes for canonical readback. */
export function fixtureReceiptId(receipt, expectedKind) {
  if (!RECEIPT_KINDS.has(expectedKind)) {
    throw new FixtureProvisioningError('RECEIPT_KIND_UNSUPPORTED', 'unknown fixture receipt kind');
  }
  assertReceiptHash(receipt, expectedKind);
  return `${expectedKind}:sha256:${receipt.contentSha256}`;
}

export function assertFixtureReceiptId(id, receipt, expectedKind) {
  if (id !== fixtureReceiptId(receipt, expectedKind)) {
    throw new FixtureProvisioningError(
      'RECEIPT_ID_MISMATCH',
      'receipt identity does not match its typed content',
    );
  }
  return receipt;
}
