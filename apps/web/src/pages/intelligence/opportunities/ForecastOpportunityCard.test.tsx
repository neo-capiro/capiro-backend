import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { ForecastOpportunityCard } from './ForecastOpportunityCard.js';
import { ForecastOpportunityDetail } from './ForecastOpportunityDetail.js';
import {
  formatForecastFreshness,
  formatSourceDate,
  type ForecastOpportunityRecord,
  type InboxForecastFacts,
  type InboxRow,
} from './funding-opportunities-api.js';

/**
 * Agency forecasts in the UI (P26).
 *
 * ── The bar these tests hold the surface to ──────────────────────────────────
 *
 * The phase's acceptance line is a statement about RENDERED TEXT: "No forecast
 * card says open, solicitation, eligible, or deadline unless source states it."
 * So the central tests here read the DOM and assert on the words in it, rather
 * than checking that some prop was passed. A component can be perfectly wired
 * and still say "Deadline: none stated" in a label, which would be the exact
 * false claim the whole phase exists to avoid.
 *
 * The other three properties tested: a forecast never offers Pursue or Submit; a
 * signal that could not be evaluated renders differently from one that was
 * evaluated and did not match; and a Postgres DATE never travels through a local
 * timezone on its way to the screen.
 */

const { apiGetMock } = vi.hoisted(() => ({ apiGetMock: vi.fn() }));

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock, post: vi.fn(), patch: vi.fn() }),
}));

function setupBrowserMocks() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  Object.defineProperty(window, 'getComputedStyle', {
    writable: true,
    value: () => ({ getPropertyValue: () => '' }),
  });
}

function facts(partial: Partial<InboxForecastFacts> = {}): InboxForecastFacts {
  return {
    anticipatedAwardDate: '2027-03-01',
    anticipatedSolicitationDate: null,
    estimatedPeriod: 'Q2 FY27',
    fiscalYear: 2027,
    sourceSystem: 'APFS',
    status: 'Forecasted',
    isActive: true,
    lastSyncedAt: '2026-08-06T02:00:00.000Z',
    providerModifiedAt: null,
    ...partial,
  };
}

function forecastRow(partial: Partial<InboxRow> = {}): InboxRow {
  return {
    id: 'wf-f1',
    client: { id: 'client-1', name: 'Acme Defense' },
    source: 'agency_forecast',
    sourceRecordId: 'FCST-1',
    title: 'Depot-level turbofan sustainment',
    agency: 'Department of the Navy',
    forecast: facts(),
    dibbs: null,
    sbir: null,
    // A forecast has no response deadline. The API sends null; the card must not
    // render a deadline slot at all.
    responseDeadline: null,
    daysUntilDeadline: null,
    workflowStatus: 'suggested',
    humanDecision: null,
    nextAction: null,
    nextActionDueAt: null,
    owner: null,
    relevanceScore: null,
    eligibility: { state: null, reason: null },
    noLongerSuggested: false,
    sourceClosed: false,
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...partial,
  };
}

function forecastRecord(partial: Partial<ForecastOpportunityRecord> = {}): ForecastOpportunityRecord {
  return {
    source: 'agency_forecast',
    sourceRecordId: 'FCST-1',
    externalId: 'APFS-9001',
    title: 'Depot-level turbofan sustainment',
    description: 'The Department anticipates a follow-on requirement for engine overhaul.',
    agency: 'Department of the Navy',
    departmentName: 'Department of Defense',
    organizationAgencyName: null,
    officeName: 'NAVSUP FLC',
    facts: facts(),
    naicsCode: '336412',
    pscCode: null,
    setAside: 'Total Small Business',
    contractVehicle: 'To Be Determined',
    placeOfPerformance: 'Jacksonville, FL',
    primaryContact: null,
    sourceUrl: null,
    recommendation: {
      forecastRecommendation: 'shape_now',
      machineRecommendation: 'monitor',
      recommendationConfidence: 'medium',
      primaryReason: "An exact program or capability match against this client's recorded profile.",
      primaryRisk: 'No confirmed acquisition vehicle access for this agency yet.',
      recommendedNextAction:
        'Research the program office and confirm a route to compete before a solicitation posts.',
      reasonCodes: ['exact_naics_match', 'capability_match'],
      signals: {
        exactNaicsMatch: true,
        exactPscMatch: false,
        capabilityMatch: true,
        priorAgencyHistory: false,
        programElementLinkedSourceBacked: false,
        locationMatch: true,
        knownVehicleAccess: false,
        reviewedStrategicPriority: false,
        unavailable: [
          {
            signal: 'exactPscMatch',
            reason: 'This provider resource states no product/service code at all.',
          },
          {
            signal: 'knownVehicleAccess',
            reason: 'Acquisition-position scoring is not enabled for this workspace.',
          },
          {
            signal: 'reviewedStrategicPriority',
            reason: 'No reviewed strategic-priority watch list exists yet.',
          },
        ],
      },
    },
    clientId: 'client-1',
    decision: null,
    workflow: null,
    linkedOpportunity: null,
    missingProfileFields: [],
    generatedAt: '2026-08-07T12:00:00.000Z',
    ...partial,
  };
}

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AntApp>{node}</AntApp>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setupBrowserMocks();
  apiGetMock.mockReset();
});

// ── Date formatting: a DATE must not travel through a timezone ───────────────

describe('a source-stated date is formatted from its parts, never from an instant', () => {
  test('a YYYY-MM-DD renders as the day the agency actually stated', () => {
    // `new Date('2027-03-01')` parses as UTC midnight and formats in local time,
    // so every reader west of Greenwich would see 28 February. Formatting from
    // the parts is correct because a DATE has no instant to convert.
    expect(formatSourceDate('2027-03-01')).toBe('1 Mar 2027');
    expect(formatSourceDate('2027-01-31')).toBe('31 Jan 2027');
  });

  test('null renders as the caller’s placeholder, never as a date', () => {
    expect(formatSourceDate(null)).toBe('Not provided by the source');
    expect(formatSourceDate(null, 'Not stated by the agency')).toBe('Not stated by the agency');
  });

  test('an unexpected source value is echoed verbatim rather than guessed at', () => {
    expect(formatSourceDate('FY27 Q2')).toBe('FY27 Q2');
  });
});

describe('the forecast freshness line states both observation and revision', () => {
  test('with no revision date it says the agency stated none', () => {
    expect(formatForecastFreshness(facts())).toMatch(
      /Last observed .* · agency states no revision date/,
    );
  });

  test('with a revision date it states both', () => {
    const line = formatForecastFreshness(
      facts({ providerModifiedAt: '2026-07-30T18:20:00.000Z' }),
    );
    expect(line).toMatch(/Last observed/);
    expect(line).toMatch(/agency last revised/);
  });

  test('never observed says exactly that, not a date', () => {
    expect(formatForecastFreshness(facts({ lastSyncedAt: null }))).toBe(
      'Never observed by Capiro',
    );
  });
});

// ── The card ────────────────────────────────────────────────────────────────

describe('the forecast card labels the record for what it is', () => {
  test('the label carries BOTH facts: where it came from and what it is', () => {
    wrap(
      <ForecastOpportunityCard row={forecastRow()} onSelectClient={vi.fn()} onOpenDetail={vi.fn()} />,
    );
    expect(screen.getByTestId('fo-forecast-label').textContent).toBe(
      'Agency forecast · early signal',
    );
  });

  test('the card names its client, because the inbox is cross-client', () => {
    wrap(
      <ForecastOpportunityCard row={forecastRow()} onSelectClient={vi.fn()} onOpenDetail={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Show only Acme Defense' })).toBeTruthy();
  });

  test('the anticipated award date is labelled as an award estimate, never a deadline', () => {
    wrap(
      <ForecastOpportunityCard row={forecastRow()} onSelectClient={vi.fn()} onOpenDetail={vi.fn()} />,
    );
    expect(screen.getByText('Anticipated award')).toBeTruthy();
    expect(screen.getByTestId('fo-forecast-award-date').textContent).toBe('1 Mar 2027');
  });

  test('the anticipated solicitation date is STATED as not provided, not omitted', () => {
    // Omitting the row reads as "there will not be one". The provider genuinely
    // states no such field on this resource, and that is what the card says.
    wrap(
      <ForecastOpportunityCard row={forecastRow()} onSelectClient={vi.fn()} onOpenDetail={vi.fn()} />,
    );
    expect(screen.getByTestId('fo-forecast-solicitation-date').textContent).toBe(
      'Not provided by the source',
    );
  });

  test('the agency system and freshness are both on the card', () => {
    wrap(
      <ForecastOpportunityCard row={forecastRow()} onSelectClient={vi.fn()} onOpenDetail={vi.fn()} />,
    );
    expect(screen.getByText(/via APFS/)).toBeTruthy();
    expect(screen.getByTestId('fo-forecast-freshness').textContent).toMatch(/Last observed/);
  });

  test('an unscored forecast says "Not scored yet", not zero', () => {
    wrap(
      <ForecastOpportunityCard row={forecastRow()} onSelectClient={vi.fn()} onOpenDetail={vi.fn()} />,
    );
    expect(screen.getByTestId('fo-forecast-relevance').textContent).toBe('Not scored yet');
  });

  test('a scored forecast shows its persisted score', () => {
    wrap(
      <ForecastOpportunityCard
        row={forecastRow({ relevanceScore: 71 })}
        onSelectClient={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );
    expect(screen.getByTestId('fo-forecast-relevance').textContent).toBe('71');
  });

  test('the agency’s own inactive flag is the ONLY thing that reports withdrawal', () => {
    const { unmount } = wrap(
      <ForecastOpportunityCard
        row={forecastRow({ forecast: facts({ isActive: false }) })}
        onSelectClient={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );
    expect(screen.getByTestId('fo-forecast-inactive').textContent).toMatch(/Withdrawn by the agency/);
    unmount();

    // `null` states nothing and must render nothing — never "open".
    wrap(
      <ForecastOpportunityCard
        row={forecastRow({ forecast: facts({ isActive: null }) })}
        onSelectClient={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('fo-forecast-inactive')).toBeNull();
  });

  test('a record Capiro no longer holds says so instead of showing empty facts', () => {
    wrap(
      <ForecastOpportunityCard
        row={forecastRow({ forecast: null, title: 'Source record no longer in the catalog' })}
        onSelectClient={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );
    expect(screen.getByTestId('fo-forecast-freshness').textContent).toMatch(
      /no longer holds this forecast record/i,
    );
  });

  test('opening the detail is a button, and it fires the callback', () => {
    const onOpenDetail = vi.fn();
    wrap(
      <ForecastOpportunityCard
        row={forecastRow()}
        onSelectClient={vi.fn()}
        onOpenDetail={onOpenDetail}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Open agency forecast detail for Depot-level turbofan sustainment',
      }),
    );
    expect(onOpenDetail).toHaveBeenCalledTimes(1);
  });
});

describe('THE ACCEPTANCE BAR: no forecast card claims a competition exists', () => {
  const BANNED = [/\bopen\b/i, /solicitation/i, /eligib/i, /deadline/i];

  test('none of the four banned words appears in the card’s own text', () => {
    // "Anticipated solicitation" is the one permitted use and it appears as a
    // FIELD LABEL whose value is "Not provided by the source" — so it is checked
    // separately below rather than banned outright.
    const { container } = wrap(
      <ForecastOpportunityCard row={forecastRow()} onSelectClient={vi.fn()} onOpenDetail={vi.fn()} />,
    );
    const text = container.textContent ?? '';
    for (const banned of [BANNED[0]!, BANNED[2]!, BANNED[3]!]) {
      expect(text).not.toMatch(banned);
    }
  });

  test('the only mention of "solicitation" is the not-provided field label', () => {
    const { container } = wrap(
      <ForecastOpportunityCard row={forecastRow()} onSelectClient={vi.fn()} onOpenDetail={vi.fn()} />,
    );
    const text = container.textContent ?? '';
    const mentions = text.match(/solicitation/gi) ?? [];
    expect(mentions).toHaveLength(1);
    expect(text).toMatch(/Anticipated solicitationNot provided by the source/);
  });

  test('there is no eligibility field at all — not even "Unknown"', () => {
    // Absent, not blank and not "Unknown": a forecast is not something a client
    // can be barred from, so an eligibility row would answer a question nobody
    // asked and would read as a determination.
    const { container } = wrap(
      <ForecastOpportunityCard row={forecastRow()} onSelectClient={vi.fn()} onOpenDetail={vi.fn()} />,
    );
    expect(container.textContent).not.toMatch(/eligib/i);
  });

  test('there is no deadline field, even though the row type has the column', () => {
    const { container } = wrap(
      <ForecastOpportunityCard
        // A deadline value the API would never send for a forecast. Even if one
        // arrived, the card must not render it.
        row={forecastRow({ responseDeadline: '2026-09-01T00:00:00.000Z', daysUntilDeadline: 25 })}
        onSelectClient={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );
    expect(container.textContent).not.toMatch(/deadline/i);
    expect(container.textContent).not.toMatch(/25d/);
  });
});

describe('a forecast never offers Pursue or Submit', () => {
  test('the four offered actions are exactly Monitor / Assign research / Plan capability briefing / Pass', () => {
    wrap(
      <ForecastOpportunityCard
        row={forecastRow()}
        onSelectClient={vi.fn()}
        onOpenDetail={vi.fn()}
        onAction={vi.fn()}
      />,
    );
    const actions = screen.getByTestId('fo-forecast-actions');
    expect(actions.textContent).toBe('MonitorAssign researchPlan capability briefingPass');
  });

  test('neither Pursue nor Submit is rendered, disabled or otherwise', () => {
    wrap(
      <ForecastOpportunityCard
        row={forecastRow()}
        onSelectClient={vi.fn()}
        onOpenDetail={vi.fn()}
        onAction={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /pursue/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /submit/i })).toBeNull();
  });

  test('with no handler the actions are ABSENT rather than inert', () => {
    // A disabled button that never becomes enabled is a promise the surface does
    // not keep.
    wrap(
      <ForecastOpportunityCard row={forecastRow()} onSelectClient={vi.fn()} onOpenDetail={vi.fn()} />,
    );
    expect(screen.queryByTestId('fo-forecast-actions')).toBeNull();
  });

  test('each action reports itself by its own key', () => {
    const onAction = vi.fn();
    wrap(
      <ForecastOpportunityCard
        row={forecastRow()}
        onSelectClient={vi.fn()}
        onOpenDetail={vi.fn()}
        onAction={onAction}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Plan capability briefing' }));
    expect(onAction).toHaveBeenCalledWith('plan_capability_briefing');
  });
});

// ── The detail ──────────────────────────────────────────────────────────────

describe('the forecast detail explains the gaps rather than hiding them', () => {
  test('it fetches the forecast read route, with the client', async () => {
    apiGetMock.mockResolvedValue({ data: forecastRecord() });
    wrap(<ForecastOpportunityDetail forecastId="FCST-1" clientId="client-1" />);
    await waitFor(() => expect(screen.getByTestId('fo-forecast-detail')).toBeTruthy());
    expect(apiGetMock).toHaveBeenCalledWith(
      '/api/intelligence/opportunities/forecasts/FCST-1?clientId=client-1',
    );
  });

  test('the recommendation is the forecast vocabulary, and confidence is labelled as evidence', async () => {
    apiGetMock.mockResolvedValue({ data: forecastRecord() });
    wrap(<ForecastOpportunityDetail forecastId="FCST-1" clientId="client-1" />);
    await waitFor(() => expect(screen.getByTestId('fo-forecast-recommendation')).toBeTruthy());
    expect(screen.getByTestId('fo-forecast-recommendation').textContent).toBe('Shape now');
    expect(screen.getByTestId('fo-forecast-confidence').textContent).toBe('Confidence: medium');
  });

  test('a signal that could not be EVALUATED renders differently from one that did not match', async () => {
    apiGetMock.mockResolvedValue({ data: forecastRecord() });
    wrap(<ForecastOpportunityDetail forecastId="FCST-1" clientId="client-1" />);
    await waitFor(() => expect(screen.getByTestId('fo-forecast-evidence')).toBeTruthy());
    // PSC could not be evaluated — the provider states no code.
    expect(screen.getByTestId('fo-forecast-signal-exactPscMatch').textContent).toMatch(
      /not evaluated/,
    );
    // Prior agency history WAS evaluated and did not match.
    expect(screen.getByTestId('fo-forecast-signal-priorAgencyHistory').textContent).toMatch(
      /no match/,
    );
    // And one that did match.
    expect(screen.getByTestId('fo-forecast-signal-exactNaicsMatch').textContent).toMatch(/yes/);
  });

  test('the linkage section states an absence of a LINK, not an absence of a solicitation', async () => {
    apiGetMock.mockResolvedValue({ data: forecastRecord() });
    wrap(<ForecastOpportunityDetail forecastId="FCST-1" clientId="client-1" />);
    await waitFor(() => expect(screen.getByTestId('fo-forecast-linkage')).toBeTruthy());
    const text = screen.getByTestId('fo-forecast-linkage').textContent ?? '';
    expect(text).toMatch(/absence of a link, not evidence that no solicitation followed/i);
  });

  test('the unscoped read says fit was not calculated, and why', async () => {
    apiGetMock.mockResolvedValue({
      data: forecastRecord({ clientId: null, recommendation: null }),
    });
    wrap(<ForecastOpportunityDetail forecastId="FCST-1" clientId={null} />);
    await waitFor(() => expect(screen.getByTestId('fo-forecast-unscored')).toBeTruthy());
    expect(screen.getByTestId('fo-forecast-assessment').textContent).toMatch(
      /Not calculated without a client/,
    );
  });

  test('a 404 and a request failure get different copy', async () => {
    const notFound = new Error('404') as Error & { response: { status: number } };
    notFound.response = { status: 404 };
    apiGetMock.mockRejectedValueOnce(notFound);
    const first = wrap(<ForecastOpportunityDetail forecastId="FCST-404" clientId={null} />);
    await waitFor(() => expect(screen.getByTestId('fo-forecast-not-found')).toBeTruthy());
    first.unmount();

    apiGetMock.mockRejectedValueOnce(new Error('network down'));
    wrap(<ForecastOpportunityDetail forecastId="FCST-1" clientId={null} />);
    await waitFor(() => expect(screen.getByTestId('fo-forecast-error')).toBeTruthy());
    expect(screen.getByTestId('fo-forecast-error').textContent).toMatch(
      /request failure, not an empty record/,
    );
  });

  test('every source absence reads as a fact about the SOURCE', async () => {
    apiGetMock.mockResolvedValue({ data: forecastRecord() });
    wrap(<ForecastOpportunityDetail forecastId="FCST-1" clientId="client-1" />);
    await waitFor(() => expect(screen.getByTestId('fo-forecast-source')).toBeTruthy());
    const source = screen.getByTestId('fo-forecast-source').textContent ?? '';
    // PSC is confirmed absent from this provider resource.
    expect(source).toMatch(/PSCNot provided by the source/);
    expect(source).toMatch(/Anticipated solicitationNot provided by the source/);
  });

  test('the detail never states an eligibility or a response deadline either', async () => {
    apiGetMock.mockResolvedValue({ data: forecastRecord() });
    const { container } = wrap(
      <ForecastOpportunityDetail forecastId="FCST-1" clientId="client-1" />,
    );
    await waitFor(() => expect(screen.getByTestId('fo-forecast-detail')).toBeTruthy());
    expect(container.textContent).not.toMatch(/eligib/i);
    expect(container.textContent).not.toMatch(/deadline/i);
  });

  test('the detail offers the same four actions and no pursuit', async () => {
    apiGetMock.mockResolvedValue({ data: forecastRecord() });
    wrap(
      <ForecastOpportunityDetail forecastId="FCST-1" clientId="client-1" onAction={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByTestId('fo-forecast-detail-actions')).toBeTruthy());
    expect(screen.getByTestId('fo-forecast-detail-actions').textContent).toBe(
      'MonitorAssign researchPlan capability briefingPass',
    );
    expect(screen.queryByRole('button', { name: /pursue|submit/i })).toBeNull();
  });
});
