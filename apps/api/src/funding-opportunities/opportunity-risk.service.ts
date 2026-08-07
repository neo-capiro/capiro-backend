import { Injectable, Logger } from '@nestjs/common';
import { hasAtLeast, type TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { readVisibleClientIds } from './funding-opportunity-inbox.service.js';
import {
  FUNDING_OPPORTUNITIES_RISK_CONTEXT_FEATURE,
  isFundingOpportunitiesFeatureEnabled,
} from './funding-opportunities-flag.guard.js';

/**
 * Protest and exclusion risk context (P45).
 *
 * ── Evidence, never a legal conclusion ───────────────────────────────────────
 *
 * Everything this service emits is an observation with a source link and a
 * date. It does not say a procurement is invalid, that an award will be
 * overturned, that a client may or may not bid, or what anyone should do about
 * a compliance flag. `opportunity-risk.spec.ts` sweeps every string this file
 * can produce against a list of advice-shaped phrasings, because the
 * distinction is easy to lose to one helpful sentence.
 *
 * ── An exclusion is three states, not two ────────────────────────────────────
 *
 * `active` requires the provider's flag set AND no end date in the past AND an
 * observation inside the staleness window. `expired` is a flag with a past end
 * date. `unverified` is a flag Capiro has not re-checked recently enough to
 * stand behind — and it exists because the Entity resource carries NO dates
 * (P17: there is no exclusions endpoint; the fields ride on the entity), so
 * without it a three-month-old flag would render as today's fact.
 *
 * ── Absence is not good standing, and it is said out loud ────────────────────
 *
 * No row means Capiro has not observed the entity. A row with the flag clear
 * means the provider reported none at that moment. Neither is a clearance, and
 * the caveat travels on EVERY response — including the clean ones, where it
 * matters most.
 *
 * ── Matched by UEI, never by name ────────────────────────────────────────────
 *
 * The only key is the client's own 12-character UEI. A same-named entity cannot
 * inherit an exclusion or a protest history, because a name is never consulted.
 */

export const RISK_EXCLUSION_STATES = ['none_observed', 'active', 'expired', 'unverified'] as const;
export type RiskExclusionState = (typeof RISK_EXCLUSION_STATES)[number];

export const RISK_STATES = ['available', 'disabled', 'denied', 'no_client_identity'] as const;
export type RiskState = (typeof RISK_STATES)[number];

/**
 * How long an exclusion observation stands for.
 *
 * 30 days. Chosen because the provider gives no dates, so this window is the
 * ONLY thing separating "excluded" from "was flagged at some point" — and a
 * compliance signal nobody re-checked within a month is one a reviewer should
 * be told to re-check, not one a panel should assert.
 */
export const EXCLUSION_STALE_AFTER_DAYS = 30;

export interface ProtestView {
  caseNumber: string | null;
  sourceSystem: string | null;
  /** The provider's own word. Null means open or unstated, never "failed". */
  outcome: string | null;
  outcomeCaveat: string;
  caseType: string | null;
  filedDate: string | null;
  decisionDate: string | null;
  agencyName: string | null;
  protesterName: string | null;
  sourceUrl: string | null;
  /** How this protest reached this client. Always an exact identifier. */
  matchedOn: 'protester_uei';
}

export interface ExclusionView {
  state: RiskExclusionState;
  /** What Capiro observed, in plain terms. Never advice. */
  explanation: string;
  /** The provider's own flag value, verbatim. */
  providerFlag: string | null;
  sourceUrl: string | null;
  observedAt: string | null;
  startDate: string | null;
  endDate: string | null;
}

export interface RiskContextResult {
  state: RiskState;
  explanation: string;
  /**
   * The recommendation hint this context contributes, or null.
   *
   * `needs_review` and nothing else. There is deliberately no value here that
   * could read as a clearance or as a block — an active exclusion routes a
   * human to legal or compliance, and Capiro does not decide the outcome.
   */
  recommendationHint: { state: 'needs_review'; reason: string } | null;
  exclusion: ExclusionView;
  protests: ProtestView[];
  /** Carried on every response, including the clean ones. */
  caveats: string[];
  asOf: string;
}

interface RiskActor {
  tenantId: string;
  userId: string;
  role: TenantContext['role'];
}

const ABSENCE_CAVEAT =
  'Absence of exclusion evidence is not evidence of good standing. Capiro reports only what the provider stated when it was last asked.';
const PROTEST_CAVEAT =
  'A protest is context about a related procurement. It is not evidence that this procurement is invalid, that an agency erred, or that an award will change.';
const SOURCE_CAVEAT =
  'Observations from MakeGov/Tango, with the provider’s own wording preserved. GAO and the Court of Federal Claims use the same outcome words for different procedural events.';
const OUTCOME_CAVEAT =
  'The provider’s own word for the docket state, unaltered. Capiro does not interpret it.';

@Injectable()
export class OpportunityRiskService {
  private readonly logger = new Logger(OpportunityRiskService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getRiskContext(
    actor: RiskActor,
    clientId: string,
    asOf: Date = new Date(),
  ): Promise<RiskContextResult> {
    if (!(await this.enabled(actor.tenantId))) {
      return this.empty(
        'disabled',
        'Procurement risk context is not enabled for this workspace.',
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
      return this.empty('denied', 'Not available for this client.', asOf);
    }

    const client = await this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.client.findFirst({ where: { id: clientId }, select: { uei: true } }),
    );
    const uei = normalizeUei(client?.uei);
    if (!uei) {
      return this.empty(
        'no_client_identity',
        'This client has no recorded UEI. A UEI is the only key Capiro will match risk evidence on — a name match could attach another company’s record to this one.',
        asOf,
      );
    }

    // Both tables are GLOBAL provider catalog data with no tenant_id and no
    // RLS, so `withSystem` — the same read every other tango_* catalog uses.
    const [exclusionRow, protestRows] = await this.prisma.withSystem(async (tx) => [
      await tx.tangoEntityExclusion.findFirst({ where: { uei } }),
      await tx.tangoProcurementProtest.findMany({
        where: { protesterUei: uei },
        orderBy: [{ filedDate: 'desc' }, { tangoCaseId: 'asc' }],
        take: 50,
      }),
    ]);

    const exclusion = deriveExclusion(exclusionRow, asOf);

    return {
      state: 'available',
      explanation:
        'Procurement risk observations matched to this client by exact UEI. Every item is evidence with a source and a date.',
      recommendationHint:
        exclusion.state === 'active'
          ? {
              state: 'needs_review',
              // The one sentence this phase exists to get right. It routes a
              // person; it does not decide, and it does not advise.
              reason:
                'An active exclusion was observed against this client’s UEI. Blocked pending legal or compliance review.',
            }
          : null,
      exclusion,
      protests: protestRows.map((row) => ({
        caseNumber: row.caseNumber,
        sourceSystem: row.sourceSystem,
        outcome: row.outcome,
        outcomeCaveat: OUTCOME_CAVEAT,
        caseType: row.caseType,
        filedDate: dateOnly(row.filedDate),
        decisionDate: dateOnly(row.decisionDate),
        agencyName: row.agencyName,
        protesterName: row.protesterName,
        sourceUrl: row.sourceUrl,
        matchedOn: 'protester_uei',
      })),
      caveats: [ABSENCE_CAVEAT, PROTEST_CAVEAT, SOURCE_CAVEAT],
      asOf: asOf.toISOString(),
    };
  }

  private async enabled(tenantId: string): Promise<boolean> {
    try {
      return await isFundingOpportunitiesFeatureEnabled(
        this.prisma,
        tenantId,
        FUNDING_OPPORTUNITIES_RISK_CONTEXT_FEATURE,
      );
    } catch (error) {
      this.logger.error(
        `${FUNDING_OPPORTUNITIES_RISK_CONTEXT_FEATURE} flag read failed for tenant ${tenantId}; failing closed`,
        error instanceof Error ? error.stack : String(error),
      );
      return false;
    }
  }

  private empty(state: RiskState, explanation: string, asOf: Date): RiskContextResult {
    return {
      state,
      explanation,
      recommendationHint: null,
      exclusion: {
        state: 'none_observed',
        explanation:
          'Capiro has not observed an exclusion record for this client. This is not a clearance.',
        providerFlag: null,
        sourceUrl: null,
        observedAt: null,
        startDate: null,
        endDate: null,
      },
      protests: [],
      // Carried on the empty responses too: the absence caveat matters most
      // where there is nothing to show.
      caveats: [ABSENCE_CAVEAT, PROTEST_CAVEAT, SOURCE_CAVEAT],
      asOf: asOf.toISOString(),
    };
  }
}

/** The provider's flag values that mean "excluded". Exact, and case-folded. */
const SET_FLAG_VALUES = new Set(['true', 'y', 'yes', 'd', 'active', 'excluded', '1']);

/**
 * Turn one observation into a state.
 *
 * Pure and exported, so the three-way rule is testable without a database.
 *
 * The ORDER matters. An expired exclusion is expired whether or not the
 * observation is fresh — a date the provider gave is better evidence than a
 * clock — so the date check runs before the staleness check. Reversing them
 * would report a long-finished exclusion as `unverified`, which invites a
 * reviewer to go and re-check something already resolved.
 */
export function deriveExclusion(
  row: {
    exclusionStatusFlag: string | null;
    exclusionUrl: string | null;
    exclusionStartDate: Date | null;
    exclusionEndDate: Date | null;
    observedAt: Date;
  } | null,
  asOf: Date,
  staleAfterDays: number = EXCLUSION_STALE_AFTER_DAYS,
): ExclusionView {
  if (!row) {
    return {
      state: 'none_observed',
      explanation:
        'Capiro has not observed an exclusion record for this client. This is not a clearance.',
      providerFlag: null,
      sourceUrl: null,
      observedAt: null,
      startDate: null,
      endDate: null,
    };
  }

  const base = {
    providerFlag: row.exclusionStatusFlag,
    sourceUrl: row.exclusionUrl,
    observedAt: row.observedAt.toISOString(),
    startDate: dateOnly(row.exclusionStartDate),
    endDate: dateOnly(row.exclusionEndDate),
  };

  const flagSet =
    row.exclusionStatusFlag != null &&
    SET_FLAG_VALUES.has(row.exclusionStatusFlag.trim().toLowerCase());

  if (!flagSet) {
    return {
      ...base,
      state: 'none_observed',
      explanation:
        'The provider reported no exclusion when Capiro last asked. This is an observation at a moment, not a clearance.',
    };
  }

  if (row.exclusionEndDate != null && row.exclusionEndDate.getTime() < asOf.getTime()) {
    return {
      ...base,
      state: 'expired',
      // Never rendered as active, which is this phase's own acceptance line.
      explanation: `The provider recorded an exclusion that ended ${dateOnly(row.exclusionEndDate)}. It is not in force.`,
    };
  }

  const ageMs = asOf.getTime() - row.observedAt.getTime();
  if (ageMs > staleAfterDays * 86_400_000) {
    return {
      ...base,
      state: 'unverified',
      explanation: `The provider reported an exclusion when Capiro last asked, on ${dateOnly(row.observedAt)}, which is more than ${staleAfterDays} days ago. Capiro cannot say whether it still stands.`,
    };
  }

  return {
    ...base,
    state: 'active',
    explanation: `The provider reported an active exclusion against this UEI when Capiro last asked, on ${dateOnly(row.observedAt)}.`,
  };
}

function normalizeUei(value: string | null | undefined): string | null {
  const s = value?.trim();
  return s && s.length === 12 ? s : null;
}

function dateOnly(value: Date | null): string | null {
  // A DATE column, rendered as a date. `toISOString()` on UTC midnight shows
  // the previous day for every reader west of Greenwich — the trap P26 named.
  return value == null ? null : value.toISOString().slice(0, 10);
}
