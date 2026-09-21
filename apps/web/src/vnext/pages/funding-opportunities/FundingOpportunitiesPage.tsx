import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

import type {
  OpportunitySearchCriteriaV2,
  OpportunitySearchResponseV2,
  OpportunitySourceV2,
  OpportunitySourceFreshnessV2,
  OpportunityQueryMatchV2,
} from '@capiro/shared';
import { MAX_OPPORTUNITY_KEYWORD_TERMS } from '@capiro/shared';
import { DashboardIcon } from '../../components/untitledui/dashboard-icons.js';
import { CapiroButton } from '../../components/actions/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { useApi } from '../../../lib/use-api.js';
import { useMe } from '../../../lib/me.js';
import { useTenantMembers, type TenantMember } from '../../../pages/strategy/members.js';

import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import { FUNDING_OPPORTUNITIES_FEATURE } from './funding-opportunities-domain.js';
import { FundingOpportunityPipeline } from './FundingOpportunityPipeline.js';
import { createFundingOpportunityV2Api } from './FundingOpportunitiesV2Adapter.js';
import { FundingOpportunitiesV2SavedSearches } from './FundingOpportunitiesV2SavedSearches.js';
import { FundingOpportunitiesV2ClientModal } from './FundingOpportunitiesV2ClientModal.js';
import {
  FundingOpportunityV2ResultCard,
  type FundingOpportunityResultRow,
  type OpportunityMenuAction,
} from './FundingOpportunityV2ResultCard.js';
import { FundingOpportunityV2ExternalConfirmation } from './FundingOpportunityV2ExternalConfirmation.js';
import { FundingOpportunityV2NotFitDialog } from './FundingOpportunityV2NotFitDialog.js';
import { FundingOpportunityV2Detail } from './FundingOpportunityV2Detail.js';
import {
  FundingOpportunityV2QuickPanel,
  FundingOpportunityV2QuickDetailsQuery,
} from './FundingOpportunityV2QuickPanel.js';
import {
  FundingOpportunityV2WorkflowDialog,
  type FundingOpportunityWorkflowDialogAction,
  type FundingOpportunityWorkflowMember,
  type FundingOpportunityWorkflowPatch,
} from './FundingOpportunityV2WorkflowDialog.js';
import { FundingOpportunityV2Icon } from './funding-opportunities-v2-icons.js';
import {
  buildFundingOpportunityV2DetailModel,
  normalizeFundingOpportunityV2Detail,
} from './funding-opportunities-v2-detail-types.js';
import { opportunityQueryKeys, refreshOpportunityQueries } from './opportunity-query-cache.js';
import { FUNDING_CLIENT_PICKER_EVENT } from './funding-client-picker-seam.js';
import {
  DEFAULT_V2_CRITERIA,
  LIFECYCLE_OPTIONS,
  PAGE_SIZES,
  SORT_OPTIONS,
  SOURCE_OPTIONS,
  TYPE_OPTIONS,
  V2_FILTER_GROUPS,
  CONTRACT_TYPE_VALUES,
  type V2FilterGroup,
  criteriaFromSearchParams,
  criteriaToSearchParams,
  updateCriteria,
} from './funding-opportunities-v2-state.js';
import { clientProfileKeywordGroups, type ClientProfileKeywordSource, type CapabilityKeywordSource } from './client-profile-keywords.js';
import './funding-opportunities-v2.css';

type ClientLite = { id: string; name: string; status?: string; meta?: string };
type ClientMatchCount = { clientId: string; total: number | null };
type OpportunityRecord = FundingOpportunityResultRow;
type V2Response = Omit<OpportunitySearchResponseV2, 'opportunities'> & {
  opportunities: OpportunityRecord[];
};
type EditorGroup =
  | 'lifecycle'
  | 'types'
  | 'client'
  | 'sector'
  | 'agency'
  | 'deadline'
  | 'eligibility';
type Overlay = 'filters' | 'health' | 'saved' | 'save' | 'quick' | null;

const EMPTY_RESPONSE: V2Response = {
  criteria: DEFAULT_V2_CRITERIA,
  opportunities: [],
  page: 1,
  pageSize: 20,
  total: null,
  totalIsCapped: false,
  catalogComplete: false,
  counts: { grants: null, contracts: null, active: null, closed: null },
  mode: 'matched',
  clientId: null,
  freshness: [],
  provenance: [],
  emptyReason: null,
  generatedAt: '',
  profileGaps: null,
};
const Icon = ({
  name,
  size = 18,
}: {
  name: 'SearchLg' | 'Users01' | 'Bookmark' | 'BookmarkCheck' | 'XClose' | 'LinkExternal01';
  size?: number;
}) => <DashboardIcon name={name} size={size} />;

function semanticCriteria(criteria: OpportunitySearchCriteriaV2): string {
  const value = { ...criteria, page: 1 } as Record<string, unknown>;
  for (const key of Object.keys(value))
    if (Array.isArray(value[key])) value[key] = [...(value[key] as unknown[])].map(String).sort();
  return JSON.stringify(value, Object.keys(value).sort());
}

export function mergeKeywordTerms(existing: readonly string[], incoming: readonly string[]): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...existing, ...incoming]) {
    const term = raw.trim().replace(/\s+/g, ' ');
    const key = term.toLocaleLowerCase();
    if (!term || term.length > 120 || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length === MAX_OPPORTUNITY_KEYWORD_TERMS) break;
  }
  return terms;
}

export function FundingOpportunitiesPage() {
  const flag = useIntelFeature(FUNDING_OPPORTUNITIES_FEATURE);
  const me = useMe();
  const api = useApi();
  const v2 = createFundingOpportunityV2Api(api);
  const queryClient = useQueryClient();
  const toast = useCapiroToast();
  const location = useLocation();
  const navigate = useNavigate();
  const routeParams = useParams<{ source?: string; sourceRecordId?: string }>();
  const routeCriteria = useMemo(
    () => criteriaFromSearchParams(new URLSearchParams(location.search)),
    [location.search],
  );
  const routeParamsFromUrl = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const routeTab = routeParamsFromUrl.get('tab') === 'pursuit' ? 'pursuit' : 'opportunities';
  const routeBoard = routeParamsFromUrl.get('board') === 'list' ? 'list' : 'board';
  const routeSavedSearchId = routeParamsFromUrl.get('savedSearchId');

  const isDetailRoute = Boolean(routeParams.source && routeParams.sourceRecordId);
  const routeSyncRef = useRef<string | null>(null);
  const [criteria, setCriteria] = useState<OpportunitySearchCriteriaV2>(routeCriteria);
  const criteriaRef = useRef(criteria);
  criteriaRef.current = criteria;
  const [queryInput, setQueryInput] = useState(criteria.query);
  const [keywordDraft, setKeywordDraft] = useState('');
  const [importingKeywords, setImportingKeywords] = useState(false);
  const [queryMatch, setQueryMatch] = useState<OpportunityQueryMatchV2>(
    routeCriteria.queryMatch ?? (routeCriteria.query ? 'phrase' : 'keywords'),
  );
  const [tab, setTab] = useState<'opportunities' | 'pursuit'>(routeTab);
  const [boardView, setBoardView] = useState<'board' | 'list'>(routeBoard);
  const [savedSearchId, setSavedSearchId] = useState<string | null>(routeSavedSearchId);

  const [overlay, setOverlay] = useState<Overlay>(null);
  const [saveFromSaved, setSaveFromSaved] = useState(false);
  const [editor, setEditor] = useState<EditorGroup | null>(null);
  const [selectedRow, setSelectedRow] = useState<OpportunityRecord | null>(null);
  const [notFitOpen, setNotFitOpen] = useState(false);
  const [notFitBusy, setNotFitBusy] = useState(false);
  const [notFitError, setNotFitError] = useState<string | null>(null);
  const [externalDestination, setExternalDestination] = useState<{
    row: OpportunityRecord;
    url: string;
    kind: string;
  } | null>(null);
  const [workflowDialog, setWorkflowDialog] = useState<{
    row: OpportunityRecord;
    action: FundingOpportunityWorkflowDialogAction;
  } | null>(null);
  const [workflowBusy, setWorkflowBusy] = useState(false);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [pendingClientAction, setPendingClientAction] = useState<{
    row: OpportunityRecord;
    kind: 'pursue' | 'menu';
    action?: OpportunityMenuAction;
  } | null>(null);

  const [previousFocus, setPreviousFocus] = useState<HTMLElement | null>(null);
  const [clientModal, setClientModal] = useState(false);
  const workflowTriggerRef = useRef<HTMLElement | null>(null);
  const {
    data: tenantMembers = [],
    isLoading: tenantMembersLoading,
    isError: tenantMembersError,
    refetch: refetchTenantMembers,
  } = useTenantMembers();

  useEffect(() => {
    setCriteria(routeCriteria);
    setQueryInput(routeCriteria.query);
    setKeywordDraft('');
    setQueryMatch(routeCriteria.queryMatch ?? (routeCriteria.query ? 'phrase' : 'keywords'));
    setTab(routeTab);
    setBoardView(routeBoard);
    setSavedSearchId(routeSavedSearchId);
    routeSyncRef.current = location.search;
  }, [location.search, routeCriteria, routeTab, routeBoard, routeSavedSearchId]);
  useEffect(() => {
    const onOpenClientPicker = () => openClientPicker();
    window.addEventListener(FUNDING_CLIENT_PICKER_EVENT, onOpenClientPicker);
    return () => window.removeEventListener(FUNDING_CLIENT_PICKER_EVENT, onOpenClientPicker);
  }, []);

  const clients = useQuery<ClientLite[]>({
    queryKey: opportunityQueryKeys.clients,
    queryFn: async () => (await api.get<ClientLite[]>('/api/clients')).data,
    enabled: flag.ready && flag.enabled,
    staleTime: 60_000,
    retry: false,
  });
  const clientOptions = clients.data?.filter((item) => item.status !== 'archived') ?? [];
  const clientName = clientOptions.find((item) => item.id === criteria.clientId)?.name;

  const search = useQuery<V2Response>({
    queryKey: opportunityQueryKeys.search(criteria),
    queryFn: ({ signal }) => v2.search(criteria, signal) as Promise<V2Response>,
    enabled: flag.ready && flag.enabled && tab === 'opportunities',
    retry: false,
    staleTime: 30_000,
  });
  useEffect(() => {
    if (isDetailRoute || !location.state || typeof location.state !== 'object' || !search.data)
      return;
    const scrollY = (location.state as { fundingOpportunitiesScrollY?: unknown })
      .fundingOpportunitiesScrollY;
    if (typeof scrollY !== 'number') return;
    const frame = requestAnimationFrame(() => window.scrollTo({ top: scrollY, behavior: 'auto' }));
    return () => cancelAnimationFrame(frame);
  }, [isDetailRoute, location.state, search.data]);
  const saved = useQuery({
    queryKey: opportunityQueryKeys.savedSearches(criteria.clientId),
    queryFn: () => v2.listSavedSearches(criteria.clientId),
    enabled: flag.ready && flag.enabled,
    retry: false,
  });
  const sourceHealth = useQuery({
    queryKey: opportunityQueryKeys.sourceHealth,
    queryFn: () => v2.sourceHealth(),
    enabled: flag.ready && flag.enabled,
    retry: false,
    staleTime: 30_000,
  });
  const pursuitCount = useQuery({
    queryKey: opportunityQueryKeys.pipeline(criteria.clientId),
    queryFn: async () =>
      (
        await api.get<{
          summary?: { inPipeline: number | null };
          counts: { stages: Array<{ count: number }> };
        }>(`/api/intelligence/clients/${encodeURIComponent(criteria.clientId!)}/pipeline`)
      ).data,
    enabled: flag.ready && flag.enabled && Boolean(criteria.clientId),
    retry: false,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (routeSyncRef.current === location.search) {
      routeSyncRef.current = null;
      return;
    }
    const params = criteriaToSearchParams(criteria);
    if (tab === 'pursuit') params.set('tab', 'pursuit');
    else params.delete('tab');
    if (routeParamsFromUrl.get('board') === 'list') params.set('board', 'list');
    if (savedSearchId) params.set('savedSearchId', savedSearchId);
    else params.delete('savedSearchId');
    const search = `?${params.toString()}`;
    if (location.search !== search) navigate({ search }, { state: location.state });
  }, [criteria, tab, savedSearchId, location.search, navigate]);

  const activeSaved = savedSearchId
    ? saved.data?.searches.find(
        (item) =>
          item.id === savedSearchId &&
          (item.clientId === criteria.clientId || item.clientId === null),
      )
    : undefined;
  useEffect(() => {
    if (!savedSearchId || !saved.data || activeSaved) return;
    setSavedSearchId(null);
    const params = new URLSearchParams(location.search);
    params.delete('savedSearchId');
    routeSyncRef.current = null;
    navigate({ search: `?${params.toString()}` }, { replace: true, state: location.state });
  }, [activeSaved, saved.data, savedSearchId, location.search, location.state, navigate]);

  useEffect(() => {
    if (isDetailRoute || !location.state || typeof location.state !== 'object') return;
    const scrollY = (location.state as { fundingOpportunitiesScrollY?: unknown })
      .fundingOpportunitiesScrollY;
    if (typeof scrollY !== 'number') return;
    requestAnimationFrame(() => window.scrollTo({ top: scrollY, behavior: 'auto' }));
  }, [isDetailRoute, location.state]);
  useEffect(() => {
    if (!overlay && !editor && !clientModal) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        clientModal ||
        event.defaultPrevented ||
        (event.target instanceof Element &&
          event.target.closest('[data-saved-search-nested="true"]'))
      )
        return;
      if (event.key === 'Escape') {
        setOverlay(null);
        setEditor(null);
        setClientModal(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const root = document.querySelector<HTMLElement>('[data-fo-overlay="true"]');
      const nodes = root
        ? [...root.querySelectorAll<HTMLElement>('button,input,select,textarea,[href]')].filter(
            (item) => !item.hasAttribute('disabled'),
          )
        : [];
      if (!nodes.length) return;
      if (event.shiftKey && document.activeElement === nodes[0]) {
        event.preventDefault();
        nodes.at(-1)?.focus();
      }
      if (!event.shiftKey && document.activeElement === nodes.at(-1)) {
        event.preventDefault();
        nodes[0]?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [overlay, editor, clientModal]);
  useEffect(() => {
    if (!overlay && !editor && !clientModal) previousFocus?.focus();
  }, [overlay, editor, clientModal, previousFocus]);

  function openOverlay(next: Overlay) {
    setPreviousFocus(document.activeElement as HTMLElement);
    setOverlay(next);
  }
  function patch(patch: Partial<OpportunitySearchCriteriaV2>, resetPage = true) {
    setCriteria((current) =>
      updateCriteria(current, { ...patch, ...(resetPage ? { page: 1 } : {}) }),
    );
  }
  function toggle(key: keyof OpportunitySearchCriteriaV2, value: string) {
    setCriteria((current) => {
      if (key === 'eligibility')
        return updateCriteria(current, {
          eligibility: [value as OpportunitySearchCriteriaV2['eligibility'][number]],
        });
      if (key === 'agencies' && value === 'any') return updateCriteria(current, { agencies: [] });
      const currentValues = Array.isArray(current[key]) ? (current[key] as string[]) : [];
      const next = currentValues.includes(value)
        ? currentValues.filter((item) => item !== value)
        : [...currentValues.filter((item) => !(key === 'agencies' && item === 'any')), value];
      return updateCriteria(current, { [key]: next } as Partial<OpportunitySearchCriteriaV2>);
    });
  }
  function updateKeyword(value: string) {
    setQueryInput(value);
  }
  function commitKeyword() {
    patch({ query: queryInput, queryMatch });
  }
  function addKeywords() {
    const incoming = keywordDraft.split(/[,\n]+/).map((term) => term.trim()).filter(Boolean);
    if (!incoming.length) return;
    if (incoming.some((term) => term.length > 120)) {
      toast.error('Each keyword or phrase must be 120 characters or fewer.');
      return;
    }
    const existing = criteria.keywordTerms ?? [];
    const next = mergeKeywordTerms(existing, incoming);
    if (next.length === existing.length) {
      toast.error('These keywords are already in the search.');
      return;
    }
    if (next.length < new Set([...existing, ...incoming].map((term) => term.toLocaleLowerCase())).size)
      toast.error(`Only the first ${MAX_OPPORTUNITY_KEYWORD_TERMS} unique keywords were added.`);
    patch({ keywordTerms: next });
    setKeywordDraft('');
  }
  async function importClientKeywords() {
    if (!criteria.clientId || importingKeywords) return;
    const clientId = criteria.clientId;
    setImportingKeywords(true);
    try {
      const encoded = encodeURIComponent(clientId);
      const [clientResponse, capabilitiesResponse] = await Promise.all([
        api.get<ClientProfileKeywordSource>(`/api/clients/${encoded}`),
        api.get<CapabilityKeywordSource[]>(`/api/clients/${encoded}/capabilities`),
      ]);
      if (clientId !== criteriaRef.current.clientId) return;
      const groups = clientProfileKeywordGroups(clientResponse.data, capabilitiesResponse.data);
      const incoming = groups.flatMap((group) => group.terms);
      if (!incoming.length) {
        toast.error('This client profile has no saved tags to import.');
        return;
      }
      const existing = criteriaRef.current.keywordTerms ?? [];
      const next = mergeKeywordTerms(existing, incoming);
      const added = next.length - existing.length;
      if (!added) {
        toast.error('All client profile tags are already in the search.');
        return;
      }
      patch({ keywordTerms: next });
      toast.success(`Imported ${added} keyword${added === 1 ? '' : 's'} from ${groups.length} client profile ${groups.length === 1 ? 'section' : 'sections'}.`);
      if (next.length < new Set([...existing, ...incoming].map((term) => term.toLocaleLowerCase())).size)
        toast.error(`Only the first ${MAX_OPPORTUNITY_KEYWORD_TERMS} unique keywords were added.`);
    } catch {
      toast.error('Client profile keywords could not be imported.');
    } finally {
      setImportingKeywords(false);
    }
  }
  function changeQueryMatch(next: OpportunityQueryMatchV2) {
    setQueryMatch(next);
  }
  function clearAll() {
    patch({
      query: '',
      keywordTerms: [],
      sources: [],
      types: [],
      lifecycle: [],
      agencies: [],
      sectors: [],
      naicsCodes: [],
      pscCodes: [],
      setAsideCodes: [],
      eligibility: [],
      posted: [],
      geography: [],
      applicantTypes: [],
      funding: [],
      costShare: [],
      methods: [],
      disbursement: [],
      grantPrerequisites: [],
      codes: [],
      deadlineWindow: 'any',
      deadlineFrom: null,
      deadlineTo: null,
    });
    setQueryInput('');
  }
  function openEditor(group: EditorGroup) {
    if (group === 'client') {
      openClientPicker();
      return;
    }
    setPreviousFocus(document.activeElement as HTMLElement);
    setEditor(group);
    setOverlay(null);
  }
  function openClientPicker() {
    setPreviousFocus(document.activeElement as HTMLElement);
    workflowTriggerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : workflowTriggerRef.current;
    setEditor(null);
    setOverlay((current) => (current === 'quick' ? current : null));
    setClientModal(true);
  }
  function switchMode(mode: 'matched' | 'all') {
    if (mode === 'matched' && !criteria.clientId) {
      setClientModal(true);
      setPreviousFocus(document.activeElement as HTMLElement);
      return;
    }
    patch({ mode });
  }
  function applySavedCriteria(next: OpportunitySearchCriteriaV2) {
    setCriteria(next);
    setQueryInput(next.query);
    setKeywordDraft('');
    setQueryMatch(next.queryMatch ?? (next.query ? 'phrase' : 'keywords'));
  }
  function openDetail(row: OpportunityRecord) {
    const originState = {
      ...(location.state && typeof location.state === 'object' ? location.state : {}),
      fundingOpportunitiesOrigin: true,
      fundingOpportunitiesScrollY: window.scrollY,
    };
    navigate(location.pathname + location.search, { replace: true, state: originState });
    navigate(
      `/intelligence/opportunities/${row.source}/${encodeURIComponent(row.sourceRecordId)}${location.search}`,
      { state: originState },
    );
  }

  async function workflow(
    row: OpportunityRecord,
    intent: 'saved' | 'pursuing',
    toggleSaved = true,
  ): Promise<void> {
    try {
      if (intent === 'saved') {
        const input = {
          clientId: row.clientId ?? null,
          source: row.source,
          sourceRecordId: row.sourceRecordId,
        };
        if (toggleSaved && (row.decoration?.bookmark.saved ?? row.workflow?.saved))
          await v2.unsaveOpportunity(input);
        else await v2.saveOpportunity(input);
      } else {
        if (!row.clientId) {
          setSelectedRow(row);
          setPendingClientAction({ row, kind: 'pursue' });
          openClientPicker();
          return;
        }
        await api.post(
          `/api/intelligence/clients/${encodeURIComponent(row.clientId)}/opportunities/${row.source}/${encodeURIComponent(row.sourceRecordId)}/action`,
          { intent: 'pursuit' },
        );
      }
      await refreshOpportunityQueries(queryClient, row.clientId);
      toast.success(
        intent === 'saved'
          ? toggleSaved && (row.decoration?.bookmark.saved ?? row.workflow?.saved)
            ? 'Removed from saved opportunities.'
            : row.clientId
              ? 'Saved to the client workspace.'
              : 'Saved to this workspace.'
          : 'Marked pursuing.',
      );
    } catch {
      toast.error(
        `The opportunity could not be marked ${intent === 'saved' ? 'saved' : 'pursuing'}.`,
      );
    }
  }
  function openNotFit(row: OpportunityRecord, trigger?: HTMLElement) {
    workflowTriggerRef.current =
      trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setSelectedRow(row);
    setNotFitError(null);
    setNotFitOpen(true);
  }
  async function submitNotFit(input: {
    clientId: string;
    source: string;
    sourceRecordId: string;
    reason: string;
    note: string | null;
  }) {
    setNotFitBusy(true);
    setNotFitError(null);
    try {
      await v2.recordNotFit({
        clientId: input.clientId,
        source: input.source as OpportunitySourceV2,
        sourceRecordId: input.sourceRecordId,
        reason: input.reason,
        note: input.note,
      });
      await refreshOpportunityQueries(queryClient, input.clientId);
      setNotFitOpen(false);
    } catch {
      setNotFitError('The reason could not be recorded. Nothing was changed.');
    } finally {
      setNotFitBusy(false);
    }
  }
  async function menuAction(
    row: OpportunityRecord,
    action: OpportunityMenuAction,
    trigger?: HTMLElement,
  ) {
    workflowTriggerRef.current = trigger ?? workflowTriggerRef.current;
    if (action === 'copy_link') {
      try {
        await navigator.clipboard.writeText(
          `${window.location.origin}/intelligence/opportunities/${row.source}/${encodeURIComponent(row.sourceRecordId)}${location.search}`,
        );
        toast.success('Link copied. Private notes are never included.');
      } catch {
        toast.error('The shareable link could not be copied.');
      }
      return;
    }
    if (!row.clientId) {
      setSelectedRow(row);
      setPendingClientAction({ row, kind: 'menu', action });
      openClientPicker();
      return;
    }
    if (action === 'follow_up' || action === 'assign_owner' || action === 'note') {
      setSelectedRow(row);
      setWorkflowError(null);
      setWorkflowDialog({ row, action });
    }
  }
  async function submitWorkflowPatch(patch: FundingOpportunityWorkflowPatch) {
    if (!workflowDialog?.row.clientId || workflowBusy) return;
    setWorkflowBusy(true);
    setWorkflowError(null);
    try {
      await v2.patchWorkflow({
        clientId: workflowDialog.row.clientId,
        source: workflowDialog.row.source,
        sourceRecordId: workflowDialog.row.sourceRecordId,
        patch,
      });
      await refreshOpportunityQueries(queryClient, workflowDialog.row.clientId);
      setWorkflowDialog(null);
    } catch {
      setWorkflowError('The workflow update could not be saved. Nothing was changed.');
    } finally {
      setWorkflowBusy(false);
    }
  }

  if (!flag.ready)
    return (
      <div className="fo-v2-loading" aria-busy="true">
        Loading Opportunities…
      </div>
    );
  if (!flag.enabled)
    return (
      <div className="fo-v2-empty">
        <h1>Opportunities</h1>
        <p>Funding Opportunities is not enabled for this workspace.</p>
      </div>
    );
  if (
    isDetailRoute &&
    !['grants_gov', 'sam_gov', 'agency_forecast', 'dibbs', 'sbir_sttr', 'ca_portal'].includes(
      routeParams.source!,
    )
  ) {
    return (
      <div className="fo-module fo-module--v2" data-testid="fo-v2">
        <DestinationRow navigate={navigate} />
        <section className="fo-v2-error">
          <h2>That opportunity link is not valid</h2>
          <p>The source in this link is not a catalog source Capiro currently supports.</p>
          <CapiroButton variant="secondary" onClick={() => navigate('/intelligence/opportunities')}>
            Back to Opportunities
          </CapiroButton>
        </section>
      </div>
    );
  }
  const result = search.data ?? EMPTY_RESPONSE;
  const knownMatchedCount: ClientMatchCount | null =
    search.isSuccess &&
    search.data &&
    criteria.mode === 'matched' &&
    criteria.clientId != null &&
    search.data.mode === 'matched' &&
    search.data.clientId === criteria.clientId &&
    semanticCriteria(search.data.criteria) === semanticCriteria(criteria) &&
    search.data.total != null
      ? { clientId: criteria.clientId, total: search.data.total }
      : null;

  if (isDetailRoute) {
    const hasOrigin = Boolean(
      location.state &&
      typeof location.state === 'object' &&
      (location.state as { fundingOpportunitiesOrigin?: boolean }).fundingOpportunitiesOrigin,
    );
    const detailBack = () =>
      hasOrigin
        ? navigate(-1)
        : navigate(`/intelligence/opportunities${location.search}`, { replace: true });
    return (
      <div className="fo-module fo-module--v2" data-testid="fo-v2">
        <DestinationRow navigate={navigate} onHealth={() => openOverlay('health')} />
        <V2DetailRoute
          api={v2}
          source={routeParams.source! as OpportunitySourceV2}
          sourceRecordId={routeParams.sourceRecordId!}
          criteria={criteria}
          clientName={clientName}
          onBack={detailBack}
          onChooseClient={openClientPicker}
          onAction={(event) => {
            if ((event.action === 'save' || event.action === 'pursue') && event.row)
              return workflow(
                event.row,
                event.action === 'save' ? 'saved' : 'pursuing',
                event.action === 'save' ? false : true,
              );
          }}
          onSaveSearch={() => setOverlay('save')}
          sourceHealth={sourceHealth.isSuccess ? (sourceHealth.data?.sources ?? []) : []}
          onSimilar={(row) => {
            navigate(
              `/intelligence/opportunities/${row.source}/${encodeURIComponent(row.sourceRecordId)}${location.search}`,
              { state: location.state },
            );
          }}
        />
        <FundingOpportunitiesV2SavedSearches
          api={v2}
          criteria={criteria}
          clientName={clientName}
          clients={clientOptions}
          currentUserId={me.data?.user.id}
          currentUserRole={me.data?.role}
          searches={saved.data?.searches ?? []}
          loading={saved.isLoading}
          error={saved.isError}
          open={false}
          saveOpen={overlay === 'save'}
          onClose={(keepParent?: boolean) => {
            if (keepParent && saveFromSaved) setOverlay('saved');
            else {
              setSaveFromSaved(false);
              setOverlay(null);
            }
          }}
          onOpenSave={(fromSaved) => {
            setSaveFromSaved(Boolean(fromSaved));
            setOverlay('save');
          }}
          onSaved={async () => {
            await queryClient.invalidateQueries({
              queryKey: opportunityQueryKeys.savedSearches(criteria.clientId),
            });
          }}
          onApplyCriteria={(next, response, appliedId) => {
            setSavedSearchId(appliedId ?? null);
            applySavedCriteria(next);
            if (response) queryClient.setQueryData(opportunityQueryKeys.search(next), response);
            setOverlay(null);
          }}
          onApplyAndRefresh={async (next, response, appliedId) => {
            setSavedSearchId(appliedId ?? null);
            applySavedCriteria(next);
            if (response) queryClient.setQueryData(opportunityQueryKeys.search(next), response);
            setOverlay(null);
            await queryClient.invalidateQueries({ queryKey: opportunityQueryKeys.search(next) });
          }}
          onToast={(kind, message) =>
            kind === 'success' ? toast.success(message) : toast.error(message)
          }
        />
        {clientModal ? (
          <FundingOpportunitiesV2ClientModal
            clients={clientOptions}
            selected={criteria.clientId}
            matchedCount={knownMatchedCount}
            returnFocusRef={workflowTriggerRef}
            onClose={() => setClientModal(false)}
            onChoose={(clientId) => {
              setQueryInput('');
              setKeywordDraft('');
              patch({ clientId, query: '', keywordTerms: [], mode: clientId ? criteria.mode : 'all' });
              setClientModal(false);
            }}
          />
        ) : null}
        {overlay === 'health' ? (
          <HealthDrawer
            freshness={sourceHealth.data?.sources ?? []}
            provenance={[]}
            loading={sourceHealth.isLoading}
            error={sourceHealth.isError}
            onClose={() => setOverlay(null)}
          />
        ) : null}
      </div>
    );
  }
  const sourceWarnings = result.freshness.filter(
    (item) => item.state !== 'current' && item.state !== 'not_enabled',
  );
  const activeFilters = filterChips(criteria, clientName);
  const savedCriteriaChanged = activeSaved
    ? semanticCriteria(activeSaved.criteria) !== semanticCriteria(criteria)
    : false;
  const enabledHealthSources =
    sourceHealth.data?.sources.filter((item) => item.state !== 'not_enabled') ?? [];
  const currentHealthSources = enabledHealthSources.filter((item) => item.state === 'current');
  const freshnessTimestamp = result.freshness.find(
    (item) => item.state === 'current',
  )?.lastSyncedAt;
  const freshnessText = freshnessTimestamp
    ? `Updated ${relativeSourceTime(freshnessTimestamp)} · ${formatCount(result.counts.active)} active records in scope`
    : 'Freshness unavailable';
  const healthTone = sourceHealth.isLoading
    ? 'loading'
    : sourceHealth.isError || !enabledHealthSources.length
      ? 'error'
      : currentHealthSources.length === enabledHealthSources.length
        ? 'current'
        : 'warning';
  const healthLabel = sourceHealth.isLoading
    ? 'SOURCE HEALTH LOADING'
    : sourceHealth.isError
      ? 'SOURCE HEALTH UNAVAILABLE'
      : !enabledHealthSources.length
        ? 'SOURCE HEALTH UNAVAILABLE'
        : `${currentHealthSources.length} OF ${enabledHealthSources.length} SOURCES CURRENT`;
  async function copyShareableUrl() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(window.location.href);
      toast.success('Shareable link copied.');
    } catch {
      toast.error('The shareable link could not be copied.');
    }
  }
  const error = search.isError;

  return (
    <div className="fo-module fo-module--v2" data-testid="fo-v2">
      <nav className="fo-v2-destination-row" aria-label="Intelligence destinations">
        <span>Intelligence</span>
        <button type="button" onClick={() => navigate('/explorer')}>
          Data Explorer
        </button>
        <button type="button" onClick={() => navigate('/legiwatch')}>
          LegiWatch
        </button>
        <button type="button" onClick={() => navigate('/program-elements')}>
          Program Elements
        </button>
        <button type="button" className="is-active" aria-current="page">
          Funding Opportunities
        </button>
        <span className="fo-v2-destination-spacer" />
        <button
          type="button"
          className="fo-v2-destination-health"
          onClick={() => openOverlay('health')}
        >
          <i />
          Source health
        </button>
      </nav>
      <header className="fo-v2-header">
        <div className="fo-v2-title">
          <span className="fo-module-eyebrow">GRANTS AND CONTRACTS</span>
          <h1>Opportunities</h1>
          <p>
            {tab === 'pursuit'
              ? `Stage, owner and next action for every grant and contract this workspace is pursuing${clientName ? ` for ${clientName}` : ''}. Stage moves are audited, and terminal stages are final.`
              : criteria.mode === 'matched' && clientName
                ? `Ranked against ${clientName} with the evidence behind each band shown in the list. Switch to all opportunities to browse the unscoped catalog without losing this client.`
                : criteria.clientId
                  ? `The unscoped catalog, with ${clientName ?? 'the selected client'} still attached. Ranking and match explanations are suppressed here.`
                  : 'The unscoped catalog of grants and contracts this workspace can read. Select a client to add relevance ranking, match explanations and per-client saved searches.'}
          </p>
        </div>
        <div className="fo-v2-header-actions">
          <div className="fo-v2-header-action-row">
            <button className="fo-v2-header-button" onClick={openClientPicker}>
              <Icon name="Users01" />
              {clientName ?? 'Select a client'}
              <FundingOpportunityV2Icon name="ChevronDown" size={16} color="#667085" />
            </button>
            <button className="fo-v2-header-button" onClick={() => openOverlay('saved')}>
              <Icon name="Bookmark" />
              Saved searches <b>{saved.data?.searches.length ?? '?'}</b>
            </button>
          </div>
          <button
            className={`fo-v2-health-pill fo-v2-health-pill--${healthTone}`}
            onClick={() => openOverlay('health')}
          >
            <i />
            {healthLabel}
          </button>
        </div>
      </header>
      <nav className="fo-v2-tabs" role="tablist" aria-label="Funding Opportunities tabs">
        <button
          role="tab"
          aria-selected={tab === 'opportunities'}
          onClick={() => {
            setTab('opportunities');
          }}
        >
          Opportunities
        </button>
        <button
          role="tab"
          aria-selected={tab === 'pursuit'}
          onClick={() => {
            setTab('pursuit');
          }}
        >
          Pursuit{' '}
          <b>
            {pursuitCount.isLoading
              ? '?'
              : (pursuitCount.data?.summary?.inPipeline ??
                (pursuitCount.data
                  ? pursuitCount.data.counts.stages.reduce((sum, stage) => sum + stage.count, 0)
                  : '?'))}
          </b>
        </button>
      </nav>
      {tab === 'pursuit' ? (
        <main className="fo-v2-content">
          <FundingOpportunityPipeline
            clientId={criteria.clientId}
            clientName={clientName}
            view={boardView}
            onOpenTitle={(event) =>
              event.sourceRecordId &&
              navigate(
                `/intelligence/opportunities/${event.source}/${encodeURIComponent(event.sourceRecordId)}${location.search}`,
                {
                  state: {
                    fundingOpportunitiesOrigin: true,
                    fundingOpportunitiesScrollY: window.scrollY,
                  },
                },
              )
            }
            onChooseClient={() => openClientPicker()}
            onViewChange={(view) => {
              setBoardView(view);
              const params = new URLSearchParams(location.search);
              params.set('board', view);
              navigate({ search: `?${params.toString()}` });
            }}
          />
        </main>
      ) : (
        <main className="fo-v2-content">
          {sourceWarnings.length > 0 ? (
            <SourceBanner warnings={sourceWarnings} onOpen={() => openOverlay('health')} />
          ) : null}
          <section className="fo-v2-builder">
            <div className="fo-v2-builder-top">
              <span className="fo-module-eyebrow">SEARCH BUILDER</span>
              <div className="fo-v2-mode">
                <button
                  aria-pressed={criteria.mode === 'matched'}
                  onClick={() => switchMode('matched')}
                >
                  Matched to {clientName ?? 'a client'}
                </button>
                <button aria-pressed={criteria.mode === 'all'} onClick={() => switchMode('all')}>
                  All opportunities
                </button>
              </div>
            </div>
            {editor ? (
              <Editor
                group={editor}
                criteria={criteria}
                clientOptions={clientOptions}
                clientName={clientName}
                onChange={patch}
                onToggle={toggle}
                onClose={() => setEditor(null)}
              />
            ) : null}
            <section
              className="fo-v2-traditional-search"
              aria-labelledby="traditional-search-heading"
            >
              <div className="fo-v2-traditional-search-heading">
                <div>
                  <span className="fo-module-eyebrow">TRADITIONAL SEARCH</span>
                  <h2 id="traditional-search-heading">Search opportunities</h2>
                </div>
              </div>
              <div className="fo-v2-keyword">
                <div className="fo-v2-input">
                  <Icon name="SearchLg" size={20} />
                  <input
                    value={queryInput}
                    onChange={(event) => updateKeyword(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        commitKeyword();
                      }
                    }}
                    placeholder={
                      queryMatch === 'phrase'
                        ? 'Exact phrase, for example “autonomous vehicle”'
                        : 'Keywords, for example autonomous vehicle'
                    }
                    aria-label="Keyword search"
                    maxLength={512}
                  />
                  {queryInput ? (
                    <button
                      type="button"
                      aria-label="Clear keyword"
                      onClick={() => {
                        setQueryInput('');
                        patch({ query: '' });
                      }}
                    >
                      <Icon name="XClose" size={16} />
                    </button>
                  ) : null}
                </div>
                <select
                  aria-label="Search mode"
                  value={queryMatch}
                  onChange={(event) =>
                    changeQueryMatch(event.target.value as OpportunityQueryMatchV2)
                  }
                >
                  <option value="keywords">Keywords</option>
                  <option value="phrase">Exact phrase</option>
                </select>
                <CapiroButton variant="primary" onClick={commitKeyword}>
                  Search
                </CapiroButton>
                <CapiroButton
                  variant="secondary"
                  onClick={() => {
                    commitKeyword();
                    openOverlay('save');
                  }}
                >
                  <Icon name="Bookmark" size={18} />
                  Save search
                </CapiroButton>
              </div>
              <p className="fo-v2-note">
                Search applies the text above. Add several keywords below to find opportunities matching any of them. An exact phrase above narrows those results.
              </p>
              <div className="fo-v2-keyword-import">
                <label htmlFor="fo-v2-keyword-draft">Multiple keywords or phrases</label>
                <div className="fo-v2-keyword-import-row">
                  <input
                    id="fo-v2-keyword-draft"
                    value={keywordDraft}
                    onChange={(event) => setKeywordDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        addKeywords();
                      }
                    }}
                    placeholder="e.g. robotics, battery storage, vehicle sustainment"
                    aria-label="Multiple keywords or phrases"
                  />
                  <CapiroButton variant="secondary" onClick={addKeywords} disabled={!keywordDraft.trim()}>
                    Add keywords
                  </CapiroButton>
                  <CapiroButton variant="secondary" onClick={() => void importClientKeywords()} disabled={!criteria.clientId || importingKeywords}>
                    {importingKeywords ? 'Importing…' : 'Import client profile tags'}
                  </CapiroButton>
                </div>
                <p className="fo-v2-note">Separate entries with commas. Imports sectors, saved tags, capabilities, funding priorities, program elements, and classification codes from the selected client.</p>
                {(criteria.keywordTerms?.length ?? 0) > 0 ? (
                  <div className="fo-v2-keyword-terms" aria-label="Selected keywords">
                    {criteria.keywordTerms?.map((term) => (
                      <span className="fo-v2-keyword-term" key={term}>
                        {term}
                        <button type="button" aria-label={`Remove keyword ${term}`} onClick={() => patch({ keywordTerms: (criteriaRef.current.keywordTerms ?? []).filter((item) => item !== term) })}>
                          <Icon name="XClose" size={14} />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </section>
          </section>
          <Toolbar
            criteria={criteria}
            result={result}
            filters={activeFilters}
            savedLabel={activeSaved?.name}
            savedCriteriaChanged={savedCriteriaChanged}
            onOpenSaved={() => openOverlay('saved')}
            freshnessLine={freshnessText}
            busy={search.isFetching}
            onFilter={() => openOverlay('filters')}
            onRemove={(key, value) => removeCriterion(criteria, key, value, patch)}
            onClear={clearAll}
            onPatch={patch}
          />
          {criteria.mode === 'matched' && criteria.clientId && result.profileGaps ? (
            <ProfileGaps data={result.profileGaps} />
          ) : null}
          {error ? (
            <section className="fo-v2-error">
              <h2>Opportunities could not be loaded</h2>
              <p>The search did not return a successful response. No rows are shown.</p>
              <CapiroButton onClick={() => void search.refetch()}>Retry</CapiroButton>
            </section>
          ) : result.emptyReason ? (
            <EmptyState
              reason={result.emptyReason}
              onClear={clearAll}
              onWiden={() =>
                patch({ deadlineWindow: '180d', deadlineFrom: null, deadlineTo: null })
              }
            />
          ) : (
            <div className="fo-v2-results">
              {result.opportunities.map((row) => (
                <FundingOpportunityV2ResultCard
                  key={row.id}
                  row={row}
                  clientName={clientName}
                  matched={criteria.mode === 'matched'}
                  onOpenDetail={() => openDetail(row)}
                  onQuick={() => {
                    setSelectedRow(row);
                    openOverlay('quick');
                  }}
                  onExternal={() => {
                    setExternalDestination({
                      row,
                      url: row.sourceUrl ?? '',
                      kind: 'source_page',
                    });
                  }}
                  onClient={openClientPicker}
                  onNotFit={(trigger) => openNotFit(row, trigger)}
                  onMenuAction={(action, trigger) => menuAction(row, action, trigger)}
                  onAction={(action) => workflow(row, action === 'save' ? 'saved' : 'pursuing')}
                />
              ))}
            </div>
          )}
          <Pagination criteria={criteria} total={result.total} onPatch={patch} />
          <footer className="fo-v2-footnotes">
            <p>
              Source freshness is shown per source, with degraded completeness called out when a
              source cannot provide a complete catalog.
            </p>
            <p>
              Counts describe records this workspace can read. Criteria are stored as typed fields
              per client — keyword query included.
            </p>
            <p>
              Back-navigation returns to this page and scroll position. The URL below is the
              shareable v2 state.
            </p>
            <div className="fo-v2-share-row">
              <span>SHAREABLE STATE</span>
              <code>{window.location.href}</code>
              <button type="button" onClick={() => void copyShareableUrl()}>
                Copy link
              </button>
            </div>
          </footer>
        </main>
      )}
      {clientModal ? (
        <FundingOpportunitiesV2ClientModal
          clients={clientOptions}
          selected={criteria.clientId}
          matchedCount={knownMatchedCount}
          returnFocusRef={workflowTriggerRef}
          onClose={() => {
            setClientModal(false);
            setPendingClientAction(null);
          }}
          onChoose={(clientId) => {
            patch({ clientId, query: '', keywordTerms: [], mode: clientId ? criteria.mode : 'all' });
            setQueryInput('');
            setKeywordDraft('');
            const pending = pendingClientAction;
            if (selectedRow && clientId) setSelectedRow({ ...selectedRow, clientId });
            setClientModal(false);
            setPendingClientAction(null);
            if (pending && clientId) {
              const nextRow = { ...pending.row, clientId };
              if (pending.kind === 'pursue') void workflow(nextRow, 'pursuing');
              else if (
                pending.action === 'follow_up' ||
                pending.action === 'assign_owner' ||
                pending.action === 'note'
              )
                setWorkflowDialog({ row: nextRow, action: pending.action });
            }
          }}
        />
      ) : null}
      <FundingOpportunitiesV2SavedSearches
        api={v2}
        criteria={criteria}
        activeSavedSearchId={savedSearchId}
        saveOpenedFromSaved={saveFromSaved}
        clientName={clientName}
        clients={clientOptions}
        currentUserId={me.data?.user.id}
        currentUserRole={me.data?.role}
        searches={saved.data?.searches ?? []}
        loading={saved.isLoading}
        error={saved.isError}
        open={overlay === 'saved' || (overlay === 'save' && saveFromSaved)}
        saveOpen={overlay === 'save'}
        onClose={(keepParent?: boolean) => {
          if (keepParent && saveFromSaved) setOverlay('saved');
          else {
            setSaveFromSaved(false);
            setOverlay(null);
          }
        }}
        onOpenSave={(fromSaved) => {
          setSaveFromSaved(Boolean(fromSaved));
          setOverlay('save');
        }}
        onSaved={async () => {
          await queryClient.invalidateQueries({
            queryKey: ['funding-opportunities-v2-saved', criteria.clientId],
          });
        }}
        onApplyCriteria={(next, response, appliedId) => {
          setSavedSearchId(appliedId ?? null);
          applySavedCriteria(next);
          if (response) queryClient.setQueryData(['funding-opportunities-v2', next], response);
          setOverlay(null);
        }}
        onApplyAndRefresh={async (next, response, appliedId) => {
          setSavedSearchId(appliedId ?? null);
          applySavedCriteria(next);
          if (response) queryClient.setQueryData(['funding-opportunities-v2', next], response);
          setOverlay(null);
          await queryClient.invalidateQueries({ queryKey: ['funding-opportunities-v2', next] });
        }}
        onToast={(kind, message) =>
          kind === 'success' ? toast.success(message) : toast.error(message)
        }
      />
      {overlay && overlay !== 'saved' && overlay !== 'save' ? (
        <Overlay
          api={v2}
          type={overlay}
          criteria={criteria}
          clientName={clientName}
          clientOptions={clientOptions}
          result={result}
          selectedRow={selectedRow}
          onClose={() => setOverlay(null)}
          onChooseClient={(clientId) => {
            patch({ clientId, mode: clientId ? criteria.mode : 'all' });
            setOverlay(null);
          }}
          onWorkflow={(intent) => {
            if (selectedRow)
              return workflow(selectedRow, intent, intent === 'saved' ? false : true);
          }}
          onApplyCriteria={(next) => {
            patch(next);
          }}
          onOpenDetail={() => selectedRow && openDetail(selectedRow)}
        />
      ) : null}
      {notFitOpen && selectedRow ? (
        <FundingOpportunityV2NotFitDialog
          title={selectedRow.title}
          clientId={selectedRow.clientId}
          source={selectedRow.source}
          sourceRecordId={selectedRow.sourceRecordId}
          busy={notFitBusy}
          error={notFitError}
          onSubmit={submitNotFit}
          onChooseClient={openClientPicker}
          returnFocusRef={workflowTriggerRef}
          onClose={() => !notFitBusy && setNotFitOpen(false)}
        />
      ) : null}
      {workflowDialog ? (
        <FundingOpportunityV2WorkflowDialog
          row={workflowDialog.row}
          action={workflowDialog.action}
          teamMembers={tenantMembers.map(
            (member: TenantMember): FundingOpportunityWorkflowMember => ({
              userId: member.id,
              email: member.email,
              firstName: member.name,
              lastName: null,
            }),
          )}
          teamMembersLoading={tenantMembersLoading}
          teamMembersError={tenantMembersError}
          onRetryTeamMembers={() => void refetchTenantMembers()}
          returnFocusRef={workflowTriggerRef}
          busy={workflowBusy}
          error={workflowError}
          onSubmit={submitWorkflowPatch}
          onClose={() => !workflowBusy && setWorkflowDialog(null)}
        />
      ) : null}
      {externalDestination?.url ? (
        <FundingOpportunityV2ExternalConfirmation
          destination={{
            kind: externalDestination.kind,
            label: 'Open authoritative source',
            url: externalDestination.url,
            note: 'This link leaves Capiro for the source system. Capiro does not record a submission.',
          }}
          source={externalDestination.row.source}
          sourceRecordId={externalDestination.row.sourceRecordId}
          clientId={externalDestination.row.clientId}
          onExternalAudit={(event) => v2.auditSourceClick(event)}
          onClose={() => setExternalDestination(null)}
        />
      ) : null}
    </div>
  );
}

function DestinationRow({
  navigate,
  onHealth,
}: {
  navigate: ReturnType<typeof useNavigate>;
  onHealth?: () => void;
}) {
  return (
    <nav className="fo-v2-destination-row" aria-label="Intelligence destinations">
      <span>Intelligence</span>
      <button type="button" onClick={() => navigate('/explorer')}>
        Data Explorer
      </button>
      <button type="button" onClick={() => navigate('/legiwatch')}>
        LegiWatch
      </button>
      <button type="button" onClick={() => navigate('/program-elements')}>
        Program Elements
      </button>
      <button type="button" className="is-active" aria-current="page">
        Funding Opportunities
      </button>
      <span className="fo-v2-destination-spacer" />
      {onHealth ? (
        <button type="button" className="fo-v2-destination-health" onClick={onHealth}>
          <i />
          Source health
        </button>
      ) : null}
    </nav>
  );
}
function FilterDrawer({
  criteria,
  result,
  onClose,
  onApplyCriteria,
}: {
  criteria: OpportunitySearchCriteriaV2;
  result: V2Response;
  onClose: () => void;
  onApplyCriteria: (criteria: OpportunitySearchCriteriaV2) => void;
}) {
  const local = criteria;
  function apply(next: OpportunitySearchCriteriaV2) {
    onApplyCriteria(next);
  }
  function toggle(group: V2FilterGroup, value: string) {
    if (group.key === 'deadlineWindow') {
      apply(
        updateCriteria(local, {
          deadlineWindow: value as OpportunitySearchCriteriaV2['deadlineWindow'],
        }),
      );
      return;
    }
    if (group.key === 'lifecycle') {
      const next = local.lifecycle.includes(value as never)
        ? local.lifecycle.filter((item) => item !== value)
        : [...local.lifecycle, value as OpportunitySearchCriteriaV2['lifecycle'][number]];
      apply(updateCriteria(local, { lifecycle: next }));
      return;
    }
    const current = local[group.key] as string[];
    const next =
      group.key === 'agencies' && value === 'any'
        ? []
        : current.includes(value)
          ? current.filter((item) => item !== value)
          : [...current.filter((item) => !(group.key === 'agencies' && item === 'any')), value];
    apply(updateCriteria(local, { [group.key]: next } as Partial<OpportunitySearchCriteriaV2>));
  }
  return (
    <div className="fo-v2-drawer-shell" data-fo-overlay="true" role="presentation">
      <button className="fo-v2-drawer-backdrop" aria-label="Close filters" onClick={onClose} />
      <aside className="fo-v2-filter-drawer" role="dialog" aria-modal="true" aria-label="Filters">
        <header className="fo-v2-overlay-header">
          <div>
            <h2>Filters</h2>
            <p>
              Groups combine with AND. Values inside a group combine with OR. A group that does not
              apply to the current type is marked, never silently dropped.
            </p>
          </div>
          <button className="fo-v2-icon-button" aria-label="Close" onClick={onClose}>
            <Icon name="XClose" size={20} />
          </button>
        </header>
        <div className="fo-v2-filter-scroll">
          {V2_FILTER_GROUPS.map((group) => {
            const selectedTypes = new Set(local.types);
            const grantTypes = new Set(['grant', 'cooperative_agreement', 'loan_assistance']);
            const contractTypes = new Set(CONTRACT_TYPE_VALUES);
            const hasGrantFamily = [...selectedTypes].some((type) => grantTypes.has(type));
            const hasContractFamily = [...selectedTypes].some((type) => contractTypes.has(type));
            const inactive =
              local.types.length > 0 &&
              ((group.only === 'Grants only' && !hasGrantFamily) ||
                (group.only === 'Contracts only' && !hasContractFamily));
            const selected =
              group.key === 'deadlineWindow'
                ? [local.deadlineWindow]
                : group.key === 'lifecycle'
                  ? local.lifecycle
                  : (local[group.key] as string[]);
            const hasSelection =
              selected.length > 0 &&
              !(group.key === 'deadlineWindow' && local.deadlineWindow === 'any');
            return (
              <section
                className={`fo-v2-filter-group ${inactive ? 'is-inapplicable' : ''}`}
                key={group.key}
              >
                <header>
                  <h3>{group.label}</h3>
                  {group.only ? <span>{group.only}</span> : null}
                  {hasSelection ? (
                    <button
                      onClick={() =>
                        apply(
                          updateCriteria(local, {
                            [group.key]: group.key === 'deadlineWindow' ? 'any' : [],
                          } as Partial<OpportunitySearchCriteriaV2>),
                        )
                      }
                    >
                      Reset
                    </button>
                  ) : null}
                </header>
                {group.note ? <p className="fo-v2-filter-group-note">{group.note}</p> : null}
                <div className="fo-v2-filter-options">
                  {group.options.map((option) => (
                    <button
                      type="button"
                      className={selected.includes(option.value) ? 'is-selected' : ''}
                      key={`${group.key}:${option.value}`}
                      disabled={Boolean(inactive)}
                      onClick={() => toggle(group, option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
        <footer className="fo-v2-overlay-footer">
          <button
            onClick={() =>
              apply(
                updateCriteria(local, {
                  query: '',
                  sources: [],
                  types: [],
                  lifecycle: [],
                  agencies: [],
                  sectors: [],
                  naicsCodes: [],
                  pscCodes: [],
                  setAsideCodes: [],
                  eligibility: [],
                  posted: [],
                  geography: [],
                  applicantTypes: [],
                  funding: [],
                  costShare: [],
                  methods: [],
                  disbursement: [],
                  grantPrerequisites: [],
                  codes: [],
                  deadlineWindow: 'any',
                  deadlineFrom: null,
                  deadlineTo: null,
                }),
              )
            }
          >
            Clear all
          </button>
          <button onClick={onClose}>
            {result.total == null
              ? 'Show results (count unavailable)'
              : `Show ${result.total} results`}
          </button>
        </footer>
      </aside>
    </div>
  );
}
function sourceName(source: string) {
  return (
    (
      {
        grants_gov: 'Grants.gov',
        sam_gov: 'SAM.gov',
        ca_portal: 'California Grants Portal',
        dibbs: 'DLA bid board',
        agency_forecast: 'Agency forecasts',
        sbir_sttr: 'SBIR / STTR',
      } as Record<string, string>
    )[source] ?? source.replaceAll('_', ' ')
  );
}
function healthStateLabel(state: OpportunitySearchResponseV2['freshness'][number]['state']) {
  return state === 'not_enabled'
    ? 'Not enabled'
    : state === 'never_synced'
      ? 'Never synced'
      : state === 'initial_partial'
        ? 'Initial partial'
        : state === 'error_cached'
          ? 'Error cached'
          : state.replace('_', ' ').replace(/^./, (c) => c.toUpperCase());
}
function healthStateNote(state: OpportunitySearchResponseV2['freshness'][number]['state']) {
  return state === 'current'
    ? 'The source reported a current successful catalog sync.'
    : state === 'degraded'
      ? 'The source reported a degraded sync; coverage may be incomplete.'
      : state === 'stale'
        ? 'The source has not reported a current successful sync.'
        : state === 'not_enabled'
          ? 'This source is not enabled for this workspace.'
          : state === 'never_synced'
            ? 'This source has not reported a successful sync.'
            : state === 'error_cached'
              ? 'The latest source attempt failed; cached records may be shown.'
              : 'The source state is not available for a stronger conclusion.';
}
function healthSourceDescription(
  source: string,
  state: OpportunitySearchResponseV2['freshness'][number]['state'],
): string {
  const descriptions: Record<string, string> = {
    grants_gov: 'Federal grant notices and assistance listings published through Grants.gov.',
    sam_gov: 'Federal contract notices and award records published through SAM.gov.',
    ca_portal: 'California state grant opportunities and program details from the Grants Portal.',
    dibbs: 'Defense Logistics Agency bid-board opportunities and line items.',
    agency_forecast: 'Agency planning forecasts published before a solicitation is issued.',
    sbir_sttr: 'Small-business research opportunities published through SBIR and STTR programs.',
  };
  return `${descriptions[source] ?? 'Records published by this opportunity source.'} ${healthStateNote(state)}`;
}
function relativeSourceTime(value: string | null | undefined) {
  if (!value) return 'not available';
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

function HealthDrawer({
  freshness,
  provenance,
  health,
  loading,
  error,
  onClose,
}: {
  freshness: V2Response['freshness'];
  provenance: V2Response['provenance'];
  health?: Array<OpportunitySearchResponseV2['freshness'][number]>;
  loading?: boolean;
  error?: boolean;
  onClose: () => void;
}) {
  const rows =
    health ??
    (freshness.length
      ? freshness
      : provenance.map((item) => ({
          source: item.source,
          state: item.queried ? ('unknown' as const) : ('unavailable' as const),
          recordCount: item.count,
          activeRecordCount: null,
          lastSyncedAt: null,
        })));
  return (
    <div className="fo-v2-drawer-shell" data-fo-overlay="true" role="presentation">
      <button
        className="fo-v2-drawer-backdrop"
        aria-label="Close source health"
        onClick={onClose}
      />
      <aside className="fo-v2-drawer" role="dialog" aria-modal="true" aria-label="Source health">
        <header className="fo-v2-overlay-header">
          <div>
            <h2>Source health</h2>
            <p>
              Never-synced, stale, degraded, failed and current are distinct states. Source update
              time is kept separately from Capiro ingestion time.
            </p>
          </div>
          <button className="fo-v2-icon-button" aria-label="Close" onClick={onClose}>
            <Icon name="XClose" size={20} />
          </button>
        </header>
        {loading ? (
          <p>Loading source health…</p>
        ) : error ? (
          <p role="alert">
            Source health could not be loaded. No freshness conclusion is available.
          </p>
        ) : (
          <div className="fo-v2-health-list">
            {rows.map((item) => (
              <section className="fo-v2-health-card" key={item.source}>
                <i className={`is-${item.state}`} />
                <div>
                  <div className="fo-v2-health-card-heading">
                    <strong>{sourceName(item.source)}</strong>
                    <span className={`fo-v2-health-state is-${item.state}`}>
                      {healthStateLabel(item.state)}
                    </span>
                  </div>
                  <p className="fo-v2-health-meta">
                    LAST RUN {relativeSourceTime(item.lastSyncedAt)} ·{' '}
                    {item.recordCount == null
                      ? 'COUNTS UNAVAILABLE'
                      : item.activeRecordCount == null
                        ? `${formatCount(item.recordCount)} TOTAL · ACTIVE UNKNOWN`
                        : `${formatCount(item.activeRecordCount)} ACTIVE OF ${formatCount(item.recordCount)} TOTAL`}
                  </p>
                  <p>{healthSourceDescription(item.source, item.state)}</p>
                </div>
              </section>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}
function SourceBanner({
  warnings,
  onOpen,
}: {
  warnings: V2Response['freshness'];
  onOpen: () => void;
}) {
  const affected = warnings.filter(
    (item) => item.state !== 'current' && item.state !== 'not_enabled',
  );
  const primary = affected.find((item) => item.state === 'degraded') ?? affected[0];
  if (!primary) return null;
  const name = sourceName(primary.source);
  const whenValue = primary.latestAttemptAt ?? primary.lastSyncedAt;
  const when = whenValue
    ? ` after ${new Date(whenValue).toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })} ET`
    : '';
  const countsUnknown = primary.recordCount == null;
  return (
    <section className="fo-v2-health-banner">
      <span className="fo-v2-health-banner-icon">
        <FundingOpportunityV2Icon name="AlertTriangle" size={18} color="#b54708" />
      </span>
      <div>
        <strong>
          {name} is {primary.state.replace('_', ' ')} — this list is not the complete catalog
        </strong>
        <span>
          {countsUnknown
            ? `Counts were not returned${when}, so records from ${name} may be missing or incomplete.`
            : `The source is not current${when}. Other source records remain visible with their reported freshness.`}
        </span>
      </div>
      <button onClick={onOpen}>Source health</button>
    </section>
  );
}
function formatCount(value: number | null | undefined): string {
  return value == null ? '?' : value.toLocaleString('en-US');
}

type ToolbarOption = { value: string; label: string };

function ToolbarSelect({
  label,
  value,
  options,
  onChange,
  popupClassName,
}: {
  label: string;
  value: string;
  options: readonly ToolbarOption[];
  onChange: (value: string) => void;
  popupClassName: 'fo-v2-sort-popup' | 'fo-v2-size-popup';
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const [focusedIndex, setFocusedIndex] = useState(selectedIndex);
  useEffect(() => {
    if (!open) return;
    setFocusedIndex(selectedIndex);
    const selected = popupRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]');
    selected?.focus();
    const onDocumentPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !popupRef.current?.contains(event.target)) {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDocumentPointerDown);
    document.addEventListener('keydown', onDocumentKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onDocumentPointerDown);
      document.removeEventListener('keydown', onDocumentKeyDown);
    };
  }, [open]);
  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
    triggerRef.current?.focus();
  };
  const move = (delta: number) => {
    const next = (focusedIndex + delta + options.length) % options.length;
    setFocusedIndex(next);
    popupRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]')[next]?.focus();
  };
  const focusEdge = (edge: 'first' | 'last') => {
    const next = edge === 'first' ? 0 : options.length - 1;
    setFocusedIndex(next);
    popupRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]')[next]?.focus();
  };
  const selected = options[selectedIndex];
  return (
    <div className="fo-v2-toolbar-select">
      <span className="fo-v2-toolbar-select-label">{label}</span>
      <button
        ref={triggerRef}
        type="button"
        className="fo-v2-toolbar-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
            event.preventDefault();
            if (!open) setOpen(true);
            else move(1);
          } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
            event.preventDefault();
            if (!open) setOpen(true);
            else move(-1);
          } else if ((event.key === 'Enter' || event.key === ' ') && open) {
            event.preventDefault();
            choose(value);
          } else if (event.key === 'Home' && open) {
            event.preventDefault();
            focusEdge('first');
          } else if (event.key === 'End' && open) {
            event.preventDefault();
            focusEdge('last');
          } else if (event.key === 'Escape' && open) {
            event.preventDefault();
            setOpen(false);
            triggerRef.current?.focus();
          }
        }}
      >
        <span>{selected?.label ?? value}</span>
        <FundingOpportunityV2Icon name="ChevronDown" size={16} color="#667085" />
      </button>
      {open ? (
        <div
          ref={popupRef}
          className={`fo-v2-toolbar-popup ${popupClassName}`}
          role="listbox"
          aria-label={label}
        >
          {options.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              key={option.value}
              onClick={() => choose(option.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
                  event.preventDefault();
                  move(1);
                } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
                  event.preventDefault();
                  move(-1);
                } else if (event.key === 'Home') {
                  event.preventDefault();
                  focusEdge('first');
                } else if (event.key === 'End') {
                  event.preventDefault();
                  focusEdge('last');
                } else if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  choose(option.value);
                }
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Toolbar({
  criteria,
  result,
  filters,
  savedLabel,
  savedCriteriaChanged,
  onOpenSaved,
  freshnessLine,
  busy,
  onFilter,
  onRemove,
  onClear,
  onPatch,
}: {
  criteria: OpportunitySearchCriteriaV2;
  result: V2Response;
  filters: FilterChip[];
  savedLabel?: string;
  savedCriteriaChanged: boolean;
  onOpenSaved: () => void;
  freshnessLine: string;
  busy: boolean;
  onFilter: () => void;
  onRemove: (key: string, value?: string) => void;
  onClear: () => void;
  onPatch: (patch: Partial<OpportunitySearchCriteriaV2>) => void;
}) {
  return (
    <section className="fo-v2-toolbar">
      <div className="fo-v2-type-row">
        <button
          className={criteria.types.length === 1 && criteria.types[0] === 'grant' ? 'active' : ''}
          onClick={() => onPatch({ types: ['grant'] })}
        >
          Grants <b>{formatCount(result.counts.grants)}</b>
        </button>
        <button
          className={
            criteria.types.length > 0 &&
            criteria.types.every((type) => CONTRACT_TYPE_VALUES.includes(type))
              ? 'active'
              : ''
          }
          onClick={() => onPatch({ types: [...CONTRACT_TYPE_VALUES] })}
        >
          Contracts <b>{formatCount(result.counts.contracts)}</b>
        </button>
        <button
          className={
            !criteria.types.length ||
            (criteria.types.length > 1 &&
              criteria.types.some((type) => type === 'grant') &&
              criteria.types.some((type) => CONTRACT_TYPE_VALUES.includes(type)))
              ? 'active'
              : ''
          }
          onClick={() => onPatch({ types: [] })}
        >
          All <b>{formatCount(result.counts.active)}</b>
        </button>
        <button type="button" className="fo-v2-saved-hint" onClick={onOpenSaved}>
          <Icon name="BookmarkCheck" size={14} />
          {savedLabel ? `Saved: ${savedLabel}` : 'Saved searches'}
          {savedLabel && savedCriteriaChanged ? (
            <span className="fo-v2-saved-stale">
              <i aria-hidden="true" />
              Criteria changed
            </span>
          ) : null}
        </button>
      </div>
      <div className="fo-v2-filter-row">
        <button
          className={`fo-v2-filter-button${filters.length ? ' is-active' : ''}`}
          onClick={onFilter}
        >
          <FundingOpportunityV2Icon name="FilterFunnel01" size={16} />
          Filters <b>{filters.length}</b>
        </button>
        {filters.map((filter) => (
          <button
            className={`fo-v2-chip${filter.key === 'query' ? ' fo-v2-chip--keyword' : ''}`}
            key={`${filter.key}:${filter.value ?? 'query'}`}
            title="Remove this filter"
            onClick={() => onRemove(filter.key, filter.value)}
          >
            {filter.label}
            <Icon name="XClose" size={13} />
          </button>
        ))}
        {filters.length ? (
          <button className="fo-v2-clear" onClick={onClear}>
            Clear all
          </button>
        ) : null}
      </div>
      <div className="fo-v2-toolbar-bottom">
        <span aria-live="polite">
          {busy
            ? 'Searching…'
            : result.total == null
              ? `Displaying ${result.opportunities.length} results · count unavailable`
              : `Displaying ${result.opportunities.length ? (criteria.page - 1) * criteria.pageSize + 1 : 0}–${Math.min(criteria.page * criteria.pageSize, result.total)} of ${result.total} ${criteria.mode === 'matched' ? 'matched' : 'available'}`}
          <i aria-hidden="true" /> <small>{freshnessLine}</small>
        </span>
        <ToolbarSelect
          label="Sort"
          value={criteria.sort}
          options={SORT_OPTIONS}
          popupClassName="fo-v2-sort-popup"
          onChange={(value) => onPatch({ sort: value as OpportunitySearchCriteriaV2['sort'] })}
        />
        <button
          type="button"
          className="fo-v2-direction"
          aria-label={`Sort direction: ${criteria.direction === 'asc' ? 'ascending' : 'descending'}`}
          title={`Sort direction: ${criteria.direction === 'asc' ? 'ascending' : 'descending'}`}
          onClick={() => onPatch({ direction: criteria.direction === 'asc' ? 'desc' : 'asc' })}
        >
          <span
            className={
              criteria.direction === 'desc'
                ? 'fo-v2-direction-icon is-desc'
                : 'fo-v2-direction-icon'
            }
          >
            <FundingOpportunityV2Icon name="ArrowNarrowUp" size={16} />
          </span>
        </button>
        <ToolbarSelect
          label="Per page"
          value={String(criteria.pageSize)}
          options={PAGE_SIZES.map((size) => ({ value: String(size), label: String(size) }))}
          popupClassName="fo-v2-size-popup"
          onChange={(value) => onPatch({ pageSize: Number(value) })}
        />
      </div>
    </section>
  );
}
type FilterChip = { key: string; label: string; value?: string };
function filterLabel(key: string, value: string): string {
  const group = V2_FILTER_GROUPS.find((item) => item.key === key);
  return (
    group?.options.find((option) => option.value === value)?.label ?? value.replaceAll('_', ' ')
  );
}
export function filterChips(
  criteria: OpportunitySearchCriteriaV2,
  _clientName?: string,
): FilterChip[] {
  const out: FilterChip[] = [];
  if (criteria.query) out.push({ key: 'query', label: `“${criteria.query}”` });
  if (criteria.keywordTerms?.length) out.push({ key: 'keywordTerms', label: `${criteria.keywordTerms.length} selected keywords` });
  criteria.lifecycle
    .filter((v) => v !== 'active' || criteria.lifecycle.length > 1)
    .forEach((v) =>
      out.push({
        key: 'lifecycle',
        value: v,
        label: v === 'forecast' ? 'forecasted' : v === 'post_award' ? 'post-award' : v,
      }),
    );
  if (criteria.types.some((v) => v === 'grant'))
    out.push({ key: 'types', value: 'grant', label: 'grants' });
  if (criteria.types.some((v) => CONTRACT_TYPE_VALUES.includes(v)))
    out.push({ key: 'types', value: 'contract', label: 'contracts' });
  criteria.sources.forEach((v) =>
    out.push({
      key: 'sources',
      value: v,
      label: SOURCE_OPTIONS.find((x) => x.value === v)?.label ?? v,
    }),
  );
  criteria.sectors.forEach((v) => out.push({ key: 'sectors', value: v, label: v }));
  criteria.agencies
    .filter((v) => v !== 'any')
    .forEach((v) => out.push({ key: 'agencies', value: v, label: filterLabel('agencies', v) }));
  criteria.posted.forEach((v) =>
    out.push({ key: 'posted', value: v, label: filterLabel('posted', v) }),
  );
  criteria.geography.forEach((v) =>
    out.push({ key: 'geography', value: v, label: filterLabel('geography', v) }),
  );
  criteria.applicantTypes.forEach((v) =>
    out.push({ key: 'applicantTypes', value: v, label: filterLabel('applicantTypes', v) }),
  );
  criteria.funding.forEach((v) =>
    out.push({ key: 'funding', value: v, label: filterLabel('funding', v) }),
  );
  criteria.costShare.forEach((v) =>
    out.push({ key: 'costShare', value: v, label: filterLabel('costShare', v) }),
  );
  criteria.methods.forEach((v) =>
    out.push({ key: 'methods', value: v, label: filterLabel('methods', v) }),
  );
  criteria.disbursement.forEach((v) =>
    out.push({ key: 'disbursement', value: v, label: filterLabel('disbursement', v) }),
  );
  criteria.grantPrerequisites.forEach((v) =>
    out.push({ key: 'grantPrerequisites', value: v, label: filterLabel('grantPrerequisites', v) }),
  );
  criteria.setAsideCodes.forEach((v) =>
    out.push({ key: 'setAsideCodes', value: v, label: filterLabel('setAsideCodes', v) }),
  );
  criteria.codes.forEach((v) =>
    out.push({ key: 'codes', value: v, label: filterLabel('codes', v) }),
  );
  criteria.pscCodes.forEach((v) => out.push({ key: 'pscCodes', value: v, label: `PSC ${v}` }));
  if (criteria.deadlineWindow !== 'any')
    out.push({
      key: 'deadlineWindow',
      value: criteria.deadlineWindow,
      label: `within ${criteria.deadlineWindow === '90d' ? '90 days' : criteria.deadlineWindow}`,
    });
  if (criteria.deadlineFrom)
    out.push({
      key: 'deadlineFrom',
      value: criteria.deadlineFrom,
      label: `from ${criteria.deadlineFrom.slice(0, 10)}`,
    });
  if (criteria.deadlineTo)
    out.push({
      key: 'deadlineTo',
      value: criteria.deadlineTo,
      label: `to ${criteria.deadlineTo.slice(0, 10)}`,
    });
  const eligibilityLabels: Record<string, string> = {
    eligible: 'eligible',
    needs_review: 'the client needs eligibility review',
    ineligible: 'the client does not meet stated eligibility',
    unknown: 'eligibility is not stated',
  };
  criteria.eligibility.forEach((v) =>
    out.push({
      key: 'eligibility',
      value: v,
      label: eligibilityLabels[v] ?? v.replaceAll('_', ' '),
    }),
  );
  criteria.naicsCodes.forEach((v) =>
    out.push({ key: 'naicsCodes', value: v, label: `NAICS ${v}` }),
  );
  return out;
}
function removeCriterion(
  criteria: OpportunitySearchCriteriaV2,
  key: string,
  value: string | undefined,
  patch: (p: Partial<OpportunitySearchCriteriaV2>) => void,
) {
  if (key === 'query') return patch({ query: '' });
  if (key === 'deadlineWindow') return patch({ deadlineWindow: 'any' });
  if (key === 'deadlineFrom') return patch({ deadlineFrom: null });
  if (key === 'deadlineTo') return patch({ deadlineTo: null });
  if (key === 'clientId') return patch({ clientId: null, mode: 'all' });
  const current = criteria[key as keyof OpportunitySearchCriteriaV2];
  if (Array.isArray(current))
    patch({
      [key]: value ? current.filter((item) => item !== value) : [],
    } as Partial<OpportunitySearchCriteriaV2>);
}

function ProfileGaps({ data }: { data: NonNullable<V2Response['profileGaps']> }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <section className="fo-v2-profile-gaps">
      <header>
        <strong>Profile gaps limiting matches</strong>
        <span>{data.items.length} fields</span>
        <button
          type="button"
          className="fo-v2-profile-gaps-dismiss"
          aria-label="Dismiss profile gaps for this session"
          onClick={() => setDismissed(true)}
        >
          <Icon name="XClose" size={16} />
        </button>
      </header>
      <div className="fo-v2-gap-list">
        {data.items.map((gap) => (
          <div className="fo-v2-gap" key={`${gap.title}:${gap.tag}`}>
            <i />
            <div>
              <strong>{gap.title}</strong>
              <span>{gap.tag}</span>
              <p>{gap.body}</p>
            </div>
          </div>
        ))}
        <div className="fo-v2-gap-footer">
          {data.profileLink ? <a href={data.profileLink}>Open client profile</a> : null}
          {data.actualUnscoredCount != null ? (
            <span>
              Missing profile data is not the same as no matching opportunities.{' '}
              {data.actualUnscoredCount} contract records are unscored, not excluded.
            </span>
          ) : null}
        </div>
      </div>
    </section>
  );
}
function EmptyState({
  reason,
  onClear,
  onWiden,
}: {
  reason: string;
  onClear: () => void;
  onWiden: () => void;
}) {
  return (
    <section className="fo-v2-empty">
      <h2>No opportunities match these criteria</h2>
      <p>{reason}</p>
      <div>
        <button onClick={onWiden}>Widen deadline</button>
        <button onClick={onClear}>Clear all filters</button>
      </div>
    </section>
  );
}
function Pagination({
  criteria,
  total,
  onPatch,
}: {
  criteria: OpportunitySearchCriteriaV2;
  total: number | null;
  onPatch: (patch: Partial<OpportunitySearchCriteriaV2>, reset?: boolean) => void;
}) {
  const canNext = total != null && criteria.page * criteria.pageSize < total;
  return (
    <div className="fo-v2-pagination">
      <span>
        {total == null ? 'Result count unavailable from the sources' : `${total} results`} ·{' '}
        {criteria.pageSize} per page · back-navigation returns to this page and scroll position
      </span>
      <div>
        <button
          disabled={criteria.page <= 1}
          onClick={() => onPatch({ page: criteria.page - 1 }, false)}
        >
          Previous
        </button>
        <b>{criteria.page}</b>
        <button disabled={!canNext} onClick={() => onPatch({ page: criteria.page + 1 }, false)}>
          Next
        </button>
      </div>
    </div>
  );
}

function Editor({
  group,
  criteria,
  clientOptions,
  clientName,
  onChange,
  onToggle,
  onClose,
}: {
  group: EditorGroup;
  criteria: OpportunitySearchCriteriaV2;
  clientOptions: ClientLite[];
  clientName?: string;
  onChange: (patch: Partial<OpportunitySearchCriteriaV2>) => void;
  onToggle: (key: keyof OpportunitySearchCriteriaV2, value: string) => void;
  onClose: () => void;
}) {
  const definitions =
    group === 'lifecycle'
      ? LIFECYCLE_OPTIONS
      : group === 'types'
        ? TYPE_OPTIONS
        : group === 'eligibility'
          ? [
              { value: 'eligible', label: 'Eligible' },
              { value: 'needs_review', label: 'Needs review' },
              { value: 'ineligible', label: 'Ineligible' },
              { value: 'unknown', label: 'Unknown' },
            ]
          : group === 'sector'
            ? [
                { value: 'defense electronics', label: 'Defense electronics' },
                { value: 'autonomous systems', label: 'Autonomous systems' },
                { value: 'energy resilience', label: 'Energy resilience' },
                { value: 'climate resilience', label: 'Climate resilience' },
                { value: 'logistics', label: 'Logistics and sealift' },
              ]
            : group === 'agency'
              ? [
                  { value: 'army', label: 'the Army' },
                  { value: 'disa', label: 'DISA' },
                  { value: 'doe', label: 'Energy' },
                  { value: 'dla', label: 'DLA' },
                ]
              : group === 'deadline'
                ? [
                    { value: 'any', label: 'at any time' },
                    { value: '14d', label: 'within 14 days' },
                    { value: '30d', label: 'within 30 days' },
                    { value: '90d', label: 'within 90 days' },
                    { value: '180d', label: 'within 180 days' },
                  ]
                : [];
  const selected =
    group === 'lifecycle'
      ? criteria.lifecycle
      : group === 'types'
        ? criteria.types
        : group === 'eligibility'
          ? criteria.eligibility
          : group === 'sector'
            ? criteria.sectors
            : group === 'agency'
              ? criteria.agencies
              : [];
  const key =
    group === 'types'
      ? 'types'
      : group === 'eligibility'
        ? 'eligibility'
        : group === 'sector'
          ? 'sectors'
          : group === 'agency'
            ? 'agencies'
            : 'lifecycle';
  return (
    <div
      className="fo-v2-editor-strip"
      data-fo-overlay="true"
      role="dialog"
      aria-label={`${group} editor`}
    >
      <div className="fo-v2-editor-strip-heading">
        <div>
          <strong>{group === 'sector' ? 'Category / program area' : group}</strong>
          <span>Choose one or more values. Values within this group use OR.</span>
        </div>
        <button className="fo-v2-icon-button" aria-label="Close" onClick={onClose}>
          <Icon name="XClose" size={18} />
        </button>
      </div>
      <div className="fo-v2-editor-options">
        {definitions.map((item, index) => (
          <button
            key={`${item.value}:${index}`}
            className={
              selected.includes(item.value) ||
              (group === 'deadline' && criteria.deadlineWindow === item.value)
                ? 'selected'
                : ''
            }
            onClick={() =>
              group === 'deadline'
                ? onChange({
                    deadlineWindow: item.value as OpportunitySearchCriteriaV2['deadlineWindow'],
                  })
                : group === 'eligibility'
                  ? onChange({
                      eligibility: [
                        item.value as OpportunitySearchCriteriaV2['eligibility'][number],
                      ],
                    })
                  : onToggle(key, item.value)
            }
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="fo-v2-editor-strip-actions">
        <button
          onClick={() =>
            onChange(
              group === 'deadline'
                ? { deadlineWindow: 'any' }
                : ({ [key]: [] } as Partial<OpportunitySearchCriteriaV2>),
            )
          }
        >
          Clear group
        </button>
        <button onClick={onClose}>Done</button>
      </div>
    </div>
  );
}
function QuickQueryStatePanel({
  state,
  onClose,
  onRetry,
}: {
  state: 'loading' | 'error';
  onClose: () => void;
  onRetry?: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    panel.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const nodes = [
        ...panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])',
        ),
      ];
      if (!nodes.length) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (
        event.shiftKey &&
        (document.activeElement === panel || document.activeElement === first)
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === panel || document.activeElement === last)
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    panel.addEventListener('keydown', onKeyDown);
    return () => {
      panel.removeEventListener('keydown', onKeyDown);
      if (restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus();
    };
  }, [onClose]);
  return (
    <aside
      ref={panelRef}
      className="fo-v2-detail-panel fo-v2-detail-panel--loading"
      role="dialog"
      aria-modal="true"
      aria-label="Quick details"
      data-fo-v2-overlay="quick"
      tabIndex={-1}
    >
      <button
        className="fo-v2-detail-icon-button"
        aria-label="Close quick details"
        onClick={onClose}
      >
        <Icon name="XClose" size={20} />
      </button>
      {state === 'loading' ? (
        <p aria-live="polite">Loading opportunity details…</p>
      ) : (
        <>
          <h2>Quick details could not be loaded</h2>
          <p role="alert">This request failed. No conclusion can be drawn about the opportunity.</p>
          <div className="fo-v2-actions">
            <button className="fo-v2-detail-button" onClick={onRetry}>
              Retry
            </button>
            <button className="fo-v2-detail-button fo-v2-detail-button--dark" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      )}
    </aside>
  );
}

function Overlay({
  api,
  type,
  criteria,
  clientName,
  clientOptions,
  result,
  selectedRow,
  onClose,
  onChooseClient,
  onWorkflow,
  onApplyCriteria,
  onOpenDetail,
}: {
  api: ReturnType<typeof createFundingOpportunityV2Api>;
  type: Exclude<Overlay, 'saved' | 'save' | null>;
  criteria: OpportunitySearchCriteriaV2;
  clientName?: string;
  clientOptions: ClientLite[];
  result: V2Response;
  selectedRow: OpportunityRecord | null;
  onClose: () => void;
  onChooseClient: (id: string | null) => void;
  onWorkflow: (intent: 'saved' | 'pursuing') => void | Promise<void>;
  onApplyCriteria: (criteria: OpportunitySearchCriteriaV2) => void;
  onOpenDetail: () => void;
}) {
  if (type === 'filters')
    return (
      <FilterDrawer
        criteria={criteria}
        result={result}
        onClose={onClose}
        onApplyCriteria={onApplyCriteria}
      />
    );
  if (type === 'health')
    return (
      <HealthDrawer freshness={result.freshness} provenance={result.provenance} onClose={onClose} />
    );
  if (type === 'quick' && selectedRow) {
    return (
      <FundingOpportunityV2QuickDetailsQuery
        api={api}
        source={selectedRow.source}
        sourceRecordId={selectedRow.sourceRecordId}
        clientId={criteria.clientId}
        mode={criteria.mode}
        clientName={clientName}
        enabled
      >
        {({ model, isLoading, isError, retry }) => {
          if (isLoading) return <QuickQueryStatePanel state="loading" onClose={onClose} />;
          if (isError || !model)
            return <QuickQueryStatePanel state="error" onClose={onClose} onRetry={retry} />;
          return (
            <FundingOpportunityV2QuickPanel
              model={model}
              onClose={onClose}
              onOpenFullDetail={onOpenDetail}
              onAction={(event) => {
                if (event.action === 'save') return onWorkflow('saved') ?? undefined;
                if (event.action === 'pursue') return onWorkflow('pursuing') ?? undefined;
              }}
              onExternalAudit={(event) => api.auditSourceClick(event)}
            />
          );
        }}
      </FundingOpportunityV2QuickDetailsQuery>
    );
  }
  if (type === 'quick') return null;
  return (
    <FundingOpportunitiesV2ClientModal
      clients={clientOptions}
      selected={criteria.clientId}
      matchedCount={null}
      onClose={onClose}
      onChoose={onChooseClient}
    />
  );
}

function V2DetailRoute({
  api,
  source,
  sourceRecordId,
  criteria,
  clientName,
  onBack,
  onChooseClient,
  onAction,
  onSimilar,
  onSaveSearch,
  sourceHealth,
}: {
  api: ReturnType<typeof createFundingOpportunityV2Api>;
  source: OpportunitySourceV2;
  sourceRecordId: string;
  criteria: OpportunitySearchCriteriaV2;
  clientName?: string;
  onBack: () => void;
  onChooseClient: () => void;
  onAction: (event: {
    action: 'save' | 'pursue' | 'not_fit';
    source: OpportunitySourceV2;
    sourceRecordId: string;
    clientId: string | null;
    row?: OpportunityRecord;
  }) => void | Promise<void>;
  onSimilar: (row: { source: OpportunitySourceV2; sourceRecordId: string }) => void;
  onSaveSearch: () => void;
  sourceHealth: OpportunitySourceFreshnessV2[];
}) {
  const [quickOpen, setQuickOpen] = useState(false);
  const [notFitOpen, setNotFitOpen] = useState(false);
  const [notFitBusy, setNotFitBusy] = useState(false);
  const [notFitError, setNotFitError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: opportunityQueryKeys.detail(source, sourceRecordId, criteria.clientId, criteria.mode),
    queryFn: ({ signal }) =>
      api.getDetail(source, sourceRecordId, criteria.clientId, criteria.mode, signal),
    retry: false,
  });
  if (query.isPending)
    return (
      <div className="fo-v2-loading" aria-busy="true">
        Loading opportunity details…
      </div>
    );
  if (query.isError || !query.data) {
    const status = (query.error as { response?: { status?: number } } | undefined)?.response
      ?.status;
    return (
      <section
        className="fo-v2-error"
        data-testid={status === 404 ? 'fo-v2-detail-not-found' : 'fo-v2-detail-error'}
      >
        <h2>
          {status === 404 ? 'Opportunity not found' : 'Opportunity details could not be loaded'}
        </h2>
        <p>
          {status === 404
            ? 'The source record is no longer available in the catalog.'
            : 'This request failed. No conclusion can be drawn about the opportunity.'}
        </p>
        {status !== 404 ? (
          <CapiroButton onClick={() => void query.refetch()}>Retry</CapiroButton>
        ) : null}
        <CapiroButton variant="secondary" onClick={onBack}>
          Back to results
        </CapiroButton>
      </section>
    );
  }
  const sourceFreshnessState: OpportunitySourceFreshnessV2['state'] | null =
    sourceHealth.find((item) => item.source === source)?.state ?? null;
  const input = normalizeFundingOpportunityV2Detail(query.data.opportunity, {
    mode: criteria.mode,
    clientName,
    sourceFreshnessState,
  });
  const model = buildFundingOpportunityV2DetailModel(input);
  const row = {
    ...query.data.opportunity,
    source: query.data.source,
    sourceRecordId: query.data.sourceRecordId,
  } as OpportunityRecord;
  const audit = (
    event: Parameters<
      NonNullable<React.ComponentProps<typeof FundingOpportunityV2Detail>['onExternalAudit']>
    >[0],
  ) => api.auditSourceClick(event);
  async function submitNotFit(input: {
    clientId: string;
    source: string;
    sourceRecordId: string;
    reason: string;
    note: string | null;
  }) {
    setNotFitBusy(true);
    setNotFitError(null);
    try {
      await api.recordNotFit({
        clientId: input.clientId,
        source: input.source as OpportunitySourceV2,
        sourceRecordId: input.sourceRecordId,
        reason: input.reason,
        note: input.note,
      });
      await refreshOpportunityQueries(queryClient, input.clientId);
      setNotFitOpen(false);
    } catch {
      setNotFitError('The reason could not be recorded. Nothing was changed.');
    } finally {
      setNotFitBusy(false);
    }
  }
  const routeAction = (event: {
    action: 'save' | 'pursue' | 'not_fit';
    source: OpportunitySourceV2;
    sourceRecordId: string;
    clientId: string | null;
  }) => {
    if (event.action === 'not_fit') {
      setNotFitOpen(true);
      setNotFitError(null);
      return;
    }
    return onAction({ ...event, row });
  };
  return (
    <>
      <FundingOpportunityV2Detail
        input={input}
        model={model}
        onBack={onBack}
        onAction={routeAction}
        onExternalAudit={audit}
        onOpenSimilar={(similar) =>
          onSimilar({ source: similar.source, sourceRecordId: similar.sourceRecordId })
        }
        onSaveSearch={onSaveSearch}
        onOpenQuick={() => setQuickOpen(true)}
      />
      {quickOpen ? (
        <FundingOpportunityV2QuickPanel
          model={model}
          onClose={() => setQuickOpen(false)}
          onOpenFullDetail={() => setQuickOpen(false)}
          onAction={routeAction}
          onExternalAudit={audit}
        />
      ) : null}
      {notFitOpen ? (
        <FundingOpportunityV2NotFitDialog
          title={row.title}
          clientId={row.clientId}
          source={row.source}
          sourceRecordId={row.sourceRecordId}
          busy={notFitBusy}
          error={notFitError}
          onSubmit={submitNotFit}
          onChooseClient={onChooseClient}
          onClose={() => !notFitBusy && setNotFitOpen(false)}
        />
      ) : null}
    </>
  );
}
