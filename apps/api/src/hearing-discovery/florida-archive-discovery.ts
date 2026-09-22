import { PrismaClient } from '@prisma/client';
import { CommitteeSourceRepository } from './committee-source.repository.js';
import { HearingReconcilerService } from './hearing-reconciler.service.js';
import { StreamCandidateRepository } from './stream-candidate.repository.js';
import { runWithSyncRun } from '../ingestion/sync-run.helper.js';
import type { LegislativeObservation } from './legislative-calendar.js';
import {
  FL_ARCHIVE_PARSER,
  FL_CHANNEL,
  FL_SENATE,
  classifyFloridaChannelTitle,
  fetchFloridaChannelSource,
  fetchFloridaSource,
  floridaChannelObservation,
  floridaChannelSessionProgramId,
  floridaChannelTitleDate,
  floridaKalturaEntryId,
  isFloridaChannelVideoPage,
  senateMediaArchive,
} from './adapters/florida-calendar.adapter.js';
import {
  discoverFloridaCalendar,
  floridaCalendarDate,
  floridaCalendarSessions,
  isFloridaSessionCode,
} from './florida-calendar-discovery.js';

/** Rate limit between publisher reads. */
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The meeting day an observation was projected onto (from its stored snapshot). */
function observationLegislative(sourceMetadata: unknown):
  | {
      officialIdentity?: string;
      bodySourceKey?: string;
      chamber?: string;
      sourceUrl?: string;
      fields?: { watchUrl?: unknown };
      /** The publisher's own media identity (Kaltura entry id), persisted
       *  with the observation so crosswalk probes never refetch every
       *  archive page on later runs. JSON-only — no migration. */
      publisherMediaEntryId?: string;
    }
  | undefined {
  const leg = (sourceMetadata as { legislative?: unknown } | null)?.legislative;
  return leg && typeof leg === 'object'
    ? (leg as {
        officialIdentity?: string;
        bodySourceKey?: string;
        chamber?: string;
        sourceUrl?: string;
        fields?: { watchUrl?: unknown };
        publisherMediaEntryId?: string;
      })
    : undefined;
}

export type FloridaArchiveOptions = {
  session: string;
  from?: string; // default {session}-01-01
  to?: string; // default today
  /** Opt-in: also re-walk the chamber notice/daily adapters over the window
   *  (bounded in <=31-day chunks). Off by default — the archive inventory is
   *  the historical backfill; the recurring florida job owns recent notices. */
  notices?: boolean;
  /** Opt-in: also reconcile the Senate media catalog (official alternative
   *  player pages). Bounded by the archive window — the catalog is only walked
   *  while its rows are inside [from, to], so no ~600-page historical crawl. */
  catalog?: boolean;
  delayMs?: number;
  log?: (message: string) => void;
  fetchChamber?: (url: string) => Promise<Uint8Array>;
  fetchChannel?: (url: string) => Promise<{ bytes: Uint8Array; totalPages: number | null }>;
  /** Shared by a multi-session fall pass. A video tagged to both adjacent
   * session taxonomies is processed once by its stable WordPress id. */
  seenVideoIds?: Set<number>;
};

export type FloridaArchiveReport = {
  pages: number;
  listed: number;
  accepted: number;
  inserted: number;
  updated: number;
  unchanged: number;
  rejected: Array<{ reason: string; count: number }>;
  ambiguous: string[];
  issues: string[];
  errors: number;
  catalog: { rows: number; attached: number; reported: number; failures: number };
};

type FloridaChannelArchiveRecord = {
  id: number;
  date: string;
  link: string;
  title: { rendered: string };
  content: { rendered: string };
  video_programs: number[];
};

/** TFC is requested newest-first. Once every publisher timestamp on a page is
 * older than the lower bound, every later page is out of range too. Invalid
 * timestamps keep pagination going rather than making an unsafe assumption. */
export function floridaArchivePageBefore(
  records: ReadonlyArray<Pick<FloridaChannelArchiveRecord, 'date'>>,
  from: string,
): boolean {
  return (
    records.length > 0 &&
    records.every(
      (record) => /^\d{4}-\d{2}-\d{2}/.test(record.date) && record.date.slice(0, 10) < from,
    )
  );
}

/**
 * Historical Florida backfill. The TFC WP archive is the PRIMARY inventory;
 * the chamber notice pass is an explicit opt-in. Idempotent: canonical
 * identity `fl:tfc:video:{wpId}` is stable per archive record, the TFC source
 * observation is keyed on it, and the reconciler's official-identity alias
 * attaches a later chamber notice for the same proceeding to the same row
 * (proven by test). Strong-proof crosswalk only — shared Kaltura entry id or
 * exact source/watch page — never title/date alone.
 */
export async function backfillFloridaArchive(
  prisma: PrismaClient,
  options: FloridaArchiveOptions,
): Promise<{ archive: FloridaArchiveReport; notices: unknown[] | null }> {
  if (!isFloridaSessionCode(options.session))
    throw new Error('valid Florida session code is required');
  // Default to the September interim that opens the session's archive (the
  // 2026 taxonomy holds 2025-09 interim weeks) rather than the calendar year.
  const from = options.from ?? `${Number(options.session.slice(0, 4)) - 1}-09-01`;
  const to = options.to ?? new Date().toISOString().slice(0, 10);
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  if (
    !DAY.test(from) ||
    !DAY.test(to) ||
    new Date(`${from}T00:00:00Z`).toISOString().slice(0, 10) !== from ||
    new Date(`${to}T00:00:00Z`).toISOString().slice(0, 10) !== to
  )
    throw new Error('from/to must be valid YYYY-MM-DD calendar days');
  if (from > to) throw new Error('from must not follow to');
  const log = options.log ?? (() => {});
  const delay = options.delayMs ?? 400;
  const fetchChamber = options.fetchChamber ?? fetchFloridaSource;
  const fetchChannel = options.fetchChannel ?? fetchFloridaChannelSource;
  const repo = new CommitteeSourceRepository(prisma);
  const reconciler = new HearingReconcilerService(prisma);
  const candidates = new StreamCandidateRepository(prisma);

  const source = await repo.ensureSource({
    committeeSystemCode: null,
    chamber: 'joint',
    sourceType: 'COMMITTEE_API',
    sourceUrl: `${FL_CHANNEL}/videos/`,
    adapterKey: 'florida-channel-archive',
    priority: 20,
    parserVersion: FL_ARCHIVE_PARSER,
    enabled: true,
  });
  if (
    !(await repo.listEnabled({ adapterKey: 'florida-channel-archive' })).some(
      (s) => s.id === source.id,
    )
  ) {
    throw new Error('florida-channel-archive source disabled by operator');
  }
  await repo.markChecked(source.id, new Date());

  const totals = {
    pages: 0,
    listed: 0,
    accepted: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    rejected: new Map<string, number>(),
    ambiguous: [] as string[],
    issues: [] as string[],
    errors: 0,
    catalog: { rows: 0, attached: 0, reported: 0, failures: 0 },
  };
  const reject = (reason: string) =>
    totals.rejected.set(reason, (totals.rejected.get(reason) ?? 0) + 1);
  // Publisher page → Kaltura entry, read at most once per run.
  const probeCache = new Map<string, string | null>();
  const probe = async (page: string): Promise<string | null> => {
    if (!probeCache.has(page)) {
      try {
        const isChannel = new URL(page).hostname.toLowerCase() === 'thefloridachannel.org';
        const bytes = isChannel ? (await fetchChannel(page)).bytes : await fetchChamber(page);
        probeCache.set(page, floridaKalturaEntryId(new TextDecoder().decode(bytes)));
      } catch {
        probeCache.set(page, null); // an unreadable page proves nothing either way
      }
    }
    return probeCache.get(page) ?? null;
  };

  try {
    // 1. Resolve this session's taxonomy term; never hardcode the id, and
    //    never page the unfiltered taxonomy (2026 may be past the first 100).
    const programs = JSON.parse(
      new TextDecoder().decode(
        (
          await fetchChannel(
            `${FL_CHANNEL}/api/wp/v2/video_programs?search=${options.session}&per_page=100&_fields=id,name`,
          )
        ).bytes,
      ),
    ) as Array<{ id: number; name: string }>;
    totals.pages++;
    const programId = floridaChannelSessionProgramId(programs, options.session);
    if (!programId)
      throw new Error(
        `The Florida Channel has no "${options.session} Legislative Session" program`,
      );

    // 2. Bound through the archive pages. `X-WP-TotalPages` caps the walk when
    //    the publisher reports it; a WP 400 on a paged request is the end.
    // Hard bound even when the publisher omits X-WP-TotalPages: 100 records a
    // page, and no Florida legislative session archive exceeds 50 pages.
    const MAX_ARCHIVE_PAGES = 50;
    let totalPages: number | null = null;
    for (
      let page = 1;
      (totalPages === null || page <= totalPages) && page <= MAX_ARCHIVE_PAGES;
      page++
    ) {
      await pause(delay);
      const response = await fetchChannel(
        `${FL_CHANNEL}/api/wp/v2/videos?video_programs=${programId}&per_page=100&page=${page}` +
          `&orderby=date&order=desc&_fields=id,date,link,title,content,video_programs`,
      );
      if (!response.bytes.length) break; // HTTP 400 end-of-pagination
      totals.pages++;
      if (response.totalPages) totalPages = response.totalPages;
      const records = JSON.parse(
        new TextDecoder().decode(response.bytes),
      ) as FloridaChannelArchiveRecord[];
      if (!Array.isArray(records) || !records.length) break;
      if (floridaArchivePageBefore(records, from)) break;
      if (page === MAX_ARCHIVE_PAGES)
        totals.issues.push(`Archive pagination hit the ${MAX_ARCHIVE_PAGES}-page safety bound`);
      for (const record of records) {
        totals.listed++;
        // Qualify BEFORE any per-record network: the page fallback below must
        // never fetch an out-of-window or out-of-program record (recurring
        // runs re-walk recent pages and would otherwise pay one publisher
        // request per missing-player record outside their window).
        const classification = classifyFloridaChannelTitle(record.title.rendered);
        const inProgram = record.video_programs.includes(programId);
        const titleDate = floridaChannelTitleDate(record.title.rendered);
        if (
          inProgram &&
          titleDate !== null &&
          titleDate >= from &&
          titleDate <= to &&
          options.seenVideoIds
        ) {
          if (options.seenVideoIds.has(record.id)) continue;
          options.seenVideoIds.add(record.id);
        }
        // The WP content usually carries the player; when it does not, the
        // rendered video page can still embed it (TFC 78898). ONE bounded
        // fetch, and only after the record is source/title/session-qualified
        // AND inside the requested window AND the link is verified as an
        // exact HTTPS thefloridachannel.org /videos/<slug>/ page with no
        // credentials or non-standard port — never a speculative per-record
        // crawl of arbitrary URLs.
        let pageHtml: string | null = null;
        if (
          inProgram &&
          classification.legislative &&
          titleDate !== null &&
          titleDate >= from &&
          titleDate <= to &&
          !floridaKalturaEntryId(record.content.rendered) &&
          isFloridaChannelVideoPage(record.link)
        ) {
          await pause(delay);
          try {
            pageHtml = new TextDecoder().decode((await fetchChannel(record.link)).bytes);
          } catch {
            pageHtml = null; // an unreadable page is not proof
          }
        }
        const built = floridaChannelObservation({
          id: record.id,
          link: record.link,
          title: record.title.rendered,
          contentHtml: record.content.rendered,
          pageHtml,
          programIds: record.video_programs,
          sessionProgramId: programId,
          session: options.session,
        });
        if ('rejected' in built) {
          reject(built.rejected.replace(/^video \d+:?\s*/, ''));
          continue;
        }
        const { observation, kalturaEntryId } = built;
        // Cache this record's own page → entry so later crosswalk probes never
        // refetch a page this run already parsed.
        probeCache.set(record.link, kalturaEntryId);
        // Persist the publisher's own media identity on the observation: the
        // notice-path crosswalk and later reimports match on it without ever
        // refetching every archive page (JSON-only; no migration).
        (observation as { publisherMediaEntryId?: string }).publisherMediaEntryId = kalturaEntryId;
        const date = observation.fields.time!.date;
        if (date < from || date > to) continue;
        totals.accepted++;
        try {
          // CROSSWALK: strong proof only (shared Kaltura entry id on a stored
          // FL source/watch page for the same date, or this exact archive page
          // already observed). Overlap without proof blocks creation — a
          // plausible same-proceeding row is reported, never duplicated.
          const exact = await findFloridaHearingByExactPage(prisma, record.link);
          let existing = exact;
          if (!existing) {
            try {
              existing = await findFloridaHearingByKalturaEntry(
                prisma,
                kalturaEntryId,
                { date, chamber: observation.chamber },
                probe,
              );
            } catch (e) {
              // Ambiguous proof: report and skip — never create a duplicate.
              totals.ambiguous.push(
                `fl:tfc:video:${record.id}: ${e instanceof Error ? e.message : String(e)}`,
              );
              continue;
            }
          }
          if (existing) {
            // Attach this archive observation to the PROVEN proceeding by its
            // canonical id — never by clearing the archive's own identity onto
            // the proceeding's (that would destroy the alias bridge a later
            // chamber notice uses, and would rewrite a linked observation's
            // source-keyed identity, which the reconciler correctly refuses).
            observation.issues.push(
              `Crosswalked by strong proof (${exact ? 'exact page' : `Kaltura entry ${kalturaEntryId}`}) to canonical ${existing.hearingId}.`,
            );
          } else {
            const overlap = await unverifiedFloridaOverlap(
              prisma,
              date,
              observation.chamber,
              observation.bodyName,
            );
            if (overlap.length) {
              totals.ambiguous.push(
                `fl:tfc:video:${record.id} (${date} ${observation.bodyName}) overlaps ` +
                  `${overlap.join(', ')} without strong proof; left uncreated`,
              );
              continue;
            }
          }
          // externalEventId is the STABLE archive identity, unchanged by any
          // crosswalk above: the TFC source's observation of this record keeps
          // its own key, so re-runs never fork the observation ledger.
          const outcome = await reconciler.reconcileEvent(
            source,
            {
              externalEventId: `fl:tfc:video:${record.id}`,
              chamber: observation.chamber,
              legislative: observation,
              // Strong-proof canonical attachment (exact page or shared Kaltura
              // entry). Absent proof, the archive's own identity keys the row.
              canonicalHearingId: existing?.hearingId ?? null,
            },
            new Date(),
          );
          if (outcome.hearingCreated) totals.inserted++;
          else if (outcome.changedFields.length) totals.updated++;
          else totals.unchanged++;
          // Always record the TFC record's own exact page as its provider's
          // candidate, even when the watch fact was upgraded to a chamber page.
          await candidates.recordCandidates(
            outcome.hearingId,
            [
              {
                provider: 'florida-channel',
                officialPageUrl: record.link,
                mediaUrl: null,
                capturePolicy: 'BROWSER_CAPTURE_ONLY',
                priority: 20,
              },
            ],
            { now: new Date(), sourceId: source.id },
          );
          log(
            JSON.stringify({
              hearingId: outcome.hearingId,
              created: outcome.hearingCreated,
              date,
              body: observation.bodyName,
            }),
          );
        } catch (e) {
          totals.errors++;
          totals.issues.push(
            `fl:tfc:video:${record.id}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }

    // 3. Senate media catalog (OPT-IN): official alternative player pages and
    //    crosswalk evidence ONLY. Walked while its rows are inside the archive
    //    window; it never creates a canonical row.
    if (options.catalog) {
      const catalog = await reconcileSenateMediaCatalog(prisma, {
        candidates,
        probe,
        delay,
        log,
        from,
        to,
        fetchChamber,
      });
      totals.issues.push(...catalog.issues);
      totals.ambiguous.push(...catalog.ambiguous);
      totals.catalog = {
        rows: catalog.rows,
        attached: catalog.attached,
        reported: catalog.reported,
        failures: catalog.issues.length,
      };
    }
  } catch (e) {
    await repo.recordOutcome(
      source.id,
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      new Date(),
      FL_ARCHIVE_PARSER,
    );
    throw e;
  }
  await repo.recordOutcome(
    source.id,
    // Ambiguities are reported-and-skipped coverage gaps: the source run is
    // not fully healthy while any record is blocked on ambiguous proof.
    {
      ok: totals.errors === 0 && totals.issues.length === 0 && totals.ambiguous.length === 0,
      error:
        totals.issues[0] ??
        (totals.ambiguous.length ? `${totals.ambiguous.length} ambiguous crosswalk(s)` : undefined),
    },
    new Date(),
    FL_ARCHIVE_PARSER,
  );
  const report: FloridaArchiveReport = {
    ...totals,
    rejected: [...totals.rejected.entries()].map(([reason, count]) => ({ reason, count })),
  };
  log(JSON.stringify(report));

  // 4. Chamber notices — explicit opt-in, chunked to the adapters' 31-day
  //    contract. Existing canonical rows reconcile, never duplicate.
  let notices: unknown[] | null = null;
  if (options.notices) {
    notices = [];
    for (let start = new Date(`${from}T00:00:00Z`); start.toISOString().slice(0, 10) <= to; ) {
      const end = new Date(
        Math.min(
          start.getTime() + 30 * 86400000,
          Date.parse(`${to}T00:00:00Z`) + 86399999, // include the final day
        ),
      );
      notices.push(
        ...(await discoverFloridaCalendar(prisma, {
          from: start.toISOString().slice(0, 10),
          to: end.toISOString().slice(0, 10),
          session: options.session,
          delayMs: delay,
          log,
          fetchSource: options.fetchChamber,
        })),
      );
      start.setUTCDate(start.getUTCDate() + 31);
    }
  }
  return { archive: report, notices };
}

export type FloridaArchiveBatchMetrics = {
  archiveSessions: number;
  archiveSessionsCompleted: number;
  archiveSessionFailures: number;
  archivePages: number;
  archiveListed: number;
  archiveAccepted: number;
  archiveInserted: number;
  archiveUpdated: number;
  archiveUnchanged: number;
  archiveRejected: number;
  archiveErrors: number;
  archiveIssues: number;
  archiveAmbiguous: number;
  archiveCatalogRows: number;
  archiveCatalogAttached: number;
  archiveCatalogReported: number;
  archiveCatalogFailures: number;
  archivePartial: boolean;
  archiveFailedSessions: string;
};

/** Run the recurring archive against every active/default session. Adjacent
 * fall taxonomies can contain the same TFC video, so a shared stable-id set
 * prevents duplicate processing while each taxonomy is still probed. */
export async function backfillFloridaArchiveSessions(
  prisma: PrismaClient,
  options: Omit<FloridaArchiveOptions, 'session' | 'seenVideoIds'> & { sessions: string[] },
  dependency: typeof backfillFloridaArchive = backfillFloridaArchive,
): Promise<FloridaArchiveBatchMetrics> {
  const sessions = [...new Set(options.sessions.map((session) => session.trim().toUpperCase()))];
  if (
    !sessions.length ||
    sessions.length > 2 ||
    sessions.some((session) => !isFloridaSessionCode(session))
  ) {
    throw new Error('Florida archive requires one or two valid Florida session codes');
  }
  const metrics: FloridaArchiveBatchMetrics = {
    archiveSessions: sessions.length,
    archiveSessionsCompleted: 0,
    archiveSessionFailures: 0,
    archivePages: 0,
    archiveListed: 0,
    archiveAccepted: 0,
    archiveInserted: 0,
    archiveUpdated: 0,
    archiveUnchanged: 0,
    archiveRejected: 0,
    archiveErrors: 0,
    archiveIssues: 0,
    archiveAmbiguous: 0,
    archiveCatalogRows: 0,
    archiveCatalogAttached: 0,
    archiveCatalogReported: 0,
    archiveCatalogFailures: 0,
    archivePartial: false,
    archiveFailedSessions: '',
  };
  const seenVideoIds = new Set<number>();
  const failedSessions: string[] = [];
  let catalogPending = options.catalog === true;
  const { sessions: _sessions, ...archiveOptions } = options;
  for (const session of sessions) {
    try {
      const result = await dependency(prisma, {
        ...archiveOptions,
        session,
        catalog: catalogPending,
        seenVideoIds,
      });
      catalogPending = false;
      const report = result.archive;
      metrics.archiveSessionsCompleted++;
      metrics.archivePages += report.pages;
      metrics.archiveListed += report.listed;
      metrics.archiveAccepted += report.accepted;
      metrics.archiveInserted += report.inserted;
      metrics.archiveUpdated += report.updated;
      metrics.archiveUnchanged += report.unchanged;
      metrics.archiveRejected += report.rejected.reduce((sum, row) => sum + row.count, 0);
      metrics.archiveErrors += report.errors;
      metrics.archiveIssues += report.issues.length;
      metrics.archiveAmbiguous += report.ambiguous.length;
      metrics.archiveCatalogRows += report.catalog.rows;
      metrics.archiveCatalogAttached += report.catalog.attached;
      metrics.archiveCatalogReported += report.catalog.reported;
      metrics.archiveCatalogFailures += report.catalog.failures;
    } catch (error) {
      metrics.archiveSessionFailures++;
      metrics.archiveErrors++;
      failedSessions.push(`${session}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  metrics.archiveFailedSessions = failedSessions.join('; ').slice(0, 1000);
  metrics.archivePartial =
    metrics.archiveSessionFailures > 0 ||
    metrics.archiveErrors > 0 ||
    metrics.archiveIssues > 0 ||
    metrics.archiveAmbiguous > 0 ||
    metrics.archiveCatalogFailures > 0;
  return metrics;
}

/** The proceeding an archive record is PROVEN to belong to. Callers consume
 *  ONLY the canonical id — the repository validates the actual row metadata
 *  (geography/chamber/session/body) at reconcile time, so returning stale
 *  ledger metadata here could only mislead. */
export type FloridaArchiveMatch = {
  hearingId: string;
};

/**
 * Strong proof by EXACT URL: a canonical FL hearing whose own `url`, an
 * existing stream candidate, or a stored observation's source/watch page IS
 * this page. Distinct from title/date matching — the publisher URL is stable
 * per event. Returns at most one hearing; more than one is a data conflict.
 * No observation ledger is required: an exact canonical URL/candidate match
 * attaches by itself, never returns null to let the caller create a duplicate.
 */
async function findFloridaHearingByExactPage(
  prisma: PrismaClient,
  page: string,
): Promise<FloridaArchiveMatch | null> {
  const ids = new Set<string>();
  const byUrl = await prisma.committeeHearing.findMany({
    where: { geographicJurisdiction: 'FL', canonicalHearingId: null, url: page },
    select: { id: true },
    take: 5,
  });
  for (const row of byUrl) ids.add(row.id);
  const candidateRows = await prisma.hearingStreamCandidate.findMany({
    where: { officialPageUrl: page },
    select: { hearingId: true },
    take: 5,
  });
  const observationRows = await prisma.hearingSourceObservation.findMany({
    where: {
      hearingId: { not: null },
      OR: [
        { sourceMetadata: { path: ['legislative', 'sourceUrl'], equals: page } },
        { sourceMetadata: { path: ['legislative', 'fields', 'watchUrl'], equals: page } },
      ],
    },
    select: { hearingId: true },
    take: 5,
  });
  const referenced = new Set<string>([
    ...candidateRows.map((r) => r.hearingId),
    ...observationRows.map((r) => r.hearingId!),
  ]);
  if (referenced.size) {
    const hearings = await prisma.committeeHearing.findMany({
      where: {
        id: { in: [...referenced] },
        geographicJurisdiction: 'FL',
        canonicalHearingId: null,
      },
      select: { id: true },
      take: 10,
    });
    for (const row of hearings) ids.add(row.id);
  }
  if (!ids.size) return null;
  if (ids.size > 1)
    throw new Error(`Exact page ${page} is cited by ${ids.size} canonical Florida hearings`);
  return { hearingId: [...ids][0]! };
}

/**
 * The stored FL proceedings a TFC record could be — WITHOUT strong proof.
 * Date + chamber narrow the candidate set; a body token overlap is reported
 * for a human, never auto-merged and never silently duplicated.
 */
/**
 * Normalize a published body name for OVERLAP comparison only (never identity):
 * lowercase, drop the chamber prefix and generic meeting labels. Two records
 * naming the same normalized body on the same day MIGHT be one proceeding;
 * different normalized bodies are always distinct events.
 */
export function normalizeFloridaBodyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(
      /\b(joint|senate|house|committee|meeting|session|in|special|regular|the|of|held|at|on|am|pm|and|a|an)\b/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

async function unverifiedFloridaOverlap(
  prisma: PrismaClient,
  date: string,
  chamber: 'house' | 'senate' | 'joint',
  body: string,
): Promise<string[]> {
  const rows = await prisma.committeeHearing.findMany({
    where: {
      geographicJurisdiction: 'FL',
      canonicalHearingId: null,
      date: new Date(`${date}T00:00:00Z`),
      chamber:
        chamber === 'joint'
          ? { in: ['Joint', 'Senate', 'House'] }
          : chamber === 'senate'
            ? { in: ['Senate', 'Joint'] }
            : { in: ['House', 'Joint'] },
    },
    select: { id: true, committeeName: true },
    take: 50,
  });
  const mine = normalizeFloridaBodyName(body);
  if (!mine) return [];
  return rows
    .filter((row) => {
      // Exact normalized-body equality ONLY: "Appropriations" must never
      // overlap "Appropriations on Health and Human Services" — a subcommittee
      // is a distinct proceeding, and a prefix match blocks real same-day
      // events (root inventory proof: ids 79030 / 78444 false-blocked).
      return normalizeFloridaBodyName(row.committeeName) === mine;
    })
    .map((row) => `${row.id} (${row.committeeName})`);
}

/**
 * Find the canonical FL proceeding a TFC record belongs to by STRONG proof
 * only: a stored observation whose source page IS this archive page, or whose
 * source/watch page embeds the SAME Kaltura entry. Date+chamber only narrow
 * the read set; they are never identity. Returns null when nothing is proven.
 * An ambiguous proof (the same entry cited by two proceedings) throws into the
 * per-record catch, so it is reported and never aborts the run.
 */
async function findFloridaHearingByKalturaEntry(
  prisma: PrismaClient,
  kalturaEntryId: string,
  narrow: { date: string; chamber: 'house' | 'senate' | 'joint' },
  probe: (page: string) => Promise<string | null>,
): Promise<FloridaArchiveMatch | null> {
  // No ORM relation between the observation ledger and committee_hearing is
  // assumed: candidate hearings for the date+chamber are read first, then the
  // observations for exactly those ids.
  const hearings = await prisma.committeeHearing.findMany({
    where: {
      geographicJurisdiction: 'FL',
      date: new Date(`${narrow.date}T00:00:00Z`),
      chamber:
        narrow.chamber === 'joint'
          ? { in: ['Joint', 'Senate', 'House'] }
          : narrow.chamber === 'senate'
            ? { in: ['Senate', 'Joint'] }
            : { in: ['House', 'Joint'] },
    },
    select: { id: true, chamber: true, committeeName: true, legislativeSession: true },
    take: 200,
  });
  if (!hearings.length) return null;
  const hearingById = new Map(hearings.map((h) => [h.id, h]));
  const observations = await prisma.hearingSourceObservation.findMany({
    where: { hearingId: { in: hearings.map((h) => h.id) } },
    select: { hearingId: true, sourceMetadata: true },
    take: 1000,
  });
  const matches = new Map<string, FloridaArchiveMatch>();
  for (const observation of observations) {
    const leg = observationLegislative(observation.sourceMetadata);
    if (!leg?.officialIdentity || !leg.bodySourceKey) continue;
    // Fast path: the observation's persisted publisher identity — a shared
    // Kaltura entry proves the proceeding without any page refetch.
    if (leg.publisherMediaEntryId === kalturaEntryId) {
      if (hearingById.has(observation.hearingId!)) {
        matches.set(observation.hearingId!, { hearingId: observation.hearingId! });
        continue;
      }
    }
    const pages = new Set<string>();
    if (typeof leg.sourceUrl === 'string') pages.add(leg.sourceUrl);
    if (typeof leg.fields?.watchUrl === 'string') pages.add(leg.fields.watchUrl);
    for (const page of pages) {
      if ((await probe(page)) !== kalturaEntryId) continue;
      if (!hearingById.has(observation.hearingId!)) continue;
      matches.set(observation.hearingId!, { hearingId: observation.hearingId! });
      break;
    }
  }
  if (matches.size > 1)
    throw new Error(
      `Kaltura entry ${kalturaEntryId} is cited by ${matches.size} proceedings on ${narrow.date}`,
    );
  return [...matches.values()][0] ?? null;
}

/**
 * The Senate media catalog is official evidence of an exact player page. A row
 * is attached as a `florida-senate` candidate to the canonical proceeding it
 * PROVES via the observation ledger — a stored observation whose source page
 * IS this player page, or whose source/watch page embeds the same Kaltura
 * entry this player page embeds (shared probe cache: the TFC pages reconciled
 * above are already cached). Unmatched rows are reported, never merged by
 * title/date — and the catalog never creates a canonical row.
 */
async function reconcileSenateMediaCatalog(
  prisma: PrismaClient,
  deps: {
    candidates: StreamCandidateRepository;
    probe: (page: string) => Promise<string | null>;
    delay: number;
    log: (message: string) => void;
    from: string;
    to: string;
    fetchChamber: (url: string) => Promise<Uint8Array>;
  },
): Promise<{
  rows: number;
  attached: number;
  reported: number;
  ambiguous: string[];
  issues: string[];
}> {
  const result = {
    rows: 0,
    attached: 0,
    reported: 0,
    ambiguous: [] as string[],
    issues: [] as string[],
  };
  // Page 1 establishes the pager; older pages are bounded by it AND by the
  // archive window — pages whose rows are all older than `from` end the walk.
  let maxPage = 1;
  for (let page = 1; page <= maxPage; page++) {
    await pause(deps.delay);
    const url =
      page === 1 ? `${FL_SENATE}/Media/Videos` : `${FL_SENATE}/Media/Videos/Committees/${page}`;
    let parsed: ReturnType<typeof senateMediaArchive>;
    try {
      const bytes = await deps.fetchChamber(url);
      parsed = senateMediaArchive(new TextDecoder().decode(bytes));
    } catch (e) {
      result.issues.push(`${url}: ${e instanceof Error ? e.message : String(e)}`);
      break;
    }
    maxPage = parsed.maxPage;
    result.issues.push(...parsed.issues);
    const inWindow = parsed.rows.filter((row) => row.date >= deps.from && row.date <= deps.to);
    // The catalog is newest-first; once a whole page falls before the window
    // every later page does too — stop instead of crawling all history.
    if (parsed.rows.length && !inWindow.length && parsed.rows.every((row) => row.date < deps.from))
      break;
    for (const row of inWindow) {
      result.rows++;
      // Strong proof A: a stored observation's source page IS this player page.
      const direct = await prisma.hearingSourceObservation.findFirst({
        where: { sourceMetadata: { path: ['legislative', 'sourceUrl'], equals: row.watchUrl } },
        select: { hearingId: true },
      });
      let hearingId: string | null = null;
      if (direct?.hearingId) {
        const hearing = await prisma.committeeHearing.findFirst({
          where: { id: direct.hearingId, geographicJurisdiction: 'FL' },
          select: { id: true },
        });
        hearingId = hearing?.id ?? null;
      }
      if (!hearingId) {
        // Strong proof B: shared Kaltura entry with any stored FL observation
        // page for the SAME date (the archive pass already cached its pages).
        const entry = await deps.probe(row.watchUrl);
        if (entry) {
          const hearings = await prisma.committeeHearing.findMany({
            where: { geographicJurisdiction: 'FL', date: new Date(`${row.date}T00:00:00Z`) },
            select: { id: true },
            take: 200,
          });
          if (!hearings.length) {
            result.reported++;
            deps.log(
              `[florida-catalog] unmatched official player page ${row.watchUrl} (${row.date} ${row.title})`,
            );
            continue;
          }
          const candidates = await prisma.hearingSourceObservation.findMany({
            where: { hearingId: { in: hearings.map((h) => h.id) } },
            select: { hearingId: true, sourceMetadata: true },
            take: 1000,
          });
          const hits = new Set<string>();
          for (const candidate of candidates) {
            const leg = observationLegislative(candidate.sourceMetadata);
            const pages = new Set<string>();
            if (typeof leg?.sourceUrl === 'string') pages.add(leg.sourceUrl);
            if (typeof leg?.fields?.watchUrl === 'string') pages.add(leg.fields.watchUrl);
            for (const pageUrl of pages) {
              if ((await deps.probe(pageUrl)) === entry) {
                hits.add(candidate.hearingId!);
                break;
              }
            }
          }
          if (hits.size > 1) {
            result.ambiguous.push(
              `${row.watchUrl}: Kaltura entry ${entry} matches ${hits.size} proceedings on ${row.date}`,
            );
            continue;
          }
          hearingId = [...hits][0] ?? null;
        }
      }
      if (!hearingId) {
        result.reported++;
        deps.log(
          `[florida-catalog] unmatched official player page ${row.watchUrl} (${row.date} ${row.title})`,
        );
        continue;
      }
      await deps.candidates.recordCandidates(
        hearingId,
        [
          {
            provider: 'florida-senate',
            officialPageUrl: row.watchUrl,
            mediaUrl: null,
            capturePolicy: 'BROWSER_CAPTURE_ONLY',
            priority: 10,
          },
        ],
        { now: new Date() },
      );
      result.attached++;
    }
  }
  return result;
}

/** CLI: `discover:hearings -- --source=florida-archive [--session=2026A] [--from= --to= --catalog --notices]`. */
export function floridaArchiveCliWindow(
  args: string[],
  now = new Date(),
): { from: string; to: string; lookbackDays: number } {
  const value = (key: string) => args.find((v) => v.startsWith(`--${key}=`))?.slice(key.length + 3);
  const to = value('to') ?? floridaCalendarDate(now);
  const lookbackDays = Number(value('lookback-days') ?? '30');
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 366)
    throw new Error('--lookback-days must be an integer in 1..366');
  const from =
    value('from') ??
    new Date(Date.parse(`${to}T00:00:00Z`) - (lookbackDays - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
  return { from, to, lookbackDays };
}

export async function runFloridaArchiveBackfill(args: string[]) {
  const session = floridaCalendarSessions(args)[0]!;
  const { from, to } = floridaArchiveCliWindow(args);
  const prisma = new PrismaClient();
  try {
    const result = await runWithSyncRun(
      prisma,
      'florida-archive-backfill',
      async () => {
        const res = await backfillFloridaArchive(prisma, {
          session,
          from,
          to,
          notices: args.includes('--notices'),
          catalog: args.includes('--catalog'),
          log: console.log,
        });
        return {
          inserted: res.archive.inserted,
          updated: res.archive.updated,
          skipped: res.archive.unchanged,
          // Ambiguities are partial-failure evidence: the run did NOT cover
          // those records, so they must count against the outcome and the
          // CLI exit, never silently advance the success watermark.
          errors: res.archive.errors + res.archive.issues.length + res.archive.ambiguous.length,
        };
      },
      { skipIfRunning: true },
    );
    if ((result as { errors?: number }).errors) process.exitCode = 2;
  } finally {
    await prisma.$disconnect();
  }
}
