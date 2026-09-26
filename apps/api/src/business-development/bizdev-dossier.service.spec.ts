import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { BizDevDossierService } from './bizdev-dossier.service.js';

/**
 * Deterministic Jest coverage for the Phase 2 BizDevDossierService with
 * in-memory Prisma/SAM mocks. No live provider calls: the SAM client is a
 * jest.fn whose behavior is set per test. RLS proof is NOT claimed here (the
 * disposable real-Postgres harness owns that) — these tests pin the
 * page-level query discipline, tenant privacy, section independence, provider
 * flag semantics, and evidence honesty.
 */

const tenantId = randomUUID();
const tenantBId = randomUUID();
const ctx = { tenantId, userId: 'u1', role: 'standard_user' } as unknown as TenantContext;
const ctxB = {
  tenantId: tenantBId,
  userId: 'u2',
  role: 'standard_user',
} as unknown as TenantContext;

// ── fixtures ────────────────────────────────────────────────────────────────

interface CanonicalOrg {
  id: string;
  canonicalName: string;
  normalizedName: string;
  identityScope: 'global_public' | 'tenant_private';
  tenantId: string | null;
  status: string;
  entityType: string;
  mergedIntoEntityId: string | null;
}

const UEI_A = 'ABCDE123456F'; // valid 12-char UEI shape
const UEI_B = 'GHIJKL654321N';

interface Identifier {
  entityId: string;
  identifierType: string;
  identifierValue: string;
  identityScope: 'global_public' | 'tenant_private';
  tenantId: string | null;
  status: string;
}

interface Alias {
  entityId: string;
  alias: string;
  normalizedAlias: string;
  identityScope: string;
  tenantId: string | null;
  status: string;
}

interface AwardRow {
  id: string;
  awardUniqueId: string;
  piid: string | null;
  recipientUei: string | null;
  contractorName: string | null;
  amount: number | string | null;
  description: string | null;
  actionDate: Date | null;
  awardingAgency: string | null;
  awardingSubTier: string | null;
  fundingFy: number | null;
  peCode: string | null;
  peCodeSource: string | null;
  peCodeConfidence: number | null;
  peCodeCandidateCount: number | null;
  dodAcqProgramCode: string | null;
  dodAcqProgramName: string | null;
  popState: string | null;
  popCongressionalDistrict: string | null;
  recipientState: string | null;
  recipientCongressionalDistrict: string | null;
  lastSyncedAt: Date | null;
}

interface AssistanceRow {
  awardUniqueId: string;
  fain: string | null;
  recipientUei: string | null;
  recipientName: string | null;
  totalObligatedAmount: number | null;
  startDate: Date | null;
  awardingAgency: string | null;
  awardingSubTier: string | null;
  lastSyncedAt: Date | null;
}

interface LdaRow {
  filingUuid: string;
  filingType: string | null;
  filingYear: number | null;
  filingPeriod: string | null;
  registrantName: string | null;
  clientName: string | null;
  clientId: string | null;
  income: number | null;
  issueCodes: string[] | null;
  dtPosted: Date | null;
  filingDocumentUrl: string | null;
  lastSyncedAt: Date | null;
}

interface SamOppRow {
  noticeId: string;
  title: string | null;
  noticeType: string | null;
  agency: string | null;
  subAgency: string | null;
  office: string | null;
  postedDate: Date | null;
  responseDeadline: Date | null;
  active: boolean;
  lastSyncedAt: Date | null;
}

type Fixture = {
  canonical: CanonicalOrg[];
  identifiers: Identifier[];
  aliases: Alias[];
  awards: AwardRow[];
  assistance: AssistanceRow[];
  lda: LdaRow[];
  samOpps: SamOppRow[];
  prospects: Array<Record<string, unknown>>;
  clients: Array<Record<string, unknown>>;
  facilities: Array<Record<string, unknown>>;
  tenantSettings: Record<string, unknown> | null;
  /** When set, the candidate award aggregate raw query rejects (outage test). */
  awardAggregateThrows?: boolean;
  samLookupByUei?: (uei: string) => { ok: true; entities: unknown[] } | { ok: false; reason: string; message: string };
  samLookupByCage?: (cage: string) => { ok: true; entities: unknown[] } | { ok: false; reason: string; message: string };
};

const org = (over: Partial<CanonicalOrg> = {}): CanonicalOrg => ({
  id: randomUUID(),
  canonicalName: 'Acme Aerospace',
  normalizedName: 'acme aerospace',
  identityScope: 'global_public',
  tenantId: null,
  status: 'active',
  entityType: 'organization',
  mergedIntoEntityId: null,
  ...over,
});

const award = (over: Partial<AwardRow> = {}): AwardRow => ({
  id: randomUUID(),
  awardUniqueId: `AWARD_${randomUUID().slice(0, 8)}`,
  piid: 'PIID123',
  recipientUei: UEI_A,
  contractorName: 'ACME AEROSPACE LLC',
  amount: 1_000_000,
  description: 'Advanced aerospace components R&D',
  actionDate: new Date('2026-06-15T00:00:00Z'),
  awardingAgency: 'DEPT OF DEFENSE',
  awardingSubTier: 'NAVY',
  fundingFy: 2026,
  peCode: null,
  peCodeSource: null,
  peCodeConfidence: null,
  peCodeCandidateCount: null,
  dodAcqProgramCode: null,
  dodAcqProgramName: null,
  popState: 'CA',
  popCongressionalDistrict: '12',
  recipientState: 'VA',
  recipientCongressionalDistrict: '08',
  lastSyncedAt: new Date('2026-07-01T10:00:00Z'),
  ...over,
});

const SAM_RECORD = {
  uei: UEI_A,
  cageCode: '1AB23',
  legalBusinessName: 'ACME AEROSPACE LLC',
  dbaName: null,
  registrationStatus: 'Active',
  registrationDate: '2024-01-01',
  registrationExpirationDate: '2026-01-01',
  lastUpdateDate: '2026-05-01',
  physicalAddress: {
    line1: '1 Main St',
    line2: null,
    city: 'Arlington',
    state: 'VA',
    zip: '22202',
    country: 'USA',
  },
  congressionalDistrict: '08',
  entityStructure: 'LLC',
  stateOfIncorporation: 'VA',
  primaryNaics: '336411',
  naicsCodes: ['336411'],
  pscCodes: ['1510'],
};

// ── harness ────────────────────────────────────────────────────────────────

/** Minimal where-matcher supporting equality, {in:}, {equals,mode}, {contains,mode}, OR, AND. */
function matches(where: Record<string, unknown>, row: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(where)) {
    const rowValue = row[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if ('in' in (value as object)) {
        if (!(value as { in: unknown[] }).in.includes(rowValue)) return false;
        continue;
      }
      if ('equals' in (value as object)) {
        const needle = String((value as { equals: unknown }).equals).toLowerCase();
        if (String(rowValue ?? '').toLowerCase() !== needle) return false;
        continue;
      }
      if ('contains' in (value as object)) {
        const needle = String((value as { contains: unknown }).contains).toLowerCase();
        if (!String(rowValue ?? '').toLowerCase().includes(needle)) return false;
        continue;
      }
    }
    if (key === 'OR' && Array.isArray(value)) {
      if (!value.some((sub) => matches(sub, row))) return false;
      continue;
    }
    if (key === 'AND' && Array.isArray(value)) {
      if (!value.every((sub) => matches(sub, row))) return false;
      continue;
    }
    if (value !== rowValue) return false;
  }
  return true;
}

const visibleTo = (row: { identityScope: string; tenantId: string | null }, t: string) =>
  row.identityScope === 'global_public' || row.tenantId === t;

interface Calls {
  rawQueries: Array<{ sql: string; args: unknown[] }>;
  awardReads: Array<Record<string, unknown>>;
  samUei: string[];
  samCage: string[];
  withTenantCount: number;
}

const makeHarness = (fx: Fixture) => {
  const calls: Calls = {
    rawQueries: [],
    awardReads: [],
    samUei: [],
    samCage: [],
    withTenantCount: 0,
  };

  /** In-memory raw SQL evaluator for the bounded canonical/identifier/alias
   * queries. SQL strings are matched structurally, not parsed. */
  const runRaw = (sql: string, args: unknown[]): Array<Record<string, unknown>> => {
    if (sql.includes('FROM "canonical_entities"')) {
      let rows: CanonicalOrg[] = fx.canonical.filter(
        (c) =>
          c.mergedIntoEntityId === null &&
          c.status === 'active' &&
          c.entityType === 'organization' &&
          visibleTo(c, String(args[0])),
      );
      if (sql.includes('WHERE "id" =')) {
        return rows
          .filter((c) => c.id === args[0])
          .map((c) => ({
            id: c.id,
            canonicalName: c.canonicalName,
            identityScope: c.identityScope,
          }));
      }
      // Search: term present in the args; applies to canonical + alias EXISTS.
      // The alias EXISTS is approximated by also matching aliases.
      const term = String(args.find((a) => typeof a === 'string' && a.includes('%')) ?? '')
        .replaceAll('%', '')
        .toLowerCase();
      const aliasEntityIds = new Set(
        fx.aliases
          .filter(
            (a) =>
              a.status === 'active' &&
              visibleTo(a, String(args[0])) &&
              (a.alias.toLowerCase().includes(term) || a.normalizedAlias.includes(term)),
          )
          .map((a) => a.entityId),
      );
      rows = rows.filter(
        (c) =>
          c.canonicalName.toLowerCase().includes(term) ||
          c.normalizedName.includes(term) ||
          aliasEntityIds.has(c.id),
      );
      const limitIdx = args.findIndex((a) => typeof a === 'number' && a > 0);
      const limit = limitIdx >= 0 ? Number(args[limitIdx]) : 25;
      return rows
        .sort((a, b) => a.canonicalName.localeCompare(b.canonicalName) || a.id.localeCompare(b.id))
        .slice(0, limit)
        .map((c) => ({
          id: c.id,
          canonicalName: c.canonicalName,
          normalizedName: c.normalizedName,
          identityScope: c.identityScope,
          tenantId: c.tenantId,
        }));
    }
    if (sql.includes('FROM "entity_identifiers"')) {
      const tenant = String(args[0]);
      let rows = fx.identifiers.filter((i) => i.status === 'active' && visibleTo(i, tenant));
      if (sql.includes('"entity_id" =') && !sql.includes('ANY(')) {
        return rows
          .filter((i) => i.entityId === args[0])
          .map((i) => ({
            identifierType: i.identifierType,
            identifierValue: i.identifierValue,
            sourceType: null,
            verifiedAt: null,
          }));
      }
      const pageIds = (args.find((a) => Array.isArray(a)) ?? []) as string[];
      rows = rows.filter((i) => pageIds.includes(i.entityId));
      return rows.map((i) => ({
        entityId: i.entityId,
        identifierType: i.identifierType,
        identifierValue: i.identifierValue,
      }));
    }
    if (sql.includes('FROM "entity_aliases"')) {
      return fx.aliases
        .filter((a) => a.status === 'active' && a.entityId === args[0] && visibleTo(a, String(args[1])))
        .map((a) => ({ alias: a.alias }));
    }
    if (sql.includes('FROM "federal_award"') && fx.awardAggregateThrows) {
      throw new Error('simulated aggregate outage');
    }
    if (sql.includes('FROM "federal_award"') && sql.includes('ARRAY_AGG')) {
      // Candidate aggregate: GROUP BY recipient_uei with latest-row semantics.
      // Deterministic ordering: action_date DESC NULLS LAST, then row id ASC
      // (same tiebreak the real SQL uses via "id" — mirrored by insertion id).
      const ueis = (args.find((a) => Array.isArray(a)) ?? []) as string[];
      const out: Array<Record<string, unknown>> = [];
      for (const uei of ueis) {
        const rows = fx.awards
          .filter((a) => a.recipientUei === uei)
          .sort(
            (x, y) =>
              (y.actionDate?.getTime() ?? 0) - (x.actionDate?.getTime() ?? 0) ||
              x.id.localeCompare(y.id),
          );
        if (rows.length === 0) continue;
        const latest = rows[0]!;
        out.push({
          recipientUei: uei,
          awardCount: rows.length,
          totalObligations: rows.reduce((s, r) => s + (r.amount != null ? Number(r.amount) : 0), 0),
          latestActionDate: latest.actionDate,
          latestAwardId: latest.awardUniqueId,
          latestFetchedAt: latest.lastSyncedAt,
          latestAmount: latest.amount,
          latestDescription: latest.description,
          latestAwardingAgency: latest.awardingAgency,
          latestContractorName: latest.contractorName,
          latestRecipientState: latest.recipientState,
        });
      }
      return out;
    }
    return [];
  };

  const txFor = (t: string) => ({
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...args: unknown[]) => {
      const sql = strings.join('?');
      calls.rawQueries.push({ sql, args });
      return runRaw(sql, args);
    }),
    businessDevelopmentProspect: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        for (const row of fx.prospects) if (matches(where, row)) return { ...row };
        return null;
      }),
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        fx.prospects.filter((row) => matches(where, row)).map((row) => ({ ...row })),
      ),
    },
    client: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        for (const row of fx.clients) if (matches(where, row)) return { ...row };
        return null;
      }),
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        fx.clients.filter((row) => matches(where, row)).map((row) => ({ ...row })),
      ),
    },
    clientFacility: {
      findMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        fx.facilities.filter((row) => matches(where, row)).map((row) => ({ ...row })),
      ),
    },
    tenant: {
      findUnique: jest.fn(async () => (fx.tenantSettings === undefined ? null : { settings: fx.tenantSettings })),
    },
  });

  const prisma = {
    withTenant: jest.fn(async (t: string, fn: (tx: unknown) => Promise<unknown>) => {
      calls.withTenantCount += 1;
      return fn(txFor(t));
    }),
    // Direct delegate (global projections, no tenant scope): the candidate
    // award aggregate runs here.
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...args: unknown[]) => {
      const sql = strings.join('?');
      calls.rawQueries.push({ sql, args });
      return runRaw(sql, args);
    }),
    // GLOBAL projections: the direct delegate — no tenant scope, all reads
    // recorded for the section-independence assertions.
    federalAward: {
      findMany: jest.fn(async (args: { where: Record<string, unknown>; take?: number; select?: Record<string, unknown> } & Record<string, unknown>) => {
        calls.awardReads.push(args.where);
        let rows = fx.awards.filter((a) => matches(args.where, a as unknown as Record<string, unknown>));
        if (args.orderBy) rows = rows.slice();
        if (args.take != null) rows = rows.slice(0, args.take);
        return rows;
      }),
    },
    federalAssistanceAward: {
      findMany: jest.fn(async (args: { where: Record<string, unknown>; take?: number }) => {
        let rows = fx.assistance.filter((a) => matches(args.where, a as unknown as Record<string, unknown>));
        if (args.take != null) rows = rows.slice(0, args.take);
        return rows;
      }),
    },
    ldaFiling: {
      findMany: jest.fn(async (args: { where: Record<string, unknown>; take?: number }) => {
        let rows = fx.lda.filter((l) => matches(args.where, l as unknown as Record<string, unknown>));
        if (args.take != null) rows = rows.slice(0, args.take);
        return rows;
      }),
    },
    samOpportunity: {
      findMany: jest.fn(async (args: { where: Record<string, unknown>; take?: number }) => {
        let rows = fx.samOpps.filter((s) => matches(args.where, s as unknown as Record<string, unknown>));
        if (args.take != null) rows = rows.slice(0, args.take);
        return rows;
      }),
    },
  } as never;

  const samClient = {
    lookupByUei: jest.fn(async (uei: string) => {
      calls.samUei.push(uei);
      return fx.samLookupByUei
        ? fx.samLookupByUei(uei)
        : { ok: true as const, entities: [SAM_RECORD] };
    }),
    lookupByCage: jest.fn(async (cage: string) => {
      calls.samCage.push(cage);
      return fx.samLookupByCage
        ? fx.samLookupByCage(cage)
        : { ok: true as const, entities: [SAM_RECORD] };
    }),
    lookupByName: jest.fn(),
  } as never;

  const service = new BizDevDossierService(prisma, samClient);
  return { service, calls, prisma, samClient };
};

const baseFixture = (over: Partial<Fixture> = {}): Fixture => ({
  canonical: [],
  identifiers: [],
  aliases: [],
  awards: [],
  assistance: [],
  lda: [],
  samOpps: [],
  prospects: [],
  clients: [],
  facilities: [],
  tenantSettings: {},
  ...over,
});

// ── search: bounded page-level reads + structured whyInspect ────────────────

describe('searchCandidates', () => {
  const fixtureWithOrgs = (): Fixture => {
    const acme = org({ canonicalName: 'Acme Aerospace', normalizedName: 'acme aerospace' });
    const named = org({
      id: 'named-only',
      canonicalName: 'Named Only Co',
      normalizedName: 'named only co',
    });
    return baseFixture({
      canonical: [acme, named],
      identifiers: [
        {
          entityId: acme.id,
          identifierType: 'uei',
          identifierValue: UEI_A,
          identityScope: 'global_public',
          tenantId: null,
          status: 'active',
        },
      ],
      awards: [
        award({ recipientUei: UEI_A, actionDate: new Date('2026-06-15T00:00:00Z') }),
        award({
          awardUniqueId: 'AWARD_older',
          recipientUei: UEI_A,
          amount: 500_000,
          actionDate: new Date('2025-01-01T00:00:00Z'),
        }),
      ],
    });
  };

  test('stable bounded result; exactly page-level queries; no provider call; structured exact-UEI reason', async () => {
    const fx = fixtureWithOrgs();
    const h = makeHarness(fx);
    const res = await h.service.searchCandidates(ctx, { q: 'acme' });

    expect(res.results.map((r) => r.canonicalName).sort()).toEqual(['Acme Aerospace']);
    expect(res.coverage.more).toBe(false);

    // Provider never called during search.
    expect(h.calls.samUei).toHaveLength(0);
    expect(h.calls.samCage).toHaveLength(0);

    // Page-level discipline: exactly ONE canonical search query, ONE
    // identifiers query, ONE award aggregate — no per-result queries.
    const searchQueries = h.calls.rawQueries.filter((q) => q.sql.includes('ILIKE'));
    expect(searchQueries).toHaveLength(1);
    const idQueries = h.calls.rawQueries.filter((q) => q.sql.includes('ANY(') && q.sql.includes('entity_identifiers'));
    expect(idQueries).toHaveLength(1);
    const aggregates = h.calls.rawQueries.filter((q) => q.sql.includes('ARRAY_AGG'));
    expect(aggregates).toHaveLength(1);

    // Deterministic ordering: stable across a repeated identical search.
    const again = await h.service.searchCandidates(ctx, { q: 'acme' });
    expect(again.results.map((r) => r.canonicalEntityId)).toEqual(
      res.results.map((r) => r.canonicalEntityId),
    );

    // Structured source-backed reason for the exact-UEI org.
    const acme = res.results.find((r) => r.canonicalName === 'Acme Aerospace')!;
    expect(acme.whyInspect).not.toBeNull();
    expect(acme.whyInspect).toMatchObject({
      sourceFamily: 'usaspending_contract',
      originalSourceName: 'USAspending',
      recordId: expect.stringMatching(/^AWARD_/),
      eventDate: '2026-06-15',
      relationshipStrength: 'direct',
      status: 'available',
    });
    expect(acme.whyInspect!.locator).toContain('usaspending.gov/award/');
    expect(acme.whyInspect!.fetchedAt).toBeTruthy();
    expect(acme.whyInspect!.title).toContain('2 ingested federal award record(s)');
  });

  test('name-only candidate has NO direct award reason', async () => {
    const fx = fixtureWithOrgs();
    const h = makeHarness(fx);
    const res = await h.service.searchCandidates(ctx, { q: 'Named Only' });
    expect(res.results.map((r) => r.canonicalName)).toEqual(['Named Only Co']);
    expect(res.results[0]!.whyInspect).toBeNull();
    // No award aggregate ran at all (page had no UEIs).
    expect(h.calls.rawQueries.filter((q) => q.sql.includes('ARRAY_AGG'))).toHaveLength(0);
  });

  test('unsupported filters are reported truthfully, never fabricated', async () => {
    const h = makeHarness(baseFixture());
    const res = await h.service.searchCandidates(ctx, {
      q: 'acme',
      agency: 'DoD',
      issue: 'defense',
      geography: 'VA',
    });
    expect(res.coverage.agencyFilterApplied).toBe(false);
    expect(res.coverage.issueFilterApplied).toBe(false);
    expect(res.coverage.geographyFilterApplied).toBe(false);
    expect(res.coverage.unsupportedFilters).toEqual(['agency', 'issue', 'geography']);
  });

  test('identifier visibility predicate includes global-public-or-caller-tenant only', async () => {
    const acme = org();
    const fixture = baseFixture({
      canonical: [acme],
      identifiers: [
        {
          entityId: acme.id,
          identifierType: 'uei',
          identifierValue: 'PUBUEI000001',
          identityScope: 'global_public',
          tenantId: null,
          status: 'active',
        },
        {
          entityId: acme.id,
          identifierType: 'uei',
          identifierValue: 'TENUEI000000A',
          identityScope: 'tenant_private',
          tenantId,
          status: 'active',
        },
        {
          entityId: acme.id,
          identifierType: 'uei',
          identifierValue: 'OTHUEI000000Z',
          identityScope: 'tenant_private',
          tenantId: tenantBId,
          status: 'active',
        },
      ],
    });
    const h = makeHarness(fixture);
    const res = await h.service.searchCandidates(ctx, { q: 'acme' });
    const values = res.results[0]!.identifiers.map((i) => i.value);
    expect(values).toContain('PUBUEI000001');
    expect(values).toContain('TENUEI000000A');
    expect(values).not.toContain('OTHUEI000000Z');
    // The SQL predicate is explicit in the identifiers query.
    const idQuery = h.calls.rawQueries.find((q) => q.sql.includes('ANY(') && q.sql.includes('entity_identifiers'))!;
    expect(idQuery.sql).toContain('global_public');
    expect(idQuery.sql).toContain('tenant_id');
  });

  test('tenant A marker/client-without-prospect never appears for tenant B', async () => {
    const shared = org({ canonicalName: 'Shared Public Co', normalizedName: 'shared public co' });
    const fixture = baseFixture({
      canonical: [shared],
      prospects: [
        {
          id: randomUUID(),
          tenantId,
          canonicalEntityId: shared.id,
          status: 'active',
          stage: 'qualified',
          conflictExcluded: false,
          linkedClientId: null,
        },
      ],
      clients: [
        {
          id: randomUUID(),
          tenantId,
          canonicalEntityId: shared.id,
          name: 'Shared Public Client',
        },
      ],
    });
    const h = makeHarness(fixture);
    const resA = await h.service.searchCandidates(ctx, { q: 'Shared' });
    const resB = await h.service.searchCandidates(ctxB, { q: 'Shared' });

    expect(resA.results[0]!.marker.prospectActive).toBe(true);
    expect(resA.results[0]!.marker.client).toBe(true);
    expect(resA.results[0]!.clientWithoutProspect).toBe(false);

    expect(resB.results[0]!.marker.prospectActive).toBe(false);
    expect(resB.results[0]!.marker.client).toBe(false);
    expect(resB.results[0]!.clientWithoutProspect).toBe(false);
    expect(resB.results[0]!.prospectId).toBeUndefined();
  });

  test('no selected field includes note body or conflictReason', async () => {
    const shared = org();
    const prospectId = randomUUID();
    const fixture = baseFixture({
      canonical: [shared],
      prospects: [
        {
          id: prospectId,
          tenantId,
          canonicalEntityId: shared.id,
          status: 'active',
          stage: 'researching',
          conflictExcluded: true,
          conflictReason: 'opposing counsel — SECRET',
          linkedClientId: null,
        },
      ],
    });
    const h = makeHarness(fixture);
    const res = await h.service.searchCandidates(ctx, { q: 'acme' });
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('conflictReason');
    expect(serialized).not.toContain('SECRET');
    expect(serialized).not.toContain('note');
    // The tenant read selects a fixed safe field set.
    expect(res.results[0]!.marker.excluded).toBe(true);
  });

  // ── Phase 5: structured latestAward + coverage + hypothesis ─────────────

  test('latestAward fields come from the SAME latest row across two distinct awards', async () => {
    const older = award({
      awardUniqueId: 'AWARD_older_v2',
      amount: 250_000.55,
      description: 'OLDER WORK SOW',
      awardingAgency: 'DEPT OF HOMELAND SECURITY',
      contractorName: 'ACME OLD NAME',
      recipientState: 'MD',
      actionDate: new Date('2025-03-01T00:00:00Z'),
      lastSyncedAt: new Date('2025-04-01T00:00:00Z'),
    });
    const newer = award({
      awardUniqueId: 'AWARD_newer_v2',
      amount: '98765.40' as unknown as number, // PG numeric arrives as string
      description: 'NEWER WORK SOW',
      awardingAgency: 'DEPT OF DEFENSE',
      contractorName: 'ACME NEW NAME',
      recipientState: 'VA',
      actionDate: new Date('2026-08-01T00:00:00Z'),
      lastSyncedAt: new Date('2026-08-02T00:00:00Z'),
    });
    const fx = fixtureWithOrgs();
    fx.awards = [older, newer];
    const h = makeHarness(fx);
    const res = await h.service.searchCandidates(ctx, { q: 'acme' });
    const acme = res.results.find((r) => r.canonicalName === 'Acme Aerospace')!;

    expect(acme.whyInspect!.recordId).toBe('AWARD_newer_v2');
    expect(acme.whyInspect!.eventDate).toBe('2026-08-01');
    expect(acme.whyInspect!.fetchedAt).toBe('2026-08-02T00:00:00.000Z');
    // All latestAward values describe the SAME (newer) row — never a mix.
    expect(acme.whyInspect!.latestAward).toEqual({
      obligatedAmountUsd: '98765.40',
      description: 'NEWER WORK SOW',
      awardingAgency: 'DEPT OF DEFENSE',
      recipientName: 'ACME NEW NAME',
      recipientState: 'VA',
    });
    // Aggregate title keeps its own all-awards scope.
    expect(acme.whyInspect!.title).toContain('2 ingested federal award record(s)');
    expect(acme.evidenceCoverage).toBe('available');
  });

  test('tie on action_date breaks by id ASC deterministically', async () => {
    const tieDate = new Date('2026-07-01T00:00:00Z');
    const lo = award({
      id: '00000000-0000-0000-0000-000000000001',
      awardUniqueId: 'AWARD_tie_lowid',
      description: 'LOW ID ROW',
      amount: 111.11,
      actionDate: tieDate,
    });
    const hi = award({
      id: '00000000-0000-0000-0000-000000000002',
      awardUniqueId: 'AWARD_tie_highid',
      description: 'HIGH ID ROW',
      amount: 222.22,
      actionDate: tieDate,
    });
    const fx = fixtureWithOrgs();
    fx.awards = [hi, lo]; // insertion order must not matter
    const h = makeHarness(fx);
    const res = await h.service.searchCandidates(ctx, { q: 'acme' });
    const acme = res.results[0]!;
    expect(acme.whyInspect!.recordId).toBe('AWARD_tie_lowid');
    expect(acme.whyInspect!.latestAward.description).toBe('LOW ID ROW');
  });

  test('null, zero, and negative latest amounts are preserved decimal-safe', async () => {
    // UEI_A in fixtureWithOrgs is fixed; use the same harness per case.
    const cases: Array<{ amount: number | string | null; expected: string | null }> = [
      { amount: null, expected: null },
      { amount: 0, expected: '0.00' },
      { amount: -12500, expected: '-12500.00' },
      { amount: '-0.01' as unknown as number, expected: '-0.01' },
      { amount: '12345.6' as unknown as number, expected: '12345.60' },
      { amount: '9999999999999999.99', expected: '9999999999999999.99' },
      { amount: '1e30', expected: null },
      { amount: '1.234', expected: null },
    ];
    for (const c of cases) {
      const fx = fixtureWithOrgs();
      fx.awards = [award({ amount: c.amount, awardUniqueId: 'AWARD_money_case' })];
      const h = makeHarness(fx);
      const res = await h.service.searchCandidates(ctx, { q: 'acme' });
      expect(res.results[0]!.whyInspect!.latestAward.obligatedAmountUsd).toBe(c.expected);
    }
  });

  test('candidate without UEI is identity_unresolved; exact UEI with no rows is empty_in_queried_scope', async () => {
    const named = org({
      canonicalName: 'Named Only Co',
      normalizedName: 'named only co',
    });
    const ueiNoAwards = org({ canonicalName: 'Quiet UEI Co', normalizedName: 'quiet uei co' });
    const fx = baseFixture({
      canonical: [named, ueiNoAwards],
      identifiers: [
        {
          entityId: ueiNoAwards.id,
          identifierType: 'uei',
          identifierValue: UEI_B,
          identityScope: 'global_public',
          tenantId: null,
          status: 'active',
        },
      ],
    });
    const h = makeHarness(fx);
    const res = await h.service.searchCandidates(ctx, { q: 'co' });

    const quiet = res.results.find((r) => r.canonicalName === 'Quiet UEI Co')!;
    expect(quiet.evidenceCoverage).toBe('empty_in_queried_scope');
    expect(quiet.whyInspect).toBeNull();
    const namedOnly = res.results.find((r) => r.canonicalName === 'Named Only Co')!;
    expect(namedOnly.evidenceCoverage).toBe('identity_unresolved');
    expect(namedOnly.whyInspect).toBeNull();
  });

  test('aggregate outage marks evidenceCoverage error, not empty — and still no extra queries', async () => {
    const fx = fixtureWithOrgs();
    fx.awardAggregateThrows = true;
    const h = makeHarness(fx);
    const res = await h.service.searchCandidates(ctx, { q: 'acme' });
    const acme = res.results[0]!;
    expect(acme.whyInspect).toBeNull();
    expect(acme.evidenceCoverage).toBe('error');
    // Marker coverage stays about markers only.
    expect(acme.markerCoverage).toBe('complete');
    // Fail-soft did not trigger per-result fallback reads.
    expect(h.calls.rawQueries.filter((q) => q.sql.includes('ARRAY_AGG'))).toHaveLength(1);
    expect(h.calls.awardReads).toHaveLength(0);
    expect(h.calls.samUei).toHaveLength(0);
  });

  test('serviceHypothesis comes only from the caller tenant prospect; tenant B sees null', async () => {
    const shared = org({ canonicalName: 'Shared Public Co', normalizedName: 'shared public co' });
    const fixture = baseFixture({
      canonical: [shared],
      prospects: [
        {
          id: randomUUID(),
          tenantId,
          canonicalEntityId: shared.id,
          status: 'active',
          stage: 'qualified',
          conflictExcluded: false,
          linkedClientId: null,
          serviceHypothesis: 'Prime contract pursuit via NAVY',
        },
      ],
    });
    const h = makeHarness(fixture);
    const resA = await h.service.searchCandidates(ctx, { q: 'Shared' });
    const resB = await h.service.searchCandidates(ctxB, { q: 'Shared' });
    expect(resA.results[0]!.serviceHypothesis).toBe('Prime contract pursuit via NAVY');
    expect(resB.results[0]!.serviceHypothesis).toBeNull();
  });

  test('serviceHypothesis and no other prospect text leaks into the response', async () => {
    const shared = org();
    const fixture = baseFixture({
      canonical: [shared],
      prospects: [
        {
          id: randomUUID(),
          tenantId,
          canonicalEntityId: shared.id,
          status: 'active',
          stage: 'researching',
          conflictExcluded: false,
          conflictReason: 'opposing counsel — SECRET',
          linkedClientId: null,
          notes: 'internal note — SECRETNOTE',
          serviceHypothesis: '  Federal   R&D partnerships  ',
        },
      ],
    });
    const h = makeHarness(fixture);
    const res = await h.service.searchCandidates(ctx, { q: 'acme' });
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('SECRET');
    expect(serialized).not.toContain('SECRETNOTE');
    expect(serialized).not.toContain('conflictReason');
    // Hypothesis is verbatim (not normalized).
    expect(res.results[0]!.serviceHypothesis).toBe('  Federal   R&D partnerships  ');
  });
});

// ── dossier section independence ────────────────────────────────────────────

describe('companyDossier section filter', () => {
  const dossierFixture = (): { fx: Fixture; acmeId: string } => {
    const acme = org();
    return {
      fx: baseFixture({
        canonical: [acme],
        identifiers: [
          {
            entityId: acme.id,
            identifierType: 'uei',
            identifierValue: UEI_A,
            identityScope: 'global_public',
            tenantId: null,
            status: 'active',
          },
        ],
        aliases: [],
        awards: [award({ recipientUei: UEI_A })],
        assistance: [],
        lda: [],
        samOpps: [],
      }),
      acmeId: acme.id,
    };
  };

  test('section=lobbying computes the identity anchor + lobbying only — no exposure/signals/footprint reads', async () => {
    const { fx, acmeId } = dossierFixture();
    fx.tenantSettings = {
      clioFeatureFlags: { 'businessDevelopment.provider.sam.enabled': true },
    };
    const h = makeHarness(fx);
    const dossier = await h.service.companyDossier(ctx, acmeId, 'lobbying');

    expect(Object.keys(dossier.sections).sort()).toEqual(['identity', 'lobbying']);
    expect(dossier.sections.lobbying!.status).toBe('empty_in_queried_scope');

    // No award exposure read, no SAM opportunity read (the signals delegate).
    expect(h.calls.awardReads).toHaveLength(0);
    // Exactly one identifiers + one aliases raw read (the anchor) + the
    // unresolved-prospect guard never fired (prospects stay untouched here).
    const idReads = h.calls.rawQueries.filter((q) => q.sql.includes('FROM "entity_identifiers"'));
    expect(idReads).toHaveLength(1);
    const aliasReads = h.calls.rawQueries.filter((q) => q.sql.includes('FROM "entity_aliases"'));
    expect(aliasReads).toHaveLength(1);
    // Progressive non-identity cards reuse the internal anchor but must not
    // repeat the live SAM identity lookup made by section=identity.
    expect(h.calls.samUei).toHaveLength(0);
    expect(h.calls.samCage).toHaveLength(0);
  });

  test('no section filter assembles all sections', async () => {
    const { fx, acmeId } = dossierFixture();
    const h = makeHarness(fx);
    const dossier = await h.service.companyDossier(ctx, acmeId);
    expect(Object.keys(dossier.sections).sort()).toEqual([
      'footprint',
      'government_exposure',
      'identity',
      'lobbying',
      'people',
      'relevant_signals',
    ]);
  });

  test('invisible canonical (other-tenant private / merged) → safe 404', async () => {
    const theirs = org({ identityScope: 'tenant_private', tenantId: tenantBId });
    const merged = org({ mergedIntoEntityId: 'x' });
    const h = makeHarness(baseFixture({ canonical: [theirs, merged] }));
    await expect(h.service.companyDossier(ctx, theirs.id)).rejects.toThrow(NotFoundException);
    await expect(h.service.companyDossier(ctx, merged.id)).rejects.toThrow(NotFoundException);
  });
});

// ── live SAM lookup semantics ───────────────────────────────────────────────

describe('identity SAM lookup', () => {
  const samFixture = (samLookupByUei?: Fixture['samLookupByUei']): { fx: Fixture; id: string } => {
    const acme = org();
    return {
      fx: baseFixture({
        canonical: [acme],
        identifiers: [
          {
            entityId: acme.id,
            identifierType: 'uei',
            identifierValue: UEI_A,
            identityScope: 'global_public',
            tenantId: null,
            status: 'active',
          },
        ],
        aliases: [],
        tenantSettings: {
          clioFeatureFlags: { 'businessDevelopment.provider.sam.enabled': true },
        },
        samLookupByUei,
      }),
      id: acme.id,
    };
  };

  test('enabled: exactly one exact-UEI SAM lookup; success keeps identity available', async () => {
    const { fx, id } = samFixture();
    const h = makeHarness(fx);
    const dossier = await h.service.companyDossier(ctx, id, 'identity');
    expect(h.calls.samUei).toEqual([UEI_A]);
    expect(h.calls.samCage).toHaveLength(0);
    expect(dossier.sections.identity!.status).toBe('available');
    const samEvidence = dossier.sections.identity!.evidence.find(
      (e) => e.sourceFamily === 'sam_entity',
    );
    expect(samEvidence).toBeTruthy();
    expect(samEvidence!.relationshipStrength).toBe('direct');
    expect((dossier.sections.identity!.detail as { samCoverage?: string }).samCoverage).toBe('live_checked');
  });

  test('disabled: zero SAM calls and no manufactured error', async () => {
    const acme = org();
    const h = makeHarness(
      baseFixture({
        canonical: [acme],
        identifiers: [
          {
            entityId: acme.id,
            identifierType: 'uei',
            identifierValue: UEI_A,
            identityScope: 'global_public',
            tenantId: null,
            status: 'active',
          },
        ],
        aliases: [],
        tenantSettings: { clioFeatureFlags: {} },
      }),
    );
    const dossier = await h.service.companyDossier(ctx, acme.id, 'identity');
    expect(h.calls.samUei).toHaveLength(0);
    expect(h.calls.samCage).toHaveLength(0);
    expect(dossier.sections.identity!.status).toBe('available');
    expect(dossier.sections.identity!.statusText).not.toMatch(/could not be completed/i);
  });

  test('no identifier with SAM enabled: zero calls, honest note, status stays available', async () => {
    const acme = org();
    const h = makeHarness(
      baseFixture({
        canonical: [acme],
        identifiers: [],
        aliases: [],
        tenantSettings: {
          clioFeatureFlags: { 'businessDevelopment.provider.sam.enabled': true },
        },
      }),
    );
    const dossier = await h.service.companyDossier(ctx, acme.id, 'identity');
    expect(h.calls.samUei).toHaveLength(0);
    expect(h.calls.samCage).toHaveLength(0);
    expect(dossier.sections.identity!.status).toBe('available');
    expect(dossier.sections.identity!.statusText).toContain('No UEI or CAGE');
  });

  test('SAM error: identity becomes partial, internal evidence retained, other sections unaffected', async () => {
    const samFixtureWithAwards = (
      samLookupByUei?: Fixture['samLookupByUei'],
    ): { fx: Fixture; id: string } => {
      const acme = org();
      return {
        fx: baseFixture({
          canonical: [acme],
          identifiers: [
            {
              entityId: acme.id,
              identifierType: 'uei',
              identifierValue: UEI_A,
              identityScope: 'global_public',
              tenantId: null,
              status: 'active',
            },
          ],
          aliases: [],
          awards: [award({ recipientUei: UEI_A })],
          tenantSettings: {
            clioFeatureFlags: { 'businessDevelopment.provider.sam.enabled': true },
          },
          samLookupByUei,
        }),
        id: acme.id,
      };
    };
    const { fx, id } = samFixtureWithAwards(() => ({
      ok: false as const,
      reason: 'http_error',
      message: 'SAM.gov responded HTTP 429',
    }));
    const h = makeHarness(fx);
    const dossier = await h.service.companyDossier(ctx, id);
    expect(h.calls.samUei).toEqual([UEI_A]);
    const identity = dossier.sections.identity!;
    expect(identity.status).toBe('partial');
    expect((identity.detail as { samCoverage?: string }).samCoverage).toBe('attempted_unconfirmed');
    // Internal evidence retained — canonical record still present.
    expect(identity.evidence.some((e) => e.sourceFamily === 'capiro_canonical_identity')).toBe(true);
    // Other sections are NOT blanked by the SAM failure.
    expect(dossier.sections.government_exposure!.status).not.toBe('error');
    expect(dossier.sections.government_exposure!.evidence.length).toBeGreaterThan(0);
  });

  test('SAM no-match: identity becomes partial, no sam_entity evidence', async () => {
    const { fx, id } = samFixture(() => ({ ok: true as const, entities: [] }));
    const h = makeHarness(fx);
    const dossier = await h.service.companyDossier(ctx, id, 'identity');
    const identity = dossier.sections.identity!;
    expect(identity.status).toBe('partial');
    expect(identity.evidence.some((e) => e.sourceFamily === 'sam_entity')).toBe(false);
    expect(identity.statusText).toContain('no active registration');
  });
});

// ── provider flags do not gate ingested projections ─────────────────────────

describe('ingested projections remain readable with provider flags false', () => {
  test('LDA filings + SAM opportunities readable with all provider flags off', async () => {
    const acme = org();
    const h = makeHarness(
      baseFixture({
        canonical: [acme],
        identifiers: [
          {
            entityId: acme.id,
            identifierType: 'uei',
            identifierValue: UEI_A,
            identityScope: 'global_public',
            tenantId: null,
            status: 'active',
          },
        ],
        aliases: [],
        awards: [award({ recipientUei: UEI_A, awardingAgency: 'DEPT OF DEFENSE' })],
        lda: [
          {
            filingUuid: 'LDA-1',
            filingType: 'Q1',
            filingYear: 2026,
            filingPeriod: 'Q1',
            registrantName: 'Hill Associates',
            clientName: 'Acme Aerospace',
            clientId: 'CLIENT-77',
            income: 40_000,
            issueCodes: ['DEF'],
            dtPosted: new Date('2026-03-01T00:00:00Z'),
            filingDocumentUrl: 'https://lda.senate.gov/filing/LDA-1',
            lastSyncedAt: new Date('2026-03-02T00:00:00Z'),
          },
        ],
        samOpps: [
          {
            noticeId: 'NOTICE-1',
            title: 'Navy solicitation',
            noticeType: 's',
            agency: 'DEPT OF DEFENSE',
            subAgency: 'NAVY',
            office: null,
            postedDate: new Date('2026-08-01T00:00:00Z'),
            responseDeadline: null,
            active: true,
            lastSyncedAt: new Date('2026-08-02T00:00:00Z'),
          },
        ],
        tenantSettings: { clioFeatureFlags: {} },
      }),
    );
    const dossier = await h.service.companyDossier(ctx, acme.id);
    expect(dossier.sections.lobbying!.status).toBe('available');
    expect(dossier.sections.lobbying!.evidence).toHaveLength(1);
    expect(dossier.sections.relevant_signals!.evidence.length).toBeGreaterThan(0);
    // Zero live SAM calls with the flag off.
    expect(h.calls.samUei).toHaveLength(0);
  });
});

// ── LDA semantics ───────────────────────────────────────────────────────────

describe('lobbying section semantics', () => {
  const ldaFixture = (lda: LdaRow[]): { fx: Fixture; id: string } => {
    const acme = org();
    return {
      fx: baseFixture({ canonical: [acme], identifiers: [], aliases: [], lda }),
      id: acme.id,
    };
  };

  const filing = (over: Partial<LdaRow> = {}): LdaRow => ({
    filingUuid: `LDA-${randomUUID().slice(0, 6)}`,
    filingType: 'Q1',
    filingYear: 2026,
    filingPeriod: 'Q1',
    registrantName: 'Hill Associates',
    clientName: 'Acme Aerospace',
    clientId: 'CLIENT-77',
    income: 40_000,
    issueCodes: ['DEF'],
    dtPosted: new Date('2026-03-01T00:00:00Z'),
    filingDocumentUrl: 'https://lda.senate.gov/filing/x',
    lastSyncedAt: new Date('2026-03-02T00:00:00Z'),
    ...over,
  });

  test('exact match: available, conditional strength, full provenance fields', async () => {
    const { fx, id } = ldaFixture([filing()]);
    const h = makeHarness(fx);
    const section = (await h.service.companyDossier(ctx, id, 'lobbying')).sections.lobbying!;
    expect(section.status).toBe('available');
    const ev = section.evidence[0]!;
    expect(ev.relationshipStrength).toBe('conditional');
    expect(ev.locator).toBe('https://lda.senate.gov/filing/x');
    expect(ev.eventDate).toBe('2026-03-01');
    expect(ev.fiscalYear).toBe(2026);
    expect((ev.detail as { clientId: string | null }).clientId).toBe('CLIENT-77');
    expect((ev.detail as { filingPeriod: string | null }).filingPeriod).toBe('Q1');
    expect(ev.fetchedAt).toBe('2026-03-02T00:00:00.000Z');
    expect((ev.detail as { matchBasis: string }).matchBasis).toBe('exact_client_name');
  });

  test('contains-only: partial with unresolved overlap count, no asserted evidence', async () => {
    const { fx, id } = ldaFixture([filing({ clientName: 'Acme Aerospace Holdings GmbH' })]);
    const h = makeHarness(fx);
    const section = (await h.service.companyDossier(ctx, id, 'lobbying')).sections.lobbying!;
    expect(section.status).toBe('partial');
    expect(section.evidence).toHaveLength(0);
    expect((section.detail as { unresolvedNameOverlapCount: number }).unresolvedNameOverlapCount).toBe(1);
  });

  test('no match: empty_in_queried_scope, not a claim of no lobbying', async () => {
    const { fx, id } = ldaFixture([]);
    const h = makeHarness(fx);
    const section = (await h.service.companyDossier(ctx, id, 'lobbying')).sections.lobbying!;
    expect(section.status).toBe('empty_in_queried_scope');
    expect(section.statusText).toContain('not a statement');
  });

  test('read error: error section, other sections unaffected', async () => {
    const { fx, id } = ldaFixture([]);
    const h = makeHarness(fx);
    (h.prisma as unknown as { ldaFiling: { findMany: jest.Mock } }).ldaFiling.findMany.mockRejectedValueOnce(
      new Error('db hiccup'),
    );
    const dossier = await h.service.companyDossier(ctx, id);
    expect(dossier.sections.lobbying!.status).toBe('error');
    expect(dossier.sections.identity!.status).toBe('available');
    expect(dossier.sections.government_exposure).toBeDefined();
  });
});

// ── relevant signals honesty ────────────────────────────────────────────────

describe('relevant signals', () => {
  const signalsFixture = (awards: AwardRow[]): { fx: Fixture; id: string } => {
    const acme = org();
    return {
      fx: baseFixture({
        canonical: [acme],
        identifiers: [
          {
            entityId: acme.id,
            identifierType: 'uei',
            identifierValue: UEI_A,
            identityScope: 'global_public',
            tenantId: null,
            status: 'active',
          },
        ],
        aliases: [],
        awards,
        samOpps: [],
        tenantSettings: {},
      }),
      id: acme.id,
    };
  };

  test('exposure-constrained: without a UEI the section is honest-empty, not thematic guesses', async () => {
    const acme = org();
    const h = makeHarness(baseFixture({ canonical: [acme], identifiers: [], aliases: [] }));
    const section = (await h.service.companyDossier(ctx, acme.id, 'relevant_signals')).sections
      .relevant_signals!;
    expect(section.status).toBe('empty_in_queried_scope');
    expect(section.evidence).toHaveLength(0);
  });

  test('no award rows: honest empty with the exposure basis stated', async () => {
    const { fx, id } = signalsFixture([]);
    const h = makeHarness(fx);
    const section = (await h.service.companyDossier(ctx, id, 'relevant_signals')).sections
      .relevant_signals!;
    expect(section.status).toBe('empty_in_queried_scope');
    expect(section.statusText).toContain('award-exposure basis');
  });

  test('PE evidence: verified UEI-confirmed R-3 prime is direct; unverified stays conditional with honest wording', async () => {
    const { fx, id } = signalsFixture([
      award({
        peCode: '0207412F',
        peCodeSource: 'uei_confirmed_r3_prime',
        peCodeConfidence: 1.0,
        peCodeCandidateCount: 1,
        dodAcqProgramCode: '516',
        dodAcqProgramName: 'SSN 774',
      }),
      award({
        awardUniqueId: 'AWARD_unverified_pe',
        peCode: '0604865F',
        peCodeSource: 'description_regex',
        peCodeConfidence: 0.4,
        peCodeCandidateCount: 3,
      }),
    ]);
    const h = makeHarness(fx);
    const section = (await h.service.companyDossier(ctx, id, 'relevant_signals')).sections
      .relevant_signals!;
    expect(section.status).toBe('partial');

    const peCards = section.evidence.filter((e) =>
      e.detail && 'peCode' in (e.detail as Record<string, unknown>),
    );
    expect(peCards).toHaveLength(2);

    const verified = peCards.find((e) => e.recordId !== 'AWARD_unverified_pe')!;
    expect(verified.relationshipStrength).toBe('direct');
    expect((verified.detail as { peEvidenceStrength: string }).peEvidenceStrength).toBe('direct');
    expect(verified.title).toContain('Award record carrying');

    const unverified = peCards.find((e) => e.recordId === 'AWARD_unverified_pe')!;
    expect(unverified.relationshipStrength).toBe('conditional');
    const unverifiedDetail = unverified.detail as Record<string, unknown>;
    expect(unverifiedDetail.peEvidenceStrength).toBe('conditional');
    expect(String(unverifiedDetail.meaning)).toContain('does not claim that the program element funds');
    expect(String((unverifiedDetail.ambiguityWarning as string | undefined) ?? '')).toContain(
      '3 program elements',
    );
    // PE fields exposed.
    expect(unverifiedDetail.peCode).toBe('0604865F');
    expect(unverifiedDetail.peCodeSource).toBe('description_regex');
    expect(unverifiedDetail.peCodeConfidence).toBe(0.4);
    expect(unverifiedDetail.peCodeCandidateCount).toBe(3);
    expect(verified.detail && (verified.detail as Record<string, unknown>).dodAcqProgramName).toBe('SSN 774');
    // Warnings surfaced at section level.
    expect((section.detail as { peWarnings?: string[] }).peWarnings).toBeTruthy();
  });

  test('SAM notices stay exposure-constrained (issuing agency of the company’s own awards)', async () => {
    const acme = org();
    const h = makeHarness(
      baseFixture({
        canonical: [acme],
        identifiers: [
          {
            entityId: acme.id,
            identifierType: 'uei',
            identifierValue: UEI_A,
            identityScope: 'global_public',
            tenantId: null,
            status: 'active',
          },
        ],
        aliases: [],
        awards: [award({ recipientUei: UEI_A, awardingAgency: 'DEPT OF DEFENSE' })],
        samOpps: [
          {
            noticeId: 'N1',
            title: 'Navy work',
            noticeType: 's',
            agency: 'DEPT OF DEFENSE',
            subAgency: null,
            office: null,
            postedDate: new Date('2026-08-01T00:00:00Z'),
            responseDeadline: null,
            active: true,
            lastSyncedAt: null,
          },
          {
            noticeId: 'N2',
            title: 'Unrelated agency',
            noticeType: 's',
            agency: 'DEPT OF EDUCATION',
            subAgency: null,
            office: null,
            postedDate: new Date('2026-08-01T00:00:00Z'),
            responseDeadline: null,
            active: true,
            lastSyncedAt: null,
          },
        ],
      }),
    );
    const section = (await h.service.companyDossier(ctx, acme.id, 'relevant_signals')).sections
      .relevant_signals!;
    const noticeCards = section.evidence.filter((e) => e.sourceFamily === 'sam_opportunity');
    expect(noticeCards.map((c) => c.recordId)).toEqual(['N1']);
    expect(noticeCards[0]!.relationshipStrength).toBe('thematic');
  });
});

// ── footprint ───────────────────────────────────────────────────────────────

describe('footprint section', () => {
  test('tenant-reviewed facility is distinct from award geography and carries no jobs claim', async () => {
    const acme = org();
    const clientId = randomUUID();
    const h = makeHarness(
      baseFixture({
        canonical: [acme],
        identifiers: [
          {
            entityId: acme.id,
            identifierType: 'uei',
            identifierValue: UEI_A,
            identityScope: 'global_public',
            tenantId: null,
            status: 'active',
          },
        ],
        aliases: [],
        awards: [award({ recipientUei: UEI_A, popState: 'CA', recipientState: 'VA' })],
        clients: [{ id: clientId, tenantId, canonicalEntityId: acme.id, name: 'Acme' }],
        facilities: [
          {
            id: randomUUID(),
            tenantId,
            clientId,
            name: 'Acme Plant 1',
            addressLine: '5 Factory Rd',
            city: 'San Diego',
            state: 'CA',
            zip: '92101',
            congressionalDistrict: '52',
            employeeCount: 250,
            updatedAt: new Date('2026-01-01T00:00:00Z'),
            createdAt: new Date('2025-01-01T00:00:00Z'),
          },
        ],
      }),
    );
    const section = (await h.service.companyDossier(ctx, acme.id, 'footprint')).sections.footprint!;
    expect(section.status).toBe('available');
    const facility = section.evidence.find(
      (e) => (e.detail as { facilityKind?: string }).facilityKind === 'tenant_reviewed',
    );
    const pop = section.evidence.find((e) =>
      e.title.startsWith('Place of performance'),
    );
    expect(facility).toBeTruthy();
    expect(pop).toBeTruthy();
    expect((facility!.detail as { distinctMeaning: string }).distinctMeaning).toContain(
      'distinct from award place of performance',
    );
    expect(String((facility!.detail as { distinctMeaning: string }).distinctMeaning)).toContain(
      'not a jobs claim',
    );
    // Tenant privacy: tenant B sees no facility.
    const sectionB = (await h.service.companyDossier(ctxB, acme.id, 'footprint')).sections.footprint!;
    expect(
      sectionB.evidence.find((e) => (e.detail as { facilityKind?: string }).facilityKind === 'tenant_reviewed'),
    ).toBeUndefined();
  });
});

// ── prospect dossier ────────────────────────────────────────────────────────

describe('prospectDossier', () => {
  test('unresolved prospect returns bounded identity candidates; non-identity sections honestly ambiguous', async () => {
    const prospectId = randomUUID();
    const candidates = [org({ canonicalName: 'Acme Alpha' }), org({ canonicalName: 'Acme Beta' })];
    const h = makeHarness(
      baseFixture({
        canonical: candidates,
        prospects: [
          { id: prospectId, tenantId, displayName: 'Acme', canonicalEntityId: null },
        ],
      }),
    );
    const dossier = await h.service.prospectDossier(ctx, prospectId);
    expect(dossier.identityBasis).toBe('unresolved_prospect');
    const identity = dossier.sections.identity!;
    expect(identity.status).toBe('ambiguous');
    const detail = identity.detail as { candidates: Array<{ canonicalName: string }> };
    expect(detail.candidates.map((c) => c.canonicalName).sort()).toEqual(['Acme Alpha', 'Acme Beta']);
    expect(detail.candidates.length).toBeLessThanOrEqual(5);
    expect(dossier.sections.government_exposure!.status).toBe('ambiguous');
    expect(dossier.sections.lobbying!.status).toBe('ambiguous');
    expect(
      (h.prisma as unknown as { ldaFiling: { findMany: jest.Mock } }).ldaFiling.findMany,
    ).not.toHaveBeenCalled();
    // Section-filtered request never runs the LDA read.
    const filtered = await h.service.prospectDossier(ctx, prospectId, 'identity');
    expect(Object.keys(filtered.sections)).toEqual(['identity']);
  });

  test('cross-tenant guessed prospect id → safe NotFound', async () => {
    const prospectId = randomUUID();
    const h = makeHarness(
      baseFixture({
        prospects: [
          { id: prospectId, tenantId, displayName: 'Acme', canonicalEntityId: null },
        ],
      }),
    );
    await expect(h.service.prospectDossier(ctxB, prospectId)).rejects.toThrow(NotFoundException);
  });

  test('resolved prospect returns the canonical dossier with prospect metadata', async () => {
    const acme = org();
    const prospectId = randomUUID();
    const h = makeHarness(
      baseFixture({
        canonical: [acme],
        identifiers: [
          {
            entityId: acme.id,
            identifierType: 'uei',
            identifierValue: UEI_A,
            identityScope: 'global_public',
            tenantId: null,
            status: 'active',
          },
        ],
        aliases: [],
        awards: [award({ recipientUei: UEI_A })],
        prospects: [
          { id: prospectId, tenantId, displayName: 'Acme', canonicalEntityId: acme.id },
        ],
      }),
    );
    const dossier = await h.service.prospectDossier(ctx, prospectId);
    expect(dossier.canonicalEntityId).toBe(acme.id);
    expect(dossier.identityBasis).toBe('exact_uei');
    expect(dossier.prospect).toEqual({ id: prospectId, displayName: 'Acme' });
    expect(dossier.sections.government_exposure!.evidence.length).toBeGreaterThan(0);
  });
});

// ── people: zero-call by construction ───────────────────────────────────────

describe('people section', () => {
  test('always zero-call/deferred regardless of provider flags', async () => {
    for (const flags of [
      {},
      { 'businessDevelopment.provider.pdlPeople.enabled': true },
      { 'businessDevelopment.provider.pdlCompany.enabled': true },
      {
        'businessDevelopment.provider.pdlPeople.enabled': true,
        'businessDevelopment.provider.pdlCompany.enabled': true,
      },
    ]) {
      const acme = org();
      const h = makeHarness(
        baseFixture({
          canonical: [acme],
          identifiers: [],
          aliases: [],
          tenantSettings: { clioFeatureFlags: flags },
        }),
      );
      const dossier = await h.service.companyDossier(ctx, acme.id, 'people');
      const people = dossier.sections.people!;
      expect(people.evidence).toHaveLength(0);
      expect((people.detail as { callsMade: number }).callsMade).toBe(0);
      expect((people.detail as { providerState: string }).providerState).toBe('deferred');
      expect(h.calls.samUei).toHaveLength(0);
      expect(h.calls.samCage).toHaveLength(0);
    }
  });
});

// ── Phase 3 Jev scheduling: search zero-call; opened dossier BD-ENTITY/BD-SIGNAL ──

describe('Phase 3 Jev scheduling (dossier service)', () => {
  const stagedEvidence = () => ({
    sourceFamily: 'usaspending_contract',
    recordId: 'AWARD_1',
    locator: 'https://usaspending.gov/award/1',
    originalSourceName: 'USAspending',
    originalSourceId: 'AWARD_1',
    claimType: 'relevant_signal',
    relationshipStrength: 'direct',
    eventDate: '2026-06-15',
    effectiveDate: null,
    fiscalYear: 2026,
    stage: 'awarded',
    sourceUpdatedAt: '2026-06-20T00:00:00Z',
    fetchedAt: '2026-06-21T00:00:00Z',
    scopeChecked: 'award',
    status: 'available',
    title: 'Contract award',
    detail: {},
  }) as never;

  const makeJevHarness = (fx: Fixture) => {
    const h = makeHarness(fx);
    const launches: Array<Record<string, unknown>> = [];
    const jev = {
      launchForSubject: jest.fn((input: Record<string, unknown>) => {
        launches.push(input);
      }),
    };
    // Re-construct the service WITH the optional Phase 3 wiring.
    const serviceWithJev: BizDevDossierService = new (
      h.service.constructor as never as new (
        prisma: unknown,
        samClient: unknown,
        jev?: unknown,
      ) => BizDevDossierService
    )(
      (h as unknown as { prisma: unknown }).prisma,
      (h as unknown as { samClient: unknown }).samClient,
      jev,
    );
    return { ...h, service: serviceWithJev, jev, launches };
  };

  test('candidate search NEVER schedules a Jev call', async () => {
    const acme = org({ canonicalName: 'Acme Aerospace', normalizedName: 'acme aerospace' });
    const h = makeJevHarness(
      baseFixture({
        canonical: [acme],
        identifiers: [],
        awards: [],
      }),
    );
    await h.service.searchCandidates(ctx, { q: 'acme' });
    expect(h.jev.launchForSubject).not.toHaveBeenCalled();
    expect(h.launches).toHaveLength(0);
  });

  test('opened UNRESOLVED prospect schedules EXACTLY ONE bd_entity (first candidate)', async () => {
    const prospectId = randomUUID();
    const candA = org({ canonicalName: 'Acme Alpha' });
    const candB = org({ canonicalName: 'Acme Beta' });
    const h = makeJevHarness(
      baseFixture({
        canonical: [candA, candB],
        prospects: [
          { id: prospectId, tenantId, displayName: 'Acme', canonicalEntityId: null },
        ],
      }),
    );
    await h.service.prospectDossier(ctx, prospectId);
    expect(h.launches).toHaveLength(1);
    const launch = h.launches[0]!;
    expect(launch.task).toBe('bd_entity');
    expect(launch.subjectType).toBe('prospect');
    expect(launch.subjectId).toBe(prospectId);
    expect(launch.prospectId).toBe(prospectId);
    // The FIRST deterministically ordered candidate is the evaluated one.
    expect(launch.canonicalEntityId).toBe(candA.id);
    expect((launch.candidate as { canonicalEntityId: string }).canonicalEntityId).toBe(
      candA.id,
    );
    // Phase 2 baseline for the unresolved identity section.
    expect(launch.deterministicOutcome).toBe('identity_unresolved');
    // No bd_signal was scheduled: the identity is unresolved (no canonicalEntityId).
    expect(h.launches.filter((l) => l.task === 'bd_signal')).toHaveLength(0);
  });

  test('opened UNRESOLVED prospect with NO candidates schedules NOTHING', async () => {
    const prospectId = randomUUID();
    const h = makeJevHarness(
      baseFixture({
        prospects: [
          { id: prospectId, tenantId, displayName: 'Acme', canonicalEntityId: null },
        ],
      }),
    );
    await h.service.prospectDossier(ctx, prospectId);
    expect(h.launches).toHaveLength(0);
  });

  test('opened RESOLVED prospect schedules EXACTLY ONE bd_signal for the first staged signal', async () => {
    const acme = org();
    const prospectId = randomUUID();
    const h = makeJevHarness(
      baseFixture({
        canonical: [acme],
        identifiers: [
          {
            entityId: acme.id,
            identifierType: 'uei',
            identifierValue: UEI_A,
            identityScope: 'global_public',
            tenantId: null,
            status: 'active',
          },
        ],
        awards: [award({ recipientUei: UEI_A })],
        prospects: [
          { id: prospectId, tenantId, displayName: 'Acme', canonicalEntityId: acme.id },
        ],
      }),
    );
    const dossier = await h.service.prospectDossier(ctx, prospectId);
    // Phase 2 response unchanged: the returned dossier still has its sections
    // and carries no Jev-visible field.
    expect(dossier.canonicalEntityId).toBe(acme.id);
    expect(JSON.stringify(dossier)).not.toContain('jevSuggestion');
    expect(h.launches).toHaveLength(1);
    const launch = h.launches[0]!;
    expect(launch.task).toBe('bd_signal');
    expect(launch.canonicalEntityId).toBe(acme.id);
    // The scheduler passes the SECTION EVIDENCE list and null baseline; the
    // service bounds the packet to the ONE staged item itself.
    expect(launch.deterministicOutcome).toBeNull();
    expect(Array.isArray(launch.evidence)).toBe(true);
    // No bd_entity was scheduled: the identity is already resolved.
    expect(h.launches.filter((l) => l.task === 'bd_entity')).toHaveLength(0);
  });

  test('Jev wiring ABSENT (legacy construction) → exact Phase 2 behavior, zero launches', async () => {
    const acme = org();
    const prospectId = randomUUID();
    const h = makeHarness(
      baseFixture({
        canonical: [acme],
        identifiers: [
          {
            entityId: acme.id,
            identifierType: 'uei',
            identifierValue: UEI_A,
            identityScope: 'global_public',
            tenantId: null,
            status: 'active',
          },
        ],
        awards: [award({ recipientUei: UEI_A })],
        prospects: [
          { id: prospectId, tenantId, displayName: 'Acme', canonicalEntityId: acme.id },
        ],
      }),
    );
    // No jev double at all — the original two-arg construction.
    const dossier = await h.service.prospectDossier(ctx, prospectId);
    expect(dossier.canonicalEntityId).toBe(acme.id);
  });

  test('section filter: identity-only open of a resolved prospect schedules NOTHING for bd_signal', async () => {
    const acme = org();
    const prospectId = randomUUID();
    const h = makeJevHarness(
      baseFixture({
        canonical: [acme],
        identifiers: [
          {
            entityId: acme.id,
            identifierType: 'uei',
            identifierValue: UEI_A,
            identityScope: 'global_public',
            tenantId: null,
            status: 'active',
          },
        ],
        awards: [award({ recipientUei: UEI_A })],
        prospects: [
          { id: prospectId, tenantId, displayName: 'Acme', canonicalEntityId: acme.id },
        ],
      }),
    );
    await h.service.prospectDossier(ctx, prospectId, 'identity');
    // wants('relevant_signals') is false for an identity-only request.
    expect(h.launches.filter((l) => l.task === 'bd_signal')).toHaveLength(0);
  });
});
