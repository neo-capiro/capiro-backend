/**
 * District Nexus — identity adapter (Release 1, Truth Layer).
 *
 * Converts reviewed `ClientIntelMapping` rows into the canonical award-identity
 * primitive defined in `award-history-identity.ts`. This module defines NO
 * identity policy of its own — rail-level UEI precedence, name-suppression, and
 * the fuzzy/unrecorded-basis rejection all live exactly once, in
 * `buildAwardIdentityRails`. This file only reshapes District Nexus's own
 * mapping rows into that function's input contract, per client.
 */
import {
  buildAwardIdentityRails,
  isResolvableContractorId,
  type AwardIdentityRail,
} from '../funding-opportunities/award-history-identity.js';
import type { ContractorUeiIndex } from '../funding-opportunities/award-history-identity.js';
import type { ProfileMapping } from '../funding-opportunities/client-opportunity-profile.types.js';

/** One client's raw, reviewed `ClientIntelMapping` rows plus its own UEI. */
export interface DistrictNexusIdentitySeed {
  clientId: string;
  clientName: string;
  uei: string | null;
  mappings: Array<{
    /** 'contracting' | 'assistance_recipient'. Any other source is ignored. */
    source: string;
    externalId: string | null;
    externalName: string | null;
    matchBasis: string | null;
    matchTier: number | null;
  }>;
}

/** One client's canonical identity — both rails, plus the identity they attach to. */
export interface DistrictNexusClientIdentity {
  clientId: string;
  clientName: string;
  contract: AwardIdentityRail;
  assistance: AwardIdentityRail;
}

function toProfileMapping(m: DistrictNexusIdentitySeed['mappings'][number]): ProfileMapping {
  return {
    externalId: m.externalId,
    externalName: m.externalName,
    matchBasis: m.matchBasis,
    matchTier: m.matchTier,
  };
}

/** Split one seed's mappings into the two rails' raw inputs. */
export function splitDistrictNexusMappings(seed: DistrictNexusIdentitySeed): {
  contractingMappings: ProfileMapping[];
  assistanceMappings: ProfileMapping[];
} {
  return {
    contractingMappings: seed.mappings.filter((m) => m.source === 'contracting').map(toProfileMapping),
    assistanceMappings: seed.mappings
      .filter((m) => m.source === 'assistance_recipient')
      .map(toProfileMapping),
  };
}

/**
 * Build one client's canonical identity. Pure — `contractorUeis` (the
 * `federal_contractor.id -> uei` resolution) is looked up by the caller,
 * outside any tenant transaction, exactly like the funding-opportunities
 * repository already does for the same reason.
 */
export function buildDistrictNexusIdentity(
  seed: DistrictNexusIdentitySeed,
  contractorUeis: ContractorUeiIndex = new Map(),
): DistrictNexusClientIdentity {
  const { contractingMappings, assistanceMappings } = splitDistrictNexusMappings(seed);
  const rails = buildAwardIdentityRails(
    { uei: seed.uei, contractingMappings, assistanceMappings },
    contractorUeis,
  );
  return {
    clientId: seed.clientId,
    clientName: seed.clientName,
    contract: rails.contract,
    assistance: rails.assistance,
  };
}

/**
 * `federal_contractor.id` values worth resolving to a UEI, across every
 * client's `contracting` mappings — the batched, firm-wide counterpart of the
 * single-client resolution `buildDistrictNexusIdentity` needs. Same
 * UUID-shape filter as `award-history-identity.ts`'s `contractorIdsToResolve`,
 * and for the same reason: one malformed id would abort the whole `uuid[]`
 * lookup for every client, not just the one that supplied it.
 */
export function districtNexusContractorIdsToResolve(seeds: DistrictNexusIdentitySeed[]): string[] {
  const ids = new Set<string>();
  for (const seed of seeds) {
    for (const m of seed.mappings) {
      if (m.source === 'contracting' && isResolvableContractorId(m.externalId)) {
        ids.add(m.externalId);
      }
    }
  }
  return [...ids];
}
