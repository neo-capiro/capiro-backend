import { createHash } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  FORECAST_INBOX_SOURCE,
  readVisibleClientIds,
  type InboxSource,
} from './funding-opportunity-access.js';
import { assertRequestSourceRecordId } from './funding-opportunity-identity.js';
import { NON_PURSUABLE_KINDS, type OpportunityKind } from './funding-opportunities.types.js';
import { samNoticeKind } from './opportunity-kind.js';
import { isSamActive } from './source-lifecycle.js';
import { buildActionPlan, type ActionPlan } from './opportunity-action-plan.js';
import {
  LANDSCAPE_SOURCES,
  type LandscapeItem,
  type LandscapePacket,
  type LandscapeSource,
  type LandscapeSourceReport,
  type LandscapeSourceState,
} from './government-landscape.types.js';

/**
 * Composing the Government Landscape packet (Funding Opportunities P33).
 *
 * ── Deterministic, and that is testable ──────────────────────────────────────
 *
 * Same facts in, byte-identical packet out — including the ORDER and the
 * fingerprint. Ordering is total (see {@link orderLandscapeItems}), so two
 * items that tie on every meaningful key still sort the same way every time,
 * and a packet whose hash moved means a FACT moved rather than a query
 * returning rows in a different order.
 *
 * No LLM, no generic web research, no clock inside the composition. The only
 * `new Date()` is the caller's `asOf`, which is a parameter.
 *
 * ── Verified beats inferred, and the two never merge ─────────────────────────
 *
 * A `source_backed` item exists because a source states it. An `inferred` one
 * exists because two things resemble each other. The PE rail is where this
 * bites: `sam_opportunity_match` carries a `review_status`, and only
 * `'accepted'` rows are source-backed. A `'candidate'` or `'quarantined'` row —
 * which is what a NAICS or keyword coincidence produces — is admitted as
 * `inferred` and excluded from every high-confidence action.
 *
 * Dropping those rows entirely would be the other tempting choice and it is
 * worse: a quarantined PE match is real information for a human deciding
 * whether to pursue, and hiding it means the reader has to go find the same
 * coincidence themselves. Labelling it is the honest middle.
 *
 * ── Missing sources lower COVERAGE; they never create a claim ────────────────
 *
 * Every declared source appears in `sources` with a state. `not_wired` means
 * Capiro cannot read it yet — distinct from `empty`, which means Capiro read it
 * and it holds nothing. An unwired source contributes no section, because an
 * empty "Hearings" heading is a claim about Congress that this packet cannot
 * support.
 *
 * ── One query per source, never one per item ─────────────────────────────────
 *
 * Every read below is a single bounded query. The composition itself is a
 * linear pass over already-loaded rows, so the packet costs the same whether it
 * holds two items or two hundred.
 */

/**
 * Sources Capiro reads today. Everything else in `LANDSCAPE_SOURCES` is
 * declared and reported `not_wired`.
 *
 * Kept as an explicit list rather than derived from "which reader exists",
 * because a reader that silently starts returning nothing would otherwise look
 * like a wired source with no data — the exact conflation `not_wired` exists to
 * prevent.
 */
export const WIRED_LANDSCAPE_SOURCES: ReadonlySet<LandscapeSource> = new Set<LandscapeSource>([
  'program_element',
  'client_facility',
  'congressional_district',
]);

const NOT_WIRED_EXPLANATION: Readonly<Partial<Record<LandscapeSource, string>>> = Object.freeze({
  budget_movement:
    'Verified funding movement is not yet joined to an opportunity. Nothing here says a Program Element has not moved.',
  legislation:
    'Related bills and amendments are not yet joined to an opportunity. Nothing here says none exist.',
  hearing: 'Hearings are not yet joined to an opportunity. Nothing here says none are scheduled.',
  regulation: 'Regulations are not yet joined to an opportunity. Nothing here says none apply.',
  committee:
    'Committee context is not yet joined to an opportunity. Nothing here says no committee has jurisdiction.',
  acquisition_personnel:
    'Acquisition personnel are not yet joined to an opportunity. Nothing here says none are identified.',
  reviewed_relationship:
    'Reviewed relationships are not yet joined to an opportunity. Nothing here says the client has none.',
  client_priority:
    'Client strategic priorities are not yet joined to an opportunity. Nothing here says the client has none.',
});

/**
 * The TOTAL order every packet is emitted in.
 *
 * Four keys, and the last is what makes it total: `source` groups, `basis` puts
 * source-backed before inferred (a reader should meet the verified evidence
 * first), `matchedOn` orders within a basis, and `sourceId` breaks a tie no
 * other key can. Without the fourth, two facilities in the same state would
 * sort by whatever order Postgres returned them in and the packet's fingerprint
 * would change without any fact changing.
 */
export function orderLandscapeItems(items: readonly LandscapeItem[]): LandscapeItem[] {
  const sourceRank = new Map(LANDSCAPE_SOURCES.map((s, i) => [s, i]));
  return [...items].sort((a, b) => {
    const bySource = (sourceRank.get(a.source) ?? 99) - (sourceRank.get(b.source) ?? 99);
    if (bySource !== 0) return bySource;
    if (a.basis !== b.basis) return a.basis === 'source_backed' ? -1 : 1;
    const byMatch = a.matchedOn.localeCompare(b.matchedOn);
    if (byMatch !== 0) return byMatch;
    return a.sourceId.localeCompare(b.sourceId);
  });
}

/**
 * Stable hash over the ordered items.
 *
 * Over the FACTS only — source, id, basis, matchedOn — and deliberately not
 * over `label`, `asOf` or `evidenceRef`. A label is composed prose that a copy
 * edit would change; `asOf` moves every time a source is re-observed with
 * identical content. Hashing either would make the fingerprint report "the
 * landscape changed" for a wording tweak or a re-sync, which is the noise a
 * fingerprint exists to filter out.
 */
export function landscapeFingerprint(ordered: readonly LandscapeItem[]): string {
  const canonical = ordered
    .map((i) => [i.source, i.sourceId, i.basis, i.matchedOn].join('\u0000'))
    .join('\u0001');
  return createHash('sha256').update(canonical).digest('hex');
}

/** Only a source-backed item may drive a high-confidence action. */
export function isHighConfidenceItem(item: Pick<LandscapeItem, 'basis'>): boolean {
  return item.basis === 'source_backed';
}

export interface LandscapePort {
  visibleClientIds(tenantId: string, actorUserId: string): Promise<string[]>;
  /** PE links on this notice, with their review status. */
  readProgramElementLinks(
    samOpportunityId: string,
  ): Promise<
    Array<{
      id: string;
      peCode: string | null;
      reviewStatus: string;
      matchBasis: string;
      asOf: Date | null;
    }>
  >;
  /** The client's own recorded sites. */
  readClientFacilities(
    tenantId: string,
    clientId: string,
  ): Promise<
    Array<{ id: string; name: string; state: string | null; congressionalDistrict: string | null }>
  >;
  /** The notice's stated place of performance, for a district/state overlap. */
  readNoticePlace(samOpportunityId: string): Promise<{ state: string | null } | null>;

  // ── P34. The non-landscape facts the action plan's stage rules need. ───────

  /**
   * The lifecycle facts for one record. Null when the record does not exist,
   * which the plan reports as an absence rather than guessing a stage.
   *
   * `asOf` is threaded through rather than read off the wall clock: whether a
   * notice is still open is a time-relative fact, and a composer that consulted
   * `new Date()` here could return two different plans for the same packet and
   * the same `asOf` — which is exactly the determinism the phase asks for.
   */
  readPlanLifecycle(
    source: InboxSource,
    sourceRecordId: string,
    asOf: Date,
  ): Promise<{ kind: OpportunityKind; isActive: boolean; responseDeadline: Date | null } | null>;

  /** How many P31 requirements exist for this notice. Zero is a real answer. */
  readRequirementCount(samOpportunityId: string): Promise<number>;

  /**
   * How many P22 vehicle positions the client holds.
   *
   * A PRESENCE check on `client_relevant_vehicle`, deliberately not P23's scored
   * `AcquisitionPosition`: that read is gated on the vehicle-fit flag, so keying
   * a plan prerequisite to it would make the plan announce "no vehicle access"
   * whenever an unrelated feature happens to be off. A row here means the client
   * or a parent entity holds a position; `known_teaming_route` has no producer
   * yet, so this can under-report a teaming route and can never over-report one.
   */
  readClientVehiclePositions(tenantId: string, clientId: string): Promise<number>;
}

/**
 * The action plan, or the reason there is not one (P34).
 *
 * `plan: null` under `denied` rather than an empty plan: an empty plan would
 * still have to state a STAGE, and naming a stage for a notice the caller may
 * not see is a claim about a record they were not allowed to read. The wording
 * is identical whether or not the client exists, for the same reason the denied
 * packet's fingerprint is.
 */
export const ACTION_PLAN_STATES = ['available', 'denied', 'unknown_record'] as const;
export type ActionPlanState = (typeof ACTION_PLAN_STATES)[number];

export interface ActionPlanResult {
  state: ActionPlanState;
  /** Why the state is what it is. Never a claim about the opportunity. */
  explanation: string;
  plan: ActionPlan | null;
  /**
   * Whether accepting an action can actually commit anything for this source.
   *
   * Forecast shaping actions use the same atomic review-task route as notices.
   * They never imply an application or create a pursuit.
   */
  acceptance: { wired: boolean; explanation: string };
}

/** Constant per source, and stated in the response rather than left to the UI. */
function acceptanceFor(source: string): ActionPlanResult['acceptance'] {
  return source === FORECAST_INBOX_SOURCE
    ? {
        wired: true,
        explanation:
          'Accepting a forecast action creates or reuses a review task. Forecasts can be watched; pursuit waits for a published solicitation.',
      }
    : {
        wired: true,
        explanation:
          'Accepting an action creates or reuses the matching task and records the decision in one transaction.',
      };
}

@Injectable()
export class GovernmentLandscapeService {
  private port: LandscapePort;

  constructor(private readonly prisma: PrismaService) {
    this.port = this.buildPort();
  }

  /** Replace the reader wholesale. Test seam only. */
  withPort(port: LandscapePort): this {
    (this as unknown as { port: LandscapePort }).port = port;
    return this;
  }

  async compose(
    tenantId: string,
    actorUserId: string,
    clientId: string,
    source: string,
    sourceRecordId: string,
    asOf: Date = new Date(),
  ): Promise<LandscapePacket> {
    if (source !== 'sam_gov') {
      // The PE rail and the place-of-performance overlap are both SAM.gov
      // constructs. A grant packet would be every source reporting `not_wired`,
      // which is a page that says nothing rather than an honest answer.
      throw new BadRequestException(
        'Government landscape context is composed for SAM.gov contract opportunities.',
      );
    }
    assertRequestSourceRecordId(source, sourceRecordId);

    // Ethical wall FIRST, using the SAME allow-list the inbox uses. A client the
    // actor may not see yields a DENIED packet rather than a 403: a 403 would
    // confirm the client exists.
    const visible = await this.port.visibleClientIds(tenantId, actorUserId);
    if (!visible.includes(clientId)) {
      return this.deniedPacket(clientId, source, sourceRecordId, asOf);
    }

    const [peLinks, facilities, place] = await Promise.all([
      this.port.readProgramElementLinks(sourceRecordId),
      this.port.readClientFacilities(tenantId, clientId),
      this.port.readNoticePlace(sourceRecordId),
    ]);

    const items: LandscapeItem[] = [];

    // ── Program Elements. Only an ACCEPTED review is source-backed.
    for (const link of peLinks) {
      if (link.peCode == null) continue;
      const accepted = link.reviewStatus === 'accepted';
      items.push({
        source: 'program_element',
        sourceId: link.id,
        label: accepted
          ? `Program Element ${link.peCode}, linked by a reviewed and accepted match (${link.matchBasis}).`
          : `Program Element ${link.peCode}, an UNREVIEWED match (${link.matchBasis}, ${link.reviewStatus}). Not evidence of a link.`,
        // A 'candidate' or 'quarantined' row is what a NAICS or keyword
        // coincidence produces. Admitted as inferred and excluded from every
        // high-confidence action — dropping it would hide real information a
        // human deciding whether to pursue can use.
        basis: accepted ? 'source_backed' : 'inferred',
        matchedOn: link.peCode,
        evidenceRef: `sam_opportunity_match:${link.id}`,
        asOf: link.asOf ? link.asOf.toISOString() : null,
      });
    }

    // ── Facilities. A recorded client site is a fact the client stated.
    for (const facility of facilities) {
      items.push({
        source: 'client_facility',
        sourceId: facility.id,
        label: `${facility.name}${facility.state ? ` (${facility.state})` : ''}`,
        basis: 'source_backed',
        matchedOn: facility.state ?? facility.name,
        evidenceRef: `client_facility:${facility.id}`,
        asOf: null,
      });

      // ── District overlap. A STATE match between the notice's stated place of
      // performance and a recorded facility. Source-backed on both sides, and
      // deliberately state-level: this program has no geocoder, and inferring a
      // district from a city name would be exactly the fabricated district
      // nexus `FundingOpportunity.districtBasis` already refuses to create.
      if (
        facility.congressionalDistrict != null &&
        place?.state != null &&
        facility.state != null &&
        facility.state.toUpperCase() === place.state.toUpperCase()
      ) {
        items.push({
          source: 'congressional_district',
          sourceId: `${facility.id}:${facility.congressionalDistrict}`,
          label: `${facility.state}-${facility.congressionalDistrict}: a recorded client facility sits in the state this notice names as its place of performance.`,
          basis: 'source_backed',
          matchedOn: `${facility.state}-${facility.congressionalDistrict}`,
          evidenceRef: `client_facility:${facility.id}`,
          asOf: null,
        });
      }
    }

    const ordered = orderLandscapeItems(items);
    const sources = this.reportSources(ordered, {
      peLinks: peLinks.length,
      facilities: facilities.length,
    });

    return {
      clientId,
      source,
      sourceRecordId,
      items: ordered,
      sources,
      coverage: {
        available: sources.filter((s) => s.state === 'available').length,
        wired: WIRED_LANDSCAPE_SOURCES.size,
        declared: LANDSCAPE_SOURCES.length,
      },
      fingerprint: landscapeFingerprint(ordered),
      generatedAt: asOf.toISOString(),
    };
  }

  /**
   * The deterministic action plan for one client-opportunity pair (P34).
   *
   * ── Composed from the packet, never from a second opinion ──────────────────
   *
   * The SAME `compose` above supplies the evidence, so an action can only ever
   * point at something the landscape panel is already showing. Recomputing the
   * links here would let the two disagree, and a plan that cites evidence the
   * panel does not display is a plan nobody can check.
   *
   * ── The wall comes first, and it is the same wall ──────────────────────────
   *
   * `compose` applies the ethical wall itself; this method applies it again
   * BEFORE reading anything else, because the lifecycle and requirement reads
   * below would otherwise run on behalf of a client the actor may not see. A
   * denied result names no stage — see {@link ActionPlanResult}.
   *
   * ── A forecast gets a plan without a landscape ─────────────────────────────
   *
   * `compose` is SAM.gov-only by design, so a forecast plan is built with an
   * empty landscape. That is honest rather than degraded: the stage rules for a
   * forecast produce shaping and monitoring actions that need no target, and the
   * one action that WOULD name a programme office carries an explicit
   * prerequisite saying why none is named.
   */
  async composeActionPlan(
    tenantId: string,
    actorUserId: string,
    clientId: string,
    source: string,
    sourceRecordId: string,
    asOf: Date = new Date(),
  ): Promise<ActionPlanResult> {
    if (source !== 'sam_gov' && source !== FORECAST_INBOX_SOURCE) {
      throw new BadRequestException(
        'An action plan is composed for SAM.gov contract opportunities and agency forecasts.',
      );
    }
    assertRequestSourceRecordId(source, sourceRecordId);

    // The wall FIRST. Identical wording and identical shape whether or not the
    // client exists, so the response cannot be used to probe for one.
    const visible = await this.port.visibleClientIds(tenantId, actorUserId);
    if (!visible.includes(clientId)) {
      return {
        state: 'denied',
        explanation: 'Not available for this client.',
        plan: null,
        acceptance: acceptanceFor(source),
      };
    }

    const lifecycle = await this.port.readPlanLifecycle(
      source as InboxSource,
      sourceRecordId,
      asOf,
    );
    if (lifecycle == null) {
      return {
        state: 'unknown_record',
        explanation:
          'Capiro holds no record for this opportunity, so there is no stage to plan against. This says nothing about whether the notice exists at the source.',
        plan: null,
        acceptance: acceptanceFor(source),
      };
    }

    // The landscape is SAM-only. A forecast plan is built from an empty one —
    // see the method note.
    const packet =
      source === 'sam_gov'
        ? await this.compose(tenantId, actorUserId, clientId, source, sourceRecordId, asOf)
        : null;

    const [requirementCount, vehiclePositions] = await Promise.all([
      source === 'sam_gov' ? this.port.readRequirementCount(sourceRecordId) : Promise.resolve(0),
      this.port.readClientVehiclePositions(tenantId, clientId),
    ]);

    const plan = buildActionPlan({
      source: source as InboxSource,
      sourceRecordId,
      clientId,
      kind: lifecycle.kind,
      isActive: lifecycle.isActive,
      // The SAME judgement the pursuit guard makes, read off the same list
      // rather than re-derived: a kind the writer refuses to pursue must not be
      // a kind the plan proposes pursuing.
      isPursuable: lifecycle.isActive && !NON_PURSUABLE_KINDS.has(lifecycle.kind),
      responseDeadline: lifecycle.responseDeadline?.toISOString() ?? null,
      landscape: packet?.items ?? [],
      hasRequirements: requirementCount > 0,
      hasVehicleAccess: vehiclePositions > 0,
      asOf,
    });

    return {
      state: 'available',
      explanation: 'Proposed actions only. Nothing here is committed until somebody accepts it.',
      plan,
      acceptance: acceptanceFor(source),
    };
  }

  /**
   * Every declared source, with its state.
   *
   * `empty` and `not_wired` are separate values because they are separate
   * facts: one says Capiro looked and found nothing, the other says Capiro
   * cannot look yet. Collapsing them turns "we have not built this" into "there
   * is nothing there", which is a claim about the world.
   */
  private reportSources(
    items: readonly LandscapeItem[],
    read: { peLinks: number; facilities: number },
  ): LandscapeSourceReport[] {
    const counts = new Map<LandscapeSource, number>();
    for (const item of items) counts.set(item.source, (counts.get(item.source) ?? 0) + 1);

    return LANDSCAPE_SOURCES.map((source) => {
      if (!WIRED_LANDSCAPE_SOURCES.has(source)) {
        return {
          source,
          state: 'not_wired' as LandscapeSourceState,
          itemCount: 0,
          explanation:
            NOT_WIRED_EXPLANATION[source] ??
            'Capiro does not read this source for an opportunity yet. Nothing here says it holds nothing.',
        };
      }
      const count = counts.get(source) ?? 0;
      if (count > 0) {
        return {
          source,
          state: 'available' as LandscapeSourceState,
          itemCount: count,
          explanation: `${count} item${count === 1 ? '' : 's'} from this source.`,
        };
      }
      // Read, and genuinely empty. A real finding, and worded as one.
      const readCount =
        source === 'program_element'
          ? read.peLinks
          : source === 'client_facility'
            ? read.facilities
            : 0;
      return {
        source,
        state: 'empty' as LandscapeSourceState,
        itemCount: 0,
        explanation:
          readCount > 0
            ? 'This source was read and none of its rows produced a usable link.'
            : 'This source was read and holds nothing for this client and opportunity.',
      };
    });
  }

  /**
   * The packet for a client the actor may not see.
   *
   * Every source `denied`, no items, and a fingerprint over an empty list — the
   * same fingerprint any genuinely empty packet has. That is deliberate: a
   * distinctive "denied" hash would let a caller detect that a walled client
   * exists by comparing hashes.
   */
  private deniedPacket(
    clientId: string,
    source: string,
    sourceRecordId: string,
    asOf: Date,
  ): LandscapePacket {
    return {
      clientId,
      source,
      sourceRecordId,
      items: [],
      sources: LANDSCAPE_SOURCES.map((s) => ({
        source: s,
        state: 'denied' as LandscapeSourceState,
        itemCount: 0,
        explanation: 'Not available for this client.',
      })),
      coverage: {
        available: 0,
        wired: WIRED_LANDSCAPE_SOURCES.size,
        declared: LANDSCAPE_SOURCES.length,
      },
      fingerprint: landscapeFingerprint([]),
      generatedAt: asOf.toISOString(),
    };
  }

  private buildPort(): LandscapePort {
    return {
      visibleClientIds: (tenantId, actorUserId) =>
        this.prisma.withTenant(tenantId, (tx) => readVisibleClientIds(tx, tenantId, actorUserId)),

      // tenant-scope-exempt: sam_opportunity_match hangs off sam_opportunity,
      // which is global federal reference data with no tenant_id.
      readProgramElementLinks: async (samOpportunityId) => {
        const rows = await this.prisma.withSystem((tx) =>
          tx.samOpportunityMatch.findMany({
            where: { opportunityId: samOpportunityId },
            orderBy: [{ peCode: 'asc' }, { id: 'asc' }],
            // Bounded. A notice with more than 50 PE matches is a data-quality
            // problem, not a landscape.
            take: 50,
            select: {
              id: true,
              peCode: true,
              reviewStatus: true,
              matchBasis: true,
              updatedAt: true,
            },
          }),
        );
        return rows.map((r) => ({
          id: r.id,
          peCode: r.peCode,
          reviewStatus: r.reviewStatus,
          matchBasis: r.matchBasis,
          asOf: r.updatedAt,
        }));
      },

      readClientFacilities: (tenantId, clientId) =>
        this.prisma.withTenant(tenantId, (tx) =>
          tx.clientFacility.findMany({
            where: { tenantId, clientId },
            orderBy: [{ name: 'asc' }, { id: 'asc' }],
            take: 100,
            select: { id: true, name: true, state: true, congressionalDistrict: true },
          }),
        ),

      readNoticePlace: async (samOpportunityId) => {
        // tenant-scope-exempt: sam_opportunity is global federal reference data.
        const row = await this.prisma.withSystem((tx) =>
          tx.samOpportunity.findUnique({
            where: { id: samOpportunityId },
            select: { placeOfPerformance: true },
          }),
        );
        if (row == null) return null;
        const place = row.placeOfPerformance as { state?: unknown } | null;
        const state =
          place != null && typeof place === 'object' && typeof place.state === 'string'
            ? place.state
            : null;
        return { state };
      },

      readPlanLifecycle: async (source, sourceRecordId, asOf) => {
        if (source === FORECAST_INBOX_SOURCE) {
          // tenant-scope-exempt: tango_procurement_forecast is global provider
          // catalog data with no tenant_id (P24).
          const row = await this.prisma.withSystem((tx) =>
            tx.tangoProcurementForecast.findUnique({
              where: { tangoForecastId: sourceRecordId },
              select: { isActive: true },
            }),
          );
          if (row == null) return null;
          return {
            // A forecast has no notice type. `other` is the honest kind, and the
            // stage rules never consult it — a forecast's stage comes from its
            // SOURCE, which is what makes the pursuit ban unconditional.
            kind: 'other' as OpportunityKind,
            // `null` means the provider never stated one. Treated as active,
            // because the alternative is telling a user a live forecast is dead
            // on the strength of a field the provider does not populate.
            isActive: row.isActive !== false,
            // A forecast has no response deadline. Never the award estimate:
            // there is nothing to respond to, so a due date derived from one
            // would be a deadline Capiro invented.
            responseDeadline: null,
          };
        }

        // tenant-scope-exempt: sam_opportunity is global federal reference data.
        const row = await this.prisma.withSystem((tx) =>
          tx.samOpportunity.findUnique({
            where: { id: sourceRecordId },
            select: {
              noticeType: true,
              active: true,
              responseDeadline: true,
              archiveDate: true,
            },
          }),
        );
        if (row == null) return null;
        return {
          kind: samNoticeKind(row.noticeType),
          isActive: isSamActive(
            {
              active: row.active,
              responseDeadline: row.responseDeadline,
              archiveDate: row.archiveDate,
            },
            asOf,
          ),
          responseDeadline: row.responseDeadline,
        };
      },

      // tenant-scope-exempt: opportunity_requirement is global — the artifact is
      // bound to the document's bytes, not to a tenant (P31).
      readRequirementCount: (samOpportunityId) =>
        this.prisma.withSystem((tx) =>
          tx.opportunityRequirement.count({
            where: { samOpportunityId, supersededAt: null },
          }),
        ),

      readClientVehiclePositions: (tenantId, clientId) =>
        this.prisma.withTenant(tenantId, (tx) =>
          tx.clientRelevantVehicle.count({ where: { tenantId, clientId } }),
        ),
    };
  }
}
