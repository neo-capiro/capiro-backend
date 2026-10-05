/**
 * Derive + persist the canonical state_bill.status (State Legislation
 * Platform Phase 0 S3). Second consumer of derive-bill-status.ts's pattern,
 * one abstraction up — state legislatures have no House-rule mechanic, so
 * this feeds three different signals into `deriveStateBillStatus`:
 *   - the bill's own legiscanStatus/legiscanProgress (LegiScan's coded facts,
 *     persisted verbatim at ingestion time — the derivation spine, DD8),
 *   - whether a real chamber-passage vote (state_roll_call_vote, classified
 *     via classifyStateVoteMotion) passed or failed THIS bill,
 *   - the bill's session sine_die date (state_session) for dead_by_deadline.
 * Text-regex (latestActionText, vetoed/overridden fallback) is used ONLY as a
 * fallback signal alongside the coded facts — never the primary source.
 *
 * Runs unconditionally over every state_bill (pure DB compute, no external
 * API cost — unlike the LegiScan sync verbs there is no quota reason to scope
 * this to LEGISCAN_STATES). The bill scan is cursor-paginated (BATCH_SIZE) so
 * peak memory stays bounded regardless of corpus size — a single unbounded
 * findMany() over 100k+ rows (each carrying a jsonb progress array and full
 * action text) would otherwise scale memory with the whole corpus.
 *
 *   pnpm --filter @capiro/api exec tsx scripts/derive-state-bill-status.ts
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { deriveStateBillStatus, classifyStateVoteMotion, stateBillReplacement } from '@capiro/shared';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
dotenvConfig();

const prisma = new PrismaClient();

const BATCH_SIZE = 5000;

// Fallback ONLY — the coded facts (legiscanStatus 5, progress event 7) are
// the primary vetoed/overridden signals; these regexes catch the rare case
// where a state's LegiScan feed doesn't carry the coded fact cleanly.
const VETOED_TEXT = /vetoed by the governor|governor'?s? veto/i;
const OVERRIDDEN_TEXT = /veto overridden|override(d)? the (governor'?s )?veto/i;

export interface PassageVoteInput {
  billKey: string | null;
  motion: string | null;
  passed: boolean | null;
  date: Date | null;
  legiscanRollCallId: number;
}

export interface PassageOutcome {
  passed: boolean;
  date: Date | null;
  legiscanRollCallId: number;
}

/**
 * Build the (passedChamber, failedChamber) sets from every classified
 * passage-type roll-call vote, keyed by each bill's MOST RECENT such vote
 * (by date, then legiscanRollCallId as a deterministic tiebreak for
 * same-day votes) — never "any qualifying vote ever," which let a bill land
 * in BOTH sets when it failed a floor vote and was later reconsidered and
 * passed (the failed/passed inversion bug: a stale failed-vote signal
 * outranked the bill's actual current state). A bill therefore appears in
 * AT MOST ONE of the two returned sets, reflecting only its latest passage
 * verdict.
 */
export function buildPassageOutcomeSets(votes: PassageVoteInput[]): {
  passedChamber: Set<string>;
  failedChamber: Set<string>;
  latestByBill: Map<string, PassageOutcome>;
} {
  const latestByBill = new Map<string, PassageOutcome>();
  for (const v of votes) {
    if (!v.billKey || v.passed === null || !classifyStateVoteMotion(v.motion)) continue;
    const prev = latestByBill.get(v.billKey);
    const currentTime = v.date?.getTime() ?? Number.NEGATIVE_INFINITY;
    const previousTime = prev?.date?.getTime() ?? Number.NEGATIVE_INFINITY;
    const isNewer =
      !prev ||
      currentTime > previousTime ||
      (currentTime === previousTime && v.legiscanRollCallId > prev.legiscanRollCallId);
    if (isNewer) {
      latestByBill.set(v.billKey, {
        passed: v.passed,
        date: v.date,
        legiscanRollCallId: v.legiscanRollCallId,
      });
    }
  }
  const passedChamber = new Set<string>();
  const failedChamber = new Set<string>();
  for (const [billKey, outcome] of latestByBill) {
    if (outcome.passed) passedChamber.add(billKey);
    else failedChamber.add(billKey);
  }
  return { passedChamber, failedChamber, latestByBill };
}

/** DD1 join key for a bill's session (state_session is keyed the same way). */
export function sineDieKey(state: string, sessionKey: string): string {
  return `${state}-${sessionKey}`;
}

export interface StatusUpdateData {
  status: string;
  statusAt: Date | null;
  statusSource: 'derived';
  statusDerivedAt: Date;
}

export interface StateStatusActionEvidence {
  date: Date;
  text: string;
  orderKey?: number;
}

export interface StateStatusDateInput {
  status: string;
  progressEvents?: Array<{ event: number; date: string }> | null;
  actions?: StateStatusActionEvidence[] | null;
  latestActionDate?: Date | null;
  latestActionText?: string | null;
  passageVoteDate?: Date | null;
  sessionSineDie?: string | null;
}

/**
 * Strictly parse LegiScan's date-only facts. `new Date(raw)` is intentionally
 * not used: it accepts rollover dates such as 2025-02-30 and would manufacture
 * a plausible-looking legislative date from malformed provider evidence.
 */
function parseEvidenceDate(raw: string | null | undefined): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec((raw ?? '').trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date
    : null;
}

const STATUS_PROGRESS_EVENTS: Readonly<Record<string, readonly number[]>> = {
  introduced: [1],
  passed_chamber: [2],
  to_governor: [3],
  enacted: [4, 8],
  vetoed: [5],
  failed: [6, 11],
  veto_overridden: [7],
  committee: [9],
  reported: [10],
};

function actionEstablishesStatus(status: string, text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  switch (status) {
    case 'superseded':
      return stateBillReplacement(value) !== null;
    case 'enacted':
      return /\b(chaptered|enacted|became law|signed by (?:the )?governor|governor (?:signed|approved))\b/i.test(
        value,
      );
    case 'veto_overridden':
      return OVERRIDDEN_TEXT.test(value);
    case 'vetoed':
      return VETOED_TEXT.test(value) && !OVERRIDDEN_TEXT.test(value);
    case 'failed':
      return /\b(failed (?:final )?passage|did not pass|defeated|report(?:ed)? do not pass)\b/i.test(
        value,
      );
    case 'to_governor':
      return (
        /\benrolled\b/i.test(value) ||
        /\b(sent|transmitted|presented|delivered)\b.*\b(governor|executive)\b/i.test(value)
      );
    case 'resolving':
      return /amendments? (?:between|from)|\bconcur|conference committee|refuse[sd] to concur/i.test(
        value,
      );
    case 'passed_chamber':
      return (
        !/\b(fail|defeat|not pass|committee|amendment|motion)\b/i.test(value) &&
        /(?:\bpassed\b|\badopted\b).*(?:\bhouse\b|\bsenate\b|\bassembly\b|\bchamber\b|third reading|final passage|on passage)|(?:\bhouse\b|\bsenate\b|\bassembly\b).*\bpassed\b/i.test(
          value,
        )
      );
    case 'reported':
      return /reported (?:favorably|out of committee)|\bdo pass\b/i.test(value);
    case 'committee':
      return /referred|committee|hearing|markup/i.test(value);
    case 'floor':
      return /calendar|second reading|third reading|floor/i.test(value);
    case 'introduced':
      return /\b(?:introduced|prefiled|filed|first reading)\b/i.test(value);
    default:
      return false;
  }
}

function latestDate(dates: Array<Date | null | undefined>): Date | null {
  let latest: Date | null = null;
  for (const date of dates) {
    if (!date || Number.isNaN(date.getTime())) continue;
    if (!latest || date.getTime() > latest.getTime()) latest = date;
  }
  return latest;
}

/** Nullable date equality for historical statusAt repair. */
export function statusDateNeedsRepair(next: Date | null, current: Date | null): boolean {
  return (next?.getTime() ?? null) !== (current?.getTime() ?? null);
}

/**
 * Resolve the date of the fact that established the derived canonical state.
 * Evidence is deliberately status-specific: a later receiving-chamber
 * referral must not move a passed-origin-chamber date forward. When the feed
 * carries only a coded status and no dated progress/action/vote fact, return
 * null instead of inventing a date from ingestion time or bill text metadata.
 */
export function deriveStateStatusAt(input: StateStatusDateInput): Date | null {
  if (input.status === 'dead_by_deadline') return parseEvidenceDate(input.sessionSineDie);

  const progressEventSet = new Set(STATUS_PROGRESS_EVENTS[input.status] ?? []);
  const progressDates = (input.progressEvents ?? [])
    .filter((event) => progressEventSet.has(event.event))
    .map((event) => parseEvidenceDate(event.date));
  const actionDates = (input.actions ?? [])
    .filter((action) => actionEstablishesStatus(input.status, action.text))
    .map((action) => action.date);
  const latestActionDate = actionEstablishesStatus(
    input.status,
    input.latestActionText ?? '',
  )
    ? input.latestActionDate
    : null;
  // A classified passage vote is the strongest evidence for the
  // passed-origin-chamber state. Do not let a later receiving-chamber action
  // that merely recites the earlier passage move the transition date.
  if (input.status === 'passed_chamber') {
    const passageDate = latestDate([input.passageVoteDate]);
    if (passageDate) return passageDate;
  }
  const progressDate = latestDate(progressDates);
  if (progressDate) return progressDate;
  if (input.status === 'failed') {
    const failedVoteDate = latestDate([input.passageVoteDate]);
    if (failedVoteDate) return failedVoteDate;
  }
  return latestDate([...actionDates, latestActionDate]);
}

/**
 * Build the update payload for a bill whose derived status changed. Pure and
 * exported so the statusDerivedAt stamp (2026-07-10 hot-fix, S5.3) is
 * directly testable without a DB. `now` is injectable for deterministic
 * tests; production calls always pass the real current time.
 */
export function buildStatusUpdateData(
  bill: { latestActionDate: Date | null; textDate: Date | null },
  status: string,
  now: Date = new Date(),
  statusAt: Date | null = null,
): StatusUpdateData {
  return {
    status,
    // `latestActionDate`, `textDate`, and `now` are not necessarily the date
    // on which this status was established. Keep the date unknown unless the
    // caller supplies status-specific legislative evidence.
    statusAt,
    statusSource: 'derived',
    // Ingestion-time anchor, distinct from statusAt's legislative event
    // date, so emit-state-changes can window on when the change was
    // actually WRITTEN rather than the (often-midnight, often-stale-
    // relative-to-a-same-day-run) legislative date.
    statusDerivedAt: now,
  };
}

async function main() {
  await runWithSyncRun(prisma as never, 'derive-state-bill-status', async () => {
    let updated = 0;
    let skipped = 0;
    let errors = 0;

    // 1. Passage/veto sets from state_roll_call_vote — each bill's MOST
    // RECENT real passage-type motion outcome (S3 hot-fix: mutual exclusivity).
    const votes = await prisma.stateRollCallVote.findMany({
      where: { passed: { not: null }, billKey: { not: null } },
      select: { billKey: true, motion: true, passed: true, date: true, legiscanRollCallId: true },
    });
    const { passedChamber, failedChamber, latestByBill } = buildPassageOutcomeSets(votes);

    // 2. Session sine-die map, keyed by (state, sessionKey) — the DD1 join.
    const sessions = await prisma.stateSession.findMany({
      where: { sineDie: { not: null } },
      select: { state: true, sessionKey: true, sineDie: true },
    });
    const sineDieByKey = new Map<string, string>();
    for (const s of sessions) {
      if (s.sineDie) {
        sineDieByKey.set(sineDieKey(s.state, s.sessionKey), s.sineDie.toISOString().slice(0, 10));
      }
    }

    // 3. Recompute every bill in bounded batches; write ONLY when the status
    // actually changes (unlike the federal verb's unconditional rewrite —
    // 100k+ state rows make no-op writes worth skipping; deviation noted in
    // the Phase 0 plan).
    const today = new Date().toISOString().slice(0, 10);
    let lastId: string | undefined;
    for (;;) {
      const bills = await prisma.stateBill.findMany({
        take: BATCH_SIZE,
        ...(lastId ? { cursor: { id: lastId }, skip: 1 } : {}),
        orderBy: { id: 'asc' },
        select: {
          id: true,
          state: true,
          sessionKey: true,
          status: true,
          legiscanStatus: true,
          legiscanProgress: true,
          latestActionText: true,
          latestActionDate: true,
          textDate: true,
          statusAt: true,
          actions: {
            select: { date: true, text: true, orderKey: true },
          },
        },
      });
      if (bills.length === 0) break;

      for (const b of bills) {
        try {
          const progressEvents = Array.isArray(b.legiscanProgress)
            ? (b.legiscanProgress as unknown as Array<{ event: number; date: string }>)
            : [];
          const text = b.latestActionText ?? '';
          const res = deriveStateBillStatus({
            legiscanStatus: b.legiscanStatus,
            progressEvents,
            latestActionText: text,
            passedChamber: passedChamber.has(b.id),
            failedChamber: failedChamber.has(b.id),
            vetoed: VETOED_TEXT.test(text),
            overridden: OVERRIDDEN_TEXT.test(text),
            sessionSineDie: sineDieByKey.get(sineDieKey(b.state, b.sessionKey)) ?? null,
            today,
          });
          const passageOutcome = latestByBill.get(b.id);
          const statusAt = deriveStateStatusAt({
            status: res.status,
            progressEvents,
            actions: b.actions,
            latestActionDate: b.latestActionDate,
            latestActionText: b.latestActionText,
            passageVoteDate: passageOutcome?.date ?? null,
            sessionSineDie: sineDieByKey.get(sineDieKey(b.state, b.sessionKey)) ?? null,
          });
          const statusChanged = res.status !== b.status;
          // Null is meaningful: the fail-closed resolver must be able to clear
          // a legacy date that was manufactured from latestAction/textDate/now.
          const statusDateChanged = statusDateNeedsRepair(statusAt, b.statusAt);
          if (!statusChanged && !statusDateChanged) {
            skipped++;
            continue;
          }
          await prisma.stateBill.update({
            where: { id: b.id },
            data: statusChanged
              ? buildStatusUpdateData(b, res.status, new Date(), statusAt)
              : {
                  // Historical date repair only: do not advance
                  // statusDerivedAt and emit a false state-change alert when
                  // the canonical status itself did not change.
                  statusAt,
                  statusSource: 'derived',
                },
          });
          updated++;
        } catch (err) {
          errors++;
          console.error(`[derive-state-bill-status] ${b.id} failed:`, err);
        }
      }
      lastId = bills[bills.length - 1]!.id;
    }
    console.log(
      `[derive-state-bill-status] ${updated} updated, ${skipped} unchanged, ${passedChamber.size} passed-chamber sets, ${failedChamber.size} failed-chamber sets, ${errors} errors`,
    );
    return { inserted: 0, updated, skipped, errors };
  });
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error(e);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
