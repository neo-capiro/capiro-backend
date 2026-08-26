/**
 * Phase 10B-2D -- durable manifest registry repository.
 *
 * Thin wrapper over `defense_budget_cycle_manifest_registry` (see the
 * schema's own doc comment for why this table exists -- the smallest
 * governed persistence change identified by the Phase A audit). Write-once,
 * content-addressed by (cycleId, manifestContentSha256): a manifest is
 * immutable once filed under its hash, so a second registration attempt for
 * the identical hash is `ON CONFLICT DO NOTHING`, never an overwrite.
 */
import {
  parseBudgetCycleManifestV1,
  type BudgetCycleManifestV1,
} from '../../contracts/budget-cycle-manifest-v1.js';
import { sha256Bytes } from '../../contracts/canonical-json.js';
import type { ManifestForMaterializationPortV1 } from './materializing-family-reconciliation-certification-v1.js';
import type { CycleFamilyReadinessIdentityV1 } from './cycle-family-readiness-v1.js';
import type { MaterializationManifestInputV1 } from './family-certification-materialization-v1.js';

export interface ManifestRegistryPrismaLikeV1 {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

interface ManifestRegistryRowV1 {
  manifestContentSha256: string;
  fiscalYear: number;
  manifestDocument: unknown;
}

export class PrismaCycleManifestRegistryV1 implements ManifestForMaterializationPortV1 {
  constructor(private readonly prisma: ManifestRegistryPrismaLikeV1) {}

  /**
   * Register a governed manifest under its own content SHA. Idempotent by
   * (cycleId, manifestContentSha256) -- re-registering the identical
   * manifest for the identical cycle is a no-op, and this method never
   * accepts a caller-supplied hash: it always recomputes from the exact
   * bytes it is given, so storage cannot be tricked into filing a manifest
   * under the wrong identity.
   */
  async register(cycleId: string, manifest: BudgetCycleManifestV1): Promise<{ manifestContentSha256: string }> {
    const parsed = parseBudgetCycleManifestV1(manifest);
    const manifestContentSha256 = sha256Bytes(Buffer.from(JSON.stringify(parsed), 'utf8'));
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO "defense_budget_cycle_manifest_registry"
         ("cycle_id", "manifest_content_sha256", "fiscal_year", "manifest_document_jsonb")
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT ("cycle_id", "manifest_content_sha256") DO NOTHING`,
      cycleId,
      manifestContentSha256,
      parsed.fiscalYear,
      JSON.stringify(parsed),
    );
    return { manifestContentSha256 };
  }

  /**
   * Loads the most recently registered manifest for a cycle and derives the
   * `MaterializationManifestInputV1` shape the materialization boundary
   * needs -- `requiredIdentityKeys`/`requiredNarrativeSections`/etc. are
   * assembled from the manifest's own per-document declarations (never a
   * separate hand-maintained list), matching the same derivation
   * `scripts/certify-defense-budget-non-rdte.ts`'s `requiredIdentityKeys()`
   * helper already performs from manifest metadata.
   */
  async loadManifestForIdentity(
    identity: CycleFamilyReadinessIdentityV1,
    cycleId: string,
  ): Promise<MaterializationManifestInputV1 | null> {
    const rows = await this.prisma.$queryRawUnsafe<ManifestRegistryRowV1[]>(
      `SELECT "manifest_content_sha256" AS "manifestContentSha256",
              "fiscal_year" AS "fiscalYear",
              "manifest_document_jsonb" AS "manifestDocument"
         FROM "defense_budget_cycle_manifest_registry"
        WHERE "cycle_id" = $1
        ORDER BY "registered_at" DESC
        LIMIT 1`,
      cycleId,
    );
    const row = rows[0];
    if (row == null) return null;
    if (row.fiscalYear !== identity.fiscalYear) {
      // A manifest registered under a different fiscal year cannot satisfy
      // this readiness identity's scope -- fail closed rather than reusing a
      // mismatched manifest.
      return null;
    }
    const manifest = parseBudgetCycleManifestV1(row.manifestDocument);
    const familyDocuments = manifest.documents.filter(
      (document) => document.family === identity.familyGroup,
    );
    const requiredIdentityKeysMetadata = manifest.metadata?.[`${identity.familyGroup}RequiredIdentityKeys`];
    const requiredIdentityKeys = Array.isArray(requiredIdentityKeysMetadata)
      ? requiredIdentityKeysMetadata.filter((value): value is string => typeof value === 'string')
      : [];
    const requiredNarrativeSections = [
      ...new Set(familyDocuments.flatMap((document) => document.requiredNarrativeSections ?? [])),
    ];
    const requiredQuantityCategories = [
      ...new Set(familyDocuments.flatMap((document) => document.requiredQuantityCategories ?? [])),
    ];
    const requiredUnitCostCategories = [
      ...new Set(familyDocuments.flatMap((document) => document.requiredUnitCostCategories ?? [])),
    ];
    return {
      manifestContentSha256: row.manifestContentSha256,
      documents: familyDocuments,
      requiredIdentityKeys,
      requiredNarrativeSections,
      requiredQuantityCategories,
      requiredUnitCostCategories,
    };
  }
}
