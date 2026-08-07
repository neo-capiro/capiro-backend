import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { TangoStoreService } from '../external/tango/tango-store.service.js';
import { ClientProfileEnrichmentService, type EnrichmentCandidateView } from './client-profile-enrichment.service.js';
import type { TangoEntity } from '../external/tango/tango.types.js';

/**
 * Versioned Federal Business Profile (Funding Opportunities P21).
 *
 * A single READ aggregation — no migration, no new persistence — combining
 * three things that already exist but have never been assembled into one
 * view before this phase:
 *
 *   1. First-party data: the client's OWN profile fields (`clients`), the
 *      authoritative source per the plan's own precedence rule.
 *   2. Provider-verified data: the ACTIVE Tango entity snapshot (P19), plus
 *      its FULL version history (`TangoStoreService.getSnapshotHistory`,
 *      P15's own method — written then, called for real for the first time
 *      here). "Versioned" in this phase's name means exactly this: the
 *      profile is not just "what Tango last said", it is the auditable
 *      trail of what Tango has said over time.
 *   3. Review state: any OPEN enrichment candidates (P20) still awaiting a
 *      human decision, and the client's own sync-status columns (P19).
 *
 * ── Never a merge, never an overwrite ─────────────────────────────────────
 *
 * `firstParty` and `verified` are returned as clearly SEPARATE sections, not
 * combined into one flattened object. Collapsing them would silently make a
 * reader guess which side of a disagreement they are looking at — exactly
 * the "source precedence: first-party authoritative, Tango verifies/
 * enriches, never silently overwrites" invariant this whole plan is built
 * around, restated here for a READ view rather than assumed to be obviously
 * true of one just because it was already enforced on the WRITE side (P20).
 */

export interface FederalBusinessProfileVersion {
  version: number;
  active: boolean;
  observedAt: string;
  sourceUpdatedAt: string | null;
  contentSha256: string;
  entity: TangoEntity;
}

export interface FederalBusinessProfile {
  clientId: string;
  uei: string | null;
  firstParty: {
    naicsCodes: string[];
    pscCodes: string[];
    setAsideCertifications: string[];
    cageCode: string | null;
  };
  /** Null when there is no UEI yet, or no Tango snapshot has ever been observed. */
  verified: FederalBusinessProfileVersion | null;
  /** Every observation, oldest first — empty when `verified` is null. */
  history: FederalBusinessProfileVersion[];
  pendingEnrichment: EnrichmentCandidateView[];
  syncStatus: {
    lastSyncedAt: string | null;
    lastAttemptAt: string | null;
    lastError: string | null;
  };
}

@Injectable()
export class FederalBusinessProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tangoStore: TangoStoreService,
    private readonly enrichment: ClientProfileEnrichmentService,
  ) {}

  async getProfile(tenantId: string, clientId: string): Promise<FederalBusinessProfile> {
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({
        where: { id: clientId },
        select: {
          id: true,
          uei: true,
          naicsCodes: true,
          pscCodes: true,
          setAsideCertifications: true,
          cageCode: true,
          tangoEntityLastSyncedAt: true,
          tangoEntityLastAttemptAt: true,
          tangoEntityLastError: true,
        },
      }),
    );
    if (!client) throw new NotFoundException(`Client ${clientId} not found in this tenant`);

    const firstParty = {
      naicsCodes: client.naicsCodes,
      pscCodes: client.pscCodes,
      setAsideCertifications: client.setAsideCertifications,
      cageCode: client.cageCode,
    };
    const syncStatus = {
      lastSyncedAt: client.tangoEntityLastSyncedAt ? client.tangoEntityLastSyncedAt.toISOString() : null,
      lastAttemptAt: client.tangoEntityLastAttemptAt ? client.tangoEntityLastAttemptAt.toISOString() : null,
      lastError: client.tangoEntityLastError,
    };

    // No UEI: never a fuzzy name-based lookup, same invariant P19/P20 both
    // already hold. Nothing verified, nothing to version, nothing pending
    // (P20's own propose step already refuses to run without a UEI too).
    if (!client.uei) {
      return { clientId, uei: null, firstParty, verified: null, history: [], pendingEnrichment: [], syncStatus };
    }

    const historyRows = await this.tangoStore.getSnapshotHistory('entity', client.uei);
    const history = historyRows.map(toVersion);
    const verified = history.find((v) => v.active) ?? null;

    const pendingEnrichment = await this.enrichment.listCandidates(tenantId, { clientId, status: 'pending' });

    return { clientId, uei: client.uei, firstParty, verified, history, pendingEnrichment, syncStatus };
  }
}

function toVersion(row: {
  version: number;
  active: boolean;
  providerFetchedAt: Date;
  sourceUpdatedAt: Date | null;
  contentSha256: string;
  normalizedJsonb: unknown;
}): FederalBusinessProfileVersion {
  return {
    version: row.version,
    active: row.active,
    observedAt: row.providerFetchedAt.toISOString(),
    sourceUpdatedAt: row.sourceUpdatedAt ? row.sourceUpdatedAt.toISOString() : null,
    contentSha256: row.contentSha256,
    entity: row.normalizedJsonb as unknown as TangoEntity,
  };
}
