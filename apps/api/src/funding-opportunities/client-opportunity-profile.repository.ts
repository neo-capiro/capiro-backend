/**
 * The I/O half of the client profile: every read that feeds
 * `buildClientOpportunityProfile`, and nothing else.
 *
 * WHY THE CALLER OWNS THE TRANSACTION
 * ----------------------------------
 * These functions take a client/transaction handle rather than opening one. The
 * three callers have genuinely different transaction semantics and P01 must not
 * flatten them:
 *
 *   - the HTTP service reads inside `prisma.withTenant(...)`, so RLS is enforced
 *     by the tenant connection;
 *   - both producers read inside `withBypass(...)`, a transaction that sets
 *     `app.bypass_rls` because a nightly job legitimately walks every tenant.
 *
 * A repository that opened its own transaction would have to pick one, and would
 * either break the producers or quietly drop RLS from the request path.
 *
 * TENANT FACTS AND AWARD HISTORY ARE READ SEPARATELY, ON PURPOSE
 * -------------------------------------------------------------
 * `readClientProfileFacts*` is tenant-scoped and belongs in a SHORT transaction.
 * `readAwardHistory` hits the global `federal_award` / `federal_assistance_award`
 * tables, which are not tenant-scoped, and it is the slow one — up to 5,000 rows
 * per identity set. Holding a tenant transaction open across it is what turns one
 * slow client into a connection-pool problem for every other request.
 *
 * `readAwardHistory` THROWS. It does not swallow.
 * ---------------------------------------------
 * The service wraps it in the try/catch that already logs and degrades to empty
 * history, because that fail-soft is a documented, tested property of the read
 * path. The producers deliberately do NOT wrap it: a nightly job that silently
 * scores every client against empty award history would quietly mark thousands of
 * suggestions stale, and it must crash instead.
 */

import { dedupeStrings } from './client-opportunity-profile.builder.js';
import type { AwardHistoryIdentityV2 } from './award-history-identity.js';
import type {
  AwardHistoryFacts,
  ClientProfileFacts,
  ProfileMapping,
} from './client-opportunity-profile.types.js';

/** Archived or non-ACTIVE clients are not scored. Same predicate all three used. */
export const VISIBLE_CLIENT_FILTER = {
  status: { not: 'archived' },
  profileStatus: 'ACTIVE',
} as const;

/**
 * Bound on award-history rows per identity set. A client with tens of thousands of
 * awards contributes a bounded set of DISTINCT agencies, so this caps work without
 * changing the result in practice.
 */
export const HISTORY_ROW_CAP = 5000;

/**
 * The one client `select`, shared by all three callers.
 *
 * Sharing it is most of the point of P01. Before this, the grant producer selected
 * 6 fields, the SAM producer 8, and the service 12 — so the producers could not
 * have computed the same profile even with identical shaping code, and the SAM
 * producer did not select `uei` at all.
 *
 * A caller that needs only one rail still selects everything. One extra row-wide
 * read per client is cheap; a profile that differs by caller is not.
 */
export const CLIENT_PROFILE_SELECT = {
  id: true,
  name: true,
  uei: true,
  cageCode: true,
  naicsCodes: true,
  pscCodes: true,
  applicantTypes: true,
  setAsideCertifications: true,
  sectorTag: true,
  capabilities: { select: { name: true, tags: true, keywords: true, peNumbers: true } },
  facilities: {
    select: {
      id: true,
      name: true,
      city: true,
      state: true,
      zip: true,
      congressionalDistrict: true,
    },
  },
} as const;

/**
 * Award-bearing mappings only, and only where a reviewer permitted roll-up.
 *
 * All four conditions are load-bearing and none may be relaxed by a caller:
 * `confirmed` and `reviewStatus` are separate gates by design, and `rollUpAwards`
 * must be `true` rather than "not false" — a null roll-up is an unanswered
 * question, not consent.
 */
export const PROFILE_MAPPING_WHERE = {
  confirmed: true,
  reviewStatus: 'confirmed',
  rollUpAwards: true,
  source: { in: ['contracting', 'assistance_recipient'] },
} as const;

export interface RawProfileClientRow {
  id: string;
  name: string | null;
  uei: string | null;
  cageCode: string | null;
  naicsCodes: string[];
  pscCodes: string[];
  applicantTypes: string[];
  setAsideCertifications: string[];
  sectorTag: string | null;
  capabilities: Array<{ name: string; tags: unknown; keywords: string[]; peNumbers: string[] }>;
  facilities: Array<{
    id: string;
    name: string;
    city: string | null;
    state: string | null;
    zip: string | null;
    congressionalDistrict: string | null;
  }>;
}

export interface RawProfileMappingRow {
  clientId: string;
  source: string;
  externalId: string | null;
  externalName: string | null;
  matchBasis: string | null;
  matchTier: number | null;
}

/** Minimal Prisma slice, duck-typed so this is unit-testable without a database. */
export interface ProfileReadClient {
  client: {
    findFirst(args: unknown): Promise<RawProfileClientRow | null>;
    findMany(args: unknown): Promise<RawProfileClientRow[]>;
  };
  clientIntelMapping: {
    findMany(args: unknown): Promise<RawProfileMappingRow[]>;
  };
}

export interface AwardHistoryReadClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
}

/**
 * Narrow a Prisma client or transaction to the slice above.
 *
 * Prisma's generated delegates carry overloaded generic signatures that do not
 * structurally satisfy `findFirst(args: unknown)`, so `TransactionClient` is not
 * assignable to `ProfileReadClient` even though it does everything required. The
 * producers already narrow their own slices the same way
 * (`prisma as unknown as SamCandidatesPrisma`).
 *
 * The cast is centralized here so there is exactly ONE place to look at when
 * asking what is being assumed, rather than an `as unknown as` at each call site.
 * The row types it claims are enforced by `CLIENT_PROFILE_SELECT` being the only
 * select these functions use.
 */
export function asProfileReadClient(tx: unknown): ProfileReadClient {
  return tx as ProfileReadClient;
}

/** Split reviewed mappings into the two identity rails. */
export function splitMappings(rows: RawProfileMappingRow[]): {
  contractingMappings: ProfileMapping[];
  assistanceMappings: ProfileMapping[];
} {
  const contractingMappings: ProfileMapping[] = [];
  const assistanceMappings: ProfileMapping[] = [];
  for (const row of rows) {
    const mapping: ProfileMapping = {
      externalId: row.externalId,
      externalName: row.externalName,
      matchBasis: row.matchBasis ?? null,
      matchTier: row.matchTier ?? null,
    };
    if (row.source === 'contracting') contractingMappings.push(mapping);
    else if (row.source === 'assistance_recipient') assistanceMappings.push(mapping);
  }
  return { contractingMappings, assistanceMappings };
}

/** Pure Prisma-row → facts mapping. No I/O, so a fixture can call it directly. */
export function toClientProfileFacts(
  row: RawProfileClientRow,
  mappings: RawProfileMappingRow[],
): ClientProfileFacts {
  const { contractingMappings, assistanceMappings } = splitMappings(mappings);
  return {
    clientId: row.id,
    name: row.name,
    uei: row.uei,
    cageCode: row.cageCode,
    naicsCodes: row.naicsCodes,
    pscCodes: row.pscCodes,
    applicantTypes: row.applicantTypes,
    setAsideCertifications: row.setAsideCertifications,
    sectorTag: row.sectorTag,
    capabilities: row.capabilities.map((c) => ({
      name: c.name,
      tags: c.tags,
      keywords: c.keywords ?? [],
      peNumbers: c.peNumbers ?? [],
    })),
    facilities: row.facilities.map((f) => ({
      id: f.id,
      name: f.name,
      city: f.city,
      state: f.state,
      zip: f.zip,
      congressionalDistrict: f.congressionalDistrict,
    })),
    contractingMappings,
    assistanceMappings,
  };
}

/** Reviewed mappings for a set of clients, grouped by client id. */
export async function readProfileMappingsByClient(
  tx: ProfileReadClient,
  input: { tenantId?: string; clientIds: string[] },
): Promise<Map<string, RawProfileMappingRow[]>> {
  const byClient = new Map<string, RawProfileMappingRow[]>();
  if (input.clientIds.length === 0) return byClient;
  const rows = await tx.clientIntelMapping.findMany({
    where: {
      ...(input.tenantId ? { tenantId: input.tenantId } : {}),
      clientId: { in: input.clientIds },
      ...PROFILE_MAPPING_WHERE,
    },
    select: {
      clientId: true,
      source: true,
      externalId: true,
      externalName: true,
      // P02: the recorded match basis gates the name fallback. Without these two
      // columns a fuzzy-matched mapping is indistinguishable from a verified one.
      matchBasis: true,
      matchTier: true,
    },
  });
  for (const row of rows) {
    const list = byClient.get(row.clientId) ?? [];
    list.push(row);
    byClient.set(row.clientId, list);
  }
  return byClient;
}

/**
 * One client's facts. Returns null when the client does not exist or is not
 * visible — the caller decides whether that is a 404, because throwing a Nest
 * exception from here would drag `@nestjs/common` into the producer scripts.
 */
export async function readClientProfileFacts(
  tx: ProfileReadClient,
  input: { clientId: string },
): Promise<ClientProfileFacts | null> {
  const row = await tx.client.findFirst({
    where: { id: input.clientId, ...VISIBLE_CLIENT_FILTER },
    select: CLIENT_PROFILE_SELECT,
  });
  if (!row) return null;
  const mappings = await readProfileMappingsByClient(tx, { clientIds: [row.id] });
  return toClientProfileFacts(row, mappings.get(row.id) ?? []);
}

/**
 * Facts for many clients in one tenant, for the producers.
 *
 * `take` is still accepted because both producers still pass their client cap.
 * P03 and P04 replace that cap with a keyset walk; this signature does not need
 * to change when they do, because `take` is a page size there rather than a
 * coverage boundary.
 */
export async function readClientProfileFactsMany(
  tx: ProfileReadClient,
  input: { tenantId: string; clientId?: string | null; take?: number; cursor?: string | null },
): Promise<ClientProfileFacts[]> {
  const rows = await tx.client.findMany({
    where: {
      tenantId: input.tenantId,
      ...VISIBLE_CLIENT_FILTER,
      ...(input.clientId ? { id: input.clientId } : {}),
      ...(input.cursor ? { id: { gt: input.cursor } } : {}),
    },
    select: CLIENT_PROFILE_SELECT,
    orderBy: { id: 'asc' },
    ...(input.take != null ? { take: input.take } : {}),
  });
  const mappings = await readProfileMappingsByClient(tx, {
    tenantId: input.tenantId,
    clientIds: rows.map((r) => r.id),
  });
  return rows.map((row) => toClientProfileFacts(row, mappings.get(row.id) ?? []));
}

/**
 * Resolve `federal_contractor.id` -> `federal_contractor.uei` for a batch.
 *
 * This is the join P02 adds. A `contracting` mapping's `externalId` is a
 * `federal_contractor` UUID, so before P02 the contract rail had no verified
 * identifier available and fell through to matching on names — the exact UEI was
 * one join away and never read.
 *
 * `federal_contractor` is a GLOBAL reference table (no `tenant_id`, no RLS), so
 * this is safe to run outside the tenant transaction, and it must be: it is
 * batched across a whole client page rather than issued per client.
 */
export async function resolveContractorUeis(
  prisma: AwardHistoryReadClient,
  contractorIds: string[],
): Promise<Map<string, string | null>> {
  const index = new Map<string, string | null>();
  if (contractorIds.length === 0) return index;
  // tenant-scope-exempt: federal_contractor is public federal reference data with
  // no tenant_id, same as federal_award and federal_assistance_award.
  const rows = await prisma.$queryRaw<{ id: string; uei: string | null }>`
    SELECT id::text AS id, uei
    FROM federal_contractor
    WHERE id = ANY(${contractorIds}::uuid[])
  `;
  for (const row of rows) index.set(row.id, row.uei);
  return index;
}

/**
 * Award history for one client, read under ONE basis per rail.
 *
 * The pre-P02 query OR'd an exact-UEI list with a reviewed-name list in a single
 * predicate, which made a name as authoritative as a verified identifier and left
 * no way to tell which rows arrived by which route. Each rail now issues exactly
 * one query, keyed on whichever basis `buildAwardHistoryIdentity` selected — or no
 * query at all when the basis is `none`.
 *
 * THROWS. See the file docblock for why the read path and the producers want
 * different failure behavior.
 */
export async function readAwardHistoryByBasis(
  prisma: AwardHistoryReadClient,
  identity: AwardHistoryIdentityV2,
): Promise<AwardHistoryFacts> {
  const assistanceRows = async () => {
    if (identity.assistance.basis === 'exact_uei') {
      return prisma.$queryRaw<{
        assistance_listing_number: string | null;
        awarding_agency: string | null;
      }>`
        SELECT DISTINCT assistance_listing_number, awarding_agency
        FROM federal_assistance_award
        WHERE recipient_uei = ANY(${identity.assistance.ueis}::text[])
        LIMIT ${HISTORY_ROW_CAP}
      `;
    }
    if (identity.assistance.basis === 'reviewed_name_fallback') {
      return prisma.$queryRaw<{
        assistance_listing_number: string | null;
        awarding_agency: string | null;
      }>`
        SELECT DISTINCT assistance_listing_number, awarding_agency
        FROM federal_assistance_award
        WHERE lower(recipient_name) = ANY(${identity.assistance.fallbackNames}::text[])
        LIMIT ${HISTORY_ROW_CAP}
      `;
    }
    return [];
  };

  const contractRows = async () => {
    if (identity.contract.basis === 'exact_uei') {
      return prisma.$queryRaw<{
        awarding_agency: string | null;
        awarding_sub_tier: string | null;
      }>`
        SELECT DISTINCT awarding_agency, awarding_sub_tier
        FROM federal_award
        WHERE recipient_uei = ANY(${identity.contract.ueis}::text[])
        LIMIT ${HISTORY_ROW_CAP}
      `;
    }
    if (identity.contract.basis === 'reviewed_name_fallback') {
      return prisma.$queryRaw<{
        awarding_agency: string | null;
        awarding_sub_tier: string | null;
      }>`
        SELECT DISTINCT awarding_agency, awarding_sub_tier
        FROM federal_award
        WHERE lower(contractor_name) = ANY(${identity.contract.fallbackNames}::text[])
        LIMIT ${HISTORY_ROW_CAP}
      `;
    }
    return [];
  };

  const [assistance, contracts] = await Promise.all([assistanceRows(), contractRows()]);

  return {
    assistanceListings: dedupeStrings(assistance.map((r) => r.assistance_listing_number)),
    assistanceAgencies: dedupeStrings(assistance.map((r) => r.awarding_agency)),
    // Both tiers are agency evidence, and both granularities are needed:
    // `sam_opportunity.agency` is sub-tier shaped ('DEPT OF THE NAVY'), so
    // `awarding_agency` alone ('Department of Defense') never matched a notice.
    contractAgencies: dedupeStrings([
      ...contracts.map((r) => r.awarding_agency),
      ...contracts.map((r) => r.awarding_sub_tier),
    ]),
    contractOffices: [],
    basis: {
      contract: identity.contract.basis,
      assistance: identity.assistance.basis,
    },
  };
}
