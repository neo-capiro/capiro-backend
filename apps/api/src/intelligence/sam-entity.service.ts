import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EntityResolutionService } from './entity-resolution.service.js';

/**
 * SAM.gov Entity-Management enrichment: resolve a client's government
 * identifiers (UEI / CAGE / NAICS / PSC) from the authoritative SAM registry,
 * by legal business name (+ state when known).
 *
 * Design guarantees (these IDs feed procurement/budget-exposure matching, so a
 * WRONG id is worse than a missing one):
 *   - CONSERVATIVE matching — only auto-assigns when there is exactly ONE active
 *     SAM registration whose normalized legal name (or DBA) matches the client
 *     exactly (optionally narrowed by physical-address state). Multiple distinct
 *     UEIs => ambiguous => skip (never guess).
 *   - FILL-IF-EMPTY — never overwrites a value a user already entered.
 *   - FAIL-SAFE — any network/parse/quota error returns null and is logged; it
 *     never throws into the create/import path (callers run it fire-and-forget).
 *   - RLS-SAFE — the clients write goes through withTenant (clients is RLS-forced).
 *
 * Unlike the existing /opportunities SAM usage, this hits the Entity-Management
 * API (/entity-information/v3/entities). Verified 2026-06-09 that SAM_GOV_API_KEY
 * has Entity-API access.
 */
export interface SamGovIds {
  uei: string | null;
  cageCode: string | null;
  naicsCodes: string[];
  pscCodes: string[];
  matchedName: string;
  state: string | null;
  registrationStatus: string | null;
}

const SAM_ENTITY_URL = 'https://api.sam.gov/entity-information/v3/entities';
const LOOKUP_TIMEOUT_MS = 25_000;
// Legal-form suffixes safe to strip for an exact-name comparison. Deliberately
// excludes ambiguous words like GROUP / HOLDINGS / PARTNERS that are part of a
// distinct legal name (stripping them would collide separate entities).
const LEGAL_SUFFIX_RE =
  /\b(THE|INC|INCORPORATED|LLC|L L C|LLP|L L P|LP|L P|CO|CORP|CORPORATION|COMPANY|LTD|LIMITED|PLLC|PC)\b/g;
const UEI_RE = /^[A-Z0-9]{12}$/;
const CAGE_RE = /^[A-Z0-9]{5}$/;

@Injectable()
export class SamEntityEnrichmentService {
  private readonly logger = new Logger(SamEntityEnrichmentService.name);
  private readonly apiKey?: string;
  private readonly enabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<AppConfig, true>,
    private readonly entityResolution: EntityResolutionService,
  ) {
    this.apiKey = config.get('SAM_GOV_API_KEY', { infer: true });
    this.enabled = config.get('SAM_ENRICHMENT_ENABLED', { infer: true }) !== false;
  }

  /**
   * Normalize a company name for exact comparison: uppercase, drop legal-form
   * suffixes + punctuation, collapse whitespace. "RTX Corporation" and
   * "RTX CORPORATION, INC." both normalize to "RTX".
   */
  normalize(name: string): string {
    return (name ?? '')
      .toUpperCase()
      .replace(/&/g, ' AND ')
      .replace(/[^A-Z0-9 ]/g, ' ')
      .replace(LEGAL_SUFFIX_RE, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Query SAM for a company name and return gov-ids for the single CONFIDENT
   * match, or null when there is no match / it is ambiguous / on any error.
   */
  async lookupGovIds(name: string, state?: string | null): Promise<SamGovIds | null> {
    if (!this.enabled) return null; // ops kill-switch (SAM_ENRICHMENT_ENABLED)
    if (!this.apiKey) {
      this.logger.warn('SAM_GOV_API_KEY not configured; gov-id enrichment disabled');
      return null;
    }
    const trimmed = (name ?? '').trim();
    const targetFp = this.normalize(trimmed);
    if (targetFp.length < 3) return null;

    // The api.data.gov key is sent via the X-Api-Key HEADER (not a query param)
    // so it never lands in URL access logs / proxies.
    const params = new URLSearchParams({
      legalBusinessName: trimmed,
      registrationStatus: 'A',
      includeSections: 'entityRegistration,coreData,assertions',
    });

    let json: { entityData?: unknown } | null = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
      try {
        const res = await fetch(`${SAM_ENTITY_URL}?${params.toString()}`, {
          method: 'GET',
          headers: { Accept: 'application/json', 'X-Api-Key': this.apiKey },
          signal: controller.signal,
        });
        if (!res.ok) {
          this.logger.warn(`SAM entity lookup HTTP ${res.status} for "${trimmed}"`);
          return null;
        }
        json = (await res.json()) as { entityData?: unknown };
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      this.logger.warn(
        `SAM entity lookup failed for "${trimmed}": ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }

    const rows: any[] = Array.isArray(json?.entityData) ? (json!.entityData as any[]) : [];
    if (rows.length === 0) return null;

    const wantState = (state ?? '').trim().toUpperCase() || null;

    // Active registrations whose normalized legal name (or DBA) matches exactly.
    const exact = rows.filter((r) => {
      const reg = r?.entityRegistration ?? {};
      if (String(reg.registrationStatus ?? '').toUpperCase() !== 'ACTIVE') return false;
      const legal = this.normalize(String(reg.legalBusinessName ?? ''));
      const dba = this.normalize(String(reg.dbaName ?? ''));
      return legal === targetFp || (dba.length >= 3 && dba === targetFp);
    });
    if (exact.length === 0) return null;

    // When the client's state is known, prefer registrations in that state — it
    // disambiguates same-named entities across states. Only narrows if it helps.
    let pool = exact;
    if (wantState) {
      const inState = exact.filter(
        (r) =>
          String(r?.coreData?.physicalAddress?.stateOrProvinceCode ?? '').toUpperCase() ===
          wantState,
      );
      if (inState.length > 0) pool = inState;
    }

    // Only auto-assign on an UNAMBIGUOUS single legal entity. Distinct UEIs means
    // we cannot tell which is the client — skip rather than attach a wrong id.
    const distinctUeis = new Set(
      pool.map((r) => String(r?.entityRegistration?.ueiSAM ?? '')).filter(Boolean),
    );
    if (distinctUeis.size !== 1) {
      const scope = wantState && pool !== exact ? `in ${wantState}` : 'nationally';
      this.logger.log(
        `SAM: "${trimmed}" matched ${distinctUeis.size} distinct active entities ${scope} — skipping (ambiguous${!wantState ? '; a known client state could disambiguate' : ''})`,
      );
      return null;
    }

    const top = pool[0];
    const reg = top.entityRegistration ?? {};
    const gs = top?.assertions?.goodsAndServices ?? {};

    const uei = typeof reg.ueiSAM === 'string' && UEI_RE.test(reg.ueiSAM) ? reg.ueiSAM : null;
    if (!uei) return null; // UEI is the anchor; without a valid one, don't write.
    const cageCode =
      typeof reg.cageCode === 'string' && CAGE_RE.test(reg.cageCode) ? reg.cageCode : null;

    const naics = new Set<string>();
    if (gs.primaryNaics) naics.add(String(gs.primaryNaics));
    for (const n of Array.isArray(gs.naicsList) ? gs.naicsList : []) {
      if (n?.naicsCode) naics.add(String(n.naicsCode));
    }
    const psc = new Set<string>();
    for (const p of Array.isArray(gs.pscList) ? gs.pscList : []) {
      if (p?.pscCode) psc.add(String(p.pscCode));
    }

    return {
      uei,
      cageCode,
      naicsCodes: Array.from(naics),
      pscCodes: Array.from(psc),
      matchedName: String(reg.legalBusinessName ?? trimmed),
      state: top?.coreData?.physicalAddress?.stateOrProvinceCode ?? null,
      registrationStatus: reg.registrationStatus ?? null,
    };
  }

  /**
   * Enrich one client's gov-ids from SAM. Fill-if-empty only. Returns which
   * fields it (would) fill. Set opts.commit=false for a dry run (no write).
   */
  async enrichGovIds(
    tenantId: string,
    clientId: string,
    opts?: { commit?: boolean },
  ): Promise<{ filled: string[]; matched: boolean }> {
    const commit = opts?.commit ?? true;
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findUnique({
        where: { id: clientId },
        select: {
          id: true,
          name: true,
          uei: true,
          cageCode: true,
          naicsCodes: true,
          pscCodes: true,
          intakeData: true,
        },
      }),
    );
    if (!client) return { filled: [], matched: false };

    const needsUei = !client.uei;
    const needsCage = !client.cageCode;
    const needsNaics = (client.naicsCodes?.length ?? 0) === 0;
    const needsPsc = (client.pscCodes?.length ?? 0) === 0;
    if (!needsUei && !needsCage && !needsNaics && !needsPsc) {
      return { filled: [], matched: false };
    }

    const gov = await this.lookupGovIds(client.name, this.extractState(client.intakeData));
    if (!gov) return { filled: [], matched: false };

    const filled: string[] = [];
    if (needsUei && gov.uei) filled.push('uei');
    if (needsCage && gov.cageCode) filled.push('cageCode');
    if (needsNaics && gov.naicsCodes.length) filled.push('naicsCodes');
    if (needsPsc && gov.pscCodes.length) filled.push('pscCodes');
    if (filled.length === 0) return { filled: [], matched: true };

    if (!commit) {
      this.logger.log(
        `[dry-run] "${client.name}" would fill ${filled.join(',')} from SAM UEI=${gov.uei}`,
      );
      return { filled, matched: true };
    }

    // Fill-if-empty, atomic, RLS-scoped. Scalars guarded by CASE; arrays only
    // replaced when currently empty. Arrays passed as jsonb then expanded to
    // text[] (Prisma $executeRawUnsafe does not bind JS arrays to PG arrays —
    // same pattern as ClientPrepopulationService).
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE clients SET
           uei = CASE WHEN (uei IS NULL OR uei = '') THEN $2 ELSE uei END,
           cage_code = CASE WHEN (cage_code IS NULL OR cage_code = '') THEN $3 ELSE cage_code END,
           naics_codes = CASE WHEN (naics_codes IS NULL OR coalesce(array_length(naics_codes, 1), 0) = 0)
             THEN ARRAY(SELECT jsonb_array_elements_text($4::jsonb)) ELSE naics_codes END,
           psc_codes = CASE WHEN (psc_codes IS NULL OR coalesce(array_length(psc_codes, 1), 0) = 0)
             THEN ARRAY(SELECT jsonb_array_elements_text($5::jsonb)) ELSE psc_codes END,
           intake_data_jsonb = jsonb_set(coalesce(intake_data_jsonb, '{}'::jsonb), '{samEntity}', $6::jsonb),
           updated_at = now()
         WHERE id = $1::uuid`,
        clientId,
        gov.uei,
        gov.cageCode,
        JSON.stringify(gov.naicsCodes),
        JSON.stringify(gov.pscCodes),
        JSON.stringify({
          uei: gov.uei,
          cageCode: gov.cageCode,
          matchedName: gov.matchedName,
          state: gov.state,
          registrationStatus: gov.registrationStatus,
          refreshedAt: new Date().toISOString(),
        }),
      ),
    );
    this.logger.log(`SAM enriched "${client.name}": filled ${filled.join(',')} (UEI=${gov.uei})`);

    // ── Re-run entity resolution when a UEI was filled ──────────────────────
    //
    // SAM enrichment runs AFTER entity resolution on the create path (both are
    // fire-and-forget), so the initial resolveClient call saw clientUei=null and
    // could not auto-confirm contracting or assistance_recipient mappings by UEI.
    // Now that the UEI is persisted, re-resolve so the identifier match path can
    // fire: tier-1 contracting auto-confirm (contractor-identity.ts) and the
    // exact-UEI assistance_recipient candidate (matchAssistanceRecipientByUei).
    //
    // resolveClient is idempotent — it upserts mappings and never downgrades a
    // human-confirmed row — so re-running is safe even if the initial pass already
    // created candidates. It just adds the UEI-driven ones it couldn't before.
    if (filled.includes('uei')) {
      const tenant = await this.prisma.withTenant(tenantId, (tx) =>
        tx.tenant.findUnique({ where: { id: tenantId }, select: { ldaRegistrantId: true } }),
      );
      void this.entityResolution
        .resolveClient(clientId, tenantId, client.name, {
          ldaRegistrantId: tenant?.ldaRegistrantId ?? null,
          clientUei: gov.uei,
          clientCageCode: filled.includes('cageCode') ? gov.cageCode : client.cageCode,
        })
        .catch((e: unknown) =>
          this.logger.warn(
            `post-SAM re-resolution failed for ${clientId}: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
    }

    return { filled, matched: true };
  }

  private extractState(intakeData: unknown): string | null {
    if (intakeData && typeof intakeData === 'object') {
      const v = (intakeData as Record<string, unknown>).state;
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  }

  /**
   * Backfill helper: enrich every non-archived client in a tenant (fill-if-empty).
   * Rate-limited (delayMs between SAM calls) to respect the daily key quota.
   * Defaults to a DRY RUN — pass commit:true to write.
   */
  async enrichAllForTenant(
    tenantId: string,
    opts?: { commit?: boolean; delayMs?: number },
  ): Promise<{ clients: number; matched: number; filled: number }> {
    const commit = opts?.commit ?? false;
    const delayMs = opts?.delayMs ?? 300;
    const clients = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findMany({ where: { status: { not: 'archived' } }, select: { id: true } }),
    );
    let matched = 0;
    let filled = 0;
    for (const c of clients) {
      try {
        const r = await this.enrichGovIds(tenantId, c.id, { commit });
        if (r.matched) matched++;
        if (r.filled.length) filled++;
      } catch (e) {
        this.logger.warn(
          `enrichGovIds(${c.id}) failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (delayMs > 0) await new Promise((res) => setTimeout(res, delayMs));
    }
    return { clients: clients.length, matched, filled };
  }
}
