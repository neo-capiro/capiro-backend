import { EngagementTaskStatus } from '@prisma/client';
import { FEC_DISCLAIMER } from './fec-disclaimer.js';
import { federalHearingWhere } from '../hearing-discovery/hearing-geography.js';
import { dateBoundsInZone } from './time-bounds.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type {
  ProfileV1Context,
  ProfileV1Ports,
  ProfileV1Settler,
} from './client-profile-v1.shared.js';

export async function collectProfileV1Sources(
  prisma: PrismaService,
  ports: ProfileV1Ports,
  context: ProfileV1Context,
) {
  const { clientId, tenantId } = context;
  const mappingRowsPromise = prisma.withTenant(tenantId, (tx) =>
    tx.clientIntelMapping.findMany({
      where: { clientId },
      select: { source: true, confirmed: true, externalId: true },
    }),
  );
  const trackedBillsPromise = ports.getTrackedBills(clientId, tenantId);
  const settledSourceLabels = [
    'profile',
    'lobbyingRoi',
    'fecMoneyFlow',
    'districtNexus',
    'trackedBills',
    'billRegulationLinks',
    'knowledgeGraph',
    'engagementHealth',
    'exStaffers',
    'commentAlerts',
    'changes',
    'hearings',
    'meetings',
    'mailThreads',
    'doneTasks',
    'debriefs',
    'outreachRecords',
    'mappingRows',
    'districtNexusSpend',
    'overdueComments',
    'competitorLda',
    'contractAwards',
    'alertStates',
    'hearingAlerts',
    'clientRelevantRegulations',
  ] as const;
  const sources: Array<Promise<unknown>> = [
    ...startProfileSources(ports, context, trackedBillsPromise),
    ...readCalendarAndActivity(prisma, context),
    ...startDistrictAndAlertSources(
      prisma,
      ports,
      context,
      trackedBillsPromise,
      mappingRowsPromise,
    ),
  ];
  const settled = await Promise.allSettled(
    sources.map((work, index) =>
      ports.withSourceBudget(settledSourceLabels[index] ?? `source_${index}`, clientId, work),
    ),
  );
  return { settled, settledSourceLabels };
}

function startProfileSources(
  ports: ProfileV1Ports,
  context: ProfileV1Context,
  trackedBillsPromise: ReturnType<ProfileV1Ports['getTrackedBills']>,
): Array<Promise<unknown>> {
  const { client, clientId, tenantId, day7 } = context;
  return [
    ports.getClientProfile(clientId, tenantId),
    ports.getLobbyingRoi(clientId, tenantId),
    ports.getFecMoneyFlow(clientId, tenantId),
    ports.getDistrictNexus(clientId, tenantId),
    trackedBillsPromise,
    ports.getBillRegulationLinks(clientId, tenantId, trackedBillsPromise),
    // [6] Knowledge graph: REMOVED from the client Intelligence tab. The graph
    // is being relocated to the Intelligence Center (it still has its own
    // dedicated endpoint + getKnowledgeGraph() method, used by
    // KnowledgeGraphPage). It was the single slowest source here — kg_walk()
    // ran inside an interactive transaction and, under the 24-way fan-out,
    // produced "Unable to start a transaction" pool-starvation errors plus
    // 8–18s tail latency. We keep this positional slot (so every later index
    // is unchanged) but resolve a static empty graph instead of touching the
    // DB. scopedGraph is built from this empty shape; the Relationships
    // section no longer renders the graph, so nothing downstream regresses.
    Promise.resolve({
      nodes: [] as Array<{ id: string; type: string; label: string }>,
      edges: [] as Array<{ source: string; target: string; type: string }>,
      resolutionQuality: { avgConfidence: 0, confirmedCount: 0, unconfirmedCount: 0 },
    } as unknown as Awaited<ReturnType<ProfileV1Ports['getKnowledgeGraph']>>),
    ports.computeEngagementHealth(clientId, tenantId),
    ports.getExStaffers(clientId, tenantId),
    ports.getCommentPeriodAlerts(tenantId),
    ports.getChanges(tenantId, day7.toISOString(), clientId),
  ];
}

function readCalendarAndActivity(
  prisma: PrismaService,
  context: ProfileV1Context,
): Array<Promise<unknown>> {
  const { clientId, tenantId, now, day14, day21 } = context;
  return [
    prisma.committeeHearing.findMany({
      // `date` is @db.Date, stored at UTC midnight of the hearing's Eastern day.
      // `gte: now` therefore excluded TODAY's hearings for the whole working
      // day — 00:00Z >= 13:00Z is false — so a hearing happening right now was
      // never in this feed. Compare against the start of the Eastern day.
      where: federalHearingWhere({
        date: { gte: dateBoundsInZone(now, 'America/New_York').start, lte: day21 },
      }),
      orderBy: [{ date: 'asc' }, { time: 'asc' }],
      take: 40,
    }),
    prisma.withTenant(tenantId, (tx) =>
      tx.meeting.findMany({
        where: { clientId, startsAt: { gte: day14 } },
        select: { startsAt: true },
        orderBy: { startsAt: 'asc' },
      }),
    ),
    prisma.withTenant(tenantId, (tx) =>
      tx.mailThread.findMany({
        where: { clientId, lastMessageAt: { gte: day14 } },
        select: { lastMessageAt: true },
        orderBy: { lastMessageAt: 'asc' },
      }),
    ),
    prisma.withTenant(tenantId, (tx) =>
      tx.engagementTask.findMany({
        where: {
          clientId,
          status: EngagementTaskStatus.done,
          updatedAt: { gte: day14 },
        },
        select: { updatedAt: true },
        orderBy: { updatedAt: 'asc' },
      }),
    ),
    prisma.withTenant(tenantId, (tx) =>
      tx.meetingDebrief.findMany({
        where: { clientId, createdAt: { gte: day14 } },
        select: { createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
    ),
    // Outreach sent per day, feeds the 5th Activity row in the snapshot
    // panel (Meetings / Outreach sent / Tasks done / Bills tracked /
    // Critical alerts). Mockup spec requires this row; previously only
    // surfaced as an aggregate inside computeEngagementHealth.
    prisma.withTenant(tenantId, (tx) =>
      tx.outreachRecord.findMany({
        where: { clientId, sentAt: { gte: day14 } },
        select: { sentAt: true },
        orderBy: { sentAt: 'asc' },
      }),
    ),
  ];
}

function startDistrictAndAlertSources(
  prisma: PrismaService,
  ports: ProfileV1Ports,
  context: ProfileV1Context,
  trackedBillsPromise: ReturnType<ProfileV1Ports['getTrackedBills']>,
  mappingRowsPromise: Promise<
    Array<{ source: string; confirmed: boolean; externalId: string | null }>
  >,
): Array<Promise<unknown>> {
  const { client, clientId, tenantId, userId, now, day21, day7, day30 } = context;
  return [
    mappingRowsPromise,
    // Real USAspending spend-by-district (the data-driven path). Appended at the
    // end of the array so the existing positional settle() indices are unchanged.
    // Drives the Financial Footprint district panel's job/spend bars; the
    // free-text getDistrictNexus (index 3) remains as a fallback / capability list.
    ports.getDistrictNexusSpend(clientId, tenantId),
    // ── New alert-source feeders (compute-on-read), appended at the END so the
    // existing positional settle() indices (0–18) are unchanged. Each is wrapped
    // so a failure degrades only its own alert type, never the aggregate. ──
    // [19] Overdue comment deadlines: FedReg docs whose comment window JUST
    // closed (last 7d) and that match this client — "did we file?" nudge.
    ports.getOverdueCommentAlerts(clientId, tenantId, now, day7),
    // [20] New competitor LDA activity on the client's issue codes (last 30d).
    ports.getCompetitorLdaAlerts(clientId, tenantId, day30),
    // [21] New federal contract awards relevant to the client (last 30d).
    ports.getContractAwardAlerts(clientId, tenantId, day30),
    // [22] Per-user worklist state (ack/dismiss/snooze) for this client's alerts.
    userId
      ? prisma.withTenant(tenantId, (tx) =>
          tx.alertState.findMany({
            where: { userId, clientId },
            select: { alertId: true, state: true, snoozedUntil: true },
          }),
        )
      : Promise.resolve([] as Array<{ alertId: string; state: string; snoozedUntil: Date | null }>),
    // [23] Upcoming hearings & markups matched to this client (next 21d). The
    // legacy Hearings panel was removed from the UI; this surfaces the same
    // signal as time-sensitive alert rows on the Top alerts card.
    ports.getHearingAlerts(clientId, tenantId, now, day21, trackedBillsPromise),
    // [24] Regulatory matters relevant to this client with NO dependency on
    // bill tracking (see getBillRegulationLinks, index 5, and
    // getClientRelevantRegulations below) — a client that tracks no bills
    // otherwise gets a permanently empty Regulatory panel.
    ports.getClientRelevantRegulations(clientId, tenantId, now),
  ];
}

export function settleProfileV1Sources(
  ports: ProfileV1Ports,
  context: ProfileV1Context,
  settled: PromiseSettledResult<unknown>[],
  settledSourceLabels: readonly string[],
) {
  const { client, clientId } = context;
  const settle = <T>(index: number, fallback: T): T => {
    const result = settled[index];
    if (result && result.status === 'fulfilled') return result.value as T;
    const reason = result && result.status === 'rejected' ? result.reason : 'unknown';
    ports.warn(
      `profile-v1 source "${settledSourceLabels[index]}" failed for client ${clientId}: ${
        reason instanceof Error ? reason.message : String(reason)
      }`,
    );
    return fallback;
  };
  const spine = settled[0];
  if (!spine || spine.status === 'rejected') {
    throw spine ? spine.reason : new Error('profile-v1 spine source did not run');
  }
  const profile = spine.value as Awaited<ReturnType<ProfileV1Ports['getClientProfile']>>;
  const finance = settleFinancialSources(context, settle);
  const panels = settlePanelSources(settle);
  const activity = settleActivitySources(settle);
  const alerts = settleDistrictAndAlertSources(settle);
  return { profile, ...finance, ...panels, ...activity, ...alerts };
}
export type SettledProfileV1Sources = ReturnType<typeof settleProfileV1Sources>;

function settleFinancialSources(context: ProfileV1Context, settle: ProfileV1Settler) {
  const { client, clientId } = context;
  const roi = settle(1, {
    clientId,
    clientName: client.name,
    mappedLdaClientId: null,
    mappedLdaClientIds: [],
    mappedContractorId: null,
    lobbySpend: 0,
    contractWins: 0,
    roi: null,
    gap: 0,
  } as Awaited<ReturnType<ProfileV1Ports['getLobbyingRoi']>>);
  const fec = settle(2, {
    clientId,
    clientName: client.name,
    mappedEmployer: null,
    contributionType: 'individual_employer_linked' as const,
    summary: {
      totalContributions: 0,
      totalAmount: 0,
      committeeCount: 0,
      candidateCount: 0,
      memberCount: 0,
      billCount: 0,
    },
    committees: [],
    pacGiving: {
      tracked: false,
      committees: [],
      summary: { totalAmount: 0, disbursementCount: 0, recipientCount: 0 },
    },
    disclaimer: FEC_DISCLAIMER,
  } as unknown as Awaited<ReturnType<ProfileV1Ports['getFecMoneyFlow']>>);
  const district = settle(3, { capabilities: [] } as unknown as Awaited<
    ReturnType<ProfileV1Ports['getDistrictNexus']>
  >);
  return { roi, fec, district };
}

function settlePanelSources(settle: ProfileV1Settler) {
  const trackedBills = settle(4, { total: 0, issueCodes: [], bills: [] } as Awaited<
    ReturnType<ProfileV1Ports['getTrackedBills']>
  >);
  const regLinks = settle(5, {
    links: [],
    totalBills: 0,
    totalRegulations: 0,
  } as Awaited<ReturnType<ProfileV1Ports['getBillRegulationLinks']>>);
  const graph = settle(6, {
    nodes: [],
    edges: [],
    resolutionQuality: { avgConfidence: 0, confirmedCount: 0, unconfirmedCount: 0 },
  } as unknown as Awaited<ReturnType<ProfileV1Ports['getKnowledgeGraph']>>);
  const health = settle(
    7,
    null as unknown as Awaited<ReturnType<ProfileV1Ports['computeEngagementHealth']>>,
  );
  const exStaffers = settle(8, { lobbyists: [] } as unknown as Awaited<
    ReturnType<ProfileV1Ports['getExStaffers']>
  >);
  const commentAlerts = settle(9, { alerts: [] } as Awaited<
    ReturnType<ProfileV1Ports['getCommentPeriodAlerts']>
  >);
  return { trackedBills, regLinks, graph, health, exStaffers, commentAlerts };
}

function settleActivitySources(settle: ProfileV1Settler) {
  const changes = settle(10, [] as Awaited<ReturnType<ProfileV1Ports['getChanges']>>);
  const hearings = settle(
    11,
    [] as Awaited<ReturnType<PrismaService['committeeHearing']['findMany']>>,
  );
  const meetings = settle(12, [] as Array<{ startsAt: Date }>);
  const threads = settle(13, [] as Array<{ lastMessageAt: Date | null }>);
  const doneTasks = settle(14, [] as Array<{ updatedAt: Date }>);
  const debriefs = settle(15, [] as Array<{ createdAt: Date }>);
  const outreachRows = settle(16, [] as Array<{ sentAt: Date }>);
  const mappingRows = settle(
    17,
    [] as Array<{ source: string; confirmed: boolean; externalId: string | null }>,
  );
  return { changes, hearings, meetings, threads, doneTasks, debriefs, outreachRows, mappingRows };
}

function settleDistrictAndAlertSources(settle: ProfileV1Settler) {
  const districtSpend = settle(18, {
    linked: false as const,
    reason: 'no_confirmed_contracting_mapping',
    contractorNames: [] as string[],
    totalAwards: 0,
    totalAmount: 0,
    districts: [] as Array<{
      district: string;
      state: string;
      districtNumber: string;
      awardCount: number;
      totalAmount: number;
      demographics: unknown;
    }>,
    unmappedAmount: 0,
  } as unknown as Awaited<ReturnType<ProfileV1Ports['getDistrictNexusSpend']>>);
  const overdueCommentAlerts = settle(
    19,
    [] as Awaited<ReturnType<ProfileV1Ports['getOverdueCommentAlerts']>>,
  );
  const competitorLdaAlerts = settle(
    20,
    [] as Awaited<ReturnType<ProfileV1Ports['getCompetitorLdaAlerts']>>,
  );
  const contractAwardAlerts = settle(
    21,
    [] as Awaited<ReturnType<ProfileV1Ports['getContractAwardAlerts']>>,
  );
  const alertStateRows = settle(
    22,
    [] as Array<{ alertId: string; state: string; snoozedUntil: Date | null }>,
  );
  const hearingAlerts = settle(23, [] as Awaited<ReturnType<ProfileV1Ports['getHearingAlerts']>>);
  const clientRelevantRegs = settle(
    24,
    [] as Awaited<ReturnType<ProfileV1Ports['getClientRelevantRegulations']>>,
  );
  return {
    districtSpend,
    overdueCommentAlerts,
    competitorLdaAlerts,
    contractAwardAlerts,
    alertStateRows,
    hearingAlerts,
    clientRelevantRegs,
  };
}
