import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroSkeleton } from '../../components/feedback/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { useApi } from '../../../lib/use-api.js';
import { requestMeriContextPrompt } from '../../../components/chat/meri-prompt.js';
import {
  readEnum,
  readEnumList,
  readInt,
  useUrlState,
} from '../../../pages/intelligence/opportunities/funding-opportunities-url-state.js';
import {
  ELIGIBILITY_LABELS,
  KIND_LABELS,
  type EligibilityState,
  type FundingOpportunity,
  type FundingOpportunityListResponse,
  type OpportunityKind,
} from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';
import { OpportunityCard } from './OpportunityCard.js';
import { OpportunityFreshnessStrip } from './OpportunityFreshnessStrip.js';
import {
  FovAlert,
  FovCard,
  FovModal,
  FovMultiSelect,
  FovSegmented,
  FovSkeletonRows,
} from './fov-ui.js';

interface TenantMember {
  id: string;
  name: string;
  email: string;
}

interface FacilityLite {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  congressionalDistrict: string | null;
}

export const EXPLORE_TABS = [
  'all',
  'grants',
  'contracts',
  'saved',
  'pursuing',
  'deadlines',
  'dismissed',
] as const;
export type ExploreTab = (typeof EXPLORE_TABS)[number];
type EditorAction = 'assign' | 'note' | 'site' | 'task';

const TABS: Array<{ value: ExploreTab; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'grants', label: 'Grants' },
  { value: 'contracts', label: 'Government contracts' },
  { value: 'saved', label: 'Saved' },
  { value: 'pursuing', label: 'Pursuing' },
  { value: 'deadlines', label: 'Deadlines' },
  { value: 'dismissed', label: 'Dismissed' },
];

const KIND_OPTIONS = (Object.keys(KIND_LABELS) as OpportunityKind[]).map((value) => ({
  label: KIND_LABELS[value],
  value,
}));
const ELIGIBILITY_OPTIONS = (Object.keys(ELIGIBILITY_LABELS) as EligibilityState[]).map(
  (value) => ({ label: ELIGIBILITY_LABELS[value], value }),
);
const ALL_KINDS = Object.keys(KIND_LABELS) as OpportunityKind[];
const ALL_ELIGIBILITY = Object.keys(ELIGIBILITY_LABELS) as EligibilityState[];

/**
 * `Explore federal opportunities` — the raw source catalog, vNext port of the
 * canonical FundingOpportunityExplore.
 *
 * A RESEARCH TOOL: one row per source record, scored against a client if one
 * is selected, with the full filter set. The honesty rules it carries (no
 * blended total, null money is never `$0`, relevance and eligibility stay
 * separate, a failed request is not an empty list) read the same data through
 * the same endpoints; only the presentation moved to vNext primitives. Tab,
 * filters and page number stay in the URL.
 */
export function FundingOpportunityExplore({ clientId }: { clientId: string | undefined }) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const url = useUrlState();

  const tab = readEnum<ExploreTab>(url.get('tab'), EXPLORE_TABS, 'all');
  const search = url.get('q') ?? '';
  const agency = url.get('agency') ?? '';
  const naics = url.get('naics') ?? '';
  const psc = url.get('psc') ?? '';
  const setAside = url.get('setAside') ?? '';
  const kinds = readEnumList<OpportunityKind>(url.get('kind'), ALL_KINDS);
  const eligibility = readEnumList<EligibilityState>(url.get('eligibility'), ALL_ELIGIBILITY);
  const minRelevance = readInt(url.get('minRelevance'), 0, 100);
  const page = readInt(url.get('page'), 1, 100_000) ?? 1;

  // Every filter change resets to page 1. A filter applied on page 7 of the
  // old result set lands the reader on a page that may not exist in the new one.
  const patch = (next: Record<string, string | number | null | undefined>) =>
    url.set({ ...next, page: null });

  const [editor, setEditor] = useState<{
    action: EditorAction;
    opportunity: FundingOpportunity;
  } | null>(null);
  const [ownerUserId, setOwnerUserId] = useState<string | null>(null);
  const [facilityId, setFacilityId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');

  const members = useQuery<TenantMember[]>({
    queryKey: ['tenant-members'],
    queryFn: async () => (await api.get<TenantMember[]>('/api/tenant-members')).data,
    staleTime: 60_000,
    enabled: Boolean(clientId),
  });
  const facilities = useQuery<FacilityLite[]>({
    queryKey: ['client-facilities', clientId],
    queryFn: async () =>
      (await api.get<FacilityLite[]>(`/api/clients/${encodeURIComponent(clientId!)}/facilities`))
        .data,
    staleTime: 60_000,
    enabled: Boolean(clientId),
  });

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (clientId) params.set('clientId', clientId);
    if (tab === 'grants') params.set('source', 'grants_gov');
    if (tab === 'contracts') params.set('source', 'sam_gov');
    if (tab === 'saved') params.set('workflowStatus', 'saved');
    if (tab === 'pursuing') params.set('workflowStatus', 'pursuing');
    if (tab === 'dismissed') params.set('workflowStatus', 'dismissed');
    if (tab === 'deadlines') {
      params.set('deadlineFrom', new Date().toISOString());
      params.set('deadlineTo', new Date(Date.now() + 30 * 86_400_000).toISOString());
    }
    params.set('activeState', ['saved', 'pursuing', 'dismissed'].includes(tab) ? 'all' : 'active');
    if (search.trim()) params.set('q', search.trim());
    if (agency.trim()) params.set('agency', agency.trim());
    if (naics.trim()) params.set('naics', naics.trim());
    if (psc.trim()) params.set('psc', psc.trim());
    if (setAside.trim()) params.set('setAside', setAside.trim());
    if (kinds.length) params.set('kind', kinds.join(','));
    if (eligibility.length) params.set('eligibility', eligibility.join(','));
    if (minRelevance != null) params.set('minRelevance', String(minRelevance));
    params.set('page', String(page));
    params.set('pageSize', '25');
    return params.toString();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    clientId,
    tab,
    search,
    agency,
    naics,
    psc,
    setAside,
    kinds.join(','),
    eligibility.join(','),
    minRelevance,
    page,
  ]);

  const listQuery = useQuery<FundingOpportunityListResponse>({
    queryKey: ['funding-opportunities', query],
    queryFn: async () =>
      (await api.get<FundingOpportunityListResponse>(`/api/intelligence/opportunities?${query}`))
        .data,
    retry: 1,
    staleTime: 30_000,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['funding-opportunities'] });
    void qc.invalidateQueries({ queryKey: ['funding-opportunity-inbox'] });
    void qc.invalidateQueries({ queryKey: ['client-funding-opportunities'] });
    void qc.invalidateQueries({ queryKey: ['engagement-tasks'] });
  };

  const workflowMutation = useMutation({
    mutationFn: async (input: {
      o: FundingOpportunity;
      action: 'save' | 'pursue' | 'dismiss' | 'restore';
    }) => {
      if (!clientId) throw new Error('Select a client first.');
      const { o, action } = input;
      const base = `/api/intelligence/clients/${clientId}/opportunities/${o.source}/${o.sourceRecordId}`;
      if (action === 'dismiss') return api.post(`${base}/dismiss`, {});
      if (action === 'restore') return api.post(`${base}/restore`, {});
      return api.post(`${base}/save`, { status: action === 'pursue' ? 'pursuing' : 'saved' });
    },
    onSuccess: (_r, input) => {
      toast.success(
        `${
          input.action === 'dismiss'
            ? 'Dismissed'
            : input.action === 'restore'
              ? 'Restored'
              : input.action === 'pursue'
                ? 'Marked as pursuing'
                : 'Saved'
        } — ${input.o.title}`,
      );
      invalidate();
    },
    onError: (err) => toast.error(`Action failed — ${apiErrorMessage(err)}`),
  });

  const editorMutation = useMutation({
    mutationFn: async () => {
      if (!clientId || !editor) throw new Error('Select a client first.');
      const o = editor.opportunity;
      const base = `/api/intelligence/clients/${clientId}/opportunities/${o.source}/${o.sourceRecordId}`;
      if (editor.action === 'task') {
        // ONE atomic server action since P08. The server derives the title,
        // description, due date and the idempotency key — sending them from
        // here is what let the task and the opportunity drift apart.
        return api.post(`${base}/action`, {
          intent: o.isPursuable && o.isActive ? 'pursuit' : 'review',
          ownerUserId: ownerUserId ?? undefined,
          notes: notes.trim() || undefined,
        });
      }
      const body =
        editor.action === 'assign'
          ? { ownerUserId }
          : editor.action === 'site'
            ? { facilityId }
            : { notes: notes.trim() || null };
      return api.patch(base, body);
    },
    onSuccess: () => {
      toast.success(
        `${
          editor?.action === 'assign'
            ? 'Owner assigned'
            : editor?.action === 'site'
              ? 'Project site linked'
              : editor?.action === 'task'
                ? 'Task created'
                : 'Note saved'
        } — ${editor?.opportunity.title ?? ''}`,
      );
      setEditor(null);
      invalidate();
    },
    onError: (err) => toast.error(`Action failed — ${apiErrorMessage(err)}`),
  });

  function openEditor(action: EditorAction, opportunity: FundingOpportunity) {
    setEditor({ action, opportunity });
    setOwnerUserId(opportunity.workflow?.owner?.userId ?? null);
    setFacilityId(opportunity.workflow?.facility?.id ?? null);
    setNotes(action === 'note' ? (opportunity.workflow?.notes ?? '') : '');
  }

  function askMeriAboutOpportunity(opportunity: FundingOpportunity) {
    if (!clientId) return;
    const sourceLabel = opportunity.source === 'grants_gov' ? 'Grants.gov' : 'SAM.gov';
    requestMeriContextPrompt({
      clientId,
      newSession: true,
      prompt: [
        `Assess this ${sourceLabel} funding opportunity for the selected client.`,
        `Title: ${opportunity.title}`,
        `Reference: ${opportunity.sourceReference ?? opportunity.sourceRecordId}`,
        `Agency: ${[opportunity.agency, opportunity.subAgency, opportunity.office].filter(Boolean).join(' / ') || 'not stated'}`,
        `Deadline: ${opportunity.responseDeadline ?? opportunity.responseDeadlineNote ?? 'not stated'}`,
        `Current deterministic relevance: ${opportunity.relevanceScore}/100.`,
        `Eligibility state: ${opportunity.eligibility.state} — ${opportunity.eligibility.reason}`,
        opportunity.sourceUrl ? `Source: ${opportunity.sourceUrl}` : '',
        'Explain the match, identify missing facts or eligibility risks, recommend pursue/watch/dismiss, and give concrete next steps. Keep source facts, Capiro context, and inferences clearly separated.',
      ]
        .filter(Boolean)
        .join('\n'),
    });
  }

  const data = listQuery.data;
  const counts = data?.counts;

  return (
    <div className="fov-explore fov-stack fov-stack--10" data-testid="fo-explore">
      <OpportunityFreshnessStrip freshness={data?.freshness} />

      {!clientId ? (
        <div data-testid="fo-no-client">
          <FovAlert
            tone="info"
            message="Showing the raw opportunity catalog"
            description="Pick a client to calculate relevance and eligibility or to save and pursue opportunities."
          />
        </div>
      ) : null}

      <div className="fov-kpis" data-testid="fo-kpis">
        <Kpi label="Active grants" value={counts?.activeGrants} loading={listQuery.isPending} />
        <Kpi
          label="Active contract opportunities"
          value={counts?.activeContracts}
          loading={listQuery.isPending}
        />
        <Kpi label="Saved" value={counts?.saved} loading={listQuery.isPending} />
        <Kpi label="Pursuing" value={counts?.pursuing} loading={listQuery.isPending} />
        <Kpi
          label="Deadlines in 30 days"
          value={counts?.deadlinesIn30Days}
          loading={listQuery.isPending}
        />
      </div>

      <FovSegmented<ExploreTab>
        block
        value={tab}
        onChange={(value) => patch({ tab: value === 'all' ? null : value })}
        options={TABS}
        // Named because two of the tab labels ("Saved", "Pursuing") are also
        // KPI tile labels a few lines above.
        ariaLabel="Opportunity workflow tab"
      />

      <FovCard>
        <div className="fov-filters">
          <SearchField value={search} onSearch={(value) => patch({ q: value })} />
          <input
            className="capiro-input fov-filter-input"
            placeholder="Agency"
            style={{ width: 160 }}
            value={agency}
            onChange={(event) => patch({ agency: event.target.value })}
            aria-label="Agency"
          />
          <input
            className="capiro-input fov-filter-input"
            placeholder="NAICS"
            style={{ width: 110 }}
            value={naics}
            onChange={(event) => patch({ naics: event.target.value })}
            aria-label="NAICS code"
          />
          <input
            className="capiro-input fov-filter-input"
            placeholder="PSC"
            style={{ width: 100 }}
            value={psc}
            onChange={(event) => patch({ psc: event.target.value })}
            aria-label="PSC code"
          />
          <input
            className="capiro-input fov-filter-input"
            placeholder="Set-aside"
            style={{ width: 140 }}
            value={setAside}
            onChange={(event) => patch({ setAside: event.target.value })}
            aria-label="Set-aside"
          />
          <FovMultiSelect
            label="Notice type"
            placeholder="Notice type"
            options={KIND_OPTIONS}
            value={kinds}
            onChange={(value) => patch({ kind: value.join(',') })}
          />
          <FovMultiSelect
            label="Eligibility"
            placeholder="Eligibility"
            options={ELIGIBILITY_OPTIONS}
            value={eligibility}
            onChange={(value) => patch({ eligibility: value.join(',') })}
          />
          <input
            type="number"
            className="capiro-input fov-filter-input"
            min={0}
            max={100}
            placeholder="Min relevance"
            style={{ width: 130 }}
            value={minRelevance ?? ''}
            onChange={(event) =>
              patch({ minRelevance: event.target.value === '' ? null : Number(event.target.value) })
            }
            aria-label="Minimum relevance"
          />
        </div>
      </FovCard>

      {listQuery.isError ? (
        <div data-testid="fo-error">
          <FovAlert
            tone="error"
            message="Funding opportunities failed to load"
            description="This is a request failure, not an empty result. No conclusion can be drawn about how many opportunities exist."
            action={
              <CapiroButton size="compact" onClick={() => void listQuery.refetch()}>
                Retry
              </CapiroButton>
            }
          />
        </div>
      ) : listQuery.isPending ? (
        <div data-testid="fo-loading">
          <FovSkeletonRows rows={8} />
        </div>
      ) : (data?.opportunities.length ?? 0) === 0 ? (
        <FovCard testId="fo-empty">
          <div className="fov-empty">
            <span className="fov-empty__title">No opportunities to show</span>
            <span className="fov-muted">
              {data?.emptyExplanation ?? 'No opportunities match the current filters.'}
            </span>
            {data?.missingProfileFields?.length ? (
              <div style={{ marginTop: 12, textAlign: 'left' }}>
                <span className="fov-empty__title" style={{ fontSize: 12 }}>
                  What would improve matching for this client:
                </span>
                <ul className="fov-gaps">
                  {data.missingProfileFields.map((field) => (
                    <li key={field.field}>
                      {field.href ? <a href={field.href}>{field.label}</a> : field.label} —{' '}
                      {field.impact}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        </FovCard>
      ) : (
        <>
          <div className="fov-stack fov-stack--10">
            {data!.opportunities.map((opportunity) => (
              <OpportunityCard
                key={opportunity.id}
                opportunity={opportunity}
                clientId={clientId ?? null}
                busy={workflowMutation.isPending || editorMutation.isPending}
                onSave={(value) => workflowMutation.mutate({ o: value, action: 'save' })}
                onPursue={(value) => workflowMutation.mutate({ o: value, action: 'pursue' })}
                onDismiss={(value) => workflowMutation.mutate({ o: value, action: 'dismiss' })}
                onRestore={(value) => workflowMutation.mutate({ o: value, action: 'restore' })}
                onAssign={(value) => openEditor('assign', value)}
                onNote={(value) => openEditor('note', value)}
                onLinkSite={(value) => openEditor('site', value)}
                onCreateTask={(value) => openEditor('task', value)}
                onAskMeri={askMeriAboutOpportunity}
              />
            ))}
          </div>
          <div className="fov-pager">
            <span className="fov-muted">
              Showing {data!.opportunities.length} of {data!.total}
              {data!.totalIsCapped ? '+ (scan bound reached — narrow the filters to see more)' : ''}
            </span>
            <span className="fov-row">
              <CapiroButton
                size="compact"
                disabled={page <= 1}
                onClick={() => url.set({ page: page - 1 <= 1 ? null : page - 1 })}
              >
                Previous
              </CapiroButton>
              <CapiroButton
                size="compact"
                disabled={page * data!.pageSize >= data!.total}
                onClick={() => url.set({ page: page + 1 })}
              >
                Next
              </CapiroButton>
            </span>
          </div>
        </>
      )}

      <FovModal
        open={editor != null}
        title={editorTitle(editor?.action)}
        onCancel={() => setEditor(null)}
        onOk={() => editorMutation.mutate()}
        okLoading={editorMutation.isPending}
        okDisabled={
          (editor?.action === 'assign' && !ownerUserId) ||
          (editor?.action === 'site' && !facilityId)
        }
      >
        {editor?.action === 'assign' || editor?.action === 'task' ? (
          <select
            className="capiro-select"
            style={{ width: '100%', marginBottom: 12 }}
            value={ownerUserId ?? ''}
            onChange={(event) => setOwnerUserId(event.target.value || null)}
            aria-label="Opportunity owner"
          >
            <option value="">
              {editor.action === 'task' ? 'Task owner (optional)' : 'Select owner'}
            </option>
            {(members.data ?? []).map((member) => (
              <option key={member.id} value={member.id}>
                {`${member.name} (${member.email})`}
              </option>
            ))}
          </select>
        ) : null}
        {editor?.action === 'site' ? (
          <select
            className="capiro-select"
            style={{ width: '100%' }}
            value={facilityId ?? ''}
            onChange={(event) => setFacilityId(event.target.value || null)}
            aria-label="Project site"
          >
            <option value="">Select a client facility</option>
            {(facilities.data ?? []).map((facility) => (
              <option key={facility.id} value={facility.id}>
                {[facility.name, facility.city, facility.state].filter(Boolean).join(' · ')}
              </option>
            ))}
          </select>
        ) : null}
        {editor?.action === 'note' || editor?.action === 'task' ? (
          <textarea
            className="capiro-input"
            rows={5}
            style={{ width: '100%', resize: 'vertical' }}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder={
              editor.action === 'task' ? 'Additional task context (optional)' : 'Add a team note'
            }
            maxLength={4000}
            aria-label={editor.action === 'task' ? 'Task context' : 'Opportunity note'}
          />
        ) : null}
      </FovModal>
    </div>
  );
}

/**
 * Search commits on Enter or the button — the same commit-on-search contract
 * antd's Input.Search carried (typing does not re-query on every keystroke).
 */
function SearchField({ value, onSearch }: { value: string; onSearch: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  return (
    <span className="fov-row" style={{ gap: 4 }}>
      <input
        className="capiro-input fov-filter-input"
        placeholder="Search title, agency or reference…"
        style={{ width: 240 }}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onSearch(draft);
        }}
        aria-label="Search opportunities"
      />
      <CapiroButton size="compact" onClick={() => onSearch(draft)} aria-label="Search">
        Search
      </CapiroButton>
    </span>
  );
}

function editorTitle(action: EditorAction | undefined): string {
  if (action === 'assign') return 'Assign opportunity owner';
  if (action === 'site') return 'Link a reviewed project site';
  if (action === 'task') return 'Create pursuit task';
  return 'Add opportunity note';
}

function Kpi({
  label,
  value,
  loading,
}: {
  label: string;
  value: number | undefined;
  loading: boolean;
}) {
  return (
    <div className="fov-kpi">
      <div className="fov-kpi__label">{label}</div>
      <div className="fov-kpi__value">
        {loading ? <CapiroSkeleton width={48} height={20} /> : (value ?? '—')}
      </div>
    </div>
  );
}

/**
 * Local copy of the canonical Explore's `apiErrorMessage` — that export lives
 * in the antd Explore file, and this eight-line generic error formatter is not
 * worth an extraction module of its own.
 */
export function apiErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const data = (error as { response?: { data?: { message?: unknown } } }).response?.data;
    if (typeof data?.message === 'string') return data.message;
    if (Array.isArray(data?.message)) return data.message.join(', ');
  }
  return error instanceof Error ? error.message : 'Request failed';
}
