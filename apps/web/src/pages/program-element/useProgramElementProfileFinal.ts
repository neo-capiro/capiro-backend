import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useApi } from '../../lib/use-api.js';
import { useActionsList } from '../actions/actions-api.js';
import { getRelevantClientsForPe } from '../clients/relevance-api.js';
import {
  getBudgetActions,
  getBudgetLineRelationships,
  getIncumbents,
  getProgramElementBillActions,
  getProgramElementBills,
  getProgramElementContractors,
  getProgramElementDeltas,
  getProgramElementDetail,
  getProgramElementIntelligence,
  getProgramElementNarrative,
  getProgramElementOpportunities,
  getProgramElementPersonnel,
  getProgramElementProcurementLines,
  getProgramElementProjects,
  getProgramElementProvisions,
  getProgramElementRelated,
  getProgramElementSources,
} from './api.js';
import { getProgramsForPe } from './programs-api.js';
import type { DescriptionSource } from './DescriptionPanel.js';
import type { PdocDetail } from './PdocDetailPanel.js';
import type {
  ProgramElementBill,
  ProgramElementHistoryRow,
  ProgramElementYearPoint,
} from './types.js';
import { buildFundingSeries, STAGE_LABEL } from './funding-model.js';
import { useWatchToggle } from './pe-shared.js';

const CLOSED_ACTION_STATUSES = new Set(['dismissed', 'archived']);

export type ProgramElementProfileSection =
  | 'overview'
  | 'funding'
  | 'legislative'
  | 'structure'
  | 'ecosystem'
  | 'sources';

export const PROGRAM_ELEMENT_PROFILE_SECTIONS: Array<{
  key: ProgramElementProfileSection;
  label: string;
}> = [
  { key: 'overview', label: 'Overview' },
  { key: 'funding', label: 'Funding & movement' },
  { key: 'legislative', label: 'Legislative' },
  { key: 'structure', label: 'Program structure' },
  { key: 'ecosystem', label: 'Ecosystem' },
  { key: 'sources', label: 'Sources & coverage' },
];

function parseSection(value: string | null): ProgramElementProfileSection {
  return PROGRAM_ELEMENT_PROFILE_SECTIONS.some((item) => item.key === value)
    ? (value as ProgramElementProfileSection)
    : 'overview';
}

function numberOrNull(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toProgramElementHistoryRows(
  years: ProgramElementYearPoint[],
): ProgramElementHistoryRow[] {
  return [...years]
    .sort((left, right) => left.fy - right.fy)
    .map((year) => ({
      id: year.id,
      fy: year.fy,
      request: numberOrNull(year.request),
      hascMark: numberOrNull(year.hascMark),
      sascMark: numberOrNull(year.sascMark),
      hacDMark: numberOrNull(year.hacDMark),
      sacDMark: numberOrNull(year.sacDMark),
      conference: numberOrNull(year.conference),
      ndaaConference: numberOrNull(year.ndaaConference),
      enacted: numberOrNull(year.enacted),
      projectedEnacted: false,
      sourceAttribution: {},
    }));
}

function downloadCsv(
  filename: string,
  rows: Array<Array<string | number | null | undefined>>,
) {
  const csv = rows
    .map((row) =>
      row
        .map((cell) => `"${String(cell ?? '').replaceAll('"', '""')}"`)
        .join(','),
    )
    .join('\n');
  const url = URL.createObjectURL(
    new Blob([csv], { type: 'text/csv;charset=utf-8' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function useProgramElementProfileFinal() {
  const { peCode = '' } = useParams<{ peCode: string }>();
  const code = peCode.toUpperCase();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const api = useApi();
  const watch = useWatchToggle();
  const [section, setSection] = useState<ProgramElementProfileSection>(() =>
    parseSection(searchParams.get('tab')),
  );
  const [alertsOpen, setAlertsOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [dataIssueOpen, setDataIssueOpen] = useState(false);
  const [linkTarget, setLinkTarget] = useState<{
    id: string;
    name: string;
  } | null>(null);

  useEffect(() => {
    setSection(parseSection(searchParams.get('tab')));
  }, [searchParams]);

  const setActiveSection = (next: ProgramElementProfileSection) => {
    setSection(next);
    const params = new URLSearchParams(searchParams);
    if (next === 'overview') params.delete('tab');
    else params.set('tab', next);
    setSearchParams(params, { replace: true });
  };
  const enabled = (...sections: ProgramElementProfileSection[]) =>
    code.length > 0 && sections.includes(section);

  const detailQuery = useQuery({
    queryKey: ['program-element-detail', code],
    queryFn: () => getProgramElementDetail(api, code),
    enabled: code.length > 0,
    staleTime: 5 * 60_000,
  });
  const billsQuery = useQuery({
    queryKey: ['program-element-bills', code, 'final-ui'],
    queryFn: () => getProgramElementBills(api, code),
    enabled: enabled('overview', 'legislative'),
    staleTime: 60_000,
  });
  const billActionsQuery = useQuery({
    queryKey: ['program-element-bill-actions', code, 'final-ui'],
    queryFn: () => getProgramElementBillActions(api, code),
    enabled: enabled('legislative'),
    staleTime: 60_000,
  });
  const budgetActionsQuery = useQuery({
    queryKey: ['program-element-actions', code, 'final-ui'],
    queryFn: () => getBudgetActions(api, code),
    enabled: enabled('overview', 'legislative'),
    staleTime: 60_000,
  });
  const peopleQuery = useQuery({
    queryKey: ['program-element-personnel', code, 'final-ui'],
    queryFn: () => getProgramElementPersonnel(api, code),
    enabled: enabled('overview', 'ecosystem'),
    staleTime: 60_000,
  });
  const clientsQuery = useQuery({
    queryKey: ['program-element-client-relevance', code, 'final-ui'],
    queryFn: () => getRelevantClientsForPe(api, code),
    enabled: enabled('overview', 'sources'),
    staleTime: 60_000,
  });
  const deltasQuery = useQuery({
    queryKey: ['program-element-deltas', code, 'final-ui'],
    queryFn: () => getProgramElementDeltas(api, code, { limit: 25 }),
    enabled: enabled('funding', 'sources'),
    staleTime: 60_000,
  });
  const narrativeQuery = useQuery({
    queryKey: ['program-element-narrative', code, 'final-ui'],
    queryFn: () => getProgramElementNarrative(api, code),
    enabled: enabled('funding'),
    staleTime: 60_000,
  });
  const projectsQuery = useQuery({
    queryKey: ['program-element-projects', code, 'final-ui'],
    queryFn: () => getProgramElementProjects(api, code),
    enabled: enabled('structure'),
    staleTime: 60_000,
  });
  const procurementQuery = useQuery({
    queryKey: ['program-element-procurement-lines', code, 'final-ui'],
    queryFn: () => getProgramElementProcurementLines(api, code),
    enabled: enabled('structure'),
    staleTime: 60_000,
  });
  const relatedQuery = useQuery({
    queryKey: ['program-element-related', code, 'final-ui'],
    queryFn: () => getProgramElementRelated(api, code),
    enabled: enabled('structure'),
    staleTime: 60_000,
  });
  const programsQuery = useQuery({
    queryKey: ['program-element-programs', code, 'final-ui'],
    queryFn: () => getProgramsForPe(api, code),
    enabled: enabled('structure'),
    staleTime: 60_000,
  });
  const relationshipsQuery = useQuery({
    queryKey: ['program-element-relationships', code, 'final-ui'],
    queryFn: () => getBudgetLineRelationships(api, code),
    enabled: enabled('structure'),
    staleTime: 60_000,
  });
  const provisionsQuery = useQuery({
    queryKey: ['program-element-provisions', code, 'final-ui'],
    queryFn: () => getProgramElementProvisions(api, code),
    enabled: enabled('legislative'),
    staleTime: 60_000,
  });
  const opportunitiesQuery = useQuery({
    queryKey: ['program-element-opportunities', code, 'final-ui'],
    queryFn: () => getProgramElementOpportunities(api, code),
    enabled: enabled('legislative'),
    staleTime: 60_000,
  });
  const contractorsQuery = useQuery({
    queryKey: ['program-element-contractors', code, 'final-ui'],
    queryFn: () => getProgramElementContractors(api, code),
    enabled: enabled('ecosystem'),
    staleTime: 60_000,
  });
  const incumbentsQuery = useQuery({
    queryKey: ['program-element-incumbents', code, 'final-ui'],
    queryFn: () => getIncumbents(api, code),
    enabled: enabled('ecosystem'),
    staleTime: 60_000,
  });
  const intelligenceQuery = useQuery({
    queryKey: ['program-element-intelligence', code, 'final-ui'],
    queryFn: () => getProgramElementIntelligence(api, code),
    enabled: enabled('structure', 'ecosystem'),
    staleTime: 5 * 60_000,
  });
  const sourcesQuery = useQuery({
    queryKey: ['program-element-sources', code, 'final-ui'],
    queryFn: () => getProgramElementSources(api, code),
    enabled: enabled('sources'),
    staleTime: 60_000,
  });
  const actionCardsQuery = useActionsList({ page: 1, limit: 100 });

  const detail = detailQuery.data;
  const funding = detail ? buildFundingSeries(detail.years ?? []) : [];
  const latest = [...funding]
    .reverse()
    .find((point) => point.current.value != null);
  const latestRequest = [...funding]
    .reverse()
    .find((point) => point.request != null);
  const current = latest?.current.value ?? null;
  const request = latest?.request ?? latestRequest?.request ?? null;
  const deltaPct =
    latest?.request != null && latest.request !== 0 && current != null
      ? ((current - latest.request) / Math.abs(latest.request)) * 100
      : null;
  const bills = Array.isArray(billsQuery.data) ? billsQuery.data : [];
  const signals = Array.isArray(budgetActionsQuery.data)
    ? budgetActionsQuery.data
    : [];
  const people = Array.isArray(peopleQuery.data) ? peopleQuery.data : [];
  const clients = Array.isArray(clientsQuery.data) ? clientsQuery.data : [];
  const openActions = (actionCardsQuery.data?.data ?? []).filter(
    (action) =>
      action.peCode === code && !CLOSED_ACTION_STATUSES.has(action.status),
  );
  const raw =
    (detail as
      | {
          raw?: {
            pDocDetail?: PdocDetail | null;
            op5Detail?: DescriptionSource['op5Detail'];
          } | null;
        }
      | undefined)?.raw ?? {};
  const pdoc = raw.pDocDetail ?? null;
  const historyEvents = billActionsQuery.isError
    ? []
    : billActionsQuery.data ?? [];
  const billsWithActions: ProgramElementBill[] = bills.map((bill) => ({
    ...bill,
    ...(billActionsQuery.isError
      ? {}
      : {
          actions: historyEvents
            .filter((event) => event.billId === bill.id)
            .map((event, index) => ({
              id: `${event.billId}-${event.date}-${index}`,
              date: event.date,
              text: event.text,
              type: event.type,
              chamber: event.chamber,
            })),
        }),
  }));
  const latestRecordFy = (detail?.years ?? []).reduce<number | null>(
    (max, year) => {
      const hasValue = [
        year.request,
        year.hascMark,
        year.sascMark,
        year.hacDMark,
        year.sacDMark,
        year.ndaaConference,
        year.conference,
        year.enacted,
      ].some((value) => numberOrNull(value) != null);
      return hasValue && (max == null || year.fy > max) ? year.fy : max;
    },
    null,
  );
  const historical =
    latestRecordFy != null &&
    detail?.currentCycleFy != null &&
    latestRecordFy < detail.currentCycleFy;
  const lineType = detail?.appropriationType?.toUpperCase().startsWith('RDT')
    ? 'RDT&E PE'
    : detail?.appropriationType?.toUpperCase() === 'PROC'
      ? 'Procurement BLIN'
      : detail?.appropriationType?.toUpperCase() === 'OM'
        ? 'O&M line'
        : 'Budget line';
  const firstSignal = signals[0];
  const signalLabel = firstSignal
    ? `${firstSignal.stage.replaceAll('_', '-')} ${firstSignal.action.replaceAll('_', ' ')}`.toUpperCase()
    : null;

  const partial = (() => {
    if (section === 'overview') {
      return (
        billsQuery.isError ||
        budgetActionsQuery.isError ||
        peopleQuery.isError ||
        clientsQuery.isError ||
        actionCardsQuery.isError
      );
    }
    if (section === 'funding') {
      return deltasQuery.isError || narrativeQuery.isError;
    }
    if (section === 'legislative') {
      return (
        billsQuery.isError ||
        billActionsQuery.isError ||
        budgetActionsQuery.isError ||
        provisionsQuery.isError ||
        opportunitiesQuery.isError
      );
    }
    if (section === 'structure') {
      return (
        projectsQuery.isError ||
        procurementQuery.isError ||
        relatedQuery.isError ||
        programsQuery.isError ||
        relationshipsQuery.isError ||
        intelligenceQuery.isError
      );
    }
    if (section === 'ecosystem') {
      return (
        contractorsQuery.isError ||
        incumbentsQuery.isError ||
        peopleQuery.isError ||
        intelligenceQuery.isError
      );
    }
    return (
      clientsQuery.isError || sourcesQuery.isError || deltasQuery.isError
    );
  })();

  const retryFailed = () => {
    if (section === 'overview') {
      if (billsQuery.isError) void billsQuery.refetch();
      if (budgetActionsQuery.isError) void budgetActionsQuery.refetch();
      if (peopleQuery.isError) void peopleQuery.refetch();
      if (clientsQuery.isError) void clientsQuery.refetch();
      if (actionCardsQuery.isError) void actionCardsQuery.refetch();
    } else if (section === 'funding') {
      if (deltasQuery.isError) void deltasQuery.refetch();
      if (narrativeQuery.isError) void narrativeQuery.refetch();
    } else if (section === 'legislative') {
      if (billsQuery.isError) void billsQuery.refetch();
      if (billActionsQuery.isError) void billActionsQuery.refetch();
      if (budgetActionsQuery.isError) void budgetActionsQuery.refetch();
      if (provisionsQuery.isError) void provisionsQuery.refetch();
      if (opportunitiesQuery.isError) void opportunitiesQuery.refetch();
    } else if (section === 'structure') {
      if (projectsQuery.isError) void projectsQuery.refetch();
      if (procurementQuery.isError) void procurementQuery.refetch();
      if (relatedQuery.isError) void relatedQuery.refetch();
      if (programsQuery.isError) void programsQuery.refetch();
      if (relationshipsQuery.isError) void relationshipsQuery.refetch();
      if (intelligenceQuery.isError) void intelligenceQuery.refetch();
    } else if (section === 'ecosystem') {
      if (contractorsQuery.isError) void contractorsQuery.refetch();
      if (incumbentsQuery.isError) void incumbentsQuery.refetch();
      if (peopleQuery.isError) void peopleQuery.refetch();
      if (intelligenceQuery.isError) void intelligenceQuery.refetch();
    } else {
      if (clientsQuery.isError) void clientsQuery.refetch();
      if (sourcesQuery.isError) void sourcesQuery.refetch();
      if (deltasQuery.isError) void deltasQuery.refetch();
    }
  };

  const exportProfile = () => {
    if (!detail) return;
    downloadCsv(`${detail.peCode}-profile.csv`, [
      ['Field', 'Value'],
      ['Program Element', detail.peCode],
      ['Title', detail.title],
      ['Service', detail.service],
      ['Appropriation', detail.appropriationType],
      ['Budget activity', detail.budgetActivity],
      ['Current FY', latest?.fy],
      ['Current stage', latest ? STAGE_LABEL[latest.current.stage] : null],
      ['Current amount ($M)', current],
      ['Request ($M)', request],
      ['Delta vs request (%)', deltaPct],
      ['Bills touching', detail.billCount ?? bills.length],
      ['Sources', detail.sourceCount],
      ['Projects', detail.projectCount],
      ['Verified', detail.lastSyncedAt],
    ]);
  };

  return {
    code,
    navigate,
    watch,
    section,
    setActiveSection,
    alertsOpen,
    setAlertsOpen,
    exportOpen,
    setExportOpen,
    dataIssueOpen,
    setDataIssueOpen,
    linkTarget,
    setLinkTarget,
    detailQuery,
    billsQuery,
    billActionsQuery,
    budgetActionsQuery,
    peopleQuery,
    clientsQuery,
    deltasQuery,
    narrativeQuery,
    projectsQuery,
    procurementQuery,
    relatedQuery,
    programsQuery,
    relationshipsQuery,
    provisionsQuery,
    opportunitiesQuery,
    contractorsQuery,
    incumbentsQuery,
    intelligenceQuery,
    sourcesQuery,
    actionCardsQuery,
    detail,
    funding,
    latest,
    latestRequest,
    current,
    request,
    deltaPct,
    bills,
    billsWithActions,
    signals,
    people,
    clients,
    openActions,
    raw,
    pdoc,
    latestRecordFy,
    historical,
    lineType,
    signalLabel,
    partial,
    retryFailed,
    exportProfile,
  };
}

export type ProgramElementProfileFinalVm = ReturnType<
  typeof useProgramElementProfileFinal
>;
