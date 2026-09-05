/**
 * District Nexus Release 4 — CPF/CDS change-detector bridge.
 *
 * The canonical CPF/CDS ingest transaction lives in
 * government-data/community-funding (CommunityFundingUpsertService). That
 * package must not depend on district-nexus (layering: government-data is a
 * lower-level data rail), so the upsert service emits narrow prior/current
 * events through a CommunityFundingUpsertChangeSink and this adapter implements
 * the sink with the R4 detector + ledger writer. (The government-data import
 * below is type-only — no runtime dependency is created.)
 *
 * Honesty rules preserved here:
 *  - House attribution requires a source-backed district (the canonical row's
 *    own requester_district, never the member's directory row): district rows
 *    carry geography_vintage 'source_unknown' (the CPF/CDS sources publish a
 *    district number but never a boundary congress), Senate statewide rows
 *    carry null district and null vintage.
 *  - Requested amounts are 'requested_not_awarded' semantics — never final.
 *  - Only a real value/stage difference produces an event; synced_at-style
 *    metadata churn produces nothing (the upsert service only emits when its
 *    canonical write or first-create actually happened, and the detector
 *    re-verifies the values).
 *  - Formatting discipline: state must be a 2-char code, and the district goes
 *    through the SAME normalizer as the read model so sentinel district codes
 *    (90/98/ZZ-class) can never land in district_nexus_change.
 *  - The sink is AWAITED inside the ingest transaction and its ledger writes
 *    run on the caller's tx client: a ledger row and its fact row commit or
 *    roll back together (fail closed — the stores cannot diverge).
 */
import type { Prisma } from '@prisma/client';
import { detectCpfCdsChange, DistrictNexusChangeWriter } from './priority-intelligence-changes.js';
import { normalizeCpfCdsDistrict } from './priority-intelligence-cpf-cds.js';
import type { CommunityFundingUpsertChangeEvent } from '../../government-data/community-funding/community-funding.upsert.service.js';

/** Structural shape of a Prisma transaction client (or the service itself). */
export interface ChangeLedgerClient {
  districtNexusChange: {
    findUnique: (args: { where: { dedupeKey: string } }) => Promise<unknown>;
    create: (args: { data: Record<string, unknown> }) => Promise<unknown>;
  };
}

export type CommunityFundingChangeSink = (
  event: CommunityFundingUpsertChangeEvent,
  tx: Prisma.TransactionClient,
) => Promise<void>;

/**
 * Build a sink that runs the deterministic detector and persists the resulting
 * ledger rows through the tx passed per event (the caller's open ingest
 * transaction). This is the REAL production call site for detectCpfCdsChange —
 * without it the change ledger could never receive CPF/CDS events.
 */
export function createDistrictNexusChangeSink(
  writer: Pick<DistrictNexusChangeWriter, 'writeChanges'>,
): CommunityFundingChangeSink {
  return async (event, tx) => {
    // Formatting discipline before anything reaches the ledger: state must be
    // a 2-char code (parser-validated upstream; anything else carries no state
    // claim), and the district goes through the SAME normalizer as the read
    // model — at-large → '00', digits 1–89 padded, sentinels (90/98/ZZ-class)
    // and non-numeric junk → null so a sentinel district can never land in
    // district_nexus_change. Null district also means a Senate statewide row
    // (districtCode null) makes no district-geography claim at all.
    const stateCode = /^[A-Z]{2}$/.test(event.stateCode ?? '') ? event.stateCode : null;
    const districtCode = normalizeCpfCdsDistrict(event.districtCode);
    const changes = detectCpfCdsChange({
      requestId: event.requestId,
      chamber: event.chamber,
      fiscalYear: event.fiscalYear,
      stateCode,
      districtCode,
      requesterName: event.requesterName,
      prior: event.prior,
      current: event.current,
      observedAt: new Date(),
    });
    if (changes.length === 0) return;
    await writer.writeChanges(changes, tx);
  };
}
