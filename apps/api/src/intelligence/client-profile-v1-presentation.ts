import type { SettledProfileV1Sources } from './client-profile-v1-sources.js';
import type { ProfileV1Context } from './client-profile-v1.shared.js';
import type { ProfileV1Ports } from './client-profile-v1.shared.js';
import type { buildProfileV1Snapshot } from './client-profile-v1-snapshot.js';
import type {
  buildProfileV1Kanban,
  buildProfileV1Hearings,
} from './client-profile-v1-legislative.js';
import type {
  buildProfileV1DistrictRows,
  buildProfileV1ScopedGraph,
  profileV1HeroTruthState,
} from './client-profile-v1-relationships.js';
import type { OfficeRecommenderService } from './office-recommender.service.js';
import type { classifyTrajectory } from './trajectory-classifier.model.js';

export type ProfileV1Sections = {
  snapshot: Record<string, any>;
  financialFootprint: Record<string, any>;
  legislativeRegulatory: Record<string, any>;
  relationships: Record<string, any>;
};
export interface ProfileV1Coercions {
  asFinite(value: unknown, fallback?: number): number;
  asFiniteOrNull(value: unknown): number | null;
  asIsoOrNull(value: unknown): string | null;
}
export function profileV1Finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function profileV1FiniteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function profileV1IsoOrNull(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'string') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

export function normalizeProfileV1Sections(
  sections: ProfileV1Sections,
  coercions: ProfileV1Coercions,
) {
  const snapshot = {
    ...sections.snapshot,
    changes7dCount: Math.max(
      0,
      Math.trunc(coercions.asFinite(sections.snapshot.changes7dCount, 0)),
    ),
    activity14d: Array.isArray(sections.snapshot.activity14d)
      ? [...sections.snapshot.activity14d].sort((a, b) =>
          String(a?.date ?? '').localeCompare(String(b?.date ?? '')),
        )
      : [],
    topAlerts: Array.isArray(sections.snapshot.topAlerts)
      ? sections.snapshot.topAlerts.map((a: Record<string, unknown>) => ({
          ...a,
          when: coercions.asIsoOrNull(a.when),
          countdownDays: coercions.asFiniteOrNull(a.countdownDays),
          state: a.state === 'acknowledged' ? 'acknowledged' : null,
        }))
      : [],
    alertsHiddenCount: Math.max(
      0,
      Math.trunc(coercions.asFinite(sections.snapshot.alertsHiddenCount, 0)),
    ),
  };

  const financialFootprint = {
    ...sections.financialFootprint,
    districtNexus: {
      ...(sections.financialFootprint.districtNexus ?? {}),
      topDistricts: Array.isArray(sections.financialFootprint?.districtNexus?.topDistricts)
        ? [...sections.financialFootprint.districtNexus.topDistricts]
            .sort((a, b) => coercions.asFinite(b?.jobs, 0) - coercions.asFinite(a?.jobs, 0))
            .slice(0, 5)
        : [],
    },
  };

  const legislativeRegulatory = normalizeLegislativeSection(sections, coercions);

  const relationships = {
    ...sections.relationships,
    exStafferCount: Math.max(
      0,
      Math.trunc(coercions.asFinite(sections.relationships.exStafferCount, 0)),
    ),
    officeRecommender: Array.isArray(sections.relationships.officeRecommender)
      ? [...sections.relationships.officeRecommender]
          .sort((a, b) => coercions.asFinite(b?.score, 0) - coercions.asFinite(a?.score, 0))
          .slice(0, 12)
      : [],
  };

  return { snapshot, financialFootprint, legislativeRegulatory, relationships };
}

export interface ProfileV1Presentation {
  context: ProfileV1Context;
  values: SettledProfileV1Sources;
  snapshot: ReturnType<typeof buildProfileV1Snapshot>;
  kanbanColumns: ReturnType<typeof buildProfileV1Kanban>;
  regulatoryLifecycle: ReturnType<ProfileV1Ports['buildRegulatoryLifecycle']>;
  hearingsList: Awaited<ReturnType<typeof buildProfileV1Hearings>>;
  districtRows: ReturnType<typeof buildProfileV1DistrictRows>;
  officeRecommendations: Awaited<ReturnType<OfficeRecommenderService['recommend']>>;
  scopedGraph: ReturnType<typeof buildProfileV1ScopedGraph>;
  heroTruthState: ReturnType<typeof profileV1HeroTruthState>;
  quarterRoiSeries: Awaited<ReturnType<ProfileV1Ports['buildRoiQuarterSeries']>>;
  trajectoryModel: ReturnType<typeof classifyTrajectory>;
}

export function buildProfileV1Sections(
  input: ProfileV1Presentation,
  ports: Pick<ProfileV1Ports, 'normalizeProfileV1Sections'>,
) {
  const {
    context,
    values,
    snapshot,
    kanbanColumns,
    regulatoryLifecycle,
    hearingsList,
    districtRows,
    officeRecommendations,
    scopedGraph,
    heroTruthState,
    quarterRoiSeries,
    trajectoryModel,
  } = input;
  const { now } = context;
  const { profile, roi, fec, district, trackedBills, health, exStaffers, changes } = values;
  const { byDay, dailyBriefing, topAlerts, alertsHiddenCount } = snapshot;
  const sections = ports.normalizeProfileV1Sections({
    snapshot: buildSnapshotSection(input),
    financialFootprint: buildFinancialSection(input),
    legislativeRegulatory: {
      kanban: {
        total: trackedBills.total,
        issueCodes: trackedBills.issueCodes,
        columns: kanbanColumns,
      },
      regulatoryLifecycle,
      hearingsAndMarkups: hearingsList,
    },
    relationships: {
      scopedGraph,
      officeRecommender: officeRecommendations,
      exStafferCount: exStaffers.lobbyists.length,
    },
  });
  return sections;
}

export function buildProfileV1Envelope(
  context: ProfileV1Context,
  values: SettledProfileV1Sources,
  snapshot: ReturnType<typeof buildProfileV1Snapshot>,
  sections: ReturnType<typeof buildProfileV1Sections>,
  metadata: { sourceCount: number; unresolvedMappings: number },
) {
  const { client, clientId, now } = context;
  const { profile, trackedBills } = values;
  const { changesInboxHref } = snapshot;
  const { sourceCount, unresolvedMappings } = metadata;
  const primaryIssueCode = trackedBills.issueCodes
    .find((code) => typeof code === 'string' && code.trim().length > 0)
    ?.trim();
  const competitorIssueHref = primaryIssueCode
    ? `/intelligence/issues/${encodeURIComponent(primaryIssueCode)}`
    : '';
  return {
    client: { id: client.id, name: client.name },
    generatedAt: now.toISOString(),
    meta: {
      schema: 'client-profile-v1',
      sectionOrder: ['snapshot', 'financialFootprint', 'legislativeRegulatory', 'relationships'],
      hasSnapshot: true,
      hasFinancialFootprint: true,
      hasLegislativeRegulatory: true,
      hasRelationships: true,
      generatedAt: now.toISOString(),
      sourceCount,
      unresolvedMappings,
    },
    links: {
      changesInbox: changesInboxHref,
      mappingsAdmin: '/settings/intelligence-mappings',
      competitorIssuePage: competitorIssueHref,
      billDetailBase: '/explorer',
      entityResolutionQueue: '/settings/intelligence-mappings',
    },
    actionTargets: buildProfileV1ActionTargets(clientId, changesInboxHref),
    sections,
    movedOut: {
      changesInbox: true,
      entityResolutionQueue: true,
      competitorLeaderboard: true,
      billEnrichment: true,
    },
  };
}

function buildProfileV1ActionTargets(clientId: string, changesInboxHref: string) {
  return {
    snapshot: {
      seeAllChanges: {
        route: '/intelligence/changes',
        params: { clientId },
        href: changesInboxHref,
      },
      viewAllAlerts: {
        route: '/intelligence/changes',
        params: { clientId },
        href: changesInboxHref,
      },
      mappingsHelp: {
        route: '/settings/intelligence-mappings',
        params: {},
        href: '/settings/intelligence-mappings',
      },
    },
    financial: {
      runFecEnrichment: {
        route: '/settings/intelligence-mappings',
        params: { clientId, source: 'fec_employer' },
        href: '/settings/intelligence-mappings',
      },
      districtSupport: {
        route: '/settings/intelligence-mappings',
        params: { clientId, focus: 'district_nexus' },
        href: '/settings/intelligence-mappings',
      },
    },
    legislative: {
      billDrill: {
        route: '/explorer',
        params: { billIdentifierParam: ':bill' },
        hrefTemplate: '/explorer?bill=:bill',
      },
      syncCalendar: {
        route: '/engagement',
        params: { clientId },
        href: '/engagement',
      },
      setAlerts: {
        route: '/intelligence/changes',
        params: { clientId },
        href: changesInboxHref,
      },
    },
    relationships: {
      officeAll: {
        route: '/intelligence/issues',
        params: { clientId },
        href: '/intelligence/issues',
      },
      officeDrill: {
        route: '/intelligence/issues',
        params: { officeParam: ':office' },
        hrefTemplate: '/intelligence/issues?office=:office',
      },
      graphNodeDrill: {
        route: '/intelligence/issues',
        params: { nodeParam: ':node' },
        hrefTemplate: '/intelligence/issues?node=:node',
      },
    },
  };
}

function buildSnapshotSection(input: ProfileV1Presentation) {
  const {
    context,
    values,
    snapshot,
    kanbanColumns,
    regulatoryLifecycle,
    hearingsList,
    districtRows,
    officeRecommendations,
    scopedGraph,
    heroTruthState,
    quarterRoiSeries,
    trajectoryModel,
  } = input;
  const { now } = context;
  const { profile, roi, fec, district, trackedBills, health, exStaffers, changes } = values;
  const { byDay, dailyBriefing, topAlerts, alertsHiddenCount } = snapshot;
  return {
    trajectory: {
      label: trajectoryModel.label,
      growthRate: profile.lobbyIntel.growthRate,
      totalSpending: profile.lobbyIntel.totalSpending,
      yearlySpend: profile.lda.yearlySpend,
      model: {
        label: trajectoryModel.label,
        confidence: trajectoryModel.confidence,
        score: trajectoryModel.score,
        source: trajectoryModel.source,
      },
      fallback: {
        label: profile.lobbyIntel.trajectory,
      },
    },
    health,
    dailyBriefing,
    topAlerts,
    alertsHiddenCount,
    activity14d: Array.from(byDay.values()),
    changes7dCount: changes.length,
  };
}

function buildFinancialSection(input: ProfileV1Presentation) {
  const {
    context,
    values,
    snapshot,
    kanbanColumns,
    regulatoryLifecycle,
    hearingsList,
    districtRows,
    officeRecommendations,
    scopedGraph,
    heroTruthState,
    quarterRoiSeries,
    trajectoryModel,
  } = input;
  const { now } = context;
  const { profile, roi, fec, district, trackedBills, health, exStaffers, changes } = values;
  const { byDay, dailyBriefing, topAlerts, alertsHiddenCount } = snapshot;
  return {
    hero: {
      lobbyingTtm: roi.lobbySpend,
      obligationsTtm: roi.contractWins,
      returnRatio: roi.roi,
      gap: roi.gap,
      truthState: heroTruthState,
    },
    series: {
      lobbying: profile.lda.yearlySpend,
      obligations: profile.contracting.yearlySpend,
      quarterSeries: quarterRoiSeries,
    },
    fecMoneyFlow: fec,
    districtNexus: {
      topDistricts: districtRows,
      // Retained for response-shape back-compat; the free-text capability
      // parse no longer drives topDistricts (now spend-only). Always [] in
      // practice since prod has no capability districtNexus input.
      capabilities: district.capabilities,
    },
  };
}

function normalizeLegislativeSection(sections: ProfileV1Sections, coercions: ProfileV1Coercions) {
  const stageOrder = ['introduced', 'committee', 'passed', 'enacted'];
  const legislativeRegulatory = {
    ...sections.legislativeRegulatory,
    kanban: {
      ...(sections.legislativeRegulatory.kanban ?? {}),
      columns: Array.isArray(sections.legislativeRegulatory?.kanban?.columns)
        ? [...sections.legislativeRegulatory.kanban.columns]
            .sort((a, b) => stageOrder.indexOf(String(a?.id)) - stageOrder.indexOf(String(b?.id)))
            .map((c) => ({
              ...c,
              count: Math.max(0, Math.trunc(coercions.asFinite(c?.count, 0))),
              bills: Array.isArray(c?.bills)
                ? [...c.bills].sort(
                    (x, y) =>
                      coercions.asFinite(y?.probability, 0) - coercions.asFinite(x?.probability, 0),
                  )
                : [],
            }))
        : [],
    },
    hearingsAndMarkups: Array.isArray(sections.legislativeRegulatory.hearingsAndMarkups)
      ? [...sections.legislativeRegulatory.hearingsAndMarkups]
          .map((h) => ({ ...h, date: coercions.asIsoOrNull(h?.date) }))
          .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')))
      : [],
  };
  return legislativeRegulatory;
}
