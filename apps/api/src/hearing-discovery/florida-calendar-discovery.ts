import { PrismaClient, type Prisma } from '@prisma/client';
import { PDFParse } from 'pdf-parse';
import { CommitteeSourceRepository } from './committee-source.repository.js';
import { HearingReconcilerService } from './hearing-reconciler.service.js';
import { runWithSyncRun } from '../ingestion/sync-run.helper.js';
import type { LegislativeObservation } from './legislative-calendar.js';
import { contentHash } from './hearing-identity.js';
import {
  FL_CALENDAR_PARSER,
  FL_HOUSE,
  FL_SENATE,
  fetchFloridaSource,
  floridaDate,
  floridaBillNumberAliases,
  houseNoticeLinks,
  houseNoticeObservation,
  senateCommitteeLinks,
  senateNoticeRefs,
  senateNoticeObservation,
  senateDailyCalendar,
  houseDailyCalendar,
} from './adapters/florida-calendar.adapter.js';

export type FloridaDiscoveryOptions = {
  from: string;
  to: string;
  session: string;
  dryRun?: boolean;
  delayMs?: number;
  log?: (message: string) => void;
  fetchSource?: typeof fetchFloridaSource;
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
  const results: Array<{
    chamber: string;
    pages: number;
    expected: number;
    found: number;
    inserted: number;
    updated: number;
    unchanged: number;
    issues: string[];
    events: string[];
  }> = [];
  for (const chamber of ['senate', 'house'] as const) {
    const now = new Date(),
      issues: string[] = [],
      observations: LegislativeObservation[] = [];
    let pages = 0,
      expected = 0,
      inserted = 0,
      updated = 0,
      unchanged = 0;
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
                issues.push(`${ref.id}: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
          } catch (e) {
            issues.push(`${body.code}: ${e instanceof Error ? e.message : String(e)}`);
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
                issues.push(`${ref.id}: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
          } catch (e) {
            issues.push(`${date}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } else {
        const urls = new Set<string>();
        let unresolved = 0;
        for (
          let date = new Date(`${options.from}T00:00:00Z`);
          date.toISOString().slice(0, 10) <= options.to;
          date.setUTCDate(date.getUTCDate() + 1)
        ) {
          await pause();
          const day = `${date.getUTCMonth() + 1}-${date.getUTCDate()}-${date.getUTCFullYear()}`;
          const html = await text(
            `${FL_HOUSE}/Sections/HouseSchedule/houseschedule.aspx?date=${day}`,
          );
          pages++;
          if (!/House Schedule|HouseSchedule/i.test(html))
            throw new Error('House schedule layout unavailable');
          for (const url of houseNoticeLinks(html)) urls.add(url);
          const daily = houseDailyCalendar(html, date.toISOString().slice(0, 10), options.session);
          unresolved += daily.unresolved + daily.floors.length;
          observations.push(...daily.floors);
          issues.push(...daily.issues);
        }
        expected = urls.size + unresolved;
        for (const url of urls) {
          await pause();
          try {
            // A session may only be attached when the specific notice provides
            // it. Joint/no-bill off-session meetings deliberately stay unknown.
            const html = await text(url);
            pages++;
            const observation = houseNoticeObservation(html, url, null);
            if (
              observation.fields.time &&
              observation.fields.time.date >= options.from &&
              observation.fields.time.date <= options.to
            )
              observations.push(observation);
            else
              issues.push(
                `${observation.officialIdentity}: linked notice falls outside the requested schedule window`,
              );
          } catch (e) {
            issues.push(
              `${new URL(url).searchParams.get('MeetingId')}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
      }
      for (const observation of observations) {
        if (prisma && source && reconciler) {
          try {
            await resolveFloridaAgenda(prisma, observation);
            const outcome = await reconciler.reconcileEvent(
              source,
              {
                externalEventId: observation.officialIdentity,
                chamber: observation.chamber,
                legislative: observation,
              },
              new Date(),
            );
            if (outcome.hearingCreated) inserted++;
            else if (outcome.changedFields.length) updated++;
            else unchanged++;
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
      issues.push(e instanceof Error ? e.message : String(e));
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
      events: observations.map((o) => o.officialIdentity),
    };
    results.push(result);
    if (prisma && source && coverage && repo) {
      const state = issues.length ? (observations.length ? 'partial' : 'failed') : 'complete';
      await prisma.legislativeCalendarCoverage.update({
        where: { id: coverage.id },
        data: {
          status: state,
          pages,
          items: observations.length,
          details: result as Prisma.InputJsonValue,
        },
      });
      await repo.recordOutcome(
        source.id,
        {
          ok: state === 'complete',
          observedEvents: observations.length,
          error: issues.length ? `${issues.length} source qualification issues` : null,
        },
        new Date(),
        FL_CALENDAR_PARSER,
      );
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
      return {
        inserted: results.reduce((n, r) => n + r.inserted, 0),
        updated: results.reduce((n, r) => n + r.updated, 0),
        skipped: results.reduce((n, r) => n + r.unchanged, 0),
        errors: results.reduce((n, r) => n + r.issues.length, 0),
      };
    };
    if (prisma)
      await runWithSyncRun(prisma, 'discover-hearings-florida', run, { skipIfRunning: true });
    else await run();
  } finally {
    await prisma?.$disconnect();
  }
}
