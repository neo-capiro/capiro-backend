import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { sha256Bytes } from '../lib/stable.mjs';
import { FixtureProvisioningError, fixtureRecordKey } from './contract.mjs';

function requirePort(ports, owner, operation) {
  const port = ports?.[owner];
  const method = port?.[operation];
  if (typeof method !== 'function') {
    throw new FixtureProvisioningError(
      'CANONICAL_OWNER_PORT_UNAVAILABLE',
      `${owner} canonical owner does not implement ${operation}`,
    );
  }
  return method.bind(port);
}

function assertGuard(record, guards) {
  if (
    guards?.tenantId !== record.tenantId ||
    guards?.physicalId !== record.physicalId ||
    guards?.expectedOwnershipMarkerSha256 !== record.ownership.markerSha256
  ) {
    throw new FixtureProvisioningError(
      'WRITE_GUARD_MISMATCH',
      `${record.logicalId} write guard mismatch`,
    );
  }
  if (guards.expectedRowVersion !== null && guards.expectedRowVersion === undefined) {
    throw new FixtureProvisioningError(
      'ROW_VERSION_GUARD_MISSING',
      `${record.logicalId} row version guard missing`,
    );
  }
}

/**
 * Adapter over existing canonical owner services. It does not persist a fixture
 * ledger or generic source row. Each owner port must perform its mutation and
 * tenant/marker/version compare atomically in its own canonical transaction.
 */
export class CanonicalOwnerAdapter {
  constructor({ ownerPorts }) {
    this.ownerPorts = ownerPorts;
  }

  async inspect(record) {
    return requirePort(this.ownerPorts, record.owner, 'read')(record);
  }

  async createOwned(record, guards) {
    assertGuard(record, guards);
    if (guards.expectedRowVersion !== null) {
      throw new FixtureProvisioningError('CREATE_VERSION_GUARD_INVALID', record.logicalId);
    }
    return requirePort(this.ownerPorts, record.owner, 'create')(record, guards);
  }

  async replaceOwned(record, guards) {
    assertGuard(record, guards);
    if (guards.expectedRowVersion === null) {
      throw new FixtureProvisioningError('REPLACE_VERSION_GUARD_MISSING', record.logicalId);
    }
    return requirePort(this.ownerPorts, record.owner, 'replace')(record, guards);
  }

  async deleteOwned(record, guards) {
    assertGuard(record, guards);
    if (guards.expectedRowVersion === null) {
      throw new FixtureProvisioningError('DELETE_VERSION_GUARD_MISSING', record.logicalId);
    }
    return requirePort(this.ownerPorts, record.owner, 'delete')(record, guards);
  }

  async retireOwned(record, guards) {
    assertGuard(record, guards);
    if (guards.expectedRowVersion === null) {
      throw new FixtureProvisioningError('RETIRE_VERSION_GUARD_MISSING', record.logicalId);
    }
    return requirePort(this.ownerPorts, record.owner, 'retire')(record, guards);
  }

  async inspectForRetirement(record) {
    const port = this.ownerPorts?.[record.owner];
    return typeof port?.readForRetirement === 'function'
      ? port.readForRetirement(record)
      : this.inspect(record);
  }

  async inspectRetirement(record, guards) {
    return requirePort(this.ownerPorts, record.owner, 'readRetirement')(record, guards);
  }
}

export function clientDocumentPhysicalId({
  tenantId,
  userId,
  clientId,
  idempotencyKey,
  contentType,
  bytes,
  byteSha256,
}) {
  const digestOfBytes = byteSha256 ?? sha256Bytes(bytes);
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        'client-document-v1',
        tenantId,
        userId,
        clientId ?? null,
        null,
        idempotencyKey,
        contentType,
        false,
        digestOfBytes,
      ]),
    )
    .digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/**
 * Builds only the EngagementAttachment port. The supplied documentWriter must
 * be ClientDocumentWriterService (or an exact test adapter), so S3/object
 * lifecycle ownership remains in the application. No filesystem URL is stored.
 */
export function createClientDocumentOwnerPort({
  documentWriter,
  reader,
  actorForTenant,
  assetRoot,
}) {
  if (typeof documentWriter?.createAttachmentFromBuffer !== 'function') {
    throw new FixtureProvisioningError(
      'DOCUMENT_WRITER_REQUIRED',
      'ClientDocumentWriterService is required',
    );
  }
  if (typeof reader !== 'function') {
    throw new FixtureProvisioningError('DOCUMENT_OWNER_INCOMPLETE', 'document reader is required');
  }

  async function loadBytes(record) {
    const asset = record.payload.sourceAsset;
    let bytes;
    if (asset?.sourcePath) bytes = await readFile(new URL(`../${asset.sourcePath}`, assetRoot));
    else if (typeof record.payload.facts?.utf8Bytes === 'string') {
      bytes = Buffer.from(record.payload.facts.utf8Bytes, 'utf8');
    } else {
      throw new FixtureProvisioningError('ASSET_BYTES_UNAVAILABLE', record.logicalId);
    }
    const expected = asset?.byteSha256 ?? record.payload.facts?.byteSha256;
    if (!expected || sha256Bytes(bytes) !== expected) {
      throw new FixtureProvisioningError('ASSET_BYTE_HASH_MISMATCH', record.logicalId);
    }
    return bytes;
  }

  return {
    read: reader,
    async create(record, guards) {
      assertGuard(record, guards);
      const userId = actorForTenant(record.tenantId);
      if (!userId)
        throw new FixtureProvisioningError('DOCUMENT_ACTOR_UNAVAILABLE', record.logicalId);
      const bytes = await loadBytes(record);
      const asset = record.payload.sourceAsset;
      const contentType = asset?.mediaType ?? 'text/plain';
      const idempotencyKey = fixtureRecordKey(
        record.logicalId,
        record.ownership.marker.fixtureInstanceId,
      );
      const expectedId = clientDocumentPhysicalId({
        tenantId: record.tenantId,
        userId,
        clientId: record.clientPhysicalId,
        idempotencyKey,
        contentType,
        bytes,
      });
      if (expectedId !== record.physicalId) {
        throw new FixtureProvisioningError(
          'DOCUMENT_IDENTITY_MISMATCH',
          `${record.logicalId} source map is not bound to the canonical uploader identity`,
        );
      }
      const result = await documentWriter.createAttachmentFromBuffer(
        { tenantId: record.tenantId, userId },
        {
          clientId: record.clientPhysicalId,
          fileName: asset?.fileName ?? `${record.logicalId}.txt`,
          contentType,
          buffer: bytes,
          source: 'meri_synthetic_fixture',
          sourceEntityType: 'meri_synthetic_fixture',
          sourceEntityId: record.ownership.markerSha256,
          idempotencyKey,
          sourceVersion:
            Number.parseInt(String(asset?.version ?? '1').replace(/\D/gu, ''), 10) || 1,
          sourceContentHash: sha256Bytes(bytes),
          untrustedUpload: true,
        },
      );
      if (result.id !== expectedId || !result.s3Key) {
        const error = new FixtureProvisioningError(
          'DOCUMENT_UPLOAD_OUTCOME_UNKNOWN',
          record.logicalId,
        );
        error.unknownCommit = true;
        throw error;
      }
      return result;
    },
    async replace() {
      throw new FixtureProvisioningError(
        'IMMUTABLE_ASSET_REPLACEMENT_REFUSED',
        'asset changes require a new source version, never in-place replacement',
      );
    },
    async delete() {
      // EngagementService.deleteAttachment currently performs a read followed by
      // a later lifecycle mutation. It cannot atomically fence tenant + fixture
      // marker + logical identity + expected row version, so fixture reset must
      // fail closed until that canonical erasure owner exposes a guarded path.
      throw new FixtureProvisioningError(
        'DOCUMENT_GUARDED_ERASURE_UNAVAILABLE',
        'fixture-owned documents are immutable; guarded canonical erasure is not available',
      );
    },
  };
}

export { createMemoryCandidateOwnerPort } from './memory-candidate-owner.mjs';
