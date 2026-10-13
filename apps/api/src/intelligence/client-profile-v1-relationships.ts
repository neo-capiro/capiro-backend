import type { SettledProfileV1Sources } from './client-profile-v1-sources.js';
import type { ProfileV1Context } from './client-profile-v1.shared.js';
import type { OfficeRecommenderService } from './office-recommender.service.js';
import type { buildProfileV1Hearings } from './client-profile-v1-legislative.js';

export function buildProfileV1DistrictRows(values: SettledProfileV1Sources) {
  const { district, districtSpend } = values;
  const districtRows =
    districtSpend.linked && Array.isArray(districtSpend.districts)
      ? districtSpend.districts
          .filter((d) => d.totalAmount > 0)
          .sort((a, b) => b.totalAmount - a.totalAmount)
          .slice(0, 5)
          .map((d) => ({
            district: d.district,
            jobs: 0,
            spend: d.totalAmount,
            awardCount: d.awardCount,
            capability: 'Federal contract spend',
            dataYear:
              d.demographics &&
              typeof d.demographics === 'object' &&
              'dataYear' in (d.demographics as Record<string, unknown>)
                ? Number((d.demographics as Record<string, unknown>).dataYear) || 0
                : 0,
          }))
      : [];
  return districtRows;
}

export function prepareProfileV1Relationships(
  values: SettledProfileV1Sources,
  hearingsList: Awaited<ReturnType<typeof buildProfileV1Hearings>>,
) {
  const { trackedBills, exStaffers } = values;
  const exStafferNames = exStaffers.lobbyists.map((l) => l.name.toLowerCase());
  const committeeNames = Array.from(
    new Set(hearingsList.map((h) => h.committeeName).filter(Boolean)),
  ).slice(0, 12);
  const trackedBillIdsForRec = trackedBills.bills
    .map((b) => b.identifier)
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  return { exStafferNames, committeeNames, trackedBillIdsForRec };
}

export function buildProfileV1ScopedGraph(
  values: SettledProfileV1Sources,
  relationships: ReturnType<typeof prepareProfileV1Relationships>,
  officeRecommendations: Awaited<ReturnType<OfficeRecommenderService['recommend']>>,
) {
  const { graph, exStaffers } = values;
  const { exStafferNames, committeeNames } = relationships;
  const recommendedMemberCount = officeRecommendations.length;
  const scopedGraph = {
    nodes: graph.nodes
      .filter(
        (n) => ['lobbyist', 'agency', 'registrant'].includes(n.type) || n.id.startsWith('member:'),
      )
      .slice(0, 40),
    edges: graph.edges.slice(0, 80),
    resolutionQuality: graph.resolutionQuality,
    meta: {
      lobbyistCount: exStaffers.lobbyists.length,
      memberCount: recommendedMemberCount,
      committeeCount: committeeNames.length,
    },
    hints: {
      exStafferNames,
    },
  };
  return scopedGraph;
}

export function profileV1HeroTruthState(values: SettledProfileV1Sources) {
  const { roi } = values;
  const hasLobbyingTtm = (roi.lobbySpend ?? 0) > 0;
  const hasObligationsTtm = (roi.contractWins ?? 0) > 0;
  const heroTruthState: 'normal' | 'zero_obligation' | 'no_activity' =
    hasLobbyingTtm && !hasObligationsTtm
      ? 'zero_obligation'
      : hasLobbyingTtm || hasObligationsTtm
        ? 'normal'
        : 'no_activity';
  return heroTruthState;
}
