/**
 * Source registry — turns the committee corpus we already sync into
 * `committee_source` rows the discovery jobs can iterate.
 *
 * The "46 bodies" the coverage contract talks about are not hardcoded here.
 * They are DERIVED from `congress_committee` (the CC0 registry `sync-committees`
 * already maintains), filtered to current PARENT committees. Deriving beats a
 * literal list for two reasons: a committee that is created, renamed or
 * dissolved between Congresses updates itself, and a hardcoded catalog that
 * silently drifts out of date is indistinguishable from full coverage.
 *
 * Source priority is the projection's authority order (lower wins), and it
 * encodes a real editorial judgement:
 *
 *   10  congress-gov       official API; richest and most structured
 *   20  house-repository   House Clerk; faster than the API, thinner
 *   20  senate-schedule    Senate's own feed; authoritative for the Senate
 *   50  committee-site     per-committee HTML; earliest, least structured
 *
 * So a committee page can FILL a witness list days before the API publishes one,
 * but can never overwrite a date the API disagrees with.
 */
import type { PrismaClient } from '@prisma/client';
import { CommitteeSourceRepository } from './committee-source.repository.js';
import { SENATE_SCHEDULE_URL } from './adapters/senate-schedule.adapter.js';
import { HOUSE_DOCS_BASE } from './adapters/house-docs-parse.js';
import { CONGRESS_BASE } from './adapters/congress-gov.adapter.js';
import type { Chamber, SourceDescriptor } from './hearing-discovery.types.js';

export const PRIORITY_CONGRESS_GOV = 10;
export const PRIORITY_HOUSE_REPOSITORY = 20;
export const PRIORITY_SENATE_SCHEDULE = 20;
export const PRIORITY_COMMITTEE_SITE = 50;

/** One congressional body in the coverage catalog. */
export interface CommitteeBody {
  systemCode: string;
  name: string;
  chamber: Chamber;
  /** The committee's own official site, when the registry has one. */
  url: string | null;
}

export class SourceRegistryService {
  private readonly sources: CommitteeSourceRepository;

  constructor(
    private readonly prisma: PrismaClient,
    sources?: CommitteeSourceRepository,
  ) {
    this.sources = sources ?? new CommitteeSourceRepository(prisma);
  }

  /**
   * Current PARENT committees of both chambers plus joint committees — the
   * coverage catalog. Subcommittees are excluded: they hold hearings, but they
   * do so under a parent body's source, and counting them would inflate
   * "coverage" without adding a single new place to look.
   */
  async listBodies(): Promise<CommitteeBody[]> {
    const rows = await this.prisma.congressCommittee.findMany({
      where: { isCurrent: true, parentSystemCode: null },
      select: { systemCode: true, name: true, chamber: true, url: true },
      orderBy: [{ chamber: 'asc' }, { name: 'asc' }],
    });
    return rows.map((r) => ({
      systemCode: r.systemCode,
      name: r.name,
      chamber: (r.chamber as Chamber) ?? 'joint',
      url: r.url,
    }));
  }

  /** systemCode → display name, for adapters that only receive a code. */
  async committeeNameResolver(): Promise<(systemCode: string) => string | null> {
    const rows = await this.prisma.congressCommittee.findMany({
      select: { systemCode: true, name: true },
    });
    const map = new Map(rows.map((r) => [r.systemCode.toLowerCase(), r.name]));
    return (systemCode: string) => map.get(systemCode.toLowerCase()) ?? null;
  }

  /**
   * Display name → systemCode, for docs.house.gov (which publishes only names).
   * Matching is on a normalized form, because the Clerk writes "Appropriations"
   * where the registry has "House Committee on Appropriations". Ambiguous names
   * resolve to null rather than to a guess — an event filed under the wrong
   * committee is worse than one filed under none.
   */
  async systemCodeByNameResolver(
    chamber?: Chamber,
  ): Promise<(committeeName: string) => string | null> {
    const rows = await this.prisma.congressCommittee.findMany({
      where: { isCurrent: true, ...(chamber ? { chamber } : {}) },
      select: { systemCode: true, name: true },
    });
    const index = new Map<string, string[]>();
    for (const r of rows) {
      const key = normalizeCommitteeName(r.name);
      const list = index.get(key) ?? [];
      list.push(r.systemCode);
      index.set(key, list);
    }
    return (committeeName: string) => {
      const key = normalizeCommitteeName(committeeName);
      const exact = index.get(key);
      if (exact && exact.length === 1) return exact[0] ?? null;
      if (exact && exact.length > 1) return null;
      // Fall back to a containment match, but only when exactly ONE registry
      // name contains (or is contained by) the published one.
      const hits: string[] = [];
      for (const [name, codes] of index) {
        if (name.includes(key) || key.includes(name)) hits.push(...codes);
      }
      return hits.length === 1 ? (hits[0] ?? null) : null;
    };
  }

  /**
   * Register the three central schedule sources. These are chamber-wide, so
   * `committeeSystemCode` is null — the same convention Phase 2's schema comment
   * describes for a Senate central schedule row.
   */
  async ensureCentralSources(congress: number): Promise<SourceDescriptor[]> {
    return Promise.all([
      this.sources.ensureSource({
        committeeSystemCode: null,
        chamber: 'joint',
        sourceType: 'CONGRESS_GOV',
        sourceUrl: `${CONGRESS_BASE}/committee-meeting/${congress}`,
        adapterKey: 'congress-gov',
        priority: PRIORITY_CONGRESS_GOV,
        parserVersion: 'congress-gov/2026-08-20',
      }),
      this.sources.ensureSource({
        committeeSystemCode: null,
        chamber: 'house',
        sourceType: 'HOUSE_REPOSITORY',
        sourceUrl: `${HOUSE_DOCS_BASE}/ByDay.aspx`,
        adapterKey: 'house-repository',
        priority: PRIORITY_HOUSE_REPOSITORY,
        parserVersion: 'house-repository/2026-08-20',
      }),
      this.sources.ensureSource({
        committeeSystemCode: null,
        chamber: 'senate',
        sourceType: 'SENATE_SCHEDULE',
        sourceUrl: SENATE_SCHEDULE_URL,
        adapterKey: 'senate-schedule',
        priority: PRIORITY_SENATE_SCHEDULE,
        parserVersion: 'senate-schedule/2026-08-20',
      }),
    ]);
  }

  /**
   * Register one COMMITTEE_SITE source per body that publishes a site. Bodies
   * with no URL in the registry get no source — and the coverage audit reports
   * them as REVIEW_REQUIRED rather than pretending they are covered.
   */
  async ensureCommitteeSiteSources(): Promise<{
    registered: number;
    skippedNoUrl: CommitteeBody[];
  }> {
    const bodies = await this.listBodies();
    const skippedNoUrl: CommitteeBody[] = [];
    let registered = 0;
    for (const body of bodies) {
      const url = normalizeSiteUrl(body.url);
      if (!url) {
        skippedNoUrl.push(body);
        continue;
      }
      await this.sources.ensureSource({
        committeeSystemCode: body.systemCode,
        chamber: body.chamber,
        sourceType: 'COMMITTEE_SITE',
        sourceUrl: url,
        adapterKey: 'committee-site',
        priority: PRIORITY_COMMITTEE_SITE,
        parserVersion: 'committee-site/2026-08-20',
      });
      registered += 1;
    }
    return { registered, skippedNoUrl };
  }
}

/**
 * Fold a committee name to a comparison key: chamber prefixes, the words
 * "committee on", punctuation and case all removed, since the same body is
 * written four different ways across four official sources.
 */
export function normalizeCommitteeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(house|senate|joint)\b/g, ' ')
    .replace(/\bcommittee\s+on\b/g, ' ')
    .replace(/\bcommittee\b/g, ' ')
    .replace(/\bsubcommittee\s+on\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Only http(s) URLs are usable as a source; anything else is treated as absent. */
export function normalizeSiteUrl(url: string | null): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch {
    return null;
  }
}
