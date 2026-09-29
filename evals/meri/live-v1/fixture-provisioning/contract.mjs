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

export function ownedIdentity(logicalId, tenantId, owner, fixtureVersion) {
  const marker = {
    contractVersion: PROVISIONING_CONTRACT_VERSION,
    fixtureNamespace: FIXTURE_NAMESPACE,
    fixtureVersion,
    logicalId,
    owner,
    tenantId,
  };
  return Object.freeze({
    marker,
    markerSha256: sha256Stable(marker),
    physicalId: deterministicUuid(FIXTURE_NAMESPACE, fixtureVersion, tenantId, owner, logicalId),
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
