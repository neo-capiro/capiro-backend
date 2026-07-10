import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { SourceBillAction, SourceHearingForBill } from './source-data.repository.js';

/**
 * StateSourceDataRepository — the state-rail twin of SourceDataRepository
 * (State Legislation Platform Phase 0, S4.2). Same invariants: READ-ONLY
 * against apps/api-owned GLOBAL tables (`state_bill` + its children — same
 * posture as `congress_bill`, no RLS/tenant scoping needed), all scalar
 * params bound, never `$executeRaw*`/insert/update/delete.
 *
 * Several methods deliberately return the SAME shape as their congress-rail
 * counterpart (`SourceBillAction`, `SourceHearingForBill`) so the shared
 * detector code (`selectMaterialEvents`, the B3 hearing builder) works
 * unchanged across both rails — only the repository read differs.
 */
export interface SourceStateBill {
  id: string;
  state: string;
  sessionKey: string;
  identifier: string;
  title: string | null;
  status: string | null;
  statusAt: Date | null;
  latestActionText: string | null;
  latestActionDate: Date | null;
  textDate: Date | null;
  sponsorName: string | null;
  sponsorParty: string | null;
  sponsorCount: number | null;
  stateUrl: string | null;
  url: string | null;
  subjects: string[] | null;
}

export interface SourceStateSponsorMomentum {
  billKey: string;
  liveCount: number;
  new7d: number;
  recentNames: string[] | null;
}

export interface SourceStateVote {
  billKey: string;
  chamber: string | null;
  motion: string | null;
  yeas: number;
  nays: number;
  passed: boolean | null;
  date: Date;
  sourceUrl: string | null;
  /** When intel-api's own ingestion last wrote this row — the "new since we last looked" signal (votes are immutable, never revised). */
  lastSyncedAt: Date;
}

export interface SourceMovedCompanion {
  billKey: string;
  relatedBillKey: string | null;
  relatedDisplay: string | null;
  relatedStatus: string | null;
  relatedStatusAt: Date | null;
  linkType: string;
}

@Injectable()
export class StateSourceDataRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Batch-read GLOBAL `state_bill` rows by DD1 key (for the shadow change detector). */
  async getStateBillsByIds(keys: string[]): Promise<SourceStateBill[]> {
    if (!keys.length) return [];
    return this.prisma.$queryRawUnsafe<SourceStateBill[]>(
      `SELECT id,
              state,
              session_key         AS "sessionKey",
              identifier,
              title,
              status,
              status_at            AS "statusAt",
              latest_action_text   AS "latestActionText",
              latest_action_date   AS "latestActionDate",
              text_date            AS "textDate",
              sponsor_name         AS "sponsorName",
              sponsor_party        AS "sponsorParty",
              sponsor_count        AS "sponsorCount",
              state_url            AS "stateUrl",
              url,
              subjects
         FROM state_bill
        WHERE id = ANY($1::text[])`,
      keys,
    );
  }

  /** One `state_bill` row by DD1 key (track-path validation), or null. */
  async getStateBillById(key: string): Promise<SourceStateBill | null> {
    const rows = await this.getStateBillsByIds([key]);
    return rows[0] ?? null;
  }

  /** Batch-read `state_bill_action` rows for many bills, oldest-first — same shape as SourceBillAction. */
  async getStateBillActionsByIds(keys: string[]): Promise<SourceBillAction[]> {
    if (!keys.length) return [];
    return this.prisma.$queryRawUnsafe<SourceBillAction[]>(
      `SELECT id::text        AS id,
              bill_key         AS "billId",
              date,
              text,
              NULL::text       AS type,
              chamber
         FROM state_bill_action
        WHERE bill_key = ANY($1::text[])
        ORDER BY date ASC`,
      keys,
    );
  }

  /**
   * Sponsor-momentum snapshot: current live sponsor count + count/names added
   * within the last `days`, windowed on `first_seen_at` (NOT `last_synced_at`
   * — LegiScan carries no per-sponsor add date, so the diff-sync anti-join's
   * stamp at ingestion time is the only honest "new this window" anchor;
   * windowing on sync time would report the whole sponsor list as "new" on
   * every re-sync).
   */
  async getStateSponsorMomentum(
    keys: string[],
    days: number,
  ): Promise<SourceStateSponsorMomentum[]> {
    if (!keys.length) return [];
    return this.prisma.$queryRawUnsafe<SourceStateSponsorMomentum[]>(
      `SELECT bill_key AS "billKey",
              count(*)::int AS "liveCount",
              count(*) FILTER (
                WHERE first_seen_at >= (now() - ($2::int || ' days')::interval)
              )::int AS "new7d",
              (array_agg(name ORDER BY first_seen_at DESC)
                 FILTER (WHERE first_seen_at >= (now() - ($2::int || ' days')::interval))
              )[1:10] AS "recentNames"
         FROM state_bill_sponsor
        WHERE bill_key = ANY($1::text[])
        GROUP BY bill_key`,
      keys,
      days,
    );
  }

  /** Latest roll-call vote per bill (for a vote-tally alert + status derivation). */
  async getStateVotesForBills(keys: string[]): Promise<SourceStateVote[]> {
    if (!keys.length) return [];
    return this.prisma.$queryRawUnsafe<SourceStateVote[]>(
      `SELECT DISTINCT ON (bill_key)
              bill_key       AS "billKey",
              chamber,
              motion,
              yeas,
              nays,
              passed,
              date,
              source_url     AS "sourceUrl",
              last_synced_at AS "lastSyncedAt"
         FROM state_roll_call_vote
        WHERE bill_key = ANY($1::text[])
        ORDER BY bill_key, date DESC, last_synced_at DESC`,
      keys,
    );
  }

  /**
   * Soonest upcoming calendar event per bill — same shape as
   * SourceHearingForBill (billId←billKey, hearingId←eventKey, title←eventType,
   * url←the bill's official stateUrl) so the federal B3 hearing builder works
   * unchanged.
   */
  async getUpcomingStateEventsForBills(keys: string[]): Promise<SourceHearingForBill[]> {
    if (!keys.length) return [];
    return this.prisma.$queryRawUnsafe<SourceHearingForBill[]>(
      `SELECT DISTINCT ON (e.bill_key)
              e.bill_key        AS "billId",
              e.event_key       AS "hearingId",
              e.event_type      AS title,
              NULL::text        AS "committeeName",
              NULL::text        AS chamber,
              e.date,
              sb.state_url      AS url
         FROM state_bill_calendar_event e
         LEFT JOIN state_bill sb ON sb.id = e.bill_key
        WHERE e.bill_key = ANY($1::text[])
          AND e.date >= CURRENT_DATE
        ORDER BY e.bill_key, e.date ASC`,
      keys,
    );
  }

  /**
   * Companion links whose related bill's status has since advanced —
   * `sasts` (same_as/companion/similar) from `state_bill_link` joined to the
   * related bill's current status/statusAt. The caller (detector) compares
   * `relatedStatusAt` against ITS OWN per-row `lastSeenAt` watermark (a
   * global "advanced" cutoff can't be computed here since that watermark is
   * per tracked-bill, not global).
   */
  async getMovedCompanions(keys: string[]): Promise<SourceMovedCompanion[]> {
    if (!keys.length) return [];
    return this.prisma.$queryRawUnsafe<SourceMovedCompanion[]>(
      `SELECT l.bill_key            AS "billKey",
              l.related_bill_key    AS "relatedBillKey",
              rb.identifier         AS "relatedDisplay",
              rb.status             AS "relatedStatus",
              rb.status_at          AS "relatedStatusAt",
              l.link_type           AS "linkType"
         FROM state_bill_link l
         LEFT JOIN state_bill rb ON rb.id = l.related_bill_key
        WHERE l.bill_key = ANY($1::text[])
          AND l.related_bill_key IS NOT NULL`,
      keys,
    );
  }

  /** Keyword/subject candidate bill keys, scoped to a set of states (S5 watchlist matching). */
  async stateKeywordCandidateIds(terms: string[], states: string[]): Promise<string[]> {
    if (!states.length) return [];
    const lower = terms.map((t) => t.toLowerCase()).filter((t) => t.length >= 3);
    if (!lower.length) return [];
    const patterns = lower.map((n) => `\\m${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\M`);
    const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT DISTINCT sb.id
         FROM state_bill sb
        WHERE sb.state = ANY($1::text[])
          AND ( sb.subjects && $2::text[]
             OR LOWER(sb.title) ~ ANY($3::text[]) )
        LIMIT 300`,
      states.map((s) => s.toUpperCase()),
      lower,
      patterns,
    );
    return rows.map((r) => r.id);
  }
}
