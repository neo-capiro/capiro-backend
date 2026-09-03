/**
 * Official-time observation — MANUAL-ONLY Phase 9 job.
 *
 * PURPOSE (2026-09-04 field-hearing correction, QA brief §4/§6)
 * A central calendar can encode a field hearing's LOCAL wall clock as an
 * Eastern instant (cm-119-119533: "1:00 PM" PT published as 17:00Z). Authority
 * rule: an explicit first-party committee announcement stating a local time AND
 * zone outweighs that ambiguous instant. This job re-observes window hearings
 * through the committee's OWN official site (the announcement's home), extracts
 * an explicit local-clock + zone statement with a hard rule, and reconciles the
 * resulting SourceEvent through the SAME ledger + reconciler as every other
 * observation. The projection (canonical-diff) then grants the explicit-local
 * time write authority over the legacy display columns.
 *
 * HARD RULES (mirrors provenance-backfill discipline):
 *  - manual-only; never scheduled; never a required job.
 *  - Zone evidence is an EXPLICIT statement ("1:00 PM PT", "10:00 AM Eastern")
 *    — never inferred from a location string ("California" proves nothing).
 *  - Identity FIRST: the match ladder must resolve the observation to the SAME
 *    canonical hearing; anything else is refused (a correction never re-points
 *    identity, and a `new` answer means the parse found something else).
 *  - No synthetic data: a page without an explicit zone statement is honestly
 *    SKIPPED, not coerced.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { fetchText } from '../../hearing-discovery/adapters/source-http.js';
import {
  cleanTextSafe,
  extractExplicitLocalTime,
} from './official-time-evidence.js';
import { resolveSourceTime } from '../../hearing-discovery/hearing-time.js';
import { HearingReconcilerService } from '../../hearing-discovery/hearing-reconciler.service.js';
import type { SourceDescriptor, SourceEvent } from '../../hearing-discovery/hearing-discovery.types.js';

export interface OfficialTimeObservationOptions {
  manual: boolean;
  lookbackDays?: number;
  lookaheadDays?: number;
  limit?: number;
  reportOnly?: boolean;
  reconcilerFactory?: () => Pick<HearingReconcilerService, 'reconcileEvent'>;
}

export interface OfficialTimeCandidate {
  hearingId: string;
  title: string | null;
  officialUrl: string | null;
  currentStartsAt: string | null;
  classification:
    | 'PENDING'
    | 'EXPLICIT_LOCAL_OBSERVED'
    | 'NO_ZONE_EVIDENCE'
    | 'FETCH_FAILED'
    | 'SKIPPED_IDENTITY_CONFLICT'
    | 'ERROR';
  /** The evidence line + resolved zone, for the operator report. */
  evidence?: string;
  derivedStartsAt?: string;
  derivedTimeZone?: string;
  error?: string;
}

export interface OfficialTimeObservationResult {
  mode: 'REPORT_ONLY' | 'APPLY';
  scanned: number;
  observed: number;
  noZoneEvidence: number;
  fetchFailed: number;
  identityConflicts: number;
  errors: number;
  candidates: OfficialTimeCandidate[];
}

interface Row {
  id: string;
  title: string | null;
  url: string | null;
  chamber: string | null;
  congress: number | null;
  committee_system_code: string | null;
  committee_code: string | null;
  starts_at: Date | null;
  date: Date | null;
  timezone: string | null;
}

const PARSER_VERSION = 'official-time-observation/2026-09-04';

@Injectable()
export class LegiWatchPhase9OfficialTimeObservationService {
  constructor(private readonly prisma: PrismaService) {}

  async run(input: OfficialTimeObservationOptions): Promise<OfficialTimeObservationResult> {
    if (!input.manual) {
      throw new Error('official-time-observation is manual-only; pass --manual');
    }
    const lookbackDays = bounded(input.lookbackDays ?? 7, 1, 60);
    const lookaheadDays = bounded(input.lookaheadDays ?? 30, 1, 60);
    const limit = bounded(input.limit ?? 25, 1, 200);

    const rows = await this.prisma.$queryRawUnsafe<Row[]>(
      `SELECT h.id, h.title, h.url, h.chamber, h.congress, h.committee_system_code,
              h.committee_code, h.starts_at, h.date, h.timezone
       FROM committee_hearing h
       WHERE COALESCE(h.starts_at, h.date::timestamp)
               BETWEEN now() - ($1 || ' days')::interval
                   AND now() + ($2 || ' days')::interval
         AND h.url IS NOT NULL
         AND h.event_status IN ('scheduled', 'postponed')
         AND COALESCE(h.timezone, 'America/New_York') = 'America/New_York'
       ORDER BY COALESCE(h.starts_at, h.date::timestamp) ASC, h.id ASC
       LIMIT $3::int`,
      String(lookbackDays),
      String(lookaheadDays),
      limit,
    );

    const result: OfficialTimeObservationResult = {
      mode: input.reportOnly ? 'REPORT_ONLY' : 'APPLY',
      scanned: rows.length,
      observed: 0,
      noZoneEvidence: 0,
      fetchFailed: 0,
      identityConflicts: 0,
      errors: 0,
      candidates: [],
    };
    if (input.reportOnly || rows.length === 0) {
      result.candidates = rows.map((r) => ({
        hearingId: r.id,
        title: r.title,
        officialUrl: r.url,
        currentStartsAt: r.starts_at?.toISOString() ?? null,
        classification: 'PENDING' as const,
      }));
      return result;
    }

    const reconciler = input.reconcilerFactory
      ? input.reconcilerFactory()
      : new HearingReconcilerService(this.prisma);

    for (const row of rows) {
      const candidate: OfficialTimeCandidate = {
        hearingId: row.id,
        title: row.title,
        officialUrl: row.url,
        currentStartsAt: row.starts_at?.toISOString() ?? null,
        classification: 'PENDING',
      };
      try {
        const source = await this.committeeSiteSource(row);
        if (!source?.sourceUrl) {
          candidate.classification = 'NO_ZONE_EVIDENCE';
          result.noZoneEvidence += 1;
          result.candidates.push(candidate);
          continue;
        }
        const page = await fetchText(source.sourceUrl, { accept: 'text/html', timeoutMs: 15_000 });
        if (!page.ok || page.body == null) {
          candidate.classification = 'FETCH_FAILED';
          result.fetchFailed += 1;
          result.candidates.push(candidate);
          continue;
        }
        const text = cleanTextSafe(page.body);
        const evidence = extractExplicitLocalTime(text);
        if (!evidence) {
          // No explicit zone statement on the committee page: an honest skip.
          // Never coerce a zone from the location string.
          candidate.classification = 'NO_ZONE_EVIDENCE';
          result.noZoneEvidence += 1;
          result.candidates.push(candidate);
          continue;
        }
        const calendarDay = row.date ?? new Date(`${(row.starts_at ?? new Date()).toISOString().slice(0, 10)}T00:00:00Z`);
        const resolved = resolveSourceTime({
          instant: null,
          calendarDay,
          displayClock: evidence.clock,
          zoneToken: evidence.zoneToken,
        });
        if (resolved.authority !== 'explicit_local' || !resolved.startsAt) {
          candidate.classification = 'NO_ZONE_EVIDENCE';
          result.noZoneEvidence += 1;
          result.candidates.push(candidate);
          continue;
        }
        candidate.evidence = evidence.snippet;
        candidate.derivedStartsAt = resolved.startsAt.toISOString();
        candidate.derivedTimeZone = resolved.timeZone;

        const event: SourceEvent = {
          externalEventId: externalEventIdOf(row),
          congress: row.congress ?? undefined,
          chamber: normalizeChamber(row.chamber),
          committeeSystemCode: row.committee_system_code ?? row.committee_code,
          title: row.title,
          startsAt: resolved.startsAt,
          calendarDate: resolved.calendarDate,
          displayTime: resolved.displayTime,
          timeZone: resolved.timeZone,
          timeAuthority: 'explicit_local',
          officialPageUrl: source.sourceUrl,
          raw: {
            announcementSnippet: evidence.snippet,
            announcementUrl: source.sourceUrl,
            parserVersion: PARSER_VERSION,
          },
        };
        const outcome = await reconciler.reconcileEvent(source, event, new Date());
        if (outcome.hearingId !== row.id) {
          candidate.classification = 'SKIPPED_IDENTITY_CONFLICT';
          result.identityConflicts += 1;
        } else {
          candidate.classification = 'EXPLICIT_LOCAL_OBSERVED';
          result.observed += 1;
        }
      } catch (err) {
        candidate.classification = 'ERROR';
        candidate.error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
        result.errors += 1;
      }
      result.candidates.push(candidate);
    }
    return result;
  }

  /** The committee's official-site source row (already registered by discovery). */
  private async committeeSiteSource(row: Row): Promise<SourceDescriptor | null> {
    const systemCode = row.committee_system_code ?? row.committee_code;
    if (!systemCode) return null;
    const rows = await this.prisma.$queryRawUnsafe<SourceDescriptor[]>(
      `SELECT id, committee_system_code AS "committeeSystemCode", chamber,
              source_type AS "sourceType", source_url AS "sourceUrl",
              adapter_key AS "adapterKey", priority, parser_version AS "parserVersion"
       FROM committee_source
       WHERE adapter_key = 'committee-site' AND committee_system_code = $1 AND enabled = true
       ORDER BY priority ASC
       LIMIT 1`,
      systemCode,
    );
    return rows[0] ?? null;
  }
}

function bounded(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.floor(v)));
}

function normalizeChamber(raw: string | null): 'house' | 'senate' | 'joint' {
  const c = (raw ?? '').trim().toLowerCase();
  if (c === 'house') return 'house';
  if (c === 'senate') return 'senate';
  return 'joint';
}

/** cm- rows carry the numeric Congress.gov event id in their canonical id. */
function externalEventIdOf(row: Row): string {
  const m = /^cm-\d+-(\d+)$/.exec(row.id);
  if (m?.[1]) return m[1];
  throw new Error(`no external event id derivable for ${row.id}`);
}
