import { Prisma } from '@prisma/client';
import {
  buildAwardIdentityRails,
  FUZZY_MATCH_TIER,
  type AwardIdentityInput,
  type ContractorUeiIndex,
} from './award-history-identity.js';
import type { ProfileMapping } from './client-opportunity-profile.types.js';

/** Reviewed names are identifiers only when the recorded basis supports it. */
const REVIEWED_NAME_BASES = new Set([
  'exact_uei',
  'exact_cage',
  'exact_legal_name',
  'exact_legal_name_corroborated',
  'manual_pin',
]);

export interface ClientAwardScope {
  ueis: string[];
  /** Exact names usable only on source records whose UEI is NULL or blank. */
  missingUeiNames: string[];
}

function reviewedNames(mappings: ProfileMapping[]): string[] {
  return [
    ...new Set(
      mappings.flatMap((mapping) => {
        if (
          !REVIEWED_NAME_BASES.has(mapping.matchBasis ?? '') ||
          (mapping.matchTier != null && mapping.matchTier >= FUZZY_MATCH_TIER)
        )
          return [];
        const name = mapping.externalName?.trim().toLowerCase();
        return name ? [name] : [];
      }),
    ),
  ];
}

/**
 * Shared row scope for the client profile's contract totals and award explorer.
 * Callers supply only confirmed mappings with reviewStatus=confirmed and
 * rollUpAwards=true, including separately approved subsidiaries/aliases.
 *
 * Historical imports can omit an award UEI even when the client has one. A
 * reviewed exact name may recover those rows, but must never override a source
 * row's nonblank, conflicting UEI. Funding-opportunity scoring intentionally
 * retains its stricter rail-level basis and provenance in award-history-identity.
 */
export function buildClientAwardScope(
  input: AwardIdentityInput,
  contractorUeis: ContractorUeiIndex = new Map(),
): { contract: ClientAwardScope; assistance: ClientAwardScope } {
  const identity = buildAwardIdentityRails(input, contractorUeis);
  return {
    contract: {
      ueis: identity.contract.ueis,
      missingUeiNames: reviewedNames(input.contractingMappings),
    },
    assistance: {
      ueis: identity.assistance.ueis,
      missingUeiNames: reviewedNames(input.assistanceMappings),
    },
  };
}

/** Column arguments are static SQL identifiers supplied by the caller. */
export function clientAwardScopeSql(
  scope: ClientAwardScope,
  ueiColumn: Prisma.Sql = Prisma.sql`recipient_uei`,
  nameColumn: Prisma.Sql = Prisma.sql`contractor_name`,
): Prisma.Sql | null {
  const options: Prisma.Sql[] = [];
  if (scope.ueis.length) {
    options.push(Prisma.sql`${ueiColumn} = ANY(${scope.ueis}::text[])`);
  }
  if (scope.missingUeiNames.length) {
    options.push(
      Prisma.sql`(NULLIF(BTRIM(${ueiColumn}), '') IS NULL AND lower(${nameColumn}) = ANY(${scope.missingUeiNames}::text[]))`,
    );
  }
  return options.length ? Prisma.sql`(${Prisma.join(options, ' OR ')})` : null;
}
