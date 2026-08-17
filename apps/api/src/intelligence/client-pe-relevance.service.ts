import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  combineRelevance,
  scoreCapabilityKeyword,
  scoreCapabilityPeDirect,
  scoreEcosystem,
  scoreFacilityDistrict,
  scorePriorAward,
  type PathResult,
} from './client-pe-relevance.scoring.js';
import { expandTerms, isKnownAcronym, MIN_KEYWORD_TOKEN_LENGTH } from './term-expansion.js';

/**
 * Step 2.3 — explainable client ⇄ Program-Element (PE) relevance (plan §9/§13).
 *
 * This service is the DB-fetching half of the relevance feature. It gathers the
 * raw per-path SIGNAL facts for a (client, PE) pair, hands each fact bundle to the
 * matching PURE scorer in `client-pe-relevance.scoring.ts`, then folds the paths
 * into a single 0..1 score with supporting evidence via `combineRelevance`.
 *
 * It depends ONLY on PrismaService, the pure scoring module, and term-expansion —
 * deliberately NOT on any program-element service, to avoid a DI cycle (the
 * program-element module already injects intelligence-adjacent services).
 *
 * Tenant-owned signals (client capabilities, facilities, intel mappings) are read
 * with a tenant-scoped transaction (`withTenant` → `tx`) so RLS isolates them.
 * Global, public-domain intel (federal_award, program_element*) is read via the
 * un-scoped `this.prisma` client.
 */

/** Default minimum combined score for "relevant" filtering across the read paths. */
export const DEFAULT_MIN_RELEVANCE_SCORE = 0.5;

/**
 * Trigram similarity floor for the capability-keyword path. Lowered from 0.65
 * to 0.5 to catch more partial matches (e.g. "autonomous" matching "autonomy").
 * The final relevance result is already filtered at DEFAULT_MIN_RELEVANCE_SCORE
 * (0.5), so the keyword path was stricter than the final threshold — now they
 * align. Only keyword↔PE-text matches at or above this similarity count.
 */
export const KEYWORD_SIMILARITY_FLOOR = 0.5;

/**
 * Name-similarity floor for tying a client to an award / performer by name (trigram).
 * Lower than the keyword floor because award + performer names are short, high-signal
 * proper nouns and the alternative (UEI) is exact; mirrors the 0.3 contractor-name floor
 * used throughout intelligence.service.
 */
export const NAME_SIMILARITY_FLOOR = 0.3;

/** Cap on the candidate-PE set scored per client read, to keep the fan-out bounded. */
const MAX_CANDIDATE_PES = 400;

/**
 * Heuristic cap on the candidate-client set scored per PE read (the PE→clients direction),
 * mirroring MAX_CANDIDATE_PES for the client→PE direction. Bounds the per-PE fan-out so a
 * popular PE (many award/facility/capability hits) cannot make getRelevantClientsForPe score
 * an unbounded number of clients inside one transaction.
 */
const MAX_CANDIDATE_CLIENTS = 200;

/** Cap on the (tenant, client) pairs the system cross-tenant writer path will score. */
const MAX_SYSTEM_CLIENT_PAIRS = 2000;

/**
 * Normalize a congressional-district code for comparison. Facilities store the app's
 * BARE convention ('5') but federal_award keeps USAspending's raw ZERO-PADDED codes
 * ('05'), so exact equality silently misses single-digit districts. Stripping leading
 * zeros makes both sides comparable; '' (everything stripped) means the at-large
 * district ('00'/'0'). JS twin of the LTRIM(x, '0') applied on both sides of the SQL
 * district joins; USAspending's '90'/'98' sentinels are untouched and still never match.
 */
export function normalizeDistrictForComparison(district: string): string {
  return district.trim().replace(/^0+/, '');
}

interface ClientSignalContext {
  uei: string | null;
  name: string;
  /** Acronym-expanded, length-filtered capability keyword/tag terms. */
  keywordTerms: string[];
  /** Distinct PE codes the client's capabilities explicitly list (peNumbers[] + legacy peNumber). */
  capabilityPeCodes: Set<string>;
  /** Distinct "ST-NN" district keys for the client's facilities. */
  facilityDistricts: Array<{ state: string; district: string }>;
  /** Confirmed/declared external intel names the client maps to (for ecosystem matching). */
  intelNames: string[];
}

@Injectable()
export class ClientPeRelevanceService {
  private readonly logger = new Logger(ClientPeRelevanceService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Core ─────────────────────────────────────────────────────────────────────

  /**
   * Score one (client, PE) pair on every evidence path and combine.
   *
   * `tx` MUST be a tenant-scoped transactional client (from `withTenant`) for the
   * tenant that owns `clientId`: the tenant-owned signals (capabilities, facilities,
   * intel mappings) are read through it so RLS applies. Global intel is read via
   * `this.prisma` regardless of `tx`.
   */
  async computeForClientPe(
    tx: Prisma.TransactionClient,
    clientId: string,
    peCode: string,
  ): Promise<{ score: number; paths: PathResult[] }> {
    const signals = await this.loadClientSignalContext(tx, clientId);
    if (!signals) return { score: 0, paths: [] };
    return this.scoreClientPe(signals, peCode);
  }

  /**
   * Load the per-client signal facts once so multiple PEs can be scored against the
   * same client without re-querying the tenant tables. Tenant-owned reads go through
   * `tx`. Returns null when the client does not exist (in this tenant).
   *
   * This client read is also the clientId-OWNERSHIP guard for every caller
   * (computeForClientPe, getRelevantPesForClient, getRelevantClientsForPe):
   * client_capabilities/client_intel_mapping lack RLS policies (see spawned hardening
   * task), so reading them via `tx` does NOT enforce tenant isolation on its own — only
   * the explicit clientId filter does. This clientId-ownership check via the RLS-protected
   * `clients` table (a wrong-tenant id returns null) is what prevents a cross-tenant read
   * until those tables get RLS.
   */
  private async loadClientSignalContext(
    tx: Prisma.TransactionClient,
    clientId: string,
  ): Promise<ClientSignalContext | null> {
    const client = await tx.client.findUnique({
      where: { id: clientId },
      select: { id: true, name: true, uei: true },
    });
    if (!client) return null;

    const [capabilities, facilities, mappings] = await Promise.all([
      tx.clientCapability.findMany({
        where: { clientId },
        select: { peNumber: true, peNumbers: true, keywords: true, tags: true, name: true },
      }),
      tx.clientFacility.findMany({
        where: { clientId },
        select: { state: true, congressionalDistrict: true },
      }),
      tx.clientIntelMapping.findMany({
        // Confirmed only: unconfirmed fuzzy candidates (the trigram noise) must not
        // feed PE-matching terms — that's the GIGO this overhaul removes.
        where: { clientId, confirmed: true },
        select: { externalName: true },
      }),
    ]);

    // Direct PE codes: union of peNumbers[] and the legacy single peNumber.
    const capabilityPeCodes = new Set<string>();
    const rawKeywords: string[] = [];
    for (const cap of capabilities) {
      for (const pe of cap.peNumbers ?? []) {
        const code = pe?.trim();
        if (code) capabilityPeCodes.add(code.toUpperCase());
      }
      if (cap.peNumber) {
        const code = cap.peNumber.trim();
        if (code) capabilityPeCodes.add(code.toUpperCase());
      }
      // Keyword terms: explicit keywords[] + the capability name's significant words
      // + string tags (tags is a json array). Mirrors intelligence.service term gathering.
      for (const kw of cap.keywords ?? []) {
        if (typeof kw === 'string' && kw.trim()) rawKeywords.push(kw.trim());
      }
      if (cap.name) {
        for (const word of cap.name.split(/\s+/)) {
          if (word.length >= MIN_KEYWORD_TOKEN_LENGTH || isKnownAcronym(word)) {
            rawKeywords.push(word);
          }
        }
      }
      const tags = Array.isArray(cap.tags)
        ? (cap.tags as unknown[]).filter((t): t is string => typeof t === 'string')
        : [];
      for (const tag of tags) {
        if (tag.trim().length >= MIN_KEYWORD_TOKEN_LENGTH || isKnownAcronym(tag)) {
          rawKeywords.push(tag.trim());
        }
      }
    }

    // Acronym-expand (EW → electronic warfare) so short client tags reach PE prose,
    // de-duplicate case-insensitively, drop empties.
    const keywordTerms = expandTerms(rawKeywords)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    const facilityDistricts: Array<{ state: string; district: string }> = [];
    for (const f of facilities) {
      const state = f.state?.trim();
      const district = f.congressionalDistrict?.trim();
      if (state && district) facilityDistricts.push({ state, district });
    }

    const intelNames = mappings
      .map((m) => m.externalName?.trim())
      .filter((n): n is string => Boolean(n));

    return {
      uei: client.uei?.trim() || null,
      name: client.name,
      keywordTerms,
      capabilityPeCodes,
      facilityDistricts,
      intelNames,
    };
  }

  /** Score a pre-loaded client signal context against one PE. */
  private async scoreClientPe(
    signals: ClientSignalContext,
    peCode: string,
  ): Promise<{ score: number; paths: PathResult[] }> {
    const code = peCode.trim().toUpperCase();

    const [directResult, keywordResult, priorAwardResult, facilityResult, ecosystemResult] =
      await Promise.all([
        Promise.resolve(this.scoreDirectPath(signals, code)),
        this.scoreKeywordPath(signals, code),
        this.scorePriorAwardPath(signals, code),
        this.scoreFacilityPath(signals, code),
        this.scoreEcosystemPath(signals, code),
      ]);

    return combineRelevance([
      directResult,
      keywordResult,
      priorAwardResult,
      facilityResult,
      ecosystemResult,
    ]);
  }

  // ── Per-path signal fetchers ───────────────────────────────────────────────────

  /** capability_pe_direct: capability peNumbers[]/peNumber explicitly names this PE. */
  private scoreDirectPath(signals: ClientSignalContext, peCode: string): PathResult | null {
    const matched = signals.capabilityPeCodes.has(peCode) ? [peCode] : [];
    return scoreCapabilityPeDirect({ matchedPeNumbers: matched });
  }

  /**
   * capability_keyword: expanded capability keywords/tags trigram-match the PE
   * title/description and its R-2A project titles/missions + J-book source snippets.
   * Only matches at/above KEYWORD_SIMILARITY_FLOOR count; maxSimilarity is the best.
   */
  private async scoreKeywordPath(
    signals: ClientSignalContext,
    peCode: string,
  ): Promise<PathResult | null> {
    if (signals.keywordTerms.length === 0) return null;

    // Build the PE text corpus: title + description + project titles/missions + source
    // snippets. Pulled in one global read (these are public-domain, RLS-exempt tables).
    const [pe, projects, sources] = await Promise.all([
      this.prisma.programElement.findUnique({
        where: { peCode },
        select: { title: true, description: true },
      }),
      this.prisma.programElementProject.findMany({
        where: { peCode },
        select: { title: true, mission: true },
      }),
      this.prisma.programElementSource.findMany({
        where: { peCode },
        select: { snippet: true },
        take: 50,
      }),
    ]);
    if (!pe) return null;

    const corpusParts: string[] = [pe.title, pe.description ?? ''];
    for (const p of projects) {
      corpusParts.push(p.title);
      if (p.mission) corpusParts.push(p.mission);
    }
    for (const s of sources) {
      if (s.snippet) corpusParts.push(s.snippet);
    }
    const corpus = corpusParts
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
      .join(' \n ');
    if (!corpus) return null;

    // Trigram similarity of each keyword term against the assembled corpus; keep terms
    // at/above the floor. `similarity()` (pg_trgm) over a long corpus is conservative —
    // we evaluate per-term so a single strong keyword is not diluted by the others.
    const rows = await this.prisma.$queryRaw<Array<{ term: string; sim: number }>>(Prisma.sql`
      SELECT t.term AS "term", similarity(${corpus}, t.term)::float8 AS "sim"
      FROM unnest(${signals.keywordTerms}::text[]) AS t(term)
      WHERE similarity(${corpus}, t.term) >= ${KEYWORD_SIMILARITY_FLOOR}
      ORDER BY "sim" DESC
    `);
    if (rows.length === 0) return null;

    const matchedKeywords = rows.map((r) => r.term);
    const maxSimilarity = rows.reduce((m, r) => Math.max(m, r.sim), 0);
    return scoreCapabilityKeyword({ matchedKeywords, maxSimilarity });
  }

  /**
   * prior_award: federal_award rows on this PE held by the client — matched by exact
   * recipientUei OR a contractorName trigram-similar to the client name (> floor).
   */
  private async scorePriorAwardPath(
    signals: ClientSignalContext,
    peCode: string,
  ): Promise<PathResult | null> {
    const hasUei = Boolean(signals.uei);
    const rows = await this.prisma.$queryRaw<Array<{ cnt: number; total: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS "cnt",
             COALESCE(SUM(amount), 0)::float8 AS "total"
      FROM federal_award
      WHERE pe_code = ${peCode}
        AND (
          ${hasUei ? Prisma.sql`recipient_uei = ${signals.uei}` : Prisma.sql`FALSE`}
          OR (contractor_name IS NOT NULL AND similarity(contractor_name, ${signals.name}) > ${NAME_SIMILARITY_FLOOR})
        )
    `);
    const awardCount = rows[0]?.cnt ?? 0;
    const totalAmountUsd = rows[0]?.total ?? 0;
    return scorePriorAward({ awardCount, totalAmountUsd });
  }

  /**
   * facility_district: a client facility sits in a (state, district) that has at least
   * one federal_award on this PE (place-of-performance). Evidence districts are "ST-NN".
   */
  private async scoreFacilityPath(
    signals: ClientSignalContext,
    peCode: string,
  ): Promise<PathResult | null> {
    if (signals.facilityDistricts.length === 0) return null;

    // Distinct award districts on this PE (place of performance).
    const awardDistricts = await this.prisma.$queryRaw<
      Array<{ state: string; district: string }>
    >(Prisma.sql`
      SELECT DISTINCT pop_state AS "state", pop_congressional_district AS "district"
      FROM federal_award
      WHERE pe_code = ${peCode}
        AND pop_state IS NOT NULL
        AND pop_congressional_district IS NOT NULL
    `);
    if (awardDistricts.length === 0) return null;

    // Intersect the client's facility districts with the award districts. Facilities
    // store the BARE district ("5") but federal_award keeps USAspending's ZERO-PADDED
    // raw code ("05"), so both sides are normalized (leading zeros stripped; "" means
    // at-large, keyed back as "00") before comparison; the evidence string prints "ST-NN".
    const districtKey = (state: string, district: string): string =>
      `${state.trim().toUpperCase()}-${normalizeDistrictForComparison(district) || '00'}`;
    const awardKeys = new Set(awardDistricts.map((d) => districtKey(d.state, d.district)));
    const matched = new Set<string>();
    for (const f of signals.facilityDistricts) {
      const key = districtKey(f.state, f.district);
      if (awardKeys.has(key)) matched.add(key);
    }
    return scoreFacilityDistrict({ matchedDistricts: [...matched].sort() });
  }

  /**
   * ecosystem: the client maps (by UEI/name on awards, or by an intel-mapping name) to a
   * performer / awardee named on this PE. We resolve the PE's performer + awardee universe
   * and match the client's identity (UEI, name, intel names) into it by trigram name match.
   */
  private async scoreEcosystemPath(
    signals: ClientSignalContext,
    peCode: string,
  ): Promise<PathResult | null> {
    // The set of names the client is known by: its own name + confirmed intel external names.
    const clientNames = [signals.name, ...signals.intelNames]
      .map((n) => n.trim())
      .filter((n) => n.length > 0);
    if (clientNames.length === 0) return null;

    const hasUei = Boolean(signals.uei);
    // Named performers (R-3 exhibit) + award contractor names on this PE. Match a PE
    // performer/awardee whose name is trigram-similar to ANY of the client's known names,
    // or (for awards) whose recipient_uei equals the client UEI.
    const rows = await this.prisma.$queryRaw<Array<{ performer: string }>>(Prisma.sql`
      WITH ecosystem AS (
        SELECT performer AS name, NULL::text AS uei
        FROM program_element_performer
        WHERE pe_code = ${peCode} AND is_named_company = true
        UNION ALL
        SELECT contractor_name AS name, recipient_uei AS uei
        FROM federal_award
        WHERE pe_code = ${peCode} AND contractor_name IS NOT NULL
      ),
      client_names AS (
        SELECT cn AS name FROM unnest(${clientNames}::text[]) AS t(cn)
      )
      SELECT DISTINCT e.name AS "performer"
      FROM ecosystem e
      WHERE (
          ${hasUei ? Prisma.sql`e.uei = ${signals.uei}` : Prisma.sql`FALSE`}
        )
        OR EXISTS (
          SELECT 1 FROM client_names c
          WHERE similarity(e.name, c.name) > ${NAME_SIMILARITY_FLOOR}
        )
    `);
    if (rows.length === 0) return null;

    const performerNames = [...new Set(rows.map((r) => r.performer).filter(Boolean))];
    return scoreEcosystem({ performerNames });
  }

  // ── Candidate-set assembly ─────────────────────────────────────────────────────

  /**
   * Gather the candidate PE codes worth scoring for a client: PEs its capabilities
   * explicitly name, PEs where the client holds an award (by UEI/name), and PEs with an
   * award in the client's facility districts. Keyword-only candidacy is covered by the
   * award/facility/direct sets in practice; scoring still evaluates the keyword path for
   * each candidate, so a candidate surfaced by any signal gets a full multi-path score.
   * Bounded to MAX_CANDIDATE_PES.
   */
  private async candidatePeCodesForClient(signals: ClientSignalContext): Promise<string[]> {
    const codes = new Set<string>(signals.capabilityPeCodes);

    // PEs the client holds awards on (UEI or name).
    const hasUei = Boolean(signals.uei);
    const awardRows = await this.prisma.$queryRaw<Array<{ peCode: string }>>(Prisma.sql`
      SELECT DISTINCT pe_code AS "peCode"
      FROM federal_award
      WHERE pe_code IS NOT NULL
        AND (
          ${hasUei ? Prisma.sql`recipient_uei = ${signals.uei}` : Prisma.sql`FALSE`}
          OR (contractor_name IS NOT NULL AND similarity(contractor_name, ${signals.name}) > ${NAME_SIMILARITY_FLOOR})
        )
      LIMIT ${MAX_CANDIDATE_PES}
    `);
    for (const r of awardRows) if (r.peCode) codes.add(r.peCode.toUpperCase());

    // PEs with awards in any of the client's facility districts.
    if (signals.facilityDistricts.length > 0) {
      const states = signals.facilityDistricts.map((d) => d.state.toUpperCase());
      const districts = signals.facilityDistricts.map((d) => d.district);
      const facilityRows = await this.prisma.$queryRaw<Array<{ peCode: string }>>(Prisma.sql`
        SELECT DISTINCT fa.pe_code AS "peCode"
        FROM federal_award fa
        -- Facility districts are BARE ('5'); award codes are zero-padded ('05') —
        -- LTRIM both sides ('' = at-large '00').
        JOIN unnest(${states}::text[], ${districts}::text[]) AS d(state, district)
          ON upper(fa.pop_state) = d.state
          AND LTRIM(fa.pop_congressional_district, '0') = LTRIM(d.district, '0')
        WHERE fa.pe_code IS NOT NULL
        LIMIT ${MAX_CANDIDATE_PES}
      `);
      for (const r of facilityRows) if (r.peCode) codes.add(r.peCode.toUpperCase());
    }

    // Ecosystem: PEs naming a performer/awardee the client maps to. Covered for award-linked
    // PEs above; performer-only ecosystem candidacy is intentionally not enumerated here to
    // keep the candidate query bounded — those PEs still score via the ecosystem path when
    // reached through another signal.
    return [...codes].slice(0, MAX_CANDIDATE_PES);
  }

  // ── Read endpoints ───────────────────────────────────────────────────────────

  /**
   * PEs relevant to a client, scored + explained, filtered to >= minScore (default 0.5),
   * sorted by score desc, paginated, with the PE title attached.
   */
  async getRelevantPesForClient(
    ctx: TenantContext,
    clientId: string,
    opts: { minScore?: number; page?: number; limit?: number } = {},
  ): Promise<{
    data: Array<{ peCode: string; title: string | null; score: number; paths: PathResult[] }>;
    total: number;
    page: number;
    limit: number;
  }> {
    const minScore = opts.minScore ?? DEFAULT_MIN_RELEVANCE_SCORE;
    const page = Math.max(1, opts.page ?? 1);
    const limit = Math.min(100, Math.max(1, opts.limit ?? 50));

    const scored = await this.prisma.withTenant(
      ctx.tenantId,
      async (tx) => {
        // clientId-ownership guard: loadClientSignalContext reads the client via the
        // RLS-protected `clients` table, so a wrong-tenant clientId returns null and we
        // short-circuit to an empty result. client_capabilities/client_intel_mapping lack
        // RLS policies (see spawned hardening task); this clientId-ownership check via the
        // RLS-protected clients table is what prevents a cross-tenant read until those tables
        // get RLS.
        const signals = await this.loadClientSignalContext(tx, clientId);
        if (!signals) return [] as Array<{ peCode: string; score: number; paths: PathResult[] }>;

        const candidates = await this.candidatePeCodesForClient(signals);
        const results: Array<{ peCode: string; score: number; paths: PathResult[] }> = [];
        for (const peCode of candidates) {
          const { score, paths } = await this.scoreClientPe(signals, peCode);
          if (score >= minScore) results.push({ peCode, score, paths });
        }
        return results;
      },
      // Iterating many candidate PEs inside one interactive transaction can exceed Prisma's
      // 5s default; raise the limit (same fix as intelligence.service's slow graph paths).
      { timeoutMs: 30_000 },
    );

    scored.sort((a, b) => b.score - a.score || a.peCode.localeCompare(b.peCode));
    const total = scored.length;
    const pageRows = scored.slice((page - 1) * limit, (page - 1) * limit + limit);

    // Attach PE titles (global read) for the page only.
    const titles = await this.peTitles(pageRows.map((r) => r.peCode));
    const data = pageRows.map((r) => ({
      peCode: r.peCode,
      title: titles.get(r.peCode) ?? null,
      score: r.score,
      paths: r.paths,
    }));

    return { data, total, page, limit };
  }

  /**
   * Clients (within ctx's tenant) relevant to a PE, scored + explained, filtered to
   * >= minScore (default 0.5). Enumerates tenant clients that have ANY signal on this PE,
   * then scores each.
   */
  async getRelevantClientsForPe(
    ctx: TenantContext,
    peCode: string,
    opts: { minScore?: number } = {},
  ): Promise<Array<{ clientId: string; clientName: string; score: number; paths: PathResult[] }>> {
    // Delegates to the bare-tenantId variant; only ctx.tenantId is used by the scoping logic.
    return this.getRelevantClientsForPeByTenantId(ctx.tenantId, peCode, opts);
  }

  /**
   * Same as {@link getRelevantClientsForPe} but takes a bare `tenantId` instead of a full
   * {@link TenantContext}. Used by trusted server jobs (e.g. the Step 3.2 action generator)
   * that have already resolved the tenant id from a SYSTEM cross-tenant fan-out and do not
   * hold a request-scoped TenantContext. Runs the identical `withTenant` scoring logic.
   */
  async getRelevantClientsForPeByTenantId(
    tenantId: string,
    peCode: string,
    opts: { minScore?: number } = {},
  ): Promise<Array<{ clientId: string; clientName: string; score: number; paths: PathResult[] }>> {
    const minScore = opts.minScore ?? DEFAULT_MIN_RELEVANCE_SCORE;
    const code = peCode.trim().toUpperCase();

    return this.prisma.withTenant(
      tenantId,
      async (tx) => {
        const candidateIds = await this.candidateClientIdsForPe(tx, code);
        const out: Array<{
          clientId: string;
          clientName: string;
          score: number;
          paths: PathResult[];
        }> = [];
        for (const clientId of candidateIds) {
          // clientId-ownership guard: the candidate set can include ids surfaced by the
          // client_capabilities / client_facilities legs, which lack RLS policies (see
          // spawned hardening task). loadClientSignalContext reads the client via the
          // RLS-protected `clients` table, so a wrong-tenant id returns null and is skipped;
          // this clientId-ownership check is what prevents a cross-tenant read until those
          // tables get RLS.
          const signals = await this.loadClientSignalContext(tx, clientId);
          if (!signals) continue;
          const { score, paths } = await this.scoreClientPe(signals, code);
          if (score >= minScore) {
            out.push({ clientId, clientName: signals.name, score, paths });
          }
        }
        out.sort((a, b) => b.score - a.score || a.clientName.localeCompare(b.clientName));
        return out;
      },
      // Iterating many candidate clients inside one interactive transaction can exceed
      // Prisma's 5s default; raise the limit (same fix as intelligence.service).
      { timeoutMs: 30_000 },
    );
  }

  /**
   * SYSTEM / CROSS-TENANT path (NOT tenant-scoped) — for the relevance delta writer only.
   *
   * Finds every (tenant, client) that has ANY signal on this PE across ALL tenants, then
   * scores each pair under its own tenant context and returns those at/above minScore
   * (default 0.5). This is the ONLY method that reads tenant-owned tables outside
   * `withTenant`: it enumerates candidate clients with the RLS-bypass system client
   * (`withSystem`) — appropriate because the delta writer is a trusted server job that
   * must see every tenant — but then re-scores each client under a proper tenant-scoped
   * transaction so the per-path tenant reads stay correctly isolated. Bounded to
   * MAX_SYSTEM_CLIENT_PAIRS candidate pairs.
   */
  async getRelevantTenantClientsForPe(
    peCode: string,
    opts: { minScore?: number } = {},
  ): Promise<Array<{ tenantId: string; clientId: string; score: number }>> {
    const minScore = opts.minScore ?? DEFAULT_MIN_RELEVANCE_SCORE;
    const code = peCode.trim().toUpperCase();

    // 1) Enumerate candidate (tenant, client) pairs across ALL tenants. System read
    //    (RLS bypass) because the delta writer must see every tenant's signals.
    const candidates = await this.prisma.withSystem(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ tenantId: string; clientId: string }>>(Prisma.sql`
        -- Capability explicitly names this PE (peNumbers[] or legacy peNumber).
        SELECT DISTINCT cc.tenant_id AS "tenantId", cc.client_id AS "clientId"
        FROM client_capabilities cc
        WHERE ${code} = ANY(cc.pe_numbers) OR upper(cc.pe_number) = ${code}
        UNION
        -- Client holds an award on this PE (by UEI or name-similar contractor). Pre-limit
        -- the award side to a DISTINCT 500-row sample before the clients join: an unbounded
        -- clients × federal_award join on a high-award PE is a Cartesian blow-up, and the
        -- candidate enumeration only needs to KNOW a client has *an* award on this PE.
        SELECT DISTINCT c.tenant_id AS "tenantId", c.id AS "clientId"
        FROM (
          SELECT DISTINCT recipient_uei, contractor_name
          FROM federal_award
          WHERE pe_code = ${code}
          LIMIT 500
        ) fa
        JOIN clients c
          ON (c.uei IS NOT NULL AND fa.recipient_uei = c.uei)
          OR (fa.contractor_name IS NOT NULL AND similarity(fa.contractor_name, c.name) > ${NAME_SIMILARITY_FLOOR})
        UNION
        -- Client facility sits in a district with an award on this PE.
        SELECT DISTINCT f.tenant_id AS "tenantId", f.client_id AS "clientId"
        FROM client_facilities f
        JOIN federal_award fa ON fa.pe_code = ${code}
        WHERE f.state IS NOT NULL AND f.congressional_district IS NOT NULL
          AND upper(fa.pop_state) = upper(f.state)
          -- BARE facility district vs zero-padded award code — LTRIM both ('' = at-large).
          AND LTRIM(fa.pop_congressional_district, '0') = LTRIM(f.congressional_district, '0')
        LIMIT ${MAX_SYSTEM_CLIENT_PAIRS}
      `);
      return rows;
    });
    if (candidates.length === 0) return [];

    // 2) Group candidates by tenant, then score each under a proper tenant-scoped tx so the
    //    per-path tenant reads inside computeForClientPe remain RLS-isolated.
    const byTenant = new Map<string, Set<string>>();
    for (const { tenantId, clientId } of candidates) {
      if (!byTenant.has(tenantId)) byTenant.set(tenantId, new Set());
      byTenant.get(tenantId)!.add(clientId);
    }

    const out: Array<{ tenantId: string; clientId: string; score: number }> = [];
    for (const [tenantId, clientIds] of byTenant) {
      await this.prisma.withTenant(tenantId, async (tx) => {
        for (const clientId of clientIds) {
          const { score } = await this.computeForClientPe(tx, clientId, code);
          if (score >= minScore) out.push({ tenantId, clientId, score });
        }
      });
    }
    return out;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────────

  /**
   * Tenant clients (via `tx`) with ANY signal on this PE: capability PE, award (UEI/name),
   * facility district. Bounded to MAX_CANDIDATE_CLIENTS (heuristic cap, mirrors the
   * client→PE direction's MAX_CANDIDATE_PES) so a popular PE cannot fan out unboundedly.
   */
  private async candidateClientIdsForPe(
    tx: Prisma.TransactionClient,
    peCode: string,
  ): Promise<string[]> {
    const rows = await tx.$queryRaw<Array<{ clientId: string }>>(Prisma.sql`
      SELECT "clientId" FROM (
        SELECT DISTINCT cc.client_id AS "clientId"
        FROM client_capabilities cc
        WHERE ${peCode} = ANY(cc.pe_numbers) OR upper(cc.pe_number) = ${peCode}
        UNION
        SELECT DISTINCT c.id AS "clientId"
        FROM clients c
        JOIN federal_award fa ON fa.pe_code = ${peCode}
        WHERE (c.uei IS NOT NULL AND fa.recipient_uei = c.uei)
           OR (fa.contractor_name IS NOT NULL AND similarity(fa.contractor_name, c.name) > ${NAME_SIMILARITY_FLOOR})
        UNION
        SELECT DISTINCT f.client_id AS "clientId"
        FROM client_facilities f
        JOIN federal_award fa ON fa.pe_code = ${peCode}
        WHERE f.state IS NOT NULL AND f.congressional_district IS NOT NULL
          AND upper(fa.pop_state) = upper(f.state)
          -- BARE facility district vs zero-padded award code — LTRIM both ('' = at-large).
          AND LTRIM(fa.pop_congressional_district, '0') = LTRIM(f.congressional_district, '0')
      ) candidates
      LIMIT ${MAX_CANDIDATE_CLIENTS}
    `);
    return rows.map((r) => r.clientId);
  }

  /** Map peCode → title for a set of PEs (global read). Missing PEs simply absent from the map. */
  private async peTitles(peCodes: string[]): Promise<Map<string, string | null>> {
    if (peCodes.length === 0) return new Map();
    const rows = await this.prisma.programElement.findMany({
      where: { peCode: { in: peCodes } },
      select: { peCode: true, title: true },
    });
    return new Map(rows.map((r) => [r.peCode, r.title]));
  }
}
