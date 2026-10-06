import { PrismaClient, type Prisma } from '@prisma/client';
import { PDFParse } from 'pdf-parse';
import { CommitteeSourceRepository } from './committee-source.repository.js';
import { HearingReconcilerService } from './hearing-reconciler.service.js';
import { StreamCandidateRepository } from './stream-candidate.repository.js';
import { runWithSyncRun } from '../ingestion/sync-run.helper.js';
import type { LegislativeObservation } from './legislative-calendar.js';
import { contentHash } from './hearing-identity.js';
import { floridaDiscoveryRunCounts, floridaSourceOutcome } from './florida-source-outcome.js';
import { findFloridaCanonicalBySharedEntry } from './florida-crosswalk.js';
import {
  FL_CALENDAR_PARSER,
  FL_HOUSE,
  FL_SENATE,
  fetchFloridaSource,
  FloridaSourceRateLimitError,
  floridaDate,
  floridaBillNumberAliases,
  floridaOfficialWatchChamber,
  houseNoticeObservation,
  houseNoticeWatchPairs,
  senateCommitteePageSession,
  senateCommitteeLinks,
  senateNoticeRefs,
  senateNoticeObservation,
  senateDailyCalendar,
  houseDailyCalendar,
} from './adapters/florida-calendar.adapter.js';

const FLORIDA_TIME_ZONE = 'America/New_York';
// Florida publishes regular sessions as YYYY and special/organizational
// sessions as YYYY plus one letter (for example 2025C). Reject invented
// multi-character suffixes before they are interpolated into publisher URLs.
const FLORIDA_SESSION_CODE = /^\d{4}[A-Z]?$/;

/** Validate an official regular or special-session key used in Florida URLs. */
export function isFloridaSessionCode(value: string): boolean {
  return FLORIDA_SESSION_CODE.test(value.trim().toUpperCase());
}

/**
 * Default regular sessions for the Tallahassee calendar date. Florida starts
 * publishing the next regular session's committee material in the preceding
 * fall, so September through December probes both bounded session keys.
 */
export function defaultFloridaRegularSessions(now = new Date()): string[] {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: FLORIDA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  if (!Number.isInteger(year) || !Number.isInteger(month)) {
    throw new Error('Unable to derive the Florida legislative session date');
  }
  return month >= 9 ? [String(year), String(year + 1)] : [String(year)];
}

/** Calendar day in Tallahassee, independent of the worker's UTC boundary. */
export function floridaCalendarDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: FLORIDA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type: 'year' | 'month' | 'day') => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

/** Default recurring window, expressed as Florida calendar days. */
export function defaultFloridaCalendarWindow(now = new Date()): { from: string; to: string } {
  const today = floridaCalendarDate(now);
  const base = new Date(`${today}T00:00:00Z`);
  const day = (offset: number) =>
    new Date(base.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
  return { from: day(-7), to: day(14) };
}

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
  /** Limit a pass to the requested official chamber sources. The recurring
   *  rollover runner uses this to read shared House/date pages once while
   *  still reading each session-specific Senate committee directory. */
  chambers?: ReadonlyArray<'senate' | 'house'>;
  /** Senate daily/date pages are shared across sessions. Additional-session
   *  probes disable this so only `/Committees/Show/.../<session>` is read. */
  includeSenateDaily?: boolean;
  /** A future session may be official before its committee pages are
   *  published. A verified fallback becomes an explicit unavailable marker,
   *  not an error and never a coverage-complete assertion. */
  optionalSession?: boolean;
  /** Additional probes share the primary's source-registry row. They retain
   *  their own coverage row but must not overwrite primary source health. */
  recordSourceHealth?: boolean;
  /** Shared across the primary and additional passes so one notice reached by
   *  both a committee page and the shared daily page is projected once. */
  seenSenateNoticeIds?: Set<string>;
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
  /** Shared across session passes so throttling cannot restart on the next session. */
  throttledHosts?: Map<string, FloridaSourceRateLimitError>;
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
    !isFloridaSessionCode(options.session)
  )
    throw new Error('Florida source requires a valid <=32-day window and Florida session code');
  const throttledHosts = options.throttledHosts ?? new Map<string, FloridaSourceRateLimitError>();
  const readSource = options.fetchSource ?? fetchFloridaSource;
  const fetchSource = async (url: string) => {
    const host = new URL(url).hostname;
    const prior = throttledHosts.get(host);
    if (prior) throw prior;
    try {
      return await readSource(url);
    } catch (error) {
      if (error instanceof FloridaSourceRateLimitError) throttledHosts.set(host, error);
      throw error;
    }
  };
  const senateThrottled = () => throttledHosts.has(new URL(FL_SENATE).hostname);
  const houseThrottled = () => throttledHosts.has(new URL(FL_HOUSE).hostname);
  const text = async (url: string) => new TextDecoder().decode(await fetchSource(url));
  const log = options.log ?? (() => {});
  const pause = () => new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 1000));
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
    session: string;
    availability: 'available' | 'unavailable';
  }> = [];
  const crosswalkCache = options.probeCache ?? new Map<string, string | null>();
  const chambers = options.chambers ?? (['senate', 'house'] as const);
  for (const chamber of chambers) {
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
    let availability: 'available' | 'unavailable' = 'available';
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
        session: options.session,
        availability,
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
        const seenNotices = options.seenSenateNoticeIds ?? new Set<string>();
        const bodies = senateCommitteeLinks(await text(`${FL_SENATE}/Committees`), options.session);
        let consecutiveBodyFailures = 0;
        pages++;
        if (!bodies.length)
          throw new Error(
            'Senate committee directory unavailable; no coverage assertion can be made',
          );
        for (const body of bodies) {
          if (senateThrottled()) break;
          await pause();
          try {
            const html = await text(body.url);
            pages++;
            const servedSession = senateCommitteePageSession(html);
            if (servedSession !== options.session) {
              const message =
                `${body.url}: requested Senate session ${options.session}, ` +
                `publisher served ${servedSession ?? 'an unqualified session'}`;
              if (options.optionalSession) {
                availability = 'unavailable';
                sourceIssues.push(message);
                log(
                  JSON.stringify({
                    marker: 'FLORIDA_SESSION_UNAVAILABLE',
                    requestedSession: options.session,
                    servedSession,
                    sourceUrl: body.url,
                  }),
                );
                break;
              }
              throw new Error(message);
            }
            const parsed = senateNoticeRefs(html, body.code, body.name, options);
            consecutiveBodyFailures = 0;
            issues.push(...parsed.issues.map((issue) => `${body.code}: ${issue}`));
            const refs = parsed.notices.filter(
              (n) => n.date >= options.from && n.date <= options.to,
            );
            for (const ref of refs) {
              if (senateThrottled()) break;
              if (seenNotices.has(ref.id)) continue;
              expected++;
              await pause();
              try {
                const pdf = new PDFParse({ data: await fetchSource(ref.sourceUrl) });
                let noticeText: string;
                try {
                  noticeText = (await pdf.getText()).text;
                } finally {
                  await pdf.destroy();
                }
                const observation = senateNoticeObservation(ref, noticeText, options.session);
                // Mark only after a qualified observation exists. If one
                // source path could not read the PDF, the shared daily or
                // adjacent-session path may make the bounded retry.
                seenNotices.add(ref.id);
                pages++;
                observations.push(observation);
              } catch (e) {
                sourceFailure(ref.sourceUrl, e);
              }
            }
          } catch (e) {
            sourceFailure(body.url, e);
            consecutiveBodyFailures++;
            // A publisher-wide 5xx/access block otherwise multiplies into
            // dozens of identical page requests every scheduler tick. Three
            // consecutive committee-page failures prove this pass cannot
            // qualify complete Senate coverage; stop the fan-out, retain the
            // partial work, and let the next bounded run retry.
            if (consecutiveBodyFailures >= 3) {
              sourceFailure(
                'Senate committee fan-out stopped',
                new Error('three consecutive committee pages were unavailable'),
              );
              break;
            }
          }
        }
        if (options.includeSenateDaily !== false && !senateThrottled()) {
          for (
            let day = new Date(`${options.from}T00:00:00Z`);
            day.toISOString().slice(0, 10) <= options.to;
            day.setUTCDate(day.getUTCDate() + 1)
          ) {
            if (senateThrottled()) break;
            await pause();
            const date = day.toISOString().slice(0, 10);
            try {
              const daily = senateDailyCalendar(
                await text(
                  `${FL_SENATE}/Home/${date.slice(5, 7)}-${date.slice(8, 10)}-${date.slice(0, 4)}?ShowSlide=0`,
                ),
                date,
                // A bounded window may cross Dec/Jan. Regular floor identity
                // follows the published calendar day, not the worker's primary
                // committee-session argument.
                date.slice(0, 4),
              );
              pages++;
              issues.push(...daily.issues);
              expected += daily.floors.length + daily.unresolved;
              observations.push(...daily.floors);
              for (const ref of daily.notices) {
                if (senateThrottled()) break;
                if (seenNotices.has(ref.id)) continue;
                expected++;
                await pause();
                try {
                  const pdf = new PDFParse({ data: await fetchSource(ref.sourceUrl) });
                  try {
                    observations.push(
                      senateNoticeObservation(
                        ref,
                        (await pdf.getText()).text,
                        // If a shared daily page crosses Jan 1 and the notice
                        // omits an explicit regular-session heading, retain the
                        // daily page's calendar year rather than the primary
                        // committee session.
                        date.slice(0, 4),
                      ),
                    );
                    seenNotices.add(ref.id);
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
          if (houseThrottled()) break;
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
              // Same Dec/Jan rule as the Senate daily calendar above.
              date.toISOString().slice(0, 4),
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
          if (houseThrottled()) break;
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
      session: options.session,
      availability,
    };
    results.push(result);
    if (prisma && source && coverage && repo) {
      const outcome =
        availability === 'unavailable'
          ? {
              coverage: 'failed' as const,
              // The publisher is up; only this not-yet-published session is
              // unavailable. Keep global source health truthful while the
              // coverage row and run marker preserve the gap.
              health: { ok: true, observedEvents: 0, error: null },
            }
          : floridaSourceOutcome({
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
      if (options.recordSourceHealth !== false)
        await repo.recordOutcome(source.id, outcome.health, new Date(), FL_CALENDAR_PARSER);
    }
    log(JSON.stringify(result));
  }
  return results;
}

export async function resolveFloridaAgenda(
  prisma: PrismaClient,
  observation: LegislativeObservation,
) {
  // Older House notices omit CommitteeId. A unique, exact directory name in
  // the same official session/chamber can qualify the body; no fuzzy matching.
  if (
    observation.bodySourceKey.includes('unresolved-body') &&
    observation.session &&
    ['house', 'senate'].includes(observation.chamber)
  ) {
    const normalize = (name: string) =>
      name
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/^(?:house|senate)\s+/, '')
        .replace(/\s+committee$/, '')
        .replace(/\s+/g, ' ')
        .trim();
    const prefix = `FL:${observation.session}:fl:${observation.chamber}:`;
    const directory = await prisma.stateCommittee.findMany({
      where: {
        state: 'FL',
        legislativeSession: observation.session,
        officialSourceKey: { startsWith: prefix },
      },
    });
    const matches = directory.filter(
      (row) =>
        normalize(row.name) === normalize(observation.bodyName) &&
        (row.sourceEvidence as { directory?: { active?: boolean } } | null)?.directory?.active !==
          false,
    );
    if (matches.length === 1)
      observation.bodySourceKey = matches[0]!.officialSourceKey!.slice(
        `FL:${observation.session}:`.length,
      );
  }
  // Joint directories span sessions. Reuse their exact published body key,
  // which already carries qualified aliases/rosters, rather than manufacture
  // an empty session-specific Senate committee from a Senate-hosted notice.
  let officialJointBody: { id: string } | null = null;
  if (
    observation.chamber === 'joint' &&
    observation.eventType === 'joint' &&
    /^fl:joint:[A-Z]{2,8}$/.test(observation.bodySourceKey)
  ) {
    const directory = await prisma.stateCommittee.findUnique({
      where: { officialSourceKey: `FL:directory:${observation.bodySourceKey}` },
    });
    if (directory) {
      const cleanName = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
      if (
        directory.state !== 'FL' ||
        directory.chamber !== 'joint' ||
        cleanName(directory.name) !== cleanName(observation.bodyName) ||
        (directory.sourceEvidence as { directory?: { active?: boolean } } | null)?.directory
          ?.active !== true
      )
        throw new Error('Official joint directory identity conflicts with notice');
      officialJointBody = directory;
      observation.stateCommitteeId = directory.id;
    }
  }
  // Register a directory body only from a first-party body identifier. These
  // identities remain separate from unresolved vendor crosswalks and never
  // acquire a roster by matching people's display names.
  if (
    !officialJointBody &&
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
  const defaultWindow = defaultFloridaCalendarWindow();
  const from = explicitFrom ?? defaultWindow.from;
  const to =
    value('to') ??
    (explicitFrom
      ? new Date(Date.parse(from) + 14 * 86400000).toISOString().slice(0, 10)
      : defaultWindow.to);
  const sessions = floridaCalendarSessions(args);
  const dryRun = args.includes('--dry-run');
  if (!dryRun && process.env.FL_CALENDAR_INGEST_ENABLED !== 'true')
    throw new Error('Florida calendar ingestion is disabled');
  const prisma = dryRun ? null : new PrismaClient();
  try {
    const run = async () => {
      return discoverFloridaCalendarSessions(prisma, {
        from,
        to,
        sessions,
        includeArchive: !args.includes('--calendar-only'),
        dryRun,
        log: console.log,
      });
    };
    if (prisma)
      await runWithSyncRun(prisma, 'discover-hearings-florida', run, { skipIfRunning: true });
    else await run();
  } finally {
    await prisma?.$disconnect();
  }
}

type FloridaCalendarSessionRunOptions = {
  from: string;
  to: string;
  sessions: readonly string[];
  /** Keep the latency-sensitive calendar pass independent from archive work. */
  includeArchive?: boolean;
  dryRun?: boolean;
  log?: (message: string) => void;
};

type FloridaCalendarSessionDependencies = {
  discover?: typeof discoverFloridaCalendar;
  archive?: (
    prisma: PrismaClient,
    options: {
      session: string;
      from: string;
      to: string;
      delayMs: number;
      catalog: boolean;
      log?: (message: string) => void;
    },
  ) => Promise<{
    archive: {
      inserted: number;
      updated: number;
      unchanged: number;
      errors: number;
      issues: readonly string[];
      ambiguous: readonly string[];
    };
  }>;
};

/**
 * Parse the bounded set of official Florida sessions requested by the worker.
 *
 * Explicit CLI values win over environment values. Without either override,
 * the Tallahassee-date default covers the current regular session and, during
 * the fall publication rollover, the next regular session. Official special-
 * session codes are accepted only when an operator supplies them explicitly.
 */
export function floridaCalendarSessions(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): string[] {
  const value = (key: string) =>
    args.find((candidate) => candidate.startsWith(`--${key}=`))?.slice(key.length + 3);
  const cliPrimary = value('session');
  const cliAdditional = value('additional-session');
  const hasCliOverride = cliPrimary !== undefined || cliAdditional !== undefined;
  const envPrimary = env.FL_CALENDAR_SESSION?.trim();
  const envAdditional = env.FL_CALENDAR_ADDITIONAL_SESSION?.trim();
  const hasEnvOverride = Boolean(envPrimary || envAdditional);
  const requested = hasCliOverride
    ? [cliPrimary ?? '', cliAdditional ?? '']
    : hasEnvOverride
      ? [envPrimary ?? '', envAdditional ?? '']
      : defaultFloridaRegularSessions(now);
  const sessions = [
    ...new Set(requested.map((session) => session.trim().toUpperCase()).filter(Boolean)),
  ];
  if (
    ((hasCliOverride || hasEnvOverride) && !requested[0]?.trim()) ||
    !sessions.length ||
    sessions.length > 2 ||
    sessions.some((session) => !isFloridaSessionCode(session))
  )
    throw new Error('Florida source requires one or two valid Florida session codes');
  return sessions;
}

export function floridaCalendarDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.FL_CALENDAR_DELAY_MS?.trim();
  if (!value) return 1000;
  const delay = Number(value);
  if (!Number.isInteger(delay) || delay < 1000 || delay > 5000)
    throw new Error('FL_CALENDAR_DELAY_MS must be an integer in 1000..5000');
  return delay;
}

/**
 * Execute one bounded recurring Florida window across a session rollover.
 *
 * The explicit primary session keeps the established full pass: session-
 * specific Senate committee pages plus shared Senate daily and House pages.
 * An optional second session probes Senate committee pages only. House notice
 * pages self-identify their session, daily floor parsing uses each date's year,
 * and the TFC archive runs exactly once under the primary session.
 */
export async function discoverFloridaCalendarSessions(
  prisma: PrismaClient | null,
  options: FloridaCalendarSessionRunOptions,
  dependencies: FloridaCalendarSessionDependencies = {},
) {
  const sessions = [...new Set(options.sessions)];
  if (
    !sessions.length ||
    sessions.length > 2 ||
    sessions.some((session) => !isFloridaSessionCode(session))
  )
    throw new Error('Florida source requires one or two valid Florida session codes');
  const discover = dependencies.discover ?? discoverFloridaCalendar;
  const primarySession = sessions[0]!;
  const delayMs = floridaCalendarDelayMs();
  const throttledHosts = new Map<string, FloridaSourceRateLimitError>();
  const results: Awaited<ReturnType<typeof discoverFloridaCalendar>> = [];
  const seenSenateNoticeIds = new Set<string>();

  for (const session of sessions) {
    const primary = session === primarySession;
    results.push(
      ...(await discover(prisma, {
        from: options.from,
        to: options.to,
        session,
        chambers: primary ? ['senate', 'house'] : ['senate'],
        includeSenateDaily: primary,
        optionalSession: !primary,
        recordSourceHealth: primary,
        delayMs,
        throttledHosts,
        seenSenateNoticeIds,
        dryRun: options.dryRun,
        log: options.log,
      })),
    );
  }

  // Recurring TFC archive sweep: same window as the chamber pass, bounded and
  // idempotent. Run it once under the EXPLICIT PRIMARY session. A future
  // committee session can be official before TFC publishes that taxonomy;
  // querying it would fail this otherwise healthy recurring pass, and querying
  // both could project one multiply-tagged video with conflicting identity.
  let archive = {
    inserted: 0,
    updated: 0,
    unchanged: 0,
    errors: 0,
    issues: 0,
    ambiguous: [] as readonly string[],
  };
  if (prisma && options.includeArchive !== false) {
    const backfill =
      dependencies.archive ??
      (await import('./florida-archive-discovery.js')).backfillFloridaArchive;
    const result = await backfill(prisma, {
      session: primarySession,
      from: options.from,
      to: options.to,
      delayMs: 400,
      catalog: true,
      log: options.log,
    });
    archive = {
      inserted: result.archive.inserted,
      updated: result.archive.updated,
      unchanged: result.archive.unchanged,
      errors: result.archive.errors,
      issues: result.archive.issues.length,
      ambiguous: result.archive.ambiguous,
    };
  }
  return floridaDiscoveryRunCounts(results, archive);
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
    const snap = row.calendarSnapshot as {
      watchUrl?: unknown;
      fields?: { watchUrl?: unknown };
    } | null;
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
