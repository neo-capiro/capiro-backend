import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Empty,
  Input,
  InputNumber,
  Modal,
  Segmented,
  Select,
  Skeleton,
  Space,
  Typography,
} from 'antd';
import { useApi } from '../../../lib/use-api.js';
import { requestMeriContextPrompt } from '../../../components/chat/meri-prompt.js';
import { OpportunityCard } from './OpportunityCard.js';
import { OpportunityFreshnessStrip } from './OpportunityFreshnessStrip.js';
import {
  readEnum,
  readEnumList,
  readInt,
  useUrlState,
} from './funding-opportunities-url-state.js';
import {
  ELIGIBILITY_LABELS,
  KIND_LABELS,
  type EligibilityState,
  type FundingOpportunity,
  type FundingOpportunityListResponse,
  type OpportunityKind,
} from './funding-opportunities-api.js';

const { Text } = Typography;
const { TextArea } = Input;

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
 * `Explore federal opportunities` — the raw source catalog.
 *
 * ── What changed in P11, and what deliberately did not ───────────────────────
 *
 * This IS the page that used to be the whole surface, moved intact behind a
 * second-class tab. It is a RESEARCH TOOL: one row per source record, scored
 * against a client if one is selected, with the full filter set. Nothing about
 * how it reads the catalog, scores it, or renders money and eligibility changed —
 * the honesty rules it carries (no blended total, null money is never `$0`,
 * relevance and eligibility stay separate, a failed request is not an empty list)
 * are the same code as before.
 *
 * TWO things did change:
 *
 *  1. It is no longer the DEFAULT. "No client selected, here is the entire federal
 *     catalog" was the opening screen, and it is the thing this program exists to
 *     stop being the answer to "what should my team do today".
 *
 *  2. Its tab, filters and page number moved from component state into the URL, so
 *     a refresh or a shared link restores the view instead of silently resetting
 *     to All/page 1.
 */
export function FundingOpportunityExplore({ clientId }: { clientId: string | undefined }) {
  const api = useApi();
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
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

  // Every filter change resets to page 1. A filter applied on page 7 of the old
  // result set lands the reader on a page that may not exist in the new one.
  const patch = (next: Record<string, string | number | null | undefined>) =>
    url.set({ ...next, page: null });

  const [editor, setEditor] = useState<{ action: EditorAction; opportunity: FundingOpportunity } | null>(
    null,
  );
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
      (await api.get<FacilityLite[]>(`/api/clients/${encodeURIComponent(clientId!)}/facilities`)).data,
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
      (await api.get<FundingOpportunityListResponse>(`/api/intelligence/opportunities?${query}`)).data,
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
      notification.success({
        message:
          input.action === 'dismiss'
            ? 'Dismissed'
            : input.action === 'restore'
              ? 'Restored'
              : input.action === 'pursue'
                ? 'Marked as pursuing'
                : 'Saved',
        description: input.o.title,
      });
      invalidate();
    },
    onError: (err) =>
      notification.error({ message: 'Action failed', description: apiErrorMessage(err) }),
  });

  const editorMutation = useMutation({
    mutationFn: async () => {
      if (!clientId || !editor) throw new Error('Select a client first.');
      const o = editor.opportunity;
      const base = `/api/intelligence/clients/${clientId}/opportunities/${o.source}/${o.sourceRecordId}`;
      if (editor.action === 'task') {
        // ONE atomic server action since P08, replacing a direct POST to
        // /api/engagement/tasks. That call created a task titled "Pursue: X" and
        // changed nothing else, so a task saying "pursue this" could exist while the
        // opportunity was still an untouched machine suggestion — two facts in two
        // tables written by two requests, either able to succeed alone.
        //
        // The server derives the title, description, due date and the idempotency
        // key. Sending them from here is what let the two drift apart, and it is why
        // the task's due date and the opportunity's next-action date could disagree.
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
      notification.success({
        message:
          editor?.action === 'assign'
            ? 'Owner assigned'
            : editor?.action === 'site'
              ? 'Project site linked'
              : editor?.action === 'task'
                ? 'Task created'
                : 'Note saved',
        description: editor?.opportunity.title,
      });
      setEditor(null);
      invalidate();
    },
    onError: (err) =>
      notification.error({ message: 'Action failed', description: apiErrorMessage(err) }),
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
    <div className="fo-explore" data-testid="fo-explore">
      <OpportunityFreshnessStrip freshness={data?.freshness} />

      {!clientId ? (
        <div data-testid="fo-no-client">
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message="Showing the raw opportunity catalog"
            description="Pick a client to calculate relevance and eligibility or to save and pursue opportunities."
          />
        </div>
      ) : null}

      <div className="fo-kpis" data-testid="fo-kpis">
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

      <Segmented<ExploreTab>
        block
        value={tab}
        onChange={(value) => patch({ tab: value === 'all' ? null : value })}
        options={TABS}
        // Named because two of the tab labels ("Saved", "Pursuing") are also KPI
        // tile labels a few lines above, so neither a screen reader nor a test can
        // tell the tab from the count without it.
        aria-label="Opportunity workflow tab"
        style={{ margin: '12px 0' }}
      />

      <Card size="small" style={{ marginBottom: 12 }}>
        <div className="fo-filters">
          <Input.Search
            allowClear
            placeholder="Search title, agency or reference…"
            style={{ width: 240 }}
            defaultValue={search}
            onSearch={(value) => patch({ q: value })}
            aria-label="Search opportunities"
          />
          <Input allowClear placeholder="Agency" style={{ width: 160 }} value={agency} onChange={(event) => patch({ agency: event.target.value })} aria-label="Agency" />
          <Input allowClear placeholder="NAICS" style={{ width: 110 }} value={naics} onChange={(event) => patch({ naics: event.target.value })} aria-label="NAICS code" />
          <Input allowClear placeholder="PSC" style={{ width: 100 }} value={psc} onChange={(event) => patch({ psc: event.target.value })} aria-label="PSC code" />
          <Input allowClear placeholder="Set-aside" style={{ width: 140 }} value={setAside} onChange={(event) => patch({ setAside: event.target.value })} aria-label="Set-aside" />
          <Select allowClear mode="multiple" placeholder="Notice type" style={{ minWidth: 200 }} value={kinds} onChange={(value) => patch({ kind: value.join(',') })} options={KIND_OPTIONS} aria-label="Notice type" />
          <Select allowClear mode="multiple" placeholder="Eligibility" style={{ minWidth: 170 }} value={eligibility} onChange={(value) => patch({ eligibility: value.join(',') })} options={ELIGIBILITY_OPTIONS} aria-label="Eligibility" />
          <InputNumber min={0} max={100} placeholder="Min relevance" style={{ width: 130 }} value={minRelevance} onChange={(value) => patch({ minRelevance: value ?? null })} aria-label="Minimum relevance" />
        </div>
      </Card>

      {listQuery.isError ? (
        <div data-testid="fo-error">
          <Alert
            type="error"
            showIcon
            message="Funding opportunities failed to load"
            description="This is a request failure, not an empty result. No conclusion can be drawn about how many opportunities exist."
            action={<Button size="small" onClick={() => void listQuery.refetch()}>Retry</Button>}
          />
        </div>
      ) : listQuery.isPending ? (
        <div data-testid="fo-loading"><Skeleton active paragraph={{ rows: 8 }} /></div>
      ) : (data?.opportunities.length ?? 0) === 0 ? (
        <Card size="small" data-testid="fo-empty">
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={null}>
            <div style={{ maxWidth: 560, margin: '0 auto', textAlign: 'center' }}>
              <Text strong>No opportunities to show</Text>
              <div><Text type="secondary" style={{ fontSize: 12 }}>{data?.emptyExplanation ?? 'No opportunities match the current filters.'}</Text></div>
              {data?.missingProfileFields?.length ? (
                <div style={{ marginTop: 12, textAlign: 'left' }}>
                  <Text strong style={{ fontSize: 12 }}>What would improve matching for this client:</Text>
                  <ul className="fo-gaps">
                    {data.missingProfileFields.map((field) => (
                      <li key={field.field}>{field.href ? <a href={field.href}>{field.label}</a> : field.label} — {field.impact}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </Empty>
        </Card>
      ) : (
        <>
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
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
          </Space>
          <div className="fo-pager">
            <Text type="secondary" style={{ fontSize: 12 }}>
              Showing {data!.opportunities.length} of {data!.total}
              {data!.totalIsCapped ? '+ (scan bound reached — narrow the filters to see more)' : ''}
            </Text>
            <Space>
              <Button size="small" disabled={page <= 1} onClick={() => url.set({ page: page - 1 <= 1 ? null : page - 1 })}>Previous</Button>
              <Button size="small" disabled={page * data!.pageSize >= data!.total} onClick={() => url.set({ page: page + 1 })}>Next</Button>
            </Space>
          </div>
        </>
      )}

      <Modal
        open={editor != null}
        title={editorTitle(editor?.action)}
        onCancel={() => setEditor(null)}
        onOk={() => editorMutation.mutate()}
        confirmLoading={editorMutation.isPending}
        okButtonProps={{
          disabled:
            (editor?.action === 'assign' && !ownerUserId) ||
            (editor?.action === 'site' && !facilityId),
        }}
        destroyOnClose
      >
        {editor?.action === 'assign' || editor?.action === 'task' ? (
          <Select
            allowClear
            showSearch
            style={{ width: '100%', marginBottom: 12 }}
            placeholder={editor.action === 'task' ? 'Task owner (optional)' : 'Select owner'}
            value={ownerUserId}
            onChange={(value) => setOwnerUserId(value ?? null)}
            options={(members.data ?? []).map((member) => ({
              label: `${member.name} (${member.email})`,
              value: member.id,
            }))}
            aria-label="Opportunity owner"
          />
        ) : null}
        {editor?.action === 'site' ? (
          <Select
            allowClear
            showSearch
            style={{ width: '100%' }}
            placeholder="Select a client facility"
            value={facilityId}
            onChange={(value) => setFacilityId(value ?? null)}
            options={(facilities.data ?? []).map((facility) => ({
              label: [facility.name, facility.city, facility.state].filter(Boolean).join(' · '),
              value: facility.id,
            }))}
            aria-label="Project site"
          />
        ) : null}
        {editor?.action === 'note' || editor?.action === 'task' ? (
          <TextArea
            rows={5}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder={editor.action === 'task' ? 'Additional task context (optional)' : 'Add a team note'}
            maxLength={4000}
            aria-label={editor.action === 'task' ? 'Task context' : 'Opportunity note'}
          />
        ) : null}
      </Modal>
    </div>
  );
}

function editorTitle(action: EditorAction | undefined): string {
  if (action === 'assign') return 'Assign opportunity owner';
  if (action === 'site') return 'Link a reviewed project site';
  if (action === 'task') return 'Create pursuit task';
  return 'Add opportunity note';
}

function Kpi({ label, value, loading }: { label: string; value: number | undefined; loading: boolean }) {
  return (
    <div className="fo-kpi">
      <div className="fo-kpi__label">{label}</div>
      <div className="fo-kpi__value">{loading ? <Skeleton.Button active size="small" /> : (value ?? '—')}</div>
    </div>
  );
}

export function apiErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const data = (error as { response?: { data?: { message?: unknown } } }).response?.data;
    if (typeof data?.message === 'string') return data.message;
    if (Array.isArray(data?.message)) return data.message.join(', ');
  }
  return error instanceof Error ? error.message : 'Request failed';
}
