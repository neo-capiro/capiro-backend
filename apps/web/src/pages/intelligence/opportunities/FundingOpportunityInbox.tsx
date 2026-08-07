import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  Empty,
  Segmented,
  Select,
  Skeleton,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useApi } from '../../../lib/use-api.js';
import { OpportunityFreshnessStrip } from './OpportunityFreshnessStrip.js';
import { readEnum, useUrlState } from './funding-opportunities-url-state.js';
import {
  ELIGIBILITY_LABELS,
  INBOX_FILTERS,
  INBOX_FILTER_DESCRIPTIONS,
  INBOX_FILTER_LABELS,
  SOURCE_LABELS,
  WORKFLOW_LABELS,
  formatDeadline,
  formatInboxCount,
  type EligibilityState,
  type FundingOpportunityListResponse,
  type InboxFilter,
  type InboxResponse,
  type InboxRow,
  type OpportunitySource,
} from './funding-opportunities-api.js';

const { Text } = Typography;

const SOURCE_OPTIONS = [
  { label: 'All sources', value: '' },
  { label: SOURCE_LABELS.grants_gov, value: 'grants_gov' },
  { label: SOURCE_LABELS.sam_gov, value: 'sam_gov' },
];
const SOURCES: OpportunitySource[] = ['grants_gov', 'sam_gov'];

const DECISION_LABELS: Record<string, string> = {
  pursue: 'Decided: pursue',
  monitor: 'Decided: monitor',
  pass: 'Decided: pass',
};
const DECISION_COLORS: Record<string, string> = {
  pursue: 'geekblue',
  monitor: 'blue',
  pass: 'default',
};

/**
 * The cross-client triage inbox — the default Funding Opportunities experience.
 *
 * ── What this replaces, and why ──────────────────────────────────────────────
 *
 * The old default was the raw federal catalog with no client selected: thousands
 * of source records, no relevance, no owner, no decision, ordered by whatever the
 * catalog felt like. It answered "what exists", which nobody asks. This answers
 * "what needs deciding", one row per CLIENT-OPPORTUNITY decision context, which is
 * the unit of work a government-affairs team actually has.
 *
 * ── Three rules this component is built around ───────────────────────────────
 *
 * EVERY ROW NAMES ITS CLIENT. A cross-client list without the client on each row
 * is a list nobody can act on.
 *
 * SOURCE IS A FILTER, NOT A TAB. The catalog made "Grants" and "Government
 * contracts" primary tabs, which framed the work as "which rail am I reading" and
 * left a deadline three days out on the other rail one click from invisible.
 *
 * AN EMPTY QUEUE EXPLAINS ITSELF. "Nothing here" is four different situations —
 * nothing exists anywhere, nothing for the client you narrowed to, nothing on the
 * rail you narrowed to, or nothing in this queue while another queue is full — and
 * they have four different fixes. The counts the API already returns are enough to
 * tell them apart, so the empty state says which one it is.
 */
export function FundingOpportunityInbox({
  clientId,
  clientName,
  onSelectClient,
}: {
  clientId: string | undefined;
  clientName: string | undefined;
  onSelectClient: (id: string | undefined) => void;
}) {
  const api = useApi();
  const url = useUrlState();

  const filter = readEnum<InboxFilter>(url.get('filter'), INBOX_FILTERS, 'needs_review');
  const source = readEnum<OpportunitySource | ''>(url.get('source'), [...SOURCES, ''], '');
  const cursor = url.get('cursor');

  /**
   * Cursors already visited, for a working Previous.
   *
   * Component state, not URL: a keyset cursor is forward-only, so Previous needs
   * the trail. After a refresh the trail is gone but the CURSOR is still in the
   * URL, so the reader lands back on the same page — and gets "First page" instead
   * of a Previous that would silently jump somewhere else.
   */
  const [trail, setTrail] = useState<string[]>([]);

  const params = new URLSearchParams({ filter });
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
  });

  /**
   * Source-rail health, for the inbox too.
   *
   * The inbox reads decision-context SNAPSHOTS, so a dead source rail does not
   * empty it — it quietly serves last week's picture instead, which is the more
   * dangerous failure. `pageSize=1` because only `freshness` is wanted; this is the
   * same catalog request the page issued on every load before P11, so it is not a
   * new cost, just a much smaller one.
   */
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

  function goToFilter(next: InboxFilter) {
    setTrail([]);
    url.set({ filter: next === 'needs_review' ? null : next, cursor: null });
  }

  function goToSource(next: string) {
    setTrail([]);
    url.set({ source: next || null, cursor: null });
  }

  function nextPage(next: string) {
    setTrail((t) => [...t, cursor ?? '']);
    url.set({ cursor: next });
  }

  function previousPage() {
    const previous = trail[trail.length - 1];
    setTrail((t) => t.slice(0, -1));
    url.set({ cursor: previous || null });
  }

  const data = inbox.data;
  const counts = data?.counts;

  return (
    <div className="fo-inbox" data-testid="fo-inbox">
      <OpportunityFreshnessStrip freshness={freshness.data?.freshness} />

      <Segmented<InboxFilter>
        block
        value={filter}
        onChange={goToFilter}
        aria-label="Triage queue"
        style={{ margin: '12px 0' }}
        options={INBOX_FILTERS.map((value) => ({
          value,
          label: (
            <Tooltip title={INBOX_FILTER_DESCRIPTIONS[value]}>
              <span>
                {INBOX_FILTER_LABELS[value]}{' '}
                <Text type="secondary" style={{ fontSize: 11 }}>
                  {formatInboxCount(counts?.[value])}
                </Text>
              </span>
            </Tooltip>
          ),
        }))}
      />

      <div className="fo-inbox__controls">
        <Select
          style={{ width: 200 }}
          value={source}
          onChange={goToSource}
          options={SOURCE_OPTIONS}
          aria-label="Source rail"
        />
        {data?.clientId ? (
          <Tag
            closable
            onClose={() => onSelectClient(undefined)}
            aria-label="Client filter"
            data-testid="fo-inbox-client-filter"
          >
            Only {clientName ?? 'the selected client'}
          </Tag>
        ) : null}
        <Text type="secondary" style={{ fontSize: 11 }}>
          {INBOX_FILTER_DESCRIPTIONS[filter]}
        </Text>
      </div>

      {data?.countsUnavailableReason ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="Queue counts could not be read"
          description="The tab numbers show “?” rather than 0. A zero on a full queue is the more dangerous of the two, so no count is shown at all."
        />
      ) : null}

      {inbox.isError ? (
        <div data-testid="fo-inbox-error">
          <Alert
            type="error"
            showIcon
            message="The triage inbox failed to load"
            description="This is a request failure, not an empty inbox. No conclusion can be drawn about how much work is waiting."
            action={
              <Button size="small" onClick={() => void inbox.refetch()}>
                Retry
              </Button>
            }
          />
        </div>
      ) : inbox.isPending ? (
        <div data-testid="fo-inbox-loading">
          <Skeleton active paragraph={{ rows: 8 }} />
        </div>
      ) : data!.rows.length === 0 ? (
        <InboxEmptyState
          data={data!}
          filter={filter}
          source={source}
          clientName={clientName}
          onClearClient={() => onSelectClient(undefined)}
          onClearSource={() => goToSource('')}
          onGoToFilter={goToFilter}
        />
      ) : (
        <>
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {data!.rows.map((row) => (
              <InboxRowCard key={row.id} row={row} onSelectClient={onSelectClient} />
            ))}
          </Space>
          <div className="fo-pager">
            <Text type="secondary" style={{ fontSize: 12 }}>
              {/*
                A cursor page has no honest "of N" — the total is a COUNT over a
                different predicate than the page, and a keyset walk deliberately
                never computes one. Saying how many are in the queue and how many
                are on screen is the true version of that sentence.
              */}
              Showing {data!.rows.length} of {formatInboxCount(counts?.[filter])} in{' '}
              {INBOX_FILTER_LABELS[filter].toLowerCase()}
            </Text>
            <Space>
              {cursor ? (
                <Button
                  size="small"
                  onClick={() => {
                    setTrail([]);
                    url.set({ cursor: null });
                  }}
                >
                  First page
                </Button>
              ) : null}
              <Button size="small" disabled={trail.length === 0} onClick={previousPage}>
                Previous
              </Button>
              <Button
                size="small"
                disabled={!data!.nextCursor}
                onClick={() => nextPage(data!.nextCursor!)}
              >
                Next
              </Button>
            </Space>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * One decision context.
 *
 * Leads with the CLIENT, then the recommendation-relevant facts, then the state.
 * The source rail is a small tag rather than a heading, which is the visual form
 * of "source is a filter, not the model".
 */
function InboxRowCard({
  row,
  onSelectClient,
}: {
  row: InboxRow;
  onSelectClient: (id: string) => void;
}) {
  const deadline = formatDeadline(row.responseDeadline, null);
  const eligibility = row.eligibility.state as EligibilityState | null;

  return (
    <Card size="small" className="fo-card" data-testid={`fo-inbox-row-${row.id}`}>
      <div className="fo-inbox-row__head">
        <Space size={6} wrap>
          {/* Every row names its client. Without it a cross-client list is unusable. */}
          <Button
            type="link"
            size="small"
            className="fo-inbox-row__client"
            onClick={() => onSelectClient(row.client.id)}
            aria-label={`Show only ${row.client.name}`}
          >
            {row.client.name}
          </Button>
          <Tag color={row.source === 'grants_gov' ? 'purple' : 'cyan'}>
            {SOURCE_LABELS[row.source]}
          </Tag>
          {row.humanDecision ? (
            <Tag color={DECISION_COLORS[row.humanDecision] ?? 'default'}>
              {DECISION_LABELS[row.humanDecision] ?? `Decided: ${row.humanDecision}`}
            </Tag>
          ) : null}
          <Tag color={row.workflowStatus === 'pursuing' ? 'geekblue' : 'default'}>
            {WORKFLOW_LABELS[row.workflowStatus as keyof typeof WORKFLOW_LABELS] ??
              row.workflowStatus}
          </Tag>
          {row.sourceClosed ? (
            <Tooltip title="The source has been observed closed since this row was created. The decision on it still stands.">
              <Tag color="red">Source closed</Tag>
            </Tooltip>
          ) : null}
          {row.noLongerSuggested ? (
            <Tooltip title="The nightly matcher no longer suggests this, but your decision on it stands.">
              <Tag>No longer suggested</Tag>
            </Tooltip>
          ) : null}
        </Space>
      </div>

      <div className="fo-card__title">
        <Text strong>{row.title}</Text>
      </div>
      <div className="fo-card__meta">
        <Text type="secondary" style={{ fontSize: 12 }}>
          {row.agency ?? 'Agency not stated'}
        </Text>
      </div>

      <div className="fo-card__facts">
        <span className="fo-fact">
          <Text type="secondary" className="fo-fact__label">
            Deadline
          </Text>
          <Text className="fo-fact__value">
            {deadline.text}
            {row.daysUntilDeadline != null && row.daysUntilDeadline >= 0 ? (
              <Text
                type={row.daysUntilDeadline <= 14 ? 'danger' : 'secondary'}
                style={{ fontSize: 11 }}
              >
                {' '}
                ({row.daysUntilDeadline}d)
              </Text>
            ) : null}
          </Text>
        </span>

        <span className="fo-fact">
          <Text type="secondary" className="fo-fact__label">
            Eligibility
          </Text>
          {/*
            An eligibility nobody has evaluated is "Not evaluated", never
            "Eligible" and never a blank cell. The API returns null for it, and a
            blank reads as "fine".
          */}
          <Text className="fo-fact__value">
            {eligibility ? (ELIGIBILITY_LABELS[eligibility] ?? eligibility) : 'Not evaluated'}
          </Text>
        </span>

        <span className="fo-fact">
          <Text type="secondary" className="fo-fact__label">
            Relevance
          </Text>
          <Text className="fo-fact__value">{row.relevanceScore ?? 'Not scored'}</Text>
        </span>

        <span className="fo-fact">
          <Text type="secondary" className="fo-fact__label">
            Owner
          </Text>
          <Text className="fo-fact__value">
            {row.owner?.name ?? row.owner?.email ?? 'Unassigned'}
          </Text>
        </span>

        <span className="fo-fact">
          <Text type="secondary" className="fo-fact__label">
            Next action
          </Text>
          <Text className="fo-fact__value">{row.nextAction ?? 'None recorded'}</Text>
        </span>
      </div>
    </Card>
  );
}

/**
 * WHY the queue is empty — four different situations with four different fixes.
 *
 * Everything here is derived from counts the API already returns, so nothing is
 * guessed. Ordered widest-cause-first: if the whole tenant has no decision
 * contexts, saying "try another queue" would send the reader to five more empty
 * queues before they worked out that the producers have never run.
 */
function InboxEmptyState({
  data,
  filter,
  source,
  clientName,
  onClearClient,
  onClearSource,
  onGoToFilter,
}: {
  data: InboxResponse;
  filter: InboxFilter;
  source: string;
  clientName: string | undefined;
  onClearClient: () => void;
  onClearSource: () => void;
  onGoToFilter: (f: InboxFilter) => void;
}) {
  const counts = data.counts;
  const unreadable = data.countsUnavailableReason != null;
  const totalHere = INBOX_FILTERS.reduce((sum, f) => sum + Math.max(counts[f] ?? 0, 0), 0);
  const elsewhere = INBOX_FILTERS.filter((f) => f !== filter && (counts[f] ?? 0) > 0);
  const otherClientsHave = data.countsAllClients ? (data.countsAllClients[filter] ?? 0) : 0;

  let heading: string;
  let detail: string;
  let action: React.ReactNode = null;

  if (unreadable) {
    heading = 'Nothing to show, and the counts could not be read';
    detail =
      'The queue is empty in this page of results, but the counts that would explain why are unavailable. Retry before concluding there is no work waiting.';
  } else if (data.clientId && otherClientsHave > 0) {
    heading = `${clientName ?? 'This client'} has nothing in ${INBOX_FILTER_LABELS[filter].toLowerCase()}`;
    detail = `Other clients have ${otherClientsHave} here. The client filter is what is hiding them.`;
    action = (
      <Button size="small" onClick={onClearClient}>
        Show every client
      </Button>
    );
  } else if (source) {
    heading = `Nothing in ${INBOX_FILTER_LABELS[filter].toLowerCase()} on this source`;
    detail =
      'The source filter narrows this queue to one rail. The other rail is not counted here.';
    action = (
      <Button size="small" onClick={onClearSource}>
        Show all sources
      </Button>
    );
  } else if (elsewhere.length > 0) {
    heading = `Nothing in ${INBOX_FILTER_LABELS[filter].toLowerCase()}`;
    detail = `${INBOX_FILTER_DESCRIPTIONS[filter]} Other queues do have work waiting.`;
    action = (
      <Space size={6} wrap>
        {elsewhere.map((f) => (
          <Button key={f} size="small" onClick={() => onGoToFilter(f)}>
            {INBOX_FILTER_LABELS[f]} ({counts[f]})
          </Button>
        ))}
      </Space>
    );
  } else if (totalHere === 0) {
    // Nothing in ANY queue. Either the producers have never run, or the source
    // rails are empty/stale — both of which are visible in the freshness strip
    // above, and neither of which is "there are no opportunities".
    heading = 'No client-opportunity decisions exist yet';
    detail =
      'No queue has any rows. Either the nightly matchers have not produced suggestions for these clients, or the source rails above have not synced. This is not a statement that no relevant opportunities exist.';
  } else {
    heading = `Nothing in ${INBOX_FILTER_LABELS[filter].toLowerCase()}`;
    detail = INBOX_FILTER_DESCRIPTIONS[filter];
  }

  return (
    <Card size="small" data-testid="fo-inbox-empty">
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={null}>
        <div style={{ maxWidth: 560, margin: '0 auto', textAlign: 'center' }}>
          <Text strong>{heading}</Text>
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {detail}
            </Text>
          </div>
          {action ? <div style={{ marginTop: 12 }}>{action}</div> : null}
        </div>
      </Empty>
    </Card>
  );
}
