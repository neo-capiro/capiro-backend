/**
 * Business Development Phase 5 — REAL PostgreSQL/Prisma integration rehearsal
 * for Discover candidate-search service/exclusion filtering, against the
 * disposable LOCAL database "capiro_bizdev_watch_paging_20260926".
 *
 * Delegation bounds (from root):
 *   * This is a NEW, standalone file only — never imported by app code.
 *   * No network providers, no ingestion, no AWS/cloud/production, no default
 *     DATABASE_URL, no flags. Requires BIZDEV_DISCOVER_REHEARSAL_DATABASE_URL;
 *     parses and validates it BEFORE any PrismaClient construction; refuses
 *     every host except localhost / 127.0.0.1, every port except 5432, every
 *     database except the dedicated one above, non-postgres protocols, and
 *     any query options or fragments. Never prints URLs, credentials, or raw
 *     driver errors.
 *   * Imports and calls the REAL BizDevDossierService.searchCandidates — its
 *     SQL, filtering, paging and coverage are exercised as shipped; nothing
 *     is duplicated or re-implemented here.
 *   * ONE outer Prisma transaction holds everything: exact synthetic fixtures
 *     are created under the local admin connection, capiro_app is asserted
 *     non-superuser / non-BYPASSRLS up front, then SET LOCAL ROLE capiro_app
 *     + app.bypass_rls=off drop the transaction to application privileges.
 *     A withTenant shim sets app.current_tenant via set_config and forwards
 *     to the actual outer-transaction delegates/$queryRaw (the same handle
 *     also carries $queryRaw for the global award projection path). The
 *     transaction is ALWAYS rolled back with a recognized sentinel — even
 *     after success — so fixtures never commit and no explicit delete is
 *     needed. Prisma disconnects in finally.
 *   * No federal_award rows are seeded: no fixture carries a UEI, so the
 *     award aggregate is skipped by the service itself (identifiers use
 *     CAGE only, avoiding unrelated award aggregates entirely).
 *
 * Scenarios (all inside the single rolled-back transaction):
 *   1. Two tenants share global_public orgs; A excludes the first org
 *      alphabetically while B does not; a B-only exclusion/hypothesis
 *      (Zeta) neither hides nor selects rows for A; a tenant-private
 *      org/alias/identifier is never visible to the other tenant.
 *   2. Saved service 'Appropriations advocacy' matches case-insensitive
 *      trimmed EXACT input (messy-case/padded saved value still matches;
 *      substring and other tenants' hypotheses do not).
 *   3. Four matching orgs, one excluded: limit 1 proves the exclusion is
 *      applied BEFORE LIMIT/OFFSET (first visible result, not the excluded
 *      org); offset paging is stable with no duplicates; includeExcluded
 *      reveals only a safe excluded marker.
 *   4. Alias name-search and no-prospect paths are preserved.
 *   5. Empty filtered results carry truthful coverage.
 *   6. An injection-looking service literal returns no matches and leaves
 *      the transaction/fixtures intact.
 *   7. Post-rollback verification proves nothing committed.
 */
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { BizDevDossierService } from '../../src/business-development/bizdev-dossier.service.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import type { VendorReferenceSamClient } from '../../src/vendor-reference/vendor-reference-sam.client.js';
import type { TenantContext } from '@capiro/shared';

const ALLOWED_DATABASE = 'capiro_bizdev_watch_paging_20260926';
const SERVICE_FILTER = 'Appropriations advocacy';

/** Recognized sentinel: forces rollback of the fixture transaction even
 * after every assertion passed. Never treated as a failure. */
class RollbackSentinel extends Error {}

class RehearsalFailure extends Error {}

function fail(message: string): never {
  throw new RehearsalFailure(message);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(`assertion failed: ${message}`);
}

/** Sanitized error text: our own messages verbatim; anything else reduced to
 * a class name + Prisma error code — never a driver message (credentials). */
function sanitize(error: unknown): string {
  if (error instanceof RollbackSentinel) return 'rollback sentinel';
  if (error instanceof RehearsalFailure) return error.message;
  const code = (error as { code?: unknown } | null | undefined)?.code;
  const name = error instanceof Error ? error.constructor.name : typeof error;
  return `unexpected ${name}${typeof code === 'string' ? ` (${code})` : ''}`;
}

const log = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

// ── Environment guard (BEFORE any PrismaClient construction) ──────────────

function requireRehearsalUrl(): string {
  const raw = process.env.BIZDEV_DISCOVER_REHEARSAL_DATABASE_URL;
  if (typeof raw !== 'string' || raw.length === 0) {
    fail(
      'BIZDEV_DISCOVER_REHEARSAL_DATABASE_URL is required (local disposable rehearsal database only)',
    );
  }
  let parsed: URL | null = null;
  try {
    parsed = new URL(raw);
  } catch {
    fail('rehearsal database URL is not a valid URL');
  }
  if (parsed === null) fail('rehearsal database URL is not a valid URL');
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    (parsed.port !== '' && parsed.port !== '5432') ||
    parsed.search ||
    parsed.hash
  ) {
    fail('rehearsal requires PostgreSQL on local port 5432 without URL options or fragments');
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== 'localhost' && host !== '127.0.0.1') {
    fail('rehearsal database URL must target localhost or 127.0.0.1');
  }
  const database = parsed.pathname.replace(/^\//, '');
  if (database !== ALLOWED_DATABASE) {
    fail(`rehearsal database URL must target the dedicated local database "${ALLOWED_DATABASE}"`);
  }
  return raw;
}

// ── Fixtures (exact generated ids only; unique stamp per run) ─────────────

interface Fixtures {
  stamp: string;
  term: string;
  secretA: string;
  secretADesc: string;
  secretB: string;
  tenantA: string;
  tenantB: string;
  // global_public orgs matching the search term by canonical name
  alpha: string; // A-excluded, A hypothesis (messy case/whitespace)
  beta: string; // plain shared org (also carries B-private alias token)
  delta: string; // A hypothesis match
  kappa: string; // A hypothesis match
  omega: string; // A hypothesis match
  zeta: string; // B-only exclusion + B-only hypothesis
  // global_public orgs NOT matching by name
  mu: string; // matched only via a global alias containing the term
  nu: string; // matched only via B-private CAGE identifier
  privateA: string; // tenant-private org owned by A
  aliasGlobal: string;
  aliasPrivateB: string;
  identifierPrivateB: string;
  prospects: Array<{
    id: string;
    tenantId: string;
    canonicalEntityId: string;
    serviceHypothesis: string | null;
    conflictExcluded: boolean;
    conflictReason: string | null;
    description: string | null;
  }>;
  allEntityIds: string[];
}

function makePlan(): Fixtures {
  const stamp = randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
  const term = `BDDF ${stamp}`;
  const id = () => randomUUID();
  const tenants = { a: id(), b: id() };
  const f: Fixtures = {
    stamp,
    term,
    secretA: `SECRET-A-REASON-${stamp}`,
    secretADesc: `SECRET-A-DESC-${stamp}`,
    secretB: `SECRET-B-REASON-${stamp}`,
    tenantA: tenants.a,
    tenantB: tenants.b,
    alpha: id(),
    beta: id(),
    delta: id(),
    kappa: id(),
    omega: id(),
    zeta: id(),
    mu: id(),
    nu: id(),
    privateA: id(),
    aliasGlobal: id(),
    aliasPrivateB: id(),
    identifierPrivateB: id(),
    prospects: [],
    allEntityIds: [],
  };
  const prospect = (
    tenantId: string,
    canonicalEntityId: string,
    serviceHypothesis: string | null,
    conflictExcluded = false,
    conflictReason: string | null = null,
    description: string | null = null,
  ): void => {
    f.prospects.push({
      id: id(),
      tenantId,
      canonicalEntityId,
      serviceHypothesis,
      conflictExcluded,
      conflictReason,
      description,
    });
  };
  // Tenant A: Alpha excluded with a private conflict reason + private
  // description; messy-case/padded hypothesis still EXACT-matches the
  // trimmed lowercase filter. Delta/Kappa/Omega carry clean hypotheses.
  prospect(tenants.a, f.alpha, `  appropriations ADVOCACY  `, true, f.secretA, f.secretADesc);
  prospect(tenants.a, f.delta, SERVICE_FILTER);
  prospect(tenants.a, f.kappa, SERVICE_FILTER);
  prospect(tenants.a, f.omega, SERVICE_FILTER);
  // Tenant B: NOT excluded on Alpha; B-only exclusion + B-only hypothesis on
  // Zeta (must neither hide nor select Zeta for A).
  prospect(tenants.b, f.alpha, SERVICE_FILTER);
  prospect(tenants.b, f.zeta, SERVICE_FILTER, true, f.secretB);
  f.allEntityIds = [
    f.alpha,
    f.beta,
    f.delta,
    f.kappa,
    f.omega,
    f.zeta,
    f.mu,
    f.nu,
    f.privateA,
  ];
  return f;
}

/** Seed inside the outer transaction, under the local admin connection. */
async function seed(tx: Prisma.TransactionClient, f: Fixtures): Promise<void> {
  const settings = {
    clioFeatureFlags: { 'businessDevelopment.enabled': true },
  } as Prisma.InputJsonValue;
  for (const [tenantId, label] of [
    [f.tenantA, 'a'],
    [f.tenantB, 'b'],
  ] as const) {
    await tx.tenant.create({
      data: {
        id: tenantId,
        name: `BDDF ${label.toUpperCase()} ${f.stamp}`,
        slug: `bddf-${label}-${f.stamp.toLowerCase()}`,
        status: 'active',
        settings,
      },
      select: { id: true },
    });
  }
  const org = (
    entityId: string,
    canonicalName: string,
    tenantId: string | null,
    identityScope: 'global_public' | 'tenant_private',
  ) =>
    tx.canonicalEntity.create({
      data: {
        id: entityId,
        tenantId,
        identityScope,
        entityType: 'organization',
        canonicalName,
        normalizedName: canonicalName.toLowerCase(),
        status: 'active',
        resolutionConfidence: 1,
        resolutionMethod: 'name_exact',
      },
      select: { id: true },
    });
  await org(f.alpha, `BDDF ${f.stamp} Alpha Inc`, null, 'global_public');
  await org(f.beta, `BDDF ${f.stamp} Beta Inc`, null, 'global_public');
  await org(f.delta, `BDDF ${f.stamp} Delta Inc`, null, 'global_public');
  await org(f.kappa, `BDDF ${f.stamp} Kappa Inc`, null, 'global_public');
  await org(f.omega, `BDDF ${f.stamp} Omega Inc`, null, 'global_public');
  await org(f.zeta, `BDDF ${f.stamp} Zeta Inc`, null, 'global_public');
  // Mu's canonical name does NOT contain the term — only its global alias does.
  await org(f.mu, `Quiet Mu ${f.stamp}`, null, 'global_public');
  // Nu's canonical name does not contain the term — only B's private CAGE does.
  await org(f.nu, `Quiet Nu ${f.stamp}`, null, 'global_public');
  // A's tenant-private org, name contains the term.
  await org(f.privateA, `BDDF ${f.stamp} Private A Co`, f.tenantA, 'tenant_private');
  // Global alias on Mu (both tenants can match it).
  await tx.entityAlias.create({
    data: {
      id: f.aliasGlobal,
      entityId: f.mu,
      tenantId: null,
      identityScope: 'global_public',
      alias: `BDDF ${f.stamp} Mu Aliased Trading`,
      normalizedAlias: `bddf ${f.stamp.toLowerCase()} mu aliased trading`,
      sourceType: 'manual',
    },
    select: { id: true },
  });
  // B-private alias on Beta with a distinct token — never visible to A.
  await tx.entityAlias.create({
    data: {
      id: f.aliasPrivateB,
      entityId: f.beta,
      tenantId: f.tenantB,
      identityScope: 'tenant_private',
      alias: `ZZB${f.stamp}ALIAS`,
      normalizedAlias: `zzb${f.stamp.toLowerCase()}alias`,
      sourceType: 'manual',
    },
    select: { id: true },
  });
  // B-private CAGE identifier on Nu — never visible to A. CAGE (not UEI) so
  // the award aggregate path stays untouched for these fixtures.
  await tx.entityIdentifier.create({
    data: {
      id: f.identifierPrivateB,
      entityId: f.nu,
      tenantId: f.tenantB,
      identityScope: 'tenant_private',
      identifierType: 'cage',
      identifierValue: `NUPV${f.stamp}`,
      normalizedValue: `NUPV${f.stamp}`,
      sourceType: 'manual',
      confidence: 1,
    },
    select: { id: true },
  });
  for (const p of f.prospects) {
    await tx.businessDevelopmentProspect.create({
      data: {
        id: p.id,
        tenantId: p.tenantId,
        canonicalEntityId: p.canonicalEntityId,
        displayName: `Prospect ${p.canonicalEntityId.slice(0, 8)}`,
        stage: 'researching',
        status: 'active',
        serviceHypothesis: p.serviceHypothesis,
        conflictExcluded: p.conflictExcluded,
        conflictReason: p.conflictReason,
        description: p.description,
      },
      select: { id: true },
    });
  }
  log(
    `seed: 2 tenants, 8 global_public orgs + 1 tenant-private org, 2 aliases (1 private), 1 private CAGE, ${f.prospects.length} prospects`,
  );
}

// ── The rehearsal (inside the single outer transaction) ───────────────────

interface CandidateLike {
  canonicalEntityId: string;
  canonicalName: string;
  identityScope: string;
  serviceHypothesis?: string | null;
  marker?: { excluded?: boolean };
  identifiers?: Array<{ type: string; value: string }>;
}

interface SearchResultLike {
  results: CandidateLike[];
  coverage: {
    serviceFilterApplied: boolean;
    exclusionsApplied: boolean;
    more: boolean;
    offset: number;
    limit: number;
    unsupportedFilters: string[];
  };
}

async function rehearse(
  service: BizDevDossierService,
  ctxA: TenantContext,
  ctxB: TenantContext,
  f: Fixtures,
  tx: Prisma.TransactionClient,
): Promise<void> {
  const search = (
    ctx: TenantContext,
    q: string,
    query: { service?: string; includeExcluded?: boolean; limit?: number; offset?: number },
  ) => service.searchCandidates(ctx, { q, ...query }) as Promise<SearchResultLike>;

  // ── 1. Default (unfiltered) visibility per tenant ───────────────────────
  const aDefault = await search(ctxA, f.term, { limit: 25 });
  const aIds = aDefault.results.map((r) => r.canonicalEntityId);
  assert(!aIds.includes(f.alpha), 'tenant A default search revealed its own excluded org (Alpha)');
  assert(aIds.includes(f.beta), 'tenant A default search lost shared org Beta');
  assert(
    aIds.includes(f.zeta),
    "tenant A default search hid Zeta via tenant B's exclusion (cross-tenant exclusion leak)",
  );
  assert(
    aIds.includes(f.privateA),
    'tenant A default search lost its own tenant-private org',
  );
  assert(
    aIds.includes(f.mu),
    'tenant A default search lost the global-alias-matched org (Mu)',
  );
  assert(!aIds.includes(f.nu), "tenant A default search selected Nu via B's private identifier");
  assert(
    aDefault.coverage.serviceFilterApplied === false &&
      aDefault.coverage.exclusionsApplied === true,
    'tenant A default coverage flags wrong',
  );

  const bDefault = await search(ctxB, f.term, { limit: 25 });
  const bIds = bDefault.results.map((r) => r.canonicalEntityId);
  assert(bIds.includes(f.alpha), 'tenant B default search lost Alpha (B does not exclude it)');
  assert(!bIds.includes(f.zeta), "tenant B default search revealed B's own excluded org (Zeta)");
  assert(!bIds.includes(f.privateA), "tenant B default search saw A's tenant-private org");
  assert(!bIds.includes(f.nu), 'default name query unexpectedly matched the unrelated private CAGE token');
  log('PASS 1: shared orgs + per-tenant exclusions + tenant-private isolation all correct');

  // ── 2. Tenant-private alias/identifier cross-checks ─────────────────────
  const aliasToken = `zzb${f.stamp}alias`;
  const aAlias = await search(ctxA, aliasToken, { limit: 25 });
  assert(
    aAlias.results.length === 0,
    "tenant A matched an org via tenant B's private alias",
  );
  const bAlias = await search(ctxB, aliasToken, { limit: 25 });
  assert(
    bAlias.results.length === 1 && bAlias.results[0].canonicalEntityId === f.beta,
    'tenant B private-alias search did not resolve exactly to Beta',
  );
  const cageToken = `nupv${f.stamp}`;
  const aCage = await search(ctxA, cageToken, { limit: 25 });
  assert(
    aCage.results.length === 0,
    "tenant A matched an org via tenant B's private CAGE identifier",
  );
  const bCage = await search(ctxB, cageToken, { limit: 25 });
  assert(
    bCage.results.length === 1 && bCage.results[0].canonicalEntityId === f.nu,
    'tenant B private-CAGE search did not resolve exactly to Nu',
  );
  assert(
    bCage.results[0].identifiers?.some((i) => i.type === 'cage' && i.value === `NUPV${f.stamp}`) ===
      true,
    'tenant B private-CAGE result did not carry the CAGE identifier',
  );
  log('PASS 2: tenant-private alias and identifier never visible to the other tenant');

  // ── 3. Service filter: exact, trimmed, case-insensitive, tenant-scoped ──
  const aService = await search(ctxA, f.term, {
    service: '  APPROPRIATIONS advocacy  ',
    limit: 25,
  });
  const aServiceIds = aService.results.map((r) => r.canonicalEntityId);
  assert(
    aServiceIds.includes(f.delta) &&
      aServiceIds.includes(f.kappa) &&
      aServiceIds.includes(f.omega),
    'tenant A service filter lost its own hypothesis-matching orgs',
  );
  assert(
    !aServiceIds.includes(f.alpha),
    'tenant A service filter revealed its own excluded org by default',
  );
  assert(
    !aServiceIds.includes(f.zeta),
    "tenant A service filter selected Zeta via tenant B's hypothesis (cross-tenant selection leak)",
  );
  assert(
    !aServiceIds.includes(f.beta) && !aServiceIds.includes(f.mu) && !aServiceIds.includes(f.nu),
    'tenant A service filter selected orgs without a matching own hypothesis',
  );
  assert(
    aService.coverage.serviceFilterApplied === true && aService.coverage.exclusionsApplied === true,
    'tenant A service-filtered coverage flags wrong',
  );

  // Substring / partial must NOT match (exact trimmed match only).
  const aSubstring = await search(ctxA, f.term, { service: 'Appropriations', limit: 25 });
  assert(
    aSubstring.results.length === 0,
    'substring service filter matched (must be exact trimmed only)',
  );
  // Messy-case saved hypothesis on Alpha matched above only via trim+lower —
  // proven by includeExcluded below. Other tenants' rows never leak (Zeta).
  log('PASS 3: service filter is exact trimmed case-insensitive and strictly tenant-scoped');

  // ── 4. Exclusion BEFORE paging: limit 1 across stable offsets ───────────
  const page0 = await search(ctxA, f.term, { service: SERVICE_FILTER, limit: 1, offset: 0 });
  assert(
    page0.results.length === 1 && page0.results[0].canonicalEntityId === f.delta,
    'limit-1 first page did not skip the excluded org BEFORE paging (expected Delta)',
  );
  assert(page0.coverage.more === true, 'limit-1 first page should report more');
  const page1 = await search(ctxA, f.term, { service: SERVICE_FILTER, limit: 1, offset: 1 });
  assert(
    page1.results.length === 1 && page1.results[0].canonicalEntityId === f.kappa,
    'offset 1 did not advance stably (expected Kappa)',
  );
  const page2 = await search(ctxA, f.term, { service: SERVICE_FILTER, limit: 1, offset: 2 });
  assert(
    page2.results.length === 1 && page2.results[0].canonicalEntityId === f.omega,
    'offset 2 did not advance stably (expected Omega)',
  );
  assert(page2.coverage.more === false, 'offset 2 should be the final page');
  const seen = [page0, page1, page2].flatMap((p) => p.results.map((r) => r.canonicalEntityId));
  assert(new Set(seen).size === 3, 'offset paging produced duplicate results');
  assert(
    page0.coverage.limit === 1 && page1.coverage.offset === 1 && page2.coverage.offset === 2,
    'coverage did not echo limit/offset truthfully',
  );
  log('PASS 4: exclusion applied BEFORE LIMIT/OFFSET; stable deduped paging');

  // ── 5. includeExcluded: safe marker only ────────────────────────────────
  const aIncluded = await search(ctxA, f.term, {
    service: SERVICE_FILTER,
    includeExcluded: true,
    limit: 25,
  });
  const incIds = aIncluded.results.map((r) => r.canonicalEntityId);
  assert(
    incIds.includes(f.alpha),
    'includeExcluded did not reveal the excluded org for tenant A',
  );
  assert(
    !incIds.includes(f.zeta),
    "includeExcluded revealed Zeta via tenant B's exclusion/hypothesis",
  );
  const alphaRow = aIncluded.results.find((r) => r.canonicalEntityId === f.alpha);
  assert(alphaRow, 'alpha row missing');
  assert(alphaRow.marker?.excluded === true, 'excluded marker missing on Alpha');
  assert(
    alphaRow.serviceHypothesis === `  appropriations ADVOCACY  `,
    'serviceHypothesis not returned verbatim from the saved prospect row',
  );
  assert(
    aIncluded.coverage.exclusionsApplied === false && aIncluded.coverage.serviceFilterApplied === true,
    'includeExcluded coverage flags wrong',
  );
  const serialized = JSON.stringify(aIncluded) + JSON.stringify(aDefault) + JSON.stringify(bDefault);
  assert(
    !serialized.includes(f.secretA) && !serialized.includes(f.secretADesc) && !serialized.includes(f.secretB),
    'search results leaked a private conflict reason or private description',
  );
  assert(
    !serialized.includes('conflictReason') && !serialized.includes('conflict_reason'),
    'search results exposed a conflict-reason field name',
  );
  log('PASS 5: includeExcluded shows only a safe excluded marker; no notes/reasons/private payload');

  // ── 6. Alias name-search + no-prospect path preserved ───────────────────
  const aAliasTerm = await search(ctxA, f.term, { limit: 25 });
  const muRow = aAliasTerm.results.find((r) => r.canonicalEntityId === f.mu);
  assert(muRow, 'global-alias-matched org (Mu) missing from A default search');
  assert(
    muRow.serviceHypothesis === null && muRow.marker?.excluded === false,
    'no-prospect candidate did not render the clean default marker path',
  );
  assert(
    muRow.identifiers?.length === 0,
    'no-prospect candidate unexpectedly carried identifiers',
  );
  log('PASS 6: alias name-search and no-prospect paths preserved');

  // ── 7. Empty filtered result with truthful coverage ─────────────────────
  const aEmpty = await search(ctxA, f.term, { service: 'Nonexistent service zz', limit: 10 });
  assert(aEmpty.results.length === 0, 'nonexistent service filter produced results');
  assert(
    aEmpty.coverage.serviceFilterApplied === true &&
      aEmpty.coverage.exclusionsApplied === true &&
      aEmpty.coverage.more === false,
    'empty filtered result did not carry truthful coverage',
  );
  log('PASS 7: empty filtered result with truthful coverage');

  // ── 8. Injection-looking service literal ────────────────────────────────
  const injection = `x'); DROP TABLE canonical_entities;--`;
  const aInjection = await search(ctxA, f.term, { service: injection, limit: 10 });
  assert(aInjection.results.length === 0, 'injection-looking service filter produced results');
  const entitiesNow = await tx.canonicalEntity.count({ where: { id: { in: f.allEntityIds } } });
  assert(entitiesNow === f.allEntityIds.length, 'fixtures were altered by the injection literal');
  const prospectsNow = await tx.businessDevelopmentProspect.count({
    where: { id: { in: f.prospects.map((p) => p.id) } },
  });
  assert(prospectsNow === f.prospects.filter(p => p.tenantId === f.tenantA).length,
    'tenant A prospect fixture count changed or RLS leaked foreign rows');
  await tx.$executeRaw`SELECT set_config('app.current_tenant', ${f.tenantB}, true)`;
  const prospectsB = await tx.businessDevelopmentProspect.count({
    where: { id: { in: f.prospects.map(p => p.id) } },
  });
  assert(prospectsB === f.prospects.filter(p => p.tenantId === f.tenantB).length,
    'tenant B prospect fixture count changed or RLS leaked foreign rows');
  await tx.$executeRaw`SELECT set_config('app.current_tenant', ${f.tenantA}, true)`;
  log('PASS 8: injection-looking service literal returned no matches; fixtures intact');
}

// ── Driver ────────────────────────────────────────────────────────────────

async function orchestrate(): Promise<void> {
  const url = requireRehearsalUrl(); // BEFORE PrismaClient construction
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const f = makePlan();
  try {
    const database = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
    assert(
      database[0]?.name === ALLOWED_DATABASE,
      'connected database identity differs from the local allowlist',
    );
    assert(
      (await prisma.businessDevelopmentProspect.count()) === 0,
      'dedicated rehearsal database already contains prospects; refusing to run',
    );
    assert(
      (await prisma.canonicalEntity.count({
        where: { canonicalName: { contains: f.stamp } },
      })) === 0,
      'rehearsal stamp collides with existing canonical entities; refusing to run',
    );
    // App-role assertion, exactly once: capiro_app must exist and be a plain
    // non-superuser / non-BYPASSRLS role for the RLS semantics to be real.
    const roleRows = await prisma.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'capiro_app'`;
    assert(roleRows.length === 1, 'capiro_app role must exist');
    assert(
      roleRows[0].rolsuper === false && roleRows[0].rolbypassrls === false,
      'capiro_app must be non-superuser and non-BYPASSRLS',
    );

    // ONE outer transaction: seed as admin, drop to capiro_app, run the REAL
    // service, then ALWAYS roll back via the sentinel — nothing commits.
    let sentinel: unknown = null;
    await prisma.$transaction(
      async (tx) => {
        await seed(tx, f);
        await tx.$executeRaw`SET LOCAL ROLE capiro_app`;
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'off', true)`;

        // withTenant shim over the ACTUAL outer-transaction client: sets
        // app.current_tenant per call and forwards every delegate/$queryRaw
        // (including the global award projection's direct $queryRaw) to the
        // same real transaction. No behavior of searchCandidates is duplicated.
        const handle = {
          withTenant: <T>(
            tenantId: string,
            fn: (t: Prisma.TransactionClient) => Promise<T>,
          ): Promise<T> =>
            tx
              .$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`
              .then(() => fn(tx as unknown as Prisma.TransactionClient)),
          $queryRaw: tx.$queryRaw.bind(tx),
        } as unknown as PrismaService;

        // Every provider stub throws on use — search must need none of them.
        const samStub = {
          lookupByUei: (): never => fail('samClient.lookupByUei must not be called by search'),
          lookupByCage: (): never => fail('samClient.lookupByCage must not be called by search'),
          lookupByName: (): never => fail('samClient.lookupByName must not be called by search'),
        } as unknown as VendorReferenceSamClient;
        const jevStub = new Proxy(
          {},
          {
            get: (): never =>
              fail('jev service must not be called by search'),
          },
        );
        const service = new BizDevDossierService(
          handle,
          samStub,
          jevStub as never,
        );

        const ctxA: TenantContext = {
          tenantId: f.tenantA,
          tenantSlug: `bddf-a-${f.stamp.toLowerCase()}`,
          userId: randomUUID(),
          clerkUserId: `user_bddf_a_${f.stamp.toLowerCase()}`,
          role: 'standard_user',
        };
        const ctxB: TenantContext = {
          tenantId: f.tenantB,
          tenantSlug: `bddf-b-${f.stamp.toLowerCase()}`,
          userId: randomUUID(),
          clerkUserId: `user_bddf_b_${f.stamp.toLowerCase()}`,
          role: 'standard_user',
        };

        await rehearse(service, ctxA, ctxB, f, tx);
        throw new RollbackSentinel('rehearsal complete'); // force rollback even on success
      },
      { timeout: 60000 },
    ).catch((error: unknown) => {
      if (!(error instanceof RollbackSentinel)) throw error;
      sentinel = error;
    });
    assert(sentinel !== null, 'outer transaction completed without the rollback sentinel');

    // Nothing committed: every fixture id is gone.
    const tenantsLeft = await prisma.tenant.count({ where: { id: { in: [f.tenantA, f.tenantB] } } });
    const entitiesLeft = await prisma.canonicalEntity.count({ where: { id: { in: f.allEntityIds } } });
    const prospectsLeft = await prisma.businessDevelopmentProspect.count({
      where: { id: { in: f.prospects.map((p) => p.id) } },
    });
    assert(
      tenantsLeft === 0 && entitiesLeft === 0 && prospectsLeft === 0,
      `fixtures committed despite rollback (tenants=${tenantsLeft} entities=${entitiesLeft} prospects=${prospectsLeft})`,
    );
    log('rollback verified: zero fixture rows persisted; no cleanup needed');
    log('PASS: discover filter rehearsal completed all bounded assertions');
  } finally {
    await prisma.$disconnect();
  }
}

void orchestrate().then(
  () => {
    process.exitCode = 0;
  },
  (error: unknown) => {
    process.stderr.write(`FAIL: ${sanitize(error)}\n`);
    process.exitCode = 1;
  },
);
