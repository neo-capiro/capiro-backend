import { Injectable, Logger } from '@nestjs/common';
import { hasAtLeast, type TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { FundingOpportunitiesService } from './funding-opportunities.service.js';
import { GovernmentLandscapeService } from './government-landscape.service.js';
import { readVisibleClientIds } from './funding-opportunity-inbox.service.js';
import {
  FUNDING_OPPORTUNITIES_MERI_V2_FEATURE,
  isFundingOpportunitiesFeatureEnabled,
} from './funding-opportunities-flag.guard.js';
import { explainOpportunity } from './opportunity-explanation.js';
import { OPPORTUNITY_SOURCES, type FundingOpportunity, type OpportunitySource } from './funding-opportunities.types.js';

/**
 * Typed, local, read-only Meri tools for Funding Opportunities (P37).
 *
 * ── Why this file lives HERE and not in src/meri/ ────────────────────────────
 *
 * The dependency runs ONE way: Meri imports Funding Opportunities. This module
 * has no `imports` array at all (see funding-opportunities.module.ts's own
 * docblock for why that is deliberate), and importing MeriModule to register a
 * tool would invert that — MeriModule already imports eleven feature modules,
 * so the cycle would be immediate and would surface as a Nest bootstrap failure
 * rather than a compile error. The plan states the constraint outright; this
 * file is where it is enforced structurally, and
 * meri-opportunity-tools.spec.ts asserts the import graph rather than trusting
 * a convention.
 *
 * ── Local data ONLY ──────────────────────────────────────────────────────────
 *
 * Nothing here reaches MakeGov/Tango, and nothing here can. The adapter's whole
 * dependency set is PrismaService and two sibling services that read Capiro's
 * own normalized tables; there is no gateway, no client, no config read for a
 * key. That is plan §4.1's "normal product reads never depend on a live MakeGov
 * request", applied to the surface most likely to be tempted — a model asking a
 * question the local tables cannot answer. The honest reply is "Capiro does not
 * hold this", which every tool below can express.
 *
 * ── Refusals are RESULTS, not exceptions ─────────────────────────────────────
 *
 * A route guard throws 404 because a browser can render an error page. A Meri
 * tool result is text the model reads mid-turn: a thrown exception there either
 * kills the turn or arrives as an opaque stack-shaped string the model then
 * paraphrases to the user. So every refusal below is a typed `state` the model
 * can quote accurately — `disabled`, `denied`, `not_found`, `unsupported_source`
 * — and every one of them carries wording that says what Capiro did, never what
 * is true of the world. `denied` in particular reads identically whether or not
 * the client exists, for the same reason P33's denied packet keeps the same
 * fingerprint an empty one has.
 *
 * ── Deterministic, and no clock of its own ───────────────────────────────────
 *
 * Every method takes an `asOf` and passes it down. Two calls with the same facts
 * and the same `asOf` produce the same bytes, which is what makes the tools
 * testable against a fixture instead of against a moment.
 */

/**
 * P37's flag, re-exported from the guard file where every other Funding
 * Opportunities flag constant lives.
 *
 * Declared THERE rather than here because P38's assessment route reads the same
 * flag as a route guard: one constant, two readings, no chance of a guard and a
 * data-shape check drifting into disagreeing about what enabled means.
 */
export { FUNDING_OPPORTUNITIES_MERI_V2_FEATURE };

/**
 * The six tools, as a closed list.
 *
 * Exported so the registration spec can assert the Meri-side surface matches
 * this one exactly. A tool added here and not wired into `meri-tools.service.ts`
 * — or the reverse — fails that spec rather than shipping half-registered.
 */
export const MERI_OPPORTUNITY_TOOLS = [
  'get_funding_opportunity',
  'explain_opportunity_match',
  'get_opportunity_client_context',
  'get_opportunity_government_landscape',
  'compare_funding_opportunities',
  'build_opportunity_action_plan',
] as const;
export type MeriOpportunityTool = (typeof MERI_OPPORTUNITY_TOOLS)[number];

/**
 * Every refusal a tool can return, and the one success value.
 *
 * `not_found` and `denied` are separate values and deliberately do NOT collapse:
 * "Capiro holds no such record" is a fact about Capiro's catalog, while "not
 * available for this client" is a fact about the reader's permissions. Merging
 * them would make the second usable to probe for the first.
 */
export const MERI_TOOL_STATES = [
  'available',
  'disabled',
  'denied',
  'not_found',
  'unsupported_source',
  'invalid_request',
] as const;
export type MeriToolState = (typeof MERI_TOOL_STATES)[number];

export interface MeriToolEnvelope<T> {
  tool: MeriOpportunityTool;
  state: MeriToolState;
  /** Why the state is what it is. Never a claim about the opportunity itself. */
  explanation: string;
  /** The caller's own `asOf`, echoed so a cached answer cannot look current. */
  asOf: string;
  data: T | null;
  /**
   * Collections this envelope shortened, and by how much. Present ONLY when
   * something was actually dropped — an absent field means nothing was, which is
   * a stronger statement than an empty array in a payload a model will read.
   */
  truncated?: Array<{ collection: string; kept: number; total: number }>;
}

/**
 * Per-collection caps.
 *
 * Deterministic counts rather than a byte budget applied at the end: a byte
 * budget drops whatever happens to be last, so the same query could return
 * different evidence on two runs as unrelated fields grow. Capping each
 * collection by rank keeps "which items survived" a property of the data, and
 * `truncated` states the loss outright instead of letting the model infer a
 * short list means a short answer.
 */
export const MERI_TOOL_CAPS = Object.freeze({
  signals: 12,
  landscapeItems: 40,
  actions: 12,
  comparisonRows: 5,
  topOpportunities: 5,
  summaryChars: 1_200,
});

/**
 * The last-resort ceiling, checked AFTER the per-collection caps above.
 *
 * It exists for the case the caps cannot cover — one pathological free-text
 * field — and when it fires it truncates that text rather than silently
 * shipping an oversized result into a context window. It has never been the
 * primary mechanism and must not become one: a payload reaching this bound is a
 * missing per-collection cap, not a tuning problem.
 */
export const MERI_TOOL_MAX_CHARS = 24_000;

interface ToolActor {
  tenantId: string;
  userId: string;
  role: TenantContext['role'];
}

/** A `<source>:<sourceRecordId>` pair, as every tool below accepts it. */
export interface OpportunityRef {
  source: OpportunitySource;
  sourceRecordId: string;
}

@Injectable()
export class MeriOpportunityToolsAdapter {
  private readonly logger = new Logger(MeriOpportunityToolsAdapter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly opportunities: FundingOpportunitiesService,
    private readonly landscape: GovernmentLandscapeService,
  ) {}

  // ── Gates, shared by every tool ───────────────────────────────────────────

  /**
   * Is P37 live for this tenant?
   *
   * Wrapped, unlike the guard's own call: `isFundingOpportunitiesFeatureEnabled`
   * deliberately does not catch (see its docblock), and a broken flag read here
   * must fail CLOSED and quietly. A Meri turn that dies because a feature-flag
   * query threw is a worse outcome than one that reports the capability off.
   */
  private async enabled(tenantId: string): Promise<boolean> {
    try {
      return await isFundingOpportunitiesFeatureEnabled(
        this.prisma,
        tenantId,
        FUNDING_OPPORTUNITIES_MERI_V2_FEATURE,
      );
    } catch (error) {
      this.logger.error(
        `${FUNDING_OPPORTUNITIES_MERI_V2_FEATURE} flag read failed for tenant ${tenantId}; failing closed`,
        error instanceof Error ? error.stack : String(error),
      );
      return false;
    }
  }

  /**
   * The three checks every tool makes, in the order that leaks least.
   *
   * FLAG first: a tenant without the capability learns nothing about its own
   * client roster from a tool that does not exist for them. ROLE second: a
   * portal user is refused before any client read is issued, so the refusal
   * costs no query and reveals no row. WALL last, and only then — it is the
   * check that needs the database.
   *
   * Returns `null` when everything passed; otherwise the envelope to return
   * verbatim.
   */
  private async gate<T>(
    tool: MeriOpportunityTool,
    actor: ToolActor,
    clientId: string,
    asOf: Date,
  ): Promise<MeriToolEnvelope<T> | null> {
    if (!(await this.enabled(actor.tenantId))) {
      return envelope(tool, 'disabled', asOf, DISABLED_EXPLANATION);
    }

    // `client_portal_user` ranks below `standard_user`, the same bar
    // FundingOpportunitiesController sets at the class level. A portal user has
    // no Funding Opportunities read path anywhere in this module and must not
    // acquire one by asking Meri instead of the API.
    if (!hasAtLeast(actor.role, 'standard_user')) {
      return envelope(tool, 'denied', asOf, DENIED_EXPLANATION);
    }

    if (!isUuid(clientId)) {
      // Refused as a REQUEST problem, not as a wall denial: a malformed id is
      // the model's mistake and telling it so gets a corrected retry, whereas
      // "not available for this client" invites it to give up on a real client.
      return envelope(tool, 'invalid_request', asOf, 'clientId must be a client UUID.');
    }

    const visible = await this.prisma.withTenant(actor.tenantId, (tx) =>
      readVisibleClientIds(tx, actor.tenantId, actor.userId),
    );
    if (!visible.includes(clientId)) {
      return envelope(tool, 'denied', asOf, DENIED_EXPLANATION);
    }
    return null;
  }

  // ── 1. get_funding_opportunity ────────────────────────────────────────────

  async getFundingOpportunity(
    actor: ToolActor,
    input: { clientId: string; source: string; sourceRecordId: string },
    asOf: Date = new Date(),
  ): Promise<MeriToolEnvelope<OpportunityFacts>> {
    const tool: MeriOpportunityTool = 'get_funding_opportunity';
    const refusal = await this.gate<OpportunityFacts>(tool, actor, input.clientId, asOf);
    if (refusal) return refusal;

    const source = asOpportunitySource(input.source);
    if (!source) return envelope(tool, 'unsupported_source', asOf, unsupportedSource(input.source));

    const row = await this.readOne(actor, source, input.sourceRecordId, input.clientId);
    if (!row) return envelope(tool, 'not_found', asOf, NOT_FOUND_EXPLANATION);

    return cap(
      envelope(tool, 'available', asOf, 'Local Capiro record. No provider call was made.', toFacts(row)),
    );
  }

  // ── 2. explain_opportunity_match ──────────────────────────────────────────

  async explainOpportunityMatch(
    actor: ToolActor,
    input: { clientId: string; source: string; sourceRecordId: string },
    asOf: Date = new Date(),
  ): Promise<MeriToolEnvelope<MatchExplanation>> {
    const tool: MeriOpportunityTool = 'explain_opportunity_match';
    const refusal = await this.gate<MatchExplanation>(tool, actor, input.clientId, asOf);
    if (refusal) return refusal;

    const source = asOpportunitySource(input.source);
    if (!source) return envelope(tool, 'unsupported_source', asOf, unsupportedSource(input.source));

    const row = await this.readOne(actor, source, input.sourceRecordId, input.clientId);
    if (!row) return envelope(tool, 'not_found', asOf, NOT_FOUND_EXPLANATION);

    const explained = explainOpportunity(row.matchedSignals);
    const total = explained.signals.length;
    const signals = explained.signals.slice(0, MERI_TOOL_CAPS.signals);

    const data: MatchExplanation = {
      ref: { source: row.source, sourceRecordId: row.sourceRecordId },
      title: row.title,
      // Relevance, eligibility, recommendation and the human decision are FOUR
      // fields here for the same reason they are four fields in the API: a model
      // handed one blended "score" would summarize them as one, and plan §4.5
      // keeps them separate precisely so nobody can.
      relevanceScore: row.relevanceScore,
      fitBand: explained.fitBand,
      fitLabel: explained.fitLabel,
      weakEvidenceOnly: explained.weakOnly,
      eligibility: row.eligibility,
      recommendation: row.recommendation,
      humanDecision: row.decision,
      acquisitionPosition: row.acquisitionPosition,
      signals: signals.map((s) => ({
        label: s.label,
        detail: s.detail,
        strength: s.strength,
        matchedOn: s.matchedOn,
        // The raw scorer key travels as evidence, deliberately. P09 keeps it out
        // of RENDERED card text; a tool result is not card text, and an operator
        // asking Meri "why" should be able to get back the exact key they would
        // find in the evidence panel.
        signal: s.signal,
      })),
      missingProfileFields: row.missingProfileFields,
    };

    const out = envelope(tool, 'available', asOf, EXPLANATION_NOTE, data);
    if (total > signals.length) {
      out.truncated = [{ collection: 'signals', kept: signals.length, total }];
    }
    return cap(out);
  }

  // ── 3. get_opportunity_client_context ─────────────────────────────────────

  async getOpportunityClientContext(
    actor: ToolActor,
    input: { clientId: string },
    asOf: Date = new Date(),
  ): Promise<MeriToolEnvelope<ClientContext>> {
    const tool: MeriOpportunityTool = 'get_opportunity_client_context';
    const refusal = await this.gate<ClientContext>(tool, actor, input.clientId, asOf);
    if (refusal) return refusal;

    const summary = await this.opportunities.getClientSummary(actor.tenantId, input.clientId);

    const data: ClientContext = {
      clientId: summary.clientId,
      counts: summary.counts,
      nextDeadline: summary.nextDeadline,
      // The profile GAPS are the point of this tool. A model that knows the
      // client has no recorded NAICS can say the fit is unassessable; one that
      // only sees a low score will report a bad fit, which is a different and
      // wrong claim.
      missingProfileFields: summary.missingProfileFields,
      // Freshness travels with every answer so "no matches" and "the catalog
      // has not synced" stay distinguishable.
      freshness: summary.freshness,
      emptyReason: summary.emptyReason,
      emptyExplanation: summary.emptyExplanation,
      topGrants: summary.topGrants.slice(0, MERI_TOOL_CAPS.topOpportunities).map(toBrief),
      topContracts: summary.topContracts.slice(0, MERI_TOOL_CAPS.topOpportunities).map(toBrief),
    };

    const out = envelope(tool, 'available', asOf, CLIENT_CONTEXT_NOTE, data);
    const dropped: MeriToolEnvelope<ClientContext>['truncated'] = [];
    if (summary.topGrants.length > data.topGrants.length) {
      dropped.push({
        collection: 'topGrants',
        kept: data.topGrants.length,
        total: summary.topGrants.length,
      });
    }
    if (summary.topContracts.length > data.topContracts.length) {
      dropped.push({
        collection: 'topContracts',
        kept: data.topContracts.length,
        total: summary.topContracts.length,
      });
    }
    if (dropped.length) out.truncated = dropped;
    return cap(out);
  }

  // ── 4. get_opportunity_government_landscape ───────────────────────────────

  async getOpportunityGovernmentLandscape(
    actor: ToolActor,
    input: { clientId: string; source: string; sourceRecordId: string },
    asOf: Date = new Date(),
  ): Promise<MeriToolEnvelope<LandscapeView>> {
    const tool: MeriOpportunityTool = 'get_opportunity_government_landscape';
    const refusal = await this.gate<LandscapeView>(tool, actor, input.clientId, asOf);
    if (refusal) return refusal;

    // P33 composes for SAM.gov only, and says so rather than returning a packet
    // in which every source reports `not_wired` — a page that says nothing.
    if (input.source !== 'sam_gov') {
      return envelope(
        tool,
        'unsupported_source',
        asOf,
        'Government landscape context is composed for SAM.gov contract opportunities. Nothing here says the other sources lack context — Capiro does not compose it for them yet.',
      );
    }

    let packet;
    try {
      packet = await this.landscape.compose(
        actor.tenantId,
        actor.userId,
        input.clientId,
        'sam_gov',
        input.sourceRecordId,
        asOf,
      );
    } catch (error) {
      // An identity the composer refuses is a malformed request, not a missing
      // record: saying "not found" would assert the catalog was searched.
      return envelope(tool, 'invalid_request', asOf, refusalMessage(error));
    }

    // The composer's OWN denied packet, mapped back to the envelope's `denied`.
    // Two representations of one fact would eventually disagree.
    //
    // Detected from the source states rather than a dedicated flag, because
    // P33's packet deliberately carries no `denied` field of its own — a denied
    // packet is byte-shaped like an empty one down to the fingerprint, and the
    // per-source `state` is the ONLY place the distinction survives. See
    // `isDeniedPacket`, which is exported so the spec can pin that coupling.
    if (isDeniedPacket(packet)) {
      return envelope(tool, 'denied', asOf, DENIED_EXPLANATION);
    }

    const total = packet.items.length;
    const items = packet.items.slice(0, MERI_TOOL_CAPS.landscapeItems);
    const out = envelope(
      tool,
      'available',
      asOf,
      'Composed from Capiro records only: reviewed Program Element links, client facilities, and state-level place-of-performance overlap.',
      {
        fingerprint: packet.fingerprint,
        coverage: packet.coverage,
        sources: packet.sources,
        items,
      } as LandscapeView,
    );
    if (total > items.length) {
      out.truncated = [{ collection: 'items', kept: items.length, total }];
    }
    return cap(out);
  }

  // ── 5. compare_funding_opportunities ──────────────────────────────────────

  async compareFundingOpportunities(
    actor: ToolActor,
    input: { clientId: string; opportunities: Array<{ source: string; sourceRecordId: string }> },
    asOf: Date = new Date(),
  ): Promise<MeriToolEnvelope<Comparison>> {
    const tool: MeriOpportunityTool = 'compare_funding_opportunities';
    const refusal = await this.gate<Comparison>(tool, actor, input.clientId, asOf);
    if (refusal) return refusal;

    const requested = Array.isArray(input.opportunities) ? input.opportunities : [];
    if (requested.length < 2) {
      return envelope(
        tool,
        'invalid_request',
        asOf,
        'Comparing needs at least two opportunities. Pass `opportunities` as a list of {source, sourceRecordId}.',
      );
    }

    const kept = requested.slice(0, MERI_TOOL_CAPS.comparisonRows);
    const rows: ComparisonRow[] = [];
    for (const ref of kept) {
      const source = asOpportunitySource(ref.source);
      if (!source) {
        rows.push({
          requested: { source: ref.source, sourceRecordId: ref.sourceRecordId },
          state: 'unsupported_source',
          explanation: unsupportedSource(ref.source),
          facts: null,
        });
        continue;
      }
      const row = await this.readOne(actor, source, ref.sourceRecordId, input.clientId);
      rows.push(
        row
          ? {
              requested: { source: ref.source, sourceRecordId: ref.sourceRecordId },
              state: 'available',
              explanation: 'Local Capiro record.',
              facts: toBrief(row),
            }
          : {
              requested: { source: ref.source, sourceRecordId: ref.sourceRecordId },
              state: 'not_found',
              explanation: NOT_FOUND_EXPLANATION,
              facts: null,
            },
      );
    }

    const out = envelope(tool, 'available', asOf, COMPARISON_NOTE, {
      clientId: input.clientId,
      // Every requested row appears, INCLUDING the ones that failed. A
      // comparison that silently omits the record it could not read is a
      // comparison the reader will believe is complete.
      rows,
    } as Comparison);
    if (requested.length > kept.length) {
      out.truncated = [
        { collection: 'rows', kept: kept.length, total: requested.length },
      ];
    }
    return cap(out);
  }

  // ── 6. build_opportunity_action_plan ──────────────────────────────────────

  async buildOpportunityActionPlan(
    actor: ToolActor,
    input: { clientId: string; source: string; sourceRecordId: string },
    asOf: Date = new Date(),
  ): Promise<MeriToolEnvelope<ActionPlanView>> {
    const tool: MeriOpportunityTool = 'build_opportunity_action_plan';
    const refusal = await this.gate<ActionPlanView>(tool, actor, input.clientId, asOf);
    if (refusal) return refusal;

    let result;
    try {
      result = await this.landscape.composeActionPlan(
        actor.tenantId,
        actor.userId,
        input.clientId,
        input.source,
        input.sourceRecordId,
        asOf,
      );
    } catch (error) {
      return envelope(tool, 'invalid_request', asOf, refusalMessage(error));
    }

    if (result.state === 'denied') return envelope(tool, 'denied', asOf, DENIED_EXPLANATION);
    if (result.state === 'unknown_record') {
      return envelope(tool, 'not_found', asOf, result.explanation);
    }

    const plan = result.plan!;
    const total = plan.actions.length;
    const actions = plan.actions.slice(0, MERI_TOOL_CAPS.actions);

    const out = envelope(
      tool,
      'available',
      asOf,
      // The one sentence this tool exists to make unmissable. P37's own scope
      // line is "returns proposals, not writes", and the adapter holds no
      // service through which it could write one — but a model reads the prose,
      // not the dependency list.
      'PROPOSALS ONLY. Nothing here is committed. Each action becomes real only when a person accepts it in Capiro, which creates the task and records the decision in one transaction.',
      {
        stage: plan.stage,
        // The composer's own sentence about WHY this state, not a second one
        // written here. P34 already words it for a reader.
        stageExplanation: result.explanation,
        fingerprint: plan.fingerprint,
        acceptance: result.acceptance,
        actions,
      } as ActionPlanView,
    );
    if (total > actions.length) {
      out.truncated = [{ collection: 'actions', kept: actions.length, total }];
    }
    return cap(out);
  }

  // ── Shared reads ──────────────────────────────────────────────────────────

  /**
   * One scored opportunity, or null.
   *
   * `getOpportunity` throws `NotFoundException` for a record the catalog does
   * not hold. Converted rather than propagated: see the file docblock on why a
   * refusal is a result here.
   */
  private async readOne(
    actor: ToolActor,
    source: OpportunitySource,
    sourceRecordId: string,
    clientId: string,
  ): Promise<FundingOpportunity | null> {
    try {
      return await this.opportunities.getOpportunity(
        actor.tenantId,
        source,
        sourceRecordId,
        clientId,
      );
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }
}

// ── Result shapes ───────────────────────────────────────────────────────────

export interface OpportunityBrief {
  ref: OpportunityRef;
  title: string;
  agency: string | null;
  kind: FundingOpportunity['kind'];
  isActive: boolean;
  isPursuable: boolean;
  responseDeadline: string | null;
  responseDeadlineNote: string | null;
  relevanceScore: number;
  eligibility: FundingOpportunity['eligibility'];
  recommendation: FundingOpportunity['recommendation'];
  humanDecision: FundingOpportunity['decision'];
  workflowStatus: string | null;
  sourceUrl: string | null;
  sourceUpdatedAt: string | null;
}

export interface OpportunityFacts extends OpportunityBrief {
  sourceReference: string | null;
  subAgency: string | null;
  office: string | null;
  status: string | null;
  postedDate: string | null;
  summary: string | null;
  summaryIsLink: boolean;
  naicsCodes: string[];
  pscCodes: string[];
  setAside: string | null;
  eligibleApplicantTypes: string[];
  assistanceListings: string[];
  /**
   * Grant funding and contract value stay in SEPARATE fields and are never
   * added. Plan §3's invariant, and the one a model is most likely to break if
   * handed a single `amount`.
   */
  grantFunding: FundingOpportunity['grantFunding'];
  contractValue: FundingOpportunity['contractValue'];
  placeOfPerformance: FundingOpportunity['placeOfPerformance'];
  acquisitionPosition: FundingOpportunity['acquisitionPosition'];
  missingProfileFields: FundingOpportunity['missingProfileFields'];
}

export interface MatchExplanation {
  ref: OpportunityRef;
  title: string;
  relevanceScore: number;
  fitBand: string;
  fitLabel: string;
  weakEvidenceOnly: boolean;
  eligibility: FundingOpportunity['eligibility'];
  recommendation: FundingOpportunity['recommendation'];
  humanDecision: FundingOpportunity['decision'];
  acquisitionPosition: FundingOpportunity['acquisitionPosition'];
  signals: Array<{
    signal: string;
    label: string;
    detail: string;
    strength: string;
    matchedOn: string;
  }>;
  missingProfileFields: FundingOpportunity['missingProfileFields'];
}

export interface ClientContext {
  clientId: string;
  counts: unknown;
  nextDeadline: unknown;
  missingProfileFields: unknown;
  freshness: unknown;
  emptyReason: string | null;
  emptyExplanation: string | null;
  topGrants: OpportunityBrief[];
  topContracts: OpportunityBrief[];
}

export interface LandscapeView {
  fingerprint: string;
  coverage: unknown;
  sources: unknown;
  items: unknown[];
}

export interface ComparisonRow {
  requested: { source: string; sourceRecordId: string };
  state: Extract<MeriToolState, 'available' | 'not_found' | 'unsupported_source'>;
  explanation: string;
  facts: OpportunityBrief | null;
}

export interface Comparison {
  clientId: string;
  rows: ComparisonRow[];
}

export interface ActionPlanView {
  stage: string;
  stageExplanation: string;
  fingerprint: string;
  acceptance: { wired: boolean; explanation: string };
  actions: unknown[];
}

// ── Pure helpers (exported for the spec) ────────────────────────────────────

const DISABLED_EXPLANATION =
  'Funding Opportunities assistance is not enabled for this workspace. This says nothing about whether the client has opportunities.';

/**
 * ONE string for both "you may not see this client" and "no such client".
 *
 * Identical wording is the whole mechanism: a distinguishable refusal turns the
 * tool into an oracle for which clients exist behind an ethical wall.
 */
const DENIED_EXPLANATION = 'Not available for this client.';

const NOT_FOUND_EXPLANATION =
  'Capiro holds no record for this opportunity. This says nothing about whether the notice exists at the source.';

const EXPLANATION_NOTE =
  'Relevance, eligibility, the machine recommendation and the team’s own decision are four separate facts. A strong relevance score is not eligibility, and neither is a decision.';

const CLIENT_CONTEXT_NOTE =
  'Client-side scoring inputs and coverage. `missingProfileFields` names what Capiro does not know — an unknown field is not a negative finding.';

const COMPARISON_NOTE =
  'Side-by-side local facts. Grant funding and contract value are never combined into one total; a row that could not be read is listed with its reason rather than dropped.';

function envelope<T>(
  tool: MeriOpportunityTool,
  state: MeriToolState,
  asOf: Date,
  explanation: string,
  data: T | null = null,
): MeriToolEnvelope<T> {
  return { tool, state, explanation, asOf: asOf.toISOString(), data };
}

/** Source vocabulary check. Returns null for anything outside it. */
export function asOpportunitySource(value: unknown): OpportunitySource | null {
  return typeof value === 'string' && (OPPORTUNITY_SOURCES as readonly string[]).includes(value)
    ? (value as OpportunitySource)
    : null;
}

function unsupportedSource(value: unknown): string {
  return `“${String(value)}” is not a Funding Opportunities source. Capiro reads ${OPPORTUNITY_SOURCES.join(' and ')}.`;
}

/**
 * Is this P33's denied packet?
 *
 * A denied packet is deliberately indistinguishable from an empty one by
 * fingerprint, coverage or item count — that is the leak P33 closed. Every
 * source carrying `state: 'denied'` is the one surviving marker, so this
 * predicate is the coupling point between the two phases, named and tested
 * rather than inlined as an `every()` somebody later "simplifies".
 *
 * Guards against the empty case: `[].every()` is `true`, and a packet with no
 * sources at all must not read as denied.
 */
export function isDeniedPacket(packet: {
  sources: ReadonlyArray<{ state: string }>;
}): boolean {
  return packet.sources.length > 0 && packet.sources.every((s) => s.state === 'denied');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status?: number }).status === 404
  );
}

/**
 * A refused composition, reworded for a model.
 *
 * The message is taken from the thrown `BadRequestException` because those
 * strings are already written for a human ("composed for SAM.gov contract
 * opportunities"). Anything else — a real bug — is reported as a refusal
 * without its message, so a stack-shaped string never reaches the transcript.
 */
function refusalMessage(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status?: number }).status === 400
  ) {
    const response = (error as { response?: { message?: unknown } }).response;
    const message = response?.message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return 'Capiro refused this request. Check the source and record id.';
}

export function toBrief(row: FundingOpportunity): OpportunityBrief {
  return {
    ref: { source: row.source, sourceRecordId: row.sourceRecordId },
    title: row.title,
    agency: row.agency,
    kind: row.kind,
    isActive: row.isActive,
    isPursuable: row.isPursuable,
    responseDeadline: row.responseDeadline,
    responseDeadlineNote: row.responseDeadlineNote,
    relevanceScore: row.relevanceScore,
    eligibility: row.eligibility,
    recommendation: row.recommendation,
    humanDecision: row.decision,
    workflowStatus: row.workflow?.status ?? null,
    sourceUrl: row.sourceUrl,
    sourceUpdatedAt: row.sourceUpdatedAt,
  };
}

export function toFacts(row: FundingOpportunity): OpportunityFacts {
  return {
    ...toBrief(row),
    sourceReference: row.sourceReference,
    subAgency: row.subAgency,
    office: row.office,
    status: row.status,
    postedDate: row.postedDate,
    summary: clampText(row.summary, MERI_TOOL_CAPS.summaryChars),
    summaryIsLink: row.summaryIsLink,
    naicsCodes: row.naicsCodes,
    pscCodes: row.pscCodes,
    setAside: row.setAside,
    eligibleApplicantTypes: row.eligibleApplicantTypes,
    assistanceListings: row.assistanceListings,
    grantFunding: row.grantFunding,
    contractValue: row.contractValue,
    placeOfPerformance: row.placeOfPerformance,
    acquisitionPosition: row.acquisitionPosition,
    missingProfileFields: row.missingProfileFields,
  };
}

/**
 * Trim free text, and SAY it was trimmed inside the text itself.
 *
 * The marker is inside the string rather than in a sibling field because this
 * value gets quoted: a model summarizing a truncated synopsis must not be able
 * to present the first 1,200 characters as the whole of what the notice
 * requires.
 */
export function clampText(value: string | null, max: number): string | null {
  if (value == null) return null;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}… [truncated by Capiro at ${max} characters; read the source record for the full text]`;
}

/**
 * The last-resort ceiling. See {@link MERI_TOOL_MAX_CHARS}.
 *
 * Replaces the payload with a refusal rather than shipping a half-serialized
 * object: a truncated JSON body is not something a model can read partially and
 * be right about.
 */
export function cap<T>(out: MeriToolEnvelope<T>): MeriToolEnvelope<T> {
  const size = JSON.stringify(out).length;
  if (size <= MERI_TOOL_MAX_CHARS) return out;
  return {
    tool: out.tool,
    state: 'invalid_request',
    explanation: `This result is ${size} characters, over Capiro’s ${MERI_TOOL_MAX_CHARS}-character tool limit. Narrow the request — ask about one opportunity rather than a comparison, or read the record in Capiro.`,
    asOf: out.asOf,
    data: null,
  };
}
