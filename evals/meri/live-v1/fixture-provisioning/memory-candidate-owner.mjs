import { sha256Stable, stableJson } from '../lib/stable.mjs';
import {
  AUTHORIZED_TENANTS,
  FIXTURE_NAMESPACE,
  FixtureProvisioningError,
  ownedIdentity,
} from './contract.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function assertRecord(record) {
  const tenant = AUTHORIZED_TENANTS[record?.tenantKey];
  const marker = record?.ownership?.marker;
  if (
    !tenant ||
    tenant.id !== record.tenantId ||
    record.owner !== 'memory_candidate' ||
    !marker ||
    record.expectedPresence !== 'present'
  ) {
    throw new FixtureProvisioningError('MEMORY_CANDIDATE_FIXTURE_INVALID', record?.logicalId);
  }
  const identity = ownedIdentity(
    record.logicalId,
    record.tenantId,
    record.owner,
    marker.fixtureVersion,
  );
  if (
    identity.physicalId !== record.physicalId ||
    identity.markerSha256 !== record.ownership.markerSha256 ||
    stableJson(identity.marker) !== stableJson(marker) ||
    sha256Stable(record.payload) !== record.payloadSha256
  ) {
    throw new FixtureProvisioningError('MEMORY_CANDIDATE_FIXTURE_INVALID', record.logicalId);
  }
}

function proposalFor(record, actorId) {
  const facts = record.payload.facts;
  const scope =
    facts.scope === 'private' || facts.scope === 'user_private'
      ? 'user_private'
      : record.clientPhysicalId
        ? 'client'
        : 'firm';
  const text = facts.proposedText ?? facts.text ?? `Synthetic pending proposal ${record.logicalId}`;
  return {
    scope,
    ownerUserId: scope === 'user_private' ? actorId : null,
    clientId: scope === 'client' ? record.clientPhysicalId : null,
    key: `${FIXTURE_NAMESPACE}:${record.logicalId}`,
    value: text,
    source: 'meri_synthetic_fixture',
    sourceType: 'meri_synthetic_fixture',
    sourceId: record.ownership.markerSha256,
  };
}

function expectedStoredPayload(record, actorId, sourceExcerpt) {
  const proposal = proposalFor(record, actorId);
  return {
    key: proposal.key,
    value: proposal.value,
    source: proposal.source,
    scope: proposal.scope,
    ownerUserId: proposal.ownerUserId,
    clientId: proposal.clientId,
    expiresAt: null,
    confidence: null,
    sourceConversationId: null,
    sourceMessageId: null,
    sourceExcerpt,
    canonicalItem: null,
  };
}

/** Real MemoryCandidateService owner binding, without provider or embedding calls.
 * The existing model_extraction path remains pending for every scope.
 * PrismaService owns tenant transactions; all SQL below is read-only.
 */
export function createMemoryCandidateOwnerPort({
  memoryCandidates,
  prisma,
  actorForTenant,
  clientMemoryAllowed,
}) {
  if (
    typeof memoryCandidates?.proposeSaveMemory !== 'function' ||
    typeof prisma?.withTenantUser !== 'function' ||
    typeof actorForTenant !== 'function' ||
    typeof clientMemoryAllowed !== 'function'
  ) {
    throw new FixtureProvisioningError(
      'MEMORY_CANDIDATE_OWNER_INCOMPLETE',
      'MemoryCandidateService, PrismaService and tenant actor resolver are required',
    );
  }

  async function actor(record) {
    const userId = await actorForTenant(record.tenantId);
    if (!UUID.test(userId ?? '') || userId === record.tenantId) {
      throw new FixtureProvisioningError('MEMORY_CANDIDATE_ACTOR_UNAVAILABLE', record.logicalId);
    }
    return userId;
  }

  async function assertMembership(tx, record, userId) {
    const rows = await tx.$queryRawUnsafe(
      `SELECT tm.user_id::text AS id FROM tenant_memberships tm
       WHERE tm.tenant_id = $1::uuid AND tm.user_id = $2::uuid AND tm.status = 'active'`,
      record.tenantId,
      userId,
    );
    if (rows.length !== 1)
      throw new FixtureProvisioningError('MEMORY_CANDIDATE_ACTOR_NOT_MEMBER', record.logicalId);
    if (
      record.clientPhysicalId &&
      !(await clientMemoryAllowed(tx, record.tenantId, userId, record.clientPhysicalId))
    ) {
      throw new FixtureProvisioningError('MEMORY_CANDIDATE_CLIENT_NOT_ALLOWED', record.logicalId);
    }
  }

  return {
    async read(record) {
      // An absent fixture is still readable, but can never enter the create path.
      assertRecord({ ...record, expectedPresence: 'present' });
      const userId = await actor(record);
      return prisma.withTenantUser(record.tenantId, userId, async (tx) => {
        await assertMembership(tx, record, userId);
        const rows = await tx.$queryRawUnsafe(
          `SELECT mc.*, mc.id::text AS id, mc.tenant_id::text AS tenant_id,
                  mc.proposed_by::text AS proposed_by, mc.xmin::text AS row_version
           FROM memory_candidate mc WHERE mc.tenant_id = $1::uuid AND mc.id = $2::uuid`,
          record.tenantId,
          record.physicalId,
        );
        const row = rows[0];
        if (!row) return null;
        const excerpt = row.payload_jsonb?.sourceExcerpt;
        let metadata;
        try {
          metadata = JSON.parse(excerpt);
        } catch {
          metadata = null;
        }
        const ownership = metadata?.ownership;
        const payload = metadata?.payload;
        const expectedPayload = expectedStoredPayload(record, userId, excerpt);
        const matches =
          row.proposed_by === userId &&
          row.status === 'pending' &&
          row.governed_status === 'suggested' &&
          row.memory_class === 'legacy_unclassified' &&
          row.memory_authority === 'legacy_unclassified' &&
          row.instructions_allowed === false &&
          !row.approved_at &&
          !row.approved_by_user_id &&
          row.source_kind === 'model_extraction' &&
          row.source_type === 'meri_synthetic_fixture' &&
          row.source_id === record.ownership.markerSha256 &&
          row.scope ===
            (expectedPayload.scope === 'user_private' ? 'personal' : expectedPayload.scope) &&
          (row.client_id ?? null) === expectedPayload.clientId &&
          !row.committed_memory_id &&
          !row.committed_memory_item_id &&
          !row.decided_at &&
          row.provenance_jsonb?.userId === userId &&
          row.provenance_jsonb?.tenantId === record.tenantId &&
          row.provenance_jsonb?.sourceExcerpt === excerpt &&
          sha256Stable(row.payload_jsonb) === sha256Stable(expectedPayload) &&
          payload &&
          sha256Stable(payload) === record.payloadSha256;
        return {
          physicalId: row.id,
          tenantId: row.tenant_id,
          owner: 'memory_candidate',
          ownership,
          // Never echo the desired hash when canonical content or lifecycle differs.
          payloadSha256: matches ? sha256Stable(payload) : null,
          rowVersion: row.row_version,
        };
      });
    },
    async create(record, guards) {
      assertRecord(record);
      if (
        guards?.tenantId !== record.tenantId ||
        guards?.physicalId !== record.physicalId ||
        guards?.expectedOwnershipMarkerSha256 !== record.ownership.markerSha256 ||
        guards?.expectedRowVersion !== null
      ) {
        throw new FixtureProvisioningError('WRITE_GUARD_MISMATCH', record.logicalId);
      }
      const userId = await actor(record);
      const sourceExcerpt = stableJson({ ownership: record.ownership, payload: record.payload });
      if (sourceExcerpt.length > 4000)
        throw new FixtureProvisioningError(
          'MEMORY_CANDIDATE_PROVENANCE_TOO_LARGE',
          record.logicalId,
        );
      await prisma.withTenantUser(record.tenantId, userId, (tx) =>
        assertMembership(tx, record, userId),
      );
      const result = await memoryCandidates.proposeSaveMemory(
        record.tenantId,
        userId,
        { ...proposalFor(record, userId), sourceExcerpt },
        false,
        'model_extraction',
        record.physicalId,
      );
      if (
        result?.candidateId !== record.physicalId ||
        result.status !== 'pending' ||
        result.memoryId !== null
      ) {
        const error = new FixtureProvisioningError(
          'MEMORY_CANDIDATE_OUTCOME_UNKNOWN',
          record.logicalId,
        );
        error.unknownCommit = true;
        throw error;
      }
      return result;
    },
    async replace() {
      throw new FixtureProvisioningError(
        'MEMORY_CANDIDATE_REPLACE_REFUSED',
        'Candidate content must use the governed revision lifecycle',
      );
    },
    async delete() {
      throw new FixtureProvisioningError(
        'MEMORY_CANDIDATE_DELETE_REFUSED',
        'Candidate erasure must use the governed lifecycle',
      );
    },
  };
}
