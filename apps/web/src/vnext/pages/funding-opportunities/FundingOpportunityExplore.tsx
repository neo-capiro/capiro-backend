import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CapiroButton } from '../../components/actions/index.js';
import { useCapiroToast } from '../../components/feedback/toast.js';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import {
  readInt,
  useUrlState,
} from '../../../pages/intelligence/opportunities/funding-opportunities-url-state.js';
import {
  decodeOpportunityRef,
  encodeOpportunityRef,
  formatSourceDate,
  moneyLine,
  FUNDING_OPPORTUNITIES_FORECASTS_FEATURE,
  FUNDING_OPPORTUNITIES_SBIR_FEATURE,
  type FundingOpportunity,
  type FundingOpportunityListResponse,
  type InboxSource,
} from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';
import { OpportunityFreshnessStrip } from './OpportunityFreshnessStrip.js';
import { FundingOpportunityDrawer } from './FundingOpportunityDrawer.js';
import {
  fundingFeedPath,
  type FundingFeedRecord,
  type FundingFeedResponse,
  type TangoOpportunityFeed,
} from './opportunity-feeds-api.js';
import { refreshOpportunityQueries, sourceWebUrl } from './opportunity-query-cache.js';
import { FovAlert, FovCard, FovPill, FovSkeletonRows } from './fov-ui.js';

type Feed = InboxSource | 'combined';
const FEEDS: Array<{ value: Feed; label: string }> = [
  { value: 'sam_gov', label: 'Federal contracts' },
  { value: 'grants_gov', label: 'Federal grants' },
  { value: 'agency_forecast', label: 'Agency forecasts' },
  { value: 'sbir_sttr', label: 'SBIR/STTR' },
  { value: 'dibbs', label: 'DLA purchasing (DIBBS)' },
];
const LEGACY_WORKFLOWS: Record<string, string> = {
  saved: 'saved',
  pursuing: 'pursuing',
  dismissed: 'dismissed',
};
interface BrowseRow {
  source: InboxSource;
  sourceRecordId: string;
  title: string;
  agency: string | null;
  description: string | null;
  sourceUrl: string | null;
  timing: string | null;
  timingLabel: string;
  amount: string | null;
  status: string | null;
  workflowStatus: string | null;
}

export function readBrowseFeed(
  feed: string | null,
  legacyTab: string | null,
  legacySource: string | null,
): Feed {
  if (feed && [...FEEDS.map((f) => f.value), 'combined'].includes(feed as Feed))
    return feed as Feed;
  if (legacyTab === 'grants') return 'grants_gov';
  if (legacyTab === 'contracts') return 'sam_gov';
  if (legacySource === 'sam_gov' || legacySource === 'grants_gov') return legacySource;
  // Preserve old combined and workflow URLs without making them a sixth primary feed.
  return legacyTab ? 'combined' : 'sam_gov';
}

export function FundingOpportunityExplore({ clientId }: { clientId: string | undefined }) {
  const api = useApi();
  const cache = useQueryClient();
  const toast = useCapiroToast();
  const url = useUrlState();
  const forecasts = useIntelFeature(FUNDING_OPPORTUNITIES_FORECASTS_FEATURE);
  const sbir = useIntelFeature(FUNDING_OPPORTUNITIES_SBIR_FEATURE);
  const feed = readBrowseFeed(url.get('feed'), url.get('tab'), url.get('source'));
  const auxiliary = ['agency_forecast', 'dibbs', 'sbir_sttr'].includes(feed);
  const ready = forecasts.ready && sbir.ready;
  const available =
    (feed !== 'agency_forecast' && feed !== 'sbir_sttr') ||
    (feed === 'agency_forecast' && forecasts.enabled) ||
    (feed === 'sbir_sttr' && sbir.enabled);
  const page = readInt(url.get('page'), 1, 100_000) ?? 1;
  const legacyStatus = !url.get('feed') ? LEGACY_WORKFLOWS[url.get('tab') ?? ''] : undefined;
  const params = new URLSearchParams({
    page: String(page),
    pageSize: '25',
    activeState: legacyStatus ? 'all' : url.get('activeState') === 'all' ? 'all' : 'active',
  });
  if (clientId) params.set('clientId', clientId);
  for (const key of ['q', 'agency']) {
    const value = url.get(key)?.trim();
    if (value) params.set(key, value);
  }
  if (!auxiliary || feed === 'agency_forecast') {
    const naics = url.get('naics')?.trim();
    if (naics) params.set('naics', naics);
  }
  if (!auxiliary) {
    if (feed !== 'combined') params.set('source', feed);
    if (legacyStatus) params.set('workflowStatus', legacyStatus);
    for (const key of [
      'psc',
      'setAside',
      'kind',
      'eligibility',
      'minRelevance',
      'deadlineFrom',
      'deadlineTo',
    ]) {
      const value = url.get(key);
      if (value) params.set(key, value);
    }
    if (!url.get('feed') && url.get('tab') === 'deadlines') {
      params.set('deadlineFrom', new Date().toISOString());
      params.set('deadlineTo', new Date(Date.now() + 30 * 86_400_000).toISOString());
    }
  }
  const queryString = params.toString();
  const catalog = useQuery<FundingOpportunityListResponse>({
    queryKey: ['funding-opportunities', queryString],
    queryFn: async () =>
      (
        await api.get<FundingOpportunityListResponse>(
          `/api/intelligence/opportunities?${queryString}`,
        )
      ).data,
    enabled: ready && available && !auxiliary,
    retry: 1,
    staleTime: 30_000,
  });
  const tango = useQuery<FundingFeedResponse>({
    queryKey: ['funding-opportunity-feed', feed, queryString],
    queryFn: async () =>
      (
        await api.get<FundingFeedResponse>(
          `${fundingFeedPath(feed as TangoOpportunityFeed)}?${queryString}`,
        )
      ).data,
    enabled: ready && available && auxiliary,
    retry: 1,
    staleTime: 30_000,
  });
  const openRow = (row: BrowseRow) =>
    url.set({
      detail: encodeOpportunityRef({
        source: row.source,
        sourceRecordId: row.sourceRecordId,
        clientId: clientId ?? null,
      }),
    });
  const save = useMutation({
    mutationFn: async (row: BrowseRow) => {
      if (!clientId) throw new Error('Choose a client in the details to save.');
      return api.post(
        `/api/intelligence/clients/${encodeURIComponent(clientId)}/opportunities/${row.source}/${encodeURIComponent(row.sourceRecordId)}/save`,
        { status: 'saved' },
      );
    },
    onSuccess: async () => {
      await refreshOpportunityQueries(cache);
      toast.success('Saved. Find this opportunity in Tracking.');
    },
    onError: () => toast.error('The opportunity could not be saved. Please try again.'),
  });
  const rows: BrowseRow[] = auxiliary
    ? (tango.data?.rows ?? []).map(feedRow)
    : (catalog.data?.opportunities ?? []).map(catalogRow);
  const current = auxiliary ? tango : catalog;
  const total = auxiliary ? tango.data?.total : catalog.data?.total;
  const hasMore = auxiliary ? tango.data?.hasMore : total != null && page * 25 < total;
  const choices = FEEDS.filter((f) => f.value !== 'agency_forecast' || forecasts.enabled).filter(
    (f) => f.value !== 'sbir_sttr' || sbir.enabled,
  );
  if (feed === 'combined')
    choices.push({
      value: 'combined',
      label: 'Federal grants & contracts (shared link)',
    });
  if (!choices.some((choice) => choice.value === feed))
    choices.push(FEEDS.find((choice) => choice.value === feed)!);

  return (
    <div className="fov-explore fov-stack fov-stack--10" data-testid="fo-explore">
      <div className="fov-row" style={{ flexWrap: 'wrap' }}>
        <label>
          <span className="fov-filter-label">Opportunity feed</span>
          <select
            className="capiro-input"
            value={feed}
            onChange={(event) =>
              url.set({
                feed: event.target.value,
                tab: null,
                source: null,
                page: null,
                cursor: null,
                q: null,
                agency: null,
                naics: null,
                psc: null,
                setAside: null,
                kind: null,
                eligibility: null,
                minRelevance: null,
                deadlineFrom: null,
                deadlineTo: null,
                activeState: null,
                detail: null,
              })
            }
          >
            {choices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </label>
        {!clientId ? (
          <span className="fov-muted" data-testid="fo-no-client">
            Search the source records. Choose a client when you want to assess the fit or save an
            item.
          </span>
        ) : null}
      </div>
      {!ready ? (
        <FovSkeletonRows rows={3} />
      ) : !available ? (
        <FovAlert
          tone="info"
          message="This feed is not enabled for your workspace"
          description="Your other opportunity feeds remain available from the selector."
        />
      ) : (
        <>
          {auxiliary ? (
            <FeedFreshness freshness={tango.data?.freshness} />
          ) : (
            <OpportunityFreshnessStrip freshness={catalog.data?.freshness} />
          )}
          {legacyStatus ? (
            <p className="fov-muted">
              This shared link shows {legacyStatus} grants and contracts. Tracking contains all
              supported saved work.
            </p>
          ) : null}
          <form
            key={`${feed}:${queryString}`}
            className="fov-row"
            style={{ flexWrap: 'wrap' }}
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              url.set({
                q: String(data.get('q') ?? ''),
                agency: String(data.get('agency') ?? ''),
                naics: String(data.get('naics') ?? ''),
                activeState: String(data.get('activeState') ?? 'active'),
                page: null,
              });
            }}
          >
            <label>
              <span className="fov-filter-label">Search</span>
              <input
                className="capiro-input"
                name="q"
                defaultValue={url.get('q') ?? ''}
                placeholder="Title, topic or keyword"
              />
            </label>
            <CapiroButton type="submit">Search</CapiroButton>
            <details>
              <summary>Filters</summary>
              <div className="fov-row" style={{ paddingBlock: 8, flexWrap: 'wrap' }}>
                <label>
                  <span className="fov-filter-label">Agency</span>
                  <input
                    className="capiro-input"
                    name="agency"
                    defaultValue={url.get('agency') ?? ''}
                  />
                </label>
                {!auxiliary || feed === 'agency_forecast' ? (
                  <label>
                    <span className="fov-filter-label">NAICS code</span>
                    <input
                      className="capiro-input"
                      name="naics"
                      defaultValue={url.get('naics') ?? ''}
                    />
                  </label>
                ) : null}
                <label>
                  <span className="fov-filter-label">Availability</span>
                  <select
                    className="capiro-input"
                    name="activeState"
                    defaultValue={url.get('activeState') ?? 'active'}
                  >
                    <option value="active">Open or not withdrawn</option>
                    <option value="all">Include closed records</option>
                  </select>
                </label>
                <CapiroButton type="submit">Apply filters</CapiroButton>
              </div>
            </details>
          </form>
          {current.isPending ? (
            <FovSkeletonRows rows={5} />
          ) : current.isError ? (
            <FovAlert
              tone="error"
              message="This feed could not be loaded"
              description="Your saved work is unchanged. Try loading the feed again."
              action={<CapiroButton onClick={() => void current.refetch()}>Retry</CapiroButton>}
            />
          ) : (
            <>
              <p className="fov-muted" aria-live="polite">
                {total?.toLocaleString() ?? '—'} records
                {!auxiliary && catalog.data?.totalIsCapped ? ' or more' : ''} in this search
              </p>
              {!rows.length ? (
                <FovAlert
                  message="No records match this search"
                  description="Try another keyword, clear a filter, or choose a different feed."
                />
              ) : (
                rows.map((row) => {
                  const sourceUrl = sourceWebUrl(row.sourceUrl);
                  const isSaved = [
                    'saved',
                    'pursuing',
                    'won',
                    'lost',
                    'dismissed',
                    'expired',
                  ].includes(row.workflowStatus ?? '');
                  return (
                    <FovCard key={`${row.source}:${row.sourceRecordId}`} className="fo-simple-row">
                      <div className="fov-row" style={{ justifyContent: 'space-between' }}>
                        <span className="fov-muted">{row.agency ?? 'Agency not provided'}</span>
                        {row.workflowStatus ? (
                          <FovPill>{row.workflowStatus}</FovPill>
                        ) : row.status ? (
                          <FovPill>{row.status}</FovPill>
                        ) : null}
                      </div>
                      <h3 style={{ marginBlock: 8 }}>
                        <button className="fov-title-button" onClick={() => openRow(row)}>
                          {row.title}
                        </button>
                      </h3>
                      <div className="fov-row" style={{ flexWrap: 'wrap' }}>
                        <span>
                          {row.timingLabel}:{' '}
                          {formatSourceDate(row.timing?.slice(0, 10) ?? null, 'Not provided')}
                        </span>
                        {row.amount ? <span>{row.amount}</span> : null}
                      </div>
                      {row.description ? (
                        <p className="fov-muted">
                          {row.description.slice(0, 280)}
                          {row.description.length > 280 ? '…' : ''}
                        </p>
                      ) : null}
                      <div className="fov-row" style={{ flexWrap: 'wrap' }}>
                        <CapiroButton size="compact" onClick={() => openRow(row)}>
                          View details
                        </CapiroButton>
                        {!isSaved ? (
                          <CapiroButton
                            size="compact"
                            loading={
                              save.isPending &&
                              save.variables?.sourceRecordId === row.sourceRecordId
                            }
                            onClick={() => (clientId ? save.mutate(row) : openRow(row))}
                          >
                            {clientId ? 'Save' : 'Save for a client'}
                          </CapiroButton>
                        ) : null}
                        {sourceUrl ? (
                          <a href={sourceUrl} target="_blank" rel="noreferrer">
                            Open source ↗
                          </a>
                        ) : null}
                      </div>
                    </FovCard>
                  );
                })
              )}
              {page > 1 || hasMore ? (
                <nav className="fov-row" aria-label="Browse pages">
                  <CapiroButton disabled={page <= 1} onClick={() => url.set({ page: page - 1 })}>
                    Previous
                  </CapiroButton>
                  <span>Page {page}</span>
                  <CapiroButton disabled={!hasMore} onClick={() => url.set({ page: page + 1 })}>
                    Next
                  </CapiroButton>
                </nav>
              ) : null}
            </>
          )}
        </>
      )}
      <FundingOpportunityDrawer
        refValue={decodeOpportunityRef(url.get('detail'))}
        onClose={() => url.set({ detail: null })}
      />
    </div>
  );
}

function catalogRow(row: FundingOpportunity): BrowseRow {
  const amount = moneyLine(row);
  return {
    source: row.source,
    sourceRecordId: row.sourceRecordId,
    title: row.title,
    agency: row.agency,
    description: row.summaryIsLink ? null : row.summary,
    sourceUrl: row.sourceUrl,
    timing: row.responseDeadline,
    timingLabel: 'Response deadline',
    amount: `${amount.label}: ${amount.value}`,
    status: row.status,
    workflowStatus: row.workflow?.status ?? null,
  };
}
function feedRow(row: FundingFeedRecord): BrowseRow {
  return {
    ...row,
    timing: row.source === 'agency_forecast' ? row.anticipatedAwardDate : row.responseDeadline,
    timingLabel:
      row.source === 'agency_forecast' ? 'Anticipated award (estimate)' : 'Response deadline',
    amount: null,
    workflowStatus: row.workflow?.status ?? null,
  };
}
function FeedFreshness({ freshness }: { freshness: FundingFeedResponse['freshness'] | undefined }) {
  if (!freshness) return null;
  const messages = {
    not_synced: 'This feed has not completed a recorded sync',
    current: 'Feed updated',
    stale: 'This feed may be out of date',
    failed: 'The latest feed update failed or was incomplete',
    unknown: 'Feed update status is unavailable',
  };
  return (
    <FovAlert
      tone={freshness.state === 'failed' || freshness.state === 'stale' ? 'warning' : 'info'}
      message={messages[freshness.state]}
      description={
        freshness.lastSuccessAt
          ? `Last complete update: ${new Date(freshness.lastSuccessAt).toLocaleString()}.`
          : 'There is no recorded complete update to show.'
      }
    />
  );
}
