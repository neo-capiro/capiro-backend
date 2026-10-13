import type { ResourceScopeTransaction } from './client-memory-wall.js';
import type { ProspectResourceScope } from './prospect-resource-scope.js';
import { tenantFeatureEnabled } from './tenant-feature.js';

export interface ProspectBriefVersionIdentity {
  kind: 'core_prospect_brief_version';
  prospectId: string;
  briefId: string;
  versionId: string;
  versionNumber: number;
  sectionsHash: string;
  snapshotHash: string;
}

export class ProspectBriefSourceUnavailable extends Error {}
export const MAX_PROSPECT_BRIEF_COPIES = 20;

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;

export function prospectBriefVersionIdentity(value: unknown): ProspectBriefVersionIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProspectBriefSourceUnavailable();
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join() !==
      'briefId,kind,prospectId,sectionsHash,snapshotHash,versionId,versionNumber' ||
    v.kind !== 'core_prospect_brief_version' ||
    !['prospectId', 'briefId', 'versionId'].every(
      (k) => typeof v[k] === 'string' && uuid.test(v[k] as string),
    ) ||
    !['sectionsHash', 'snapshotHash'].every(
      (k) => typeof v[k] === 'string' && hash.test(v[k] as string),
    ) ||
    !Number.isInteger(v.versionNumber) ||
    (v.versionNumber as number) < 1 ||
    (v.versionNumber as number) > 100
  )
    throw new ProspectBriefSourceUnavailable();
  return v as unknown as ProspectBriefVersionIdentity;
}

/** Core's brief flag is additive to the prospect membership/client wall. */
export async function requireProspectBriefFeatureInTx(
  tx: ResourceScopeTransaction,
  scope: ProspectResourceScope,
) {
  const [tenant] = await tx.$queryRawUnsafe<Array<{ settings: unknown }>>(
    `SELECT settings_jsonb AS settings FROM tenants WHERE id=$1::uuid
     AND status::text='active' FOR SHARE`,
    scope.tenantId,
  );
  if (!tenant || !tenantFeatureEnabled(tenant.settings, 'businessDevelopment.brief.enabled', false))
    throw new ProspectBriefSourceUnavailable();
}

/** Core-owned saved-version seam. Caller obtains CURRENT prospectResourceScope
 * in this same tenant transaction; its identity/grant locks remain held through
 * the Workspace command. Historical selection never follows current_version_id.
 * This seam reads existing Core rows only; no Core ORM is added to Workspace. */
export async function prospectBriefSourceWithinTx(
  tx: ResourceScopeTransaction,
  scope: ProspectResourceScope,
  identity: ProspectBriefVersionIdentity,
) {
  const source = prospectBriefVersionIdentity(identity);
  if (source.prospectId !== scope.prospectId) throw new ProspectBriefSourceUnavailable();
  await requireProspectBriefFeatureInTx(tx, scope);
  const [row] = await tx.$queryRawUnsafe<
    Array<{
      sections: unknown;
      citations: unknown;
      sourceSnapshot: unknown;
      sectionsHash: string;
      snapshotHash: string;
    }>
  >(
    `SELECT v.sections,v.citations,v.source_snapshot AS "sourceSnapshot",
       v.sections_hash AS "sectionsHash",v.snapshot_hash AS "snapshotHash"
     FROM business_development_briefs b JOIN business_development_brief_versions v
       ON v.tenant_id=b.tenant_id AND v.brief_id=b.id
     WHERE b.tenant_id=$1::uuid AND b.prospect_id=$2::uuid AND b.id=$3::uuid
       AND v.id=$4::uuid AND v.version_number=$5
     FOR SHARE OF b,v`,
    scope.tenantId,
    source.prospectId,
    source.briefId,
    source.versionId,
    source.versionNumber,
  );
  if (!row || row.sectionsHash !== source.sectionsHash || row.snapshotHash !== source.snapshotHash)
    throw new ProspectBriefSourceUnavailable();
  return { source, ...row };
}
