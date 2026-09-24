import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { normalizeCompanyName } from '../vendor-reference/vendor-name.util.js';
import {
  VendorReferenceSamClient,
  type SamEntityRecord,
} from '../vendor-reference/vendor-reference-sam.client.js';
import {
  businessDevelopmentLdaEnabled,
  businessDevelopmentPdlCompanyEnabled,
  businessDevelopmentPdlPeopleEnabled,
  businessDevelopmentSamEnabled,
} from '../common/tenant-flags.js';
import type {
  DossierSection,
  DossierSectionKind,
  DossierSectionState,
  EvidenceItem,
  EvidenceRelationshipStrength,
  EvidenceStage,
  EvidenceStatus,
} from './bizdev-evidence.types.js';

/**
 * Business Development Phase 2 — deterministic candidate discovery and the
 * normalized-evidence company dossier, read-only.
 *
 * Invariants:
 * 1.  Tenant-private state is joined ONLY inside `prisma.withTenant` with
 *     explicit tenant predicates (same rule as Phase 1 service; the DB RLS is
 *     defense in depth). Tenant markers returned never include note text,
 *     conflict reasons, or preference contents.
 * 2.  Candidate search is page-level bounded reads: one bounded canonical
 *     name/alias/identifier query, one page identifiers query, ONE award
 *     aggregate over all page UEIs (grouped in memory), and ONE tenant
 *     transaction batching prospects + clients for every canonical id on the
 *     page. Deterministic ordering, stable offset paging, no live
 *     SAM/LDA/provider calls, no people enrichment, no per-result queries.
 * 3.  Identity joins reuse the Phase 1 visibility rules for canonical rows
 *     (global_public OR tenant-owned) and the vendor-reference rail
 *     exclusivity: exact UEI first; without a UEI, EXACT normalized-name
 *     equality only; name-only matches are labeled conditional/unresolved.
 *     Phase 1 `resolveIdentity` (canonical A→B, same prospect row/history) is
 *     untouched — this service only READS.
 * 4.  Provider flags gate LIVE adapters only. Already-ingested FederalAward,
 *     FederalAssistanceAward, SamOpportunity, and LdaFiling projections stay
 *     readable when the provider flags are false. PDL is zero-call/deferred.
 * 5.  Section independence: each dossier section resolves under its own
 *     fail-soft wrapper. A `?section=` request computes the minimum identity
 *     anchor plus ONLY that section — never every section, never unrelated
 *     provider/projection work. A no-section request may assemble all.
 * 6.  The live SAM adapter (VendorReferenceSamClient) is used for AT MOST ONE
 *     exact-UEI-or-exact-CAGE lookup in the identity section when the SAM flag
 *     is on. Never a name search; never overwrites canonical identity. Any
 *     failure (disabled/missing key/quota/HTTP/no-match) affects identity
 *     coverage only — every other section still assembles.
 */

const SEARCH_TERM_MIN = 2;
const SEARCH_TERM_MAX = 200;
const SEARCH_LIMIT_DEFAULT = 10;
const SEARCH_LIMIT_CAP = 25;
const SEARCH_OFFSET_CAP = 500;

const EXPOSURE_CONTRACT_CAP = 10;
const EXPOSURE_ASSISTANCE_CAP = 10;
const SIGNAL_CAP = 8;
const SIGNAL_AGENCY_SCAN_CAP = 30;
const LDA_CAP = 12;
const LDA_SCAN_CAP = 50;
const FOOTPRINT_CAP = 12;
const FACILITY_CAP = 12;

/** Cached tenant settings + server-evaluated provider gates for one request. */
interface ProviderPolicy {
  samEnabled: boolean;
  ldaEnabled: boolean;
  pdlCompanyEnabled: boolean;
  pdlPeopleEnabled: boolean;
}

export interface BizDevCandidate {
  canonicalEntityId: string;
  canonicalName: string;
  identityScope: 'global_public' | 'tenant_private';
  /** Display-safe identifiers from the canonical record (UEI/CAGE only). */
  identifiers: Array<{ type: string; value: string }>;
  /** Structured, record-backed reason to inspect — null when we have none. */
  whyInspect: WhyInspectReason | null;
  /** Coverage: whether marker state is a complete read or a partial one. */
  markerCoverage: 'complete' | 'partial';
  marker: {
    prospectActive: boolean;
    prospectDismissed: boolean;
    client: boolean;
    excluded: boolean;
  };
  /** True when a same-tenant Client references this canonical entity but no
   * prospect row exists for it (firm-known organization, no pipeline state). */
  clientWithoutProspect: boolean;
  prospectId?: string;
  linkedClientId?: string | null;
  stage?: string | null;
}

export interface BizDevSearchResult {
  results: BizDevCandidate[];
  coverage: {
    /** Truthful filter support. Unsupported filters are reported, never fabricated. */
    agencyFilterApplied: boolean;
    issueFilterApplied: boolean;
    geographyFilterApplied: boolean;
    unsupportedFilters: string[];
    more: boolean;
    offset: number;
    limit: number;
  };
}

interface CanonicalOrgRow {
  id: string;
  canonicalName: string;
  normalizedName: string;
  identityScope: string;
  tenantId: string | null;
}

interface IdentifierRow {
  entityId: string;
  identifierType: string;
  identifierValue: string;
}

interface AwardAggregateRow {
  recipientUei: string;
  awardCount: number;
  totalObligations: unknown;
  latestActionDate: Date | string | null;
  latestAwardId: string | null;
  latestFetchedAt: Date | string | null;
}

/**
 * Structured, source-backed reason to inspect a candidate — or null when we
 * have none. `recordId`/`eventDate`/`fetchedAt` come from the LATEST exact-UEI
 * award row (ordered aggregate, no per-result queries), so the reason is
 * always traceable to one ingested record.
 */
export interface WhyInspectReason {
  title: string;
  eventDate: string | null;
  sourceFamily: 'usaspending_contract';
  originalSourceName: string;
  recordId: string;
  locator: string;
  fetchedAt: string | null;
  relationshipStrength: 'direct';
  status: 'available';
}

const isoDate = (d: Date | string | null | undefined): string | null => {
  if (d == null) return null;
  if (d instanceof Date) return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  const s = String(d).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
};

const isoDateTime = (d: Date | string | null | undefined): string | null => {
  if (d == null) return null;
  if (d instanceof Date) return Number.isNaN(d.getTime()) ? null : d.toISOString();
  const parsed = new Date(String(d));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const usd = (v: unknown): string | null => {
  const n = num(v);
  return n == null ? null : `$${Math.round(n).toLocaleString('en-US')}`;
};

const sectionState = (
  section: DossierSectionKind,
  status: EvidenceStatus,
  statusText: string,
): DossierSectionState => ({ section, status, statusText });

const EMPTY_SECTION_TEXTS: Record<DossierSectionKind, string> = {
  identity: 'No canonical identity records are available for this organization.',
  government_exposure:
    'No federal award or vehicle records matched this organization in Capiro’s ingested data.',
  relevant_signals: 'No relevant signals were found for this organization.',
  footprint: 'No place-of-performance or facility records were found.',
  lobbying: 'No lobbying disclosure records matched.',
  people: 'People enrichment is not available for this organization yet.',
};

const emptySection = <T extends Record<string, unknown>>(
  section: DossierSectionKind,
  status: EvidenceStatus,
  statusText: string,
  detail: T,
): DossierSection<T> => ({
  section,
  status,
  statusText,
  evidence: [],
  detail,
});

/** Dossier identity anchor: the minimum context sections need. */
interface IdentityAnchor {
  section: DossierSection<IdentityDetail>;
  detail: IdentityDetail;
}

@Injectable()
export class BizDevDossierService {
  private readonly logger = new Logger(BizDevDossierService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly samClient: VendorReferenceSamClient,
  ) {}

  /**
   * GLOBAL projection tables (federal_award, federal_assistance_award,
   * lda_filing, sam_opportunity) have no tenant_id, so PrismaService's
   * tenant-scope hook never constrains them — the same direct-delegate pattern
   * VendorReferenceService uses. Tenant-private state is NEVER read through
   * this handle, only via withTenant.
   */
  private get direct() {
    return this.prisma;
  }

  // ── provider policy (server-side, per request) ───────────────────────────

  async resolveProviderPolicy(tenantId: string): Promise<ProviderPolicy> {
    const tenant = await this.prisma.withTenant(tenantId, (tx) =>
      tx.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } }),
    );
    const settings = tenant?.settings ?? null;
    return {
      samEnabled: businessDevelopmentSamEnabled(settings),
      ldaEnabled: businessDevelopmentLdaEnabled(settings),
      pdlCompanyEnabled: businessDevelopmentPdlCompanyEnabled(settings),
      pdlPeopleEnabled: businessDevelopmentPdlPeopleEnabled(settings),
    };
  }

  // ── candidate search ─────────────────────────────────────────────────────

  /**
   * Bounded, deterministic candidate search over governed canonical
   * organization data. PAGE-LEVEL bounded reads only (see invariant 2). No
   * live provider calls, no per-result queries. agency/issue/geography filters
   * are NOT supported by the underlying projections; instead of fabricating a
   * filtered result we return coverage metadata stating they were not applied.
   */
  async searchCandidates(
    ctx: TenantContext,
    query: {
      q: string;
      agency?: string;
      issue?: string;
      geography?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<BizDevSearchResult> {
    const term = query.q?.trim() ?? '';
    if (term.length < SEARCH_TERM_MIN || term.length > SEARCH_TERM_MAX) {
      throw new BadRequestException('q must be between 2 and 200 characters');
    }
    const limit = Math.min(Math.max(query.limit ?? SEARCH_LIMIT_DEFAULT, 1), SEARCH_LIMIT_CAP);
    const offset = Math.min(Math.max(query.offset ?? 0, 0), SEARCH_OFFSET_CAP);

    const unsupported: string[] = [];
    if (query.agency?.trim()) unsupported.push('agency');
    if (query.issue?.trim()) unsupported.push('issue');
    if (query.geography?.trim()) unsupported.push('geography');

    const coverage = {
      agencyFilterApplied: false,
      issueFilterApplied: false,
      geographyFilterApplied: false,
      unsupportedFilters: unsupported,
      more: false,
      offset,
      limit,
    };

    const orgs = await this.prisma.withTenant(ctx.tenantId, async (tx) =>
      // CanonicalEntity/EntityAlias/EntityIdentifier are mixed-scope tables;
      // raw SQL keeps the visibility predicate explicit (Phase 1 precedent).
      tx
        .$queryRaw<Array<CanonicalOrgRow>>`SELECT ce."id", ce."canonical_name" AS "canonicalName", ce."normalized_name" AS "normalizedName",
                ce."identity_scope" AS "identityScope", ce."tenant_id" AS "tenantId"
         FROM "canonical_entities" ce
         WHERE ce."merged_into_entity_id" IS NULL
           AND ce."status" = 'active'
           AND ce."entity_type" = 'organization'
           AND (ce."identity_scope" = 'global_public' OR ce."tenant_id" = ${ctx.tenantId}::uuid)
           AND (
             ce."canonical_name" ILIKE ${`%${term}%`}
             OR ce."normalized_name" LIKE ${`%${term.toLowerCase()}%`}
             OR EXISTS (
               SELECT 1 FROM "entity_aliases" ea
               WHERE ea."entity_id" = ce."id" AND ea."status" = 'active'
                 AND (
                   ea."identity_scope" = 'global_public' OR ea."tenant_id" = ${ctx.tenantId}::uuid
                 )
                 AND (
                   ea."normalized_alias" LIKE ${`%${term.toLowerCase()}%`}
                   OR ea."alias" ILIKE ${`%${term}%`}
                 )
             )
             OR EXISTS (
               SELECT 1 FROM "entity_identifiers" ei
               WHERE ei."entity_id" = ce."id" AND ei."status" = 'active'
                 AND (
                   ei."identity_scope" = 'global_public' OR ei."tenant_id" = ${ctx.tenantId}::uuid
                 )
                 AND ei."normalized_value" = ${term.toUpperCase()}
             )
           )
         ORDER BY ce."canonical_name" ASC, ce."id" ASC
         LIMIT ${limit + 1} OFFSET ${offset}`,
    );

    const more = orgs.length > limit;
    const page = orgs.slice(0, limit);
    coverage.more = more;
    if (page.length === 0) return { results: [], coverage };

    const pageIds = page.map((o) => o.id);

    // ONE identifiers query for the whole page (identifier rows carry their
    // own identity_scope, so the visibility predicate is explicit again).
    const identifierRows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRaw<Array<IdentifierRow>>`SELECT ei."entity_id" AS "entityId", ei."identifier_type" AS "identifierType", ei."identifier_value" AS "identifierValue"
         FROM "entity_identifiers" ei
         WHERE ei."status" = 'active'
           AND (ei."identity_scope" = 'global_public' OR ei."tenant_id" = ${ctx.tenantId}::uuid)
           AND ei."identifier_type" IN ('uei', 'cage')
           AND ei."entity_id" = ANY(${pageIds}::uuid[])`,
    );
    const idsByEntity = new Map<string, IdentifierRow[]>();
    for (const row of identifierRows) {
      const bucket = idsByEntity.get(row.entityId) ?? [];
      bucket.push(row);
      idsByEntity.set(row.entityId, bucket);
    }

    // ONE award aggregate for every page UEI (global projection, no tenant
    // scope), grouped in memory — the whyInspect basis is exact-UEI recipient
    // rows only. A page without any UEI skips the query entirely.
    const pageUeis = Array.from(
      new Set(
        identifierRows
          .filter((r) => r.identifierType === 'uei' && r.identifierValue)
          .map((r) => r.identifierValue),
      ),
    );
    const awardAggByUei = new Map<
      string,
      {
        count: number;
        total: string | null;
        latest: string | null;
        latestAwardId: string | null;
        latestFetchedAt: string | null;
      }
    >();
    if (pageUeis.length > 0) {
      try {
        // DISTINCT-compatible ordered aggregate: latest award id/date/fetched
        // time per UEI in ONE query (window fn, not per-result reads).
        const aggRows = await this.direct.$queryRaw<Array<AwardAggregateRow>>`
          SELECT "recipient_uei" AS "recipientUei", COUNT(*)::int AS "awardCount",
                 SUM("amount") AS "totalObligations", MAX("action_date") AS "latestActionDate",
                 (ARRAY_AGG("award_unique_id" ORDER BY "action_date" DESC NULLS LAST, "id" ASC))[1] AS "latestAwardId",
                 (ARRAY_AGG("last_synced_at" ORDER BY "action_date" DESC NULLS LAST, "id" ASC))[1] AS "latestFetchedAt"
          FROM "federal_award"
          WHERE "recipient_uei" = ANY(${pageUeis}::text[])
          GROUP BY "recipient_uei"`;
        for (const row of aggRows) {
          awardAggByUei.set(row.recipientUei, {
            count: num(row.awardCount) ?? 0,
            total: usd(row.totalObligations),
            latest: isoDate(row.latestActionDate),
            latestAwardId: row.latestAwardId,
            latestFetchedAt: isoDateTime(row.latestFetchedAt),
          });
        }
      } catch (e) {
        this.logger.warn(
          `candidate award aggregate failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        // Honest partial: candidates still return, without award-based
        // whyInspect and with markerCoverage downgraded below.
      }
    }

    // ONE tenant transaction batching BOTH prospects and clients for every
    // canonical id on the page. Never selects note text, conflict reasons,
    // or preference contents.
    const [prospects, clients] = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      Promise.all([
        tx.businessDevelopmentProspect.findMany({
          where: { tenantId: ctx.tenantId, canonicalEntityId: { in: pageIds } },
          select: {
            id: true,
            canonicalEntityId: true,
            status: true,
            stage: true,
            conflictExcluded: true,
            linkedClientId: true,
          },
        }),
        tx.client.findMany({
          where: { tenantId: ctx.tenantId, canonicalEntityId: { in: pageIds } },
          select: { id: true, canonicalEntityId: true },
        }),
      ]),
    );
    const prospectByEntity = new Map<string, (typeof prospects)[number]>();
    for (const p of prospects) {
      if (p.canonicalEntityId) prospectByEntity.set(p.canonicalEntityId, p);
    }
    const clientIdsByEntity = new Map<string, string[]>();
    for (const c of clients) {
      if (!c.canonicalEntityId) continue;
      const bucket = clientIdsByEntity.get(c.canonicalEntityId) ?? [];
      bucket.push(c.id);
      clientIdsByEntity.set(c.canonicalEntityId, bucket);
    }

    const results: BizDevCandidate[] = page.map((org) => {
      const identifiers = (idsByEntity.get(org.id) ?? [])
        .map((r) => ({ type: r.identifierType, value: r.identifierValue }))
        .slice(0, 4);

      const uei = identifiers.find((i) => i.type === 'uei')?.value ?? null;
      let whyInspect: WhyInspectReason | null = null;
      if (uei) {
        const agg = awardAggByUei.get(uei);
        if (agg && agg.count > 0 && agg.latestAwardId) {
          const total = agg.total ?? 'an unrevealed total';
          const when = agg.latest ? `, most recent action ${agg.latest}` : '';
          whyInspect = {
            title: `Named recipient on ${agg.count} ingested federal award record(s) (obligations ${total}${when}).`,
            eventDate: agg.latest,
            sourceFamily: 'usaspending_contract',
            originalSourceName: 'USAspending',
            recordId: agg.latestAwardId,
            locator: `https://www.usaspending.gov/award/${agg.latestAwardId}`,
            fetchedAt: agg.latestFetchedAt,
            relationshipStrength: 'direct',
            status: 'available',
          };
        }
      }

      const prospect = prospectByEntity.get(org.id) ?? null;
      const linkedClientIds = clientIdsByEntity.get(org.id) ?? [];
      const client = linkedClientIds.length > 0 || prospect?.linkedClientId != null;
      const marker = {
        prospectActive: prospect?.status === 'active',
        prospectDismissed: prospect?.status === 'dismissed',
        client,
        excluded: prospect?.conflictExcluded === true,
      };
      return {
        canonicalEntityId: org.id,
        canonicalName: org.canonicalName,
        identityScope: org.identityScope === 'tenant_private' ? 'tenant_private' : 'global_public',
        identifiers,
        whyInspect,
        // The marker read is complete even when the award aggregate failed;
        // `partial` is reserved for a marker read that itself failed.
        markerCoverage: 'complete',
        marker,
        clientWithoutProspect: !prospect && linkedClientIds.length > 0,
        prospectId: prospect ? prospect.id : undefined,
        linkedClientId: prospect?.linkedClientId ?? null,
        stage: prospect?.stage ?? null,
      };
    });

    return { results, coverage };
  }

  // ── dossier ──────────────────────────────────────────────────────────────

  /**
   * Company dossier by canonical entity id, visibility-validated under the
   * same rules as Phase 1 (global_public OR this tenant's private rows;
   * merged-away rows are not inspectable). `?section=` computes the identity
   * anchor plus ONLY that section; a no-section request assembles all.
   */
  async companyDossier(
    ctx: TenantContext,
    canonicalEntityId: string,
    sectionFilter?: DossierSectionKind,
  ): Promise<BizDevDossier> {
    const org = await this.findVisibleCanonicalOrganization(ctx, canonicalEntityId);
    if (!org) throw new NotFoundException('Canonical entity not found');
    const policy = await this.resolveProviderPolicy(ctx.tenantId);
    return this.buildDossier(ctx, org, policy, sectionFilter);
  }

  /**
   * Prospect dossier (tenant-owned only; safe 404 on guessed/cross-tenant
   * ids, Phase 1 semantics). Resolved prospects (canonicalEntityId set) return
   * the dossier for that canonical entity. Unresolved prospects return an
   * identity section carrying candidate options/ambiguity; every other
   * requested section is honestly marked unresolved, never falsely empty.
   */
  async prospectDossier(
    ctx: TenantContext,
    prospectId: string,
    sectionFilter?: DossierSectionKind,
  ): Promise<BizDevDossier> {
    const prospect = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.businessDevelopmentProspect.findFirst({
        where: { tenantId: ctx.tenantId, id: prospectId },
        select: {
          id: true,
          displayName: true,
          canonicalEntityId: true,
        },
      }),
    );
    if (!prospect) throw new NotFoundException('Prospect not found');

    const sections: Partial<Record<DossierSectionKind, DossierSection<Record<string, unknown>>>> = {};

    // Unresolved prospects: identity candidates + honest unresolved sections.
    if (!prospect.canonicalEntityId) {
      const policy = await this.resolveProviderPolicy(ctx.tenantId);
      const wants = (kind: DossierSectionKind) => !sectionFilter || sectionFilter === kind;
      // ?section= computes the identity anchor plus only the requested
      // section — unresolved non-identity sections are cheap stateless
      // placeholders, but a filtered request still never runs the LDA read.
      if (wants('identity')) {
        sections.identity = (await this.unresolvedIdentitySection(
          ctx,
          prospect,
        )) as DossierSection<Record<string, unknown>>;
      }
      const unresolved = (kind: DossierSectionKind, claimType: EvidenceItem['claimType']) =>
        emptySection(kind, 'ambiguous', 'This prospect’s organization identity is not confirmed yet; this section cannot be checked until it is.', {
          reason: 'identity_unresolved',
          claimType,
        });
      if (wants('government_exposure')) sections.government_exposure = unresolved('government_exposure', 'government_exposure');
      if (wants('relevant_signals')) sections.relevant_signals = unresolved('relevant_signals', 'relevant_signal');
      if (wants('footprint')) sections.footprint = unresolved('footprint', 'footprint');
      if (wants('lobbying')) sections.lobbying = unresolved('lobbying', 'lobbying');
      if (wants('people')) sections.people = this.peopleSection(policy);
      return finalizeDossier(
        {
          canonicalEntityId: null,
          canonicalName: null,
          identityScope: null,
          identityBasis: 'unresolved_prospect',
          generatedAt: new Date().toISOString(),
          sections,
          prospect: { id: prospect.id, displayName: prospect.displayName },
        },
        sectionFilter,
      );
    }

    const org = await this.findVisibleCanonicalOrganization(ctx, prospect.canonicalEntityId);
    if (!org) throw new NotFoundException('Canonical entity not found');
    const policy = await this.resolveProviderPolicy(ctx.tenantId);
    const dossier = await this.buildDossier(ctx, org, policy, sectionFilter);
    return { ...dossier, prospect: { id: prospect.id, displayName: prospect.displayName } };
  }

  // ── dossier composition ──────────────────────────────────────────────────

  private async buildDossier(
    ctx: TenantContext,
    org: { id: string; canonicalName: string; identityScope: string },
    policy: ProviderPolicy,
    sectionFilter: DossierSectionKind | undefined,
  ): Promise<BizDevDossier> {
    // Minimum identity anchor: always computed first (it feeds the UEI/names
    // every other section needs), regardless of the filter. Live SAM
    // enrichment belongs only to an identity/full request. A progressive UI
    // loads identity once and then requests the other sections separately;
    // suppressing SAM for those supporting anchors prevents one charged/live
    // lookup per section while preserving the internal UEI/CAGE join.
    const identityPolicy =
      sectionFilter && sectionFilter !== 'identity' ? { ...policy, samEnabled: false } : policy;
    const anchor = await this.identityAnchor(ctx, org, identityPolicy);
    const { detail } = anchor;
    const uei = detail.uei;
    const names = detail.names;

    const wants = (kind: DossierSectionKind) => !sectionFilter || sectionFilter === kind;
    const sections: Partial<Record<DossierSectionKind, DossierSection<Record<string, unknown>>>> = {
      identity: anchor.section as unknown as DossierSection<Record<string, unknown>>,
    };

    if (wants('government_exposure')) {
      sections.government_exposure = await this.exposureSection(uei, names, ctx);
    }
    if (wants('relevant_signals')) {
      sections.relevant_signals = await this.signalsSection(uei, names, policy);
    }
    if (wants('footprint')) {
      sections.footprint = await this.footprintSection(ctx, org.id, uei, names);
    }
    if (wants('lobbying')) {
      sections.lobbying = await this.lobbyingSection({ names, uei }, policy);
    }
    if (wants('people')) {
      sections.people = this.peopleSection(policy);
    }

    return finalizeDossier(
      {
        canonicalEntityId: org.id,
        canonicalName: org.canonicalName,
        identityScope: org.identityScope === 'tenant_private' ? 'tenant_private' : 'global_public',
        identityBasis: uei ? 'exact_uei' : 'exact_name',
        generatedAt: new Date().toISOString(),
        sections,
        prospect: null,
      },
      sectionFilter,
    );
  }

  private async findVisibleCanonicalOrganization(ctx: TenantContext, canonicalEntityId: string) {
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx
        .$queryRaw<Array<{ id: string; canonicalName: string; identityScope: string }>>`
        SELECT "id", "canonical_name" AS "canonicalName", "identity_scope" AS "identityScope"
        FROM "canonical_entities"
        WHERE "id" = ${canonicalEntityId}::uuid
          AND "merged_into_entity_id" IS NULL
          AND "status" = 'active'
          AND "entity_type" = 'organization'
          AND ("identity_scope" = 'global_public' OR "tenant_id" = ${ctx.tenantId}::uuid)
        LIMIT 1`,
    ).then((rows) => rows[0] ?? null);
  }

  // ── identity section (canonical + at-most-one live SAM lookup) ───────────

  private async identityAnchor(
    ctx: TenantContext,
    org: { id: string; canonicalName: string },
    policy: ProviderPolicy,
  ): Promise<IdentityAnchor> {
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRaw<
        Array<{ identifierType: string; identifierValue: string; sourceType: string; verifiedAt: Date | null }>
      >`SELECT "identifier_type" AS "identifierType", "identifier_value" AS "identifierValue",
                "source_type" AS "sourceType", "verified_at" AS "verifiedAt"
         FROM "entity_identifiers"
         WHERE "entity_id" = ${org.id}::uuid AND "status" = 'active'
           AND ("identity_scope" = 'global_public' OR "tenant_id" = ${ctx.tenantId}::uuid)`,
    );
    const aliases = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.$queryRaw<Array<{ alias: string }>>`SELECT "alias"
         FROM "entity_aliases"
         WHERE "entity_id" = ${org.id}::uuid AND "status" = 'active'
           AND ("identity_scope" = 'global_public' OR "tenant_id" = ${ctx.tenantId}::uuid)
         ORDER BY "alias" ASC LIMIT 10`,
    );
    const uei = rows.find((r) => r.identifierType === 'uei')?.identifierValue ?? null;
    const cage = rows.find((r) => r.identifierType === 'cage')?.identifierValue ?? null;
    const names = Array.from(new Set([org.canonicalName, ...aliases.map((a) => a.alias)]));

    const evidence: EvidenceItem[] = [
      {
        sourceFamily: 'capiro_canonical_identity',
        recordId: org.id,
        locator: null,
        originalSourceName: 'Capiro identity registry',
        originalSourceId: org.id,
        claimType: 'identity',
        relationshipStrength: 'direct',
        eventDate: null,
        effectiveDate: null,
        fiscalYear: null,
        stage: null,
        sourceUpdatedAt: null,
        fetchedAt: null,
        scopeChecked: `canonical_entity_id=${org.id}`,
        status: 'available',
        title: `Canonical organization “${org.canonicalName}”`,
        detail: {
          aliases: aliases.map((a) => a.alias),
          identifiers: rows.map((r) => ({ type: r.identifierType, value: r.identifierValue })),
        },
      },
    ];

    // ── At-most-one live SAM lookup (exact UEI, else exact CAGE) ──────────
    // Never a name search. Never overwrites the canonical identity: the result
    // only enriches this section as a separately-attributed SAM card.
    //   disabled-by-flag / no identifier → no lookup, no manufactured error
    //   (identity coverage stays what Capiro's records support).
    //   attempted-but-failed / no-match → internal evidence retained, section
    //   status downgraded to `partial` (coverage attempted, not confirmed).
    let samNote: string | null = null;
    let samDegradesCoverage = false;
    if (policy.samEnabled && (uei || cage)) {
      const result = uei
        ? await this.samClient.lookupByUei(uei)
        : await this.samClient.lookupByCage(cage as string);
      if (result.ok && result.entities.length > 0) {
        // Exact identifier lookup: the first record is the SAM registration
        // for this identifier. Attributed as SAM's own view of the entity.
        const sam: SamEntityRecord = result.entities[0] as SamEntityRecord;
        evidence.push({
          sourceFamily: 'sam_entity',
          recordId: sam.uei,
          locator: `https://sam.gov/entity-registration/${sam.uei}`,
          originalSourceName: 'SAM.gov',
          originalSourceId: sam.uei,
          claimType: 'identity',
          relationshipStrength: 'direct',
          eventDate: isoDate(sam.registrationDate),
          effectiveDate: null,
          fiscalYear: null,
          stage: null,
          sourceUpdatedAt: isoDateTime(sam.lastUpdateDate),
          fetchedAt: new Date().toISOString(),
          scopeChecked: uei ? `sam_uei=${uei}` : `sam_cage=${cage}`,
          status: 'available',
          title: `SAM.gov registration: ${sam.legalBusinessName}${sam.registrationStatus ? ` (${sam.registrationStatus})` : ''}`,
          detail: {
            uei: sam.uei,
            cageCode: sam.cageCode,
            dbaName: sam.dbaName,
            registrationStatus: sam.registrationStatus,
            registrationExpirationDate: sam.registrationExpirationDate,
            physicalAddress: sam.physicalAddress,
            congressionalDistrict: sam.congressionalDistrict,
            entityStructure: sam.entityStructure,
            stateOfIncorporation: sam.stateOfIncorporation,
            primaryNaics: sam.primaryNaics,
            // Contextual display of SAM's own fields; the canonical record
            // above remains the identity of record.
            matchBasis: uei ? 'exact_uei' : 'exact_cage',
          },
        });
        samNote = `A live SAM.gov registration check (by exact ${uei ? 'UEI' : 'CAGE'}) confirmed the registration details above.`;
      } else if (result.ok) {
        samNote = `A live SAM.gov registration check (by exact ${uei ? 'UEI' : 'CAGE'}) found no active registration for this identifier.`;
        samDegradesCoverage = true;
      } else {
        // Fail-soft: identity coverage note only, never an error section. The
        // internal Capiro evidence stays; the attempted-but-incomplete live
        // check downgrades the section to partial.
        samNote = 'A live SAM.gov registration check could not be completed right now; identity coverage above is from Capiro’s records only.';
        samDegradesCoverage = true;
        this.logger.warn(`dossier SAM lookup failed: ${result.reason}: ${result.message}`);
      }
    } else if (policy.samEnabled) {
      samNote = 'No UEI or CAGE is on record, so no live SAM.gov registration check was made (lookups are by exact identifier only).';
    }

    const statusText = uei
      ? 'Identity confirmed by a registered UEI; award and lobbying joins use this identifier.'
      : 'Identity is the canonical name; award and lobbying joins use exact-name matching and are labeled conditional.';

    return {
      section: {
        section: 'identity',
        status: samDegradesCoverage ? 'partial' : 'available',
        statusText: samNote ? `${statusText} ${samNote}` : statusText,
        evidence,
        detail: { uei, cage, names, aliases: aliases.map((a) => a.alias), samCoverage: samDegradesCoverage ? 'attempted_unconfirmed' : policy.samEnabled && (uei || cage) ? 'live_checked' : 'not_attempted' },
      },
      detail: { uei, cage, names, aliases: aliases.map((a) => a.alias) },
    };
  }

  private async unresolvedIdentitySection(
    ctx: TenantContext,
    prospect: { id: string; displayName: string },
  ): Promise<DossierSection<Record<string, unknown>>> {
    // Candidate options under the same visibility rules — bounded, deterministic.
    const candidates = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx
        .$queryRaw<Array<CanonicalOrgRow>>`SELECT "id", "canonical_name" AS "canonicalName", "normalized_name" AS "normalizedName",
                  "identity_scope" AS "identityScope", "tenant_id" AS "tenantId"
         FROM "canonical_entities"
         WHERE "merged_into_entity_id" IS NULL AND "status" = 'active' AND "entity_type" = 'organization'
           AND ("identity_scope" = 'global_public' OR "tenant_id" = ${ctx.tenantId}::uuid)
           AND ("canonical_name" ILIKE ${`%${prospect.displayName}%`}
                OR "normalized_name" LIKE ${`%${prospect.displayName.toLowerCase()}%`})
         ORDER BY "canonical_name" ASC LIMIT 5`,
    );
    return {
      section: 'identity',
      status: 'ambiguous',
      statusText:
        candidates.length > 1
          ? `Organization identity is not confirmed: ${candidates.length} similarly-named organizations are on record. Confirm the right one before other sections can be checked.`
          : 'This prospect’s organization identity is not confirmed yet. Confirm the right organization to unlock the other sections.',
      evidence: [],
      detail: {
        candidates: candidates.map((c) => ({
          canonicalEntityId: c.id,
          canonicalName: c.canonicalName,
          identityScope: c.identityScope,
        })),
        ambiguity: 'identity_unresolved',
      },
    };
  }

  // ── government exposure (awards + assistance, obligations) ──────────────

  private async exposureSection(
    uei: string | null,
    names: string[],
    ctx: TenantContext,
  ): Promise<DossierSection<Record<string, unknown>>> {
    const basis: EvidenceRelationshipStrength = uei ? 'direct' : 'conditional';
    const scope = uei
      ? `recipient_uei=${uei}`
      : `exact_name∈{${names.map((n) => `"${n}"`).join(', ')}}`;

    try {
      const contracts = await this.direct.federalAward.findMany({
        where: uei
          ? { recipientUei: uei }
          : { OR: names.map((n) => ({ contractorName: { equals: n, mode: 'insensitive' as const } })) },
        orderBy: [{ actionDate: 'desc' as const }],
        take: EXPOSURE_CONTRACT_CAP,
        select: {
          awardUniqueId: true,
          awardingAgency: true,
          awardingSubTier: true,
          contractorName: true,
          amount: true,
          actionDate: true,
          awardedAt: true,
          fundingFy: true,
          peCode: true,
          peCodeSource: true,
          peCodeConfidence: true,
          peCodeCandidateCount: true,
          dodAcqProgramCode: true,
          dodAcqProgramName: true,
          fundingTas: true,
          fundingTasTitle: true,
          lastSyncedAt: true,
          description: true,
          piid: true,
        },
      });
      const assistance = await this.direct.federalAssistanceAward.findMany({
        where: uei
          ? { recipientUei: uei }
          : { OR: names.map((n) => ({ recipientName: { equals: n, mode: 'insensitive' as const } })) },
        orderBy: [{ startDate: 'desc' as const }],
        take: EXPOSURE_ASSISTANCE_CAP,
        select: {
          awardUniqueId: true,
          awardingAgency: true,
          awardingSubTier: true,
          recipientName: true,
          totalObligatedAmount: true,
          startDate: true,
          lastSyncedAt: true,
          description: true,
          fain: true,
        },
      });

      const contractEvidence: EvidenceItem[] = contracts
        .filter(
          (a) =>
            uei ||
            names.some((n) => normalizeCompanyName(n) === normalizeCompanyName(a.contractorName)),
        )
        .map((a) => {
          // Obligation semantics: the USAspending contract amount column is
          // the obligated amount for the action/award — never outlays or
          // ceiling. PE/acquisition context ONLY when the ingested row itself
          // carries it; strength is honest per-row.
          const pePresent = a.peCode != null;
          const strength: EvidenceRelationshipStrength = uei ? 'direct' : 'conditional';
          const peDetail: Record<string, unknown> = pePresent
            ? {
                peCode: a.peCode,
                peCodeSource: a.peCodeSource,
                peCodeConfidence: a.peCodeConfidence,
                peCodeCandidateCount: a.peCodeCandidateCount,
                dodAcqProgramCode: a.dodAcqProgramCode,
                dodAcqProgramName: a.dodAcqProgramName,
                fundingTas: a.fundingTas,
                fundingTasTitle: a.fundingTasTitle,
                peStrength:
                  a.peCodeConfidence != null && a.peCodeConfidence >= 0.99 && a.peCodeSource
                    ? 'direct'
                    : 'conditional',
              }
            : {};
          return {
            sourceFamily: 'usaspending_contract' as const,
            recordId: a.awardUniqueId,
            locator: `https://www.usaspending.gov/award/${a.awardUniqueId}`,
            originalSourceName: 'USAspending',
            originalSourceId: a.piid ?? a.awardUniqueId,
            claimType: 'government_exposure' as const,
            relationshipStrength: strength,
            eventDate: isoDate(a.actionDate) ?? isoDate(a.awardedAt),
            effectiveDate: null,
            fiscalYear: a.fundingFy ?? null,
            stage: 'obligated' as EvidenceStage,
            sourceUpdatedAt: null,
            fetchedAt: isoDateTime(a.lastSyncedAt),
            scopeChecked: scope,
            status: 'available' as EvidenceStatus,
            title:
              `${a.contractorName ?? 'Recipient'} — federal contract obligation` +
              (a.amount != null ? `, ${usd(a.amount) ?? 'unrevealed amount'}` : ''),
            detail: {
              agency: a.awardingAgency,
              subTier: a.awardingSubTier,
              amount: num(a.amount),
              amountType: 'obligation',
              description: a.description,
              kind: 'contract',
              matchBasis: uei ? 'exact_uei' : 'exact_name',
              ...peDetail,
            },
          };
        });

      const assistanceEvidence: EvidenceItem[] = assistance
        .filter(
          (g) =>
            uei ||
            names.some((n) => normalizeCompanyName(n) === normalizeCompanyName(g.recipientName)),
        )
        .map((g) => ({
          sourceFamily: 'usaspending_assistance' as const,
          recordId: g.awardUniqueId,
          locator: `https://www.usaspending.gov/award/${g.awardUniqueId}`,
          originalSourceName: 'USAspending',
          originalSourceId: g.fain ?? g.awardUniqueId,
          claimType: 'government_exposure' as const,
          relationshipStrength: basis,
          eventDate: isoDate(g.startDate),
          effectiveDate: isoDate(g.startDate),
          fiscalYear: null,
          stage: 'obligated' as EvidenceStage,
          sourceUpdatedAt: null,
          fetchedAt: isoDateTime(g.lastSyncedAt),
          scopeChecked: scope,
          status: 'available' as const,
          title:
            `${g.recipientName ?? 'Recipient'} — federal assistance obligation` +
            (g.totalObligatedAmount != null
              ? `, ${usd(g.totalObligatedAmount) ?? 'unrevealed amount'}`
              : ''),
          detail: {
            agency: g.awardingAgency,
            subTier: g.awardingSubTier,
            amount: num(g.totalObligatedAmount),
            amountType: 'obligation',
            description: g.description,
            kind: 'assistance',
            matchBasis: uei ? 'exact_uei' : 'exact_name',
          },
        }));

      const evidence = [...contractEvidence, ...assistanceEvidence];
      if (evidence.length === 0) {
        return emptySection(
          'government_exposure',
          'empty_in_queried_scope',
          EMPTY_SECTION_TEXTS.government_exposure,
          { scopeChecked: scope, matchBasis: uei ? 'exact_uei' : 'exact_name' },
        );
      }
      return {
        section: 'government_exposure',
        status: 'available',
        statusText: uei
          ? `Award obligations matched by exact UEI ${uei} in Capiro’s ingested USAspending data. Amounts are obligations, not outlays.`
          : 'Award obligations matched by exact name only (no UEI on this organization) — treat as leads to verify, not confirmed history. Amounts are obligations, not outlays.',
        evidence,
        detail: {
          scopeChecked: scope,
          matchBasis: uei ? 'exact_uei' : 'exact_name',
          amountType: 'obligation',
        },
      };
    } catch (e) {
      this.logger.warn(
        `exposure section failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      void ctx;
      return emptySection('government_exposure', 'error', 'Federal award records could not be read right now; other sections are unaffected.', {
        scopeChecked: scope,
      });
    }
  }

  // ── relevant signals (PE/award-exposure-constrained SAM opportunities) ────

  /**
   * Signals are ONLY the deterministic constraints the ingested data supports:
   * SAM notices issued by agencies/subagencies this company's own award rows
   * expose it to. NO arbitrary global notices. Each card is issuing-office
   * context only — never a claim of company bid intent or program ownership.
   * When no deterministic constraint exists, the section is honestly
   * empty/partial.
   */
  private async signalsSection(
    uei: string | null,
    _names: string[],
    policy: ProviderPolicy,
  ): Promise<DossierSection<Record<string, unknown>>> {
    // SamOpportunity is an already-ingested projection: it stays readable when
    // the SAM provider flag is off; the flag only governs the LIVE adapter
    // (identity section). No live call is made here either way.
    try {
      if (!uei) {
        // Without a UEI there is no deterministic award-exposure constraint we
        // can verify — return truthful empty rather than thematic guesses.
        return emptySection(
          'relevant_signals',
          'empty_in_queried_scope',
          'This organization has no registered UEI on record, so its award exposure cannot be constrained to specific agencies. No opportunity signals are shown rather than guessing.',
          { scopeChecked: 'award_exposure→sam_notices', constraint: 'none (no UEI)' },
        );
      }
      // Deterministic constraint: the agencies/subagencies on THIS company's
      // exact-UEI award rows. PE/acquisition context is read from the SAME
      // exact-UEI award rows — one query, no per-result reads.
      const exposureRows = await this.direct.federalAward.findMany({
        where: { recipientUei: uei },
        orderBy: [{ actionDate: 'desc' as const }],
        take: SIGNAL_AGENCY_SCAN_CAP,
        select: {
          awardingAgency: true,
          awardingSubTier: true,
          awardUniqueId: true,
          actionDate: true,
          amount: true,
          fundingFy: true,
          lastSyncedAt: true,
          contractorName: true,
          piid: true,
          peCode: true,
          peCodeSource: true,
          peCodeConfidence: true,
          peCodeCandidateCount: true,
          dodAcqProgramCode: true,
          dodAcqProgramName: true,
        },
      });
      const agencies = Array.from(
        new Set(exposureRows.map((r) => r.awardingAgency).filter((a): a is string => !!a)),
      );
      const subTiers = Array.from(
        new Set(exposureRows.map((r) => r.awardingSubTier).filter((a): a is string => !!a)),
      );
      if (agencies.length === 0) {
        return emptySection(
          'relevant_signals',
          'empty_in_queried_scope',
          'No federal award records on file for this organization, so there is no award-exposure basis for surfacing opportunity context.',
          { scopeChecked: 'award_exposure→sam_notices', constraint: 'none (no exposure rows)' },
        );
      }

      // ── Explicit PE / DoD acquisition evidence from exact-UEI award rows ──
      // Direct ONLY for a verified direct source (reviewed UEI-confirmed R-3
      // prime with high confidence); otherwise conditional. The wording always
      // says the AWARD RECORD carries the context — it never claims a PE funds
      // the award unless that was separately verified.
      const PE_SIGNAL_CAP = 5;
      const peStrength = (a: (typeof exposureRows)[number]): EvidenceRelationshipStrength =>
        a.peCodeSource === 'uei_confirmed_r3_prime' && (a.peCodeConfidence ?? 0) >= 0.9
          ? 'direct'
          : 'conditional';
      const peEvidence: EvidenceItem[] = exposureRows
        .filter((a) => a.peCode != null || a.dodAcqProgramCode != null)
        .slice(0, PE_SIGNAL_CAP)
        .map((a) => {
          const strength = peStrength(a);
          const isVerifiedPrime = strength === 'direct';
          return {
            sourceFamily: 'usaspending_contract' as const,
            recordId: a.awardUniqueId,
            locator: `https://www.usaspending.gov/award/${a.awardUniqueId}`,
            originalSourceName: 'USAspending',
            originalSourceId: a.piid ?? a.awardUniqueId,
            claimType: 'relevant_signal' as const,
            relationshipStrength: strength,
            eventDate: isoDate(a.actionDate),
            effectiveDate: null,
            fiscalYear: a.fundingFy ?? null,
            stage: 'obligated' as EvidenceStage,
            sourceUpdatedAt: null,
            fetchedAt: isoDateTime(a.lastSyncedAt),
            scopeChecked: `recipient_uei=${uei}`,
            status: 'available' as EvidenceStatus,
            title:
              `Award record carrying ${
                a.peCode ? `program element ${a.peCode}` : 'DoD acquisition program'
              } context: ${a.contractorName ?? 'recipient'}` +
              (a.amount != null ? `, ${usd(a.amount) ?? 'unrevealed amount'}` : ''),
            detail: {
              peCode: a.peCode,
              peCodeSource: a.peCodeSource,
              peCodeConfidence: a.peCodeConfidence,
              peCodeCandidateCount: a.peCodeCandidateCount,
              dodAcqProgramCode: a.dodAcqProgramCode,
              dodAcqProgramName: a.dodAcqProgramName,
              peEvidenceStrength: strength,
              meaning: isVerifiedPrime
                ? 'This exact-UEI award record was reviewed and carries a UEI-confirmed program-element attribution; the award record itself is the context.'
                : 'This award record carries program-element/acquisition-program context. The attribution is not separately verified — it does not claim that the program element funds this award.',
              ...(a.peCodeCandidateCount != null && a.peCodeCandidateCount > 1
                ? {
                    ambiguityWarning: `${a.peCodeCandidateCount} program elements could map to this award's account and program activity; no single program element is asserted.`,
                  }
                : {}),
            },
          };
        });
      const notices = await this.direct.samOpportunity.findMany({
        where: {
          active: true,
          OR: [
            { agency: { in: agencies } },
            ...(subTiers.length > 0 ? [{ subAgency: { in: subTiers } }] : []),
          ],
        },
        orderBy: [{ postedDate: 'desc' as const }],
        take: SIGNAL_CAP,
        select: {
          noticeId: true,
          title: true,
          noticeType: true,
          agency: true,
          subAgency: true,
          office: true,
          postedDate: true,
          responseDeadline: true,
          lastSyncedAt: true,
        },
      });
      const evidence: EvidenceItem[] = notices.map((n) => ({
        sourceFamily: 'sam_opportunity',
        recordId: n.noticeId,
        locator: `https://sam.gov/opp/${n.noticeId}/view`,
        originalSourceName: 'SAM.gov',
        originalSourceId: n.noticeId,
        claimType: 'relevant_signal',
        // Contextual relevance (issuing office), NOT evidence about the
        // company itself.
        relationshipStrength: 'thematic' as EvidenceRelationshipStrength,
        eventDate: isoDate(n.postedDate),
        effectiveDate: null,
        fiscalYear: null,
        stage: 'requested' as EvidenceStage,
        sourceUpdatedAt: null,
        fetchedAt: isoDateTime(n.lastSyncedAt),
        scopeChecked: `award_exposure_agencies∈{${agencies.slice(0, 5).join(', ')}${agencies.length > 5 ? ', …' : ''}}`,
        status: 'available' as EvidenceStatus,
        title: `Open SAM notice from an agency this organization has award exposure to: ${n.title}`,
        detail: {
          agency: n.agency,
          subAgency: n.subAgency,
          office: n.office,
          noticeType: n.noticeType,
          responseDeadline: isoDate(n.responseDeadline),
          contextOnly: true,
          meaning:
            'Issuing-office context only — not evidence that this organization will bid, has bid, or owns any program relationship.',
        },
      }));
      if (evidence.length === 0 && peEvidence.length === 0) {
        return emptySection(
          'relevant_signals',
          'empty_in_queried_scope',
          'No open SAM notices match the agencies this organization’s awards were issued by, and no award record carries program-element or acquisition-program context.',
          { scopeChecked: 'award_exposure→sam_notices', constraint: `${agencies.length} awarding agencies` },
        );
      }
      const combinedEvidence = [...peEvidence, ...evidence];
      const anyConditionalPe = peEvidence.some((p) => p.relationshipStrength === 'conditional');
      return {
        section: 'relevant_signals',
        status: 'partial',
        statusText:
          (peEvidence.length > 0
            ? 'Some award records carry program-element or DoD acquisition-program context (the award record is the context — not a claim that a program element funds the award, unless separately verified). '
            : '') +
          'SAM.gov notices below are issued by agencies this organization has award exposure to. They are issuing-office context only — not evidence of bid intent or program ownership.',
        evidence: combinedEvidence,
        detail: {
          scopeChecked: 'award_exposure→sam_notices',
          constraint: { agencies, subTiers },
          contextOnly: true,
          samProviderFlag: policy.samEnabled,
          peEvidenceCount: peEvidence.length,
          ...(anyConditionalPe ? { peWarnings: ['Program-element attribution on at least one award record is unverified; treat as context, not funding attribution.'] } : {}),
        },
      };
    } catch (e) {
      this.logger.warn(`signals section failed: ${e instanceof Error ? e.message : String(e)}`);
      return emptySection('relevant_signals', 'error', 'SAM notice records could not be read right now; other sections are unaffected.', {
        scopeChecked: 'award_exposure→sam_notices',
      });
    }
  }

  // ── footprint (place of performance vs HQ vs tenant-reviewed facility) ───

  private async footprintSection(
    ctx: TenantContext,
    orgId: string,
    uei: string | null,
    names: string[],
  ): Promise<DossierSection<Record<string, unknown>>> {
    const scope = uei
      ? `recipient_uei=${uei}`
      : `exact_name∈{${names.map((n) => `"${n}"`).join(', ')}}`;
    try {
      const awards = await this.direct.federalAward.findMany({
        where: uei
          ? { recipientUei: uei }
          : { OR: names.map((n) => ({ contractorName: { equals: n, mode: 'insensitive' as const } })) },
        orderBy: [{ actionDate: 'desc' as const }],
        take: FOOTPRINT_CAP,
        select: {
          awardUniqueId: true,
          popState: true,
          popCongressionalDistrict: true,
          recipientState: true,
          recipientCongressionalDistrict: true,
          actionDate: true,
          lastSyncedAt: true,
          contractorName: true,
        },
      });
      const placed = awards.filter(
        (a) =>
          (uei ||
            names.some((n) => normalizeCompanyName(n) === normalizeCompanyName(a.contractorName))) &&
          (a.popState != null || a.recipientState != null),
      );
      const popEvidence: EvidenceItem[] = placed.map((a) => ({
        sourceFamily: 'usaspending_contract',
        recordId: a.awardUniqueId,
        locator: `https://www.usaspending.gov/award/${a.awardUniqueId}`,
        originalSourceName: 'USAspending',
        originalSourceId: a.awardUniqueId,
        claimType: 'footprint',
        relationshipStrength: uei ? ('direct' as const) : ('conditional' as const),
        eventDate: isoDate(a.actionDate),
        effectiveDate: null,
        fiscalYear: null,
        stage: null,
        sourceUpdatedAt: null,
        fetchedAt: isoDateTime(a.lastSyncedAt),
        scopeChecked: scope,
        status: 'available',
        title: `Place of performance ${a.popState ?? '?'}${a.popCongressionalDistrict ? `-${a.popCongressionalDistrict}` : ''} (work location)${a.recipientState ? ` — recipient HQ ${a.recipientState}${a.recipientCongressionalDistrict ? `-${a.recipientCongressionalDistrict}` : ''}` : ''}`,
        detail: {
          popState: a.popState,
          popCongressionalDistrict: a.popCongressionalDistrict,
          recipientState: a.recipientState,
          recipientCongressionalDistrict: a.recipientCongressionalDistrict,
          distinctMeaning:
            'Place of performance is where work happens; recipient location is where the company is registered. Neither is a company facility.',
        },
      }));

      // Tenant-reviewed ClientFacility evidence: ONLY when a same-tenant
      // Client row references THIS canonical entity. Kept distinct from place
      // of performance and recipient/HQ; never a jobs claim.
      const facilityEvidence: EvidenceItem[] = [];
      const facilityClient = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.client.findFirst({
          where: { tenantId: ctx.tenantId, canonicalEntityId: orgId },
          select: { id: true },
        }),
      );
      if (facilityClient) {
        const facilities = await this.prisma.withTenant(ctx.tenantId, (tx) =>
          tx.clientFacility.findMany({
            where: { tenantId: ctx.tenantId, clientId: facilityClient.id },
            orderBy: [{ createdAt: 'asc' as const }],
            take: FACILITY_CAP,
            select: {
              id: true,
              name: true,
              addressLine: true,
              city: true,
              state: true,
              zip: true,
              congressionalDistrict: true,
              employeeCount: true,
              updatedAt: true,
            },
          }),
        );
        for (const f of facilities) {
          facilityEvidence.push({
            sourceFamily: 'capiro_canonical_identity',
            recordId: f.id,
            locator: null,
            originalSourceName: 'Capiro tenant-reviewed facility record',
            originalSourceId: f.id,
            claimType: 'footprint',
            relationshipStrength: 'direct',
            eventDate: null,
            effectiveDate: null,
            fiscalYear: null,
            stage: null,
            sourceUpdatedAt: isoDateTime(f.updatedAt),
            fetchedAt: null,
            scopeChecked: 'tenant_client_facilities (same-tenant client of this canonical entity)',
            status: 'available',
            title: `Tenant-reviewed facility: ${f.name}${f.city || f.state ? ` (${[f.city, f.state].filter(Boolean).join(', ')})` : ''}`,
            detail: {
              facilityKind: 'tenant_reviewed',
              name: f.name,
              addressLine: f.addressLine,
              city: f.city,
              state: f.state,
              zip: f.zip,
              congressionalDistrict: f.congressionalDistrict,
              employeeCount: f.employeeCount,
              distinctMeaning:
                'A facility your firm recorded for a client of this organization — distinct from award place of performance and from the recipient/HQ address. Employee counts, where present, are your firm’s own review data, not a jobs claim.',
            },
          });
        }
      }

      if (popEvidence.length === 0 && facilityEvidence.length === 0) {
        return emptySection('footprint', 'empty_in_queried_scope', EMPTY_SECTION_TEXTS.footprint, {
          scopeChecked: scope,
        });
      }
      return {
        section: 'footprint',
        status: facilityEvidence.length > 0 ? 'available' : 'partial',
        statusText:
          'Footprint locations come from award place-of-performance and recipient addresses (work locations, not verified company facilities)' +
          (facilityEvidence.length > 0
            ? ', plus facilities your firm has reviewed for a client of this organization (labeled separately).'
            : '.'),
        evidence: [...popEvidence, ...facilityEvidence],
        detail: { scopeChecked: scope, facilityEvidenceCount: facilityEvidence.length },
      };
    } catch (e) {
      this.logger.warn(`footprint section failed: ${e instanceof Error ? e.message : String(e)}`);
      return emptySection('footprint', 'error', 'Footprint records could not be read right now; other sections are unaffected.', {
        scopeChecked: scope,
      });
    }
  }

  // ── lobbying (LDA) ────────────────────────────────────────────────────────

  private async lobbyingSection(
    input: { names: string[]; uei?: string | null },
    policy: ProviderPolicy,
  ): Promise<DossierSection<Record<string, unknown>>> {
    void input.uei;
    // LdaFiling is an already-ingested projection — readable regardless of
    // the provider flag. The flag governs live LDA fetching, which this
    // read-only surface never performs.
    void policy.ldaEnabled;
    const names = input.names;
    const normalized = new Set(names.map(normalizeCompanyName).filter((n) => n.length >= 3));
    const scope = `client_name exact∈{${names.map((n) => `"${n}"`).join(', ')}}`;
    try {
      const filings = await this.direct.ldaFiling.findMany({
        where: {
          OR: names.flatMap((n) => [
            { clientName: { equals: n, mode: 'insensitive' as const } },
            { clientName: { contains: n, mode: 'insensitive' as const } },
          ]),
        },
        orderBy: [{ filingYear: 'desc' as const }, { dtPosted: 'desc' as const }],
        take: LDA_SCAN_CAP,
        select: {
          filingUuid: true,
          filingType: true,
          filingYear: true,
          filingPeriod: true,
          registrantName: true,
          clientName: true,
          clientId: true,
          income: true,
          issueCodes: true,
          dtPosted: true,
          filingDocumentUrl: true,
          lastSyncedAt: true,
        },
      });
      const exact = filings.filter((f) => normalized.has(normalizeCompanyName(f.clientName)));
      const partial = filings.filter((f) => !normalized.has(normalizeCompanyName(f.clientName)));
      const evidence: EvidenceItem[] = exact.slice(0, LDA_CAP).map((f) => ({
        sourceFamily: 'lda_filing',
        recordId: f.filingUuid,
        locator: f.filingDocumentUrl ?? `https://lda.senate.gov/system/public-form/${f.filingUuid}/view`,
        originalSourceName: 'Senate LDA',
        originalSourceId: f.filingUuid,
        claimType: 'lobbying',
        // Exact client-of-record name only — LDA filings carry no UEI, so
        // even a UEI-anchored identity stays conditional. Contains matches
        // are NOT asserted here; they surface as a separate count.
        relationshipStrength: 'conditional' as const,
        eventDate: isoDate(f.dtPosted),
        effectiveDate: null,
        fiscalYear: f.filingYear,
        stage: null,
        sourceUpdatedAt: isoDateTime(f.dtPosted),
        fetchedAt: isoDateTime(f.lastSyncedAt),
        scopeChecked: scope,
        status: 'available',
        title: `${f.registrantName} lobbied for ${f.clientName} (${f.filingYear}${f.filingPeriod ? ` ${f.filingPeriod}` : ''})`,
        detail: {
          registrant: f.registrantName,
          clientOfRecord: f.clientName,
          clientId: f.clientId,
          filingPeriod: f.filingPeriod,
          income: num(f.income),
          issueCodes: f.issueCodes,
          matchBasis: 'exact_client_name',
        },
      }));
      if (exact.length > 0) {
        return {
          section: 'lobbying',
          status: 'available',
          statusText:
            'Matched by exact lobbying client-of-record name. LDA filings carry no UEI, so these are name matches — verify before relying on them.',
          evidence,
          detail: {
            scopeChecked: scope,
            matchBasis: 'exact_client_name',
            // Contains matches stay unresolved leads — reported, never asserted.
            unresolvedNameOverlapCount: partial.length,
          },
        };
      }
      if (partial.length > 0) {
        return {
          section: 'lobbying',
          status: 'partial',
          statusText: `No filing names this company exactly, but ${partial.length} filing(s) contain a similar name — reported as unresolved leads only, not shown as matches.`,
          evidence: [],
          detail: { scopeChecked: scope, matchBasis: 'name_contains', unresolvedNameOverlapCount: partial.length },
        };
      }
      return emptySection(
        'lobbying',
        'empty_in_queried_scope',
        'No lobbying disclosure filings in Capiro’s ingested Senate LDA data name this company as a lobbying client. This is a data match result, not a statement that the company has no lobbyists.',
        { scopeChecked: scope },
      );
    } catch (e) {
      this.logger.warn(`lobbying section failed: ${e instanceof Error ? e.message : String(e)}`);
      return emptySection('lobbying', 'error', 'Lobbying disclosure records could not be read right now; other sections are unaffected.', {
        scopeChecked: scope,
      });
    }
  }

  // ── people (PDL deferred; zero calls by construction) ────────────────────

  private peopleSection(policy: ProviderPolicy): DossierSection<Record<string, unknown>> {
    // NO PDL client exists anywhere in this codebase — there is nothing to
    // call. The flags only select the wording of the deferred notice.
    const statusText = policy.pdlPeopleEnabled
      ? 'People enrichment is pending a legal and data-use review; no people data is fetched or shown yet.'
      : policy.pdlCompanyEnabled
        ? 'Company enrichment is pending integration; no company-enrichment call is made yet.'
        : 'People enrichment is not available yet; this section will stay empty until it is enabled.';
    return emptySection('people', 'stale', statusText, {
      provider: 'pdl_people',
      providerState: 'deferred',
      peopleEnabled: policy.pdlPeopleEnabled,
      companyEnabled: policy.pdlCompanyEnabled,
      callsMade: 0,
    });
  }
}

// ── shared dossier shape + finalize ────────────────────────────────────────

export interface IdentityDetail {
  uei: string | null;
  cage: string | null;
  names: string[];
  aliases: string[];
  /** Live SAM check outcome for the identity section: live_checked,
   * attempted_unconfirmed (failed/no-match → section status partial), or
   * not_attempted (disabled/no identifier — no manufactured error). */
  samCoverage?: 'live_checked' | 'attempted_unconfirmed' | 'not_attempted';
}

export interface BizDevDossier {
  canonicalEntityId: string | null;
  canonicalName: string | null;
  identityScope: 'global_public' | 'tenant_private' | null;
  identityBasis: 'exact_uei' | 'exact_name' | 'unresolved_prospect';
  generatedAt: string;
  sections: Partial<Record<DossierSectionKind, DossierSection<Record<string, unknown>>>>;
  sectionStates: DossierSectionState[];
  prospect: { id: string; displayName: string } | null;
}

function finalizeDossier(
  base: Omit<BizDevDossier, 'sectionStates'>,
  sectionFilter?: DossierSectionKind,
): BizDevDossier {
  const sections: Partial<Record<DossierSectionKind, DossierSection<Record<string, unknown>>>> = {};
  for (const [kind, section] of Object.entries(base.sections)) {
    if (sectionFilter && kind !== sectionFilter && kind !== 'identity') continue;
    sections[kind as DossierSectionKind] = section;
  }
  const sectionStates = Object.values(base.sections).map((s) =>
    sectionState(s.section, s.status, s.statusText),
  );
  return { ...base, sections, sectionStates };
}
