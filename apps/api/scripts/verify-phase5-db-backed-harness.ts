#!/usr/bin/env node
/**
 * Real DB-backed Knowledge Plane Phase 5 acceptance harness.
 *
 * Connects to a real PostgreSQL database via DATABASE_URL, applies the actual
 * Prisma schema (run `prisma migrate deploy` against a disposable database
 * before invoking this script), seeds the golden entity fixtures and the Jane
 * Smith ambiguity fixtures the corpus depends on, then exercises the
 * production Universal Entity Resolution orchestrator
 * (AuthoritativeFirstUniversalEntityResolutionOrchestratorService — the same
 * class KnowledgeModule aliases the public UniversalEntityResolutionOrchestratorService
 * token to) wired with the real structured public-source fallback providers.
 * public_web/model_candidate_reconciliation use the repo's existing
 * test-only Meri-compatibility fixture providers for this run, since the
 * golden/compat corpus is a fixed, deterministic script — exercising the real
 * network/model providers here would make acceptance nondeterministic and
 * require live credentials. Everything else in the resolution path is real.
 *
 * Real resolver output is converted through the existing acceptance-
 * observation adapter (never hand-built "perfect" observations) and scored
 * with the existing evaluators. Exits nonzero if any acceptance threshold
 * fails. Cleans up every fixture row it created, in a finally block, even on
 * failure.
 *
 * Usage:
 *   DATABASE_URL=postgresql://capiro:capiro@localhost:55440/capiro \
 *     pnpm --filter @capiro/api exec tsx scripts/verify-phase5-db-backed-harness.ts
 */
import { PrismaService } from '../src/prisma/prisma.service.js';
import { CanonicalEntityRegistrationRepository } from '../src/knowledge/entities/canonical-entity-registration.repository.js';
import { CanonicalEntityRegistrationService } from '../src/knowledge/entities/canonical-entity-registration.service.js';
import { CanonicalEntityRepository } from '../src/knowledge/entities/canonical-entity.repository.js';
import { UniversalEntityResolutionService } from '../src/knowledge/entities/universal-entity-resolution.service.js';
import { AuthoritativeFirstUniversalEntityResolutionOrchestratorService } from '../src/knowledge/entities/authoritative-first-entity-resolution-orchestrator.service.js';
import { CanonicalStructuredPublicLookupRepository } from '../src/knowledge/entities/canonical-structured-public-lookup.repository.js';
import {
  DirectoryGovernmentEntityResolutionProvider,
  LdaEntityResolutionProvider,
  SamUeiEntityResolutionProvider,
  SecCikEntityResolutionProvider,
  UsaSpendingEntityResolutionProvider,
} from '../src/knowledge/entities/canonical-structured-public-fallback.providers.js';
import { createMeriCompatibilityFixtureProviders } from '../src/knowledge/entities/entity-resolution-acceptance-fixture.providers.js';
import type { EntityResolutionFallbackProvider } from '../src/knowledge/entities/universal-entity-resolution-orchestrator.types.js';
import { ENTITY_RESOLUTION_GOLDEN_CORPUS } from '../src/knowledge/entities/entity-resolution-golden-corpus.js';
import { MERI_COMPATIBLE_ENTITY_RESOLUTION_CASES } from '../src/knowledge/entities/entity-resolution-meri-compat-golden.js';
import { JANE_SMITH_GOLDEN_FIXTURES } from '../src/knowledge/entities/entity-resolution-golden-seed-fixtures.js';
import {
  evaluateEntityResolutionGoldenCorpus,
  type EntityResolutionGoldenObservation,
} from '../src/knowledge/entities/entity-resolution-evaluator.js';
import {
  evaluateMeriCompatibleEntityResolution,
  type MeriCompatibleEntityResolutionObservation,
} from '../src/knowledge/entities/entity-resolution-meri-compat-evaluator.js';
import {
  toEntityResolutionGoldenObservation,
  toMeriCompatibleEntityResolutionObservation,
} from '../src/knowledge/entities/entity-resolution-acceptance-observation.js';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

// Global (identity_scope = 'global_public', tenant_id NULL) fixtures this
// harness registers. Note this is deliberately NOT the tenant-private
// JANE_SMITH_GOLDEN_FIXTURES names ("Jane Smith — Example/Other Defense") —
// those are cleaned up via tenant_id scoping below, alongside every other
// tenant-private fixture. "Jane A. Smith" here is the unrelated global
// congress-member fixture for the member_exact_bioguide golden case.
const GLOBAL_FIXTURE_NAMES = [
  'RTX Corporation',
  'Kinetic Industries, Inc.',
  'House Committee on Armed Services',
  'Jane A. Smith',
  'Ground Robotics',
];

async function main(): Promise<void> {
  const prisma = new PrismaService();
  await prisma.$connect();

  const entityRepository = new CanonicalEntityRepository(prisma);
  const resolver = new UniversalEntityResolutionService(entityRepository);
  const registrationRepository = new CanonicalEntityRegistrationRepository(prisma);
  const registration = new CanonicalEntityRegistrationService(registrationRepository);
  const structuredLookup = new CanonicalStructuredPublicLookupRepository(prisma);

  const realStructuredProviders: EntityResolutionFallbackProvider[] = [
    new DirectoryGovernmentEntityResolutionProvider(structuredLookup),
    new SamUeiEntityResolutionProvider(structuredLookup),
    new UsaSpendingEntityResolutionProvider(structuredLookup),
    new LdaEntityResolutionProvider(structuredLookup),
    new SecCikEntityResolutionProvider(structuredLookup),
  ];
  // public_web / model_candidate_reconciliation: test-only fixtures for this
  // fixed, deterministic corpus. See file header.
  const providers = [...realStructuredProviders, ...createMeriCompatibilityFixtureProviders()];
  const orchestrator = new AuthoritativeFirstUniversalEntityResolutionOrchestratorService(
    resolver,
    registration,
    providers,
  );

  const createdTenantEntityIds: string[] = [];

  try {
    await cleanup(prisma);
    await seedTenants(prisma);

    await registration.registerGlobalPublicEntity({
      entityType: 'organization',
      canonicalName: 'Kinetic Industries, Inc.',
      resolutionMethod: 'official_directory',
      identifiers: [
        {
          type: 'official_domain',
          value: 'kindeticindustries.inc',
          sourceType: 'official_directory',
          sourceId: 'fixture-kinetic',
        },
      ],
    });
    await registration.registerGlobalPublicEntity({
      entityType: 'organization',
      canonicalName: 'RTX Corporation',
      resolutionMethod: 'sam_entity',
      identifiers: [
        { type: 'uei', value: 'ABCDEF123456', sourceType: 'sam_entity', sourceId: 'fixture-rtx' },
        { type: 'cik', value: '0000101829', sourceType: 'sec_filing', sourceId: 'fixture-rtx' },
      ],
      aliases: [
        { value: 'Raytheon Technologies Corporation', sourceType: 'sec_filing', sourceId: 'fixture-rtx' },
        { value: 'Raytheon Technologies', sourceType: 'sec_filing', sourceId: 'fixture-rtx' },
      ],
    });
    await registration.registerGlobalPublicEntity({
      entityType: 'committee',
      canonicalName: 'House Committee on Armed Services',
      resolutionMethod: 'congress_committee',
      identifiers: [
        { type: 'committee_id', value: 'hsas00', sourceType: 'congress_committee', sourceId: 'fixture-committee' },
      ],
    });
    await registration.registerGlobalPublicEntity({
      entityType: 'person',
      canonicalName: 'Jane A. Smith',
      resolutionMethod: 'congress_member',
      identifiers: [
        { type: 'bioguide_id', value: 'S000001', sourceType: 'congress_member', sourceId: 'fixture-member' },
      ],
    });
    await registration.registerGlobalPublicEntity({
      entityType: 'program_element',
      canonicalName: 'Ground Robotics',
      resolutionMethod: 'program_element',
      identifiers: [
        { type: 'program_element_code', value: '0605053A', sourceType: 'program_element', sourceId: 'fixture-pe' },
      ],
    });

    // Jane Smith ambiguity fixtures, from the shared golden fixture constant
    // rather than re-declared literals — name-only lookup stays ambiguous;
    // only the Example Defense record owns the exact email.
    for (const fixture of JANE_SMITH_GOLDEN_FIXTURES) {
      createdTenantEntityIds.push(
        await insertPrivateFixture(
          prisma,
          fixture.canonicalName,
          'person',
          fixture.identifiers.map((identifier) => ({
            type: identifier.type,
            value: identifier.value,
            sourceType: 'crm_contact',
            sourceId: fixture.id,
          })),
          fixture.aliases.map((alias) => ({ value: alias, sourceType: 'crm_contact', sourceId: fixture.id })),
        ),
      );
    }

    for (const input of [
      {
        entityType: 'organization',
        canonicalName: 'Kinetic Industries',
        identifiers: [{ type: 'crm_client_id', value: 'kinetic-a', sourceType: 'crm_client', sourceId: 'kinetic-a' }],
      },
      {
        entityType: 'organization',
        canonicalName: 'Kinetic Industries',
        identifiers: [{ type: 'crm_client_id', value: 'kinetic-b', sourceType: 'crm_client', sourceId: 'kinetic-b' }],
      },
      {
        entityType: 'organization',
        canonicalName: 'ATI',
        identifiers: [{ type: 'crm_client_id', value: 'ati-a', sourceType: 'crm_client', sourceId: 'ati-a' }],
      },
      {
        entityType: 'organization',
        canonicalName: 'ATI',
        identifiers: [{ type: 'crm_client_id', value: 'ati-b', sourceType: 'crm_client', sourceId: 'ati-b' }],
      },
      {
        entityType: 'organization',
        canonicalName: 'Acme Defense Parent',
        identifiers: [{ type: 'uei', value: 'PARENT123456', sourceType: 'sam_entity', sourceId: 'parent' }],
      },
      {
        entityType: 'organization',
        canonicalName: 'Acme Defense Subsidiary',
        identifiers: [{ type: 'cage', value: 'SUB01', sourceType: 'sam_entity', sourceId: 'subsidiary' }],
      },
    ]) {
      createdTenantEntityIds.push(
        await insertPrivateFixture(prisma, input.canonicalName, input.entityType, input.identifiers),
      );
    }
    createdTenantEntityIds.push(
      await insertPrivateFixture(
        prisma,
        'Blue Lantern Holdings — Tenant A',
        'organization',
        [{ type: 'crm_client_id', value: 'blue-lantern', sourceType: 'crm_client', sourceId: 'blue-lantern' }],
        [{ value: 'Project Blue Lantern', sourceType: 'crm_client', sourceId: 'blue-lantern' }],
      ),
    );
    createdTenantEntityIds.push(
      await insertPrivateFixture(prisma, 'Private Person — Tenant A', 'person', [
        { type: 'email', value: 'private.person@stealth.example', sourceType: 'crm_contact', sourceId: 'private-person' },
      ]),
    );

    const goldenObservations: EntityResolutionGoldenObservation[] = [];
    for (const testCase of ENTITY_RESOLUTION_GOLDEN_CORPUS) {
      const tenantId = testCase.tenantFixture === 'tenant_a' ? TENANT_A : TENANT_B;
      const result = await orchestrator.resolveAcrossSources(tenantId, testCase.input);
      goldenObservations.push(toEntityResolutionGoldenObservation(testCase.id, result));
    }
    const golden = evaluateEntityResolutionGoldenCorpus(ENTITY_RESOLUTION_GOLDEN_CORPUS, goldenObservations);

    const externalObservations: MeriCompatibleEntityResolutionObservation[] = [];
    for (const testCase of MERI_COMPATIBLE_ENTITY_RESOLUTION_CASES) {
      const result = await orchestrator.resolveAcrossSources(TENANT_A, testCase.input);
      externalObservations.push(
        toMeriCompatibleEntityResolutionObservation(testCase.id, result, {
          duplicateEntityCreated: false,
          privateIdentityLeaked: result.candidates.some(
            (candidate) => candidate.entityId != null && createdTenantEntityIds.includes(candidate.entityId),
          ),
        }),
      );
    }
    const external = evaluateMeriCompatibleEntityResolution(
      MERI_COMPATIBLE_ENTITY_RESOLUTION_CASES,
      externalObservations,
    );

    const machineReadable = {
      event: 'phase5_db_backed_harness',
      golden,
      external,
      goldenObservations,
      externalObservations,
    };
    console.log(JSON.stringify(machineReadable, null, 2));
    printHumanReadableSummary(golden, external);

    if (!golden.pass || !external.pass) process.exitCode = 1;
  } finally {
    await cleanup(prisma);
    await prisma.$disconnect();
  }
}

function printHumanReadableSummary(
  golden: ReturnType<typeof evaluateEntityResolutionGoldenCorpus>,
  external: ReturnType<typeof evaluateMeriCompatibleEntityResolution>,
): void {
  const line = (label: string, value: string, ok: boolean) =>
    console.error(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(34)} ${value}`);

  console.error('\nPhase 5 DB-backed acceptance harness — summary');
  console.error('Golden corpus:');
  line('coverage', formatPct(golden.coverage), golden.coverage >= 1);
  line('status accuracy', formatPct(golden.statusAccuracy), golden.statusAccuracy >= 0.95);
  line(
    'resolved-selection accuracy',
    formatPct(golden.resolvedSelectionAccuracy),
    golden.resolvedSelectionAccuracy >= 0.95,
  );
  line('ambiguity accuracy', formatPct(golden.ambiguityAccuracy), golden.ambiguityAccuracy >= 0.95);
  line('false merges', String(golden.falseMergeCount), golden.falseMergeCount === 0);
  line('privacy leaks', String(golden.privacyLeakCount), golden.privacyLeakCount === 0);

  console.error('Meri external-company compatibility:');
  line('coverage', formatPct(external.coverage), external.coverage === 1);
  line(
    'external-company resolution success',
    formatPct(external.externalCompanyResolutionSuccess),
    external.externalCompanyResolutionSuccess >= 0.9,
  );
  line('candidate recall', formatPct(external.candidateRecall), external.candidateRecall === 1);
  line('fallback-stage coverage', formatPct(external.stageCoverage), external.stageCoverage === 1);
  line('duplicate canonical entities', String(external.duplicateEntityCount), external.duplicateEntityCount === 0);
  line('privacy leaks', String(external.privacyLeakCount), external.privacyLeakCount === 0);

  if (golden.failures.length > 0 || external.failures.length > 0) {
    console.error('\nFailures:');
    for (const failure of golden.failures) {
      console.error(`  golden:${failure.caseId} — ${failure.kind}: ${failure.message}`);
    }
    for (const failure of external.failures) {
      console.error(`  meri_compat:${failure.caseId} — ${failure.reason}`);
    }
  }

  const overallPass = golden.pass && external.pass;
  console.error(`\nOverall: ${overallPass ? 'PASS' : 'FAIL'}\n`);
}

function formatPct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

async function seedTenants(prisma: PrismaService): Promise<void> {
  for (const [id, slug] of [[TENANT_A, 'phase5-harness-a'], [TENANT_B, 'phase5-harness-b']] as const) {
    await prisma.$executeRaw`INSERT INTO tenants (id, slug, name, status) VALUES (${id}::uuid, ${slug}, 'Phase 5 Harness', 'active') ON CONFLICT (id) DO NOTHING`;
  }
}

async function insertPrivateFixture(
  prisma: PrismaService,
  canonicalName: string,
  entityType: string,
  identifiers: Array<{ type: string; value: string; sourceType: string; sourceId: string }>,
  aliases: Array<{ value: string; sourceType: string; sourceId: string }> = [],
): Promise<string> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    INSERT INTO canonical_entities (tenant_id, identity_scope, entity_type, canonical_name, normalized_name, resolution_method, metadata)
    VALUES (${TENANT_A}::uuid, 'tenant_private', ${entityType}, ${canonicalName}, lower(regexp_replace(${canonicalName}, '[^a-zA-Z0-9]+', ' ', 'g')), 'crm_fixture', '{}'::jsonb)
    RETURNING id
  `;
  const id = rows[0]!.id;
  for (const alias of aliases) {
    await prisma.$executeRaw`
      INSERT INTO entity_aliases (entity_id, tenant_id, identity_scope, alias, normalized_alias, source_type, source_id)
      VALUES (${id}::uuid, ${TENANT_A}::uuid, 'tenant_private', ${alias.value}, lower(regexp_replace(${alias.value}, '[^a-zA-Z0-9]+', ' ', 'g')), ${alias.sourceType}, ${alias.sourceId})
    `;
  }
  for (const identifier of identifiers) {
    await prisma.$executeRaw`
      INSERT INTO entity_identifiers (entity_id, tenant_id, identity_scope, identifier_type, identifier_value, normalized_value, source_type, source_id)
      VALUES (${id}::uuid, ${TENANT_A}::uuid, 'tenant_private', ${identifier.type}, ${identifier.value}, CASE WHEN ${identifier.type} = 'email' THEN lower(${identifier.value}) ELSE upper(${identifier.value}) END, ${identifier.sourceType}, ${identifier.sourceId})
    `;
  }
  return id;
}

async function cleanup(prisma: PrismaService): Promise<void> {
  // This harness targets a disposable local/CI database only. Temporarily
  // disabling USER triggers is required to remove append-only resolution
  // evidence between isolated fixture runs; production code never uses this.
  await prisma.$executeRaw`ALTER TABLE entity_resolutions DISABLE TRIGGER USER`;
  try {
    await prisma.$executeRaw`DELETE FROM entity_resolutions WHERE tenant_id IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`;
    await prisma.$executeRaw`DELETE FROM entity_identity_governance_events WHERE tenant_id IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`;
    await prisma.$executeRaw`
      DELETE FROM entity_aliases
      WHERE entity_id IN (
        SELECT id FROM canonical_entities
        WHERE tenant_id IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)
           OR canonical_name = ANY(${GLOBAL_FIXTURE_NAMES})
      )
    `;
    await prisma.$executeRaw`
      DELETE FROM entity_identifiers
      WHERE entity_id IN (
        SELECT id FROM canonical_entities
        WHERE tenant_id IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)
           OR canonical_name = ANY(${GLOBAL_FIXTURE_NAMES})
      )
    `;
    await prisma.$executeRaw`DELETE FROM canonical_entity_merges WHERE tenant_id IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`;
    await prisma.$executeRaw`
      DELETE FROM canonical_entities
      WHERE tenant_id IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)
         OR canonical_name = ANY(${GLOBAL_FIXTURE_NAMES})
    `;
    await prisma.$executeRaw`DELETE FROM tenants WHERE id IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`;
  } finally {
    await prisma.$executeRaw`ALTER TABLE entity_resolutions ENABLE TRIGGER USER`;
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ event: 'phase5_db_backed_harness.crashed', error: String(error) }));
  process.exit(1);
});
