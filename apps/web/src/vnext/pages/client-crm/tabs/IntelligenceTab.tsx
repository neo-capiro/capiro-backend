import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Card,
  CardHead,
  FitChip,
  Pill,
  SegmentedTabs,
  TabPageHead,
  Tile,
  Avatar,
  GRADIENT_DARK,
  type PillTone,
} from '../portfolio-primitives.js';
import {
  DOMAIN_STATS,
  BILLS,
  STAGES,
  MATTERS,
  DEADLINES,
  OPPS,
  PROGRAMS,
  LDA,
  DISTRICTS,
  FACILITIES,
  SPARK,
} from '../portfolio-fixtures.js';
import { lazy, Suspense } from 'react';
import { formatDateShort, formatMoney, formatNumber, ldaPeriodLabel, partyLabel, titleCaseName } from '../../../lib/labels.js';
import {
  bandOf,
  type ScoreBand,
} from '../../../../pages/intelligence/district-nexus/district-nexus-format.js';
import {
  getClientDistrictNexusV2,
  type ClientDistrictNexusV2,
  type DistrictNexusDistrictDetail,
} from '../../../../pages/clients/intelligence-v1/district-nexus-api.js';
import { DistrictNexusMap } from '../DistrictNexusMap.js';
import { PastPerformanceCard } from '../PastPerformanceCard.js';
import { ManageFacilitiesModal } from '../ManageFacilitiesModal.js';
import { AddBillModal } from './LegislativeAddBill.js';
import { BillUpdatesDrawer } from './BillUpdatesDrawer.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';
import type { IntelligenceView } from '../client-crm-routing.js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import {
  trackerKeys,
  trackerPaths,
  type BoardBill,
  type BoardResponse,
} from '../../../../pages/clients/tracker/tracker-api.js';
import { adaptBoard, intelTrackerPaths } from '../../../../pages/clients/tracker/intel-tracker-api.js';
import {
  getClientFacilities,
  formatFacilityDistrict,
  type ClientFacility,
} from '../../../../pages/clients/facilities-api.js';
import {
  getClientDistrictNexus,
  type DistrictNexusRow,
} from '../../../../pages/clients/intelligence-v1/district-nexus-api.js';
import { getClientLdaFilings } from '../../../../pages/clients/intelligence-v1/lda-filings-api.js';
import {
  getClientFecMoneyFlow,
  topPacRecipients,
} from '../../../../pages/clients/intelligence-v1/fec-money-flow-api.js';
import {
  getClientRepresentation,
  type RepresentationResult,
} from '../../../../pages/clients/intelligence-v1/representation-api.js';
import type { ClientProfileV1 } from '../../../../pages/clients/intelligence-v1/mappers.js';
import { useIntelFeature } from '../../../../lib/intel-feature-flags.js';
import {
  getRelevantPesForClient,
  formatScorePct,
  type RelevantPeRow,
} from '../../../../pages/clients/relevance-api.js';
import {
  FUNDING_OPPORTUNITIES_FEATURE,
  KIND_LABELS,
  SOURCE_LABELS,
  formatDeadline,
  moneyLine,
  type ClientFundingOpportunitySummary,
  type FundingOpportunity,
  type OpportunityWorkflowStatus,
} from '../../../../pages/intelligence/opportunities/funding-opportunities-api.js';

/**
 * Intelligence tab (spec §10). Five domains via a segmented bar: Legislative ·
 * Regulatory · Funding & Budget · Federal Footprint · District Nexus. Every
 * domain opens with the 5-cell domain stats strip.
 *
 * Overview is gone: its pulse band and domain list restated the same figures
 * each domain panel already reads from the same query keys, so a client's
 * numbers were rendered twice and Intelligence now opens on Legislative.
 * Past performance moved in from Capabilities §7.3 and sits under Federal
 * Footprint, with the rest of the client's federal delivery record.
 *
 * The precise records are designed fixtures (§14); where a real client-scoped
 * aggregate exists it would override, but the domain bodies render the design's
 * contract. Fixture-backed sections are flagged UI-only in the ship report.
 */

const INTEL_TONE: Record<string, PillTone> = {
  gray: 'gray', brand: 'brand', blue: 'blue', error: 'error', warning: 'warning', success: 'success',
};

/** MapLibre choropleth, lazy so the WebGL engine stays out of this chunk (see
 * bundle-boundaries.test.ts) for users who never open the District subtab.
 * Shared with the native District Nexus page since the Phase 2 port — its
 * default props reproduce this tab's original behavior exactly. */
const DistrictNexusMapLibreLazy = lazy(() => import('../../../components/district-map/DistrictNexusMapLibre.js'));


/**
 * District Nexus v2 — the scored, district-keyed model the canonical
 * District Nexus module renders. Deliberately NOT the legacy widget's
 * `['client-district-nexus-v2']` key: this query resolves a 404 to `null`
 * (fall back to v1) while that one throws, and two contracts must not share
 * one cache entry. `null` data = the endpoint is dark for this tenant.
 */
function useDistrictNexusV2(client: Client, active: boolean) {
  const api = useApi();
  const { enabled, ready } = useIntelFeature('district_nexus_v2');
  return useQuery<ClientDistrictNexusV2 | null>({
    queryKey: ['pf-district-nexus-v2', client.id],
    queryFn: async () => {
      try {
        return await getClientDistrictNexusV2(api, client.id);
      } catch (error) {
        const status = (error as { response?: { status?: number } } | null)?.response?.status;
        if (status === 404) return null; // configuration answer, not an outage
        throw error;
      }
    },
    enabled: active && ready && enabled && Boolean(client.id),
    staleTime: 2 * 60_000,
    retry: false,
  });
}

export function ClientCrmIntelligenceProto({ client, view }: { client: Client; view: IntelligenceView }) {
  const navigate = useNavigate();
  const api = useApi();
  const qc = useQueryClient();
  const domain = DOMAIN_META[view] ?? DOMAIN_META.legislative!;
  const [facilitiesOpen, setFacilitiesOpen] = useState(false);
  // Lifted here so the Legislative domain header's "Track bill" button and the
  // LegislativePanel below (which owns the track mutation + AddBill modal) drive
  // the same modal — the button lives in the header, the write in the panel.
  const [addBillOpen, setAddBillOpen] = useState(false);
  // Actions that need the client are computed here rather than in the static
  // map below: District's "Manage facilities" (item 3, wire-audit "2 Wire
  // existing APIs"), Legislative's "Configure" (item 4, "3 Compose extend"),
  // and Funding's "Sync sources" (same defect class as Configure: a static
  // <SecondaryBtn> in DOMAIN_META with no onClick at all did nothing on
  // click). There is no dedicated funding-sync API — this invalidates the
  // SAME query keys FundingPanel's own opportunities/PE-relevance queries
  // use, so a click forces a real re-read rather than a fabricated delay.
  const actions =
    view === 'district' ? (
      // This used to `navigate('?tab=facilities')`, which client-crm-routing maps
      // straight back to intelligence/district — the very view this button sits
      // on. It therefore did nothing. The editor is now in-place, on the real
      // /api/clients/:id/facilities CRUD.
      <SecondaryBtn onClick={() => setFacilitiesOpen(true)}>Manage facilities</SecondaryBtn>
    ) : view === 'legislative' ? (
      <>
        {/* The real source/alert configuration for a client's legislative
            intelligence is the tracker's Configure panel — watchlist topics and
            terms, per-trigger alert toggles, channels. It lives on the canonical
            Radar page at ?tab=watchlist, scoped by ?client= — NOT at
            /legiwatch?tab=watchlist: vNext's LegiWatch module treats `watchlist`
            as a removed tab (see REMOVED_TABS in legiwatch/lib/types.ts) and
            silently redirects it to Hearings, so this button did nothing until
            it was pointed at /radar instead. There is no second config store
            for this domain to open instead. */}
        <SecondaryBtn onClick={() => navigate(`/radar?tab=watchlist&client=${encodeURIComponent(client.id)}`)}>
          Configure
        </SecondaryBtn>
        {/* Header "Track bill" opens the bill-search modal — the same
            capability app.capiro.ai has (legacy AddBillModal). The track write
            itself is owned by LegislativePanel's trackMutation; this button just
            opens the shared modal via the lifted `addBillOpen` state. */}
        <PrimaryBtn onClick={() => setAddBillOpen(true)}>Track bill</PrimaryBtn>
      </>
    ) : view === 'funding' ? (
      <SecondaryBtn
        onClick={() => {
          void qc.invalidateQueries({ queryKey: ['client-funding-opportunities', client.id] });
          void qc.invalidateQueries({ queryKey: ['client-pe-relevance', client.id] });
        }}
      >
        Sync sources
      </SecondaryBtn>
    ) : (
      domain.actions
    );

  // Compute real domain-stats-strip values from the queries each panel
  // already runs. react-query dedupes by key — these are the exact same
  // queries the panels below issue, so no extra network requests.
  const realStats = useDomainStats(client, view, api);

  return (
    <div className="cap-pf-anim-rise" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <TabPageHead title={domain.title} sub={domain.sub} actions={actions} />
      <DomainStatsStrip view={view} realValues={realStats} />
      {view === 'legislative' ? (
        <LegislativePanel
          client={client}
          addBillOpen={addBillOpen}
          onAddBillOpenChange={setAddBillOpen}
        />
      ) : null}
      {view === 'regulatory' ? <RegulatoryPanel client={client} /> : null}
      {view === 'funding' ? <FundingPanel client={client} /> : null}
      {view === 'footprint' ? <FootprintPanel client={client} /> : null}
      {view === 'district' ? <DistrictPanel client={client} /> : null}

      <ManageFacilitiesModal
        open={facilitiesOpen}
        clientId={client.id}
        clientName={client.name}
        onClose={() => setFacilitiesOpen(false)}
      />
    </div>
  );
}

/**
 * Resolve real domain-stats-strip cells from live queries, falling back to
 * null (which makes DomainStatsStrip render the fixture) when a query is not
 * ready or not applicable. Each case reuses the same query key the panel
 * below uses so cache is shared — zero extra network calls.
 */
function useDomainStats(client: Client, view: IntelligenceView, api: ReturnType<typeof useApi>): Array<[string, string]> | undefined {
  const { enabled: trackerV2, ready: trackerReady } = useIntelFeature('tracker_v2');
  const boardQ = useQuery<BoardResponse>({
    queryKey: trackerKeys.board(client.id),
    queryFn: async () => {
      if (trackerV2) {
        const raw = (await api.get<Parameters<typeof adaptBoard>[0]>(intelTrackerPaths.board(client.id))).data;
        return adaptBoard(raw);
      }
      return (await api.get<BoardResponse>(trackerPaths.board(client.id))).data;
    },
    enabled: trackerReady && view === 'legislative',
    staleTime: 60_000,
  });
  const aggQ = useQuery<ClientProfileV1>({
    queryKey: ['client-intel-v1-aggregate', client.id],
    queryFn: async () =>
      (await api.get<ClientProfileV1>(`/api/intelligence/clients/${client.id}/profile-v1`)).data,
    enabled: view === 'regulatory',
    staleTime: 2 * 60_000,
    retry: 1,
  });

  const { enabled: foEnabled, ready: foReady } = useIntelFeature(FUNDING_OPPORTUNITIES_FEATURE);
  const oppsQ = useQuery<ClientFundingOpportunitySummary>({
    queryKey: ['client-funding-opportunities', client.id],
    queryFn: async () =>
      (await api.get<ClientFundingOpportunitySummary>(
        `/api/intelligence/clients/${client.id}/opportunities/summary`,
      )).data,
    enabled: Boolean(client.id) && foReady && foEnabled && view === 'funding',
    staleTime: 2 * 60_000,
    retry: 1,
  });
  const pesQ = useQuery({
    queryKey: ['client-pe-relevance', client.id, { minScore: 0.5 }],
    queryFn: () => getRelevantPesForClient(api, client.id, { minScore: 0.5, limit: 12 }),
    enabled: view === 'funding',
    staleTime: 60_000,
  });

  const ldaQ = useQuery({
    queryKey: ['client-lda-filings', client.id],
    queryFn: () => getClientLdaFilings(api, client.id),
    enabled: view === 'footprint',
    staleTime: 2 * 60_000,
  });
  const nexusQ = useQuery({
    queryKey: ['client-district-nexus', client.id],
    queryFn: () => getClientDistrictNexus(api, client.id),
    enabled: view === 'footprint' || view === 'district',
    staleTime: 2 * 60_000,
  });
  const fecQ = useQuery({
    queryKey: ['client-fec-money-flow', client.id],
    queryFn: () => getClientFecMoneyFlow(api, client.id),
    enabled: view === 'footprint',
    staleTime: 5 * 60_000,
  });
  const facilitiesQ = useQuery({
    queryKey: ['client-facilities', client.id],
    queryFn: () => getClientFacilities(api, client.id),
    enabled: view === 'district',
    staleTime: 60_000,
  });
  const nexusV2Q = useDistrictNexusV2(client, view === 'district');

  if (view === 'legislative' && trackerReady && boardQ.isSuccess) {
    const board = boardQ.data;
    return [
      [String(board.total), 'Tracked bills'],
      ['—', 'Material changes'],
      ['—', 'Upcoming hearings'],
      ['—', 'Watchlist coverage'],
    ];
  }

  if (view === 'regulatory' && aggQ.isSuccess) {
    const rails = aggQ.data.sections.legislativeRegulatory.regulatoryLifecycle?.rails ?? [];
    const now = Date.now();
    const soon = rails.filter((r) => {
      if (!r.deadline) return false;
      const on = deadlineDay(r.deadline);
      if (!on) return false;
      return Math.ceil((on.getTime() - now) / 86_400_000) <= 14;
    }).length;
    return [
      [String(rails.length), 'Active matters'],
      [String(soon), 'Deadline < 14 days'],
      ['—', 'Linked bills'],
      ['—', 'Agencies'],
      ['—', 'Days to next deadline'],
    ];
  }

  if (view === 'funding' && foReady && foEnabled && oppsQ.isSuccess && pesQ.isSuccess) {
    const c = oppsQ.data.counts;
    const pursuing = oppsQ.data.topGrants.filter((o) => o.workflow?.status === 'pursuing').length
      + oppsQ.data.topContracts.filter((o) => o.workflow?.status === 'pursuing').length;
    return [
      [String(c.activeGrants + c.activeContracts), 'Active opportunities'],
      [String(pursuing), 'Pursuing'],
      ['—', 'Largest ceiling'],
      [String(pesQ.data.data.length), 'Relevant programs'],
      ['—', 'Next deadline'],
    ];
  }

  if (view === 'footprint' && ldaQ.isSuccess && nexusQ.isSuccess && fecQ.isSuccess) {
    const lda = ldaQ.data;
    const ldaAmount = lda.matched ? lda.filings.reduce((s, f) => s + f.amount, 0) : null;
    const pac = fecQ.data.pacGiving;
    return [
      [lda.matched ? formatNumber(lda.totalFilings) : '0', 'LDA filings'],
      [formatMoney(ldaAmount), 'Lobbying · TTM'],
      // Unlinked is "no confirmed mapping", never $0 — formatMoney(null) = '—'.
      [formatMoney(nexusQ.data.linked ? nexusQ.data.totalAmount : null), 'Federal awards · TTM'],
      [formatMoney(pac?.tracked && pac.summary ? pac.summary.totalAmount : null), 'PAC disbursements'],
      [lda.matched ? formatNumber(lda.registrants.length) : '0', 'Registrants'],
    ];
  }

  // District — prefer the scored v2 model (real districtKeys, real coverage);
  // fall back to the v1 facility view when v2 is dark for this tenant.
  if (view === 'district' && nexusV2Q.data) {
    const v2 = nexusV2Q.data;
    return [
      [formatNumber(v2.districts.length), 'Districts'],
      [formatMoney(v2.awarded.contractObligations), 'Contract obligations'],
      [formatMoney(v2.awarded.grantObligations), 'Grant obligations'],
      // employeeCount null = no facility reported a headcount. NEVER render 0.
      [v2.facilityFootprint.employeeCount != null ? formatNumber(v2.facilityFootprint.employeeCount) : '—', 'Employees mapped'],
      [`${Math.round(v2.coveragePercent)}%`, 'Coverage'],
    ];
  }
  if (
    view === 'district' &&
    facilitiesQ.isSuccess &&
    nexusQ.isSuccess &&
    (nexusV2Q.data === null || nexusV2Q.isError)
  ) {
    const linkedNexus = nexusQ.data.linked ? nexusQ.data.districts.length : 0;
    const totalAmount = nexusQ.data.linked
      ? nexusQ.data.districts.reduce((s, d) => s + d.totalAmount, 0)
      : null;
    const knownEmployees = facilitiesQ.data.filter((f) => f.employeeCount != null);
    const empCount = knownEmployees.reduce((s, f) => s + (f.employeeCount ?? 0), 0);
    return [
      [String(linkedNexus), 'Districts'],
      [formatMoney(totalAmount), 'Contract obligations'],
      ['—', 'Grant obligations'],
      [knownEmployees.length ? formatNumber(empCount) : '—', 'Employees mapped'],
      ['—', 'Coverage'],
    ];
  }

  return undefined; // still loading — the strip renders dashes, never a fixture
}

const DOMAIN_META: Record<string, { title: string; sub: string; actions?: ReactNode }> = {
  legislative: {
    title: 'Legislative',
    sub: 'Tracked bills, hearings, and material changes from LegiWatch.',
    // actions computed in ClientCrmIntelligenceProto — see the comment there.
  },
  regulatory: {
    title: 'Regulatory',
    sub: 'Federal Register matters shown as decision-oriented lifecycle rails with client deadlines.',
    actions: <PrimaryBtn>Track matter</PrimaryBtn>,
  },
  funding: {
    title: 'Funding & Budget',
    sub: 'Grant and contract opportunities, active pursuits, and relevant defense budget programs in one domain.',
    actions: <SecondaryBtn>Sync sources</SecondaryBtn>,
  },
  footprint: {
    title: 'Federal footprint',
    sub: 'Lobbying activity, federal awards, political giving, past performance, and the government entities connected to the client.',
    actions: <SecondaryBtn>Export profile</SecondaryBtn>,
  },
  district: {
    title: 'District Nexus',
    sub: 'Facilities, employees, contracts, grants, and representatives translated into a defensible congressional footprint.',
    // actions computed in ClientCrmIntelligenceProto — see the comment there.
  },
};

/* ── shared buttons ───────────────────────────────────────────────────────── */

function SecondaryBtn({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button type="button" onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, height: 40, padding: '0 16px', borderRadius: 8, background: hover ? '#FAF9F6' : '#ffffff', color: hover ? '#101828' : '#344054', fontSize: 14, fontWeight: 600, lineHeight: '20px', whiteSpace: 'nowrap', border: '1px solid #E0DCD4', boxShadow: '0px 1px 2px rgba(16,24,40,.05)' }}>
      {children}
    </button>
  );
}
function PrimaryBtn({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button type="button" onClick={onClick} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, height: 40, padding: '0 16px', borderRadius: 8, background: hover ? 'linear-gradient(180deg,#4A5462 0%,#252F3C 46%,#161D26 100%)' : GRADIENT_DARK, color: '#ffffff', fontSize: 14, fontWeight: 600, lineHeight: '20px', whiteSpace: 'nowrap', boxShadow: '0px 1px 2px rgba(16,24,40,.05)' }}>
      {children}
    </button>
  );
}
function LinkBtn({
  children,
  onClick,
  disabled,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button type="button" onClick={onClick} disabled={disabled} {...(title ? { title } : {})}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ fontSize: 14, fontWeight: 600, color: disabled ? '#98A2B3' : hover ? '#0E141C' : '#101828', whiteSpace: 'nowrap', cursor: disabled ? 'not-allowed' : 'pointer' }}>
      {children}
    </button>
  );
}

/* ── Domain stats strip (§10 — all domains except Overview) ──────────────── */

/**
 * The strip renders five summary cells per domain. Until the real queries
 * answer, the value slots hold muted dashes under the domain's real labels —
 * the design fixture's invented figures ("8 districts · 92% coverage") never
 * stand in for a client's numbers.
 */
function DomainStatsStrip({ view, realValues }: { view: IntelligenceView; realValues?: Array<[string, string]> }) {
  const labelSource = (DOMAIN_STATS as unknown as Record<string, Array<[string, string]>>)[view] ?? [];
  const cells: Array<[string, string]> =
    realValues && realValues.length > 0 ? realValues : labelSource.map(([, label]) => ['—', label]);
  const loading = !realValues || realValues.length === 0;
  return (
    <section
      style={{ background: '#ffffff', borderRadius: 12, boxShadow: '0 0 0 1px #E8E5DF,0px 1px 3px rgba(16,24,40,.1),0px 1px 2px rgba(16,24,40,.06)', display: 'flex', flexWrap: 'wrap', overflow: 'hidden' }}
      data-source={loading ? 'loading' : 'live'}
      aria-busy={loading}
    >
      {cells.map(([value, label], i) => (
        <span key={label} style={{ flex: 1, minWidth: 168, padding: '20px 24px', boxShadow: i === 0 ? 'none' : 'inset 1px 0 0 #E8E5DF', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em', color: loading ? '#98A2B3' : '#101828', lineHeight: 1.2 }}>{value}</span>
          <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085', textWrap: 'pretty' }}>{label}</span>
        </span>
      ))}
    </section>
  );
}

/* ═══════════════════════════ §10.2 Legislative ═════════════════════════════ */

function LegislativePanel({
  client,
  addBillOpen,
  onAddBillOpenChange,
}: {
  client: Client;
  addBillOpen: boolean;
  onAddBillOpenChange: (open: boolean) => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [boardView, setBoardView] = useState(true);
  // The tracked bill the "latest updates" drawer is showing, or null.
  const [openBill, setOpenBill] = useState<BoardBill | null>(null);

  // Same tracker_v2 feature-detection dance as the currently-live TrackerTab.tsx
  // (the source this mirrors).
  const { enabled: trackerV2, ready } = useIntelFeature('tracker_v2');

  // The tracked-bill board. The server already groups by stage and its
  // four stage ids match the design's own STAGES exactly, so columns are used
  // as returned rather than re-derived client-side.
  const boardQ = useQuery<BoardResponse>({
    queryKey: trackerKeys.board(client.id),
    queryFn: async () => {
      if (trackerV2) {
        // `IntelBoard` isn't exported; take its shape from the adapter itself.
        const raw = (
          await api.get<Parameters<typeof adaptBoard>[0]>(intelTrackerPaths.board(client.id))
        ).data;
        return adaptBoard(raw);
      }
      return (await api.get<BoardResponse>(trackerPaths.board(client.id))).data;
    },
    enabled: ready,
    staleTime: 60_000,
  });
  const realBoard = ready && boardQ.isSuccess ? boardQ.data : null;

  // Bill ids already on the board — the AddBill modal shows these as "On board".
  const boardBillIds = useMemo(
    () => new Set((realBoard?.columns ?? []).flatMap((c) => c.bills.map((b) => b.billId))),
    [realBoard],
  );

  /**
   * Track bill (header "Track bill" → AddBill modal). This is the SAME manual
   * track path the live app.capiro.ai uses (TrackerTab's `trackManual`):
   * `source: 'manual_search'` on the same track endpoint, invalidating the
   * board/summary cache so the new bill appears in its stage column at once.
   * Returns the promise so the modal row only flips to "On board" once the
   * write actually succeeds (legacy P2-06).
   */
  const trackMutation = useMutation({
    mutationFn: (billId: string) =>
      api.post(trackerV2 ? intelTrackerPaths.track(client.id) : trackerPaths.track(client.id), {
        billId,
        source: 'manual_search',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: trackerKeys.summary(client.id) });
      qc.invalidateQueries({ queryKey: trackerKeys.board(client.id) });
    },
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Recommendations was removed (user request): the Legislative surface is
          now a single full-width tracked-bill board. */}
      <Card>
        <CardHead
          title="Tracked bills"
          action={
            <LinkBtn onClick={() => setBoardView((v) => !v)}>
              {boardView ? 'Table view' : 'Board view'}
            </LinkBtn>
          }
        />
        {realBoard ? (
          realBoard.total === 0 ? (
            <p style={{ margin: 0, padding: '4px 24px 16px', fontSize: 14, color: '#475467' }}>
              No bills are on this client&apos;s board yet. Use{' '}
              <button
                type="button"
                onClick={() => onAddBillOpenChange(true)}
                style={{ fontWeight: 600, color: '#101828', textDecoration: 'underline', cursor: 'pointer' }}
              >
                Track bill
              </button>{' '}
              to add one.
            </p>
          ) : boardView ? (
            <RealBillBoard board={realBoard} onOpenBill={setOpenBill} />
          ) : (
            <RealBillTable board={realBoard} onOpenBill={setOpenBill} />
          )
        ) : boardView ? (
          <BillBoard />
        ) : (
          <BillTable />
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 24px 18px' }}>
          <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>
            {/* `withheld` must be stated when > 0 — a bounded board that stays
                silent about it is less honest than an unbounded one. */}
            {realBoard
              ? realBoard.withheld
                ? `${realBoard.withheld} more tracked bill${realBoard.withheld === 1 ? '' : 's'} not shown`
                : `${realBoard.total} tracked bill${realBoard.total === 1 ? '' : 's'}`
              : '6 more tracked bills'}
          </span>
          <span style={{ flex: 1 }} />
          <LinkBtn onClick={() => navigate('/legiwatch')}>Open full board →</LinkBtn>
        </div>
        {/* Upcoming hearing footer relocated here from the removed
            Recommendations card so the surface keeps the hearing cue. */}
        <div style={{ padding: '14px 24px 20px', borderTop: '1px solid #E8E5DF' }}>
          <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>
            Upcoming hearing
          </div>
          <div style={{ marginTop: 4, fontSize: 14, color: '#101828' }}>HASC · Autonomous Systems · Aug 13</div>
        </div>
      </Card>

      <AddBillModal
        open={addBillOpen}
        clientId={client.id}
        boardBillIds={boardBillIds}
        onTrack={(billId) => trackMutation.mutateAsync(billId)}
        onClose={() => onAddBillOpenChange(false)}
      />
      <BillUpdatesDrawer
        open={Boolean(openBill)}
        clientId={client.id}
        bill={openBill}
        onClose={() => setOpenBill(null)}
      />
    </div>
  );
}

/**
 * `BoardBill.probability` is PASSAGE probability (0..1, occasionally already
 * 0-100 — `probClass` in tracker-api.ts tolerates both, so this does too).
 * It is NOT the fixture's client-"fit" score, so it is never rendered in the
 * bare `FitChip` the fixture uses — the label always says what the number is.
 */
function passagePct(probability: number): number {
  return Math.round(probability > 1 ? probability : probability * 100);
}

const CHANGE_TONE: Record<string, PillTone> = {
  critical: 'error',
  notable: 'warning',
  info: 'blue',
  success: 'success',
};

function RealBillBoard({ board, onOpenBill }: { board: BoardResponse; onOpenBill: (b: BoardBill) => void }) {
  return (
    <div style={{ padding: '20px 20px 12px', overflowX: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(188px,1fr))', gap: 14, minWidth: 800, alignItems: 'start' }}>
        {board.columns.map((col) => (
          <span key={col.id} style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 8, borderBottom: '1px solid #E8E5DF' }}>
              <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>{col.label}</span>
              <span style={{ flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 22, height: 22, padding: '0 7px', borderRadius: 9999, background: GRADIENT_DARK, color: '#ffffff', fontSize: 11, fontWeight: 600 }}>{col.count}</span>
            </span>
            {col.bills.map((b) => (
              <RealBillCard key={b.billId} b={b} onOpen={() => onOpenBill(b)} />
            ))}
          </span>
        ))}
      </div>
    </div>
  );
}

function RealBillCard({ b, onOpen }: { b: BoardBill; onOpen: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`View latest updates for ${b.displayNum}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 6, padding: 12, borderRadius: 8, background: hover ? '#FAF9F6' : '#ffffff', border: hover ? '1px solid #E0DCD4' : '1px solid #E8E5DF', textAlign: 'left', cursor: 'pointer' }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {b.unread ? <span aria-label="Unread" style={{ flex: '0 0 auto', width: 6, height: 6, borderRadius: '50%', background: '#101828' }} /> : null}
        <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, color: '#101828', whiteSpace: 'nowrap' }}>{b.displayNum}</span>
        <Pill tone="gray" dotless>{passagePct(b.probability)}% pass</Pill>
      </span>
      <span style={{ fontSize: 13, lineHeight: '18px', color: '#344054', textWrap: 'pretty' }}>{b.title}</span>
      {/* The real status label, when the board carries one — the coarse stage
          lane the card sits in is already shown by its column header. */}
      {b.canonicalStatus ? (
        <span style={{ fontSize: 12, color: '#667085', textWrap: 'pretty' }}>{b.canonicalStatus}</span>
      ) : null}
      {b.latestActionText ? (
        <span style={{ fontSize: 12, color: '#667085', textWrap: 'pretty' }}>{b.latestActionText}</span>
      ) : null}
      {b.change ? (
        <span style={{ alignSelf: 'flex-start' }}>
          <Pill tone={CHANGE_TONE[b.change.tone] ?? 'gray'} dotless={!b.change.dot}>{b.change.label}</Pill>
        </span>
      ) : null}
      {b.terminalRisk ? (
        <span style={{ alignSelf: 'flex-start' }}>
          <Pill tone="error">Terminal risk</Pill>
        </span>
      ) : null}
    </button>
  );
}

function RealBillTable({ board, onOpenBill }: { board: BoardResponse; onOpenBill: (b: BoardBill) => void }) {
  const rows = board.columns.flatMap((col) => col.bills.map((b) => ({ bill: b, stageLabel: col.label })));
  return (
    <div>
      {rows.map(({ bill: r, stageLabel }) => (
        <button
          key={r.billId}
          type="button"
          onClick={() => onOpenBill(r)}
          aria-label={`View latest updates for ${r.displayNum}`}
          style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 16, padding: '14px 24px', borderBottom: '1px solid #E8E5DF', textAlign: 'left', background: 'transparent', cursor: 'pointer' }}
        >
          <span style={{ flex: '0 0 auto', width: 88, fontSize: 14, fontWeight: 600, color: '#101828' }}>{r.displayNum}</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 14, color: '#101828', textWrap: 'pretty' }}>{r.title}</span>
            <span style={{ display: 'block', marginTop: 2, fontSize: 13, color: '#667085' }}>
              {r.latestActionText ?? r.canonicalStatus ?? 'No action recorded'}
            </span>
          </span>
          <span style={{ flex: '0 0 auto', width: 104, fontSize: 13, color: '#475467' }}>{stageLabel}</span>
          <span style={{ flex: '0 0 auto', width: 76, display: 'flex', justifyContent: 'flex-end' }}>
            <Pill tone="gray" dotless>{passagePct(r.probability)}% pass</Pill>
          </span>
        </button>
      ))}
    </div>
  );
}

function BillBoard() {
  return (
    <div style={{ padding: '20px 20px 12px', overflowX: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(188px,1fr))', gap: 14, minWidth: 800, alignItems: 'start' }}>
        {STAGES.map((stage) => {
          const bills = BILLS.filter((b) => b.stage === stage.id);
          return (
            <span key={stage.id} style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 8, borderBottom: '1px solid #E8E5DF' }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>{stage.label}</span>
                <span style={{ flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 22, height: 22, padding: '0 7px', borderRadius: 9999, background: GRADIENT_DARK, color: '#ffffff', fontSize: 11, fontWeight: 600 }}>{stage.count}</span>
              </span>
              {bills.map((b) => (
                <BillCard key={b.number} b={b} />
              ))}
            </span>
          );
        })}
      </div>
    </div>
  );
}

function BillCard({ b }: { b: (typeof BILLS)[number] }) {
  const [hover, setHover] = useState(false);
  return (
    <button type="button" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 6, padding: 12, borderRadius: 8, background: hover ? '#FAF9F6' : '#ffffff', border: hover ? '1px solid #E0DCD4' : '1px solid #E8E5DF', textAlign: 'left' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, color: '#101828', whiteSpace: 'nowrap' }}>{b.number}</span>
        <FitChip score={b.fit} suffix="" />
      </span>
      <span style={{ fontSize: 13, lineHeight: '18px', color: '#344054', textWrap: 'pretty' }}>{b.title}</span>
      <span style={{ fontSize: 12, color: '#667085', textWrap: 'pretty' }}>{b.latest}</span>
    </button>
  );
}

function BillTable() {
  return (
    <div>
      {BILLS.map((r) => (
        <button key={r.number} type="button" style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 16, padding: '14px 24px', borderBottom: '1px solid #E8E5DF', textAlign: 'left' }}>
          <span style={{ flex: '0 0 auto', width: 88, fontSize: 14, fontWeight: 600, color: '#101828' }}>{r.number}</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 14, color: '#101828', textWrap: 'pretty' }}>{r.title}</span>
            <span style={{ display: 'block', marginTop: 2, fontSize: 13, color: '#667085' }}>{r.latest}</span>
          </span>
          <span style={{ flex: '0 0 auto', width: 104, fontSize: 13, color: '#475467', textTransform: 'capitalize' }}>{r.stage}</span>
          <span style={{ flex: '0 0 auto', width: 56, display: 'flex', justifyContent: 'flex-end' }}>
            <FitChip score={r.fit} suffix="" />
          </span>
        </button>
      ))}
    </div>
  );
}

/* ═══════════════════════════ §10.3 Regulatory ══════════════════════════════ */

/**
 * A comment deadline is a calendar DAY, but the API serializes it as an
 * instant (midnight UTC). Reading that back with local getters moves it to the
 * previous day for every viewer west of UTC — the rail would show a deadline a
 * day early and the .ics would put the event on the wrong date. So the UTC
 * calendar day is re-anchored to local midnight once, here, and everything
 * downstream (label, urgency band, DTSTART) reads that one value.
 */
function deadlineDay(value: string | Date): Date | null {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Date(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate());
}

/** A deadline the rail can render — real or from the design fixture. */
interface DeadlineView {
  key: string;
  date: string;
  title: string;
  ask: string;
  urgent: boolean;
  /** Present only on real rows; what the .ics is built from. */
  on?: Date;
  documentNumber?: string;
}

function RegulatoryPanel({ client }: { client: Client }) {
  const api = useApi();

  /**
   * Item 5 (Calendar). The comment deadlines are real: the profile-v1
   * aggregate's regulatory lifecycle rails are Federal Register rulemakings
   * with real `deadline` dates, and it is the same query key + endpoint the
   * canonical `ClientIntelV1Page` uses, so the two share one cache entry.
   * Calendar exports THOSE dates — a .ics built from the design fixture would
   * be a file of invented events sitting in someone's calendar, so the button
   * is disabled whenever the fixture is what is on screen.
   */
  const aggregate = useQuery<ClientProfileV1>({
    queryKey: ['client-intel-v1-aggregate', client.id],
    queryFn: async () =>
      (await api.get<ClientProfileV1>(`/api/intelligence/clients/${client.id}/profile-v1`)).data,
    staleTime: 2 * 60 * 1000,
    retry: 1,
  });

  const lifecycle = aggregate.data?.sections.legislativeRegulatory.regulatoryLifecycle;
  const loaded = aggregate.data !== undefined && !aggregate.isError;

  const realDeadlines: DeadlineView[] = useMemo(() => {
    const rails = lifecycle?.rails ?? [];
    return rails
      .flatMap((rail) => {
        if (!rail.deadline) return [];
        const on = deadlineDay(rail.deadline);
        if (!on) return [];
        const days = Math.ceil((on.getTime() - Date.now()) / 86_400_000);
        return [
          {
            key: rail.documentNumber,
            date: on
              .toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
              .toUpperCase(),
            title: rail.title,
            // Same "≤ 3 days is critical" band the canonical
            // LegislativeRegulatorySection applies to these very rails.
            urgent: days <= 3,
            ask: [rail.agencyNames.join(' · '), rail.currentStage].filter(Boolean).join(' · '),
            on,
            documentNumber: rail.documentNumber,
          },
        ];
      })
      .sort((a, b) => a.on.getTime() - b.on.getTime());
  }, [lifecycle]);

  // Fixture only while the aggregate is loading or errored (§14 convention).
  // Once it resolves, real deadlines — or an honest "none" — are shown.
  const showFixture = !loaded;
  const deadlines: DeadlineView[] = showFixture
    ? DEADLINES.map((d) => ({
        key: d.title,
        date: d.date,
        title: d.title,
        ask: d.ask,
        urgent: Boolean(d.urgent),
      }))
    : realDeadlines;

  return (
    <div className="cap-pf-grid-intel">
      {/* Active matters */}
      <Card>
        <CardHead title="Active matters" action={<LinkBtn>View all</LinkBtn>} />
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {MATTERS.map((m) => (
            <MatterCard key={m.title} m={m} />
          ))}
        </div>
      </Card>

      {/* Deadline rail */}
      <Card>
        <CardHead
          title="Deadline rail"
          action={
            <LinkBtn
              disabled={realDeadlines.length === 0}
              title={
                realDeadlines.length === 0
                  ? 'No dated comment deadlines to export for this client'
                  : undefined
              }
              onClick={() => downloadDeadlineIcs(client.name, realDeadlines)}
            >
              Calendar
            </LinkBtn>
          }
        />
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {deadlines.length === 0 ? (
            <p style={{ margin: 0, padding: '4px 4px 8px', fontSize: 14, color: '#475467' }}>
              No open comment deadlines for this client right now.
            </p>
          ) : null}
          {deadlines.map((d) => (
            <span key={d.key} style={{ display: 'flex', gap: 14, padding: '14px 16px', borderRadius: 10, background: d.urgent ? '#FFFAEB' : '#FAF9F6', border: d.urgent ? '1px solid #FEDF89' : '1px solid #E8E5DF' }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: d.urgent ? '#B54708' : '#667085' }}>{d.date}</span>
                <span style={{ display: 'block', marginTop: 4, fontSize: 14, fontWeight: 600, color: '#101828', textWrap: 'pretty' }}>{d.title}</span>
                <span style={{ display: 'block', marginTop: 3, fontSize: 13, color: '#667085', textWrap: 'pretty' }}>{d.ask}</span>
              </span>
            </span>
          ))}
          <div style={{ marginTop: 4, padding: '14px 4px 6px', borderTop: '1px solid #E8E5DF' }}>
            <div style={{ fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>Source & evidence</div>
            <p style={{ margin: '8px 0 0', fontSize: 14, lineHeight: '20px', color: '#475467', textWrap: 'pretty' }}>
              Federal Register lifecycle data is current. Detailed evidence and provenance open inside each matter.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}

/* ── Calendar export (§10.3 Deadline rail) ────────────────────────────────── */

/** RFC 5545 escaping for TEXT values. Backslash first, or it double-escapes. */
function icsText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** `YYYYMMDD` in local time — a comment deadline is a calendar day, not an instant. */
function icsDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/**
 * Export the real comment deadlines as an all-day .ics. Never called with
 * fixture rows — the button is disabled unless real dated rails exist.
 */
function downloadDeadlineIcs(clientName: string, deadlines: DeadlineView[]) {
  if (deadlines.length === 0) return;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Capiro//Client regulatory deadlines//EN',
    'CALSCALE:GREGORIAN',
    ...deadlines.flatMap((d) => {
      // DTEND is exclusive for all-day events, so it is the day after.
      const end = new Date(d.on!.getTime() + 86_400_000);
      return [
        'BEGIN:VEVENT',
        `UID:capiro-reg-${icsText(d.documentNumber ?? d.key)}@capiro.ai`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${icsDate(d.on!)}`,
        `DTEND;VALUE=DATE:${icsDate(end)}`,
        `SUMMARY:${icsText(`Comment deadline · ${d.title}`)}`,
        `DESCRIPTION:${icsText([clientName, d.ask, d.documentNumber].filter(Boolean).join(' · '))}`,
        'END:VEVENT',
      ];
    }),
    'END:VCALENDAR',
  ];
  const url = URL.createObjectURL(
    new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `${clientName.replace(/[^\w-]+/g, '-').toLowerCase()}-regulatory-deadlines.ics`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const MATTER_STAGE_TONE: Record<string, PillTone> = { warning: 'warning', blue: 'blue', brand: 'brand' };

function MatterCard({ m }: { m: (typeof MATTERS)[number] }) {
  return (
    <div style={{ padding: '16px 18px', borderRadius: 10, border: '1px solid #E8E5DF', background: '#FAF9F6' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 180 }}>
          <span style={{ display: 'block', fontSize: 16, fontWeight: 600, color: '#101828', textWrap: 'pretty' }}>{m.title}</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 4, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, color: '#475467' }}>{m.agency}</span>
            <span style={{ fontSize: 13, color: '#667085' }}>{m.docket}</span>
          </span>
        </span>
        <Pill tone={MATTER_STAGE_TONE[m.ui] ?? 'gray'} size="lg">{m.stage}</Pill>
      </div>
      <MatterRail steps={m.steps as Array<[string, string]>} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 18, paddingTop: 14, borderTop: '1px solid #F2F0EB', flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 180, fontSize: 14, fontWeight: 500, color: '#101828' }}>{m.detail}</span>
        <span style={{ flex: '0 0 auto', fontSize: 12, color: '#667085' }}>Linked {m.linked}</span>
        <LinkBtn>Open matter →</LinkBtn>
      </div>
    </div>
  );
}

/** Four-step regulatory lifecycle rail (§2.14 at 24px nodes). */
function MatterRail({ steps }: { steps: Array<[string, string]> }) {
  return (
    <div style={{ position: 'relative', margin: '22px 8px 0' }}>
      <span style={{ position: 'absolute', top: 11, left: 48, right: 48, height: 2, background: '#E8E5DF' }} />
      <span style={{ position: 'relative', display: 'flex', justifyContent: 'space-between' }}>
        {steps.map(([label, st]) => {
          const done = st === 'done';
          const now = st === 'now';
          return (
            <span key={label} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, width: 96 }}>
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 24,
                  height: 24,
                  borderRadius: '50%',
                  background: done ? GRADIENT_DARK : '#ffffff',
                  boxShadow: now ? 'inset 0 0 0 2px #101828' : 'none',
                  border: now || done ? '1px solid transparent' : '1px solid #E0DCD4',
                  color: done ? '#ffffff' : now ? '#101828' : '#98A2B3',
                  fontSize: 11,
                  fontWeight: 700,
                }}
              >
                {done ? '✓' : now ? '!' : '·'}
              </span>
              <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: done || now ? '#101828' : '#98A2B3', textAlign: 'center' }}>
                {label}
              </span>
            </span>
          );
        })}
      </span>
    </div>
  );
}

/* ══════════════════════════ §10.4 Funding & Budget ═════════════════════════ */

/** Workflow status → pill presentation. Reads the real `OpportunityWorkflow.status`
 * enum directly; `null` means no workflow row exists yet (nothing decided either way). */
function workflowStatusPill(status: OpportunityWorkflowStatus | null): { label: string; tone: PillTone; dotless: boolean } {
  switch (status) {
    case 'pursuing':
      return { label: 'Pursuing', tone: 'brand', dotless: false };
    case 'won':
      return { label: 'Won', tone: 'success', dotless: false };
    case 'saved':
      return { label: 'Saved', tone: 'gray', dotless: true };
    case 'dismissed':
      return { label: 'Dismissed', tone: 'gray', dotless: true };
    case 'lost':
      return { label: 'Lost', tone: 'gray', dotless: true };
    case 'expired':
      return { label: 'Expired', tone: 'gray', dotless: true };
    case 'suggested':
      return { label: 'Suggested', tone: 'gray', dotless: true };
    default:
      return { label: 'Match', tone: 'gray', dotless: true };
  }
}

function FundingPanel({ client }: { client: Client }) {
  const api = useApi();
  const navigate = useNavigate();

  // Item 5: Opportunities list. Same endpoint + feature gate as the established
  // legacy widget (FundingOpportunitiesSection.tsx) — a disabled flag is an
  // unavailable feature, not an empty result, so the design fixture stays up
  // rather than showing a broken-looking blank card.
  const { enabled: foEnabled, ready: foReady } = useIntelFeature(FUNDING_OPPORTUNITIES_FEATURE);
  const opportunitiesQ = useQuery<ClientFundingOpportunitySummary>({
    queryKey: ['client-funding-opportunities', client.id],
    queryFn: async () =>
      (
        await api.get<ClientFundingOpportunitySummary>(
          `/api/intelligence/clients/${client.id}/opportunities/summary`,
        )
      ).data,
    enabled: Boolean(client.id) && foReady && foEnabled,
    staleTime: 2 * 60_000,
    retry: 1,
  });
  const realOpportunities = foReady && foEnabled && opportunitiesQ.isSuccess ? opportunitiesQ.data : null;
  const opportunityRows = realOpportunities
    ? [...realOpportunities.topGrants, ...realOpportunities.topContracts].slice(0, 6)
    : [];

  // Item 4: Open budget / Open PE. Real PE ids + titles from the relevance
  // engine (same threshold the already-built, currently-unrouted
  // ClientCrmIntelligence.tsx FundingView uses: minScore 0.5).
  const pesQ = useQuery({
    queryKey: ['client-pe-relevance', client.id, { minScore: 0.5 }],
    queryFn: () => getRelevantPesForClient(api, client.id, { minScore: 0.5, limit: 12 }),
    staleTime: 60_000,
  });
  const realPes = pesQ.isSuccess ? pesQ.data.data : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* The nested Overview/Opportunities/Programs/Pursuits bar is gone: its
          state was never read — all four options rendered these same two
          cards. Dead chrome that promises filtering is worse than none. */}
      <div className="cap-pf-grid-intel">
        {/* Opportunities */}
        <Card>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '20px 24px 16px' }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 18, fontWeight: 600, color: '#101828' }}>Opportunities</span>
              <span style={{ display: 'block', marginTop: 4, fontSize: 14, color: '#475467', textWrap: 'pretty' }}>
                Matches use capabilities, facilities, eligibility, agencies, and Strategy context.
              </span>
            </span>
            {realOpportunities ? (
              <LinkBtn onClick={() => navigate(`/intelligence/opportunities?clientId=${client.id}`)}>
                View all {realOpportunities.counts.activeGrants + realOpportunities.counts.activeContracts}
              </LinkBtn>
            ) : (
              <LinkBtn>View all 7</LinkBtn>
            )}
          </div>
          <div style={{ padding: '0 16px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {realOpportunities ? (
              opportunityRows.length ? (
                opportunityRows.map((o) => <RealOppRow key={o.id} o={o} />)
              ) : (
                <p style={{ margin: '4px 8px', fontSize: 14, color: '#475467' }}>
                  {realOpportunities.emptyExplanation ??
                    'No opportunity currently clears the relevance threshold for this client.'}
                </p>
              )
            ) : (
              OPPS.map((o) => <OppRow key={o.title} o={o} />)
            )}
          </div>
        </Card>

        {/* Relevant budget programs */}
        <Card>
          <CardHead
            title="Relevant budget programs"
            action={<LinkBtn onClick={() => navigate('/program-elements')}>Open budget</LinkBtn>}
          />
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {realPes ? (
              realPes.length ? (
                realPes.map((pe) => (
                  <RealProgramRow key={pe.peCode} pe={pe} onOpen={() => navigate(`/program-elements/${pe.peCode}`)} />
                ))
              ) : (
                <p style={{ margin: '4px 8px', fontSize: 14, color: '#475467' }}>
                  No program elements scored above the relevance threshold for this client.
                </p>
              )
            ) : (
              PROGRAMS.map((p) => <ProgramCard key={p.code} p={p} />)
            )}
            {/* Pursuits has no wired data source yet (a separate, unbuilt nested
                view) — stays a documented UI-only element regardless of mode,
                same convention as WorkTab's "On track" pill. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 4px 4px', borderTop: '1px solid #E8E5DF', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: '#667085' }}>Pursuit pipeline</span>
              <Pill tone="brand" size="lg">Army AGV · Qualifying</Pill>
              <Pill tone="gray" size="lg" dotless>ONR Autonomy · Saved</Pill>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}

function RealOppRow({ o }: { o: FundingOpportunity }) {
  const [hover, setHover] = useState(false);
  const money = moneyLine(o);
  const deadline = formatDeadline(o.responseDeadline, o.responseDeadlineNote);
  const soon = deadline.daysRemaining != null && deadline.daysRemaining >= 0 && deadline.daysRemaining <= 14;
  const { label: statusLabel, tone: statusTone, dotless } = workflowStatusPill(o.workflow?.status ?? null);
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', borderRadius: 10, background: hover ? '#F2F0EB' : '#FAF9F6', border: hover ? '1px solid #E0DCD4' : '1px solid #E8E5DF' }}>
      <span style={{ flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 78, minHeight: 26, borderRadius: 6, background: '#ffffff', border: '1px solid #E0DCD4', color: '#344054', fontSize: 11, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', textAlign: 'center', padding: '2px 4px' }}>
        {KIND_LABELS[o.kind]}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 15, fontWeight: 500, color: '#101828', textWrap: 'pretty' }}>
          {o.sourceUrl ? (
            <a href={o.sourceUrl} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>
              {o.title}
            </a>
          ) : (
            o.title
          )}
        </span>
        <span style={{ display: 'block', marginTop: 2, fontSize: 13, color: '#667085' }}>{o.agency ?? SOURCE_LABELS[o.source]}</span>
      </span>
      <span style={{ flex: '0 0 auto', width: 92, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: '#101828' }}>{money.value}</span>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: soon ? '#B54708' : '#667085' }}>
          {deadline.daysRemaining != null ? `Due ${deadline.text}` : deadline.text}
        </span>
      </span>
      <span style={{ flex: '0 0 auto', width: 100, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
        <Pill tone="gray" dotless>{o.relevanceScore}% fit</Pill>
        <Pill tone={statusTone} dotless={dotless}>{statusLabel}</Pill>
      </span>
    </div>
  );
}

function RealProgramRow({ pe, onOpen }: { pe: RelevantPeRow; onOpen: () => void }) {
  return (
    <div style={{ padding: '14px 16px', borderRadius: 10, background: '#FAF9F6', border: '1px solid #E8E5DF' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#101828', padding: '2px 6px', borderRadius: 6, background: '#F2F0EB' }}>{pe.peCode}</span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 500, color: '#101828', textWrap: 'pretty' }}>{pe.title ?? pe.peCode}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: '#667085' }}>Relevance</span>
        <span style={{ fontSize: 16, fontWeight: 600, color: '#101828' }}>{formatScorePct(pe.score)}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
        <LinkBtn onClick={onOpen}>Open PE →</LinkBtn>
      </div>
    </div>
  );
}

function OppRow({ o }: { o: (typeof OPPS)[number] }) {
  const [hover, setHover] = useState(false);
  const statusTone = o.status === 'Pursuing' ? 'brand' : 'gray';
  return (
    <button type="button" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', borderRadius: 10, background: hover ? '#F2F0EB' : '#FAF9F6', border: hover ? '1px solid #E0DCD4' : '1px solid #E8E5DF', textAlign: 'left' }}>
      <span style={{ flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 78, height: 26, borderRadius: 6, background: '#ffffff', border: '1px solid #E0DCD4', color: '#344054', fontSize: 11, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase' }}>
        {o.type}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 15, fontWeight: 500, color: '#101828', textWrap: 'pretty' }}>{o.title}</span>
        <span style={{ display: 'block', marginTop: 2, fontSize: 13, color: '#667085' }}>{o.agency}</span>
      </span>
      <span style={{ flex: '0 0 auto', width: 92, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
        <span style={{ fontSize: 15, fontWeight: 600, color: '#101828' }}>{o.amount}</span>
        <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: o.soon ? '#B54708' : '#667085' }}>Due {o.due}</span>
      </span>
      <span style={{ flex: '0 0 auto', width: 100, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
        <Pill tone="gray" dotless>{o.fit}% fit</Pill>
        <Pill tone={statusTone as PillTone} dotless={o.status === 'Match'}>{o.status}</Pill>
      </span>
    </button>
  );
}

function ProgramCard({ p }: { p: (typeof PROGRAMS)[number] }) {
  return (
    <div style={{ padding: '14px 16px', borderRadius: 10, background: '#FAF9F6', border: '1px solid #E8E5DF' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#101828', padding: '2px 6px', borderRadius: 6, background: '#F2F0EB' }}>{p.code}</span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 500, color: '#101828', textWrap: 'pretty' }}>{p.name}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 18, marginTop: 12, flexWrap: 'wrap' }}>
        {([['PB', p.pb], ['Auth', p.auth], ['Approp', p.approp]] as const).map(([label, value], i) => (
          <span key={label} style={{ display: 'flex', alignItems: 'flex-end', gap: 18 }}>
            {i > 0 ? <span style={{ color: '#98A2B3' }}>—</span> : null}
            <span style={{ flex: '0 0 auto' }}>
              <span style={{ display: 'block', fontSize: 11, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: '#667085' }}>{label}</span>
              <span style={{ display: 'block', marginTop: 2, fontSize: 16, fontWeight: 600, color: '#101828' }}>{value}</span>
            </span>
          </span>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
        <LinkBtn>Open PE →</LinkBtn>
        <span style={{ flex: 1 }} />
        <Pill tone={p.down ? 'error' : 'success'}>{p.delta}</Pill>
      </div>
    </div>
  );
}

/* ══════════════════════════ §10.5 Federal Footprint ════════════════════════ */

function FootprintPanel({ client }: { client: Client }) {
  const api = useApi();
  const navigate = useNavigate();

  const ldaQ = useQuery({
    queryKey: ['client-lda-filings', client.id],
    queryFn: () => getClientLdaFilings(api, client.id),
    staleTime: 2 * 60_000,
  });
  const realLda = ldaQ.isSuccess ? ldaQ.data : null;
  const ldaAmount = realLda ? realLda.filings.reduce((sum, f) => sum + f.amount, 0) : null;
  const ldaYoy = useMemo(() => {
    if (!realLda || realLda.byYear.length < 2) return null;
    const sorted = [...realLda.byYear].sort((a, b) => a.year - b.year);
    const latest = sorted[sorted.length - 1]!;
    const prior = sorted[sorted.length - 2]!;
    const priorTotal = prior.income + prior.expenses;
    if (priorTotal <= 0) return null;
    const latestTotal = latest.income + latest.expenses;
    return Math.round(((latestTotal - priorTotal) / priorTotal) * 100);
  }, [realLda]);

  // Same real district-nexus query DistrictPanel already fetches under this
  // exact key — react-query dedupes rather than double-fetching.
  const nexusQ = useQuery({
    queryKey: ['client-district-nexus', client.id],
    queryFn: () => getClientDistrictNexus(api, client.id),
    staleTime: 2 * 60_000,
  });
  const realNexus = nexusQ.isSuccess && nexusQ.data.linked ? nexusQ.data : null;

  // Item 20: the client's own PAC disbursements (Schedule B).
  const fecQ = useQuery({
    queryKey: ['client-fec-money-flow', client.id],
    queryFn: () => getClientFecMoneyFlow(api, client.id),
    staleTime: 5 * 60_000,
  });
  const realPac = fecQ.isSuccess ? (fecQ.data.pacGiving ?? null) : null;

  const intelHref = `/clients?clientId=${encodeURIComponent(client.id)}&tab=intelligence#financial-footprint`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div className="cap-pf-grid-3">
        {/* Lobbying activity */}
        <FootCard title="Lobbying activity" action={<LinkBtn onClick={() => navigate(intelHref)}>Open LDA</LinkBtn>}>
          {realLda ? (
            realLda.matched && realLda.totalFilings > 0 ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 32, fontWeight: 600, letterSpacing: '-0.02em', color: '#101828' }}>
                    ${(ldaAmount ?? 0).toLocaleString()}
                  </span>
                  {ldaYoy != null ? (
                    <Pill tone={ldaYoy >= 0 ? 'success' : 'error'}>{ldaYoy >= 0 ? '▲' : '▼'} {Math.abs(ldaYoy)}% YoY</Pill>
                  ) : null}
                </div>
                <div style={{ marginTop: 2, fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>
                  {realLda.totalFilings} filing{realLda.totalFilings === 1 ? '' : 's'}
                  {realLda.firstFilingYear ? ` · ${realLda.firstFilingYear}–${realLda.latestFilingYear}` : ''}
                </div>
              </>
            ) : (
              <p style={{ margin: '16px 0 0', fontSize: 14, color: '#475467' }}>
                No LDA filings are on record for this client. Absent filings are not the same as no federal
                lobbying activity.
              </p>
            )
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 32, fontWeight: 600, letterSpacing: '-0.02em', color: '#101828' }}>$1.8M</span>
                <Pill tone="success">▲ 18% YoY</Pill>
              </div>
              <div style={{ marginTop: 2, fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>Trailing 12 months</div>
              <Sparkline />
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 12, color: '#667085' }}>
                <span>Q3 24</span><span>Q4 24</span><span>Q1 25</span><span>Q2 25</span>
              </div>
            </>
          )}
        </FootCard>

        {/* Federal awards */}
        <FootCard
          title="Federal awards"
          action={<LinkBtn onClick={() => navigate(`/intelligence/federal-spending?tab=contracts&clientId=${client.id}`)}>View awards</LinkBtn>}
        >
          {realNexus ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 32, fontWeight: 600, letterSpacing: '-0.02em', color: '#101828' }}>
                  ${realNexus.totalAmount.toLocaleString()}
                </span>
                <Pill tone="gray" dotless>{realNexus.totalAwards} award{realNexus.totalAwards === 1 ? '' : 's'}</Pill>
              </div>
              <div style={{ marginTop: 2, fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>
                Confirmed contractor mapping · {realNexus.districtCount} district{realNexus.districtCount === 1 ? '' : 's'}
              </div>
              {/* No real per-agency breakdown source exists yet — dropped rather than fabricated (was Army/Navy/DARPA %). */}
            </>
          ) : nexusQ.isSuccess ? (
            <p style={{ margin: '16px 0 0', fontSize: 14, color: '#475467' }}>
              No confirmed contractor mapping exists for this client, so federal award totals cannot be attributed yet.
            </p>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 32, fontWeight: 600, letterSpacing: '-0.02em', color: '#101828' }}>$84.2M</span>
                <Pill tone="gray" dotless>14 awards</Pill>
              </div>
              <div style={{ marginTop: 2, fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>Obligations · trailing 12 months</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 20 }}>
                {([['Army', '$51.4M', '86%'], ['Navy · ONR', '$18.6M', '31%'], ['DARPA', '$14.2M', '24%']] as const).map(([label, value, w]) => (
                  <span key={label} style={{ display: 'block' }}>
                    <span style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', fontSize: 14 }}>
                      <span style={{ color: '#344054' }}>{label}</span>
                      <span style={{ fontWeight: 600, color: '#101828' }}>{value}</span>
                    </span>
                    <span style={{ display: 'block', marginTop: 6, height: 8, borderRadius: 4, background: '#F2F0EB', overflow: 'hidden' }}>
                      <span style={{ display: 'block', height: 8, width: w, borderRadius: 4, background: GRADIENT_DARK }} />
                    </span>
                  </span>
                ))}
              </div>
            </>
          )}
        </FootCard>

        {/* Political giving — the client's OWN PAC disbursements (item 20). */}
        <FootCard title="Political giving" action={<LinkBtn onClick={() => navigate(intelHref)}>Open FEC / PAC</LinkBtn>}>
          {realPac ? (
            !realPac.tracked ? (
              /* "No committee mapped" is not "$0 given" — never render it as one. */
              <p style={{ margin: '16px 0 0', fontSize: 14, color: '#475467', textWrap: 'pretty' }}>
                No FEC committee is mapped to this client, so its PAC giving cannot be reported.
              </p>
            ) : (
              <>
                <div style={{ marginTop: 16, fontSize: 32, fontWeight: 600, letterSpacing: '-0.02em', color: '#101828' }}>
                  {realPac.summary ? `$${realPac.summary.totalAmount.toLocaleString()}` : '—'}
                </div>
                <div style={{ marginTop: 2, fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>
                  PAC disbursements
                  {realPac.summary
                    ? ` · ${realPac.summary.disbursementCount} disbursement${realPac.summary.disbursementCount === 1 ? '' : 's'}`
                    : ''}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 20 }}>
                  {/* Real top recipients. The fixture's Incumbent/Leadership/Party
                      buckets have no equivalent in the data — recipients are named
                      rows, not categories — so they are not reproduced. */}
                  {topPacRecipients(realPac).length === 0 ? (
                    <p style={{ margin: 0, fontSize: 14, color: '#475467' }}>
                      A committee is mapped, but it has no disbursements on record.
                    </p>
                  ) : (
                    topPacRecipients(realPac).map((r, i, all) => (
                      <span key={`${r.recipientName}-${r.candidateName ?? ''}`} style={{ display: 'block' }}>
                        <span style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, fontSize: 14 }}>
                          <span style={{ color: '#344054', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {r.candidateName ?? r.recipientName}
                          </span>
                          <span style={{ fontWeight: 600, color: '#101828', whiteSpace: 'nowrap' }}>${r.totalAmount.toLocaleString()}</span>
                        </span>
                        <span style={{ display: 'block', marginTop: 6, height: 8, borderRadius: 4, background: '#F2F0EB', overflow: 'hidden' }}>
                          <span
                            style={{
                              display: 'block',
                              height: 8,
                              // Bars are relative to the largest recipient, so the
                              // width is a real comparison rather than a designed %.
                              width: (all[0]?.totalAmount ?? 0) > 0 ? `${Math.round((r.totalAmount / all[0]!.totalAmount) * 100)}%` : '0%',
                              borderRadius: 4,
                              background: '#98A2B3',
                            }}
                          />
                        </span>
                      </span>
                    ))
                  )}
                </div>
              </>
            )
          ) : (
            <>
              <div style={{ marginTop: 16, fontSize: 32, fontWeight: 600, letterSpacing: '-0.02em', color: '#101828' }}>$380K</div>
              <div style={{ marginTop: 2, fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>PAC disbursements · current cycle</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 20 }}>
                {([['Incumbent members', '$214K', '90%'], ['Leadership PACs', '$102K', '43%'], ['Party committees', '$64K', '27%']] as const).map(([label, value, w]) => (
                  <span key={label} style={{ display: 'block' }}>
                    <span style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', fontSize: 14 }}>
                      <span style={{ color: '#344054' }}>{label}</span>
                      <span style={{ fontWeight: 600, color: '#101828' }}>{value}</span>
                    </span>
                    <span style={{ display: 'block', marginTop: 6, height: 8, borderRadius: 4, background: '#F2F0EB', overflow: 'hidden' }}>
                      <span style={{ display: 'block', height: 8, width: w, borderRadius: 4, background: '#98A2B3' }} />
                    </span>
                  </span>
                ))}
              </div>
            </>
          )}
        </FootCard>
      </div>

      {/* Lobbying disclosure history */}
      <Card>
        <CardHead title="Lobbying disclosure history" action={<LinkBtn onClick={() => navigate(intelHref)}>View all filings</LinkBtn>} />
        <div style={{ width: '100%', overflowX: 'auto' }}>
          <div style={{ minWidth: 880 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '10px 24px', background: '#FAF9F6', borderBottom: '1px solid #E8E5DF', fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>
              <span style={{ flex: '0 0 auto', width: 84 }}>Period</span>
              <span style={{ flex: '0 0 auto', width: 64 }}>Type</span>
              <span style={{ flex: 1, minWidth: 0 }}>Registrant</span>
              <span style={{ flex: '0 0 auto', width: 84, textAlign: 'right' }}>Amount</span>
              <span style={{ flex: '0 0 auto', width: 148 }}>Issues</span>
              <span style={{ flex: '0 0 auto', width: 196 }}>Entities contacted</span>
              <span style={{ flex: '0 0 auto', width: 56 }}>Source</span>
            </div>
            {realLda
              ? realLda.filings.map((r) => (
                  <div key={r.filingUuid} style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '13px 24px', borderBottom: '1px solid #E8E5DF' }}>
                    <span style={{ flex: '0 0 auto', width: 84, fontSize: 14, fontWeight: 500, color: '#101828' }}>
                      {[ldaPeriodLabel(r.filingPeriod), r.filingYear].filter(Boolean).join(' ') || '—'}
                    </span>
                    <span style={{ flex: '0 0 auto', width: 64, fontSize: 13, color: '#475467' }}>{r.filingType ? String(r.filingType).toUpperCase() : '—'}</span>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 14, color: '#101828', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{titleCaseName(r.registrantName)}</span>
                    <span style={{ flex: '0 0 auto', width: 84, fontSize: 14, fontWeight: 600, color: '#101828', textAlign: 'right' }}>{formatMoney(r.amount)}</span>
                    <span style={{ flex: '0 0 auto', width: 148, fontSize: 13, color: '#475467' }}>{r.issueCodes.join(' · ') || '—'}</span>
                    <span style={{ flex: '0 0 auto', width: 196, fontSize: 13, color: '#475467', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.governmentEntities.join(' · ') || '—'}</span>
                    {r.documentUrl ? (
                      <a
                        href={r.documentUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={{ flex: '0 0 auto', width: 56, fontSize: 13, fontWeight: 600, letterSpacing: '.03em', textTransform: 'uppercase', color: '#101828' }}
                      >
                        View
                      </a>
                    ) : (
                      <span style={{ flex: '0 0 auto', width: 56, fontSize: 13, color: '#98A2B3' }}>—</span>
                    )}
                  </div>
                ))
              : LDA.map((r) => (
                  <div key={`${r.period}-${r.registrant}`} style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '13px 24px', borderBottom: '1px solid #E8E5DF' }}>
                    <span style={{ flex: '0 0 auto', width: 84, fontSize: 14, fontWeight: 500, color: '#101828' }}>{r.period}</span>
                    <span style={{ flex: '0 0 auto', width: 64, fontSize: 13, color: '#475467' }}>{r.type}</span>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 14, color: '#101828', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.registrant}</span>
                    <span style={{ flex: '0 0 auto', width: 84, fontSize: 14, fontWeight: 600, color: '#101828', textAlign: 'right' }}>{r.amount}</span>
                    <span style={{ flex: '0 0 auto', width: 148, fontSize: 13, color: '#475467' }}>{r.issues}</span>
                    <span style={{ flex: '0 0 auto', width: 196, fontSize: 13, color: '#475467', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.entities}</span>
                    <button type="button" style={{ flex: '0 0 auto', width: 56, fontSize: 13, fontWeight: 600, letterSpacing: '.03em', textTransform: 'uppercase', color: '#101828' }}>View</button>
                  </div>
                ))}
            {realLda && realLda.filings.length === 0 ? (
              <p style={{ margin: 0, padding: '16px 24px', fontSize: 14, color: '#475467' }}>No LDA filings on record.</p>
            ) : null}
          </div>
        </div>
      </Card>

      {/* Past performance — moved here from Capabilities §7.3. What the client
          has actually delivered belongs with its lobbying, awards and giving,
          not beside the roster of what it says it can do. Same real
          `ClientSubmissionHistory` reader; nothing about the card changed. */}
      <PastPerformanceCard client={client} />
    </div>
  );
}

function FootCard({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section style={{ background: '#ffffff', borderRadius: 12, boxShadow: '0 0 0 1px #E8E5DF,0px 1px 3px rgba(16,24,40,.1),0px 1px 2px rgba(16,24,40,.06)', padding: '20px 24px 22px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: '#101828' }}>{title}</h3>
        <span style={{ flex: 1 }} />
        {action}
      </div>
      {children}
    </section>
  );
}

function Sparkline() {
  const max = Math.max(...SPARK);
  const w = 240;
  const h = 76;
  const step = w / (SPARK.length - 1);
  const points = SPARK.map((v, i) => `${i * step},${h - (v / max) * (h - 8)}`).join(' ');
  return (
    <svg style={{ display: 'block', width: '100%', height: 76, marginTop: 16 }} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <polyline points={points} fill="none" stroke="#101828" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/* ═══════════════════════════ §10.6 District Nexus ══════════════════════════ */

interface RealDistrictModel {
  code: string;
  lat: number;
  lon: number;
  facilityNames: string[];
  employeeCount: number | null;
  totalAmount: number | null;
  awardCount: number | null;
  repName: string | null;
  repParty: string | null;
  repChamber: string | null;
  score: number;
  strength: 'Strong' | 'Moderate' | 'Developing';
  ui: PillTone;
}

function tierOf(score: number): { strength: RealDistrictModel['strength']; ui: PillTone } {
  if (score >= 80) return { strength: 'Strong', ui: 'success' };
  if (score >= 60) return { strength: 'Moderate', ui: 'blue' };
  return { strength: 'Developing', ui: 'gray' };
}

/**
 * v1 (`getClientDistrictNexus`) reports real award dollars/counts per district
 * but has no normalized 0-100 nexus score — that scoring model belongs to
 * District Nexus v2, which is feature-flagged and dark for most tenants today.
 * Rather than inventing a precise-looking score this app has no real basis
 * for, real districts get one of two disclosed, coarse tiers (confirmed
 * federal award activity vs. facility presence only); the real dollar/count
 * figures are always shown alongside, never replaced by this tier.
 */
function scoreOf(nexusRow: DistrictNexusRow | undefined): number {
  return nexusRow && nexusRow.totalAmount > 0 ? 75 : 40;
}

function buildRealDistricts(
  facilities: ClientFacility[],
  nexusByDistrict: Map<string, DistrictNexusRow>,
  repByFacilityId: Map<string, RepresentationResult>,
): RealDistrictModel[] {
  const byCode = new Map<string, ClientFacility[]>();
  for (const facility of facilities) {
    const code = formatFacilityDistrict(facility.state, facility.congressionalDistrict);
    if (!code) continue;
    const group = byCode.get(code) ?? [];
    group.push(facility);
    byCode.set(code, group);
  }

  const models: RealDistrictModel[] = [];
  for (const [code, group] of byCode) {
    const geocoded = group.find((f) => f.latitude != null && f.longitude != null);
    if (!geocoded) continue; // no coordinates to plot — still listed in the facilities table below

    const nexusRow = nexusByDistrict.get(code);
    const knownEmployees = group.filter((f): f is ClientFacility & { employeeCount: number } => f.employeeCount != null);

    let repName: string | null = null;
    let repParty: string | null = null;
    let repChamber: string | null = null;
    for (const facility of group) {
      const rep = repByFacilityId.get(facility.id);
      if (rep && !rep.unresolved && rep.federal.house) {
        repName = rep.federal.house.fullName;
        repParty = rep.federal.house.party;
        repChamber = 'House';
        break;
      }
    }

    const score = scoreOf(nexusRow);
    models.push({
      code,
      lat: geocoded.latitude as number,
      lon: geocoded.longitude as number,
      facilityNames: group.map((f) => f.name),
      employeeCount: knownEmployees.length ? knownEmployees.reduce((sum, f) => sum + f.employeeCount, 0) : null,
      totalAmount: nexusRow?.totalAmount ?? null,
      awardCount: nexusRow?.awardCount ?? null,
      repName,
      repParty,
      repChamber,
      score,
      ...tierOf(score),
    });
  }

  return models.sort((a, b) => {
    const byAmount = (b.totalAmount ?? -1) - (a.totalAmount ?? -1);
    if (byAmount !== 0) return byAmount;
    return (b.employeeCount ?? 0) - (a.employeeCount ?? 0);
  });
}

function facilityStatus(facility: ClientFacility, representation: RepresentationResult | undefined): { label: string; tone: PillTone } {
  if (
    !facility.congressionalDistrict ||
    facility.geocodeStatus === 'no_match' ||
    facility.geocodeStatus === 'ambiguous' ||
    facility.geocodeStatus === 'error'
  ) {
    return { label: 'Needs review', tone: 'warning' };
  }
  if (representation && !representation.unresolved && representation.federal.house) {
    return { label: 'Confirmed', tone: 'success' };
  }
  return { label: 'Representative pending', tone: 'warning' };
}

function DistrictPanel({ client }: { client: Client }) {
  const api = useApi();
  const [selected, setSelected] = useState<string | null>(null);

  const v2Q = useDistrictNexusV2(client, true);
  const facilitiesQ = useQuery({
    queryKey: ['client-facilities', client.id],
    queryFn: () => getClientFacilities(api, client.id),
    staleTime: 60_000,
  });
  const nexusQ = useQuery({
    queryKey: ['client-district-nexus', client.id],
    queryFn: () => getClientDistrictNexus(api, client.id),
    staleTime: 2 * 60_000,
  });
  const representationQ = useQuery({
    queryKey: ['client-representation', client.id],
    queryFn: () => getClientRepresentation(api, client.id),
    staleTime: 2 * 60_000,
  });

  const facilitiesLoaded = facilitiesQ.data !== undefined && !facilitiesQ.isError;
  const v2 = v2Q.data ?? null;
  const v2Settled = v2Q.data !== undefined || v2Q.isError || !v2Q.isLoading;

  const nexusByDistrict = useMemo(() => {
    const map = new Map<string, DistrictNexusRow>();
    if (nexusQ.data?.linked) for (const row of nexusQ.data.districts) map.set(row.district, row);
    return map;
  }, [nexusQ.data]);
  const repByFacilityId = useMemo(
    () => new Map((representationQ.data ?? []).map((r) => [r.facility.id, r.representation])),
    [representationQ.data],
  );
  const v1List = useMemo(
    () =>
      facilitiesLoaded && facilitiesQ.data!.length > 0
        ? buildRealDistricts(facilitiesQ.data!, nexusByDistrict, repByFacilityId)
        : [],
    [facilitiesLoaded, facilitiesQ.data, nexusByDistrict, repByFacilityId],
  );
  const ungeocodedCount = facilitiesLoaded
    ? facilitiesQ.data!.filter((f) => f.latitude == null || f.longitude == null).length
    : 0;

  /** House rep for a v2 districtKey, resolved through the facility pipeline. */
  const repForDistrict = useMemo(() => {
    const out = new Map<string, { name: string; party: string | null }>();
    for (const facility of facilitiesQ.data ?? []) {
      const code = formatFacilityDistrict(facility.state, facility.congressionalDistrict);
      if (!code) continue;
      const [state, no] = code.split('-');
      const key = `${state}-${(no ?? '').padStart(2, '0')}`;
      if (out.has(key)) continue;
      const rep = repByFacilityId.get(facility.id);
      if (rep && !rep.unresolved && rep.federal.house) {
        out.set(key, { name: rep.federal.house.fullName, party: rep.federal.house.party });
      }
    }
    return out;
  }, [facilitiesQ.data, repByFacilityId]);

  // ── loading / error / empty gates (no design fixture, ever) ──────────────
  if (!v2Settled || (!v2 && !facilitiesLoaded && !facilitiesQ.isError)) {
    return (
      <Card>
        <div style={{ padding: '20px 24px' }} aria-busy="true">
          <div style={{ height: 18, width: 220, borderRadius: 6, background: '#F2F0EB' }} />
          <div style={{ marginTop: 16, height: 380, borderRadius: 10, background: '#FAF9F6', border: '1px solid #E8E5DF' }} />
        </div>
      </Card>
    );
  }

  if (!v2 && facilitiesQ.isError) {
    return (
      <Card>
        <div style={{ padding: '32px 24px' }}>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: '#101828' }}>District data could not be loaded</h3>
          <p style={{ margin: '8px 0 16px', fontSize: 14, lineHeight: '20px', color: '#475467' }}>
            {facilitiesQ.error instanceof Error ? facilitiesQ.error.message : 'The facilities service did not answer.'}
          </p>
          <SecondaryBtn onClick={() => void facilitiesQ.refetch()}>Retry</SecondaryBtn>
        </div>
      </Card>
    );
  }

  const v2Districts = v2 ? [...v2.districts].sort((a, b) => (b.score ?? -1) - (a.score ?? -1)) : [];

  if (v2 && v2Districts.length > 0) {
    const effectiveSelected =
      selected && v2Districts.some((d) => d.districtKey === selected)
        ? selected
        : (v2.bestDistrictKey ?? v2Districts[0]!.districtKey);
    const sel = v2Districts.find((d) => d.districtKey === effectiveSelected) ?? null;
    const selBand = sel ? bandOf(sel.score) : null;
    const selRep = sel ? repForDistrict.get(sel.districtKey) : undefined;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <Card>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '20px 24px 16px', flexWrap: 'wrap' }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 18, fontWeight: 600, color: '#101828' }}>District footprint</span>
              <span style={{ display: 'block', marginTop: 4, fontSize: 14, color: '#475467', textWrap: 'pretty' }}>
                Verified client footprint, public funding, and representation by congressional district — the same scoring District Nexus uses. Select a district on the map or in the list.
              </span>
            </span>
            <Pill tone="gray" dotless>
              {v2Districts.length} district{v2Districts.length === 1 ? '' : 's'} · {Math.round(v2.coveragePercent)}% coverage
            </Pill>
          </div>
          <div className="cap-pf-map-cols">
            <div className="cap-pf-map-frame">
              <Suspense fallback={<div className="cap-pf-dn-loading" aria-busy="true" aria-label="Loading map" />}>
                <DistrictNexusMapLibreLazy
                  districts={v2Districts}
                  selectedDistrictKey={effectiveSelected}
                  onSelectDistrict={setSelected}
                />
              </Suspense>
            </div>
            <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {v2Districts.map((d) => (
                <V2DistrictRailRow
                  key={d.districtKey}
                  d={d}
                  selected={effectiveSelected === d.districtKey}
                  onSelect={() => setSelected(d.districtKey)}
                />
              ))}
            </div>
          </div>
          {ungeocodedCount > 0 ? (
            <p style={{ margin: 0, padding: '14px 24px 18px', fontSize: 13, color: '#667085' }}>
              {ungeocodedCount} facilit{ungeocodedCount === 1 ? 'y is' : 'ies are'} recorded but not yet geocoded — the map shows district evidence, not facility pins.
            </p>
          ) : null}
        </Card>

        {sel ? (
          <div className="cap-pf-grid-dist">
            <Card>
              <CardHead title="Selected district" />
              <div style={{ padding: '20px 24px 22px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 32, fontWeight: 600, letterSpacing: '-0.02em', color: '#101828' }}>{sel.districtKey}</span>
                  {selBand ? (
                    <Pill tone={selBand.id === 'strong' ? 'success' : selBand.id === 'moderate' ? 'blue' : 'gray'} size="lg">
                      {selBand.label} nexus · {sel.score}
                    </Pill>
                  ) : (
                    <Pill tone="gray" size="lg" dotless>
                      Unscored — below the coverage floor
                    </Pill>
                  )}
                </div>
                <div style={{ marginTop: 14, fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>Federal representative</div>
                <div style={{ marginTop: 3, fontSize: 16, color: '#101828' }}>
                  {selRep ? `${selRep.name}${partyLabel(selRep.party) ? ` (${partyLabel(selRep.party)})` : ''} · House` : 'Not yet resolved'}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(96px,1fr))', gap: 10, marginTop: 18 }}>
                  {(
                    [
                      ['Contract obligations', formatMoney(sel.awarded.contractObligations)],
                      ['Grant obligations', formatMoney(sel.awarded.grantObligations)],
                      ['Employees', sel.employeeCount != null ? formatNumber(sel.employeeCount) : sel.employeesUnreported ? 'Not reported' : '—'],
                      ['Evidence coverage', `${Math.round(sel.coveragePercent)}%`],
                    ] as const
                  ).map(([label, tileValue]) => (
                    <span key={label} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '12px 10px', borderRadius: 8, background: '#FAF9F6', border: '1px solid #E8E5DF' }}>
                      <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: '#667085' }}>{label}</span>
                      <span style={{ fontSize: 14, fontWeight: 600, color: '#101828' }}>{tileValue}</span>
                    </span>
                  ))}
                </div>
              </div>
            </Card>

            <FacilitiesRepresentationCard
              facilities={facilitiesQ.data ?? []}
              repByFacilityId={repByFacilityId}
            />
          </div>
        ) : null}
      </div>
    );
  }

  // ── v2 present but empty, or v2 dark — the v1 facility view ──────────────
  const genuinelyEmpty = facilitiesLoaded && facilitiesQ.data!.length === 0;
  if (genuinelyEmpty) {
    return (
      <Card>
        <div style={{ padding: '40px 24px', textAlign: 'center' }}>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: '#101828' }}>No facilities recorded for this client</h3>
          <p style={{ margin: '8px 0 0', fontSize: 14, lineHeight: '20px', color: '#475467', textWrap: 'pretty' }}>
            District Nexus builds on this client&apos;s recorded facility addresses. Add a facility to see its
            congressional district, representative, and any confirmed federal award activity here.
          </p>
        </div>
      </Card>
    );
  }

  const effectiveSelected = selected && v1List.some((d) => d.code === selected) ? selected : (v1List[0]?.code ?? null);
  const sel = v1List.find((d) => d.code === effectiveSelected) ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <Card>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '20px 24px 16px', flexWrap: 'wrap' }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 18, fontWeight: 600, color: '#101828' }}>District footprint</span>
            <span style={{ display: 'block', marginTop: 4, fontSize: 14, color: '#475467', textWrap: 'pretty' }}>
              Real facility locations and confirmed federal award activity by congressional district. Select a district on the map or in the list.
            </span>
          </span>
          <Pill tone="gray" dotless>{v1List.length} district{v1List.length === 1 ? '' : 's'}</Pill>
        </div>
        {v1List.length === 0 ? (
          <p style={{ margin: 0, padding: '0 24px 20px', fontSize: 14, color: '#475467' }}>
            {ungeocodedCount > 0
              ? `${ungeocodedCount} facilit${ungeocodedCount === 1 ? 'y is' : 'ies are'} recorded but not yet geocoded, so no district can be plotted yet.`
              : 'No facility has resolved to a congressional district yet.'}
          </p>
        ) : (
          <div className="cap-pf-map-cols">
            <div className="cap-pf-map-frame">
              <DistrictNexusMap
                districts={v1List.map((d) => ({ code: d.code, score: d.score, lat: d.lat, lon: d.lon }))}
                selected={effectiveSelected ?? ''}
                onSelect={setSelected}
              />
            </div>
            <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {v1List.map((d) => (
                <RealDistrictRailRow key={d.code} d={d} selected={effectiveSelected === d.code} onSelect={() => setSelected(d.code)} />
              ))}
            </div>
          </div>
        )}
        {ungeocodedCount > 0 && v1List.length > 0 ? (
          <p style={{ margin: 0, padding: '0 24px 18px', fontSize: 13, color: '#667085' }}>
            {ungeocodedCount} more facilit{ungeocodedCount === 1 ? 'y is' : 'ies are'} recorded but not yet geocoded.
          </p>
        ) : null}
        {nexusQ.data && !nexusQ.data.linked ? (
          <p style={{ margin: 0, padding: '0 24px 18px', fontSize: 13, color: '#667085' }}>{nexusQ.data.disclaimer}</p>
        ) : null}
      </Card>

      {sel ? (
        <div className="cap-pf-grid-dist">
          <Card>
            <CardHead title="Selected district" />
            <div style={{ padding: '20px 24px 22px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 32, fontWeight: 600, letterSpacing: '-0.02em', color: '#101828' }}>{sel.code}</span>
                <Pill tone={sel.ui} size="lg">{sel.strength} nexus</Pill>
              </div>
              <div style={{ marginTop: 14, fontSize: 12, fontWeight: 600, letterSpacing: '.04em', textTransform: 'uppercase', color: '#667085' }}>Federal representative</div>
              <div style={{ marginTop: 3, fontSize: 16, color: '#101828' }}>
                {sel.repName ? `${sel.repName}${partyLabel(sel.repParty) ? ` (${partyLabel(sel.repParty)})` : ''} · ${sel.repChamber}` : 'Not yet resolved'}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(96px,1fr))', gap: 10, marginTop: 18 }}>
                {(
                  [
                    ['Facilities', sel.facilityNames.join(', ') || '—'],
                    ['Employees', sel.employeeCount != null ? formatNumber(sel.employeeCount) : 'Needs count'],
                    ['Federal awards', sel.totalAmount != null ? formatMoney(sel.totalAmount) : 'No confirmed awards'],
                    ['Awards on record', sel.awardCount != null ? formatNumber(sel.awardCount) : '—'],
                  ] as const
                ).map(([label, tileValue]) => (
                  <span key={label} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '12px 10px', borderRadius: 8, background: '#FAF9F6', border: '1px solid #E8E5DF' }}>
                    <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase', color: '#667085' }}>{label}</span>
                    <span style={{ fontSize: 14, fontWeight: 600, color: '#101828' }}>{tileValue}</span>
                  </span>
                ))}
              </div>
            </div>
          </Card>

          <FacilitiesRepresentationCard
            facilities={facilitiesQ.data ?? []}
            repByFacilityId={repByFacilityId}
          />
        </div>
      ) : null}
    </div>
  );
}

function RealDistrictRailRow({ d, selected, onSelect }: { d: RealDistrictModel; selected: boolean; onSelect: () => void }) {
  const [hover, setHover] = useState(false);
  const dot = d.score >= 80 ? '#101828' : d.score >= 60 ? '#475467' : '#98A2B3';
  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-pressed={selected}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '11px 12px',
        borderRadius: 10,
        textAlign: 'left',
        background: selected ? '#FAF9F6' : hover ? '#F2F0EB' : '#ffffff',
        boxShadow: selected ? 'inset 0 0 0 1.5px #101828' : 'none',
        border: selected ? '1px solid transparent' : hover ? '1px solid #E0DCD4' : '1px solid #E8E5DF',
      }}
    >
      <span style={{ flex: '0 0 auto', width: 8, height: 8, borderRadius: '50%', background: dot }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: '.02em', color: '#101828' }}>{d.code}</span>
          <span style={{ fontSize: 13, color: '#667085', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {d.facilityNames[0]}
            {d.facilityNames.length > 1 ? ` +${d.facilityNames.length - 1}` : ''}
          </span>
        </span>
        <span style={{ display: 'block', marginTop: 4, fontSize: 12, color: '#667085' }}>
          {d.totalAmount != null ? formatMoney(d.totalAmount) : 'No confirmed awards'}
          {d.employeeCount != null ? ` · ${formatNumber(d.employeeCount)} employees` : ''}
        </span>
      </span>
    </button>
  );
}

/** Rail row for a v2 (scored) district — band-colored dot, real obligations. */
function V2DistrictRailRow({
  d,
  selected,
  onSelect,
}: {
  d: DistrictNexusDistrictDetail;
  selected: boolean;
  onSelect: () => void;
}) {
  const [hover, setHover] = useState(false);
  const band: ScoreBand | null = bandOf(d.score);
  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-pressed={selected}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '11px 12px',
        borderRadius: 10,
        textAlign: 'left',
        background: selected ? '#FAF9F6' : hover ? '#F2F0EB' : '#ffffff',
        boxShadow: selected ? 'inset 0 0 0 1.5px #101828' : 'none',
        border: selected ? '1px solid transparent' : hover ? '1px solid #E0DCD4' : '1px solid #E8E5DF',
      }}
    >
      <span
        title={band ? `${band.label} nexus` : 'Unscored'}
        style={{ flex: '0 0 auto', width: 8, height: 8, borderRadius: '50%', background: band?.color ?? '#E0DCD4' }}
      />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600, letterSpacing: '.02em', color: '#101828' }}>{d.districtKey}</span>
          <span style={{ fontSize: 13, color: '#667085', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {band ? band.label : 'Unscored'}
          </span>
        </span>
        <span style={{ display: 'block', marginTop: 4, fontSize: 12, color: '#667085' }}>
          {d.awarded.contractObligations != null || d.awarded.grantObligations != null
            ? `${formatMoney(d.awarded.contractObligations)} contracts · ${formatMoney(d.awarded.grantObligations)} grants`
            : 'No confirmed awards'}
          {d.employeeCount != null ? ` · ${formatNumber(d.employeeCount)} employees` : ''}
        </span>
      </span>
      <span style={{ flex: '0 0 auto', fontSize: 14, fontWeight: 600, color: '#101828' }}>{d.score ?? '—'}</span>
    </button>
  );
}

/** Facilities table shared by the v1 and v2 layouts — always real rows. */
function FacilitiesRepresentationCard({
  facilities,
  repByFacilityId,
}: {
  facilities: ClientFacility[];
  repByFacilityId: Map<string, RepresentationResult>;
}) {
  return (
    <Card>
      <CardHead title="Facilities & representation" />
      <div>
        {facilities.length === 0 ? (
          <p style={{ margin: 0, padding: '18px 24px', fontSize: 14, color: '#667085' }}>No facilities recorded.</p>
        ) : (
          facilities.map((f) => {
            const representation = repByFacilityId.get(f.id);
            const { label, tone } = facilityStatus(f, representation);
            const repName = representation && !representation.unresolved ? representation.federal.house?.fullName : null;
            return (
              <div key={f.id} style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 12, padding: '13px 24px', borderBottom: '1px solid #F2F0EB', textAlign: 'left' }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 500, color: '#101828', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</span>
                <span style={{ flex: '0 0 auto', width: 64, fontSize: 13, color: '#475467' }}>{formatFacilityDistrict(f.state, f.congressionalDistrict) || 'Not geocoded'}</span>
                <span style={{ flex: '0 0 auto', minWidth: 40, fontSize: 13, color: '#475467', textAlign: 'right' }}>{f.employeeCount != null ? formatNumber(f.employeeCount) : 'Needs count'}</span>
                <span style={{ flex: '0 0 auto', width: 118, fontSize: 13, color: '#475467', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{repName ?? 'Not resolved'}</span>
                <span style={{ flex: '0 0 auto', width: 140, display: 'flex', justifyContent: 'flex-end' }}>
                  <Pill tone={tone}>{label}</Pill>
                </span>
              </div>
            );
          })
        )}
      </div>
    </Card>
  );
}
