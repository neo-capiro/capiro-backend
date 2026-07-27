/**
 * Authoritative structured truth for bills and program elements (Phase 1 §3.b2).
 *
 * These two builders were private/public methods on EngagementService. Phase 1's
 * EvidenceSourceService needs them too, and EngagementService already depends on
 * the generation services — so hosting them here is what keeps the dependency
 * graph acyclic WITHOUT a second copy of the queries. The plan is explicit that
 * server-rehydrated authoritative truth must have exactly one implementation:
 * two copies of "what is this bill's canonical status" is precisely the drift
 * that produced the reversed-funding-direction and stalled-bill-read-as-
 * advancing defects.
 *
 * EngagementService.billTruthBlock() remains as a thin delegate because
 * AlertMemoService calls it (and mocks it) by that name.
 *
 * Both congress_bill / program_element and their child tables are GLOBAL
 * (non-RLS) reference data, so these read off the base client rather than
 * withTenant — same as before the move.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { currentCycleFyOf } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  formatBillTruth,
  formatPeTruth,
  type BillTruth,
  type BillVoteRow,
  type GoverningRuleRow,
  type PeTruth,
  type PeYearFunding,
} from '../outreach-context-enrichment.js';

@Injectable()
export class OutreachTruthService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Authoritative bill-truth block. Null when the bill is not on record — the
   * caller must then record a SOURCE FAILURE, never fall back to a thin
   * browser-supplied body (that fallback is what Phase 1 §3.b2 removes).
   */
  async billTruthBlock(billId: string): Promise<{ text: string; raw: BillTruth } | null> {
    const bill = await this.prisma.congressBill.findUnique({
      where: { id: billId },
      select: {
        id: true,
        title: true,
        status: true,
        statusAt: true,
        latestActionText: true,
        latestActionDate: true,
        sponsorName: true,
        sponsorParty: true,
        sponsorState: true,
        cosponsorsCount: true,
        committees: true,
      },
    });
    if (!bill) return null;

    const [votes, ruleLinks] = await Promise.all([
      this.prisma.rollCallVote.findMany({
        where: { billId },
        orderBy: { voteDate: 'desc' },
        take: 5,
        select: {
          chamber: true,
          rollNumber: true,
          question: true,
          result: true,
          yeas: true,
          nays: true,
          voteDate: true,
        },
      }),
      this.prisma.billRuleLink.findMany({
        where: { targetBillId: billId },
        select: { ruleBillId: true },
      }),
    ]);

    const governingRules: GoverningRuleRow[] = await Promise.all(
      ruleLinks.map(async (l) => {
        const [ruleBill, ruleVotes] = await Promise.all([
          this.prisma.congressBill.findUnique({
            where: { id: l.ruleBillId },
            select: { status: true, latestActionText: true },
          }),
          this.prisma.rollCallVote.findMany({
            where: { billId: l.ruleBillId },
            orderBy: { voteDate: 'desc' },
            take: 3,
            select: {
              chamber: true,
              rollNumber: true,
              question: true,
              result: true,
              yeas: true,
              nays: true,
              voteDate: true,
            },
          }),
        ]);
        return {
          ruleBillId: l.ruleBillId,
          ruleStatus: ruleBill?.status ?? null,
          ruleLatestAction: ruleBill?.latestActionText ?? null,
          ruleVotes: ruleVotes as BillVoteRow[],
        };
      }),
    );

    const committees = Array.isArray(bill.committees)
      ? (bill.committees as unknown[])
          .map((c) =>
            typeof c === 'string'
              ? c
              : c && typeof c === 'object' && 'name' in c
                ? String((c as { name: unknown }).name)
                : null,
          )
          .filter((c): c is string => Boolean(c))
      : [];

    const raw: BillTruth = {
      id: bill.id,
      title: bill.title,
      status: bill.status,
      statusAt: bill.statusAt,
      latestActionText: bill.latestActionText,
      latestActionDate: bill.latestActionDate,
      sponsorName: bill.sponsorName,
      sponsorParty: bill.sponsorParty,
      sponsorState: bill.sponsorState,
      cosponsorsCount: bill.cosponsorsCount,
      committees,
      votes: votes as BillVoteRow[],
      governingRules,
    };
    return { text: formatBillTruth(raw), raw };
  }

  /** Authoritative PE-funding block. Null when the PE is not on record. */
  async peTruthBlock(peCode: string): Promise<{ text: string; raw: PeTruth } | null> {
    const pe = await this.prisma.programElement.findUnique({
      where: { peCode },
      select: { peCode: true, title: true, service: true, budgetActivityName: true },
    });
    if (!pe) return null;

    const years = await this.prisma.programElementYear.findMany({
      where: { peCode },
      orderBy: { fy: 'desc' },
      select: {
        fy: true,
        request: true,
        hascMark: true,
        sascMark: true,
        hacDMark: true,
        sacDMark: true,
        conference: true,
        ndaaConference: true,
        enacted: true,
      },
    });
    const num = (d: Prisma.Decimal | null): number | null => (d == null ? null : Number(d));
    // The FULL fiscal-year series — the authoritative block renders historical,
    // current-cycle, and outyear rows so trend/direction claims are grounded and
    // an outyear projection is never quoted as the current request.
    const series: PeYearFunding[] = years.map((y) => ({
      fy: y.fy,
      request: num(y.request),
      hascMark: num(y.hascMark),
      sascMark: num(y.sascMark),
      hacDMark: num(y.hacDMark),
      sacDMark: num(y.sacDMark),
      conference: num(y.conference),
      ndaaConference: num(y.ndaaConference),
      enacted: num(y.enacted),
    }));

    const raw: PeTruth = {
      peCode: pe.peCode,
      title: pe.title,
      service: pe.service,
      budgetActivityName: pe.budgetActivityName,
      currentCycleFy: currentCycleFyOf(series),
      years: series,
    };
    return { text: formatPeTruth(raw), raw };
  }

  /**
   * Authoritative state-bill truth. Phase 1 §6.5 required re-reading the real
   * source behind /api/explorer/state-bills before implementing this: it is the
   * LegiScan-sourced `state_bill` table (ExplorerService.stateBillDetail reads
   * the same row plus its actions), NOT the thin search projection the wizard's
   * State Bills tab renders. We therefore rehydrate the full row and its latest
   * actions rather than labeling a search hit authoritative.
   *
   * state_bill is global reference data like congress_bill.
   */
  async stateBillTruthBlock(
    stateBillId: string,
  ): Promise<{ text: string; raw: StateBillTruth } | null> {
    const bill = await this.prisma.stateBill.findUnique({
      where: { id: stateBillId },
      select: {
        id: true,
        state: true,
        // `identifier` is the display form ("HB 1234"); billNumber is the
        // normalized key component ("HB1234"). Render the display form.
        identifier: true,
        title: true,
        status: true,
        statusAt: true,
        latestActionText: true,
        latestActionDate: true,
        chamber: true,
        sponsorName: true,
        sponsorParty: true,
        session: true,
      },
    });
    if (!bill) return null;

    // state_bill_action joins on `bill_key` (the StateBill DD1 id), not billId.
    const actions = await this.prisma.stateBillAction.findMany({
      where: { billKey: stateBillId },
      orderBy: [{ date: 'desc' }, { orderKey: 'desc' }],
      take: 5,
      select: { date: true, text: true, chamber: true },
    });

    const raw: StateBillTruth = {
      id: bill.id,
      state: bill.state,
      identifier: bill.identifier,
      title: bill.title,
      status: bill.status,
      statusAt: bill.statusAt ? bill.statusAt.toISOString() : null,
      latestActionText: bill.latestActionText,
      latestActionDate: bill.latestActionDate ? bill.latestActionDate.toISOString() : null,
      chamber: bill.chamber,
      sponsorName: bill.sponsorName,
      sponsorParty: bill.sponsorParty,
      session: bill.session,
      recentActions: actions.map((a) => ({
        date: a.date.toISOString(),
        text: a.text,
        chamber: a.chamber,
      })),
    };
    return { text: formatStateBillTruth(raw), raw };
  }
}

/** Canonical state-bill truth handed to the model and to the claim verifier. */
export interface StateBillTruth {
  id: string;
  state: string;
  /** Display bill identifier, e.g. "HB 1234". */
  identifier: string;
  title: string;
  status: string | null;
  statusAt: string | null;
  latestActionText: string | null;
  latestActionDate: string | null;
  chamber: string | null;
  sponsorName: string | null;
  sponsorParty: string | null;
  session: string;
  recentActions: Array<{ date: string; text: string; chamber: string | null }>;
}

/**
 * Render state-bill truth. Deliberately states the jurisdiction on the first
 * line: a state measure described with federal vocabulary ("enacted into public
 * law", "floor vote in the House") is one of the exact confusions the policy
 * registry and the claim verifier exist to catch.
 */
export function formatStateBillTruth(raw: StateBillTruth): string {
  const ident = [raw.state, raw.identifier].filter(Boolean).join(' ') || raw.id;
  const lines: string[] = [
    `AUTHORITATIVE STATE BILL RECORD (${ident}) — a STATE legislature measure, not federal legislation:`,
  ];
  if (raw.title) lines.push(`Title: ${raw.title}`);
  if (raw.session) lines.push(`Session: ${raw.session}`);
  if (raw.chamber) lines.push(`Chamber of origin: ${raw.chamber}`);
  if (raw.status) {
    lines.push(
      `Canonical status: ${raw.status}${raw.statusAt ? ` (as of ${raw.statusAt.slice(0, 10)})` : ''}`,
    );
  }
  if (raw.sponsorName) {
    lines.push(
      `Sponsor: ${raw.sponsorName}${raw.sponsorParty ? ` (${raw.sponsorParty})` : ''}`,
    );
  }
  if (raw.latestActionText) {
    lines.push(
      `Latest action: ${raw.latestActionText}${
        raw.latestActionDate ? ` (${raw.latestActionDate.slice(0, 10)})` : ''
      }`,
    );
  }
  if (raw.recentActions.length) {
    lines.push('Recent actions (newest first):');
    for (const a of raw.recentActions) {
      lines.push(`- ${a.date.slice(0, 10)}${a.chamber ? ` [${a.chamber}]` : ''}: ${a.text}`);
    }
  }
  lines.push(
    'Do NOT state any status, date, or action for this bill that is not written above.',
  );
  return lines.join('\n');
}
