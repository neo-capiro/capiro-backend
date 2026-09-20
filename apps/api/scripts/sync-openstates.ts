/**
 * Sync Open States, state legislature PEOPLE + COMMITTEES only (State
 * Legislation Platform DD2 — LegiScan is the bill spine; OpenStates bills are
 * a cross-check, not the source of record. The bills loop this file used to
 * run was removed 2026-07-10 — LegiScan's getMasterListRaw/getBill replaced it
 * (backfill-legiscan-datasets.ts, sync-legiscan-masterlist.ts,
 * sync-legiscan-bills.ts): OpenStates v3 bills paginate at a 20-row hard max
 * with no change-hash diff, the exact throttle problem LegiScan's Pull API
 * solves).
 *   pnpm --filter @capiro/api sync:openstates
 * Source: v3.openstates.org/
 * Auth: Free API key. Key in env: OPENSTATES_API_KEY
 *
 * Rate pacing (fixed 2026-09-15 against the published supplier contract,
 * openstates/api-v3 api/auth.py + api/rate_limiter.py): the limiter keeps
 * FIXED calendar-window counters (minute/hour/day keys, minute keys expire
 * 60s) and answers HTTP 429 with a plain-text detail of exactly
 * "exceeded limit of {limit}/min: {calls}" (or "/hour:", "/day:") and NO
 * Retry-After header. Tiers from auth.py: default 10/min + 250/day,
 * bronze 40/min + 1000/day, silver 80/min + 50000/day (all per_hour=0 —
 * the /hour branch exists in the limiter but no published tier sets it,
 * so an hour detail is still handled defensively). We do NOT know which
 * tier our credential holds; the recorded TD6 run captured no bodies or
 * headers. The old 2000ms cadence is 30 req/min sustained — 3x the
 * published default — and the old 4/8/16s no-hint retries could all land
 * inside the same fixed minute window (TD6: 11 HTTP 429s in 141s, runs
 * ending complete=false). Now: REQUEST_SPACING_MS paces EVERY request to
 * fit the default 10/min, and a 429 with no usable hint waits out a full
 * minute window (with jitter) instead of re-hammering it.
 * Committee sourcing (fixed 2026-07-11): `/people`'s `Person` schema has no
 * `current_memberships` field — verified against OpenStates' own live
 * `openapi.json`, whose `/people` `include` enum is only `other_names`,
 * `other_identifiers`, `links`, `sources`, `offices`. The prior code read
 * `p.current_memberships` anyway, so `StateLegislator.committees` was always
 * `[]` and normalize-state-committees.ts (M2.2) had nothing to normalize —
 * `state_committee_membership` stayed empty for every state. Committee
 * membership only exists behind the separate `/committees` endpoint
 * (`include=memberships`, confirmed live against the same openapi.json),
 * whose `CommitteeMembership` rows carry an optional `person` (CompactPerson)
 * ref — optional because OpenStates doesn't always resolve a membership back
 * to a canonical person. The same request includes `links` and `sources`, and
 * the normalized membership retains the provider committee id,
 * classification, parent, extras and provenance rather than collapsing it to
 * a display name. A membership with no `person.id` is dropped rather
 * than matched by name (PD2 — never guess an identity match), and counted so
 * the gap is visible in logs, not silent.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient, Prisma } from '@prisma/client';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import { ALL_US_STATE_CODES } from '../src/external/legiscan/us-states.js';
dotenvConfig();

const OS_BASE = 'https://v3.openstates.org';
const OS_KEY = process.env.OPENSTATES_API_KEY ?? '';
/**
 * Spacing between SUCCESSFUL requests (and between page-walk iterations).
 * The published default tier is 10/min (auth.py: Tier("default", 10, 0,
 * 250)); 6500ms paces ~9.2 requests/min including retries, so a full run
 * fits the default window without assuming our credential's actual tier.
 * Replaces the old 2000ms cadence (~30/min sustained, 3x the default).
 */
const REQUEST_SPACING_MS = 6500;
const MAX_RETRIES = 3;
/**
 * Bounded exponential backoff base for TRANSIENT failures (500/502/503/504
 * and network transport rejections): doubled per retry attempt — 13000ms,
 * 26000ms, 52000ms. Bounded to MAX_RETRIES; a valid Retry-After hint on a
 * 503 is honored instead; never applied to the final failed attempt.
 */
const TRANSIENT_RETRY_EXPONENT_MS = REQUEST_SPACING_MS * 2;
/**
 * Wait applied to a 429 that carries NO usable Retry-After hint and no
 * classifiable supplier detail. The supplier's minute counter is a FIXED
 * calendar-minute window (rate_limiter.py: key m{now.minute}, 60s expiry),
 * so a short exponential retry can re-enter the same exhausted window
 * repeatedly — the old 4/8/16s sequence burned all retries inside one
 * minute. 60s + jitter guarantees the retry lands in a NEW minute window.
 */
const NO_HINT_429_WAIT_MS = 60000;
const NO_HINT_429_JITTER_MS = 1000;
const PER_PAGE = 20; // OpenStates v3 hard max; per_page>20 -> HTTP 400 (old per_page=100/200 fetched 0 rows)
const MAX_PAGES = 5; // default page ceiling for small resources — the walk stops early anyway once pagination.max_page is reached
// People must be fully paged, not capped: every priority state legislature has
// MORE than PER_PAGE*MAX_PAGES=100 members (GA 236, NY 213, MA 200, TX 181, IL
// 177, FL 160, VA 140, CA 120), so the old shared 5-page cap silently dropped
// each state's tail — those legislators never got a state_legislator row, so
// they could never be crosswalked and always read "no sponsored bills". 25
// pages covers the largest single chamber (NH House, 400); the walk still
// breaks early at pagination.max_page for smaller states.
const PEOPLE_MAX_PAGES = 25;
// The 2026-09-16 reset run (task 85826e58d03a42b08cfdeb09ff4ce15f) proved
// real committee rosters exceed the old 5-page/100-row ceiling: NY stopped at
// 100 committee rows with the supplier still advertising more pages. Same
// bounded 25-page resource ceiling people already use; the walk still stops at
// pagination.max_page for smaller states and marks a truncated tail
// complete:false so old memberships are never overwritten from partial data.
const COMMITTEE_MAX_PAGES = PEOPLE_MAX_PAGES;
const BATCH_SIZE = 10; // process 10 states per run to avoid rate limits
// All states + DC
const ALL_STATES = ALL_US_STATE_CODES.map((s) => s.toLowerCase());

/**
 * Which states this run processes. Default: a day-of-month-rotated batch of
 * BATCH_SIZE states, so the weekly cron cycles all 51 over ~6 weeks. Override
 * with the `OPENSTATES_STATES` env (CSV, e.g. "FL,CA,TX,NY,IL,MA,GA,VA") to
 * process EXACTLY those states in one run — the only way to fully (re)populate a
 * specific set of rosters on demand instead of waiting for their batch day.
 * Mirrors sync-legiscan-masterlist's LEGISCAN_STATES convention. Pure +
 * exported for unit testing.
 */
export function resolveSyncStates(
  overrideCsv: string | undefined,
  allStates: string[],
  dayOfMonth: number,
  batchSize: number,
): string[] {
  const override = (overrideCsv ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (override.length) return override;
  const batchIndex = dayOfMonth % Math.ceil(allStates.length / batchSize);
  return allStates.slice(batchIndex * batchSize, (batchIndex + 1) * batchSize);
}

const PRIORITY_STATES = resolveSyncStates(
  process.env.OPENSTATES_STATES,
  ALL_STATES,
  new Date().getDate(),
  BATCH_SIZE,
);

export interface FetchOSOptions {
  /** Injectable sleep for deterministic tests. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock (ms since epoch) for Retry-After HTTP-date parsing. */
  now?: () => number;
  /** Injectable jitter source in [0,1) for the no-hint 429 wait. Defaults to Math.random. */
  random?: () => number;
  /**
   * Run-scoped latch recording a supplier hour/day quota exhaustion seen
   * earlier in THIS run. Passed by reference down the whole state loop so
   * one definitive 429 stops every later provider request (remaining pages,
   * committees, later states) instead of re-hammering a known-dead window.
   * Never module-level: a fresh object per run keeps the next scheduled run
   * independent.
   */
  quotaExhausted?: { current: 'hour' | 'day' | null };
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Narrow classifier for the supplier's exact 429 detail contract
 * (rate_limiter.py raises RateLimitExceeded(f"exceeded limit of
 * {tier.per_minute}/min: {minute_calls}") etc.; auth.py passes it through
 * as HTTPException(429, detail=str(e))). FastAPI serializes that as
 * {"detail": "..."} — this recognizes ONLY that narrow numeric shape and
 * deliberately nothing else: an unrecognized body is untrusted and must
 * never extend the wait or leak into logs. Exported for unit testing.
 */
export function classifyOpenstatesRateLimitDetail(body: unknown): 'minute' | 'hour' | 'day' | null {
  if (typeof body !== 'object' || body === null) return null;
  const detail = (body as Record<string, unknown>).detail;
  if (typeof detail !== 'string') return null;
  const match = /^exceeded limit of \d+\/(min|hour|day): \d+$/.exec(detail.trim());
  if (!match) return null;
  return match[1] === 'min' ? 'minute' : match[1] === 'hour' ? 'hour' : 'day';
}

/**
 * Read a 429 response body as JSON for classification. Returns undefined
 * for any unreadable/non-JSON/unexpected body — a malformed body is not a
 * fact about the rate window, and the raw text is never retained or logged
 * (it is not part of the trusted contract and could carry anything).
 */
async function readRateLimitBody(resp: Response): Promise<unknown> {
  try {
    return await resp.json();
  } catch {
    return undefined;
  }
}

/**
 * Safe one-line description of a caught fetch/parse error. Network-layer
 * exception messages AND names are attacker-influenceable strings — a
 * thrown object can carry the request URL (with the ?apikey credential) in
 * `name` as easily as in `message`. Only a fixed set of known-safe names
 * is logged; anything else collapses to a generic label. Messages, URLs,
 * and causes are never logged here — this is the single choke point.
 */
const SAFE_ERROR_NAMES = new Set([
  'Error',
  'TypeError',
  'SyntaxError',
  'RangeError',
  'ReferenceError',
  'AbortError',
  'TimeoutError',
  'FetchError',
]);

function safeErrorName(err: unknown): string {
  const name = (err as { name?: unknown })?.name;
  return typeof name === 'string' && SAFE_ERROR_NAMES.has(name) ? name : 'Error';
}

/**
 * Controlled log line for a caught failure. A validated numeric HTTP
 * status (thrown only by this file from resp.status) survives so
 * 401/403/404 stay diagnosable; everything else is the sanitized name
 * only. No URL, raw body, or exception text in either path.
 */
function describeFetchFailure(err: unknown): string {
  const status = (err as { httpStatus?: unknown })?.httpStatus;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) {
    return `HTTP ${status}`;
  }
  return `request failed (${safeErrorName(err)})`;
}

/**
 * Transient supplier/gateway statuses that are safe to retry with bounded
 * backoff: 500 (supplier error), 502/503/504 (gateway/proxy/timeout). Every
 * other status (401/403/404/501/…) is an immediate failure, exactly as before.
 */
function isTransientServerStatus(status: number): boolean {
  return status === 500 || status === 502 || status === 503 || status === 504;
}

/**
 * Parse a Retry-After header value into milliseconds from `nowMs`.
 * Supports both valid forms: delta-seconds and HTTP-date (RFC 9110 §10.2.3).
 * Returns null for missing/invalid/negative values — a malformed hint must
 * never extend or shorten the wait beyond the local backoff policy.
 */
export function parseRetryAfterMs(header: string | null, nowMs: number): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds) ? seconds * 1000 : null;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  const delta = dateMs - nowMs;
  return delta > 0 ? delta : null;
}

async function fetchOS<T>(
  path: string,
  params: Record<string, string | string[]> = {},
  options: FetchOSOptions = {},
): Promise<T | null> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const url = new URL(`${OS_BASE}${path}`);
  url.searchParams.set('apikey', OS_KEY);
  for (const [k, value] of Object.entries(params)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) url.searchParams.append(k, item);
  }
  if (options.quotaExhausted?.current) {
    // A definitive hour/day 429 was already seen in THIS run — the window
    // is known-dead, so make zero further provider requests and let the
    // caller report the unattempted remainder truthfully partial.
    console.warn(
      `GET ${path}: skipped — supplier ${options.quotaExhausted.current}ly quota already exhausted this run`,
    );
    return null;
  }
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Space EVERY attempt (initial + retries) so sustained cadence fits the
    // published default 10/min window — including after a 429 wait.
    await sleep(REQUEST_SPACING_MS);
    let resp: Response;
    try {
      // ONLY the network transport await — a rejection here is the one and
      // only failure eligible for transport retry. Everything below
      // (status/headers/body processing) is response handling instead.
      resp = await fetch(url.toString());
    } catch (err) {
      // Sanitized: network exception messages/names can embed the request
      // URL (and with it the ?apikey credential) — only a known-safe name
      // is ever logged. Bounded exponential retry like transient 5xx; no
      // sleep after the final failed attempt.
      if (attempt === MAX_RETRIES) {
        console.warn(`GET ${path}: request failed (${safeErrorName(err)}), retries exhausted`);
        return null;
      }
      const wait = TRANSIENT_RETRY_EXPONENT_MS * 2 ** attempt;
      console.warn(
        `GET ${path}: request failed (${safeErrorName(err)}), retrying in ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
      );
      await sleep(wait);
      continue;
    }
    try {
      if (isTransientServerStatus(resp.status)) {
        // 500/502/503/504: transient supplier/gateway failures (the 2026-09-16
        // reset run lost OR's committee walk to a single HTTP 504 — no retry
        // existed at all). Retry the SAME request, bounded by MAX_RETRIES, with
        // exponential backoff (13s/26s/52s) — or the full valid Retry-After
        // hint when the supplier provides one. No sleep after the final failed
        // attempt. Other statuses (401/403/404/501/…) stay immediate failures
        // exactly as before.
        if (attempt === MAX_RETRIES) {
          console.warn(`GET ${path}: HTTP ${resp.status} transient failure, retries exhausted`);
          return null;
        }
        const hint = parseRetryAfterMs(resp.headers?.get?.('retry-after') ?? null, now());
        if (hint !== null && hint > 0x7fffffff) {
          console.warn(
            `GET ${path}: HTTP ${resp.status} Retry-After ${hint}ms is unschedulable — deferring`,
          );
          return null;
        }
        const wait =
          hint !== null
            ? Math.max(REQUEST_SPACING_MS, hint)
            : TRANSIENT_RETRY_EXPONENT_MS * 2 ** attempt;
        console.warn(
          `GET ${path}: HTTP ${resp.status} transient failure, retrying in ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
        );
        await sleep(wait);
        continue;
      }
      if (resp.status === 429) {
        // Classify the supplier's narrow numeric detail FIRST, on EVERY 429
        // including the final attempt: a definitive hour/day exhaustion must
        // latch the run-scoped halt no matter which attempt surfaces it —
        // otherwise later resources/states would keep hitting a known-dead
        // window. Only the WINDOW CLASS is used; the raw body and its
        // numbers are never logged (untrusted content, and the contract
        // string is all we trust).
        const rateClass = classifyOpenstatesRateLimitDetail(await readRateLimitBody(resp));
        if (rateClass === 'hour' || rateClass === 'day') {
          // Set the run-scoped latch so every later request in this run
          // (remaining pages, committees, later states) is skipped without
          // a provider call, then defer: partial/failed, reported
          // truthfully downstream.
          if (options.quotaExhausted) options.quotaExhausted.current = rateClass;
          console.warn(
            `GET ${path}: 429 supplier ${rateClass}ly rate limit exhausted — deferring remaining work to a later run`,
          );
          return null;
        }
        if (attempt === MAX_RETRIES) {
          // Retries exhausted: surface the failure WITHOUT sleeping again —
          // the old code slept 30s here and then left the loop without ever
          // making the announced retry (logs showed "attempt 4/3").
          console.warn(`GET ${path}: 429 rate limited, retries exhausted`);
          return null;
        }
        const hint = parseRetryAfterMs(resp.headers?.get?.('retry-after') ?? null, now());
        if (hint !== null && hint > 0x7fffffff) {
          console.warn(`GET ${path}: 429 Retry-After ${hint}ms is unschedulable — deferring`);
          return null;
        }
        // Wait selection, in priority order:
        //  1. A VALID provider Retry-After is honored in full, subject only
        //     to the normal request-spacing floor — retrying sooner just
        //     earns another 429 (the old code capped the hint at 30s, so a
        //     120s Retry-After was retried at 30/60/90s and exhausted
        //     before the provider's deadline). A valid 45s hint waits 45s,
        //     NOT the 60s no-hint fallback.
        //  2. No valid hint: the supplier's minute counter is a FIXED
        //     calendar-minute window, so wait a full minute + jitter to
        //     guarantee the retry lands in a NEW window (the old 4/8/16s
        //     exponential could burn all retries inside one window). This
        //     covers both a classified minute detail and an absent/
        //     unrecognized body — the only published tier window short
        //     enough to retry inside one run is the minute.
        const wait =
          hint !== null
            ? Math.max(REQUEST_SPACING_MS, hint)
            : NO_HINT_429_WAIT_MS + Math.floor(random() * NO_HINT_429_JITTER_MS);
        console.warn(
          `GET ${path}: 429 rate limited, retrying in ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES})`,
        );
        await sleep(wait);
        continue;
      }
      if (!resp.ok) {
        // Controlled carrier for the validated numeric status — see
        // describeFetchFailure. resp.status is a number per the fetch
        // contract; it is re-validated there before logging.
        const err = new Error(`HTTP ${resp.status}`) as Error & { httpStatus: number };
        err.httpStatus = resp.status;
        throw err;
      }
      return (await resp.json()) as T;
    } catch (err) {
      // Response-processing failure only (the transport await has its own
      // catch above): a thrown httpStatus carrier (401/403/404/…) or a
      // resp.json() parse failure. NEVER retried — an immediate, sanitized
      // failure. Network exception messages/names can embed the request URL
      // (and with it the ?apikey credential), so only the controlled HTTP
      // status or a known-safe error name is ever logged.
      console.warn(`GET ${path}: ${describeFetchFailure(err)}`);
      return null;
    }
  }
  return null;
}

export interface PagedFetchResult<T> {
  rows: T[];
  /** False when a page failed (fetchOS exhausted retries and returned null) —
   *  the walk stopped early with INCOMPLETE data, not a genuine end-of-results.
   *  Callers that overwrite a DB column from this result must treat `false` as
   *  "unknown", never as "confirmed empty" (PD2 — a fetch failure is not a
   *  fact about the state's real committee roster). */
  complete: boolean;
}

export interface FetchAllPagesOptions extends FetchOSOptions {}

/**
 * Page through an OpenStates v3 list endpoint at the API's max page size.
 * OpenStates rejects per_page>20 with HTTP 400, so we request PER_PAGE rows and
 * walk pages up to maxPages (or the reported max_page). A failed page (fetchOS
 * exhausted retries) ends the walk with `complete: false` and whatever rows were
 * collected so far — distinct from a legitimate empty/final page, which ends the
 * walk with `complete: true`. Exhausting the LOCAL maxPages ceiling while the
 * provider reports more pages (pagination.max_page beyond the pages fetched)
 * is also `complete: false`: a truncated tail is not end-of-results.
 */
export async function fetchAllPages<T>(
  path: string,
  params: Record<string, string | string[]> = {},
  maxPages: number = MAX_PAGES,
  options: FetchAllPagesOptions = {},
): Promise<PagedFetchResult<T>> {
  const all: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    // fetchOS spaces every attempt itself (REQUEST_SPACING_MS), so the walk
    // no longer needs its own pre-page delay — that old 2000ms sleep was
    // the cadence that ran 3x over the published default 10/min window.
    const resp = await fetchOS<{ results: T[]; pagination?: { max_page?: number } }>(
      path,
      {
        ...params,
        per_page: String(PER_PAGE),
        page: String(page),
      },
      options,
    );
    if (resp === null) return { rows: all, complete: false };
    const rows = resp.results ?? [];
    if (!rows.length) return { rows: all, complete: true };
    all.push(...rows);
    const maxPage = resp.pagination?.max_page ?? page;
    if (page >= maxPage) return { rows: all, complete: true };
    if (page === maxPages) {
      // Local ceiling hit with provider pages still unfetched — the tail was
      // truncated by OUR cap, not by the source running out of rows.
      return { rows: all, complete: false };
    }
  }
  return { rows: all, complete: true };
}

// ── Committee membership (OpenStates `/committees?include=memberships`) ────
// The `Committee` object itself carries no chamber field (only `classification`
// and `parent_id`, per the live openapi.json) — chamber attribution for the
// roster stays in normalize-state-committees.ts, taken from the LEGISLATOR's
// own `chamber` (state_legislator.chamber), same as before this fix. This file
// only owns the person -> [{name, role}] inversion.

export interface OpenstatesCompactPerson {
  id: string;
  name?: string;
}

export interface OpenstatesCommitteeMembership {
  person_name: string;
  role?: string | null;
  person?: OpenstatesCompactPerson | null;
}

export interface OpenstatesLink {
  url: string;
  note?: string | null;
}

export interface OpenstatesCommittee {
  id: string;
  name: string;
  classification?: string;
  parent_id?: string | null;
  extras?: Record<string, unknown> | null;
  links?: OpenstatesLink[] | null;
  sources?: OpenstatesLink[] | null;
  memberships?: OpenstatesCommitteeMembership[] | null;
}

export interface OpenstatesCommitteeEntry {
  name: string;
  role: string | null;
  openstates: {
    id: string;
    classification: string | null;
    parentId: string | null;
    links: OpenstatesLink[];
    sources: OpenstatesLink[];
    extras: Record<string, unknown>;
  };
}

export interface InvertCommitteesResult {
  /** OpenStates person id -> that person's committee assignments. */
  committeesByPerson: Map<string, OpenstatesCommitteeEntry[]>;
  /** Memberships with no resolvable `person.id` — real assignments OpenStates
   *  only carries as free text, dropped rather than name-matched (PD2). */
  unlinkedCount: number;
}

/**
 * Invert a `/committees?include=memberships` page set into a per-person
 * committee list, matching the `StateLegislator.committees` Json shape
 * (`[{name, role}]`) that normalize-state-committees.ts already consumes.
 */
export function invertOpenstatesCommittees(
  committees: OpenstatesCommittee[],
): InvertCommitteesResult {
  const committeesByPerson = new Map<string, OpenstatesCommitteeEntry[]>();
  let unlinkedCount = 0;
  for (const committee of committees) {
    for (const membership of committee.memberships ?? []) {
      const personId = membership.person?.id;
      if (!personId) {
        unlinkedCount++;
        continue;
      }
      const entries = committeesByPerson.get(personId) ?? [];
      entries.push({
        name: committee.name,
        role: membership.role ?? null,
        openstates: {
          id: committee.id,
          classification: committee.classification ?? null,
          parentId: committee.parent_id ?? null,
          links: committee.links ?? [],
          sources: committee.sources ?? [],
          extras: committee.extras ?? {},
        },
      });
      committeesByPerson.set(personId, entries);
    }
  }
  return { committeesByPerson, unlinkedCount };
}

/**
 * Per-state source outcome from the two OpenStates fetches, aggregated into
 * the run-level counts main() returns. Pure + exported for unit testing.
 * `peoplePartial`/`committeesPartial` are row counts written from incomplete
 * page walks; they stay visible instead of masquerading as a clean success.
 */
export interface OpenstatesStateOutcome {
  peopleFetched: number;
  peopleComplete: boolean;
  committeesComplete: boolean;
  /** False when committees were never attempted this run (people fetch
   *  already failed, or a definitive supplier quota halt) — distinct from
   *  "fetched and confirmed empty", so existing membership data must be
   *  left untouched. Undefined/true means the committees walk ran. */
  committeesAttempted?: boolean;
}

export function aggregateStateOutcomes(states: OpenstatesStateOutcome[]): {
  inserted: number;
  updated: number;
  skipped: number;
  errors: number;
  complete: boolean;
  incompleteReason?: string;
  errorMessage?: string;
} {
  const inserted = states.reduce((n, s) => n + s.peopleFetched, 0);
  const incomplete = states.filter(
    (s) => !s.peopleComplete || !s.committeesComplete || s.committeesAttempted === false,
  );
  if (!incomplete.length) {
    return { inserted, updated: 0, skipped: 0, errors: 0, complete: true };
  }
  const peopleFailed = incomplete.filter((s) => !s.peopleComplete).length;
  const committeesFailed = incomplete.filter(
    (s) => !s.committeesComplete || s.committeesAttempted === false,
  ).length;
  const parts: string[] = [];
  if (peopleFailed) parts.push(`${peopleFailed} state(s) with incomplete people pages`);
  if (committeesFailed) parts.push(`${committeesFailed} state(s) with incomplete committee pages`);
  const reason = parts.join('; ');
  return {
    inserted,
    updated: 0,
    skipped: 0,
    errors: incomplete.length,
    complete: false,
    incompleteReason: reason,
    errorMessage: reason,
  };
}

export interface OpenstatesSyncDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

/**
 * The sync body, exported for runtime-level tests with mocked fetch/prisma.
 * main() only wires process.env + a real PrismaClient into this.
 */
export async function runOpenstatesSync(
  prisma: {
    stateLegislator: { upsert(args: unknown): Promise<unknown> };
    entityCrosswalk: { upsert(args: unknown): Promise<unknown> };
  },
  states: string[],
  deps: OpenstatesSyncDeps = {},
): Promise<{
  inserted: number;
  updated: number;
  skipped: number;
  errors: number;
  complete: boolean;
  incompleteReason?: string;
  errorMessage?: string;
}> {
  const t0 = Date.now();
  // Run-scoped (never module-level) latch: one definitive supplier hour/day
  // 429 halts every later provider request in THIS run; the next scheduled
  // run starts clean.
  const fetchOptions: FetchOSOptions = {
    sleep: deps.sleep,
    now: deps.now,
    random: deps.random,
    quotaExhausted: { current: null },
  };
  let totalPeople = 0;
  const outcomes: OpenstatesStateOutcome[] = [];

  for (const state of states) {
    // Fetch current legislators — fully paged (PEOPLE_MAX_PAGES), since every
    // priority state has >100 members and a truncated roster means missing
    // legislators that can never be crosswalked to their bills. Rows already
    // fetched before a failed page are still real data and are upserted below
    // (incremental people behavior), but the state is NOT complete.
    const { rows: peopleList, complete: peopleComplete } = await fetchAllPages<any>(
      '/people',
      { jurisdiction: state },
      PEOPLE_MAX_PAGES,
      fetchOptions,
    );

    let committeesComplete = true;
    let committeesAttempted = true;
    if (!peopleComplete) {
      console.warn(
        `[openstates-sync] ${state.toUpperCase()} people fetch incomplete after ` +
          `retries — ${peopleList.length} partial rows kept; source run will be partial`,
      );
    }

    if (peopleList.length && !fetchOptions.quotaExhausted?.current) {
      // Fetch committee rosters for the same state and invert to person -> committees,
      // so each legislator upsert below can attach their real assignments.
      const committeesPage = await fetchAllPages<OpenstatesCommittee>(
        '/committees',
        {
          jurisdiction: state,
          // FastAPI's list parameter requires repeated include keys. Retain
          // provider identity/provenance as well as the roster so the state
          // committee room can link to the official source and describe the
          // committee/subcommittee hierarchy OpenStates actually published.
          include: ['memberships', 'links', 'sources'],
        },
        COMMITTEE_MAX_PAGES,
        fetchOptions,
      );
      const committeesList = committeesPage.rows;
      committeesComplete = committeesPage.complete;
      const { committeesByPerson, unlinkedCount } = invertOpenstatesCommittees(committeesList);
      if (committeesList.length) {
        const linkedCount = [...committeesByPerson.values()].reduce((n, l) => n + l.length, 0);
        console.log(
          `[openstates-sync] ${state.toUpperCase()} committees: ${committeesList.length} ` +
            `(${linkedCount} memberships linked, ${unlinkedCount} unlinked — no resolvable person)`,
        );
      }
      if (!committeesComplete) {
        // The /committees walk failed part-way through (fetchOS exhausted retries).
        // committeesByPerson is not a trustworthy picture of "this state has no/fewer
        // committees" — writing it would overwrite already-correct existing
        // state_legislator.committees with a false negative. Leave existing rows'
        // committees untouched this run; only a brand-new legislator (create path,
        // nothing to overwrite) gets whatever partial data we did collect.
        console.warn(
          `[openstates-sync] ${state.toUpperCase()} committees fetch incomplete after ` +
            `retries — leaving existing state_legislator.committees untouched this run`,
        );
      }

      for (const p of peopleList) {
        const currentRole = p.current_role;
        const committees = (committeesByPerson.get(p.id) ?? []) as unknown as Prisma.InputJsonValue;
        await prisma.stateLegislator.upsert({
          where: { id: p.id },
          update: {
            name: p.name,
            state: state.toUpperCase(),
            chamber: currentRole?.org_classification || null,
            district: currentRole?.district?.toString() || null,
            party: p.party || null,
            email: p.email || null,
            image: p.image || null,
            url: p.openstates_url || null,
            ...(committeesComplete ? { committees } : {}),
            active: true,
            syncedAt: new Date(),
          },
          create: {
            id: p.id,
            name: p.name,
            state: state.toUpperCase(),
            chamber: currentRole?.org_classification || null,
            district: currentRole?.district?.toString() || null,
            party: p.party || null,
            email: p.email || null,
            image: p.image || null,
            url: p.openstates_url || null,
            committees,
          },
        });
        await prisma.entityCrosswalk.upsert({
          where: { idType_idValue: { idType: 'openstates_person', idValue: p.id } },
          create: {
            idType: 'openstates_person',
            idValue: p.id,
            entityType: 'state_legislator',
            entityKey: p.id,
            source: 'sync-openstates',
          },
          update: { entityKey: p.id, source: 'sync-openstates' },
        });
        totalPeople++;
      }
      console.log(`[openstates-sync] ${state.toUpperCase()} legislators: ${peopleList.length}`);
    } else if (peopleList.length) {
      // People rows exist but committees were never attempted: a definitive
      // supplier hour/day 429 halted the run first. Upsert the authentic
      // people rows WITHOUT touching the committees column (no `committees`
      // key in update — existing memberships are preserved, never wiped),
      // and mark the state's committee half truthfully unattempted/partial.
      committeesAttempted = false;
      console.warn(
        `[openstates-sync] ${state.toUpperCase()} committees not attempted — supplier ` +
          `${fetchOptions.quotaExhausted?.current}ly quota exhausted; ` +
          `${peopleList.length} authentic people rows upserted without touching committees`,
      );
      for (const p of peopleList) {
        const currentRole = p.current_role;
        await prisma.stateLegislator.upsert({
          where: { id: p.id },
          update: {
            name: p.name,
            state: state.toUpperCase(),
            chamber: currentRole?.org_classification || null,
            district: currentRole?.district?.toString() || null,
            party: p.party || null,
            email: p.email || null,
            image: p.image || null,
            url: p.openstates_url || null,
            active: true,
            syncedAt: new Date(),
          },
          create: {
            id: p.id,
            name: p.name,
            state: state.toUpperCase(),
            chamber: currentRole?.org_classification || null,
            district: currentRole?.district?.toString() || null,
            party: p.party || null,
            email: p.email || null,
            image: p.image || null,
            url: p.openstates_url || null,
            committees: [] as unknown as Prisma.InputJsonValue,
          },
        });
        await prisma.entityCrosswalk.upsert({
          where: { idType_idValue: { idType: 'openstates_person', idValue: p.id } },
          create: {
            idType: 'openstates_person',
            idValue: p.id,
            entityType: 'state_legislator',
            entityKey: p.id,
            source: 'sync-openstates',
          },
          update: { entityKey: p.id, source: 'sync-openstates' },
        });
        totalPeople++;
      }
      console.log(`[openstates-sync] ${state.toUpperCase()} legislators: ${peopleList.length}`);
    } else {
      // No people rows at all. Committees were never attempted — but the
      // meaning splits on whether the people walk itself FINISHED:
      //  - peopleComplete: an authenticated, successful, genuinely empty
      //    roster (real 200 with zero results). That is the pre-existing
      //    legitimate-empty success: no writes, no partial flag.
      //  - !peopleComplete: the walk failed before any row arrived (or a
      //    definitive quota halt pre-empted it). Zero rows here is NOT a
      //    fact about the state's roster — the unattempted committee half
      //    is truthfully partial too.
      committeesAttempted = peopleComplete;
    }

    outcomes.push({
      peopleFetched: peopleList.length,
      peopleComplete,
      committeesComplete,
      committeesAttempted,
    });

    if (fetchOptions.quotaExhausted?.current) {
      // Definitive supplier quota halt: every later state is UNATTEMPTED —
      // record it truthfully partial (zero rows is not a successful empty
      // fetch) and make zero further provider requests.
      const halted = fetchOptions.quotaExhausted.current;
      for (const skipped of states.slice(states.indexOf(state) + 1)) {
        console.warn(
          `[openstates-sync] ${skipped.toUpperCase()} skipped — supplier ${halted}ly quota exhausted`,
        );
        outcomes.push({
          peopleFetched: 0,
          peopleComplete: false,
          committeesComplete: false,
          committeesAttempted: false,
        });
      }
      break;
    }
  }

  console.log(`[openstates-sync] total: ${totalPeople} legislators`);
  console.log(`[openstates-sync] DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const counts = aggregateStateOutcomes(outcomes);
  if (!counts.complete) {
    console.warn(`[openstates-sync] run INCOMPLETE: ${counts.incompleteReason}`);
  }
  return counts;
}

async function main() {
  const prisma = new PrismaClient();
  console.log('[openstates-sync] starting');
  console.log(
    `[openstates-sync] states (${process.env.OPENSTATES_STATES ? 'OPENSTATES_STATES override' : 'day-of-month batch'}): ${PRIORITY_STATES.map((s) => s.toUpperCase()).join(', ')}`,
  );
  if (!OS_KEY) throw new Error('OPENSTATES_API_KEY env var is required');

  try {
    await runWithSyncRun(prisma as never, 'sync-openstates', async () =>
      runOpenstatesSync(prisma as never, PRIORITY_STATES),
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[openstates-sync] FAILED', err);
    process.exit(1);
  });
}
