import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/config.schema.js';
import { CAGE_RE, UEI_RE } from './vendor-name.util.js';

/**
 * Read-only SAM.gov Entity-Management lookup for the Vendor Reference Pull.
 *
 * Same endpoint, key handling (X-Api-Key HEADER, never a query param) and
 * kill-switch as `SamEntityEnrichmentService.lookupGovIds`, but:
 *   - looks up by UEI or CAGE as well as by legal name,
 *   - returns the FULL entity record (address, expiry, structure) the dossier
 *     needs rather than just the gov-id tuple,
 *   - NEVER writes to a Client row (the enrichment service's whole purpose).
 *
 * `SamEntityEnrichmentService` has no reusable HTTP helper (its fetch is
 * inline in `lookupGovIds`), so this client owns its own call rather than
 * widening a service that exists to mutate the firm's own clients.
 *
 * Fail-soft by contract: a caller always receives a `SamLookupResult`; this
 * class never throws.
 */
export interface SamPhysicalAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
}

export interface SamEntityRecord {
  uei: string;
  cageCode: string | null;
  legalBusinessName: string;
  dbaName: string | null;
  registrationStatus: string | null;
  registrationDate: string | null;
  registrationExpirationDate: string | null;
  lastUpdateDate: string | null;
  physicalAddress: SamPhysicalAddress | null;
  /** SAM's own congressional district for the physical address, facility style ('02'), when present. */
  congressionalDistrict: string | null;
  entityStructure: string | null;
  stateOfIncorporation: string | null;
  primaryNaics: string | null;
  naicsCodes: string[];
  pscCodes: string[];
}

export type SamLookupFailure = 'disabled' | 'no_api_key' | 'http_error' | 'network_error' | 'bad_input';

export type SamLookupResult =
  | { ok: true; entities: SamEntityRecord[] }
  | { ok: false; reason: SamLookupFailure; message: string };

export const SAM_ENTITY_URL = 'https://api.sam.gov/entity-information/v3/entities';
const LOOKUP_TIMEOUT_MS = 25_000;
const INCLUDE_SECTIONS = 'entityRegistration,coreData,assertions';

@Injectable()
export class VendorReferenceSamClient {
  private readonly logger = new Logger(VendorReferenceSamClient.name);
  private readonly apiKey?: string;
  private readonly enabled: boolean;

  constructor(config: ConfigService<AppConfig, true>) {
    this.apiKey = config.get('SAM_GOV_API_KEY', { infer: true });
    this.enabled = config.get('SAM_ENRICHMENT_ENABLED', { infer: true }) !== false;
  }

  lookupByUei(uei: string): Promise<SamLookupResult> {
    const clean = uei.trim().toUpperCase();
    if (!UEI_RE.test(clean)) {
      return Promise.resolve({ ok: false, reason: 'bad_input', message: `"${uei}" is not a 12-character UEI` });
    }
    return this.query({ ueiSAM: clean });
  }

  lookupByCage(cage: string): Promise<SamLookupResult> {
    const clean = cage.trim().toUpperCase();
    if (!CAGE_RE.test(clean)) {
      return Promise.resolve({ ok: false, reason: 'bad_input', message: `"${cage}" is not a 5-character CAGE` });
    }
    return this.query({ cageCode: clean });
  }

  /** All registrations (any status) whose legal business name matches SAM's own search. */
  lookupByName(name: string): Promise<SamLookupResult> {
    const trimmed = name.trim();
    if (trimmed.length < 3) {
      return Promise.resolve({ ok: false, reason: 'bad_input', message: 'name too short for a SAM lookup' });
    }
    return this.query({ legalBusinessName: trimmed });
  }

  private async query(params: Record<string, string>): Promise<SamLookupResult> {
    if (!this.enabled) {
      return { ok: false, reason: 'disabled', message: 'SAM lookups are disabled (SAM_ENRICHMENT_ENABLED=false)' };
    }
    if (!this.apiKey) {
      return { ok: false, reason: 'no_api_key', message: 'SAM_GOV_API_KEY is not configured' };
    }
    const search = new URLSearchParams({ ...params, includeSections: INCLUDE_SECTIONS });
    const label = Object.entries(params)
      .map(([k, v]) => `${k}=${v}`)
      .join('&');

    let json: { entityData?: unknown } | null = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
      try {
        const res = await fetch(`${SAM_ENTITY_URL}?${search.toString()}`, {
          method: 'GET',
          headers: { Accept: 'application/json', 'X-Api-Key': this.apiKey },
          signal: controller.signal,
        });
        if (!res.ok) {
          this.logger.warn(`SAM entity lookup HTTP ${res.status} for ${label}`);
          return { ok: false, reason: 'http_error', message: `SAM.gov responded HTTP ${res.status}` };
        }
        json = (await res.json()) as { entityData?: unknown };
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn(`SAM entity lookup failed for ${label}: ${message}`);
      return { ok: false, reason: 'network_error', message: `SAM.gov lookup failed: ${message}` };
    }

    const rows: unknown[] = Array.isArray(json?.entityData) ? (json!.entityData as unknown[]) : [];
    const entities: SamEntityRecord[] = [];
    for (const row of rows) {
      const parsed = parseSamEntity(row);
      if (parsed) entities.push(parsed);
    }
    return { ok: true, entities };
  }
}

// ── Response parsing (defensive: SAM omits sections it has no data for) ──────

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

export function parseSamEntity(raw: unknown): SamEntityRecord | null {
  const row = rec(raw);
  const reg = rec(row.entityRegistration);
  const core = rec(row.coreData);
  const gs = rec(rec(row.assertions).goodsAndServices);

  const uei = str(reg.ueiSAM)?.toUpperCase() ?? null;
  if (!uei || !UEI_RE.test(uei)) return null;
  const legalBusinessName = str(reg.legalBusinessName);
  if (!legalBusinessName) return null;

  const cageRaw = str(reg.cageCode)?.toUpperCase() ?? null;
  const addr = rec(core.physicalAddress);
  const general = rec(core.generalInformation);
  const hasAddress = Object.keys(addr).length > 0;

  const naics = new Set<string>();
  const primaryNaics = str(gs.primaryNaics);
  if (primaryNaics) naics.add(primaryNaics);
  for (const n of Array.isArray(gs.naicsList) ? gs.naicsList : []) {
    const code = str(rec(n).naicsCode);
    if (code) naics.add(code);
  }
  const psc = new Set<string>();
  for (const p of Array.isArray(gs.pscList) ? gs.pscList : []) {
    const code = str(rec(p).pscCode);
    if (code) psc.add(code);
  }

  // SAM reports the district as a bare number ('2'); facility style is '02'.
  const cdRaw = str(core.congressionalDistrict);
  const congressionalDistrict =
    cdRaw && /^\d{1,2}$/.test(cdRaw) ? cdRaw.padStart(2, '0') : cdRaw;

  return {
    uei,
    cageCode: cageRaw && CAGE_RE.test(cageRaw) ? cageRaw : null,
    legalBusinessName,
    dbaName: str(reg.dbaName),
    registrationStatus: str(reg.registrationStatus),
    registrationDate: str(reg.registrationDate),
    registrationExpirationDate: str(reg.registrationExpirationDate),
    lastUpdateDate: str(reg.lastUpdateDate),
    physicalAddress: hasAddress
      ? {
          line1: str(addr.addressLine1),
          line2: str(addr.addressLine2),
          city: str(addr.city),
          state: str(addr.stateOrProvinceCode)?.toUpperCase() ?? null,
          zip: str(addr.zipCode),
          country: str(addr.countryCode),
        }
      : null,
    congressionalDistrict,
    entityStructure: str(general.entityStructureDesc),
    stateOfIncorporation: str(general.stateOfIncorporationCode),
    primaryNaics,
    naicsCodes: Array.from(naics),
    pscCodes: Array.from(psc),
  };
}
