/**
 * GovInfo CHRG (Congressional Hearings) source adapter — provenance for the
 * printed-hearing corpus.
 *
 * The four legacy canonical rows with transcript-record ids (`{congress}-{jacket}-{date}`)
 * are official GPO/GovInfo Congressional Hearings packages. This adapter turns one
 * package into the normal SourceEvent the existing reconciler consumes:
 *
 *   GovInfo /packages/{id}/summary (chamber, dateIssued, title, lastModified)
 *   GovInfo /packages/{id}/mods    (committee authorityId, heldDates)
 *     -> SourceEvent -> recordObservation -> resolveHearingId -> linkToHearing
 *
 * Identity notes (verified against MODS 2026-09-01):
 *  - MODS `congCommittee/@authorityId` matches the canonical row's `committee_code`
 *    (hsgo00/ssga00/ssap00), so the deterministic 'day' rung (chamber + committee +
 *    calendar day) resolves without any fuzzy matching.
 *  - `calendarDate` = the package's dateIssued — the canonical row represents the
 *    PUBLISHED RECORD (its URL is the CHRG htm); the actual hearing heldDates are
 *    preserved verbatim in source_metadata.raw for audit. (60276: held 2025-06-17/24,
 *    published 2026-09-30 — a real distinction, recorded not erased.)
 *  - The identity guard in the backfill service still pre-resolves BEFORE any write;
 *    a `new` answer refuses the row.
 */
import { fetchJson } from './source-http.js';
import { currentCongress } from './congress-gov.adapter.js';
import type { DiscoveryContext, SourceDescriptor, SourceHealth } from '../hearing-discovery.types.js';

export const GOVINFO_BASE = 'https://api.govinfo.gov';

interface GovInfoCollectionResponse {
  packages?: unknown[];
}

export function govInfoChrgCollectionUrl(
  apiKey: string,
  congress = currentCongress(),
  now = new Date(),
): string {
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - 7);
  const url = new URL(
    `${GOVINFO_BASE}/collections/CHRG/${from.toISOString().replace(/\.\d+Z$/, 'Z')}/${now.toISOString().replace(/\.\d+Z$/, 'Z')}`,
  );
  url.searchParams.set('congress', String(congress));
  url.searchParams.set('pageSize', '1');
  url.searchParams.set('offsetMark', '*');
  url.searchParams.set('api_key', apiKey);
  return url.toString();
}

/** Subset of the GovInfo package summary the adapter needs. */
export interface GovInfoChrgSummary {
  packageId: string;
  title?: string | null;
  dateIssued?: string | null;
  lastModified?: string | null;
  chamber?: string | null;
  congress?: string | number | null;
  documentType?: string | null;
  detailsLink?: string | null;
}

/** Committee lines pulled from the package MODS record. */
export interface GovInfoChrgMods {
  /** authorityId values, e.g. hsgo00 */
  committees: Array<{ authorityId: string; chamber: string; congress: string }>;
  heldDates: string[];
}

export class GovInfoChrgAdapter {
  readonly adapterKey = 'govinfo-chrg';
  readonly parserVersion = 'govinfo-chrg/2026-09-01';

  constructor(private readonly apiKey: string) {}

  async fetchSummary(packageId: string): Promise<GovInfoChrgSummary | null> {
    if (!this.apiKey) throw new Error('GOVINFO_API_KEY is required for the govinfo-chrg adapter');
    const res = await fetchJson<GovInfoChrgSummary>(
      `${GOVINFO_BASE}/packages/${packageId}/summary?api_key=${this.apiKey}`,
      { timeoutMs: 30_000 },
    );
    return res.data ?? null;
  }

  async healthCheck(_source: SourceDescriptor, _ctx: DiscoveryContext): Promise<SourceHealth> {
    if (!this.apiKey) {
      return { ok: false, status: null, durationMs: 0, error: 'GOVINFO_API_KEY is required for the govinfo-chrg adapter', observedEvents: null };
    }
    const res = await fetchJson<GovInfoCollectionResponse>(
      govInfoChrgCollectionUrl(this.apiKey),
      { timeoutMs: 15_000 },
    );
    return {
      ok: res.ok,
      status: res.status,
      durationMs: res.durationMs,
      error: res.error?.replaceAll(this.apiKey, '[redacted]') ?? null,
      observedEvents: res.data?.packages?.length ?? null,
    };
  }

  async fetchMods(packageId: string): Promise<GovInfoChrgMods | null> {
    if (!this.apiKey) throw new Error('GOVINFO_API_KEY is required for the govinfo-chrg adapter');
    const res = await fetchJson<unknown>(
      `${GOVINFO_BASE}/packages/${packageId}/mods?api_key=${this.apiKey}`,
      { timeoutMs: 60_000 },
    );
    const xml = typeof res.data === 'string' ? res.data : null;
    if (!xml) return null;
    const committees = [...xml.matchAll(
      /<congCommittee authorityId="([a-z0-9]+)" chamber="([HSJ])" congress="(\d+)"/g,
    )].map((m) => ({ authorityId: m[1] as string, chamber: m[2] as string, congress: m[3] as string }));
    const heldDates = [...xml.matchAll(/<heldDate>([\d-]+)<\/heldDate>/g)].map((m) => m[1] as string);
    return { committees, heldDates };
  }
}
