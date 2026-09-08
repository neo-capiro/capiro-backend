import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CapiroButton } from '../../components/actions/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import {
  readEnum,
  useUrlState,
} from '../../../pages/intelligence/opportunities/funding-opportunities-url-state.js';
import {
  ELIGIBILITY_LABELS,
  FUNDING_OPPORTUNITIES_FORECASTS_FEATURE,
  FUNDING_OPPORTUNITIES_SBIR_FEATURE,
  decodeOpportunityRef,
  encodeOpportunityRef,
  INBOX_FILTERS,
  INBOX_FILTER_LABELS,
  INBOX_SOURCE_SHORT_LABELS,
  PIPELINE_STAGE_LABELS,
  WORKFLOW_LABELS,
  formatDeadline,
  formatInboxCount,
  formatSourceDate,
  type EligibilityState,
  type FundingOpportunityListResponse,
  type InboxFilter,
  type InboxResponse,
  type InboxRow,
  type InboxSource,
  type PipelineStageView,
} from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';
import { refreshOpportunityQueries, sourceWebUrl } from './opportunity-query-cache.js';
import {
  isFitSignal,
  signalLabel,
} from '../../../pages/intelligence/opportunities/opportunity-explanations.js';
import { FundingOpportunityDrawer } from './FundingOpportunityDrawer.js';
import { OpportunityFreshnessStrip } from './OpportunityFreshnessStrip.js';
import { FovAlert, FovCard, FovPill, FovSkeletonRows } from './fov-ui.js';

const LABELS: Partial<Record<InboxFilter, string>> = {
  suggested: 'New recommendations',
  tracked: 'All tracked',
  saved: 'Saved & watching',
  pursuing: 'Pursuing',
  tracked_deadlines: 'Due soon & overdue',
  deadlines: 'Response deadlines',
  completed: 'Completed',
  passed: 'Passed',
};

/** One server-paginated client list for recommendations and tracked work. */
export function FundingOpportunityInbox({
  clientId,
  clientName,
  onSelectClient,
  mode = 'recommended',
}: {
  clientId: string | undefined;
  clientName: string | undefined;
  onSelectClient: (id: string | undefined) => void;
  mode?: 'recommended' | 'tracking';
}) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useCapiroToast();
  const url = useUrlState();
  const forecasts = useIntelFeature(FUNDING_OPPORTUNITIES_FORECASTS_FEATURE);
  const sbir = useIntelFeature(FUNDING_OPPORTUNITIES_SBIR_FEATURE);
  const sourceOptions: InboxSource[] = [
    'sam_gov',
    'grants_gov',
    'dibbs',
    ...(forecasts.ready && forecasts.enabled ? ['agency_forecast' as const] : []),
    ...(sbir.ready && sbir.enabled ? ['sbir_sttr' as const] : []),
  ];
  const source = readEnum<InboxSource | ''>(url.get('source'), [...sourceOptions, ''], '');
  const defaultFilter: InboxFilter = mode === 'tracking' ? 'tracked' : 'suggested';
  const filter = readEnum<InboxFilter>(
    url.get('filter'),
    mode === 'tracking'
      ? ['tracked', 'saved', 'pursuing', 'tracked_deadlines', 'completed', 'passed', 'monitoring']
      : INBOX_FILTERS,
    defaultFilter,
  );
  const sort = readEnum<'updated' | 'deadline'>(
    url.get('sort'),
    ['updated', 'deadline'],
    source === 'agency_forecast' || mode === 'recommended' ? 'updated' : 'deadline',
  );
  const cursor = url.get('cursor');
  const openRef = decodeOpportunityRef(url.get('detail'));
  const [trail, setTrail] = useState<string[]>([]);
  const params = new URLSearchParams({ filter, sort });
  if (clientId) params.set('clientId', clientId);
  if (source) params.set('source', source);
  if (cursor) params.set('cursor', cursor);
  const queryString = params.toString();
  const inbox = useQuery<InboxResponse>({
    queryKey: ['funding-opportunity-inbox', queryString],
    queryFn: async () =>
      (await api.get<InboxResponse>(`/api/intelligence/opportunities/inbox?${queryString}`)).data,
    retry: 1,
    staleTime: 15_000,
    enabled: forecasts.ready && sbir.ready,
  });
  const freshness = useQuery<FundingOpportunityListResponse>({
    queryKey: ['funding-opportunities-freshness'],
    queryFn: async () =>
      (
        await api.get<FundingOpportunityListResponse>(
          '/api/intelligence/opportunities?pageSize=1&activeState=active',
        )
      ).data,
    retry: 1,
    staleTime: 60_000,
  });
  const data = inbox.data;
  // Scope is the server's applied scope. A rejected client may never remain in
  // the heading while cross-client results render beneath it.
  const scopeMismatch = Boolean(data && (data.clientId ?? undefined) !== clientId);
  useEffect(() => {
    setTrail([]);
  }, [clientId, filter, source, sort]);

  const save = useMutation({
    mutationFn: async (row: InboxRow) =>
      api.post(
        `/api/intelligence/clients/${encodeURIComponent(row.client.id)}/opportunities/${row.source}/${encodeURIComponent(row.sourceRecordId)}/save`,
        { status: 'saved' },
      ),
    onSuccess: async (_result, row) => {
      await refreshOpportunityQueries(qc);
      toast.success(`Saved for ${row.client.name}. Find it in Tracking.`);
    },
    onError: () => toast.error('This opportunity could not be saved. Please try again.'),
  });
  const rows = (data?.rows ?? []).filter((row) => sourceOptions.includes(row.source));
  const withheld = (data?.rows.length ?? 0) - rows.length;
  const visibleRows = scopeMismatch ? [] : rows;
  const primaryFilters: InboxFilter[] =
    mode === 'tracking'
      ? ['tracked', 'saved', 'pursuing', 'tracked_deadlines', 'completed']
      : ['suggested'];
  const filters = primaryFilters.includes(filter) ? primaryFilters : [...primaryFilters, filter];
  const label = LABELS[filter] ?? INBOX_FILTER_LABELS[filter];
  const openDetail = (row: InboxRow) =>
    url.set({
      detail: encodeOpportunityRef({
        source: row.source,
        sourceRecordId: row.sourceRecordId,
        clientId: row.client.id,
      }),
    });

  function exportPage() {
    if (!visibleRows.length) return;
    const cell = (value: unknown) => {
      const text = String(value ?? '');
      const safe = /^[=+@-]/.test(text) ? `'${text}` : text;
      return `"${safe.replaceAll('"', '""')}"`;
    };
    const records = [
      [
        'Client',
        'Opportunity',
        'Source',
        'Source record',
        'Status',
        'Decision',
        'Recorded stage',
        'Owner',
        'Next action',
        'Follow-up date',
        'Response deadline',
        'Estimated forecast award',
      ],
      ...visibleRows.map((row) => [
        row.client.name,
        row.title,
        row.source,
        row.sourceRecordId,
        row.workflowStatus,
        row.humanDecision,
        row.pipelineStage,
        row.owner?.name ?? row.owner?.email,
        row.nextAction,
        row.nextActionDueAt,
        row.source === 'agency_forecast' ? '' : row.responseDeadline,
        row.forecast?.anticipatedAwardDate,
      ]),
    ];
    const objectUrl = URL.createObjectURL(
      new Blob([records.map((record) => record.map(cell).join(',')).join('\r\n')], {
        type: 'text/csv;charset=utf-8',
      }),
    );
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = `funding-opportunities-${mode}-current-page.csv`;
    link.click();
    URL.revokeObjectURL(objectUrl);
    toast.success(`Exported ${visibleRows.length} client matches from this page.`);
  }

  return (
    <div
      className="fov-inbox fov-stack fov-stack--10"
      data-testid={mode === 'tracking' ? 'fo-tracking' : 'fo-inbox'}
    >
      <OpportunityFreshnessStrip freshness={freshness.data?.freshness} />
      {freshness.isError ? (
        <FovAlert
          tone="warning"
          message="Source freshness could not be checked"
          description="You can still review stored records. Check the source before acting."
        />
      ) : null}
      {scopeMismatch ? (
        <FovAlert
          tone="warning"
          message="That client filter could not be applied"
          description="Choose another client or clear the filter to view all accessible clients."
          action={
            <CapiroButton onClick={() => onSelectClient(data?.clientId ?? undefined)}>
              Clear client filter
            </CapiroButton>
          }
        />
      ) : null}
      <div className="fov-inbox__controls">
        <label>
          <span className="fov-filter-label">Opportunity feed</span>
          <select
            className="capiro-select fov-filter-input"
            value={source}
            onChange={(event) =>
              url.set({
                source: event.target.value || null,
                cursor: null,
                sort: event.target.value === 'agency_forecast' ? 'updated' : null,
              })
            }
            aria-label="Opportunity feed"
          >
            <option value="">All available feeds</option>
            {sourceOptions.map((value) => (
              <option key={value} value={value}>
                {INBOX_SOURCE_SHORT_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        {mode === 'tracking' || filter !== 'suggested' ? (
          <label>
            <span className="fov-filter-label">Show</span>
            <select
              className="capiro-select fov-filter-input"
              value={filter}
              onChange={(event) => url.set({ filter: event.target.value, cursor: null })}
              aria-label="Tracked opportunities"
            >
              {filters.map((value) => (
                <option key={value} value={value}>
                  {LABELS[value] ?? INBOX_FILTER_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          <span className="fov-filter-label">Sort</span>
          <select
            className="capiro-select fov-filter-input"
            value={source === 'agency_forecast' ? 'updated' : sort}
            onChange={(event) => url.set({ sort: event.target.value, cursor: null })}
            aria-label="Sort opportunities"
            disabled={source === 'agency_forecast'}
          >
            <option value="updated">Recently updated</option>
            <option value="deadline">Response deadline</option>
          </select>
        </label>
      </div>
      <p className="fov-micro" aria-live="polite">
        {mode === 'recommended' && filter === 'suggested'
          ? 'New matches for your clients. Save an opportunity to keep it in Tracking.'
          : label}
        {data && !data.countsUnavailableReason
          ? ` · ${formatInboxCount(data.counts[filter])} client matches`
          : ''}
      </p>
      {data?.countsUnavailableReason ? (
        <FovAlert
          tone="warning"
          message="Match counts are temporarily unavailable"
          description="The results below can still be reviewed."
        />
      ) : null}
      {withheld > 0 ? (
        <FovAlert
          tone="warning"
          testId="fo-inbox-source-withheld"
          message="Some results are unavailable in this workspace"
          description="Refresh to update the available feeds. You can continue to the next page."
        />
      ) : null}
      {inbox.isError ? (
        <FovAlert
          tone="error"
          testId="fo-inbox-error"
          message={
            mode === 'tracking'
              ? 'Tracked opportunities could not be loaded'
              : 'Recommendations could not be loaded'
          }
          description="Please retry to see the current results."
          action={<CapiroButton onClick={() => void inbox.refetch()}>Retry</CapiroButton>}
        />
      ) : inbox.isPending ? (
        <div data-testid="fo-inbox-loading">
          <FovSkeletonRows rows={5} />
        </div>
      ) : scopeMismatch ? null : visibleRows.length === 0 ? (
        <FovCard testId="fo-inbox-empty">
          <div className="fov-empty">
            <strong>
              {cursor
                ? 'No results on this page'
                : mode === 'tracking'
                  ? filter === 'tracked'
                    ? `Not currently tracking opportunities${clientName ? ` for ${clientName}` : ''}`
                    : `No ${label.toLowerCase()} opportunities${clientName ? ` for ${clientName}` : ''}`
                  : 'No new recommendations in this view'}
            </strong>
            <p className="fov-muted">
              {cursor
                ? 'Return to the first page or continue to the next page.'
                : mode === 'tracking'
                  ? 'Save or watch an opportunity from Recommended or Browse to find it here.'
                  : 'Try another feed or Browse to search the source records. A quiet recommendations list does not mean there are no relevant opportunities.'}
            </p>
            {source ? (
              <CapiroButton onClick={() => url.set({ source: null, cursor: null })}>
                Show all feeds
              </CapiroButton>
            ) : null}
            {mode === 'tracking' && filter !== 'tracked' ? (
              <CapiroButton onClick={() => url.set({ filter: 'tracked', cursor: null })}>
                Show all tracked
              </CapiroButton>
            ) : null}
            <CapiroButton
              onClick={() =>
                url.set({
                  view: 'explore',
                  filter: null,
                  cursor: null,
                  detail: null,
                })
              }
            >
              Browse opportunities
            </CapiroButton>
          </div>
        </FovCard>
      ) : (
        <div className="fov-stack fov-stack--10">
          {visibleRows.map((row) => (
            <OpportunityRow
              key={row.id}
              row={row}
              tracking={mode === 'tracking'}
              onSelectClient={onSelectClient}
              onOpenDetail={() => openDetail(row)}
              onSave={() => save.mutate(row)}
              saving={save.isPending && save.variables?.id === row.id}
            />
          ))}
        </div>
      )}
      {mode === 'tracking' && visibleRows.length > 0 ? (
        <div className="fov-row">
          <CapiroButton size="compact" onClick={exportPage}>
            Export this page
          </CapiroButton>
          <span className="fov-micro">
            Includes only the current {visibleRows.length} results and filters.
          </span>
        </div>
      ) : null}
      {/* Pagination is independent of visible rows: stale links and defensive
          capability filtering must not strand a reader on an empty page. */}
      {data && !inbox.isError && !scopeMismatch ? (
        <div className="fov-pager">
          <span className="fov-muted">
            Showing {visibleRows.length} client matches on this page
          </span>
          <span className="fov-row">
            {cursor ? (
              <CapiroButton
                size="compact"
                onClick={() => {
                  setTrail([]);
                  url.set({ cursor: null });
                }}
              >
                First page
              </CapiroButton>
            ) : null}
            <CapiroButton
              size="compact"
              disabled={trail.length === 0 || inbox.isFetching}
              onClick={() => {
                const previous = trail[trail.length - 1];
                setTrail((value) => value.slice(0, -1));
                url.set({ cursor: previous || null });
              }}
            >
              Previous
            </CapiroButton>
            <CapiroButton
              size="compact"
              disabled={!data.nextCursor || inbox.isFetching}
              onClick={() => {
                setTrail((value) => [...value, cursor ?? '']);
                url.set({ cursor: data.nextCursor });
              }}
            >
              Next
            </CapiroButton>
          </span>
        </div>
      ) : null}
      <FundingOpportunityDrawer refValue={openRef} onClose={() => url.set({ detail: null })} />
    </div>
  );
}

/** Render only evidence persisted by the scorer, never a generated fit claim. */
function fitReasons(row: InboxRow): string[] {
  return (row.matchSignals ?? [])
    .flatMap((signal: unknown) => {
      if (!signal || typeof signal !== 'object') return [];
      const record = signal as Record<string, unknown>;
      const matchedOn =
        typeof record.matchedOn === 'string'
          ? record.matchedOn
          : typeof record.matchedValue === 'string'
            ? record.matchedValue
            : null;
      const kind =
        typeof record.signal === 'string'
          ? record.signal
          : typeof record.key === 'string'
            ? record.key
            : '';
      if (
        !matchedOn ||
        !isFitSignal({
          signal: kind,
          weight: typeof record.weight === 'number' ? record.weight : undefined,
        }) ||
        /applicant|eligib|geograph|small.business/i.test(kind)
      )
        return [];
      const labels: Record<string, string> = {
        exactNaics: 'NAICS match',
        exactNaicsMatch: 'NAICS match',
        priorAssistanceListing: 'Prior grant program',
        priorAgency: 'Agency history',
        exactPsc: 'PSC match',
      };
      const label =
        labels[kind] ??
        signalLabel(
          kind,
          record.source === 'funding_priority' || record.source === 'capability'
            ? record.source
            : undefined,
        );
      const displayLabel =
        label === 'Unrecognized match signal'
          ? kind
              .replace(/([a-z])([A-Z])/g, '$1 $2')
              .replaceAll('_', ' ')
              .toLowerCase()
          : label;
      return [
        `${displayLabel ? displayLabel[0]!.toUpperCase() + displayLabel.slice(1) : 'Matched evidence'}: ${matchedOn}`,
      ];
    })
    .slice(0, 2);
}

function OpportunityRow({
  row,
  tracking,
  onSelectClient,
  onOpenDetail,
  onSave,
  saving,
}: {
  row: InboxRow;
  tracking: boolean;
  onSelectClient: (id: string) => void;
  onOpenDetail: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  const forecast = row.source === 'agency_forecast';
  const sourceFacts = row.forecast ?? row.dibbs ?? row.sbir;
  const sourceUrl =
    row.dibbs?.documentUrl ?? row.sbir?.topicUrl ?? row.sbir?.officialSolicitationUrl;
  const validSourceUrl = sourceWebUrl(sourceUrl);
  const reasons = fitReasons(row);
  const workflowLabel =
    WORKFLOW_LABELS[row.workflowStatus as keyof typeof WORKFLOW_LABELS] ?? row.workflowStatus;
  const terminal = ['won', 'lost', 'dismissed', 'expired'].includes(row.workflowStatus);
  const status = terminal
    ? workflowLabel
    : row.humanDecision === 'monitor'
      ? 'Watching'
      : row.humanDecision === 'pass'
        ? 'Passed'
        : row.humanDecision === 'pursue'
          ? 'Pursuing'
          : workflowLabel;
  const canSave = row.workflowStatus === 'suggested' && row.humanDecision == null;
  const estimate =
    row.forecast?.anticipatedSolicitationDate ?? row.forecast?.anticipatedAwardDate ?? null;
  const timingLabel = forecast
    ? row.forecast?.anticipatedSolicitationDate
      ? 'Estimated solicitation'
      : 'Estimated award'
    : row.source === 'dibbs'
      ? 'Quote return date'
      : 'Response deadline';
  const timing = forecast
    ? formatSourceDate(estimate, row.forecast?.estimatedPeriod ?? 'Not stated by the agency')
    : row.dibbs
      ? formatSourceDate(row.dibbs.closesDate, 'Not stated')
      : row.sbir
        ? formatSourceDate(row.sbir.closeDate, 'Not stated')
        : formatDeadline(row.responseDeadline, null).text;
  return (
    <FovCard className="fo-simple-row" testId={`fo-inbox-row-${row.id}`}>
      <div className="fov-inbox-row__head fov-row">
        <button
          type="button"
          className="fov-inbox-row__client"
          onClick={() => onSelectClient(row.client.id)}
          aria-label={`Show only ${row.client.name}`}
        >
          {row.client.name}
        </button>
        <FovPill>{INBOX_SOURCE_SHORT_LABELS[row.source]}</FovPill>
        {row.sourceClosed ? (
          <FovPill tone="red">{forecast ? 'Withdrawn by the agency' : 'Source closed'}</FovPill>
        ) : status !== 'Suggested' ? (
          <FovPill>{status}</FovPill>
        ) : null}
      </div>
      <button
        type="button"
        className="fov-inbox-row__title"
        onClick={onOpenDetail}
        aria-label={`Open detail for ${row.title}`}
      >
        {row.title}
      </button>
      <p className="fov-muted fo-simple-row__agency">{row.agency ?? 'Agency not stated'}</p>
      <div className="fo-simple-row__facts">
        <span>
          <span className="fov-filter-label">{timingLabel}</span>
          {timing}
        </span>
        {row.source === 'sam_gov' || row.source === 'grants_gov' ? (
          <span>
            <span className="fov-filter-label">Last assessed eligibility</span>
            {row.eligibility.state
              ? (ELIGIBILITY_LABELS[row.eligibility.state as EligibilityState] ??
                row.eligibility.state)
              : 'Not evaluated'}
          </span>
        ) : forecast ? (
          <span className="fov-muted">Agency planning estimate · not an open application</span>
        ) : row.dibbs ? (
          <span>
            <span className="fov-filter-label">Item</span>
            {row.dibbs.nsn ??
              row.dibbs.partNumber ??
              row.dibbs.nomenclature ??
              'See source specifications'}
          </span>
        ) : row.sbir ? (
          <span>
            <span className="fov-filter-label">Program</span>
            {row.sbir.cycle?.program ?? 'See source requirements'}
          </span>
        ) : null}
        {tracking ? (
          <>
            <span>
              <span className="fov-filter-label">Owner</span>
              {row.owner?.name ?? row.owner?.email ?? 'Unassigned'}
            </span>
            <span>
              <span className="fov-filter-label">Stage</span>
              {row.pipelineStage
                ? (PIPELINE_STAGE_LABELS[row.pipelineStage as PipelineStageView] ??
                  row.pipelineStage)
                : 'No stage recorded'}
            </span>
          </>
        ) : null}
      </div>
      {reasons.length ? (
        <div className="fo-simple-row__fit">
          <span className="fov-filter-label">Last assessed match</span>
          {reasons.map((reason) => (
            <span key={reason}>{reason}</span>
          ))}
        </div>
      ) : (
        <p className="fov-micro">
          Review the source details and client requirements before deciding.
        </p>
      )}
      {row.source === 'grants_gov' || row.source === 'sam_gov' || forecast ? (
        <p className="fov-micro">
          This saved assessment may predate profile changes.{' '}
          <button type="button" className="fov-link" onClick={onOpenDetail}>
            View current match
          </button>
        </p>
      ) : null}
      {tracking ? (
        <div className="fo-simple-row__next">
          <strong>Next action</strong>
          <span>{row.nextAction ?? 'Choose a next action in the details.'}</span>
          {row.nextActionDueAt ? (
            <span>Follow up {formatSourceDate(row.nextActionDueAt.slice(0, 10))}</span>
          ) : null}
        </div>
      ) : null}
      {sourceFacts ? (
        <p className="fov-micro">
          Source record updated in Capiro:{' '}
          {sourceFacts.lastSyncedAt
            ? formatSourceDate(sourceFacts.lastSyncedAt.slice(0, 10))
            : 'Update time unavailable'}
        </p>
      ) : null}
      {row.noLongerSuggested ? (
        <p className="fov-micro">
          The latest matching no longer recommends this item. Your saved work is preserved.
        </p>
      ) : null}
      <div className="fov-inbox-row__footer">
        {validSourceUrl ? (
          <a className="fov-link" href={validSourceUrl} target="_blank" rel="noreferrer">
            View source ↗
          </a>
        ) : null}
        {canSave ? (
          <CapiroButton size="compact" loading={saving} onClick={onSave}>
            Save
          </CapiroButton>
        ) : null}
        <CapiroButton size="compact" onClick={onOpenDetail}>
          View details
        </CapiroButton>
      </div>
    </FovCard>
  );
}
