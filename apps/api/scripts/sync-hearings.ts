/**
 * Sync Congressional committee hearings & markups from Congress.gov API.
 *   pnpm --filter @capiro/api sync:hearings
 *
 * Source: api.congress.gov/v3
 *
 * TWO complementary sources, both written to `committee_hearing`:
 *
 *   1. /committee-meeting/{congress}  ← PRIMARY, forward-looking SCHEDULE.
 *      This is the only Congress.gov endpoint that carries UPCOMING /
 *      scheduled hearings & markups (with date, time, room, status). The
 *      list endpoint is minimal (eventId, chamber, url); we fan out to the
 *      detail endpoint for date/title/type/committee/location.
 *      Row id: `cm-{congress}-{eventId}`.
 *
 *   2. /hearing/{congress}  ← historical / transcript records + witnesses.
 *      Records here only appear weeks-to-months AFTER a hearing, so on its
 *      own it can never show upcoming hearings — that was the original
 *      staleness bug. We keep it for back-catalog depth and witness lists.
 *      Row id: `{congress}-{jacketNumber}-{date}`.
 *
 * Committee detail records expose only a systemCode, not a name, so we
 * prebuild a systemCode→name cache from /committee/{chamber} (covers full
 * + sub-committees) once per run.
 *
 * Auth: CONGRESS_API_KEY (same as sync-congress.ts). Rate limit 5000/h with
 * a key; the per-request DELAY_MS keeps us comfortably under it.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
// Eastern-time derivation lives in ./lib so it is unit-testable without pulling
// in PrismaClient (and therefore without a generated client). See that file's
// header for why every one of these exists.
import {
  etCalendarDay,
  formatTime,
  hearingCalendarDate,
  houseStartsAt,
  isDateOnlySentinel,
  safeDate,
} from './lib/hearing-time.js';
dotenvConfig();

const CONGRESS_BASE = 'https://api.congress.gov/v3';
const API_KEY = process.env.CONGRESS_API_KEY ?? '';
const DELAY_MS = 150;
const LIST_LIMIT = 250;
const MEETING_MAX_PAGES = 40; // 40 × 250 = 10k headroom (119th has ~2.5k)
const HEARING_MAX_PAGES = 30; // 30 × 100 = 3k headroom (119th has ~770)
const HEARING_LIST_LIMIT = 100;
// Only the current Congress. The previous (118th) is finished — re-scanning it
// every day wrote 0 genuinely new rows and doubled runtime.
const TARGET_CONGRESSES = [119];
const CURRENT_CONGRESS = TARGET_CONGRESSES[0] ?? 119;

/* ── Source 3: docs.house.gov House Committee Repository ──────────────────────
 * The Congress.gov committee-meeting API lags the House Clerk by a day or more,
 * so its forward window is thin. docs.house.gov publishes upcoming House meetings
 * first. Its per-day view (ByDay.aspx?DayID=MMDDYYYY) is a plain GET (unlike the
 * week view, which is an ASP.NET postback) and each row carries EventID + title +
 * committee + time + location. The House `EventID` is the SAME id Congress.gov
 * uses for `house-event`, so we key rows `cm-<congress>-<eventId>` — they merge
 * with Source 1 (no duplicate; Congress.gov later enriches the same row with
 * systemCode/witnesses, which we never overwrite). House-only; forward-looking. */
const HOUSE_DOCS_BASE = 'https://docs.house.gov/Committee/Calendar';
const HOUSE_DOCS_DAYS_AHEAD = Number(process.env.HOUSE_DOCS_DAYS_AHEAD ?? 21);
const HOUSE_DOCS_ENABLED = (process.env.HOUSE_DOCS_ENABLED ?? 'true').toLowerCase() !== 'false';
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

interface MeetingListItem {
  eventId?: string | null;
  chamber?: string | null;
  congress?: number | null;
  url?: string | null;
}

interface MeetingDetail {
  eventId?: string | null;
  chamber?: string | null;
  congress?: number | null;
  title?: string | null;
  type?: string | null; // Hearing, Markup, Meeting, Open Hearing, ...
  meetingStatus?: string | null; // Scheduled, Postponed, Rescheduled, Cancelled
  date?: string | null; // ISO datetime, e.g. 2026-06-25T14:15:00Z
  location?: { building?: string | null; room?: string | null } | null;
  committees?: Array<{ name?: string | null; systemCode?: string | null }> | null;
  // Public-facing links (event page, video). The list/detail `url` is the API
  // endpoint and requires an api_key — never store it for the UI.
  videos?: Array<{ name?: string | null; url?: string | null }> | null;
  // Witnesses are on the committee-meeting record (same payload we already fetch
  // for Source 1) — populated as a committee posts them, often for UPCOMING
  // hearings. Previously dropped; H1c stores them so hearing-prep sees them early.
  witnesses?: Array<{
    name?: string | null;
    position?: string | null;
    organization?: string | null;
  }> | null;
  // Bills/resolutions on the meeting agenda (LegiWatch B3). Congress.gov nests
  // them under relatedItems.bills[]; the array is inlined in this same detail
  // payload (previously fetched then dropped). Each carries type/number/congress.
  relatedItems?: {
    bills?: Array<{
      type?: string | null; // "HR" | "S" | "HRES" | "HJRES" | ...
      number?: number | string | null;
      congress?: number | null;
      url?: string | null;
    }> | null;
  } | null;
}

interface HearingListItem {
  chamber?: string | null;
  congress?: number | null;
  jacketNumber?: number | null;
  number?: number | null;
  updateDate?: string | null;
  url?: string | null;
}

interface HearingDetail {
  title?: string | null;
  chamber?: string | null;
  citation?: string | null;
  committees?: Array<{ name?: string | null; systemCode?: string | null }> | null;
  dates?: Array<{ date?: string | null }> | null;
  jacketNumber?: number | null;
  number?: number | null;
  updateDate?: string | null;
  // Public transcript links (HTM/PDF) on congress.gov — no api_key needed.
  formats?: Array<{ type?: string | null; url?: string | null }> | null;
  associatedMeeting?: { eventID?: string | null } | null;
}

interface CommitteeMeetingWitnessDetail {
  witnesses?: Array<{
    name?: string | null;
    position?: string | null;
    organization?: string | null;
  }> | null;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return (await resp.json()) as T;
  } catch (err) {
    console.warn(`GET ${url}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Canonical congress_bill ids for the bills on a meeting agenda (LegiWatch B3),
 * from the detail's relatedItems.bills[]. "HR"/"H.R." → "hr", so a
 * {congress:119,type:"HR",number:8800} becomes "119-hr-8800" (soft ref — the
 * bill may be untracked). Tolerant of the nested `{ bill: [...] }` envelope
 * Congress.gov sometimes uses; skips rows missing any of the three keys.
 */
function relatedAgendaBills(d: MeetingDetail): Array<{ billId: string; congress: number }> {
  const raw: unknown = d.relatedItems?.bills;
  const arr: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { bill?: unknown[] } | null)?.bill)
      ? ((raw as { bill: unknown[] }).bill ?? [])
      : [];
  const out: Array<{ billId: string; congress: number }> = [];
  const seen = new Set<string>();
  for (const b of arr as Array<{ type?: unknown; number?: unknown; congress?: unknown }>) {
    const congress = Number(b?.congress);
    const type = String(b?.type ?? '')
      .toLowerCase()
      .replace(/[.\s]/g, '');
    const number = String(b?.number ?? '').trim();
    if (!Number.isFinite(congress) || congress <= 0 || !type || !number) continue;
    const billId = `${congress}-${type}-${number}`;
    if (seen.has(billId)) continue;
    seen.add(billId);
    out.push({ billId, congress });
  }
  return out;
}

function formatLocation(loc: MeetingDetail['location']): string | null {
  if (!loc) return null;
  const parts = [loc.building?.trim(), loc.room ? `Room ${loc.room.trim()}` : null].filter(
    (p): p is string => !!p,
  );
  return parts.length ? parts.join(', ') : null;
}

function normalizeChamber(raw: string | null | undefined, fallback?: string | null): string {
  const c = (raw || fallback || 'Joint').toLowerCase();
  if (c === 'senate') return 'Senate';
  if (c === 'house') return 'House';
  return raw || fallback || 'Joint';
}

/** Public-facing congress.gov event page for a committee meeting. The API
 *  also returns this in videos[].url; we prefer that when present and otherwise
 *  construct the canonical form:
 *    https://www.congress.gov/event/{congress}th-Congress/{chamber}-event/{eventId}
 *  NEVER store the api.congress.gov URL — it requires an api_key and renders
 *  an API_KEY_MISSING error in the browser. */
function meetingPublicUrl(
  detail: MeetingDetail,
  congress: number,
  chamber: string,
  eventId: string,
): string | null {
  const fromVideo = detail.videos?.find((v) => v.url && v.url.includes('congress.gov/event'))?.url;
  if (fromVideo) return fromVideo;
  const chamberSlug = chamber.toLowerCase();
  if (chamberSlug !== 'house' && chamberSlug !== 'senate') return null;
  return `https://www.congress.gov/event/${congress}th-Congress/${chamberSlug}-event/${eventId}`;
}

/** Public transcript link for a hearing: prefer Formatted Text (HTM), fall
 *  back to PDF, from the detail formats[]. Returns null when no public
 *  transcript exists yet (common for very recent hearings). */
function hearingPublicUrl(detail: HearingDetail): string | null {
  const fmts = detail.formats ?? [];
  const htm = fmts.find((f) => (f.type || '').toLowerCase().includes('text'))?.url;
  const pdf = fmts.find((f) => (f.type || '').toLowerCase().includes('pdf'))?.url;
  return htm ?? pdf ?? null;
}

function withAuth(rawUrl: string): string {
  const sep = rawUrl.includes('?') ? '&' : '?';
  return `${rawUrl}${sep}api_key=${API_KEY}&format=json`;
}

/** Build a systemCode → committee name cache (full + sub-committees, both
 *  chambers). One bulk endpoint per page; ~2-3 pages per chamber. */
async function buildCommitteeNameCache(): Promise<Map<string, string>> {
  const cache = new Map<string, string>();
  for (const chamber of ['house', 'senate']) {
    let offset = 0;
    for (let page = 0; page < 6; page++) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
      const url = `${CONGRESS_BASE}/committee/${chamber}?api_key=${API_KEY}&format=json&limit=250&offset=${offset}`;
      const resp = await fetchJson<{
        committees: Array<{ systemCode?: string | null; name?: string | null }>;
      }>(url);
      const items = resp?.committees ?? [];
      for (const c of items) {
        if (c.systemCode && c.name) cache.set(c.systemCode, c.name);
      }
      if (items.length < 250) break;
      offset += 250;
    }
  }
  console.log(`[hearings-sync] committee-name cache: ${cache.size} entries`);
  return cache;
}

/** Normalize a witnesses[] payload to "Name, Position, Organization" strings. */
function formatWitnesses(
  witnesses:
    | Array<{ name?: string | null; position?: string | null; organization?: string | null }>
    | null
    | undefined,
): string[] {
  return (witnesses ?? [])
    .map((w) =>
      [w.name?.trim(), w.position?.trim(), w.organization?.trim()]
        .filter((p): p is string => !!p)
        .join(', '),
    )
    .filter((s) => s.length > 0);
}

/** Witnesses live on the committee-meeting record (the /hearing endpoint has
 *  none). Fetches the committee-meeting detail by eventId (used by Source 2,
 *  which only has a jacket + associatedMeeting eventID). */
async function fetchWitnesses(
  congress: number,
  chamber: string,
  eventId: string | null | undefined,
): Promise<string[]> {
  if (!eventId) return [];
  const chamberSlug = chamber.toLowerCase();
  const url = `${CONGRESS_BASE}/committee-meeting/${congress}/${chamberSlug}/${eventId}?api_key=${API_KEY}&format=json`;
  const resp = await fetchJson<{ committeeMeeting: CommitteeMeetingWitnessDetail }>(url);
  return formatWitnesses(resp?.committeeMeeting?.witnesses);
}

/* ── docs.house.gov helpers ─────────────────────────────────────────────── */

interface HouseDocsMeeting {
  eventId: string;
  committee: string;
  title: string;
  time: string | null;
  location: string | null;
}

/** Fetch a docs.house.gov page (UTF-8; smart quotes/dashes are normalized to ASCII
 *  downstream by cleanHouseText). */
async function fetchHouseHtml(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return new TextDecoder('utf-8').decode(await resp.arrayBuffer());
  } catch (err) {
    console.warn(`GET ${url}: ${(err as Error).message}`);
    return null;
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: "'",
  lsquo: "'",
  ldquo: '"',
  rdquo: '"',
  ndash: '-',
  mdash: '-',
  hellip: '...',
  '#39': "'",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z0-9#]+);/gi, (m, name) => ENTITIES[name] ?? ENTITIES[name.toLowerCase()] ?? m);
}

/** Strip tags, decode entities, normalize typographic chars to ASCII, collapse space. */
function cleanHouseText(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ' '))
    .replace(/[‘’′]/g, "'")
    .replace(/[“”″]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[ \s]+/g, ' ')
    .trim();
}

// One ByDay GridView row: EventID + title (link) + committee (span.text-tiny) + time + location.
const BYDAY_ROW =
  /<a href="ByEvent\.aspx\?EventID=(\d+)"\s+title="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<span class="text-tiny" title="([^"]*)"[^>]*>[\s\S]*?<\/span>[\s\S]*?<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/g;

function parseByDay(html: string): HouseDocsMeeting[] {
  const out: HouseDocsMeeting[] = [];
  BYDAY_ROW.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BYDAY_ROW.exec(html)) !== null) {
    const eventId = m[1] ?? '';
    const title = cleanHouseText(m[2] || m[3] || '');
    const committee = cleanHouseText(m[4] ?? '');
    const time = cleanHouseText(m[5] ?? '') || null;
    const location = cleanHouseText(m[6] ?? '') || null;
    if (eventId && committee) out.push({ eventId, committee, title, time, location });
  }
  return out;
}

function inferHouseType(title: string, committee: string): string {
  const t = `${title} ${committee}`.toLowerCase();
  if (/\bmark[- ]?up\b|marking up/.test(t)) return 'markup';
  if (/\bbusiness meeting\b|organizational meeting|\bmeeting\b/.test(t)) return 'meeting';
  return 'hearing';
}

/** MMDDYYYY for a Date's UTC calendar day (matches docs.house.gov DayID + our DATE column). */
function houseDayId(d: Date): string {
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${mm}${dd}${d.getUTCFullYear()}`;
}

/**
 * Source 3: pull upcoming House committee meetings from docs.house.gov (today +
 * HOUSE_DOCS_DAYS_AHEAD), one ByDay GET per day. Upserts under the shared
 * `cm-<congress>-<eventId>` id so rows merge with the Congress.gov source; the
 * update never touches committeeCode/witnesses (Congress.gov owns those), so
 * enrichment from Source 1 is preserved.
 */
async function syncHouseDocsMeetings(
  prisma: PrismaClient,
): Promise<{ upserts: number; days: number; fails: number }> {
  let upserts = 0;
  let days = 0;
  let fails = 0;
  // Anchor the window on the EASTERN calendar day, not the UTC one. docs.house.gov
  // publishes an Eastern calendar, so a UTC-anchored `base` skipped the current
  // day's page entirely between 8 PM and midnight ET (when the UTC date has
  // already rolled over).
  const base = etCalendarDay(new Date());

  for (let offset = 0; offset <= HOUSE_DOCS_DAYS_AHEAD; offset++) {
    const day = new Date(base.getTime() + offset * 86400000);
    await new Promise((r) => setTimeout(r, DELAY_MS));
    const html = await fetchHouseHtml(`${HOUSE_DOCS_BASE}/ByDay.aspx?DayID=${houseDayId(day)}`);
    if (html == null) {
      fails++;
      continue;
    }
    days++;
    const meetings = parseByDay(html);
    for (const mtg of meetings) {
      const id = `cm-${CURRENT_CONGRESS}-${mtg.eventId}`;
      const title = mtg.title || '(untitled)';
      const row = {
        title,
        chamber: 'House',
        committeeName: mtg.committee,
        date: day,
        // Already an Eastern wall-clock string scraped off the page, so it is
        // converted FORWARD to an instant rather than re-derived from one. Since
        // Source 1 now also emits Eastern, both writers finally agree on the
        // convention for this shared column and last-writer-wins is harmless.
        startsAt: houseStartsAt(day, mtg.time),
        time: mtg.time,
        location: mtg.location,
        type: inferHouseType(title, mtg.committee),
        url: `https://www.congress.gov/event/${CURRENT_CONGRESS}th-Congress/house-event/${mtg.eventId}`,
      };
      await prisma.committeeHearing.upsert({
        where: { id },
        // Preserve committeeCode + witnesses (Source 1 owns them); refresh display fields.
        update: { ...row, syncedAt: new Date() },
        create: { id, committeeCode: null, witnesses: [], ...row },
      });
      upserts++;
    }
  }
  return { upserts, days, fails };
}

async function main() {
  const prisma = new PrismaClient();
  const t0 = Date.now();
  console.log('[hearings-sync] starting');
  if (!API_KEY) throw new Error('CONGRESS_API_KEY env var is required');

  let meetingUpserts = 0;
  let meetingSkippedNoDate = 0;
  let meetingDetailFails = 0;
  let hearingBillLinks = 0;
  let hearingUpserts = 0;
  let hearingSkippedNoDate = 0;
  let hearingDetailFails = 0;

  try {
    await runWithSyncRun(prisma as any, 'sync-hearings', async () => {
      const committeeNames = await buildCommitteeNameCache();

      /* ── Source 1: committee-meeting schedule (forward-looking) ──────── */
      for (const congress of TARGET_CONGRESSES) {
        console.log(`[hearings-sync] committee-meeting: fetching ${congress}th Congress`);
        let offset = 0;
        let scanned = 0;

        for (let page = 0; page < MEETING_MAX_PAGES; page++) {
          await new Promise((r) => setTimeout(r, DELAY_MS));
          const listUrl = `${CONGRESS_BASE}/committee-meeting/${congress}?api_key=${API_KEY}&format=json&limit=${LIST_LIMIT}&offset=${offset}`;
          const list = await fetchJson<{ committeeMeetings: MeetingListItem[] }>(listUrl);
          if (!list?.committeeMeetings?.length) break;

          for (const item of list.committeeMeetings) {
            if (!item.eventId || !item.url) continue;
            await new Promise((r) => setTimeout(r, DELAY_MS));
            const detailResp = await fetchJson<{ committeeMeeting: MeetingDetail }>(
              withAuth(item.url),
            );
            const d = detailResp?.committeeMeeting;
            if (!d) {
              meetingDetailFails++;
              continue;
            }

            const instant = safeDate(d.date);
            if (!instant) {
              meetingSkippedNoDate++;
              continue;
            }
            // `date`/`time` are ET-derived DISPLAY fields; `startsAt` is the true
            // instant and is what any time-based logic (liveness, windows,
            // ordering across days) must read. Null for a date-only record —
            // never a fabricated midnight.
            const date = hearingCalendarDate(instant);
            const startsAt = isDateOnlySentinel(instant) ? null : instant;

            const chamber = normalizeChamber(d.chamber, item.chamber);
            const sysCode = d.committees?.[0]?.systemCode ?? null;
            const committeeName =
              (sysCode ? committeeNames.get(sysCode) : null) ??
              d.committees?.[0]?.name ??
              'Unknown committee';
            // Surface non-scheduled status in the title so the UI shows it
            // without a schema change.
            const status = d.meetingStatus?.trim();
            const baseTitle = d.title?.trim() || '(untitled)';
            const title =
              status && status.toLowerCase() !== 'scheduled'
                ? `[${status}] ${baseTitle}`
                : baseTitle;

            // H1c: witnesses ride on the committee-meeting detail we already
            // fetched — store them (populated as a committee posts them, so
            // upcoming hearings surface their witness list once announced). The
            // detail is authoritative for cm-* rows, so setting it each run is
            // idempotent; Source 3 (docs.house) preserves this on its later merge.
            const witnesses = formatWitnesses(d.witnesses);
            const id = `cm-${congress}-${item.eventId}`;
            const row = {
              title,
              chamber,
              committeeName,
              committeeCode: sysCode,
              date,
              startsAt,
              time: formatTime(d.date),
              location: formatLocation(d.location),
              type: d.type?.trim() || 'Meeting',
              witnesses,
              url: meetingPublicUrl(d, congress, chamber, item.eventId),
            };
            await prisma.committeeHearing.upsert({
              where: { id },
              update: { ...row, syncedAt: new Date() },
              create: { id, ...row },
            });
            meetingUpserts++;

            // B3: persist the meeting's agenda bills (relatedItems.bills[]),
            // previously dropped. Idempotent on (hearingId, billId).
            const agendaBills = relatedAgendaBills(d);
            if (d.relatedItems?.bills && !agendaBills.length) {
              // relatedItems present but nothing parsed → likely the {count,url}
              // reference envelope, not inline. Log so we can add a sub-fetch.
              console.warn(
                `[hearings-sync] ${id}: relatedItems.bills present but 0 parsed (reference envelope?)`,
              );
            }
            for (const rb of agendaBills) {
              await prisma.committeeHearingBill.upsert({
                where: { hearingId_billId: { hearingId: id, billId: rb.billId } },
                update: { syncedAt: new Date() },
                create: { hearingId: id, billId: rb.billId, congress: rb.congress },
              });
              hearingBillLinks++;
            }
          }

          scanned += list.committeeMeetings.length;
          offset += LIST_LIMIT;
          console.log(
            `[hearings-sync] committee-meeting ${congress}th: scanned ${scanned}, upserts ${meetingUpserts}, skipped(no-date) ${meetingSkippedNoDate}, detail-fails ${meetingDetailFails}`,
          );
          if (list.committeeMeetings.length < LIST_LIMIT) break;
        }
      }

      /* ── Source 2: hearing transcripts + witnesses (historical) ──────── */
      for (const congress of TARGET_CONGRESSES) {
        console.log(`[hearings-sync] hearing-transcripts: fetching ${congress}th Congress`);
        let offset = 0;
        let scanned = 0;

        for (let page = 0; page < HEARING_MAX_PAGES; page++) {
          await new Promise((r) => setTimeout(r, DELAY_MS));
          const listUrl = `${CONGRESS_BASE}/hearing/${congress}?api_key=${API_KEY}&format=json&limit=${HEARING_LIST_LIMIT}&offset=${offset}`;
          const list = await fetchJson<{ hearings: HearingListItem[] }>(listUrl);
          if (!list?.hearings?.length) break;

          for (const item of list.hearings) {
            if (!item.url || !item.jacketNumber) continue;
            await new Promise((r) => setTimeout(r, DELAY_MS));
            const detailResp = await fetchJson<{ hearing: HearingDetail }>(withAuth(item.url));
            const detail = detailResp?.hearing;
            if (!detail) {
              hearingDetailFails++;
              continue;
            }

            const title = detail.title ?? '(untitled)';
            const chamber = normalizeChamber(detail.chamber, item.chamber);
            const sysCode = detail.committees?.[0]?.systemCode ?? null;
            const committeeName =
              (sysCode ? committeeNames.get(sysCode) : null) ??
              detail.committees?.[0]?.name ??
              'Unknown committee';

            const dates =
              (detail.dates ?? [])
                .map((dd) => safeDate(dd.date))
                .filter((dd): dd is Date => dd != null) ?? [];
            if (!dates.length) {
              hearingSkippedNoDate++;
              continue;
            }

            await new Promise((r) => setTimeout(r, DELAY_MS));
            const witnesses = await fetchWitnesses(
              congress,
              chamber,
              detail.associatedMeeting?.eventID,
            );

            for (const instant of dates) {
              // The id key stays on the UTC date DELIBERATELY. It is part of the
              // primary key of already-persisted rows; re-deriving it in Eastern
              // would mint a NEW id for every evening-timed hearing and fork a
              // duplicate instead of updating. (In practice these transcript
              // records are date-only, so the two agree — but the id must not
              // depend on that.)
              const dateKey = instant.toISOString().slice(0, 10);
              const id = `${congress}-${item.jacketNumber}-${dateKey}`;
              const date = hearingCalendarDate(instant);
              const startsAt = isDateOnlySentinel(instant) ? null : instant;
              const publicUrl = hearingPublicUrl(detail);
              await prisma.committeeHearing.upsert({
                where: { id },
                update: {
                  title,
                  chamber,
                  committeeName,
                  committeeCode: sysCode,
                  date,
                  startsAt,
                  type: 'hearing',
                  witnesses,
                  url: publicUrl,
                  syncedAt: new Date(),
                },
                create: {
                  id,
                  title,
                  chamber,
                  committeeName,
                  committeeCode: sysCode,
                  date,
                  startsAt,
                  type: 'hearing',
                  witnesses,
                  url: publicUrl,
                },
              });
              hearingUpserts++;
            }
          }

          scanned += list.hearings.length;
          offset += HEARING_LIST_LIMIT;
          console.log(
            `[hearings-sync] hearing-transcripts ${congress}th: scanned ${scanned}, upserts ${hearingUpserts}, skipped(no-date) ${hearingSkippedNoDate}, detail-fails ${hearingDetailFails}`,
          );
          if (list.hearings.length < HEARING_LIST_LIMIT) break;
        }
      }

      /* ── Source 3: docs.house.gov upcoming House meetings (forward window) ── */
      let houseDocsUpserts = 0;
      let houseDocsDays = 0;
      let houseDocsFails = 0;
      if (HOUSE_DOCS_ENABLED) {
        try {
          console.log(
            `[hearings-sync] docs.house.gov: scanning today +${HOUSE_DOCS_DAYS_AHEAD} days`,
          );
          const res = await syncHouseDocsMeetings(prisma);
          houseDocsUpserts = res.upserts;
          houseDocsDays = res.days;
          houseDocsFails = res.fails;
          console.log(
            `[hearings-sync] docs.house.gov: upserts ${houseDocsUpserts} over ${houseDocsDays} days, day-fetch-fails ${houseDocsFails}`,
          );
        } catch (err) {
          // A docs.house.gov outage must not fail the whole sync (Congress.gov is primary).
          houseDocsFails++;
          console.warn(`[hearings-sync] docs.house.gov source failed: ${(err as Error).message}`);
        }
      }

      const totalUpserts = meetingUpserts + hearingUpserts + houseDocsUpserts;
      console.log(
        `[hearings-sync] DONE: meeting-upserts ${meetingUpserts}, hearing-upserts ${hearingUpserts}, ` +
          `house-docs-upserts ${houseDocsUpserts}, agenda-bill-links ${hearingBillLinks}, ` +
          `skipped(no-date) ${meetingSkippedNoDate + hearingSkippedNoDate}, detail-fails ${meetingDetailFails + hearingDetailFails} ` +
          `in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
      return {
        inserted: 0,
        updated: totalUpserts,
        skipped: meetingSkippedNoDate + hearingSkippedNoDate,
        errors: meetingDetailFails + hearingDetailFails + houseDocsFails,
      };
    });
  } finally {
    await prisma.$disconnect();
  }
}

// Guarded so the pure date/time helpers above can be imported by a unit test
// without kicking off a live Congress.gov sync. Matches the established idiom in
// this directory (backfill-legiscan-datasets.ts, derive-bill-status.ts, et al).
if (require.main === module) {
  main().catch((err) => {
    console.error('[hearings-sync] FAILED', err);
    process.exit(1);
  });
}
