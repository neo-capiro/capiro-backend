import { PrismaClient, type Prisma } from '@prisma/client';
import { PDFParse } from 'pdf-parse';
import { CommitteeSourceRepository } from './committee-source.repository.js';
import { HearingReconcilerService } from './hearing-reconciler.service.js';
import { StreamCandidateRepository } from './stream-candidate.repository.js';
import { runWithSyncRun } from '../ingestion/sync-run.helper.js';
import type { LegislativeObservation } from './legislative-calendar.js';
import { contentHash } from './hearing-identity.js';
import { floridaSourceOutcome } from './florida-source-outcome.js';
import { findFloridaCanonicalBySharedEntry } from './florida-crosswalk.js';
import {
  FL_CALENDAR_PARSER,
  FL_HOUSE,
  FL_SENATE,
  fetchFloridaSource,
  floridaDate,
  floridaBillNumberAliases,
  floridaOfficialWatchChamber,
  houseNoticeObservation,
  houseNoticeWatchPairs,
  senateCommitteeLinks,
  senateNoticeRefs,
  senateNoticeObservation,
  senateDailyCalendar,
  houseDailyCalendar,
} from './adapters/florida-calendar.adapter.js';

/**
 * The official Florida watch page as a first-class browser stream candidate.
 *
 * Florida chambers publish the live player as a first-party page (Senate
 * `mtgrecord_video` / `/VideoPlayer/`, House `VideoPlayer.aspx`). We advertise
 * it exactly as observed — `mediaUrl` stays null because the publisher does not
 * expose a direct media URL on the calendar. `BROWSER_CAPTURE_ONLY` is asserted
 * at discovery: the Florida player is a browser playback page and discovery
 * makes no server-capture claim; Phase 4's resolver may later refine it, but a
 * re-run of this discovery never downgrades an already-resolved candidate
 * (the repository only writes resolution_state on INSERT).
 */
export function floridaWatchCandidate(
  chamber: 'senate' | 'house',
  watchUrl: string,
): {
  provider: string;
  officialPageUrl: string;
  mediaUrl: null;
  capturePolicy: 'BROWSER_CAPTURE_ONLY';
  priority: number;
} {
  return {
    provider: chamber === 'senate' ? 'florida-senate' : 'florida-house',
    officialPageUrl: watchUrl,
    mediaUrl: null,
    capturePolicy: 'BROWSER_CAPTURE_ONLY',
    priority: 10,
  };
}

export type FloridaDiscoveryOptions = {
  from: string;
  to: string;
  session: string;
  dryRun?: boolean;
  delayMs?: number;
  log?: (message: string) => void;
  fetchSource?: typeof fetchFloridaSource;
  /** Optional channel-host fetcher for crosswalk probes of TFC pages. When
   *  omitted, the real guarded TFC fetcher is used; tests inject fixtures so
   *  the notice path never touches the live publisher. */
  fetchChannel?: (url: string) => Promise<{ bytes: Uint8Array; totalPages: number | null }>;
  /** Per-run page→publisher-entry cache shared with the archive crosswalk. */
  probeCache?: Map<string, string | null>;
};

export async function discoverFloridaCalendar(
  prisma: PrismaClient | null,
  options: FloridaDiscoveryOptions,
) {
  if (
    !floridaDate(options.from) ||
    !floridaDate(options.to) ||
    options.from > options.to ||
    Date.parse(options.to) - Date.parse(options.from) > 31 * 86400000 ||
    !/^\d{4}$/.test(options.session)
  )
    throw new Error('Florida source requires a valid <=32-day window and explicit regular session');
  const fetchSource = options.fetchSource ?? fetchFloridaSource;
  const text = async (url: string) => new TextDecoder().decode(await fetchSource(url));
  const log = options.log ?? (() => {});
  const pause = () => new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 400));
  const repo = prisma ? new CommitteeSourceRepository(prisma) : null;
  const reconciler = prisma ? new HearingReconcilerService(prisma) : null;
  const candidates = prisma ? new StreamCandidateRepository(prisma) : null;
  const results: Array<{
    chamber: string;
    pages: number;
    expected: number;
    found: number;
    inserted: number;
    updated: number;
    unchanged: number;
    issues: string[];
    sourceIssues: string[];
    skippedOutsideWindow: number;
    events: string[];
  }> = [];
  const crosswalkCache = options.probeCache ?? new Map<string, string | null>();
  for (const chamber of ['senate', 'house'] as const) {
    const now = new Date(),
      issues: string[] = [],
      sourceIssues: string[] = [],
      observations: LegislativeObservation[] = [];
    const sourceFailure = (context: string, error: unknown) => {
      const message = `${context}: ${error instanceof Error ? error.message : String(error)}`;
      sourceIssues.push(message);
      issues.push(message);
    };
    let pages = 0,
      expected = 0,
      inserted = 0,
      updated = 0,
      unchanged = 0,
      skippedOutsideWindow = 0;
    const source = repo
      ? await repo.ensureSource({
          committeeSystemCode: null,
          chamber,
          sourceType: 'COMMITTEE_API',
          sourceUrl:
            chamber === 'senate'
              ? `${FL_SENATE}/Committees`
              : `${FL_HOUSE}/Sections/HouseSchedule/houseschedule.aspx`,
          adapterKey: `florida-${chamber}`,
          priority: 5,
          parserVersion: FL_CALENDAR_PARSER,
          enabled: true,
        })
      : null;
    // The process-level ingestion switch gates initial registration. Subsequent
    // runs must respect an operator disabling either source in the registry.
    if (
      source &&
      repo &&
      !(await repo.listEnabled({ adapterKey: `florida-${chamber}` })).some(
        (s) => s.id === source.id,
      )
    ) {
      results.push({
        chamber,
        pages: 0,
        expected: 0,
        found: 0,
        inserted: 0,
        updated: 0,
        unchanged: 0,
        issues: ['Source disabled by operator'],
        sourceIssues: [],
        skippedOutsideWindow: 0,
        events: [],
      });
      continue;
    }
    const coverage =
      source && prisma
        ? await prisma.legislativeCalendarCoverage.create({
            data: {
              sourceId: source.id,
              jurisdiction: 'FL',
              chamber,
              session: options.session,
              fromDate: new Date(`${options.from}T00:00:00Z`),
              toDate: new Date(`${options.to}T00:00:00Z`),
              status: 'attempted',
              details: {},
              attemptedAt: now,
            },
          })
        : null;
    if (source && repo) await repo.markChecked(source.id, now);
    try {
      if (chamber === 'senate') {
        const seenNotices = new Set<string>();
        const bodies = senateCommitteeLinks(await text(`${FL_SENATE}/Committees`), options.session);
        pages++;
        if (!bodies.length)
          throw new Error(
            'Senate committee directory unavailable; no coverage assertion can be made',
          );
        for (const body of bodies) {
          await pause();
          try {
            const parsed = senateNoticeRefs(await text(body.url), body.code, body.name, options);
            pages++;
            issues.push(...parsed.issues.map((issue) => `${body.code}: ${issue}`));
            const refs = parsed.notices.filter(
              (n) => n.date >= options.from && n.date <= options.to,
            );
            expected += refs.length;
            for (const ref of refs) {
              seenNotices.add(ref.id);
              await pause();
              try {
                const pdf = new PDFParse({ data: await fetchSource(ref.sourceUrl) });
                let noticeText: string;
                try {
                  noticeText = (await pdf.getText()).text;
                } finally {
                  await pdf.destroy();
                }
                pages++;
                observations.push(senateNoticeObservation(ref, noticeText, options.session));
              } catch (e) {
                sourceFailure(ref.sourceUrl, e);
              }
            }
          } catch (e) {
            sourceFailure(body.url, e);
          }
        }
        for (
          let day = new Date(`${options.from}T00:00:00Z`);
          day.toISOString().slice(0, 10) <= options.to;
          day.setUTCDate(day.getUTCDate() + 1)
        ) {
          await pause();
          const date = day.toISOString().slice(0, 10);
          try {
            const daily = senateDailyCalendar(
              await text(
                `${FL_SENATE}/Home/${date.slice(5, 7)}-${date.slice(8, 10)}-${date.slice(0, 4)}?ShowSlide=0`,
              ),
              date,
              options.session,
            );
            pages++;
            issues.push(...daily.issues);
            expected += daily.floors.length + daily.unresolved;
            observations.push(...daily.floors);
            for (const ref of daily.notices) {
              if (seenNotices.has(ref.id)) continue;
              seenNotices.add(ref.id);
              expected++;
              await pause();
              try {
                const pdf = new PDFParse({ data: await fetchSource(ref.sourceUrl) });
                try {
                  observations.push(
                    senateNoticeObservation(ref, (await pdf.getText()).text, options.session),
                  );
                  pages++;
                } finally {
                  await pdf.destroy();
                }
              } catch (e) {
                sourceFailure(ref.sourceUrl, e);
              }
            }
          } catch (e) {
            sourceFailure(`Senate daily calendar ${date}`, e);
          }
        }
      } else {
        const urls = new Set<string>();
        // Notice↔watch pairing captured at the schedule level: the notice page
        // itself carries no video, so the official player URL must be read from
        // the SAME schedule-event block (keyed on the normalized MeetingId).
        const watchByNotice = new Map<string, string>();
        let unresolved = 0;
        for (
          let date = new Date(`${options.from}T00:00:00Z`);
          date.toISOString().slice(0, 10) <= options.to;
          date.setUTCDate(date.getUTCDate() + 1)
        ) {
          await pause();
          const day = `${date.getUTCMonth() + 1}-${date.getUTCDate()}-${date.getUTCFullYear()}`;
          const url = `${FL_HOUSE}/Sections/HouseSchedule/houseschedule.aspx?date=${day}`;
          try {
            const html = await text(url);
            pages++;
            if (!/House Schedule|HouseSchedule/i.test(html))
              throw new Error('House schedule layout unavailable');
            for (const pair of houseNoticeWatchPairs(html)) {
              urls.add(pair.noticeUrl);
              if (pair.watchUrl) watchByNotice.set(pair.noticeUrl, pair.watchUrl);
            }
            const daily = houseDailyCalendar(
              html,
              date.toISOString().slice(0, 10),
              options.session,
            );
            unresolved += daily.unresolved + daily.floors.length;
            observations.push(...daily.floors);
            issues.push(...daily.issues);
          } catch (e) {
            // One unavailable day must not starve every later day in the window.
            sourceFailure(url, e);
          }
        }
        expected = urls.size + unresolved;
        for (const url of urls) {
          await pause();
          try {
            // A session may only be attached when the specific notice provides
            // it. Joint/no-bill off-session meetings deliberately stay unknown.
            const html = await text(url);
            pages++;
            const observation = houseNoticeObservation(
              html,
              url,
              null,
              watchByNotice.get(url) ?? null,
            );
            if (
              observation.fields.time &&
              observation.fields.time.date >= options.from &&
              observation.fields.time.date <= options.to
            )
              observations.push(observation);
            else if (observation.fields.time) {
              // Daily pages also link adjacent-week notices. They were read and
              // verified outside this window, not missing expected events.
              skippedOutsideWindow++;
              expected--;
            } else {
              issues.push(`${observation.officialIdentity}: linked notice has no qualified date`);
            }
          } catch (e) {
            sourceFailure(url, e);
          }
        }
      }
      for (const observation of observations) {
        if (prisma && source && reconciler) {
          try {
            await resolveFloridaAgenda(prisma, observation);
            // Strong-proof archive crosswalk BEFORE reconcile: only a shared
            // publisher media entry (this notice's official watch page vs an
            // archive observation's stored pages) attaches the row. Ambiguous
            // proof is reported and the event is SKIPPED — never null→dup.
            let canonicalHearingId: string | null = null;
            if (observation.fields.watchUrl) {
              const crosswalk = await findFloridaCanonicalBySharedEntry(
                prisma,
                observation.fields.watchUrl,
                crosswalkCache,
                {
                  observation: {
                    chamber: observation.chamber,
                    date: observation.fields.time?.date ?? null,
                  },
                  fetchChamber: fetchSource,
                  fetchChannel: options.fetchChannel,
                },
              );
              if (crosswalk.ambiguous) {
                issues.push(
                  `${observation.officialIdentity}: shared publisher entry is ambiguous; skipped`,
                );
                continue;
              }
              canonicalHearingId = crosswalk.hearingId;
            }
            const outcome = await reconciler.reconcileEvent(
              source,
              {
                externalEventId: observation.officialIdentity,
                chamber: observation.chamber,
                legislative: observation,
                canonicalHearingId,
              },
              new Date(),
            );
            if (outcome.hearingCreated) inserted++;
            else if (outcome.changedFields.length) updated++;
            else unchanged++;
            // Advertise the official Florida watch page as a first-class
            // browser candidate so the join plan can prefer the real player
            // over the notice page. Idempotent: an existing candidate for the
            // same hearing/provider/page is refreshed, never duplicated, and
            // its resolver-owned resolution_state is left untouched.
            if (candidates && observation.fields.watchUrl) {
              // Advertise ONLY an accepted official player page: the provider
              // follows the watch URL's own host (a Joint sitting can carry a
              // Senate player), and a nonofficial/invalid URL is never recorded.
              const watchChamber = floridaOfficialWatchChamber(observation.fields.watchUrl);
              if (watchChamber) {
                await candidates.recordCandidates(
                  outcome.hearingId,
                  [floridaWatchCandidate(watchChamber, observation.fields.watchUrl)],
                  { now: new Date(), sourceId: source.id },
                );
              }
            }
            log(
              JSON.stringify({
                hearingId: outcome.hearingId,
                created: outcome.hearingCreated,
                changedFields: outcome.changedFields,
              }),
            );
          } catch (e) {
            issues.push(
              `${observation.officialIdentity}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        } else log(JSON.stringify({ observation }));
        issues.push(
          ...observation.issues.map((issue) => `${observation.officialIdentity}: ${issue}`),
        );
      }
    } catch (e) {
      sourceFailure(`Florida ${chamber} calendar`, e);
    }
    const result = {
      chamber,
      pages,
      expected,
      found: observations.length,
      inserted,
      updated,
      unchanged,
      issues,
      sourceIssues,
      skippedOutsideWindow,
      events: observations.map((o) => o.officialIdentity),
    };
    results.push(result);
    if (prisma && source && coverage && repo) {
      const outcome = floridaSourceOutcome({
        pages,
        observations: observations.length,
        issues,
        sourceIssues,
      });
      await prisma.legislativeCalendarCoverage.update({
        where: { id: coverage.id },
        data: {
          status: outcome.coverage,
          pages,
          items: observations.length,
          details: result as Prisma.InputJsonValue,
        },
      });
      await repo.recordOutcome(source.id, outcome.health, new Date(), FL_CALENDAR_PARSER);
    }
    log(JSON.stringify(result));
  }
  return results;
}

async function resolveFloridaAgenda(prisma: PrismaClient, observation: LegislativeObservation) {
  // Register a directory body only from a first-party body identifier. These
  // identities remain separate from unresolved vendor crosswalks and never
  // acquire a roster by matching people's display names.
  if (
    observation.eventType !== 'floor' &&
    !observation.bodySourceKey.includes('unresolved-body') &&
    observation.session
  ) {
    const key = `${observation.jurisdiction}:${observation.session}:${observation.bodySourceKey}`;
    const body = await prisma.stateCommittee.upsert({
      where: { officialSourceKey: key },
      create: {
        id: `official-${contentHash(key).slice(0, 32)}`,
        state: observation.jurisdiction,
        chamber: observation.chamber,
        name: observation.bodyName,
        officialSourceKey: key,
        legislativeSession: observation.session,
        sourceUrl: observation.sourceUrl,
        sourceEvidence: {
          officialBodyKey: observation.bodySourceKey,
          noticeIdentity: observation.officialIdentity,
          rosterStatus: 'unqualified',
        },
      },
      update: {
        name: observation.bodyName,
        sourceUrl: observation.sourceUrl,
        lastSyncedAt: new Date(),
      },
    });
    observation.stateCommitteeId = body.id;
  }
  for (const item of observation.fields.agenda ?? []) {
    const raw = item.evidence.identifier;
    if (typeof raw !== 'string' || !observation.session) continue;
    const aliases = floridaBillNumberAliases(raw);
    const candidates = await prisma.stateBill.findMany({
      where: {
        state: 'FL',
        sessionKey: observation.session,
        OR: aliases.flatMap((n) => [
          { billNumber: { equals: n, mode: 'insensitive' as const } },
          { identifier: { equals: n.replace(/(\D)(\d)/, '$1 $2'), mode: 'insensitive' as const } },
        ]),
      },
      select: { id: true },
      take: 2,
    });
    if (candidates.length === 1) {
      item.kind = 'bill';
      item.bill = {
        scope: 'state',
        id: candidates[0]!.id,
        jurisdiction: 'FL',
        session: observation.session,
      };
    }
  }
  // A display-name match is never a person/body crosswalk. Directory linkage
  // remains unresolved until a verified official/source mapping exists.
}

export async function runFloridaCalendarDiscovery(args: string[]) {
  const value = (key: string) => args.find((v) => v.startsWith(`--${key}=`))?.slice(key.length + 3);
  const explicitFrom = value('from');
  const from = explicitFrom ?? new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const to =
    value('to') ??
    new Date(Date.parse(from) + (explicitFrom ? 14 : 21) * 86400000).toISOString().slice(0, 10);
  const session = value('session') ?? process.env.FL_CALENDAR_SESSION ?? '';
  const dryRun = args.includes('--dry-run');
  if (!dryRun && process.env.FL_CALENDAR_INGEST_ENABLED !== 'true')
    throw new Error('Florida calendar ingestion is disabled');
  const prisma = dryRun ? null : new PrismaClient();
  try {
    const run = async () => {
      const results = await discoverFloridaCalendar(prisma, {
        from,
        to,
        session,
        dryRun,
        log: console.log,
      });
      // Recurring TFC archive sweep: same window as the chamber pass, bounded,
      // idempotent — new archive recordings surface as calendar rows and exact
      // watch candidates without waiting for a noticed meeting. Never crawls
      // history here; the one-shot florida-archive backfill owns that.
      let archive = {
        inserted: 0,
        updated: 0,
        unchanged: 0,
        errors: 0,
        issues: 0,
        ambiguous: [] as string[],
      };
      if (prisma) {
        const { backfillFloridaArchive } = await import('./florida-archive-discovery.js');
        const res = await backfillFloridaArchive(prisma, {
          session,
          from,
          to,
          delayMs: 400,
          log: console.log,
        });
        archive = {
          inserted: res.archive.inserted,
          updated: res.archive.updated,
          unchanged: res.archive.unchanged,
          errors: res.archive.errors,
          issues: res.archive.issues.length,
          ambiguous: res.archive.ambiguous,
        };
      }
      return {
        inserted: results.reduce((n, r) => n + r.inserted, 0) + archive.inserted,
        updated: results.reduce((n, r) => n + r.updated, 0) + archive.updated,
        skipped: results.reduce((n, r) => n + r.unchanged, 0) + archive.unchanged,
        errors:
          results.reduce((n, r) => n + r.issues.length, 0) +
          archive.errors +
          archive.issues +
          archive.ambiguous.length,
      };
    };
    if (prisma)
      await runWithSyncRun(prisma, 'discover-hearings-florida', run, { skipIfRunning: true });
    else await run();
  } finally {
    await prisma?.$disconnect();
  }
}

/**
 * Repair/backfill: emit official watch-page candidates for Florida hearings
 * already in the corpus (ingested before candidates were advertised).
 *
 * Reads each FL hearing's stored `calendarSnapshot.watchUrl` — the official
 * chamber player page captured at discovery (the snapshot IS the projected
 * `CalendarFacts`, so `watchUrl` is a top-level key, matching how
 * `recordFederalCalendar`/`LegislativeCalendarRepository` write it; a
 * `.fields.watchUrl` fallback covers any nested-shape rows) — and records it as
 * a `BROWSER_CAPTURE_ONLY` `hearing_stream_candidate`, idempotently and in
 * bounded keyset pages. Existing candidates (same hearing/provider/page) are
 * refreshed, never duplicated, and an already-resolved candidate's
 * `resolution_state` is left untouched (the repository only writes it on
 * INSERT). No stream is probed and no server-capture claim is made.
 */
export async function backfillFloridaWatchCandidates(
  prisma: PrismaClient,
  opts: { limit?: number; cursor?: string; log?: (m: string) => void } = {},
): Promise<{ scanned: number; created: number; refreshed: number; nextCursor: string | null }> {
  const limit = opts.limit ?? 500;
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000)
    throw new Error('backfillFloridaWatchCandidates limit must be an integer in 1..5000');
  const log = opts.log ?? (() => {});
  const candidates = new StreamCandidateRepository(prisma);
  let scanned = 0,
    created = 0,
    refreshed = 0;
  // One bounded keyset page. The caller resumes with nextCursor; this function
  // never loops over the corpus itself.
  const rows: Array<{ id: string; chamber: string; calendarSnapshot: unknown }> =
    await prisma.committeeHearing.findMany({
      where: {
        geographicJurisdiction: 'FL',
        canonicalHearingId: null,
        ...(opts.cursor ? { id: { gt: opts.cursor } } : {}),
      },
      select: { id: true, chamber: true, calendarSnapshot: true },
      orderBy: { id: 'asc' },
      take: limit + 1,
    });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? page[page.length - 1]!.id : null;
  for (const row of page) {
    scanned++;
    const snap = row.calendarSnapshot as
      | { watchUrl?: unknown; fields?: { watchUrl?: unknown } }
      | null;
    const watchUrl = snap?.watchUrl ?? snap?.fields?.watchUrl;
    if (typeof watchUrl !== 'string' || !watchUrl) continue;
    // Provider follows the watch URL's own host, not the chamber column: a
    // joint sitting can carry a Senate player (e.g. JLBC), and the host is
    // the authoritative signal for which chamber's player it is. Only an
    // http(s) page on the exact official host or a dot-suffix subdomain is
    // accepted. An unknown/invalid URL is SKIPPED (scanned still increments) —
    // never fall back to the row chamber and record a nonofficial candidate.
    const chamber = floridaOfficialWatchChamber(watchUrl);
    if (!chamber) continue;
    const res = await candidates.recordCandidates(
      row.id,
      [floridaWatchCandidate(chamber, watchUrl)],
      { now: new Date() },
    );
    created += res.created;
    refreshed += res.refreshed;
  }
  log(
    `[florida-watch-backfill] scanned=${scanned} created=${created} refreshed=${refreshed} ` +
      `nextCursor=${nextCursor ?? 'none'}`,
  );
  return { scanned, created, refreshed, nextCursor };
}

/** CLI: `discover:hearings -- --source=florida-watch-backfill [--limit=N] [--cursor=ID]`. */
export async function runFloridaWatchBackfill(args: string[]) {
  const value = (key: string) => args.find((v) => v.startsWith(`--${key}=`))?.slice(key.length + 3);
  const limit = value('limit') ? Number(value('limit')) : undefined;
  const cursor = value('cursor');
  const prisma = new PrismaClient();
  try {
    await runWithSyncRun(
      prisma,
      'florida-watch-backfill',
      async () => {
        const res = await backfillFloridaWatchCandidates(prisma, {
          limit,
          cursor: cursor ?? undefined,
          log: console.log,
        });
        return { inserted: res.created, updated: res.refreshed, skipped: 0, errors: 0 };
      },
      { skipIfRunning: true },
    );
  } finally {
    await prisma.$disconnect();
  }
}
