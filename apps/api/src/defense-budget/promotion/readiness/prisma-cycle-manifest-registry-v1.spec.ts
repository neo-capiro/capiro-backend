/**
 * Phase 10B-2D -- dedicated real-adapter spec for
 * `PrismaCycleManifestRegistryV1`.
 *
 * Table-routed fake Prisma idiom (see `phase10b2-repair-findings.md` §5).
 * Proves:
 *   - `register` computes the content SHA itself (never trusts a
 *     caller-supplied hash) and is idempotent by (cycleId, hash) via
 *     ON CONFLICT DO NOTHING;
 *   - `loadManifestForIdentity` fails closed on a fiscal-year mismatch
 *     rather than reusing a wrong-year manifest;
 *   - the family-scoped document filter and required-key derivation match
 *     the manifest's own per-document declarations, never a hand-maintained
 *     list;
 *   - no row -> null, never a fabricated empty manifest.
 */
import * as fs from 'node:fs';
import { PrismaCycleManifestRegistryV1 } from './prisma-cycle-manifest-registry-v1.js';
import type { ManifestRegistryPrismaLikeV1 } from './prisma-cycle-manifest-registry-v1.js';
import type { CycleFamilyReadinessIdentityV1 } from './cycle-family-readiness-v1.js';
import {
  parseBudgetCycleManifestV1,
  type BudgetCycleManifestV1,
} from '../../contracts/budget-cycle-manifest-v1.js';
import { sha256Bytes } from '../../contracts/canonical-json.js';

const SHA = 'a'.repeat(64);

function identity(
  familyGroup: CycleFamilyReadinessIdentityV1['familyGroup'],
  fiscalYear = 2027,
): CycleFamilyReadinessIdentityV1 {
  return { fiscalYear, authorityTrack: 'authorization', familyGroup };
}

function omManifest(fiscalYear = 2027): BudgetCycleManifestV1 {
  return {
    schemaVersion: 'defense_budget_cycle_manifest_v1',
    cycleId: `cycle-fy${fiscalYear}-authorization`,
    fiscalYear,
    domain: 'defense',
    documents: [
      {
        documentKey: 'o1',
        required: true,
        title: 'O-1',
        sourceLocator: 'fixture://o1.pdf',
        family: 'om',
        exhibit: 'O-1',
        authority: 'dod-comptroller',
        component: 'ARMY',
        budgetCycle: 'pb',
        documentType: 'om_exhibit',
        parserPolicy: 'native_structured',
        requiredDataCategories: ['identity', 'funding'],
        requiredFundingFields: ['request'],
        expectedLineKinds: ['OM_SAG'],
        allowEmpty: false,
      },
      {
        documentKey: 'op5',
        required: true,
        title: 'OP-5',
        sourceLocator: 'fixture://op5.pdf',
        family: 'om',
        exhibit: 'OP-5',
        authority: 'dod-comptroller',
        component: 'ARMY',
        budgetCycle: 'pb',
        documentType: 'om_exhibit',
        parserPolicy: 'native_structured',
        requiredDataCategories: ['identity', 'funding', 'narrative'],
        requiredFundingFields: ['request'],
        expectedLineKinds: ['OM_SAG'],
        allowEmpty: false,
        requiredNarrativeSections: ['mission'],
        requiredQuantityCategories: ['workload'],
      },
      {
        documentKey: 'p1',
        required: true,
        title: 'P-1',
        sourceLocator: 'fixture://p1.pdf',
        family: 'procurement',
        exhibit: 'P-1',
        authority: 'dod-comptroller',
        component: 'ARMY',
        budgetCycle: 'pb',
        documentType: 'procurement_exhibit',
        parserPolicy: 'native_structured',
        requiredDataCategories: ['identity', 'funding'],
        requiredFundingFields: ['request'],
        expectedLineKinds: ['PROCUREMENT_BLIN'],
        allowEmpty: false,
      },
    ],
    metadata: {
      omRequiredIdentityKeys: ['OM_SAG:ARMY:O&M, ARMY:SAG1'],
    },
  } as unknown as BudgetCycleManifestV1;
}

/** Table-routed fake over defense_budget_cycle_manifest_registry only. */
class FakeManifestRegistryPrisma implements ManifestRegistryPrismaLikeV1 {
  public readonly queries: Array<{ query: string; values: unknown[] }> = [];
  public readonly executed: Array<{ query: string; values: unknown[] }> = [];
  public rows: Array<Record<string, unknown>> = [];

  async $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T> {
    this.queries.push({ query, values });
    if (query.includes('FROM "defense_budget_cycle_manifest_registry"')) {
      return this.rows as unknown as T;
    }
    throw new Error(`unexpected query in fake: ${query}`);
  }

  async $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> {
    this.executed.push({ query, values });
    if (query.includes('INSERT INTO "defense_budget_cycle_manifest_registry"')) {
      const [cycleId, manifestContentSha256, fiscalYear, manifestJson] = values as [
        string,
        string,
        number,
        string,
      ];
      const exists = this.rows.some(
        (row) => row.cycleId === cycleId && row.manifestContentSha256 === manifestContentSha256,
      );
      if (!exists) {
        this.rows.push({
          cycleId,
          manifestContentSha256,
          fiscalYear,
          manifestDocument: JSON.parse(manifestJson),
          registeredAt: new Date(this.rows.length).toISOString(),
        });
      }
      return exists ? 0 : 1;
    }
    throw new Error(`unexpected executeRawUnsafe in fake: ${query}`);
  }
}

describe('PrismaCycleManifestRegistryV1 — register', () => {
  it('computes the content SHA itself from the exact bytes given, never trusting a caller-supplied hash', async () => {
    const prisma = new FakeManifestRegistryPrisma();
    const registry = new PrismaCycleManifestRegistryV1(prisma);
    const manifest = omManifest();

    const { manifestContentSha256 } = await registry.register('cycle-fy2027-authorization', manifest);

    const parsed = parseBudgetCycleManifestV1(manifest);
    const expectedSha = sha256Bytes(Buffer.from(JSON.stringify(parsed), 'utf8'));
    expect(manifestContentSha256).toBe(expectedSha);
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0]?.manifestContentSha256).toBe(expectedSha);
  });

  it('is idempotent by (cycleId, manifestContentSha256): re-registering the identical manifest is a no-op, never a duplicate row', async () => {
    const prisma = new FakeManifestRegistryPrisma();
    const registry = new PrismaCycleManifestRegistryV1(prisma);
    const manifest = omManifest();

    const first = await registry.register('cycle-fy2027-authorization', manifest);
    const second = await registry.register('cycle-fy2027-authorization', manifest);

    expect(first.manifestContentSha256).toBe(second.manifestContentSha256);
    expect(prisma.rows).toHaveLength(1);
  });

  it('a manifest with different content registers as a SEPARATE row under the same cycleId', async () => {
    const prisma = new FakeManifestRegistryPrisma();
    const registry = new PrismaCycleManifestRegistryV1(prisma);
    const manifestV1 = omManifest();
    const manifestV2 = { ...manifestV1, documents: [...manifestV1.documents, { ...manifestV1.documents[0]!, documentKey: 'o1-extra' }] };

    const first = await registry.register('cycle-fy2027-authorization', manifestV1);
    const second = await registry.register('cycle-fy2027-authorization', manifestV2 as BudgetCycleManifestV1);

    expect(first.manifestContentSha256).not.toBe(second.manifestContentSha256);
    expect(prisma.rows).toHaveLength(2);
  });
});

describe('PrismaCycleManifestRegistryV1 — loadManifestForIdentity', () => {
  it('returns null when no row exists for the cycle (never a fabricated empty manifest)', async () => {
    const prisma = new FakeManifestRegistryPrisma();
    const registry = new PrismaCycleManifestRegistryV1(prisma);
    const result = await registry.loadManifestForIdentity(identity('om'), 'cycle-fy2027-authorization');
    expect(result).toBeNull();
  });

  it('fails closed on a fiscal-year mismatch rather than reusing a wrong-year manifest', async () => {
    const prisma = new FakeManifestRegistryPrisma();
    const registry = new PrismaCycleManifestRegistryV1(prisma);
    await registry.register('cycle-fy2027-authorization', omManifest(2027));

    const result = await registry.loadManifestForIdentity(
      identity('om', 2029), // requested FY does not match the registered manifest's FY
      'cycle-fy2027-authorization',
    );
    expect(result).toBeNull();
  });

  it('filters documents to the requested family group only, and derives requiredIdentityKeys from the manifest metadata (not a hand-maintained list)', async () => {
    const prisma = new FakeManifestRegistryPrisma();
    const registry = new PrismaCycleManifestRegistryV1(prisma);
    await registry.register('cycle-fy2027-authorization', omManifest());

    const result = await registry.loadManifestForIdentity(identity('om'), 'cycle-fy2027-authorization');

    expect(result).not.toBeNull();
    expect(result!.documents.map((d) => d.documentKey).sort()).toEqual(['o1', 'op5']);
    expect(result!.documents.some((d) => d.family === 'procurement')).toBe(false);
    expect(result!.requiredIdentityKeys).toEqual(['OM_SAG:ARMY:O&M, ARMY:SAG1']);
    expect(result!.requiredNarrativeSections).toEqual(['mission']);
    expect(result!.requiredQuantityCategories).toEqual(['workload']);
  });

  it('filters documents to the procurement family group and returns empty required-narrative/quantity arrays when the manifest declares none', async () => {
    const prisma = new FakeManifestRegistryPrisma();
    const registry = new PrismaCycleManifestRegistryV1(prisma);
    await registry.register('cycle-fy2027-authorization', omManifest());

    const result = await registry.loadManifestForIdentity(identity('procurement'), 'cycle-fy2027-authorization');

    expect(result).not.toBeNull();
    expect(result!.documents.map((d) => d.documentKey)).toEqual(['p1']);
    expect(result!.requiredIdentityKeys).toEqual([]); // no procurementRequiredIdentityKeys in this fixture's metadata
    expect(result!.requiredNarrativeSections).toEqual([]);
  });

  it('loads the MOST RECENTLY registered manifest for a cycle when multiple rows exist', async () => {
    const prisma = new FakeManifestRegistryPrisma();
    const registry = new PrismaCycleManifestRegistryV1(prisma);
    const manifestV1 = omManifest();
    const manifestV2 = {
      ...manifestV1,
      documents: manifestV1.documents.filter((d) => d.documentKey !== 'p1'),
    } as BudgetCycleManifestV1;

    await registry.register('cycle-fy2027-authorization', manifestV1);
    await registry.register('cycle-fy2027-authorization', manifestV2);
    await registry.loadManifestForIdentity(identity('om'), 'cycle-fy2027-authorization');

    // The fake's ORDER BY registered_at DESC is real SQL in production; the
    // fake itself returns rows unconditionally by table, so this test
    // instead proves the ADAPTER issues an ORDER BY + LIMIT 1 clause that
    // the real database would honor.
    const query = prisma.queries.find((q) => q.query.includes('defense_budget_cycle_manifest_registry'));
    expect(query?.query).toContain('ORDER BY "registered_at" DESC');
    expect(query?.query).toContain('LIMIT 1');
  });
});

describe('PrismaCycleManifestRegistryV1 — authorization boundary', () => {
  it('[authorization boundary] the adapter file (outside doc comments) never references PROMOTER_DATABASE_URL, DefenseBudgetCanonicalPromotionServiceV1, or DefenseBudgetPromotionAuthorizationServiceV1', () => {
    const source: string = fs.readFileSync(
      require.resolve('./prisma-cycle-manifest-registry-v1.ts'),
      'utf8',
    );
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const term of [
      'PROMOTER_DATABASE_URL',
      'DefenseBudgetCanonicalPromotionServiceV1',
      'DefenseBudgetPromotionAuthorizationServiceV1',
    ]) {
      expect(withoutComments).not.toContain(term);
    }
  });
});
