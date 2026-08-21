import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CapiroButton } from '../../components/actions/index.js';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import {
  readEnum,
  useUrlState,
} from '../../../pages/intelligence/opportunities/funding-opportunities-url-state.js';
import {
  DIBBS_PART_PROFILE_GAP_TODAY,
  DIBBS_SOURCE,
  ELIGIBILITY_LABELS,
  FORECAST_SOURCE,
  FUNDING_OPPORTUNITIES_FORECASTS_FEATURE,
  FUNDING_OPPORTUNITIES_SBIR_FEATURE,
  SBIR_ELIGIBILITY_REASON,
  SBIR_PHASE_GAP_EXPLANATION,
  SBIR_SOURCE,
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
  isSbirRow,
  type EligibilityState,
  type FundingOpportunityListResponse,
  type InboxFilter,
  type InboxResponse,
  type InboxRow,
  type InboxSource,
} from '../../../pages/intelligence/opportunities/funding-opportunities-api.js';
import { DibbsOpportunityCard } from './DibbsOpportunityCard.js';
import { ForecastOpportunityCard } from './ForecastOpportunityCard.js';
import { FundingOpportunityDrawer } from './FundingOpportunityDrawer.js';
import { OpportunityFreshnessStrip } from './OpportunityFreshnessStrip.js';
import { SbirOpportunityCard } from './SbirOpportunityCard.js';
import { FovAlert, FovCard, FovChip, FovPill, FovSegmented, FovSkeletonRows } from './fov-ui.js';

/**
 * The cross-client triage inbox — vNext port of the canonical
 * FundingOpportunityInbox. Same three rules: EVERY ROW NAMES ITS CLIENT;
 * SOURCE IS A FILTER, NOT A TAB; AN EMPTY QUEUE EXPLAINS ITSELF.
 */

/**
 * The rails offered unconditionally: the two catalog rails, plus the DLA bid
 * board (which has NO capability flag — see the canonical inbox's note).
 */
const BASE_SOURCE_OPTIONS = [
  { label: 'All sources', value: '' },
  { label: SOURCE_LABELS.grants_gov, value: 'grants_gov' },
  { label: SOURCE_LABELS.sam_gov, value: 'sam_gov' },
  { label: INBOX_SOURCE_SHORT_LABELS.dibbs, value: DIBBS_SOURCE },
];

/**
 * The source options, with each flagged rail appended only when its capability
 * is on: offering a filter that returns nothing because the capability is off
 * reads as "this client has none of those", which is a claim about the client.
 */
function sourceOptions(forecastsEnabled: boolean, sbirEnabled: boolean) {
  const options = [...BASE_SOURCE_OPTIONS];
  if (forecastsEnabled) {
    options.push({ label: INBOX_SOURCE_SHORT_LABELS.agency_forecast, value: FORECAST_SOURCE });
  }
  if (sbirEnabled) {
    options.push({ label: INBOX_SOURCE_SHORT_LABELS.sbir_sttr, value: SBIR_SOURCE });
  }
  return options;
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
   * The forecast capability, per tenant. With it off, the forecast source
   * filter is not offered and any forecast row the API returns is WITHHELD
   * rather than rendered — and the fact that rows were withheld is stated.
   */
  const forecasts = useIntelFeature(FUNDING_OPPORTUNITIES_FORECASTS_FEATURE);
  const forecastsEnabled = forecasts.ready && forecasts.enabled;
  /** The SBIR capability (P43). Same posture as the forecast flag above. */
  const sbir = useIntelFeature(FUNDING_OPPORTUNITIES_SBIR_FEATURE);
  const sbirEnabled = sbir.ready && sbir.enabled;

  const filter = readEnum<InboxFilter>(url.get('filter'), INBOX_FILTERS, 'needs_review');
  /**
   * A flagged rail in the URL is honoured only when its flag is on — a stale
   * deep link degrades to the wider view rather than to an empty one.
   */
  const source = readEnum<InboxSource | ''>(
    url.get('source'),
    [
      ...UNFLAGGED_SOURCES,
      ...(forecastsEnabled ? [FORECAST_SOURCE] : []),
      ...(sbirEnabled ? [SBIR_SOURCE] : []),
      '',
    ],
    '',
  );
  const cursor = url.get('cursor');
  /**
   * Which row's detail drawer is open, from the URL rather than component
   * state, so browser Back closes it and the open row is part of a shareable
   * link. A malformed `detail` param decodes to null, which means closed.
   */
  const openRef = decodeOpportunityRef(url.get('detail'));

  /**
   * Cursors already visited, for a working Previous. Component state, not URL:
   * a keyset cursor is forward-only, so Previous needs the trail. After a
   * refresh the trail is gone but the CURSOR is still in the URL, so the
   * reader lands back on the same page — and gets "First page" instead of a
   * Previous that would silently jump somewhere else.
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
   * Source-rail health, for the inbox too. `pageSize=1` because only
   * `freshness` is wanted — the inbox reads decision-context SNAPSHOTS, so a
   * dead source rail does not empty it; it quietly serves last week's picture,
   * which is the more dangerous failure.
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
   * The rows to render, and how many were withheld because a capability is
   * off. Withholding rather than rendering is what "flag off removes the UI"
   * means; SAYING how many were withheld is what stops that from becoming a
   * silent discrepancy against the tab badge.
   */
  const allRows = data?.rows ?? [];
  const visibleRows = allRows.filter(
    (r) => (forecastsEnabled || !isForecastRow(r)) && (sbirEnabled || !isSbirRow(r)),
  );
  /* Counted PER RAIL rather than as one "rows withheld" total — a pooled
     number leaves a reader unable to tell WHICH capability to ask for. */
  const withheldForecasts = forecastsEnabled ? 0 : allRows.filter((r) => isForecastRow(r)).length;
  const withheldSbir = sbirEnabled ? 0 : allRows.filter((r) => isSbirRow(r)).length;

  return (
    <div className="fov-inbox fov-stack fov-stack--10" data-testid="fo-inbox">
      <OpportunityFreshnessStrip freshness={freshness.data?.freshness} />

      <FovSegmented<InboxFilter>
        block
        value={filter}
        onChange={goToFilter}
        ariaLabel="Triage queue"
        options={INBOX_FILTERS.map((value) => ({
          value,
          title: INBOX_FILTER_DESCRIPTIONS[value],
          label: (
            <>
              <span className="fov-seg__count">{formatInboxCount(counts?.[value])}</span>
              <span className="fov-seg__label">{INBOX_FILTER_LABELS[value]}</span>
            </>
          ),
        }))}
      />

      <div className="fov-inbox__controls">
        <select
          className="capiro-select fov-filter-input"
          style={{ width: 220 }}
          value={source}
          onChange={(event) => goToSource(event.target.value)}
          aria-label="Source rail"
        >
          {sourceOptions(forecastsEnabled, sbirEnabled).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {data?.clientId ? (
          <FovChip
            onClose={() => onSelectClient(undefined)}
            closeLabel="Clear client filter"
            ariaLabel="Client filter"
            testId="fo-inbox-client-filter"
          >
            Only {clientName ?? 'the selected client'}
          </FovChip>
        ) : null}
        <span className="fov-micro">{INBOX_FILTER_DESCRIPTIONS[filter]}</span>
      </div>

      {data?.countsUnavailableReason ? (
        <FovAlert
          tone="warning"
          message="Queue counts could not be read"
          description="The tab numbers show “?” rather than 0. A zero on a full queue is the more dangerous of the two, so no count is shown at all."
        />
      ) : null}

      {inbox.isError ? (
        <div data-testid="fo-inbox-error">
          <FovAlert
            tone="error"
            message="The triage inbox failed to load"
            description="This is a request failure, not an empty inbox. No conclusion can be drawn about how much work is waiting."
            action={
              <CapiroButton size="compact" onClick={() => void inbox.refetch()}>
                Retry
              </CapiroButton>
            }
          />
        </div>
      ) : inbox.isPending ? (
        <div data-testid="fo-inbox-loading">
          <FovSkeletonRows rows={8} />
        </div>
      ) : visibleRows.length === 0 ? (
        <>
          {withheldForecasts > 0 ? <WithheldForecastNotice count={withheldForecasts} /> : null}
          {withheldSbir > 0 ? <WithheldSbirNotice count={withheldSbir} /> : null}
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
          {withheldSbir > 0 ? <WithheldSbirNotice count={withheldSbir} /> : null}
          <div className="fov-stack fov-stack--8">
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
              /* A forecast gets its OWN card — the opportunity card leads with
                 a deadline and an eligibility state, and a forecast has
                 neither. */
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
              /* And a bid-board item gets its own, one step further: no
                 eligibility determination, no estimated value, and its
                 "deadline" is a quote-return date on a line item. */
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
              /* And a topic gets its own, for the third time and the same
                 reason. */
              if (isSbirRow(row)) {
                return (
                  <SbirInboxRow
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
          </div>
          <div className="fov-pager">
            <span className="fov-muted">
              {/* A cursor page has no honest "of N" — saying how many are in
                  the queue and how many are on screen is the true version of
                  that sentence. */}
              Showing {visibleRows.length} of {formatInboxCount(counts?.[filter])} in{' '}
              {INBOX_FILTER_LABELS[filter].toLowerCase()}
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
              <CapiroButton size="compact" disabled={trail.length === 0} onClick={previousPage}>
                Previous
              </CapiroButton>
              <CapiroButton
                size="compact"
                disabled={!data!.nextCursor}
                onClick={() => nextPage(data!.nextCursor!)}
              >
                Next
              </CapiroButton>
            </span>
          </div>
        </>
      )}

      {/* Rendered outside the row branch so an open drawer survives the list
          going empty underneath it — a refetch that returns no rows must not
          slam shut a record somebody is reading. */}
      <FundingOpportunityDrawer refValue={openRef} onClose={() => url.set({ detail: null })} />
    </div>
  );
}

/**
 * Rows this page is not showing because the forecast capability is off. The
 * tab badges count every row the tenant has; stating the difference is the
 * point.
 */
function WithheldForecastNotice({ count }: { count: number }) {
  return (
    <FovAlert
      tone="info"
      testId="fo-inbox-forecasts-withheld"
      message={`${count} agency forecast row${count === 1 ? '' : 's'} not shown`}
      description="Agency forecasts are a separate capability and are not enabled for this workspace, so those rows are not displayed here. The queue counts above still include them."
    />
  );
}

/**
 * Rows this page is not showing because the SBIR capability is off. A second,
 * separate notice rather than a pooled count: a reader needs to know WHICH
 * capability to ask for.
 */
function WithheldSbirNotice({ count }: { count: number }) {
  return (
    <FovAlert
      tone="info"
      testId="fo-inbox-sbir-withheld"
      message={`${count} SBIR/STTR topic row${count === 1 ? '' : 's'} not shown`}
      description="SBIR/STTR topics are a separate capability and are not enabled for this workspace, so those rows are not displayed here. The queue counts above still include them."
    />
  );
}

/**
 * One SBIR/STTR topic row. The scorer is NOT called here — the two fields a
 * scored topic would supply are passed as the constants they honestly are
 * today (see the canonical inbox's note). `actions` is EMPTY and no `onAction`
 * is passed, which renders no action row: no workflow mutation is wired for a
 * topic, and the card's rule is that an absent handler removes the control.
 */
function SbirInboxRow({
  row,
  onSelectClient,
  onOpenDetail,
}: {
  row: InboxRow;
  onSelectClient: (id: string) => void;
  onOpenDetail: () => void;
}) {
  const facts = row.sbir;
  if (!facts) {
    return (
      <SourceFactsMissingCard
        row={row}
        label={INBOX_SOURCE_SHORT_LABELS.sbir_sttr}
        testIdPrefix="fo-sbir-unrenderable"
        reason="Capiro no longer holds the topic record for this row, so no source facts can be shown."
        onSelectClient={onSelectClient}
        onOpenDetail={onOpenDetail}
      />
    );
  }

  return (
    <SbirOpportunityCard
      facts={facts}
      cycle={facts.cycle}
      clientName={row.client.name}
      relevanceScore={row.relevanceScore}
      phaseGapExplanation={SBIR_PHASE_GAP_EXPLANATION}
      eligibilityReason={SBIR_ELIGIBILITY_REASON}
      onSelectClient={() => onSelectClient(row.client.id)}
      onOpenDetail={onOpenDetail}
    />
  );
}

/**
 * One DLA bid-board row. The part-profile gap is passed as a constant
 * (DIBBS_PART_PROFILE_GAP_TODAY) because the inbox response carries no scoring
 * breakdown and `null` would assert a comparison HAPPENED. `onReviewClientParts`
 * and `onPursue` are deliberately NOT passed — there is no surface to record a
 * client's parts on yet, and no pursuit mutation wired to a DIBBS row.
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
  /* Narrowed rather than cast, so a third document type arriving from the
     provider degrades to a stated absence instead of being coerced into "rfq"
     and rendered with a quote button. */
  const facts = row.dibbs ? asPursuableDibbsFacts(row.dibbs) : null;

  if (!facts) {
    return (
      <SourceFactsMissingCard
        row={row}
        label={INBOX_SOURCE_SHORT_LABELS.dibbs}
        testIdPrefix="fo-dibbs-unrenderable"
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
 * A row whose source facts cannot be rendered, on any non-catalog rail. Stays
 * on the ROW'S OWN rail and states the absence, rather than falling back to
 * the generic opportunity card (which would render "No deadline stated" and
 * "Not evaluated" against questions never asked of the record).
 */
function SourceFactsMissingCard({
  row,
  label,
  testIdPrefix,
  reason,
  onSelectClient,
  onOpenDetail,
}: {
  row: InboxRow;
  label: string;
  testIdPrefix: string;
  reason: string;
  onSelectClient: (id: string) => void;
  onOpenDetail: () => void;
}) {
  return (
    <FovCard className="fov-card--dibbs" testId={`${testIdPrefix}-${row.id}`}>
      <div className="fov-inbox-row__head">
        <span className="fov-row">
          <button
            type="button"
            className="fov-inbox-row__client"
            onClick={() => onSelectClient(row.client.id)}
            aria-label={`Show only ${row.client.name}`}
          >
            {row.client.name}
          </button>
          <FovPill tone="geekblue">{label}</FovPill>
        </span>
      </div>
      <div className="fov-card__title">
        <button
          type="button"
          className="fov-inbox-row__title"
          onClick={onOpenDetail}
          aria-label={`Open bid-board detail for ${row.title}`}
        >
          {row.title}
        </button>
      </div>
      <div className="fov-card__meta">
        <span className="fov-muted">{reason}</span>
      </div>
    </FovCard>
  );
}

/** Two-letter monogram for the row's avatar chip. UI-only derivation, no server field. */
function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase() || '—';
}

/**
 * One decision context. Leads with the CLIENT, then the recommendation-relevant
 * facts, then the state. The source rail is a small pill rather than a heading
 * — the visual form of "source is a filter, not the model".
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
    <FovCard testId={`fo-inbox-row-${row.id}`}>
      <div className="fov-inbox-row__head">
        <span className="fov-row">
          <span className="fov-inbox-row__avatar" aria-hidden="true">
            {initialsFor(row.client.name)}
          </span>
          {/* Every row names its client. Without it a cross-client list is unusable. */}
          <button
            type="button"
            className="fov-inbox-row__client"
            onClick={() => onSelectClient(row.client.id)}
            aria-label={`Show only ${row.client.name}`}
          >
            {row.client.name}
          </button>
          {/* INBOX_SOURCE_SHORT_LABELS, not SOURCE_LABELS: the row TYPE admits
              three rails now, and a lookup that can return undefined for a
              legal value would render an empty pill rather than fail. */}
          <FovPill tone={row.source === 'grants_gov' ? 'purple' : 'cyan'}>
            {INBOX_SOURCE_SHORT_LABELS[row.source]}
          </FovPill>
          {row.humanDecision ? (
            <FovPill tone={DECISION_COLORS[row.humanDecision] ?? 'default'}>
              {DECISION_LABELS[row.humanDecision] ?? `Decided: ${row.humanDecision}`}
            </FovPill>
          ) : null}
          <FovPill tone={row.workflowStatus === 'pursuing' ? 'geekblue' : 'default'}>
            {WORKFLOW_LABELS[row.workflowStatus as keyof typeof WORKFLOW_LABELS] ??
              row.workflowStatus}
          </FovPill>
          {row.sourceClosed ? (
            <FovPill
              tone="red"
              title="The source has been observed closed since this row was created. The decision on it still stands."
            >
              Source closed
            </FovPill>
          ) : null}
          {row.noLongerSuggested ? (
            <FovPill title="The nightly matcher no longer suggests this, but your decision on it stands.">
              No longer suggested
            </FovPill>
          ) : null}
        </span>
      </div>

      <div className="fov-card__title">
        {/* A BUTTON, not a link with an href. Opening the drawer is a
            same-page state change written to the URL; an anchor would offer a
            "open in new tab" that does not do what it says. */}
        <button
          type="button"
          className="fov-inbox-row__title"
          onClick={onOpenDetail}
          aria-label={`Open detail for ${row.title}`}
        >
          {row.title}
        </button>
      </div>
      <div className="fov-card__meta">
        <span className="fov-muted">{row.agency ?? 'Agency not stated'}</span>
      </div>

      <div className="fov-card__facts">
        <span className="fov-fact">
          <span className="fov-fact__label">Deadline</span>
          <span className="fov-fact__value">
            {deadline.text}
            {row.daysUntilDeadline != null && row.daysUntilDeadline >= 0 ? (
              <span
                className={row.daysUntilDeadline <= 14 ? 'fov-danger-text' : 'fov-micro'}
                style={{ fontSize: 11 }}
              >
                {' '}
                ({row.daysUntilDeadline}d)
              </span>
            ) : null}
          </span>
        </span>

        <span className="fov-fact">
          <span className="fov-fact__label">Eligibility</span>
          {/* An eligibility nobody has evaluated is "Not evaluated", never
              "Eligible" and never a blank cell. */}
          <span className="fov-fact__value">
            {eligibility ? (ELIGIBILITY_LABELS[eligibility] ?? eligibility) : 'Not evaluated'}
          </span>
        </span>

        <span className="fov-fact">
          <span className="fov-fact__label">Relevance</span>
          <span className="fov-fact__value">{row.relevanceScore ?? 'Not scored'}</span>
        </span>

        <span className="fov-fact">
          <span className="fov-fact__label">Owner</span>
          <span className="fov-fact__value">
            {row.owner?.name ?? row.owner?.email ?? 'Unassigned'}
          </span>
        </span>

        <span className="fov-fact">
          <span className="fov-fact__label">Next action</span>
          <span className="fov-fact__value">{row.nextAction ?? 'None recorded'}</span>
        </span>
      </div>

      {row.eligibility.reason ? (
        <p className="fov-inbox-row__eligibility-reason">{row.eligibility.reason}</p>
      ) : null}

      <div className="fov-inbox-row__footer">
        <CapiroButton size="compact" onClick={onOpenDetail}>
          Open decision →
        </CapiroButton>
      </div>
    </FovCard>
  );
}

/**
 * WHY the queue is empty — four different situations with four different
 * fixes, all derived from counts the API already returns, ordered
 * widest-cause-first.
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
  let action: ReactNode = null;

  if (unreadable) {
    heading = 'Nothing to show, and the counts could not be read';
    detail =
      'The queue is empty in this page of results, but the counts that would explain why are unavailable. Retry before concluding there is no work waiting.';
  } else if (data.clientId && otherClientsHave > 0) {
    heading = `${clientName ?? 'This client'} has nothing in ${INBOX_FILTER_LABELS[filter].toLowerCase()}`;
    detail = `Other clients have ${otherClientsHave} here. The client filter is what is hiding them.`;
    action = (
      <CapiroButton size="compact" onClick={onClearClient}>
        Show every client
      </CapiroButton>
    );
  } else if (source) {
    heading = `Nothing in ${INBOX_FILTER_LABELS[filter].toLowerCase()} on this source`;
    detail =
      'The source filter narrows this queue to one rail. The other rail is not counted here.';
    action = (
      <CapiroButton size="compact" onClick={onClearSource}>
        Show all sources
      </CapiroButton>
    );
  } else if (elsewhere.length > 0) {
    heading = `Nothing in ${INBOX_FILTER_LABELS[filter].toLowerCase()}`;
    detail = `${INBOX_FILTER_DESCRIPTIONS[filter]} Other queues do have work waiting.`;
    action = (
      <span className="fov-row">
        {elsewhere.map((f) => (
          <CapiroButton key={f} size="compact" onClick={() => onGoToFilter(f)}>
            {INBOX_FILTER_LABELS[f]} ({counts[f]})
          </CapiroButton>
        ))}
      </span>
    );
  } else if (totalHere === 0) {
    // Nothing in ANY queue. Either the producers have never run, or the source
    // rails are empty/stale — both visible in the freshness strip above, and
    // neither of which is "there are no opportunities".
    heading = 'No client-opportunity decisions exist yet';
    detail =
      'No queue has any rows. Either the nightly matchers have not produced suggestions for these clients, or the source rails above have not synced. This is not a statement that no relevant opportunities exist.';
  } else {
    heading = `Nothing in ${INBOX_FILTER_LABELS[filter].toLowerCase()}`;
    detail = INBOX_FILTER_DESCRIPTIONS[filter];
  }

  return (
    <FovCard testId="fo-inbox-empty">
      <div className="fov-empty">
        <span className="fov-empty__title">{heading}</span>
        <span className="fov-muted">{detail}</span>
        {action ? <div style={{ marginTop: 12 }}>{action}</div> : null}
      </div>
    </FovCard>
  );
}
