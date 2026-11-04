import { US_STATE_FIPS_TO_USPS } from '../../common/us-congressional-districts.js';
import { defenseTextSignals } from './portfolio-office-bill-text.js';
import { TIGERWEB_LEGISLATIVE_URL } from '../../external/census-geocoder/tigerweb-boundary.client.js';
import type { CongressMember, ClientFacility } from '@prisma/client';
import { hitsTerms, currentCongress, officialEvidence } from './portfolio-office-evidence.js';
import {
  boundaryVersionKey,
  servingBoundaryVersion,
  type GeographicResolution,
} from '../../external/census-geocoder/geographic-boundary.js';
import type { PortfolioTx } from './portfolio-proposal.store.js';
import type { PortfolioEvidence } from './portfolio.contracts.js';

export interface OfficeSignal {
  kind: 'statement' | 'sponsor' | 'committee' | 'hearing' | 'geography' | 'defense_priority';
  rationale: string;
  evidence: PortfolioEvidence;
}
export { hitsTerms, currentCongress, officialEvidence } from './portfolio-office-evidence.js';
export function officeFit(signals: readonly OfficeSignal[]): 'strong' | 'moderate' | 'limited' {
  const kinds = new Set(signals.map((signal) => signal.kind));
  // Evidence breadth, not a probability or an assertion of political support.
  return kinds.size >= 3 ? 'strong' : kinds.size >= 2 ? 'moderate' : 'limited';
}
export function geographicSignal(
  member: CongressMember,
  facility: ClientFacility,
): OfficeSignal | null {
  const resolution = facility.geographicResolution as unknown as GeographicResolution | null;
  if (!['house', 'senate'].includes(member.chamber.toLowerCase())) return null;
  if (
    !['US', 'PR', 'GU', 'VI', 'AS', 'MP'].includes(facility.country ?? '') ||
    facility.siteVerificationStatus !== 'verified' ||
    facility.siteStatus !== 'operating' ||
    !resolution ||
    !['census_tigerweb', 'arcgis_census'].includes(resolution.source ?? '') ||
    resolution.status !== 'resolved' ||
    resolution.requiresReview ||
    resolution.boundaryAdjacent ||
    !resolution.version ||
    boundaryVersionKey(resolution.version) !== boundaryVersionKey(servingBoundaryVersion()) ||
    resolution.version.congress !== currentCongress() ||
    !facility.state ||
    facility.state !== member.state
  )
    return null;
  const district = resolution.districts.find(
    (value) => value.chamber === 'house' && value.congress === currentCongress(),
  );
  if (
    !district ||
    US_STATE_FIPS_TO_USPS[district.stateFips ?? resolution.stateFips ?? ''] !== member.state ||
    (member.chamber.toLowerCase() === 'house' && Number(district.code) !== member.district)
  )
    return null;
  // The official boundary response is retained on the canonical facility. An explanatory
  // record is not represented as a quotation from a member or a commitment to support.
  const evidence: PortfolioEvidence = {
    title: 'Verified facility and current Census boundary',
    excerpt: `${facility.name}: ${facility.state}, House district ${district.code}, Congress ${district.congress}. Boundary resolved ${resolution.resolvedAt}.`,
    url: TIGERWEB_LEGISLATIVE_URL,
    observedAt: resolution.resolvedAt,
    sourceType: 'official',
  };
  if (
    !Number.isFinite(Date.parse(evidence.observedAt)) ||
    Date.parse(evidence.observedAt) > Date.now()
  )
    return null;
  return {
    kind: 'geography',
    rationale: `Verified operating facility ${facility.name} is in this office's current constituency.`,
    evidence,
  };
}
export async function canonicalOfficeSignals(
  tx: PortfolioTx,
  member: CongressMember,
  terms: string[],
  facilities: ClientFacility[],
): Promise<OfficeSignal[]> {
  const [bills, memberships] = await Promise.all([
    tx.congressBill.findMany({
      where: {
        congress: currentCongress(),
        OR: [
          { sponsorBioguideId: member.bioguideId },
          { cosponsors: { some: { bioguideId: member.bioguideId, withdrawnDate: null } } },
        ],
      },
      orderBy: { lastSyncedAt: 'desc' },
      take: 80,
    }),
    tx.congressCommitteeMembership.findMany({
      where: { bioguideId: member.bioguideId, committee: { isCurrent: true } },
      include: { committee: true },
      take: 40,
    }),
  ]);
  const signals: OfficeSignal[] = await defenseTextSignals(tx, bills, terms);
  for (const bill of bills) {
    const text = [
      bill.title,
      bill.latestActionText,
      bill.policyArea,
      ...bill.subjects,
      ...bill.peCodes,
    ]
      .filter(Boolean)
      .join(' ');
    if (!hitsTerms(text, terms)) continue;
    const evidence = officialEvidence(bill.url, bill.title, bill.title, bill.lastSyncedAt);
    if (!evidence) continue;
    signals.push({
      kind: 'sponsor',
      rationale: `${bill.sponsorBioguideId === member.bioguideId ? 'Sponsor' : 'Current cosponsor'} of ${bill.title}, which matches approved client terms.`,
      evidence,
    });
    if (/\b(?:national defense authorization|defense appropriations|NDAA)\b/i.test(bill.title))
      signals.push({
        kind: 'defense_priority',
        rationale: `Defense legislative priority evidenced by ${bill.title}.`,
        evidence,
      });
  }
  for (const { committee } of memberships) {
    if (
      committee.urlSource !== 'congress_gov' ||
      !committee.jurisdiction ||
      !hitsTerms(committee.jurisdiction, terms)
    )
      continue;
    const evidence = officialEvidence(
      committee.url,
      committee.name,
      committee.jurisdiction,
      committee.urlVerifiedAt,
    );
    if (evidence)
      signals.push({
        kind: 'committee',
        rationale: `Current ${committee.name} membership; its sourced jurisdiction matches approved client terms.`,
        evidence,
      });
  }
  const committeeCodes = memberships.map((row) => row.systemCode);
  if (committeeCodes.length && terms.length) {
    const since = new Date();
    since.setUTCFullYear(since.getUTCFullYear() - 1);
    const hearings = await tx.committeeHearing.findMany({
      where: {
        committeeSystemCode: { in: committeeCodes },
        congress: currentCongress(),
        visibility: 'public',
        canonicalHearingId: null,
        eventStatus: { not: 'canceled' },
        date: { gte: since },
      },
      orderBy: { syncedAt: 'desc' },
      take: 60,
    });
    for (const hearing of hearings) {
      if (!hitsTerms(hearing.title, terms)) continue;
      const evidence = officialEvidence(
        hearing.url,
        hearing.title,
        hearing.title,
        hearing.lastOfficialUpdateAt ?? hearing.syncedAt,
      );
      if (evidence)
        signals.push({
          kind: 'hearing',
          rationale: `Member of ${hearing.committeeName}, whose ${hearing.date.toISOString().slice(0, 10)} hearing covers approved client terms; attendance and support are not established.`,
          evidence,
        });
    }
  }
  for (const facility of facilities) {
    const signal = geographicSignal(member, facility);
    if (signal) signals.push(signal);
  }
  const counts = new Map<OfficeSignal['kind'], number>();
  return signals.filter((signal) => {
    const count = counts.get(signal.kind) ?? 0;
    counts.set(signal.kind, count + 1);
    return count < 3;
  });
}
