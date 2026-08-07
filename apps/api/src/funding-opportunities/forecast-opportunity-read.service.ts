import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  buildClientOpportunityProfile,
  emptyAwardHistory,
} from './client-opportunity-profile.builder.js';
import { buildAwardHistoryIdentity, contractorIdsToResolve } from './award-history-identity.js';
import {
  asProfileReadClient,
  readAwardHistoryByBasis,
  readClientProfileFacts,
  resolveContractorUeis,
} from './client-opportunity-profile.repository.js';
import { missingProfileFields, profileIsTooThin } from './missing-profile-fields.js';
import {
  FORECAST_INBOX_SOURCE,
  readVisibleClientIds,
  toInboxForecastFacts,
  type InboxForecastFacts,
} from './funding-opportunity-inbox.service.js';
import { sourceRecordWhere } from './funding-opportunity-identity.js';
import { USABLE_ACQUISITION_POSITION_STATES } from './acquisition-position.js';
import { FundingOpportunitiesService } from './funding-opportunities.service.js';
import {
  scoreForecastRelevance,
  type ForecastRelevanceInput,
  type ForecastRelevanceResult,
} from './forecast-relevance.js';
import type { ForecastRecommendation } from './opportunity-recommendation.js';
import type { MissingProfileField, OpportunityDecision } from './funding-opportunities.types.js';

/**
 * Reading ONE agency procurement forecast, for one client (Funding
 * Opportunities P26).
 *
 * ── Why forecasts get their own read service and their own record shape ──────
 *
 * A `FundingOpportunity` (`funding-opportunities.types.ts`) carries three
 * things a forecast does not have and must never appear to have:
 *
 *   `responseDeadline`  — there is nothing to respond to. A forecast is an
 *                         agency saying what it expects to buy; the
 *                         solicitation that would carry a deadline does not
 *                         exist yet, and may never.
 *   `eligibility`       — nothing to be eligible FOR. `forecast-relevance.ts`'s
 *                         own doc spells this out: there is no determination to
 *                         make, so this shape has no eligibility field and no
 *                         input for one.
 *   money               — no `grantFunding`, no `contractValue`. The provider
 *                         states neither for this resource.
 *
 * Serving a forecast through `GET /opportunities/:source/:id` would mean
 * either inventing those three or returning a `FundingOpportunity` with holes
 * where a reader expects facts — and a hole in an eligibility field reads as
 * "not eligible", which is the exact class of false claim this program exists
 * to prevent. So `OPPORTUNITY_SOURCES` stays two entries wide, this is a
 * separate route with a separate shape, and
 * `funding-opportunity-identity.spec.ts`'s guard on
 * `funding-opportunities.service.ts` is preserved rather than widened.
 *
 * ── What this service does NOT do ────────────────────────────────────────────
 *
 * It writes nothing. There is no producer proposing forecast
 * `client_funding_opportunity` rows yet (P25's handoff says so explicitly, and
 * it remains true after this phase): this service READS a workflow row if one
 * exists — created by a human through the existing decision/action routes —
 * and otherwise reports `decision: null`, which is the honest state for a
 * record nobody has decided on.
 *
 * It is also the first REAL caller of `scoreForecastRelevance`. P25 shipped
 * that scorer with no caller by design; this phase supplies one, and does so
 * with signals derived by EXACT comparison only — see
 * {@link deriveForecastSignals}.
 */

/** What the forecast read returns. Deliberately NOT a `FundingOpportunity`. */
export interface ForecastOpportunityRecord {
  /** Always the literal. Present so a UI can switch on one field across rails. */
  source: typeof FORECAST_INBOX_SOURCE;
  /** Tango's own forecast id — the value the URL and the workflow row carry. */
  sourceRecordId: string;
  /** The agency system's own id for the record, when it states one. */
  externalId: string | null;

  title: string;
  /** The provider's description. Untrusted source text — never an instruction. */
  description: string | null;

  /** The provider's flat agency label. Not always consistent with the hierarchy. */
  agency: string | null;
  departmentName: string | null;
  organizationAgencyName: string | null;
  officeName: string | null;

  /** Source facts that also appear on the inbox card, shaped identically. */
  facts: InboxForecastFacts;

  naicsCode: string | null;
  /** ALWAYS NULL — confirmed absent from this provider resource (D-45). */
  pscCode: string | null;
  setAside: string | null;
  /** Free text naming a vehicle, e.g. "To Be Determined". Never a structured link. */
  contractVehicle: string | null;
  /** Free text, not a structured address. */
  placeOfPerformance: string | null;

  primaryContact: {
    name: string | null;
    email: string | null;
    phone: string | null;
    title: string | null;
  } | null;

  /** ALWAYS NULL — confirmed absent from this provider resource (D-45). */
  sourceUrl: string | null;

  /**
   * The stage-appropriate recommendation, or null when there is no client to
   * recommend anything relative to. Never a `MachineRecommendation` of
   * `'pursue'` — see `FORECAST_TO_MACHINE_RECOMMENDATION`.
   */
  recommendation: ForecastRecommendationView | null;

  /** The client this is scored against, or null on the unscoped read. */
  clientId: string | null;
  /** The team's persisted decision, or null when nobody has decided. */
  decision: OpportunityDecision | null;
  /** The existing workflow row's id and status, when one exists. */
  workflow: { id: string; status: string } | null;

  /**
   * The SAM/Grants.gov record this forecast eventually became, once such a link
   * exists.
   *
   * ALWAYS NULL today, and that is a design statement rather than a TODO: the
   * only ways to link a forecast to a later notice are an exact identifier the
   * provider does not publish for this resource, or inference from title/text —
   * and inferring identity from free text is precisely what P02 forbids. The
   * Tango↔SAM crosswalk (P27) is the phase that can establish an exact link.
   * Until then this reads as "not yet linked", never as "no solicitation
   * followed".
   */
  linkedOpportunity: null;

  /** Profile gaps costing this client forecast matches. Empty on the unscoped read. */
  missingProfileFields: MissingProfileField[];

  generatedAt: string;
}

/** The read-model of a forecast recommendation. Mirrors `ForecastRelevanceResult`. */
export interface ForecastRecommendationView extends ForecastRelevanceResult {
  /**
   * Which signals were actually established, as booleans, so a reader can see
   * that a missing signal was ABSENT rather than false-by-default. The reason
   * codes say what fired; this says what was looked at.
   */
  signals: ForecastSignalEvidence;
}

/**
 * Every signal `scoreForecastRelevance` takes, plus WHY the ones that can never
 * fire today cannot.
 *
 * `unavailable` is not a synonym for `false`. `pscCode` is confirmed absent from
 * the provider's forecast resource (D-45), and no strategic-priority review
 * workflow exists anywhere in this codebase — so those two signals are not
 * "the client does not match", they are "there is nothing to match against".
 * A UI that rendered them as plain false would be stating an absence of the
 * client's fit rather than an absence of data.
 */
export interface ForecastSignalEvidence {
  exactNaicsMatch: boolean;
  exactPscMatch: boolean;
  capabilityMatch: boolean;
  priorAgencyHistory: boolean;
  programElementLinkedSourceBacked: boolean;
  locationMatch: boolean;
  knownVehicleAccess: boolean;
  reviewedStrategicPriority: boolean;
  /** Signals that could not be evaluated at all, and the reason for each. */
  unavailable: Array<{ signal: string; reason: string }>;
}

// ── Normalization: exact only, deliberately narrow ───────────────────────────

/**
 * NAICS/PSC comparison form: uppercase alphanumerics, nothing else.
 *
 * Byte-for-byte the same rule `sam-opportunity-relevance.ts`'s own private
 * `normCode` uses, and deliberately WITHOUT that file's banded near-miss logic
 * (4-digit industry group, 2-character PSC category). `ForecastRelevanceInput`
 * declares `exactNaicsMatch` / `exactPscMatch` — exact is the contract, and a
 * near miss scored as a match here would silently widen what "exact" means for
 * the one caller P25's scorer has.
 */
function normCode(value: string | null | undefined): string {
  return (value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Lowercase, punctuation collapsed to single spaces. */
function norm(value: string | null | undefined): string {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Does `needle` appear in `haystack` as a WHOLE token run?
 *
 * Whole-token, not substring: a client capability of "air" must not match
 * "airport", "repair" or "millionaire". Both sides are normalized to
 * space-separated tokens first and the needle is required to sit on token
 * boundaries — which is what makes this a fact check rather than a fuzzy match.
 *
 * Tokens of two characters or fewer are refused outright. A capability keyword
 * of "IT" or "AI" matches somewhere in almost any government description, and a
 * signal that fires on almost everything is noise that reads as evidence.
 */
export function containsWholeToken(haystack: string | null, needle: string | null): boolean {
  const h = norm(haystack);
  const n = norm(needle);
  if (!h || !n || n.length <= 2) return false;
  return ` ${h} `.includes(` ${n} `);
}

/** The forecast facts {@link deriveForecastSignals} reads. */
export interface ForecastSignalSource {
  title: string;
  description: string | null;
  agency: string | null;
  departmentName: string | null;
  organizationAgencyName: string | null;
  naicsCode: string | null;
  pscCode: string | null;
  placeOfPerformance: string | null;
}

/** The client facts {@link deriveForecastSignals} reads. From `ClientOpportunityProfileV1.sam`. */
export interface ForecastSignalProfile {
  naicsCodes: string[];
  pscCodes: string[];
  capabilityKeywords: string[];
  programElementCodes: string[];
  priorAgencies: string[];
  facilityStates: string[];
}

/**
 * Agency-name comparison form.
 *
 * The same closed set of rewrites `normAgency` applies on the SAM rail
 * ("dept" → "department", "hq" → "headquarters", a trailing parenthetical
 * dropped), because prior-award history is stored with the awarding agency's
 * own spelling and the forecast carries the agency's. A closed rewrite list,
 * never fuzzy distance: this signal asserts "this client has won work from this
 * organisation", and a near miss is not that evidence.
 */
function normAgency(value: string | null | undefined): string {
  return norm(value)
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\bdept\b\.?/g, 'department')
    .replace(/\bhq\b/g, 'headquarters')
    .trim();
}

/**
 * US state comparison: the two-letter postal code, when the text states one as
 * a whole token.
 *
 * Deliberately NOT a geocoder and not a city-name match. `placeOfPerformance` on
 * this provider resource is free text with no structure at all, so the only
 * honest fact available is "the client has a facility in a state this text
 * names". Anything more would be an inference dressed as a location match.
 */
function statesNamedIn(text: string | null): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  for (const token of text.toUpperCase().split(/[^A-Z]+/)) {
    if (token.length === 2) out.add(token);
  }
  return out;
}

/**
 * The six establishable signals, plus the two that cannot be established today.
 *
 * PURE and DB-free, exactly like `scoreForecastRelevance` itself, so the whole
 * derivation is provable from fixtures.
 *
 * `knownVehicleAccess` is a parameter rather than derived here: it is a
 * CLIENT-level fact owned by P23's `AcquisitionPositionService`, gated by its
 * own `funding_opportunities_vehicle_fit` flag, and reading it is a database
 * call this function must not make.
 */
export function deriveForecastSignals(
  forecast: ForecastSignalSource,
  profile: ForecastSignalProfile,
  opts: { knownVehicleAccess: boolean; vehicleFitEnabled: boolean },
): ForecastSignalEvidence {
  const forecastNaics = normCode(forecast.naicsCode);
  const clientNaics = new Set(profile.naicsCodes.map(normCode).filter(Boolean));
  const exactNaicsMatch = forecastNaics !== '' && clientNaics.has(forecastNaics);

  const forecastPsc = normCode(forecast.pscCode);
  const clientPsc = new Set(profile.pscCodes.map(normCode).filter(Boolean));
  const exactPscMatch = forecastPsc !== '' && clientPsc.has(forecastPsc);

  // Title AND description, joined — a capability named only in the body of a
  // forecast is the same evidence as one named in its title.
  const text = [forecast.title, forecast.description].filter(Boolean).join(' ');
  const capabilityMatch = profile.capabilityKeywords.some((kw) => containsWholeToken(text, kw));

  // Every level of the provider's hierarchy, because prior-award history is
  // recorded against whichever level the award itself named.
  const forecastAgencies = [forecast.agency, forecast.departmentName, forecast.organizationAgencyName]
    .map(normAgency)
    .filter(Boolean);
  const priorAgencies = new Set(profile.priorAgencies.map(normAgency).filter(Boolean));
  const priorAgencyHistory = forecastAgencies.some((a) => priorAgencies.has(a));

  /**
   * A PE link is source-backed only when the client's own asserted PE code
   * appears VERBATIM in the forecast's own text.
   *
   * The same evidentiary bar `sam-opportunity-matcher.ts` requires before it
   * will auto-accept a PE match, and for the same reason: a PE number is an
   * identifier, and a NAICS or subject-matter coincidence is explicitly capped
   * at `quarantined` there, never `accepted`. `forecast-relevance.ts`'s input is
   * named `programElementLinkedSourceBacked` precisely so a weaker link cannot
   * be passed in as this one.
   */
  const upperText = (forecast.title + ' ' + (forecast.description ?? '')).toUpperCase();
  const programElementLinkedSourceBacked = profile.programElementCodes
    .map((c) => c.trim().toUpperCase())
    .filter((c) => c.length >= 4)
    .some((code) => upperText.includes(code));

  const forecastStates = statesNamedIn(forecast.placeOfPerformance);
  const locationMatch = profile.facilityStates
    .map((s) => (s ?? '').trim().toUpperCase())
    .filter((s) => s.length === 2)
    .some((s) => forecastStates.has(s));

  const unavailable: Array<{ signal: string; reason: string }> = [];
  if (forecast.pscCode == null) {
    unavailable.push({
      signal: 'exactPscMatch',
      reason:
        'This provider resource states no product/service code at all, so there is nothing to compare against the client’s PSC codes.',
    });
  }
  if (!opts.vehicleFitEnabled) {
    unavailable.push({
      signal: 'knownVehicleAccess',
      reason:
        'Acquisition-position scoring is not enabled for this workspace, so the client’s contract-vehicle access was not read.',
    });
  }
  unavailable.push({
    signal: 'reviewedStrategicPriority',
    reason:
      'No reviewed strategic-priority watch list exists yet, so this signal cannot be established for any client.',
  });

  return {
    exactNaicsMatch,
    exactPscMatch,
    capabilityMatch,
    priorAgencyHistory,
    programElementLinkedSourceBacked,
    locationMatch,
    knownVehicleAccess: opts.vehicleFitEnabled ? opts.knownVehicleAccess : false,
    // Always false, and `unavailable` above says why. Not a claim about the client.
    reviewedStrategicPriority: false,
    unavailable,
  };
}

/** Compose the signal evidence into `scoreForecastRelevance`'s own input shape. */
export function toForecastRelevanceInput(
  facts: { isActive: boolean | null; anticipatedAwardDate: string | null },
  signals: ForecastSignalEvidence,
  profileTooThin: boolean,
  asOf: Date,
): ForecastRelevanceInput {
  return {
    isActive: facts.isActive,
    profileTooThin,
    exactNaicsMatch: signals.exactNaicsMatch,
    exactPscMatch: signals.exactPscMatch,
    capabilityMatch: signals.capabilityMatch,
    priorAgencyHistory: signals.priorAgencyHistory,
    programElementLinkedSourceBacked: signals.programElementLinkedSourceBacked,
    locationMatch: signals.locationMatch,
    knownVehicleAccess: signals.knownVehicleAccess,
    reviewedStrategicPriority: signals.reviewedStrategicPriority,
    anticipatedAwardDate: facts.anticipatedAwardDate,
    asOf,
  };
}

/**
 * Which team actions a forecast admits — and, explicitly, which it does not.
 *
 * `pursue` and `submit` are ABSENT by construction rather than by a UI
 * decision. There is no solicitation to submit against and no response window
 * to pursue within, so offering either would invite a team to act on a
 * competition that does not exist. A human who wants to treat a forecast as a
 * pursuit must first qualify it — an explicit, separate act on a real notice.
 *
 * `monitor` and `pass` are the two `HUMAN_DECISIONS` values that survive the
 * translation; `assign_research` and `plan_capability_briefing` are pursuit-plan
 * actions, not decisions, and map to task creation rather than to a decision
 * column.
 */
export const FORECAST_ACTIONS = [
  'monitor',
  'assign_research',
  'plan_capability_briefing',
  'pass',
] as const;
export type ForecastAction = (typeof FORECAST_ACTIONS)[number];

/** Actions a forecast NEVER offers, pinned so a UI change cannot add one quietly. */
export const FORECAST_FORBIDDEN_ACTIONS = ['pursue', 'submit'] as const;

/**
 * Reader seam for the two database reads this service needs. Injected as a
 * closure over the real Prisma client in the constructor, and replaced wholesale
 * in tests — the same seam `AcquisitionPositionService` (P23) uses, and for the
 * same reason: a fake at this boundary tests the composition without asserting
 * against a hand-emulated Prisma.
 */
export interface ForecastReadPort {
  /** The forecast row, or null when Capiro holds no such record. */
  readForecast(forecastId: string): Promise<ForecastRow | null>;
  /** Client ids the actor may see, per the shared ethical-wall rule. */
  readVisibleClientIds(tenantId: string, actorUserId: string): Promise<string[]>;
  /** The client's existing decision context for this forecast, if any. */
  readWorkflow(tenantId: string, clientId: string, forecastId: string): Promise<WorkflowRow | null>;
  /** The shared versioned profile, and whether it is too thin to judge with. */
  readProfile(tenantId: string, clientId: string): Promise<ProfileForForecast | null>;
  /** P23's client-level vehicle posture, already flag-gated by the caller. */
  readVehicleAccess(tenantId: string, clientId: string): Promise<{ enabled: boolean; hasAccess: boolean }>;
}

export interface ForecastRow extends ForecastSignalSource {
  tangoForecastId: string;
  externalId: string | null;
  officeName: string | null;
  setAside: string | null;
  contractVehicle: string | null;
  primaryContactName: string | null;
  primaryContactEmail: string | null;
  primaryContactPhone: string | null;
  primaryContactTitle: string | null;
  sourceUrl: string | null;
  anticipatedAwardDate: Date | null;
  estimatedPeriod: string | null;
  fiscalYear: number | null;
  sourceSystem: string | null;
  status: string | null;
  isActive: boolean | null;
  lastSyncedAt: Date | null;
  providerModifiedAt: Date | null;
}

export interface WorkflowRow {
  id: string;
  workflowStatus: string;
  humanDecision: string | null;
  decisionReason: string | null;
  decisionAt: Date | null;
  decisionByUserId: string | null;
  nextAction: string | null;
  nextActionDueAt: Date | null;
}

export interface ProfileForForecast {
  signals: ForecastSignalProfile;
  tooThin: boolean;
  missingProfileFields: MissingProfileField[];
}

@Injectable()
export class ForecastOpportunityReadService {
  private readonly logger = new Logger(ForecastOpportunityReadService.name);
  private readonly port: ForecastReadPort;

  constructor(
    private readonly prisma: PrismaService,
    private readonly opportunities: FundingOpportunitiesService,
  ) {
    this.port = this.buildPort();
  }

  /**
   * One forecast, for one client.
   *
   * `clientId` is OPTIONAL and, when supplied, intersected with the ethical wall
   * exactly as the inbox does — an id the actor cannot see is DROPPED and the
   * response reports `clientId: null`, rather than 403'ing in a way that would
   * confirm the client exists.
   */
  async getForecast(
    tenantId: string,
    actorUserId: string,
    forecastId: string,
    clientId: string | null,
    asOf: Date = new Date(),
  ): Promise<ForecastOpportunityRecord> {
    const trimmed = forecastId?.trim();
    if (!trimmed) throw new BadRequestException('A forecast id is required.');

    const forecast = await this.port.readForecast(trimmed);
    // 404, not an empty record. "We hold no such forecast" and "the agency
    // forecast nothing" are different facts and the second one is never true.
    if (!forecast) throw new NotFoundException('No such agency forecast.');

    let appliedClientId: string | null = null;
    if (clientId) {
      const visible = await this.port.readVisibleClientIds(tenantId, actorUserId);
      appliedClientId = visible.includes(clientId) ? clientId : null;
    }

    const facts = toInboxForecastFacts(forecast);

    let recommendation: ForecastRecommendationView | null = null;
    let decision: OpportunityDecision | null = null;
    let workflow: { id: string; status: string } | null = null;
    let gaps: MissingProfileField[] = [];

    if (appliedClientId) {
      const [profile, workflowRow, vehicle] = await Promise.all([
        this.port.readProfile(tenantId, appliedClientId),
        this.port.readWorkflow(tenantId, appliedClientId, trimmed),
        this.readVehicleAccessSafely(tenantId, appliedClientId),
      ]);

      if (workflowRow) {
        workflow = { id: workflowRow.id, status: workflowRow.workflowStatus };
        decision = toDecision(workflowRow);
      }

      if (profile) {
        gaps = profile.missingProfileFields;
        const signals = deriveForecastSignals(forecast, profile.signals, {
          knownVehicleAccess: vehicle.hasAccess,
          vehicleFitEnabled: vehicle.enabled,
        });
        const scored = scoreForecastRelevance(
          toForecastRelevanceInput(facts, signals, profile.tooThin, asOf),
        );
        recommendation = { ...scored, signals };
      }
    }

    return {
      source: FORECAST_INBOX_SOURCE,
      sourceRecordId: forecast.tangoForecastId,
      externalId: forecast.externalId,
      title: forecast.title,
      description: forecast.description,
      agency: forecast.agency,
      departmentName: forecast.departmentName,
      organizationAgencyName: forecast.organizationAgencyName,
      officeName: forecast.officeName,
      facts,
      naicsCode: forecast.naicsCode,
      pscCode: forecast.pscCode,
      setAside: forecast.setAside,
      contractVehicle: forecast.contractVehicle,
      placeOfPerformance: forecast.placeOfPerformance,
      primaryContact: hasContact(forecast)
        ? {
            name: forecast.primaryContactName,
            email: forecast.primaryContactEmail,
            phone: forecast.primaryContactPhone,
            title: forecast.primaryContactTitle,
          }
        : null,
      sourceUrl: forecast.sourceUrl,
      recommendation,
      clientId: appliedClientId,
      decision,
      workflow,
      linkedOpportunity: null,
      missingProfileFields: gaps,
      generatedAt: asOf.toISOString(),
    };
  }

  /**
   * The vehicle-access read, degraded to "not enabled" on ANY failure.
   *
   * The same posture `funding-opportunities.service.ts` takes for the same
   * signal: an additive input must never be the reason a record fails to load.
   * Degrading to `enabled: false` also keeps the failure VISIBLE — the response
   * says the signal was unavailable and why, rather than reporting a confident
   * `knownVehicleAccess: false`.
   */
  private async readVehicleAccessSafely(
    tenantId: string,
    clientId: string,
  ): Promise<{ enabled: boolean; hasAccess: boolean }> {
    try {
      return await this.port.readVehicleAccess(tenantId, clientId);
    } catch (error) {
      this.logger.warn(
        `vehicle-access read failed; knownVehicleAccess will be reported unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { enabled: false, hasAccess: false };
    }
  }

  /** Replace the reader wholesale. Test seam only. */
  withPort(port: ForecastReadPort): this {
    (this as unknown as { port: ForecastReadPort }).port = port;
    return this;
  }

  private buildPort(): ForecastReadPort {
    return {
      readForecast: async (forecastId) =>
        // tenant-scope-exempt: `tango_procurement_forecast` is a GLOBAL
        // provider reference table with no tenant_id and no RLS (P24), the
        // same category as `federal_grant` and `sam_opportunity`. Read under
        // withSystem for that reason, and it holds no tenant data to leak.
        this.prisma.withSystem((tx) =>
          tx.tangoProcurementForecast.findUnique({
            where: { tangoForecastId: forecastId },
            select: FORECAST_SELECT,
          }),
        ),

      readVisibleClientIds: async (tenantId, actorUserId) =>
        this.prisma.withTenant(tenantId, (tx) => readVisibleClientIds(tx, tenantId, actorUserId)),

      readWorkflow: async (tenantId, clientId, forecastId) =>
        this.prisma.withTenant(tenantId, (tx) =>
          tx.clientFundingOpportunity.findFirst({
            where: {
              tenantId,
              clientId,
              ...sourceRecordWhere(FORECAST_INBOX_SOURCE, forecastId),
            },
            select: {
              id: true,
              workflowStatus: true,
              humanDecision: true,
              decisionReason: true,
              decisionAt: true,
              decisionByUserId: true,
              nextAction: true,
              nextActionDueAt: true,
            },
          }),
        ),

      readProfile: async (tenantId, clientId) => {
        // The SHARED profile path (P01/P21), never a second profile-building
        // site: the whole point of `client-opportunity-profile.*` is that
        // read-time and producers consume one builder. A forecast is a third
        // consumer of the same profile, not a reason for a fourth builder.
        const facts = await this.prisma.withTenant(tenantId, (tx) =>
          readClientProfileFacts(asProfileReadClient(tx), { clientId }),
        );
        if (!facts) return null;

        // Award history reads GLOBAL tables and is the slow half, so it stays
        // OUTSIDE the tenant transaction above — the same boundary P01
        // established and `readClientFacts` keeps.
        //
        // Degrades to empty history rather than failing the read, matching the
        // read path's posture (the producers deliberately do not: see the
        // repository's own docblock). An empty history means the
        // prior-agency-history signal cannot fire, which the response reports
        // as an absent signal rather than as a negative finding.
        let history;
        try {
          const contractorUeis = await resolveContractorUeis(
            this.prisma,
            contractorIdsToResolve([facts]),
          );
          history = await readAwardHistoryByBasis(
            this.prisma,
            buildAwardHistoryIdentity(facts, contractorUeis),
          );
        } catch (error) {
          this.logger.warn(
            `award-history read failed; prior-agency history will not fire for this forecast: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          history = emptyAwardHistory();
        }

        const profile = buildClientOpportunityProfile(facts, history);
        return {
          signals: {
            naicsCodes: profile.sam.naicsCodes,
            pscCodes: profile.sam.pscCodes,
            capabilityKeywords: profile.sam.capabilityKeywords,
            programElementCodes: profile.sam.programElementCodes,
            priorAgencies: profile.sam.priorAgencies,
            facilityStates: profile.sam.facilityStates,
          },
          tooThin: profileIsTooThin(profile.completeness),
          // Scoped to the SAM rail's gap list: a forecast is a contract-side
          // signal, so telling somebody their Grants.gov applicant types are
          // missing would be noise.
          missingProfileFields: missingProfileFields(profile.completeness, 'sam_gov'),
        };
      },

      /**
       * P23's posture, through the CATALOG service's own accessor rather than a
       * second `AcquisitionPositionService` built here.
       *
       * Building one locally would mean a second copy of P23's reader closure
       * (four Prisma reads and a Tango-store read), and two copies of a
       * flag-gated signal is how the two rails end up disagreeing about the
       * same client — the exact drift P01 existed to remove for profiles.
       */
      readVehicleAccess: async (tenantId, clientId) => {
        const position = await this.opportunities.getClientAcquisitionPosition(tenantId, clientId);
        // null means the vehicle-fit flag is off for this tenant, which is NOT
        // "no access" — the caller reports it as unavailable, with a reason.
        if (position == null) return { enabled: false, hasAccess: false };
        return {
          enabled: true,
          hasAccess: (USABLE_ACQUISITION_POSITION_STATES as readonly string[]).includes(
            position.state,
          ),
        };
      },
    };
  }
}

/** The columns the forecast read selects. One place, so the row type cannot drift. */
export const FORECAST_SELECT = {
  tangoForecastId: true,
  externalId: true,
  title: true,
  description: true,
  agency: true,
  departmentName: true,
  organizationAgencyName: true,
  officeName: true,
  naicsCode: true,
  pscCode: true,
  setAside: true,
  contractVehicle: true,
  placeOfPerformance: true,
  primaryContactName: true,
  primaryContactEmail: true,
  primaryContactPhone: true,
  primaryContactTitle: true,
  sourceUrl: true,
  anticipatedAwardDate: true,
  estimatedPeriod: true,
  fiscalYear: true,
  sourceSystem: true,
  status: true,
  isActive: true,
  lastSyncedAt: true,
  providerModifiedAt: true,
} satisfies Prisma.TangoProcurementForecastSelect;

function hasContact(row: ForecastRow): boolean {
  return (
    row.primaryContactName != null ||
    row.primaryContactEmail != null ||
    row.primaryContactPhone != null ||
    row.primaryContactTitle != null
  );
}

/**
 * The persisted decision, or null.
 *
 * Returns null unless the row carries BOTH a decision and its actor+timestamp —
 * the three-way all-or-nothing the P07 migration's own
 * `client_funding_opportunity_decision_actor_chk` already enforces at the
 * database level. Reporting a decision without who made it and when would be a
 * decision nobody can be asked about later, which is the state that CHECK
 * exists to make impossible.
 */
export function toDecision(row: WorkflowRow): OpportunityDecision | null {
  if (!row.humanDecision || !row.decisionAt || !row.decisionByUserId) return null;
  return {
    decision: row.humanDecision as OpportunityDecision['decision'],
    reason: row.decisionReason ?? null,
    decidedAt: row.decisionAt.toISOString(),
    decidedByUserId: row.decisionByUserId,
    nextAction: row.nextAction ?? null,
    nextActionDueAt: row.nextActionDueAt ? row.nextActionDueAt.toISOString() : null,
  };
}

/** Re-exported so a UI mirror has one import site for the forecast vocabulary. */
export type { ForecastRecommendation };
