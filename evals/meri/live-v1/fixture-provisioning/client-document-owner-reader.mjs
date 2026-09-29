import { sha256Stable } from '../lib/stable.mjs';
import {
  AUTHORIZED_TENANTS,
  FIXTURE_NAMESPACE,
  FixtureProvisioningError,
  ownedIdentity,
  fixtureRecordKey,
} from './contract.mjs';
import { clientDocumentPhysicalId } from './canonical-owner-adapter.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const fail = (code, record) => {
  throw new FixtureProvisioningError(code, record?.logicalId);
};

/** Canonical source-only read: no parser, provider, scan override or raw S3 bypass. */
export function createClientDocumentOwnerReader({
  prisma,
  engagement,
  actorForTenant,
  clientMemoryAllowed,
  storageBucket,
}) {
  if (
    typeof prisma?.withTenantUser !== 'function' ||
    typeof engagement?.extractAttachmentText !== 'function' ||
    typeof actorForTenant !== 'function' ||
    typeof clientMemoryAllowed !== 'function' ||
    typeof storageBucket !== 'string' ||
    !storageBucket
  )
    throw new FixtureProvisioningError(
      'DOCUMENT_READER_INCOMPLETE',
      'canonical source reader, tenant database, wall policy, actor and bucket required',
    );
  function expected(record, userId) {
    const tenant = AUTHORIZED_TENANTS[record?.tenantKey];
    const marker = record?.ownership?.marker;
    if (
      process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE !== FIXTURE_NAMESPACE ||
      !tenant ||
      tenant.id !== record.tenantId ||
      record.owner !== 'engagement_attachment' ||
      !marker ||
      userId !== record.uploaderActorId ||
      !UUID.test(userId ?? '') ||
      !UUID.test(record.clientPhysicalId ?? '')
    )
      fail('DOCUMENT_FIXTURE_IDENTITY_INVALID', record);
    const identity = ownedIdentity(
      record.logicalId,
      record.tenantId,
      record.owner,
      marker.fixtureVersion,
      marker.fixtureInstanceId,
    );
    const asset = record.payload?.sourceAsset;
    const hash = asset?.byteSha256 ?? record.payload?.facts?.byteSha256;
    const contentType = asset?.mediaType ?? 'text/plain';
    const byteSize =
      asset?.byteSize ??
      (typeof record.payload?.facts?.utf8Bytes === 'string'
        ? Buffer.byteLength(record.payload.facts.utf8Bytes)
        : null);
    const physicalId = clientDocumentPhysicalId({
      tenantId: record.tenantId,
      userId,
      clientId: record.clientPhysicalId,
      contentType,
      byteSha256: hash,
      idempotencyKey: fixtureRecordKey(record.logicalId, marker.fixtureInstanceId),
    });
    if (
      !/^[a-f0-9]{64}$/u.test(hash ?? '') ||
      !Number.isSafeInteger(byteSize) ||
      byteSize < 0 ||
      sha256Stable(marker) !== identity.markerSha256 ||
      record.ownership.markerSha256 !== identity.markerSha256 ||
      record.physicalId !== physicalId ||
      record.ownership.physicalId !== physicalId ||
      sha256Stable(record.payload) !== record.payloadSha256
    )
      fail('DOCUMENT_FIXTURE_IDENTITY_INVALID', record);
    return {
      tenantSlug: tenant.slug,
      hash,
      byteSize,
      contentType,
      fileName: asset?.fileName ?? `${record.logicalId}.txt`,
      version: Number.parseInt(String(asset?.version ?? '1').replace(/\D/gu, ''), 10) || 1,
    };
  }
  async function readRow(record, userId, want) {
    return prisma.withTenantUser(record.tenantId, userId, async (tx) => {
      const membership = await tx.$queryRawUnsafe(
        `SELECT tm.role FROM tenant_memberships tm JOIN tenants t ON t.id=tm.tenant_id WHERE tm.tenant_id=$1::uuid AND tm.user_id=$2::uuid AND tm.status='active' AND t.slug=$3`,
        record.tenantId,
        userId,
        want.tenantSlug,
      );
      if (membership.length !== 1) fail('DOCUMENT_FIXTURE_ACTOR_UNAVAILABLE', record);
      if (!(await clientMemoryAllowed(tx, record.tenantId, userId, record.clientPhysicalId)))
        fail('DOCUMENT_FIXTURE_CLIENT_DENIED', record);
      const rows = await tx.$queryRawUnsafe(
        `SELECT id::text,tenant_id::text,client_id::text,uploaded_by_user_id::text,meeting_id::text,mail_message_id::text,
        file_name,content_type,byte_size,bucket,s3_key,source,source_entity_type,source_entity_id,source_version,source_content_hash,
        calculated_sha256,viewer_mode,viewer_user_ids,approved_at,approved_by_user_id::text,shared_at,shared_by_user_id::text,superseded_by_attachment_id::text,lifecycle_status,scan_status,xmin::text AS row_version
        FROM engagement_attachments WHERE tenant_id=$1::uuid AND id=$2::uuid`,
        record.tenantId,
        record.physicalId,
      );
      if (rows.length > 1) fail('DOCUMENT_FIXTURE_COLLISION', record);
      return { row: rows[0] ?? null, role: membership[0].role };
    });
  }
  function assertRow(record, want, row, userId) {
    if (
      row.id !== record.physicalId ||
      row.tenant_id !== record.tenantId ||
      row.client_id !== record.clientPhysicalId ||
      row.uploaded_by_user_id !== userId ||
      row.meeting_id ||
      row.mail_message_id ||
      row.source !== 'meri_synthetic_fixture' ||
      row.source_entity_type !== 'meri_synthetic_fixture' ||
      row.source_entity_id !== record.ownership.markerSha256 ||
      row.source_version !== want.version ||
      row.source_content_hash !== want.hash ||
      row.calculated_sha256 !== want.hash ||
      row.file_name !== want.fileName ||
      row.content_type !== want.contentType ||
      row.byte_size !== want.byteSize ||
      row.bucket !== storageBucket ||
      row.s3_key !== `tenants/${record.tenantId}/engagement/${record.physicalId}/document` ||
      row.viewer_mode !== 'all' ||
      !Array.isArray(row.viewer_user_ids) ||
      row.viewer_user_ids.length !== 0 ||
      row.approved_at ||
      row.approved_by_user_id ||
      row.shared_at ||
      row.shared_by_user_id ||
      row.superseded_by_attachment_id ||
      !/^[0-9]{1,10}$/u.test(row.row_version ?? '')
    )
      fail('DOCUMENT_FIXTURE_ROW_MISMATCH', record);
  }
  return async (record) => {
    const userId = await actorForTenant(record?.tenantId);
    const want = expected(record, userId);
    const before = await readRow(record, userId, want);
    if (!before.row) return null;
    assertRow(record, want, before.row, userId);
    // This owner method checks current viewer/parent/readiness policy BEFORE
    // reading bytes and calculates the actual content hash. Quarantine stays closed.
    const actual = await engagement.extractAttachmentText(
      { tenantId: record.tenantId, userId, role: before.role },
      record.physicalId,
      { clientId: record.clientPhysicalId, contextSourceOnly: true },
    );
    if (
      actual?.attachmentId !== record.physicalId ||
      actual.clientId !== record.clientPhysicalId ||
      actual.contentHash !== want.hash ||
      actual.fileName !== want.fileName ||
      actual.contentType !== want.contentType
    )
      fail('DOCUMENT_FIXTURE_BYTES_MISMATCH', record);
    const after = await readRow(record, userId, want);
    if (
      !after.row ||
      before.role !== after.role ||
      sha256Stable(before.row) !== sha256Stable(after.row)
    )
      fail('DOCUMENT_FIXTURE_READ_CHANGED', record);
    assertRow(record, want, after.row, userId);
    return {
      physicalId: record.physicalId,
      tenantId: record.tenantId,
      owner: record.owner,
      ownership: record.ownership,
      payloadSha256: record.payloadSha256,
      rowVersion: after.row.row_version,
      contentSha256: actual.contentHash,
      lifecycleStatus: after.row.lifecycle_status,
      scanStatus: after.row.scan_status,
    };
  };
}
