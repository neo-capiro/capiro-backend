/**
 * Acquisition position (Funding Opportunities P23): whether a client has a
 * CREDIBLE PATH to an acquisition, as distinct from legal eligibility
 * (`eligibility`) and probability of win (`recommendationConfidence`).
 *
 * ── What this is NOT ─────────────────────────────────────────────────────────
 *
 * It is not a seventh score, and it is not a crosswalk from a specific SAM/
 * Grants.gov opportunity to a specific Tango contract vehicle — no such
 * crosswalk exists in this codebase (that is P27+ scope, and neither this
 * phase's Prisma schema nor its migration list adds one). Nothing here
 * fabricates "this notice requires vehicle X" from a notice's free text —
 * this program's own award-history identity rules (P02) forbid fuzzy
 * name/text matching as an identity signal, and a vehicle requirement is an
 * identity claim exactly like a UEI match is.
 *
 * What this computes instead is the CLIENT'S OWN vehicle-access posture —
 * every relevant vehicle P22's sync has confirmed matters to this client, as
 * itself or as a related entity — surfaced as honest, deterministic context
 * on every opportunity. See decision-log D-44 for the full reasoning and for
 * why `vehicleAccessRequired` (the recommendation-engine hook this feeds,
 * in opportunity-recommendation.ts) is real, tested code with no live
 * trigger today.
 *
 * ── Deterministic states ─────────────────────────────────────────────────────
 *
 *   - direct_prime_access      the client itself holds a live vehicle position
 *   - related_entity_access    a PARENT entity holds one; the client itself does not
 *   - known_teaming_route      a known teaming partner holds one (real code path;
 *                              P22's sync only ever records 'self'/'parent' — no
 *                              producer emits 'teaming' evidence yet, matching
 *                              decision-log D-41's dormant-but-tested precedent)
 *   - no_direct_access_evidence  the sync HAS run and found vehicles, but every
 *                              one is expired, or none give current access
 *   - vehicle_not_identified   the sync HAS run for this client and found ZERO
 *                              relevant vehicles at all
 *   - unknown                  Tango is not configured, or the sync has never
 *                              completed a run — there is nothing to judge from
 *
 * `no_direct_access_evidence` and `vehicle_not_identified` are DELIBERATELY
 * separate, both to satisfy "absence of provider evidence is unknown/no
 * evidence, not 'cannot bid'": the first means "we found vehicles but none
 * currently work"; the second means "we found none at all". Neither is ever
 * rendered, or reasoned about downstream, as a bar to bidding — an
 * opportunity a client has no known vehicle route to can still be full and
 * open.
 *
 * RELATED-ENTITY ACCESS NEVER DISPLAYS AS DIRECT. `related_entity_access` and
 * `known_teaming_route` are real, credible routes — worth surfacing — but are
 * never returned as `direct_prime_access`, because "your parent can bid" and
 * "you can bid" are different answers to whether THIS client can submit
 * alone (the same distinction TangoVehicleAwardee.recipientParentUei's own
 * doc states, from the producer side).
 *
 * ── Precedence when a client has more than one relevant vehicle ─────────────
 *
 * The state reflects the BEST current access found: self beats parent beats
 * teaming beats expired-only beats none. `evidence` always lists EVERY
 * relevant vehicle found, best first, never just the winner — an operator
 * judging capture strategy needs to see the weaker routes too, not just the
 * headline.
 */

export const ACQUISITION_POSITION_STATES = [
  'direct_prime_access',
  'related_entity_access',
  'known_teaming_route',
  'vehicle_not_identified',
  'no_direct_access_evidence',
  'unknown',
] as const;
export type AcquisitionPositionState = (typeof ACQUISITION_POSITION_STATES)[number];

/**
 * 'teaming' is a real, scored relationship with no current producer. P22's
 * `client_relevant_vehicle` table CHECK-constrains its own `relationship`
 * column to 'self' | 'parent' only — no code anywhere writes 'teaming' today.
 * It stays in this vocabulary, not the persisted one, so a future teaming-
 * partner data source (a formal partner/JV registry Capiro does not have
 * yet) is a producer to add, not a scoring-function or schema change.
 */
export const ACQUISITION_RELATIONSHIPS = ['self', 'parent', 'teaming'] as const;
export type AcquisitionRelationship = (typeof ACQUISITION_RELATIONSHIPS)[number];

/** One relevant vehicle, as evidence for a client's acquisition position. */
export interface AcquisitionVehicleEvidence {
  tangoVehicleId: string;
  vehicleName: string | null;
  vehicleType: string | null;
  relationship: AcquisitionRelationship;
  /** The UEI that actually holds the position — the client's own for 'self', the related entity's for 'parent'/'teaming'. */
  recipientUei: string;
  /** Provider-reported past performance under this vehicle. Null = source did not state it, never coerced to 0. */
  orderCount: number | null;
  idvObligations: number | null;
  idvContractsValue: number | null;
  /** The vehicle's own ordering deadline, from its Tango snapshot. Null = source did not state one. */
  lastDateToOrder: string | null;
  /**
   * Derived from `lastDateToOrder` vs the caller's `asOf`. Null when the
   * source never stated a date — an unstated deadline is not evidence of
   * expiry, and must never be treated as "still open" either.
   */
  expired: boolean | null;
  lastSyncedAt: string;
}

export interface AcquisitionPosition {
  state: AcquisitionPositionState;
  /** Every relevant vehicle found, strongest access first. Empty when none. */
  evidence: AcquisitionVehicleEvidence[];
  /** One sentence, composed from facts. Never a probability, never "cannot bid". */
  summary: string;
  recommendedRoute: string;
  source: 'tango';
  freshness: {
    /** The sync's own last completed run, global (this sync walks every vehicle in one pass, not per-client). */
    lastSyncedAt: string | null;
    neverSynced: boolean;
  };
}

export interface AcquisitionPositionInput {
  /** False when Tango has no key configured at all. */
  configured: boolean;
  /** True when the vehicle-relevant sync (P22) has never completed a run. */
  neverSynced: boolean;
  lastSyncedAt: string | null;
  /** This client's own known relevant vehicles (P22), independent of any specific opportunity. */
  evidence: AcquisitionVehicleEvidence[];
  /** The caller's clock. Never `new Date()` inside this module — same rule as opportunity-recommendation.ts. */
  asOf: Date;
}

const RELATIONSHIP_RANK: Readonly<Record<AcquisitionRelationship, number>> = {
  self: 0,
  parent: 1,
  teaming: 2,
};

const STATE_FOR_RELATIONSHIP: Readonly<Record<AcquisitionRelationship, AcquisitionPositionState>> = {
  self: 'direct_prime_access',
  parent: 'related_entity_access',
  teaming: 'known_teaming_route',
};

function vehicleLabel(e: AcquisitionVehicleEvidence): string {
  return e.vehicleName ?? `vehicle ${e.tangoVehicleId}`;
}

/** Best (lowest rank) first; expired vehicles sort after every non-expired one of the same relationship. */
function sortEvidence(evidence: readonly AcquisitionVehicleEvidence[]): AcquisitionVehicleEvidence[] {
  return [...evidence].sort((a, b) => {
    const aExpired = a.expired === true;
    const bExpired = b.expired === true;
    if (aExpired !== bExpired) return aExpired ? 1 : -1;
    return RELATIONSHIP_RANK[a.relationship] - RELATIONSHIP_RANK[b.relationship];
  });
}

/**
 * The pure truth table. Every DB/network effect lives in
 * `AcquisitionPositionService` below; this function is fed already-loaded
 * facts so it runs identically in `acquisition-position.spec.ts` and in
 * production, and so the SAME six-state proof this phase's acceptance bar
 * requires can be written directly against it.
 */
export function computeAcquisitionPosition(input: AcquisitionPositionInput): AcquisitionPosition {
  const freshness = { lastSyncedAt: input.lastSyncedAt, neverSynced: input.neverSynced };

  // ── unknown: nothing to judge from ──────────────────────────────────────
  if (!input.configured || input.neverSynced) {
    return {
      state: 'unknown',
      evidence: [],
      summary: input.configured
        ? 'The vehicle sync has not completed a run yet, so there is no evidence to report.'
        : 'MakeGov/Tango is not configured, so vehicle access cannot be evaluated.',
      recommendedRoute: 'No route can be recommended without provider data.',
      source: 'tango',
      freshness,
    };
  }

  // ── vehicle_not_identified: the sync ran, found nothing at all ─────────
  if (input.evidence.length === 0) {
    return {
      state: 'vehicle_not_identified',
      evidence: [],
      summary: 'No contract vehicle relevant to this client has been identified.',
      recommendedRoute: 'No known vehicle route today. Direct, open-market pursuit is unaffected.',
      source: 'tango',
      freshness,
    };
  }

  const ranked = sortEvidence(input.evidence);
  const best = ranked[0]!;
  const bestIsUsable = best.expired !== true;

  // ── no_direct_access_evidence: vehicles exist, but none currently work ─
  if (!bestIsUsable) {
    return {
      state: 'no_direct_access_evidence',
      evidence: ranked,
      summary: `${ranked.length === 1 ? 'The only' : 'Every'} relevant vehicle found (${ranked
        .map(vehicleLabel)
        .join(', ')}) has passed its last date to order.`,
      recommendedRoute: 'No current vehicle route. Watch for a successor vehicle or pursue open-market.',
      source: 'tango',
      freshness,
    };
  }

  // ── A usable relationship won: self, parent, or teaming ─────────────────
  const state = STATE_FOR_RELATIONSHIP[best.relationship];
  const routeByRelationship: Readonly<Record<AcquisitionRelationship, string>> = {
    self: `Bid directly under ${vehicleLabel(best)}.`,
    parent: `Route through ${best.recipientUei}, which holds ${vehicleLabel(best)}. This client is not itself on the vehicle.`,
    teaming: `Pursue a teaming arrangement with ${best.recipientUei} on ${vehicleLabel(best)}.`,
  };
  const summaryByRelationship: Readonly<Record<AcquisitionRelationship, string>> = {
    self: `This client holds a live position on ${vehicleLabel(best)}.`,
    parent: `A related entity (${best.recipientUei}) holds a live position on ${vehicleLabel(best)}; this client does not hold one itself.`,
    teaming: `A known teaming partner (${best.recipientUei}) holds a live position on ${vehicleLabel(best)}.`,
  };

  return {
    state,
    evidence: ranked,
    summary: summaryByRelationship[best.relationship],
    recommendedRoute: routeByRelationship[best.relationship],
    source: 'tango',
    freshness,
  };
}

// ── Real wiring ──────────────────────────────────────────────────────────────

/** The narrow slice of Prisma this service needs — fakeable without a real client. */
export interface AcquisitionPositionReader {
  listRelevantVehicles(tenantId: string, clientId: string): Promise<
    Array<{
      tangoVehicleId: string;
      vehicleName: string | null;
      vehicleType: string | null;
      relationship: string;
      recipientUei: string;
      orderCount: number | null;
      idvObligations: number | null;
      idvContractsValue: number | null;
      lastSyncedAt: Date;
    }>
  >;
  /** The vehicle's own last-known snapshot, for fields P22's summary table does not carry (lastDateToOrder). */
  getVehicleSnapshot(tangoVehicleId: string): Promise<{ lastDateToOrder: string | null } | null>;
  /** Whether the vehicle sync (P22) has ever completed a run, and when. */
  getSyncStatus(): Promise<{ neverSynced: boolean; lastSyncedAt: string | null }>;
  /** Whether a Tango key is configured at all — a structurally different absence from "never synced". */
  isConfigured(): boolean;
}

/**
 * Assembles `AcquisitionPositionInput` from real data and hands it to the
 * pure function above. No business logic lives here — only fetching and
 * shaping, so the truth table stays provable without a database.
 */
export class AcquisitionPositionService {
  constructor(private readonly reader: AcquisitionPositionReader) {}

  async getPosition(tenantId: string, clientId: string, asOf: Date = new Date()): Promise<AcquisitionPosition> {
    const configured = this.reader.isConfigured();
    const syncStatus = await this.reader.getSyncStatus();

    if (!configured || syncStatus.neverSynced) {
      return computeAcquisitionPosition({
        configured,
        neverSynced: syncStatus.neverSynced,
        lastSyncedAt: syncStatus.lastSyncedAt,
        evidence: [],
        asOf,
      });
    }

    const rows = await this.reader.listRelevantVehicles(tenantId, clientId);
    const evidence: AcquisitionVehicleEvidence[] = await Promise.all(
      rows.map(async (row) => {
        const snapshot = await this.reader.getVehicleSnapshot(row.tangoVehicleId);
        const lastDateToOrder = snapshot?.lastDateToOrder ?? null;
        const expired = lastDateToOrder == null ? null : new Date(lastDateToOrder).getTime() < asOf.getTime();
        // Row-level defensiveness: P22's CHECK constraint already limits this
        // column to 'self'/'parent' in the database, but a raw string read
        // through Prisma is not itself a type guarantee — an unrecognized
        // value is dropped as unmappable evidence rather than trusted, the
        // same posture tango.client.ts takes for a provider record with no
        // usable identifier.
        const relationship = ACQUISITION_RELATIONSHIPS.includes(row.relationship as AcquisitionRelationship)
          ? (row.relationship as AcquisitionRelationship)
          : null;
        if (relationship == null) return null;
        return {
          tangoVehicleId: row.tangoVehicleId,
          vehicleName: row.vehicleName,
          vehicleType: row.vehicleType,
          relationship,
          recipientUei: row.recipientUei,
          orderCount: row.orderCount,
          idvObligations: row.idvObligations,
          idvContractsValue: row.idvContractsValue,
          lastDateToOrder,
          expired,
          lastSyncedAt: row.lastSyncedAt.toISOString(),
        };
      }),
    ).then((results) => results.filter((e): e is AcquisitionVehicleEvidence => e != null));

    return computeAcquisitionPosition({
      configured,
      neverSynced: syncStatus.neverSynced,
      lastSyncedAt: syncStatus.lastSyncedAt,
      evidence,
      asOf,
    });
  }
}
