import { Injectable, Logger } from '@nestjs/common';
import { hasAtLeast, type TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { readVisibleClientIds } from './funding-opportunity-inbox.service.js';
import {
  FUNDING_OPPORTUNITIES_BUDGET_CONTEXT_FEATURE,
  isFundingOpportunitiesFeatureEnabled,
} from './funding-opportunities-flag.guard.js';

/**
 * Tango budget beta context, in shadow mode (P44).
 *
 * ── A CLIENT footprint, not an opportunity-to-account crosswalk ──────────────
 *
 * There is no source-backed key linking a SAM.gov notice to a Treasury federal
 * account. A notice states an agency NAME and an office; a budget account
 * states a federal account symbol and (sometimes — it was null on a real row)
 * an agency code. Matching them would mean matching agency names, which is
 * exactly the fuzzy-matching-as-identity P02 removed from award history and
 * P27's crosswalk refuses for solicitation numbers.
 *
 * So this service answers the question it CAN answer from exact identifiers:
 * which federal accounts have obligated money to THIS CLIENT, by UEI. That is
 * the same shape P23 landed on for acquisition position after finding no
 * notice-to-vehicle crosswalk existed either (decision-log D-44), and it is
 * reported as what it is — the panel says outright that no account is linked to
 * this notice, rather than presenting a name match as one.
 *
 * ── Beta means the provider's own confidence travels with the number ─────────
 *
 * Every account row carries the provider's `attribution_status` and
 * `attribution_confidence` verbatim. A number Tango is unsure about is shown as
 * a number Tango is unsure about. That is what makes the "Tango Budget Beta"
 * label mean something rather than decorate a panel.
 *
 * ── It cannot touch Capiro's own budget data, and could not if it tried ──────
 *
 * This service reads two tables, both provider-owned and global. It holds no
 * writer for anything, and specifically no path to a Program Element, project,
 * request, mark or enacted row — plan §P44's own prohibition, enforced by the
 * dependency list and asserted structurally by the spec.
 *
 * ── Nothing is summed across unlike scope ────────────────────────────────────
 *
 * Rows are grouped by fiscal year and returned per account. No total spans two
 * fiscal years, two accounts or two stages, because those are different things
 * measured differently and one number over them is a number that means nothing.
 */

/**
 * P44's flag, re-exported from the guard file where every other Funding
 * Opportunities flag constant lives — the same arrangement P37/P38 use, so the
 * route guard and this service's boolean read can never disagree about what
 * enabled means.
 */
export { FUNDING_OPPORTUNITIES_BUDGET_CONTEXT_FEATURE };

/** The label every surface must use. Stated once, so it cannot drift. */
export const BUDGET_BETA_LABEL = 'Tango Budget Beta';

export const BUDGET_CONTEXT_STATES = [
  'available',
  'disabled',
  'denied',
  'not_synced',
  'no_client_identity',
  'no_flows',
] as const;
export type BudgetContextState = (typeof BUDGET_CONTEXT_STATES)[number];

export interface BudgetAccountView {
  federalAccountSymbol: string;
  fiscalYear: number;
  accountTitle: string;
  agencyName: string | null;
  bureauName: string | null;
  /** Every figure nullable. Null means the provider stated none, never zero. */
  money: {
    requestedBa: string | null;
    enactedBa: string | null;
    apportioned: string | null;
    obligatedTotal: string | null;
    outlayedTotal: string | null;
    unobligatedBalance: string | null;
    contractObligated: string | null;
  };
  /** The provider's own words about how sure it is. */
  attributionStatus: string | null;
  attributionConfidence: string | null;
  /** This client's flow out of THIS account, in THIS fiscal year. */
  clientFlow: {
    recipientUei: string;
    contractObligated: string | null;
    contractOutlayed: string | null;
    contractCount: number | null;
    fundingOfficeName: string | null;
    fundingAgencyName: string | null;
  } | null;
  lastSyncedAt: string | null;
}

export interface BudgetContextResult {
  state: BudgetContextState;
  /** Why the state is what it is. Never a claim about the client or the notice. */
  explanation: string;
  source: typeof BUDGET_BETA_LABEL;
  /**
   * Stated on EVERY response, including the empty ones.
   *
   * "No source-backed key links this notice to a federal account" is the single
   * most important sentence on the panel, and a reader who only sees it when
   * data happens to be missing will read its absence as a link existing.
   */
  noticeLinkage: {
    linked: false;
    explanation: string;
  };
  /** Grain, stated rather than left to the reader to infer from the numbers. */
  grain: string;
  /** Grouped by fiscal year, newest first. Never summed across years. */
  fiscalYears: Array<{ fiscalYear: number; accounts: BudgetAccountView[] }>;
  asOf: string;
}

interface BudgetActor {
  tenantId: string;
  userId: string;
  role: TenantContext['role'];
}

const NOTICE_LINKAGE_EXPLANATION =
  'No federal account is linked to this notice. SAM.gov notices carry no Treasury account symbol, and matching on agency name would be a guess. What follows is this client’s own federal-account execution footprint, matched by exact UEI.';

const GRAIN =
  'Federal account × fiscal year. This is appropriation-container execution, not Program Element line-item funding — the two are different grains and are never compared here.';

@Injectable()
export class OpportunityBudgetContextService {
  private readonly logger = new Logger(OpportunityBudgetContextService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getContext(
    actor: BudgetActor,
    clientId: string,
    asOf: Date = new Date(),
  ): Promise<BudgetContextResult> {
    if (!(await this.enabled(actor.tenantId))) {
      return this.empty(
        'disabled',
        'Budget context is not enabled for this workspace. This says nothing about the client’s federal funding.',
        asOf,
      );
    }
    if (!hasAtLeast(actor.role, 'standard_user')) {
      return this.empty('denied', 'Not available for this client.', asOf);
    }

    const visible = await this.prisma.withTenant(actor.tenantId, (tx) =>
      readVisibleClientIds(tx, actor.tenantId, actor.userId),
    );
    if (!visible.includes(clientId)) {
      // The same sentence a non-existent client gets, for the reason every wall
      // in this program uses one wording.
      return this.empty('denied', 'Not available for this client.', asOf);
    }

    const ueis = await this.clientUeis(actor.tenantId, clientId);
    if (ueis.length === 0) {
      return this.empty(
        'no_client_identity',
        'This client has no recorded UEI, and a UEI is the only exact key between a Capiro client and a federal budget recipient. Nothing here says the client received no federal funding.',
        asOf,
      );
    }

    // `withSystem`: both tables are GLOBAL provider catalog data with no
    // tenant_id and no RLS, same as sam_opportunity and federal_grant. A
    // withTenant read would set a GUC no policy on these tables reads.
    const flows = await this.prisma.withSystem((tx) =>
      tx.tangoBudgetVendorFlow.findMany({
        where: { recipientUei: { in: ueis } },
        include: { budgetAccount: true },
        // Bounded and deterministically ordered. A client with hundreds of
        // account relationships is a panel nobody reads, not a bigger panel.
        orderBy: [{ budgetAccount: { fiscalYear: 'desc' } }, { recipientUei: 'asc' }, { id: 'asc' }],
        take: 200,
      }),
    );

    if (flows.length === 0) {
      // TWO different facts, and they must not collapse. If the catalog has
      // never been populated the answer is "not synced"; if it has and this
      // client appears nowhere in it, the answer is "no flows found".
      const anyAccount = await this.prisma.withSystem((tx) =>
        tx.tangoBudgetAccount.count({ take: 1 }),
      );
      return anyAccount === 0
        ? this.empty(
            'not_synced',
            'Capiro has not synchronized federal budget accounts yet, so there is nothing to show. This is a gap in Capiro’s coverage, not a finding about the client.',
            asOf,
          )
        : this.empty(
            'no_flows',
            'No federal account in Capiro’s synchronized set shows contract obligations to this client’s UEI. Coverage is partial and labelled beta — this is not proof the client received nothing.',
            asOf,
          );
    }

    const byYear = new Map<number, BudgetAccountView[]>();
    for (const flow of flows) {
      const account = flow.budgetAccount;
      const view: BudgetAccountView = {
        federalAccountSymbol: account.federalAccountSymbol,
        fiscalYear: account.fiscalYear,
        accountTitle: account.accountTitle,
        agencyName: account.agencyName,
        bureauName: account.bureauName,
        money: {
          // Decimal → string, never number. A NUMERIC(20,2) that round-trips
          // through a JS float silently loses cents on a nine-figure
          // obligation, and a dollar figure nobody can reconcile against the
          // source is worse than no figure.
          requestedBa: decimal(account.requestedBa),
          enactedBa: decimal(account.enactedBa),
          apportioned: decimal(account.apportioned),
          obligatedTotal: decimal(account.obligatedTotal),
          outlayedTotal: decimal(account.outlayedTotal),
          unobligatedBalance: decimal(account.unobligatedBalance),
          contractObligated: decimal(account.contractObligated),
        },
        attributionStatus: account.attributionStatus,
        attributionConfidence: account.attributionConfidence,
        clientFlow: {
          recipientUei: flow.recipientUei,
          contractObligated: decimal(flow.contractObligated),
          contractOutlayed: decimal(flow.contractOutlayed),
          contractCount: flow.contractCount,
          fundingOfficeName: flow.fundingOfficeName,
          fundingAgencyName: flow.fundingAgencyName,
        },
        lastSyncedAt: account.lastSyncedAt.toISOString(),
      };
      const bucket = byYear.get(account.fiscalYear);
      if (bucket) bucket.push(view);
      else byYear.set(account.fiscalYear, [view]);
    }

    return {
      state: 'available',
      explanation:
        'Federal-account execution for accounts that obligated contract dollars to this client, matched by exact UEI.',
      source: BUDGET_BETA_LABEL,
      noticeLinkage: { linked: false, explanation: NOTICE_LINKAGE_EXPLANATION },
      grain: GRAIN,
      // Newest fiscal year first, and each year is its own group. There is
      // deliberately no cross-year total: two fiscal years are two different
      // appropriations and one number over them means nothing.
      fiscalYears: [...byYear.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([fiscalYear, accounts]) => ({ fiscalYear, accounts })),
      asOf: asOf.toISOString(),
    };
  }

  /**
   * The client's exact UEIs.
   *
   * The client's own `uei` only. Deliberately NOT the reviewed contractor
   * mappings P02 admits for award history: a budget flow says money reached a
   * legal entity, and attributing a parent's or affiliate's obligation to this
   * client would be a financial claim about the wrong company. P02's
   * `reviewed_name_fallback` is explicitly not usable here for the same reason.
   */
  private async clientUeis(tenantId: string, clientId: string): Promise<string[]> {
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({ where: { id: clientId }, select: { uei: true } }),
    );
    const uei = client?.uei?.trim();
    return uei ? [uei] : [];
  }

  private async enabled(tenantId: string): Promise<boolean> {
    try {
      return await isFundingOpportunitiesFeatureEnabled(
        this.prisma,
        tenantId,
        FUNDING_OPPORTUNITIES_BUDGET_CONTEXT_FEATURE,
      );
    } catch (error) {
      this.logger.error(
        `${FUNDING_OPPORTUNITIES_BUDGET_CONTEXT_FEATURE} flag read failed for tenant ${tenantId}; failing closed`,
        error instanceof Error ? error.stack : String(error),
      );
      return false;
    }
  }

  private empty(
    state: BudgetContextState,
    explanation: string,
    asOf: Date,
  ): BudgetContextResult {
    return {
      state,
      explanation,
      source: BUDGET_BETA_LABEL,
      // Carried on the empty responses too — see the field's own doc.
      noticeLinkage: { linked: false, explanation: NOTICE_LINKAGE_EXPLANATION },
      grain: GRAIN,
      fiscalYears: [],
      asOf: asOf.toISOString(),
    };
  }
}

/**
 * A Prisma `Decimal` as its exact decimal string, or null.
 *
 * Never `.toNumber()`. NUMERIC(20,2) exceeds what a JS float represents
 * exactly, and a nine-figure obligation that comes back a cent short is a
 * number nobody can reconcile against the source document.
 */
export function decimal(value: { toString(): string } | null | undefined): string | null {
  return value == null ? null : value.toString();
}
