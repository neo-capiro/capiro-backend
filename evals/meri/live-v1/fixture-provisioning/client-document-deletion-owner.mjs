import { sha256Stable } from '../lib/stable.mjs';
import {
  AUTHORIZED_TENANTS,
  FIXTURE_NAMESPACE,
  FixtureProvisioningError,
  ownedIdentity,
} from './contract.mjs';

/** Reset-only bridge: canonical services own mutation, storage access and proof. */
export function createClientDocumentDeletionPort({ prisma, documentWriter, actorForTenant }) {
  if (
    typeof prisma?.withTenantUser !== 'function' ||
    typeof actorForTenant !== 'function' ||
    typeof documentWriter?.deleteSyntheticFixtureAttachment !== 'function' ||
    typeof documentWriter?.inspectSyntheticFixtureAttachmentDeletion !== 'function'
  )
    throw new FixtureProvisioningError(
      'DOCUMENT_DELETION_OWNER_INCOMPLETE',
      'guarded owner and current membership resolver required',
    );
  const fail = (code, record) => {
    throw new FixtureProvisioningError(code, record?.logicalId);
  };
  async function input(record, guards) {
    const tenant = AUTHORIZED_TENANTS[record?.tenantKey];
    const marker = record?.ownership?.marker;
    if (
      process.env.MERI_SYNTHETIC_FIXTURE_NAMESPACE !== FIXTURE_NAMESPACE ||
      !tenant ||
      tenant.id !== record.tenantId ||
      record.owner !== 'engagement_attachment' ||
      !marker ||
      guards?.tenantId !== record.tenantId ||
      guards?.physicalId !== record.physicalId ||
      guards?.expectedOwnershipMarkerSha256 !== record.ownership.markerSha256 ||
      !/^[0-9]{1,10}$/u.test(guards?.expectedRowVersion ?? '') ||
      typeof guards?.expectedStorageBucket !== 'string' ||
      !guards.expectedStorageBucket ||
      sha256Stable(record.payload) !== record.payloadSha256
    )
      fail('DOCUMENT_DELETION_IDENTITY_INVALID', record);
    const owned = ownedIdentity(
      record.logicalId,
      record.tenantId,
      record.owner,
      marker.fixtureVersion,
      marker.fixtureInstanceId,
    );
    if (
      sha256Stable(marker) !== owned.markerSha256 ||
      record.ownership.markerSha256 !== owned.markerSha256 ||
      record.ownership.physicalId !== record.physicalId
    )
      fail('DOCUMENT_DELETION_IDENTITY_INVALID', record);
    const userId = await actorForTenant(record.tenantId);
    if (userId !== record.uploaderActorId || !/^[0-9a-f-]{36}$/u.test(userId ?? ''))
      fail('DOCUMENT_DELETION_ACTOR_INVALID', record);
    const memberships = await prisma.withTenantUser(record.tenantId, userId, (tx) =>
      tx.$queryRawUnsafe(
        `SELECT role FROM tenant_memberships WHERE tenant_id=$1::uuid AND user_id=$2::uuid AND status='active'`,
        record.tenantId,
        userId,
      ),
    );
    if (
      memberships.length !== 1 ||
      !['standard_user', 'user_admin', 'capiro_admin'].includes(memberships[0].role)
    )
      fail('DOCUMENT_DELETION_ACTOR_UNAVAILABLE', record);
    const asset = record.payload.sourceAsset;
    const facts = record.payload.facts;
    return {
      ctx: { tenantId: record.tenantId, userId, role: memberships[0].role },
      guard: {
        expectedRowVersion: String(guards.expectedRowVersion),
        expectedBucket: guards.expectedStorageBucket,
        fixtureVersion: marker.fixtureVersion,
        fixtureInstanceId: marker.fixtureInstanceId,
        logicalId: record.logicalId,
        clientId: record.clientPhysicalId,
        fileName: asset?.fileName ?? `${record.logicalId}.txt`,
        contentType: asset?.mediaType ?? 'text/plain',
        byteSize:
          asset?.byteSize ??
          (typeof facts?.utf8Bytes === 'string' ? Buffer.byteLength(facts.utf8Bytes) : null),
        contentSha256: asset?.byteSha256 ?? facts?.byteSha256,
        sourceVersion: Number.parseInt(String(asset?.version ?? '1').replace(/\D/gu, ''), 10) || 1,
      },
    };
  }
  return {
    async readForReset(record, guards) {
      const { ctx, guard } = await input(record, guards);
      const proof = await documentWriter.inspectSyntheticFixtureAttachmentDeletion(
        ctx,
        record.physicalId,
        guard,
      );
      if (
        proof?.state === 'absent' &&
        proof.currentObjectAbsent === true &&
        proof.indexedChunksAbsent === true
      )
        return null;
      if (!['present', 'pending'].includes(proof?.state) || !proof.rowVersion)
        fail('DOCUMENT_DELETION_READBACK_INVALID', record);
      return {
        physicalId: record.physicalId,
        tenantId: record.tenantId,
        owner: record.owner,
        ownership: record.ownership,
        payloadSha256: record.payloadSha256,
        rowVersion: proof.rowVersion,
        deletionState: proof.state,
        deletionOriginalRowVersion: proof.originalRowVersion,
      };
    },
    async delete(record, guards) {
      const { ctx, guard } = await input(record, guards);
      return documentWriter.deleteSyntheticFixtureAttachment(ctx, record.physicalId, guard);
    },
  };
}
