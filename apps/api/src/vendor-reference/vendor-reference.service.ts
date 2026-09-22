import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  RepresentationResolverService,
  type FederalMemberSummary,
} from '../clients/representation-resolver.service.js';
import {
  geocodeAddress,
  type CensusGeocodeResult,
} from '../external/census-geocoder/census-geocoder.client.js';
import { toUsaSpendingDistrictCode } from '../common/district-code.util.js';
import { federalAwardDates } from '../common/federal-award-date-serialization.js';
import { resolveEvidenceAccuracyModeForTenant } from '../common/meri-evidence-accuracy-flags.js';
import {
  VendorReferenceSamClient,
  type SamEntityRecord,
  type SamLookupResult,
} from './vendor-reference-sam.client.js';
import {
  normalizeCage,
  normalizeCompanyName,
  normalizeUei,
  uniqueNames,
} from './vendor-name.util.js';
import {
  litigationRow,
  NOT_SOURCED_FINDING,
  type ContractingDetail,
  type DelegationDetail,
  type DistrictBasis,
  type IdentityCandidate,
  type LobbyingDetail,
  type VendorIdentity,
  type VendorReferenceDossier,
  type VendorReferenceInput,
  type VendorReferenceRow,
} from './vendor-reference.types.js';

/**
 * Vendor Reference Pull — READ-ONLY composition over Capiro's existing rails.
 *
 *   SAM.gov entity (live)            → Company identity, Federal-market credentials
 *   federal_award / federal_assistance_award / tango vehicle snapshots
 *                                    → Federal contracting history
 *   lda_filing (Senate LDA)          → Federal lobbying representation
 *   congress_member + committee rosters via RepresentationResolverService
 *                                    → Congressional delegation for the facility
 *   (nothing)                        → Litigation and adverse history (ALWAYS not_sourced)
 *
 * Identity discipline (mirrors award-history-identity.ts): a UEI is the only
 * identifier that may CONFIRM a row. With a UEI anchor, every award/vehicle join
 * is `recipient_uei = uei` and nothing is name-matched. Without one, awards are
 * joined on EXACT normalized legal-name equality only (never contains/fuzzy) and
 * every such row is `unverified`. Tango vehicle awardees are keyed by UEI at
 * the provider, so they are never name-joined at all.
 *
 * Fail-soft: every rail runs under `guard()`. A provider or database error
 * yields `not_sourced` rows plus a `warnings[]` entry — never a 500.
 *
 * This service writes to NO table.
 */

const CONTRACT_CAP = 15;
const ASSISTANCE_CAP = 10;
const VEHICLE_CAP = 15;
const LDA_FETCH = 200;
const LDA_RENDER_CAP = 12;
const LDA_PARTIAL_CAP = 10;
const COMMITTEES_PER_MEMBER_CAP = 8;

const SOURCE_SAM = 'SAM.gov entity';
const SOURCE_SAM_ADDRESS = 'SAM.gov entity (physical address)';
const SOURCE_CONTRACTS = 'USAspending (contracts) / Capiro ingestion';
const SOURCE_ASSISTANCE = 'USAspending (assistance) / Capiro ingestion';
const SOURCE_VEHICLES = 'MakeGov/Tango vehicle awardees';
const SOURCE_LDA = 'Senate LDA';
const SOURCE_DIRECTORY = 'Capiro directory';
const SOURCE_MANUAL = 'Manual';
const SOURCE_CLIENT = 'Client';
const SOURCE_CALLER = 'Client (caller-supplied)';

interface FacilityPlacement {
  /** 2-letter state code. */
  state: string;
  /** Facility-style district ('02', '00' at-large) or null when only the state is known. */
  district: string | null;
  basis: DistrictBasis;
  address: string | null;
}

interface ClientRelationship {
  finding: string;
  verification: VendorReferenceRow['verification'];
  detail?: Record<string, unknown>;
}

@Injectable()
export class VendorReferenceService {
  private readonly logger = new Logger(VendorReferenceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sam: VendorReferenceSamClient,
    private readonly resolver: RepresentationResolverService,
  ) {}

  async pull(tenantId: string, input: VendorReferenceInput): Promise<VendorReferenceDossier> {
    const warnings: string[] = [];
    const now = new Date();
    const asOf = now.toISOString().slice(0, 10);
    const enforceDateSemantics =
      resolveEvidenceAccuracyModeForTenant(tenantId, 'strategy') === 'enforce';

    const { identity, sam } = await this.resolveIdentity(input, warnings);

    const [placement, relationship] = await Promise.all([
      this.guard('facility placement', warnings, () => this.resolveFacility(input, sam, warnings), null),
      input.clientId
        ? this.guard(
            'client relationship',
            warnings,
            () => this.clientRelationship(tenantId, input.clientId!, identity),
            null,
          )
        : Promise.resolve<ClientRelationship | null>(null),
    ]);

    const [contracting, lobbying, delegation] = await Promise.all([
      this.guard('federal contracting history', warnings, () => this.contractingHistory(identity, enforceDateSemantics), [
        notSourcedListRow('federal_contracting_history', 'Federal award records unavailable', 'USAspending / Tango'),
      ]),
      this.guard('federal lobbying representation', warnings, () => this.lobbying(identity, sam), [
        notSourcedListRow('federal_lobbying_representation', 'Senate LDA records unavailable', SOURCE_LDA),
      ]),
      this.guard('congressional delegation', warnings, () => this.delegation(placement), [
        notSourcedListRow('congressional_delegation', 'Directory records unavailable', SOURCE_DIRECTORY),
      ]),
    ]);

    const rows: VendorReferenceRow[] = [
      ...this.companyIdentityRows(input, identity, sam, placement, relationship),
      ...this.credentialRows(identity, sam),
      ...contracting,
      ...lobbying,
      ...delegation,
      // HARD RULE: always present, never populated, never inferred.
      litigationRow(),
    ];

    return {
      generatedAt: now.toISOString(),
      asOf,
      input,
      identity,
      rows,
      warnings,
      handlingNotes: this.handlingNotes(identity, placement, lobbying),
    };
  }

  // ── Identity ─────────────────────────────────────────────────────────────

  private async resolveIdentity(
    input: VendorReferenceInput,
    warnings: string[],
  ): Promise<{ identity: VendorIdentity; sam: SamEntityRecord | null }> {
    const inputName = input.name.trim();
    const uei = normalizeUei(input.uei);
    const cage = normalizeCage(input.cage);
    const wantState = input.state?.trim().toUpperCase() || null;
    const target = normalizeCompanyName(inputName);

    const build = (
      basis: VendorIdentity['basis'],
      sam: SamEntityRecord | null,
      extra: Partial<VendorIdentity> & { explanation: string },
    ): { identity: VendorIdentity; sam: SamEntityRecord | null } => ({
      identity: {
        inputName,
        matchedName: sam?.legalBusinessName ?? null,
        uei: sam?.uei ?? extra.uei ?? null,
        cageCode: sam?.cageCode ?? extra.cageCode ?? null,
        basis,
        samVerified: sam != null,
        ambiguous: extra.ambiguous ?? false,
        candidates: extra.candidates ?? [],
        nameVariants: uniqueNames([inputName, sam?.legalBusinessName, sam?.dbaName]),
        explanation: extra.explanation,
      },
      sam,
    });

    // 1. Caller-supplied UEI: the identifier governs; SAM only verifies it.
    if (uei) {
      const res = await this.safeSam(() => this.sam.lookupByUei(uei), warnings, `UEI ${uei}`);
      const sam = res?.ok ? (res.entities.find((e) => e.uei === uei) ?? null) : null;
      if (res?.ok && !sam) {
        warnings.push(`SAM.gov has no entity for UEI ${uei}; identity rests on the caller-supplied UEI.`);
      }
      if (sam && !nameMatches(sam, target)) {
        warnings.push(
          `SAM legal name "${sam.legalBusinessName}" for UEI ${uei} does not equal the input name "${inputName}"; the UEI governs.`,
        );
      }
      return build('uei_input', sam, {
        uei,
        cageCode: cage,
        explanation: sam
          ? `Caller supplied UEI ${uei}; SAM.gov confirms it as "${sam.legalBusinessName}". Every award and vehicle join keys on this UEI.`
          : `Caller supplied UEI ${uei}; SAM.gov could not verify it. Award and vehicle joins still key on this UEI; SAM-sourced rows are not sourced.`,
      });
    }

    // 2. Caller-supplied CAGE: SAM resolves it to a UEI, or we fall through to the name.
    if (cage) {
      const res = await this.safeSam(() => this.sam.lookupByCage(cage), warnings, `CAGE ${cage}`);
      if (res?.ok) {
        const distinct = dedupeByUei(res.entities);
        if (distinct.length === 1) {
          const sam = distinct[0]!;
          return build('cage_input', sam, {
            explanation: `Caller supplied CAGE ${cage}; SAM.gov resolves it to UEI ${sam.uei} ("${sam.legalBusinessName}"). Every award and vehicle join keys on that UEI.`,
          });
        }
        warnings.push(
          distinct.length === 0
            ? `SAM.gov has no entity for CAGE ${cage}; falling back to a legal-name match.`
            : `CAGE ${cage} resolved to ${distinct.length} distinct SAM entities; falling back to a legal-name match.`,
        );
      }
    }

    // 3. Name path: exactly ONE distinct active registration whose legal name or DBA equals the input.
    const res = await this.safeSam(() => this.sam.lookupByName(inputName), warnings, `"${inputName}"`);
    if (!res || !res.ok) {
      return build('name_only', null, {
        cageCode: cage,
        explanation: `No identifier supplied and SAM.gov was unavailable; every row below is derived from the name "${inputName}" alone.`,
      });
    }
    const exact = res.entities.filter((e) => nameMatches(e, target));
    const active = exact.filter((e) => (e.registrationStatus ?? '').toUpperCase() === 'ACTIVE');
    let pool = active.length ? active : exact;
    const usedInactive = active.length === 0 && exact.length > 0;
    if (wantState) {
      const inState = pool.filter((e) => e.physicalAddress?.state === wantState);
      if (inState.length) pool = inState;
    }
    const distinct = dedupeByUei(pool);

    if (distinct.length === 1) {
      const sam = distinct[0]!;
      if (usedInactive) {
        warnings.push(
          `Only an inactive SAM registration matched "${inputName}" (status ${sam.registrationStatus ?? 'unknown'}).`,
        );
      }
      return build('sam_exact_name', sam, {
        explanation: `No identifier supplied; SAM.gov returned exactly one ${usedInactive ? '' : 'active '}registration whose legal name or DBA equals "${inputName}"${wantState ? ` in ${wantState}` : ''}: "${sam.legalBusinessName}", UEI ${sam.uei}. Award and vehicle joins key on that UEI.`,
      });
    }

    if (distinct.length > 1) {
      const candidates: IdentityCandidate[] = distinct.map((e) => ({
        uei: e.uei,
        legalBusinessName: e.legalBusinessName,
        state: e.physicalAddress?.state ?? null,
        registrationStatus: e.registrationStatus,
      }));
      return build('name_only', null, {
        cageCode: cage,
        ambiguous: true,
        candidates,
        explanation: `"${inputName}" matches ${distinct.length} distinct SAM.gov entities${wantState ? ` (state ${wantState} did not disambiguate)` : ' (a state would help disambiguate)'}; no identifier was assigned. Every row below is name-derived.`,
      });
    }

    return build('name_only', null, {
      cageCode: cage,
      explanation:
        res.entities.length === 0
          ? `SAM.gov returned no registrations for "${inputName}"; every row below is name-derived.`
          : `SAM.gov returned ${res.entities.length} registration(s) for "${inputName}" but none whose legal name or DBA equals it exactly; every row below is name-derived.`,
    });
  }

  private async safeSam(
    call: () => Promise<SamLookupResult>,
    warnings: string[],
    label: string,
  ): Promise<SamLookupResult | null> {
    try {
      const res = await call();
      if (!res.ok) warnings.push(`SAM.gov entity lookup for ${label} unavailable: ${res.message}.`);
      return res;
    } catch (e) {
      warnings.push(
        `SAM.gov entity lookup for ${label} failed: ${e instanceof Error ? e.message : String(e)}.`,
      );
      return null;
    }
  }

  // ── Company identity + credentials ───────────────────────────────────────

  private companyIdentityRows(
    input: VendorReferenceInput,
    identity: VendorIdentity,
    sam: SamEntityRecord | null,
    placement: FacilityPlacement | null,
    relationship: ClientRelationship | null,
  ): VendorReferenceRow[] {
    const section = 'company_identity' as const;
    const samAsOf = sam?.lastUpdateDate ? isoDate(sam.lastUpdateDate) ?? undefined : undefined;

    const legalName: VendorReferenceRow = sam
      ? {
          section,
          item: 'Legal name and DBA',
          finding: sam.dbaName ? `${sam.legalBusinessName} (DBA: ${sam.dbaName})` : sam.legalBusinessName,
          source: SOURCE_SAM,
          verification: 'confirmed',
          asOf: samAsOf,
          detail: { uei: sam.uei, matchBasis: identity.basis },
        }
      : {
          section,
          item: 'Legal name and DBA',
          finding: identity.ambiguous
            ? `${identity.inputName} (as supplied; ${identity.candidates.length} SAM entities share this name)`
            : `${identity.inputName} (as supplied; not matched to a SAM record)`,
          source: SOURCE_CALLER,
          verification: 'unverified',
        };

    const hq: VendorReferenceRow = sam?.physicalAddress
      ? {
          section,
          item: 'Headquarters',
          finding: formatAddress(sam.physicalAddress),
          source: SOURCE_SAM_ADDRESS,
          verification: 'confirmed',
          asOf: samAsOf,
        }
      : {
          section,
          item: 'Headquarters',
          finding: NOT_SOURCED_FINDING,
          source: SOURCE_SAM,
          verification: 'not_sourced',
        };

    const facility: VendorReferenceRow = this.facilityRow(input, placement, samAsOf);

    const ownership: VendorReferenceRow = {
      section,
      item: 'Ownership and parent',
      finding: NOT_SOURCED_FINDING,
      source: SOURCE_MANUAL,
      verification: 'not_sourced',
      ...(sam && (sam.entityStructure || sam.stateOfIncorporation)
        ? {
            detail: {
              samEntityStructure: sam.entityStructure,
              samStateOfIncorporation: sam.stateOfIncorporation,
            },
          }
        : {}),
    };

    const rel: VendorReferenceRow = relationship
      ? {
          section,
          item: 'Relationship to the client',
          finding: relationship.finding,
          source: SOURCE_CLIENT,
          verification: relationship.verification,
          detail: relationship.detail,
        }
      : {
          section,
          item: 'Relationship to the client',
          finding: input.clientId ? 'Client record unavailable' : NOT_SOURCED_FINDING,
          source: SOURCE_CLIENT,
          verification: 'not_sourced',
        };

    return [legalName, hq, facility, ownership, rel];
  }

  private facilityRow(
    input: VendorReferenceInput,
    placement: FacilityPlacement | null,
    samAsOf: string | undefined,
  ): VendorReferenceRow {
    const section = 'company_identity' as const;
    const item = 'Facility relevant to this request (address, congressional district)';
    if (!placement) {
      return { section, item, finding: 'Enter facility address and district', source: 'Client / SAM.gov', verification: 'placeholder' };
    }
    const where = placement.district ? `${placement.state}-${placement.district}` : `${placement.state} (district unknown)`;
    const finding = placement.address ? `${placement.address}; ${where}` : where;
    switch (placement.basis) {
      case 'sam_physical_address':
      case 'state_only_sam_physical_address':
        return {
          section,
          item,
          finding: `${finding} — SAM.gov registered physical address; may not be the facility for this request`,
          source: SOURCE_SAM_ADDRESS,
          verification: 'confirmed',
          asOf: samAsOf,
          detail: { districtBasis: placement.basis },
        };
      case 'census_geocode':
        return {
          section,
          item,
          finding: `${finding} — district resolved by Census geocoder from the supplied address`,
          source: 'Client / Census geocoder',
          verification: 'unverified',
          detail: { districtBasis: placement.basis },
        };
      default:
        return {
          section,
          item,
          finding,
          source: SOURCE_CALLER,
          verification: 'unverified',
          detail: { districtBasis: placement.basis, facilityAddress: input.facilityAddress ?? null },
        };
    }
  }

  private credentialRows(identity: VendorIdentity, sam: SamEntityRecord | null): VendorReferenceRow[] {
    const section = 'federal_market_credentials' as const;
    const samAsOf = sam?.lastUpdateDate ? isoDate(sam.lastUpdateDate) ?? undefined : undefined;
    const rows: VendorReferenceRow[] = [];

    if (sam) {
      rows.push({ section, item: 'UEI', finding: sam.uei, source: SOURCE_SAM, verification: 'confirmed', asOf: samAsOf });
    } else if (identity.uei) {
      rows.push({
        section,
        item: 'UEI',
        finding: `${identity.uei} (caller-supplied; SAM.gov verification unavailable)`,
        source: SOURCE_CALLER,
        verification: 'unverified',
      });
    } else {
      rows.push({ section, item: 'UEI', finding: NOT_SOURCED_FINDING, source: SOURCE_SAM, verification: 'not_sourced' });
    }

    if (sam) {
      rows.push({
        section,
        item: 'CAGE',
        finding: sam.cageCode ?? 'No CAGE on the SAM.gov record',
        source: SOURCE_SAM,
        verification: 'confirmed',
        asOf: samAsOf,
      });
    } else if (identity.cageCode) {
      rows.push({
        section,
        item: 'CAGE',
        finding: `${identity.cageCode} (caller-supplied; SAM.gov verification unavailable)`,
        source: SOURCE_CALLER,
        verification: 'unverified',
      });
    } else {
      rows.push({ section, item: 'CAGE', finding: NOT_SOURCED_FINDING, source: SOURCE_SAM, verification: 'not_sourced' });
    }

    rows.push(
      sam
        ? {
            section,
            item: 'SAM registration status and expiry',
            finding: [
              sam.registrationStatus ?? 'Status not stated',
              sam.registrationExpirationDate ? `expires ${isoDate(sam.registrationExpirationDate) ?? sam.registrationExpirationDate}` : null,
              sam.registrationDate ? `registered ${isoDate(sam.registrationDate) ?? sam.registrationDate}` : null,
            ]
              .filter(Boolean)
              .join('; '),
            source: SOURCE_SAM,
            verification: 'confirmed',
            asOf: samAsOf,
          }
        : { section, item: 'SAM registration status and expiry', finding: NOT_SOURCED_FINDING, source: SOURCE_SAM, verification: 'not_sourced' },
    );

    rows.push(
      sam
        ? {
            section,
            item: 'NAICS / PSC',
            finding: formatCodes(sam),
            source: SOURCE_SAM,
            verification: 'confirmed',
            asOf: samAsOf,
            detail: { primaryNaics: sam.primaryNaics, naicsCodes: sam.naicsCodes, pscCodes: sam.pscCodes },
          }
        : { section, item: 'NAICS / PSC', finding: NOT_SOURCED_FINDING, source: SOURCE_SAM, verification: 'not_sourced' },
    );

    rows.push({
      section,
      item: 'ITAR / export-control posture',
      finding: NOT_SOURCED_FINDING,
      source: SOURCE_MANUAL,
      verification: 'not_sourced',
    });

    return rows;
  }

  // ── Client relationship (the only tenant-scoped read) ────────────────────

  private async clientRelationship(
    tenantId: string,
    clientId: string,
    identity: VendorIdentity,
  ): Promise<ClientRelationship | null> {
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findUnique({ where: { id: clientId }, select: { id: true, name: true, uei: true } }),
    );
    if (!client) return null;
    const clientUei = normalizeUei(client.uei);
    const detail = { clientId: client.id, clientName: client.name, clientUei };
    if (clientUei && identity.uei) {
      return clientUei === identity.uei
        ? {
            finding: `Same legal entity as client "${client.name}" (UEI ${clientUei} matches)`,
            verification: 'confirmed',
            detail,
          }
        : {
            finding: `Distinct legal entity from client "${client.name}" (client UEI ${clientUei}, vendor UEI ${identity.uei}); enter the relationship (teaming partner, supplier, prime, etc.)`,
            verification: 'placeholder',
            detail,
          };
    }
    const sameName = identity.nameVariants.some(
      (n) => normalizeCompanyName(n) === normalizeCompanyName(client.name),
    );
    return sameName
      ? {
          finding: `Name matches client "${client.name}"; no UEI on both sides to confirm they are the same entity`,
          verification: 'unverified',
          detail,
        }
      : {
          finding: `Relationship to client "${client.name}" not on record; enter manually`,
          verification: 'placeholder',
          detail,
        };
  }

  // ── Federal contracting history ──────────────────────────────────────────

  private async contractingHistory(
    identity: VendorIdentity,
    enforceDateSemantics: boolean,
  ): Promise<VendorReferenceRow[]> {
    const section = 'federal_contracting_history' as const;
    const rows: VendorReferenceRow[] = [];
    const uei = identity.uei;
    const names = identity.nameVariants;

    // Rail-level exclusivity (award-history-identity.ts): with a UEI, names are
    // NOT queried at all. Without one, exact normalized-name equality only.
    const contractWhere = uei
      ? { recipientUei: uei }
      : { OR: names.map((n) => ({ contractorName: { equals: n, mode: 'insensitive' as const } })) };
    const assistanceWhere = uei
      ? { recipientUei: uei }
      : { OR: names.map((n) => ({ recipientName: { equals: n, mode: 'insensitive' as const } })) };
    const basis: ContractingDetail['matchBasis'] = uei ? 'exact_uei' : 'exact_name';
    const verification = uei ? 'confirmed' : 'unverified';

    const [contracts, assistance, vehicles] = await Promise.all([
      this.prisma.federalAward.findMany({
        where: contractWhere,
        orderBy: [{ actionDate: 'desc' }, { amount: 'desc' }],
        take: CONTRACT_CAP,
        select: {
          awardUniqueId: true,
          piid: true,
          awardingAgency: true,
          awardingSubTier: true,
          contractorName: true,
          recipientUei: true,
          amount: true,
          description: true,
          actionDate: true,
          ...(enforceDateSemantics
            ? { baseAwardSignedDate: true, latestActionDate: true }
            : {}),
          lastSyncedAt: true,
        },
      }),
      this.prisma.federalAssistanceAward.findMany({
        where: assistanceWhere,
        orderBy: [{ startDate: 'desc' }],
        take: ASSISTANCE_CAP,
        select: {
          awardUniqueId: true,
          fain: true,
          awardTypeLabel: true,
          awardingAgency: true,
          awardingSubTier: true,
          recipientName: true,
          recipientUei: true,
          assistanceListingTitle: true,
          description: true,
          totalObligatedAmount: true,
          startDate: true,
          endDate: true,
          lastSyncedAt: true,
        },
      }),
      uei ? this.vehiclesForUei(uei) : Promise.resolve([] as VendorReferenceRow[]),
    ]);

    for (const a of contracts) {
      // Name path double-check in memory: Prisma's insensitive equality is not
      // our normalizer, so a row that only matches loosely is dropped.
      if (!uei && !names.some((n) => normalizeCompanyName(n) === normalizeCompanyName(a.contractorName))) continue;
      const dates = federalAwardDates(a);
      const detail: ContractingDetail = {
        agency: joinAgency(a.awardingAgency, a.awardingSubTier),
        type: 'Contract',
        value: toNum(a.amount),
        awardDate: isoDate(a.actionDate),
        ...(enforceDateSemantics
          ? {
              awardDate:
                dates.baseAwardSignedDate?.slice(0, 10) ??
                dates.latestActionDate?.slice(0, 10) ??
                null,
              awardDateSemantics: dates.baseAwardSignedDate
                ? ('base_award_signed' as const)
                : ('latest_action' as const),
            }
          : {}),
        periodOfPerformance: null, // not carried by the DoD contract ingestion
        matchBasis: basis,
        recordId: a.awardUniqueId,
      };
      rows.push({
        section,
        item: [a.piid ?? a.awardUniqueId, truncate(a.description, 90)].filter(Boolean).join(' — '),
        finding: truncate(a.description, 200) ?? '',
        source: SOURCE_CONTRACTS,
        verification,
        asOf: isoDate(a.lastSyncedAt) ?? undefined,
        detail: { ...detail },
      });
    }

    for (const g of assistance) {
      if (!uei && !names.some((n) => normalizeCompanyName(n) === normalizeCompanyName(g.recipientName))) continue;
      const start = isoDate(g.startDate);
      const end = isoDate(g.endDate);
      const detail: ContractingDetail = {
        agency: joinAgency(g.awardingAgency, g.awardingSubTier),
        type: g.awardTypeLabel ?? 'Grant',
        value: toNum(g.totalObligatedAmount),
        awardDate: start,
        periodOfPerformance: start || end ? `${start ?? '?'} – ${end ?? '?'}` : null,
        matchBasis: basis,
        recordId: g.awardUniqueId,
      };
      rows.push({
        section,
        item: [g.fain ?? g.awardUniqueId, truncate(g.assistanceListingTitle ?? g.description, 90)]
          .filter(Boolean)
          .join(' — '),
        finding: truncate(g.description, 200) ?? '',
        source: SOURCE_ASSISTANCE,
        verification,
        asOf: isoDate(g.lastSyncedAt) ?? undefined,
        detail: { ...detail },
      });
    }

    rows.push(...vehicles);

    if (rows.length === 0) {
      rows.push({
        section,
        item: uei
          ? `None found in Capiro-ingested data for UEI ${uei} (USAspending DoD contracts, assistance awards, Tango vehicles)`
          : `None found in Capiro-ingested data by exact legal name (${names.join(' / ')}); vehicles are UEI-keyed and were not searched`,
        finding: '',
        source: 'USAspending / Tango',
        verification: 'unverified',
      });
    }
    return rows;
  }

  /** Tango vehicle awardees are UEI-keyed at the provider; there is no name path by design. */
  private async vehiclesForUei(uei: string): Promise<VendorReferenceRow[]> {
    const awardees = await this.prisma.tangoResourceSnapshot.findMany({
      where: {
        resourceType: 'vehicle_awardee',
        active: true,
        normalizedJsonb: { path: ['recipientUei'], equals: uei },
      },
      orderBy: [{ providerFetchedAt: 'desc' }],
      take: VEHICLE_CAP,
      select: { externalId: true, normalizedJsonb: true, providerFetchedAt: true },
    });
    if (awardees.length === 0) return [];

    // externalId is `${vehicleId}#${awardeeId}` (sync-tango-vehicles.ts).
    const vehicleIds = Array.from(new Set(awardees.map((a) => a.externalId.split('#')[0]!).filter(Boolean)));
    const vehicles = await this.prisma.tangoResourceSnapshot.findMany({
      where: { resourceType: 'vehicle', active: true, externalId: { in: vehicleIds } },
      select: { externalId: true, normalizedJsonb: true },
    });
    const vehicleById = new Map(vehicles.map((v) => [v.externalId, rec(v.normalizedJsonb)]));

    return awardees.map((a) => {
      const aw = rec(a.normalizedJsonb);
      const vehicleId = a.externalId.split('#')[0]!;
      const v = vehicleById.get(vehicleId) ?? {};
      const name = str(v.programAcronym) ?? str(v.solicitationTitle) ?? vehicleId;
      const piid = str(aw.piid);
      const lastDateToOrder = str(v.lastDateToOrder);
      const detail: ContractingDetail = {
        agency: str(v.agencyId),
        type: str(v.vehicleType) ?? 'IDV',
        value: num(aw.idvObligations),
        awardDate: isoDate(str(aw.awardDate)),
        periodOfPerformance: lastDateToOrder ? `orders through ${isoDate(lastDateToOrder) ?? lastDateToOrder}` : null,
        matchBasis: 'exact_uei',
        recordId: a.externalId,
      };
      return {
        section: 'federal_contracting_history' as const,
        item: piid ? `${name} (IDV ${piid})` : name,
        finding: str(aw.title) ?? str(v.solicitationTitle) ?? '',
        source: SOURCE_VEHICLES,
        verification: 'confirmed' as const,
        asOf: isoDate(a.providerFetchedAt) ?? undefined,
        detail: { ...detail, vehicleId },
      };
    });
  }

  // ── Federal lobbying representation ──────────────────────────────────────

  private async lobbying(identity: VendorIdentity, sam: SamEntityRecord | null): Promise<VendorReferenceRow[]> {
    const section = 'federal_lobbying_representation' as const;
    const names = identity.nameVariants;
    const normalizedLegal = new Set(
      [sam?.legalBusinessName, sam?.dbaName].map(normalizeCompanyName).filter((n) => n.length >= 3),
    );
    const normalizedAll = new Set(names.map(normalizeCompanyName).filter((n) => n.length >= 3));
    const terms = uniqueTerms([...names, ...normalizedAll]).filter((t) => t.length >= 3);
    if (terms.length === 0) {
      return [
        {
          section,
          item: 'Name too short to search the Senate LDA dataset',
          finding: NOT_SOURCED_FINDING,
          source: SOURCE_LDA,
          verification: 'not_sourced',
        },
      ];
    }

    const filings = await this.prisma.ldaFiling.findMany({
      where: { OR: terms.map((t) => ({ clientName: { contains: t, mode: 'insensitive' as const } })) },
      orderBy: [{ filingYear: 'desc' }, { dtPosted: 'desc' }],
      take: LDA_FETCH,
      select: {
        filingUuid: true,
        filingType: true,
        filingYear: true,
        filingPeriod: true,
        income: true,
        registrantName: true,
        clientName: true,
        issueCodes: true,
        lastSyncedAt: true,
      },
    });

    const exact = filings.filter((f) => normalizedAll.has(normalizeCompanyName(f.clientName)));
    const partial = filings.filter((f) => !normalizedAll.has(normalizeCompanyName(f.clientName)));

    // A filing is a primary record; the join is the client-of-record NAME. It is
    // `confirmed` only when the identity is UEI-anchored AND the filing's client
    // name equals the SAM legal name / DBA for that UEI. Anything looser stays
    // `unverified`.
    const toRow = (f: (typeof filings)[number], matchBasis: LobbyingDetail['matchBasis']): VendorReferenceRow => {
      const detail: LobbyingDetail = {
        registrant: f.registrantName,
        clientOfRecord: f.clientName,
        period: periodLabel(f.filingYear, f.filingPeriod, f.filingType),
        income: toNum(f.income),
        issueCodes: f.issueCodes ?? [],
        filingType: f.filingType,
        filingUuid: f.filingUuid,
        matchBasis,
      };
      const confirmed = identity.uei != null && sam != null && matchBasis === 'exact_legal_name';
      return {
        section,
        item: f.registrantName,
        finding: `${f.registrantName} for ${f.clientName}, ${detail.period}`,
        source: SOURCE_LDA,
        verification: confirmed ? 'confirmed' : 'unverified',
        asOf: isoDate(f.lastSyncedAt) ?? undefined,
        detail: { ...detail },
      };
    };

    const rows: VendorReferenceRow[] = exact
      .slice(0, LDA_RENDER_CAP)
      .map((f) => toRow(f, normalizedLegal.has(normalizeCompanyName(f.clientName)) ? 'exact_legal_name' : 'exact_input_name'));

    if (rows.length === 0 && partial.length > 0) {
      rows.push(...partial.slice(0, LDA_PARTIAL_CAP).map((f) => toRow(f, 'name_contains')));
    }

    if (rows.length === 0) {
      rows.push({
        section,
        item: `No Senate LDA filings name ${names.map((n) => `"${n}"`).join(' / ')} as client of record`,
        finding: 'No filings found in Capiro-ingested Senate LDA data',
        source: SOURCE_LDA,
        verification: 'unverified',
      });
    }
    return rows;
  }

  // ── Congressional delegation ─────────────────────────────────────────────

  private async resolveFacility(
    input: VendorReferenceInput,
    sam: SamEntityRecord | null,
    warnings: string[],
  ): Promise<FacilityPlacement | null> {
    const inputState = input.state?.trim().toUpperCase() || null;
    const inputDistrict = input.district ? toUsaSpendingDistrictCode(input.district) : null;
    const address = input.facilityAddress?.trim() || null;

    if (inputState && inputDistrict) {
      return { state: inputState, district: inputDistrict, basis: 'caller_supplied', address };
    }

    if (address) {
      let geo: CensusGeocodeResult | null = null;
      try {
        geo = await this.geocodeOneLine(address);
      } catch (e) {
        warnings.push(`Census geocoder failed for "${address}": ${e instanceof Error ? e.message : String(e)}.`);
      }
      if (geo?.status === 'matched' && geo.congressionalDistrict) {
        const state =
          inputState ?? stateFromOneLine(geo.matchedAddress) ?? stateFromOneLine(address) ?? null;
        if (state) {
          return {
            state,
            district: geo.congressionalDistrict,
            basis: 'census_geocode',
            address: geo.matchedAddress ?? address,
          };
        }
        warnings.push(`Census geocoder placed "${address}" in district ${geo.congressionalDistrict} but no state could be determined; supply state.`);
      } else if (geo) {
        warnings.push(`Census geocoder could not place "${address}" (${geo.status}).`);
      }
    }

    if (inputState) {
      return { state: inputState, district: null, basis: 'state_only_caller_supplied', address };
    }

    if (sam?.physicalAddress?.state) {
      return {
        state: sam.physicalAddress.state,
        district: sam.congressionalDistrict,
        basis: sam.congressionalDistrict ? 'sam_physical_address' : 'state_only_sam_physical_address',
        address: formatAddress(sam.physicalAddress),
      };
    }
    return null;
  }

  /** Census one-line geocode; separated so specs can stub the network. */
  protected geocodeOneLine(address: string): Promise<CensusGeocodeResult> {
    // geocodeAddress builds its one-line string from the parts and drops empties,
    // so passing the whole address as `street` sends it verbatim.
    return geocodeAddress(address, '', '', '');
  }

  private async delegation(placement: FacilityPlacement | null): Promise<VendorReferenceRow[]> {
    const section = 'congressional_delegation' as const;
    if (!placement) {
      return [
        {
          section,
          item: 'No facility state/district available — supply state + district or facilityAddress',
          finding: NOT_SOURCED_FINDING,
          source: SOURCE_DIRECTORY,
          verification: 'not_sourced',
        },
      ];
    }

    // The resolver's input is a facility-shaped record. `geocodeStatus:
    // 'matched'` is its "this facility has been placed" flag — true here in the
    // sense the resolver cares about (a state, and possibly a district, is known),
    // and what lets a state-only placement still resolve both senators.
    const rep = await this.resolver.representativesForFacility({
      state: placement.state,
      congressionalDistrict: placement.district,
      stateHouseDistrict: null,
      stateSenateDistrict: null,
      geocodeStatus: 'matched',
    });
    if (rep.unresolved) {
      return [
        {
          section,
          item: `Delegation unresolved for ${placement.state}${placement.district ? `-${placement.district}` : ''} (${rep.reason})`,
          finding: NOT_SOURCED_FINDING,
          source: SOURCE_DIRECTORY,
          verification: 'not_sourced',
        },
      ];
    }

    const members: Array<{ m: FederalMemberSummary; chamber: 'House' | 'Senate' }> = [];
    if (rep.federal.house) members.push({ m: rep.federal.house, chamber: 'House' });
    for (const s of rep.federal.senate) members.push({ m: s, chamber: 'Senate' });

    const verification =
      placement.basis === 'census_geocode' ||
      placement.basis === 'sam_physical_address' ||
      placement.basis === 'state_only_sam_physical_address'
        ? 'confirmed'
        : 'unverified';

    const rows: VendorReferenceRow[] = [];
    if (members.length === 0) {
      rows.push({
        section,
        item: `No current members on record for ${placement.state}${placement.district ? `-${placement.district}` : ''}`,
        finding: NOT_SOURCED_FINDING,
        source: SOURCE_DIRECTORY,
        verification: 'not_sourced',
      });
      return rows;
    }
    if (placement.district && !rep.federal.house) {
      rows.push({
        section,
        item: `No current House member on record for ${placement.state}-${placement.district}`,
        finding: NOT_SOURCED_FINDING,
        source: SOURCE_DIRECTORY,
        verification: 'not_sourced',
        detail: { districtBasis: placement.basis },
      });
    }

    const seats = await this.prisma.congressCommitteeMembership.findMany({
      where: { bioguideId: { in: members.map((x) => x.m.bioguideId) } },
      select: {
        bioguideId: true,
        systemCode: true,
        title: true,
        rank: true,
        committee: { select: { name: true, chamber: true, parentSystemCode: true, isCurrent: true } },
      },
    });
    const seatsByMember = new Map<string, typeof seats>();
    for (const s of seats) {
      if (!s.committee?.isCurrent) continue;
      const bucket = seatsByMember.get(s.bioguideId) ?? [];
      bucket.push(s);
      seatsByMember.set(s.bioguideId, bucket);
    }

    for (const { m, chamber } of members) {
      const stateAbbr = placement.state;
      const stateDistrict =
        chamber === 'House'
          ? `${stateAbbr}-${placement.district ?? (m.district == null ? '00' : String(m.district).padStart(2, '0'))}`
          : `${stateAbbr} (statewide)`;
      const memberLabel = m.party ? `${m.fullName} (${partyInitial(m.party)})` : m.fullName;
      const memberSeats = (seatsByMember.get(m.bioguideId) ?? [])
        .slice()
        .sort((a, b) => {
          const aFull = a.committee.parentSystemCode == null ? 0 : 1;
          const bFull = b.committee.parentSystemCode == null ? 0 : 1;
          if (aFull !== bFull) return aFull - bFull;
          return (a.rank ?? 999) - (b.rank ?? 999);
        })
        .slice(0, COMMITTEES_PER_MEMBER_CAP);

      const base = (committee: string | null, systemCode: string | null, role: string): VendorReferenceRow => {
        const detail: DelegationDetail = {
          bioguideId: m.bioguideId,
          member: memberLabel,
          chamber,
          stateDistrict,
          committee,
          committeeSystemCode: systemCode,
          role,
          districtBasis: placement.basis,
        };
        return {
          section,
          item: memberLabel,
          finding: committee ? `${memberLabel}, ${chamber}, ${stateDistrict}: ${role}, ${committee}` : `${memberLabel}, ${chamber}, ${stateDistrict}`,
          source: SOURCE_DIRECTORY,
          verification,
          detail: { ...detail },
        };
      };

      if (memberSeats.length === 0) {
        rows.push(base(null, null, 'Member'));
        continue;
      }
      for (const s of memberSeats) {
        rows.push(base(s.committee.name, s.systemCode, roleLabel(s.title)));
      }
    }
    return rows;
  }

  // ── Handling notes ───────────────────────────────────────────────────────

  private handlingNotes(
    identity: VendorIdentity,
    placement: FacilityPlacement | null,
    lobbying: VendorReferenceRow[],
  ): string[] {
    const notes: string[] = [`Identity: ${identity.explanation}`];
    if (identity.ambiguous) {
      notes.push('Re-pull with `uei` once the correct SAM.gov entity is chosen; until then every row is name-derived.');
    }
    notes.push(
      'Confirmed rows came from a primary record (SAM.gov, Senate LDA, USAspending/Tango, Capiro directory) joined on the identity above; Unverified rows are name-derived or caller-supplied and must be checked before use.',
    );
    if (placement) {
      switch (placement.basis) {
        case 'sam_physical_address':
        case 'state_only_sam_physical_address':
          notes.push('Delegation resolved from the SAM.gov registered physical address, which may not be the facility relevant to this request; supply state + district or facilityAddress to re-target.');
          break;
        case 'census_geocode':
          notes.push('Delegation resolved by Census geocoding of the supplied facility address; the address itself is caller-supplied.');
          break;
        default:
          notes.push('Delegation resolved from the caller-supplied state/district; Capiro did not verify the facility location.');
      }
    } else {
      notes.push('No facility placement was available; supply state + district or facilityAddress to populate the delegation.');
    }
    if (lobbying.some((r) => (r.detail as Partial<LobbyingDetail> | undefined)?.matchBasis === 'name_contains')) {
      notes.push('Lobbying rows are partial-name matches (no filing names the company exactly); treat as leads, not representation of record.');
    }
    notes.push('Litigation and adverse history is never sourced by Capiro; confirm or clear it by hand before export.');
    notes.push('Facts in this pull travel in the technical annex and staff briefing only — never in funding-table or report-language text.');
    return notes;
  }

  // ── Fail-soft wrapper ────────────────────────────────────────────────────

  private async guard<T>(
    label: string,
    warnings: string[],
    fn: () => Promise<T>,
    fallback: T,
  ): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.logger.warn(`vendor-reference ${label} failed: ${message}`);
      warnings.push(`${capitalize(label)} unavailable: ${message}.`);
      return fallback;
    }
  }
}

// ── Pure helpers ───────────────────────────────────────────────────────────

function nameMatches(e: SamEntityRecord, target: string): boolean {
  if (target.length < 3) return false;
  const legal = normalizeCompanyName(e.legalBusinessName);
  const dba = normalizeCompanyName(e.dbaName);
  return legal === target || (dba.length >= 3 && dba === target);
}

function dedupeByUei(entities: SamEntityRecord[]): SamEntityRecord[] {
  const seen = new Map<string, SamEntityRecord>();
  for (const e of entities) if (!seen.has(e.uei)) seen.set(e.uei, e);
  return Array.from(seen.values());
}

function notSourcedListRow(
  section: VendorReferenceRow['section'],
  item: string,
  source: string,
): VendorReferenceRow {
  return { section, item, finding: NOT_SOURCED_FINDING, source, verification: 'not_sourced' };
}

export function formatAddress(a: {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
}): string {
  const street = [a.line1, a.line2].filter(Boolean).join(', ');
  const cityLine = [a.city, [a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [street, cityLine, a.country && a.country !== 'USA' ? a.country : null].filter(Boolean).join(', ');
}

function formatCodes(sam: SamEntityRecord): string {
  const naics = sam.naicsCodes.length
    ? `NAICS ${sam.naicsCodes.map((c) => (c === sam.primaryNaics ? `${c} (primary)` : c)).join(', ')}`
    : 'NAICS: none on record';
  const psc = sam.pscCodes.length ? `PSC ${sam.pscCodes.join(', ')}` : 'PSC: none on record';
  return `${naics}; ${psc}`;
}

function joinAgency(agency: string | null, subTier: string | null): string | null {
  if (agency && subTier && subTier !== agency) return `${agency} / ${subTier}`;
  return agency ?? subTier ?? null;
}

/** LDA filing_period comes in several spellings; render as "Q2 2026" when a quarter is stated. */
export function periodLabel(year: number, period: string | null, filingType: string): string {
  if (/^RR|REGISTRATION/i.test(filingType ?? '')) return `Registration ${year}`;
  const text = (period ?? '').toUpperCase().replace(/[_-]/g, ' ');
  const numeric = text.match(/\bQ([1-4])\b|\b([1-4])(?:ST|ND|RD|TH)?\s+QUARTER\b/);
  if (numeric) return `Q${numeric[1] ?? numeric[2]} ${year}`;
  const ordinal = ['FIRST', 'SECOND', 'THIRD', 'FOURTH'].findIndex((w) => text.includes(`${w} QUARTER`));
  if (ordinal >= 0) return `Q${ordinal + 1} ${year}`;
  const typeQ = (filingType ?? '').toUpperCase().match(/^Q([1-4])/);
  if (typeQ) return `Q${typeQ[1]} ${year}`;
  return period ? `${period} ${year}` : String(year);
}

function roleLabel(title: string | null): string {
  if (!title) return 'Member';
  if (/^chair/i.test(title) || /chairman|chairwoman/i.test(title)) return 'Chair';
  if (/ranking/i.test(title)) return 'Ranking Member';
  return title;
}

function partyInitial(party: string): string {
  const p = party.trim();
  if (/^dem/i.test(p)) return 'D';
  if (/^rep/i.test(p)) return 'R';
  if (/^ind/i.test(p)) return 'I';
  return p.slice(0, 1).toUpperCase();
}

/** Pull a 2-letter state out of a one-line US address ("…, Fort Worth, TX 76108"). */
export function stateFromOneLine(address: string | null): string | null {
  if (!address) return null;
  const m = address.toUpperCase().match(/(?:,|\s)\s*([A-Z]{2})\s*,?\s*\d{5}(?:-\d{4})?\s*(?:,\s*(?:USA|US))?\s*$/);
  return m ? m[1]! : null;
}

function uniqueTerms(terms: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of terms) {
    const k = t.trim().toUpperCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(t.trim());
  }
  return out;
}

function toNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}
function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function isoDate(d: Date | string | null | undefined): string | null {
  if (d == null) return null;
  if (d instanceof Date) return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  const s = String(d).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}
function truncate(s: string | null | undefined, max: number): string | null {
  if (!s) return null;
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
