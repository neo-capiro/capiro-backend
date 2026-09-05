/**
 * LegiWatch V2 Wave 2 (W2-4) — the backtest matcher.
 *
 * Five ENUMERATED condition types, each mapped to a real, existing, timestamped
 * canonical table. There is no expression language: a caller cannot ask this
 * module to evaluate anything it does not already know how to run as a plain,
 * parameterized, bounded SQL query.
 *
 *   KEYWORD_MATCH          bill | hearing | regulation | program_element | state_bill
 *   STATUS_CHANGE          bill | state_bill | hearing
 *   FUNDING_MOVEMENT       program_element only
 *   HEARING_SCHEDULED      hearing only
 *   CLIENT_RELEVANCE_HIGH  requires the preset to name at least one client
 *
 * Every query is READ-ONLY (`$queryRawUnsafe` with a plain `SELECT`; nothing
 * in this file ever calls `$executeRaw*`). Grepping this file for a write
 * verb should find none — that grep is exactly what the no-side-effect test
 * asserts.
 *
 * ── UNSUPPORTED, never a fabricated zero ──
 *
 * `FUNDING_MOVEMENT` is the one condition where the naive approach (checking
 * `program_element_year.last_synced_at`) would produce a plausible-looking but
 * WRONG answer: that column is a sync timestamp, not a value-changed
 * timestamp, so a PE that hasn't moved in years but was just re-synced would
 * look like it "moved." The real signal is `ProgramElementDelta.computedAt` —
 * a genuine timestamped record of a computed funding change, with
 * `materialityScore`/`deltaPct`/`explanation` already attached as evidence.
 * Every condition here is deliberately matched to a column with an actual
 * "this happened at this time" meaning; where a family/condition combination
 * has no such column (there is none in this schema), `evaluate()` returns
 * `supported: false` with a `reason` — never a zero-match result that reads
 * as "nothing happened."
 */
import type { PrismaService } from '../prisma/prisma.service.js';
import { RELEVANCE_BAND_FLOORS } from './legiwatch-wave1-relevance.js';

export const SIGNAL_FAMILIES = [
  'bill',
  'hearing',
  'regulation',
  'program_element',
  'state_bill',
] as const;
export type SignalFamily = (typeof SIGNAL_FAMILIES)[number];

export const CONDITION_TYPES = [
  'KEYWORD_MATCH',
  'STATUS_CHANGE',
  'FUNDING_MOVEMENT',
  'HEARING_SCHEDULED',
  'CLIENT_RELEVANCE_HIGH',
] as const;
export type ConditionType = (typeof CONDITION_TYPES)[number];

export interface WatchCondition {
  type: ConditionType;
  family?: SignalFamily;
  keyword?: string;
  committeeSystemCode?: string;
  minMaterialityScore?: number;
}

export interface SampleMatch {
  packetId: string;
  canonicalObject: { kind: SignalFamily; id: string; label: string; detailPath: string | null };
  occurredAt: string;
  reasonCodes: string[];
  matchedConditions: string[];
  evidence: string | null;
}

export interface ConditionOutcome {
  condition: WatchCondition;
  supported: boolean;
  reason: string | null;
  matched: number;
  samples: SampleMatch[];
}

/** Bounded per condition — a preview, never a full export. */
const MAX_SAMPLES_PER_CONDITION = 10;
/** The current shape of this matcher's output. Bump on any behavior change. */
export const BACKTEST_QUERY_VERSION = 'w2-backtest-v1';

function likeParam(keyword: string): string {
  return `%${keyword.replace(/[%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Evaluate one condition against real historical data in `[from, to)`.
 *
 * `tenantId` scopes CLIENT_RELEVANCE_HIGH only — every other condition reads
 * GLOBAL public-record tables and takes no tenant parameter at all, so it
 * cannot leak tenant-private data even by accident.
 */
export async function evaluateCondition(
  prisma: PrismaService,
  condition: WatchCondition,
  window: { from: Date; to: Date },
  scope: { tenantId: string; clientIds: string[] },
): Promise<ConditionOutcome> {
  switch (condition.type) {
    case 'KEYWORD_MATCH':
      return evaluateKeywordMatch(prisma, condition, window);
    case 'STATUS_CHANGE':
      return evaluateStatusChange(prisma, condition, window);
    case 'FUNDING_MOVEMENT':
      return evaluateFundingMovement(prisma, condition, window);
    case 'HEARING_SCHEDULED':
      return evaluateHearingScheduled(prisma, condition, window);
    case 'CLIENT_RELEVANCE_HIGH':
      return evaluateClientRelevanceHigh(prisma, condition, window, scope);
    default:
      return unsupported(condition, `Unknown condition type "${(condition as { type: string }).type}".`);
  }
}

function unsupported(condition: WatchCondition, reason: string): ConditionOutcome {
  return { condition, supported: false, reason, matched: 0, samples: [] };
}

function ok(condition: WatchCondition, rows: SampleMatch[], total: number): ConditionOutcome {
  return { condition, supported: true, reason: null, matched: total, samples: rows.slice(0, MAX_SAMPLES_PER_CONDITION) };
}

async function evaluateKeywordMatch(
  prisma: PrismaService,
  condition: WatchCondition,
  window: { from: Date; to: Date },
): Promise<ConditionOutcome> {
  if (!condition.family) return unsupported(condition, 'KEYWORD_MATCH requires a signal family.');
  if (!condition.keyword?.trim()) return unsupported(condition, 'KEYWORD_MATCH requires a keyword.');
  const kw = likeParam(condition.keyword.trim());

  switch (condition.family) {
    case 'bill': {
      const rows = await prisma.$queryRawUnsafe<
        Array<{ id: string; title: string; occurredAt: Date }>
      >(
        `SELECT id, title, COALESCE(latest_action_date, introduced_date)::timestamptz AS "occurredAt"
         FROM congress_bill
         WHERE COALESCE(latest_action_date, introduced_date) BETWEEN $1 AND $2
           AND (title ILIKE $3 OR latest_action_text ILIKE $3 OR policy_area ILIKE $3)
         ORDER BY COALESCE(latest_action_date, introduced_date) DESC
         LIMIT 200`,
        window.from,
        window.to,
        kw,
      );
      return ok(
        condition,
        rows.map((r) => ({
          packetId: `bill:${r.id}`,
          canonicalObject: { kind: 'bill', id: r.id, label: r.title, detailPath: `/bills/${r.id}` },
          occurredAt: r.occurredAt.toISOString(),
          reasonCodes: ['KEYWORD_MATCH'],
          matchedConditions: ['KEYWORD_MATCH'],
          evidence: r.title,
        })),
        rows.length,
      );
    }
    case 'hearing': {
      const rows = await prisma.$queryRawUnsafe<
        Array<{ id: string; title: string; occurredAt: Date }>
      >(
        `SELECT id, title, COALESCE(starts_at, date::timestamptz) AS "occurredAt"
         FROM committee_hearing
         WHERE date BETWEEN $1::date AND $2::date
           AND visibility = 'public'
           AND (title ILIKE $3 OR committee_name ILIKE $3)
         ORDER BY date DESC
         LIMIT 200`,
        window.from,
        window.to,
        kw,
      );
      return ok(
        condition,
        rows.map((r) => ({
          packetId: `hearing:${r.id}`,
          canonicalObject: {
            kind: 'hearing',
            id: r.id,
            label: r.title,
            detailPath: `/legiwatch/hearings/${r.id}`,
          },
          occurredAt: r.occurredAt.toISOString(),
          reasonCodes: ['KEYWORD_MATCH'],
          matchedConditions: ['KEYWORD_MATCH'],
          evidence: r.title,
        })),
        rows.length,
      );
    }
    case 'regulation': {
      const rows = await prisma.$queryRawUnsafe<
        Array<{ id: string; title: string; occurredAt: Date }>
      >(
        `SELECT id, title, publication_date AS "occurredAt"
         FROM federal_register_document
         WHERE publication_date BETWEEN $1 AND $2
           AND (title ILIKE $3 OR abstract ILIKE $3)
         ORDER BY publication_date DESC
         LIMIT 200`,
        window.from,
        window.to,
        kw,
      );
      return ok(
        condition,
        rows.map((r) => ({
          packetId: `regulation:${r.id}`,
          canonicalObject: { kind: 'regulation', id: r.id, label: r.title, detailPath: null },
          occurredAt: r.occurredAt.toISOString(),
          reasonCodes: ['KEYWORD_MATCH'],
          matchedConditions: ['KEYWORD_MATCH'],
          evidence: r.title,
        })),
        rows.length,
      );
    }
    case 'program_element': {
      // A PE row itself has no per-instance timestamp for "this happened at
      // this time" — the real timestamped event is a computed DELTA, so the
      // keyword match is tied to deltas landing in the window, not to a bare
      // PE-directory text search that would have no occurredAt to report.
      const rows = await prisma.$queryRawUnsafe<
        Array<{ id: string; peCode: string; title: string; occurredAt: Date }>
      >(
        `SELECT d.id, d.pe_code AS "peCode", pe.title, d.computed_at AS "occurredAt"
         FROM program_element_delta d
         JOIN program_element pe ON pe.pe_code = d.pe_code
         WHERE d.computed_at BETWEEN $1 AND $2
           AND d.superseded_at IS NULL
           AND pe.title ILIKE $3
         ORDER BY d.computed_at DESC
         LIMIT 200`,
        window.from,
        window.to,
        kw,
      );
      return ok(
        condition,
        rows.map((r) => ({
          packetId: `program_element_delta:${r.id}`,
          canonicalObject: {
            kind: 'program_element',
            id: r.peCode,
            label: r.title,
            detailPath: null,
          },
          occurredAt: r.occurredAt.toISOString(),
          reasonCodes: ['KEYWORD_MATCH'],
          matchedConditions: ['KEYWORD_MATCH'],
          evidence: r.title,
        })),
        rows.length,
      );
    }
    case 'state_bill': {
      const rows = await prisma.$queryRawUnsafe<
        Array<{ id: string; title: string; occurredAt: Date }>
      >(
        `SELECT id, title, COALESCE(status_at, latest_action_date::timestamptz) AS "occurredAt"
         FROM state_bill
         WHERE COALESCE(status_at, latest_action_date::timestamptz) BETWEEN $1 AND $2
           AND title ILIKE $3
         ORDER BY COALESCE(status_at, latest_action_date::timestamptz) DESC
         LIMIT 200`,
        window.from,
        window.to,
        kw,
      );
      return ok(
        condition,
        rows.map((r) => ({
          packetId: `state_bill:${r.id}`,
          canonicalObject: { kind: 'state_bill', id: r.id, label: r.title, detailPath: null },
          occurredAt: r.occurredAt.toISOString(),
          reasonCodes: ['KEYWORD_MATCH'],
          matchedConditions: ['KEYWORD_MATCH'],
          evidence: r.title,
        })),
        rows.length,
      );
    }
    default:
      return unsupported(condition, `KEYWORD_MATCH is not supported for family "${condition.family}".`);
  }
}

async function evaluateStatusChange(
  prisma: PrismaService,
  condition: WatchCondition,
  window: { from: Date; to: Date },
): Promise<ConditionOutcome> {
  if (!condition.family) return unsupported(condition, 'STATUS_CHANGE requires a signal family.');

  if (condition.family === 'bill') {
    const rows = await prisma.$queryRawUnsafe<
      Array<{ id: string; title: string; status: string | null; occurredAt: Date }>
    >(
      `SELECT id, title, status, status_at AS "occurredAt"
       FROM congress_bill
       WHERE status_at BETWEEN $1 AND $2
       ORDER BY status_at DESC
       LIMIT 200`,
      window.from,
      window.to,
    );
    return ok(
      condition,
      rows.map((r) => ({
        packetId: `bill:${r.id}`,
        canonicalObject: { kind: 'bill', id: r.id, label: r.title, detailPath: `/bills/${r.id}` },
        occurredAt: r.occurredAt.toISOString(),
        reasonCodes: ['STATUS_CHANGE', r.status ?? 'UNKNOWN_STATUS'],
        matchedConditions: ['STATUS_CHANGE'],
        evidence: r.status ? `Status changed to ${r.status}` : null,
      })),
      rows.length,
    );
  }

  if (condition.family === 'state_bill') {
    const rows = await prisma.$queryRawUnsafe<
      Array<{ id: string; title: string; status: string | null; occurredAt: Date }>
    >(
      `SELECT id, title, status, status_at AS "occurredAt"
       FROM state_bill
       WHERE status_at BETWEEN $1 AND $2
       ORDER BY status_at DESC
       LIMIT 200`,
      window.from,
      window.to,
    );
    return ok(
      condition,
      rows.map((r) => ({
        packetId: `state_bill:${r.id}`,
        canonicalObject: { kind: 'state_bill', id: r.id, label: r.title, detailPath: null },
        occurredAt: r.occurredAt.toISOString(),
        reasonCodes: ['STATUS_CHANGE', r.status ?? 'UNKNOWN_STATUS'],
        matchedConditions: ['STATUS_CHANGE'],
        evidence: r.status ? `Status changed to ${r.status}` : null,
      })),
      rows.length,
    );
  }

  if (condition.family === 'hearing') {
    // No dedicated "status changed at" column exists on committee_hearing;
    // `last_official_update_at` (bumped whenever reconciliation overwrites a
    // previously-observed field) combined with `source_revision > 1` is the
    // real, honest proxy for "something about this hearing changed" — never
    // treated as more specific than that in the evidence text.
    const rows = await prisma.$queryRawUnsafe<
      Array<{ id: string; title: string; occurredAt: Date }>
    >(
      `SELECT id, title, last_official_update_at AS "occurredAt"
       FROM committee_hearing
       WHERE last_official_update_at BETWEEN $1 AND $2
         AND source_revision > 1
         AND visibility = 'public'
       ORDER BY last_official_update_at DESC
       LIMIT 200`,
      window.from,
      window.to,
    );
    return ok(
      condition,
      rows.map((r) => ({
        packetId: `hearing:${r.id}`,
        canonicalObject: {
          kind: 'hearing',
          id: r.id,
          label: r.title,
          detailPath: `/legiwatch/hearings/${r.id}`,
        },
        occurredAt: r.occurredAt.toISOString(),
        reasonCodes: ['STATUS_CHANGE'],
        matchedConditions: ['STATUS_CHANGE'],
        evidence: 'A previously-observed field on this hearing was reconciled.',
      })),
      rows.length,
    );
  }

  return unsupported(condition, `STATUS_CHANGE is not supported for family "${condition.family}".`);
}

async function evaluateFundingMovement(
  prisma: PrismaService,
  condition: WatchCondition,
  window: { from: Date; to: Date },
): Promise<ConditionOutcome> {
  const floor = condition.minMaterialityScore ?? 0;
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      id: string;
      peCode: string;
      title: string;
      materialityScore: number;
      deltaPct: number | null;
      explanation: string | null;
      occurredAt: Date;
    }>
  >(
    `SELECT d.id, d.pe_code AS "peCode", pe.title, d.materiality_score AS "materialityScore",
            d.delta_pct AS "deltaPct", d.explanation, d.computed_at AS "occurredAt"
     FROM program_element_delta d
     JOIN program_element pe ON pe.pe_code = d.pe_code
     WHERE d.computed_at BETWEEN $1 AND $2
       AND d.superseded_at IS NULL
       AND d.materiality_score >= $3
     ORDER BY d.materiality_score DESC, d.computed_at DESC
     LIMIT 200`,
    window.from,
    window.to,
    floor,
  );
  return ok(
    condition,
    rows.map((r) => ({
      packetId: `program_element_delta:${r.id}`,
      canonicalObject: { kind: 'program_element', id: r.peCode, label: r.title, detailPath: null },
      occurredAt: r.occurredAt.toISOString(),
      reasonCodes: ['FUNDING_MOVEMENT'],
      matchedConditions: ['FUNDING_MOVEMENT'],
      evidence:
        r.explanation ??
        (r.deltaPct != null ? `Funding moved ${(r.deltaPct * 100).toFixed(1)}%` : null),
    })),
    rows.length,
  );
}

async function evaluateHearingScheduled(
  prisma: PrismaService,
  condition: WatchCondition,
  window: { from: Date; to: Date },
): Promise<ConditionOutcome> {
  const params: unknown[] = [window.from, window.to];
  const bind = (v: unknown): string => {
    params.push(v);
    return `$${params.length}`;
  };
  const committeeFilter = condition.committeeSystemCode
    ? `AND (committee_system_code = ${bind(condition.committeeSystemCode)} OR subcommittee_system_code = ${bind(condition.committeeSystemCode)})`
    : '';
  const keywordFilter = condition.keyword?.trim()
    ? `AND title ILIKE ${bind(likeParam(condition.keyword.trim()))}`
    : '';

  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; title: string; occurredAt: Date }>>(
    `SELECT id, title, date::timestamptz AS "occurredAt"
     FROM committee_hearing
     WHERE date BETWEEN $1::date AND $2::date
       AND visibility = 'public'
       ${committeeFilter}
       ${keywordFilter}
     ORDER BY date DESC
     LIMIT 200`,
    ...params,
  );
  return ok(
    condition,
    rows.map((r) => ({
      packetId: `hearing:${r.id}`,
      canonicalObject: {
        kind: 'hearing',
        id: r.id,
        label: r.title,
        detailPath: `/legiwatch/hearings/${r.id}`,
      },
      occurredAt: r.occurredAt.toISOString(),
      reasonCodes: ['HEARING_SCHEDULED'],
      matchedConditions: ['HEARING_SCHEDULED'],
      evidence: r.title,
    })),
    rows.length,
  );
}

async function evaluateClientRelevanceHigh(
  prisma: PrismaService,
  condition: WatchCondition,
  window: { from: Date; to: Date },
  scope: { tenantId: string; clientIds: string[] },
): Promise<ConditionOutcome> {
  if (!scope.clientIds.length) {
    return unsupported(
      condition,
      'CLIENT_RELEVANCE_HIGH requires the preset to name at least one client.',
    );
  }
  const rows = await prisma.withTenant(scope.tenantId, (tx) =>
    tx.$queryRawUnsafe<
      Array<{ hearingId: string; hearingTitle: string; score: number; occurredAt: Date }>
    >(
      `SELECT r.hearing_id AS "hearingId", h.title AS "hearingTitle", r.score,
              r.updated_at AS "occurredAt"
       FROM tenant_hearing_relevance r
       JOIN committee_hearing h ON h.id = r.hearing_id
       WHERE r.client_id = ANY($1::uuid[])
         AND r.updated_at BETWEEN $2 AND $3
         AND r.score >= $4
       ORDER BY r.score DESC, r.updated_at DESC
       LIMIT 200`,
      scope.clientIds,
      window.from,
      window.to,
      RELEVANCE_BAND_FLOORS.HIGH,
    ),
  );
  return ok(
    condition,
    rows.map((r) => ({
      packetId: `relevance:${r.hearingId}`,
      canonicalObject: {
        kind: 'hearing',
        id: r.hearingId,
        label: r.hearingTitle,
        detailPath: `/legiwatch/hearings/${r.hearingId}`,
      },
      occurredAt: r.occurredAt.toISOString(),
      reasonCodes: ['CLIENT_RELEVANCE_HIGH'],
      matchedConditions: ['CLIENT_RELEVANCE_HIGH'],
      evidence: `Relevance score ${r.score.toFixed(2)}`,
    })),
    rows.length,
  );
}
