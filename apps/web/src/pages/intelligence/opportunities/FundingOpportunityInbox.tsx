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
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import { OpportunityFreshnessStrip } from './OpportunityFreshnessStrip.js';
import { FundingOpportunityDrawer } from './FundingOpportunityDrawer.js';
import { ForecastOpportunityCard } from './ForecastOpportunityCard.js';
import { DibbsOpportunityCard } from './DibbsOpportunityCard.js';
import { readEnum, useUrlState } from './funding-opportunities-url-state.js';
import {
  DIBBS_PART_PROFILE_GAP_TODAY,
  DIBBS_SOURCE,
  ELIGIBILITY_LABELS,
  FORECAST_SOURCE,
  FUNDING_OPPORTUNITIES_FORECASTS_FEATURE,
  asPursuableDibbsFacts,
  decodeOpportunityRef,
  encodeOpportunityRef,
  INBOX_FILTERS,
  INBOX_FILTER_DESCRIPTIONS,
  INBOX_FILTER_LABELS,
  INBOX_SOURCE_SHORT_LABELS,
  SOURCE_LABELS,
  WORKFLOW_LABELS,
  formatDeadline,
  formatInboxCount,
  isDibbsRow,
  isForecastRow,
  type EligibilityState,
  type FundingOpportunityListResponse,
  type InboxFilter,
  type InboxResponse,
  type InboxRow,
  type InboxSource,
} from './funding-opportunities-api.js';

const { Text } = Typography;

/**
 * The rails offered unconditionally: the two catalog rails, plus the DLA bid
 * board.
 *
 * The forecast option is appended only when the tenant has the forecast flag —
 * see {@link forecastSourceOptions}. Offering a filter that returns nothing
 * because the capability is off is worse than not offering it: an empty result
 * reads as "this client has no forecasts", which is a claim about the client.
 *
 * `dibbs` is in the unconditional list because it has NO capability flag —
 * neither the API nor the web defines one, and the inbox has returned bid-board
 * rows to every tenant since P41 part 2. Inventing a flag here would not gate
 * anything; it would only hide a filter for rows the page is already showing.
 */
const BASE_SOURCE_OPTIONS = [
  { label: 'All sources', value: '' },
  { label: SOURCE_LABELS.grants_gov, value: 'grants_gov' },
  { label: SOURCE_LABELS.sam_gov, value: 'sam_gov' },
  { label: INBOX_SOURCE_SHORT_LABELS.dibbs, value: DIBBS_SOURCE },
];

function forecastSourceOptions(forecastsEnabled: boolean) {
  return forecastsEnabled
    ? [
        ...BASE_SOURCE_OPTIONS,
        { label: INBOX_SOURCE_SHORT_LABELS.agency_forecast, value: FORECAST_SOURCE },
      ]
    : BASE_SOURCE_OPTIONS;
}

/** The rails a `?source=` deep link is honoured for with no capability check. */
const UNFLAGGED_SOURCES: InboxSource[] = ['grants_gov', 'sam_gov', DIBBS_SOURCE];

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
  /**
   * The forecast capability, per tenant.
   *
   * With it off, the forecast source filter is not offered and any forecast row
   * the API returns is WITHHELD rather than rendered — and the fact that rows
   * were withheld is stated, because silently showing fewer rows than the tab
   * badge counts is the kind of discrepancy that reads as a broken filter.
   */
  const forecasts = useIntelFeature(FUNDING_OPPORTUNITIES_FORECASTS_FEATURE);
  const forecastsEnabled = forecasts.ready && forecasts.enabled;

  const filter = readEnum<InboxFilter>(url.get('filter'), INBOX_FILTERS, 'needs_review');
  /**
   * A `source=agency_forecast` in the URL is honoured only when the flag is on.
   * With it off the value is not in the accepted set, so `readEnum` falls back to
   * "all sources" — a stale deep link degrades to the wider view rather than to
   * an empty one.
   */
  const source = readEnum<InboxSource | ''>(
    url.get('source'),
    forecastsEnabled ? [...UNFLAGGED_SOURCES, FORECAST_SOURCE, ''] : [...UNFLAGGED_SOURCES, ''],
    '',
  );
  const cursor = url.get('cursor');
  /**
   * Which row's detail drawer is open, from the URL rather than component state, so
   * browser Back closes it and the open row is part of a shareable link. A
   * malformed `detail` param decodes to null, which simply means closed.
   */
  const openRef = decodeOpportunityRef(url.get('detail'));

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

  /**
   * The rows to render, and how many were withheld because the forecast
   * capability is off.
   *
   * Withholding rather than rendering is what "flag off removes forecast UI"
   * means; SAYING how many were withheld is what stops that from becoming a
   * silent discrepancy against the tab badge, which counts every row the tenant
   * has regardless of what this page can display.
   */
  const allRows = data?.rows ?? [];
  const visibleRows = forecastsEnabled ? allRows : allRows.filter((r) => !isForecastRow(r));
  const withheldForecasts = allRows.length - visibleRows.length;

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
          style={{ width: 220 }}
          value={source}
          onChange={goToSource}
          options={forecastSourceOptions(forecastsEnabled)}
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
      ) : visibleRows.length === 0 ? (
        <>
          {withheldForecasts > 0 ? <WithheldForecastNotice count={withheldForecasts} /> : null}
          <InboxEmptyState
            data={data!}
            filter={filter}
            source={source}
            clientName={clientName}
            onClearClient={() => onSelectClient(undefined)}
            onClearSource={() => goToSource('')}
            onGoToFilter={goToFilter}
          />
        </>
      ) : (
        <>
          {withheldForecasts > 0 ? <WithheldForecastNotice count={withheldForecasts} /> : null}
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {visibleRows.map((row) => {
              const openDetail = () =>
                url.set({
                  detail: encodeOpportunityRef({
                    source: row.source,
                    sourceRecordId: row.sourceRecordId,
                    // The ROW's client, not the page filter: the inbox is
                    // cross-client, and the detail is a fact about the pair.
                    clientId: row.client.id,
                  }),
                });
              /*
                A forecast gets its OWN card, not the opportunity card with a
                different tag. The opportunity card leads with a deadline and an
                eligibility state, and a forecast has neither — reusing it would
                mean rendering "No deadline stated" and "Not evaluated" against
                two questions that do not apply to an agency's buying plan.
              */
              if (isForecastRow(row)) {
                return (
                  <ForecastOpportunityCard
                    key={row.id}
                    row={row}
                    onSelectClient={onSelectClient}
                    onOpenDetail={openDetail}
                  />
                );
              }
              /*
                And a bid-board item gets its own, for the same reason one step
                further: it has no eligibility determination and no estimated
                value at all, and its "deadline" is a quote-return date on a
                line item rather than a response deadline on a competition.
                Rendering it through the opportunity card would put a quantity
                and a unit of issue into a layout built around money and
                eligibility.
              */
              if (isDibbsRow(row)) {
                return (
                  <DibbsInboxRow
                    key={row.id}
                    row={row}
                    onSelectClient={onSelectClient}
                    onOpenDetail={openDetail}
                  />
                );
              }
              return (
                <InboxRowCard
                  key={row.id}
                  row={row}
                  onSelectClient={onSelectClient}
                  onOpenDetail={openDetail}
                />
              );
            })}
          </Space>
          <div className="fo-pager">
            <Text type="secondary" style={{ fontSize: 12 }}>
              {/*
                A cursor page has no honest "of N" — the total is a COUNT over a
                different predicate than the page, and a keyset walk deliberately
                never computes one. Saying how many are in the queue and how many
                are on screen is the true version of that sentence.
              */}
              Showing {visibleRows.length} of {formatInboxCount(counts?.[filter])} in{' '}
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

      {/*
        Rendered outside the row branch so an open drawer survives the list going
        empty underneath it — a refetch that returns no rows must not slam shut a
        record somebody is reading.
      */}
      <FundingOpportunityDrawer refValue={openRef} onClose={() => url.set({ detail: null })} />
    </div>
  );
}

/**
 * Rows this page is not showing because the forecast capability is off.
 *
 * The tab badges count every row the tenant has; this page renders only the ones
 * it can render honestly. Stating the difference is the point — a page showing
 * three rows under a badge that says four reads as a bug in the filter, and the
 * reader has no way to tell that the missing one is a capability question rather
 * than a data question.
 */
function WithheldForecastNotice({ count }: { count: number }) {
  return (
    <Alert
      type="info"
      showIcon
      style={{ marginBottom: 12 }}
      data-testid="fo-inbox-forecasts-withheld"
      message={`${count} agency forecast row${count === 1 ? '' : 's'} not shown`}
      description="Agency forecasts are a separate capability and are not enabled for this workspace, so those rows are not displayed here. The queue counts above still include them."
    />
  );
}

/**
 * One DLA bid-board row.
 *
 * ── Why the part-profile gap is passed as a constant ────────────────────────
 *
 * `DibbsOpportunityCard` reads `partProfileGap` to decide whether to say "no
 * part-level match was attempted". The inbox response carries no scoring
 * breakdown, so there is no field to read it from — but `null` is not a neutral
 * default here: it asserts that a part-level comparison HAPPENED and found no
 * gap, which would tell the reader this client's parts were compared and came
 * up short. Nothing stores a client's parts, so no comparison has ever run for
 * anyone. See {@link DIBBS_PART_PROFILE_GAP_TODAY}, which holds that reasoning
 * and is what gets deleted when a client part store lands.
 *
 * `onReviewClientParts` is deliberately NOT passed: there is no surface to
 * record a client's parts on yet, so the gap is stated without offering a
 * control that would lead nowhere. The card's own prop doc describes exactly
 * this posture.
 *
 * `onPursue` is likewise absent, which means the card renders no action row at
 * all rather than an inert one. A DIBBS row has no pursuit mutation wired to it
 * — that is P42/P43 work, not part 3 — and the card's design is that an absent
 * handler removes the control instead of disabling it.
 */
function DibbsInboxRow({
  row,
  onSelectClient,
  onOpenDetail,
}: {
  row: InboxRow;
  onSelectClient: (id: string) => void;
  onOpenDetail: () => void;
}) {
  /*
    `documentType` is a plain string on the wire, and the card renders only the
    two a client can bid. Narrowed rather than cast, so a third document type
    arriving from the provider degrades to a stated absence instead of being
    coerced into "rfq" and rendered with a quote button.
  */
  const facts = row.dibbs ? asPursuableDibbsFacts(row.dibbs) : null;

  if (!facts) {
    return (
      <DibbsUnrenderableCard
        row={row}
        reason={
          row.dibbs
            ? `Capiro holds this item as a “${row.dibbs.documentType}” document, which this rail does not render.`
            : 'Capiro no longer holds the bid-board record for this row, so no source facts can be shown.'
        }
        onSelectClient={onSelectClient}
        onOpenDetail={onOpenDetail}
      />
    );
  }

  return (
    <DibbsOpportunityCard
      facts={facts}
      clientName={row.client.name}
      relevanceScore={row.relevanceScore}
      partProfileGap={DIBBS_PART_PROFILE_GAP_TODAY}
      onSelectClient={() => onSelectClient(row.client.id)}
      onOpenDetail={onOpenDetail}
    />
  );
}

/**
 * A bid-board row whose source facts cannot be rendered.
 *
 * Stays on the BID-BOARD rail and states the absence, rather than falling back
 * to the generic opportunity card. The generic card leads with a response
 * deadline and an eligibility state, and a DLA line item has neither — so the
 * fallback that looks harmless would render "No deadline stated" and "Not
 * evaluated" against two questions that were never asked of this record. That
 * is the same reasoning the forecast rail follows, where a row whose forecast
 * record is gone still renders as a forecast and says so.
 */
function DibbsUnrenderableCard({
  row,
  reason,
  onSelectClient,
  onOpenDetail,
}: {
  row: InboxRow;
  reason: string;
  onSelectClient: (id: string) => void;
  onOpenDetail: () => void;
}) {
  return (
    <Card
      size="small"
      className="fo-card fo-card--dibbs"
      data-testid={`fo-dibbs-unrenderable-${row.id}`}
    >
      <div className="fo-inbox-row__head">
        <Space size={6} wrap>
          <Button
            type="link"
            size="small"
            className="fo-inbox-row__client"
            onClick={() => onSelectClient(row.client.id)}
            aria-label={`Show only ${row.client.name}`}
          >
            {row.client.name}
          </Button>
          <Tag color="geekblue">{INBOX_SOURCE_SHORT_LABELS.dibbs}</Tag>
        </Space>
      </div>
      <div className="fo-card__title">
        <Button
          type="link"
          className="fo-inbox-row__title"
          onClick={onOpenDetail}
          aria-label={`Open bid-board detail for ${row.title}`}
        >
          {row.title}
        </Button>
      </div>
      <div className="fo-card__meta">
        <Text type="secondary" style={{ fontSize: 12 }}>
          {reason}
        </Text>
      </div>
    </Card>
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
  onOpenDetail,
}: {
  row: InboxRow;
  onSelectClient: (id: string) => void;
  onOpenDetail: () => void;
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
          {/*
            INBOX_SOURCE_SHORT_LABELS, not SOURCE_LABELS: this card only ever
            receives a catalog row, but the row TYPE admits three rails now, and
            a lookup that can return undefined for a legal value would render an
            empty tag rather than fail.
          */}
          <Tag color={row.source === 'grants_gov' ? 'purple' : 'cyan'}>
            {INBOX_SOURCE_SHORT_LABELS[row.source]}
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
        {/*
          A BUTTON, not a link with an href. Opening the drawer is a same-page
          state change written to the URL; rendering it as an anchor would offer a
          "open in new tab" that does not do what it says. The full-page link lives
          inside the drawer, where it is unambiguous.
        */}
        <Button
          type="link"
          className="fo-inbox-row__title"
          onClick={onOpenDetail}
          aria-label={`Open detail for ${row.title}`}
        >
          {row.title}
        </Button>
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
