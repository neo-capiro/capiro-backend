import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { OpportunityOutcomeModal } from './OpportunityOutcomeModal.js';
import type { OutcomeHistoryResultView, RecordOutcomeResultView } from './funding-opportunities-api.js';

/**
 * Outcome capture and governed learning candidate (P36).
 *
 * Four rules carry the modal:
 *   1. Submit is disabled until a reason code AND a note are both present.
 *   2. Every prior outcome for this opportunity is visible, most recent first,
 *      with the current one tagged — nothing lets a person edit an old one.
 *   3. A learning-candidate failure is stated, and the outcome is still shown
 *      as recorded.
 *   4. A refusal (disabled/denied/invalid) renders the server's own sentence.
 */

const CLIENT = '22222222-2222-2222-2222-222222222222';
const SAM_ID = '44444444-4444-4444-4444-444444444444';

const { apiGetMock, apiPostMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
}));

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock, post: apiPostMock, patch: vi.fn() }),
}));

function emptyHistory(): OutcomeHistoryResultView {
  return { state: 'available', explanation: 'No outcome has been recorded for this opportunity yet.', outcomes: [] };
}

function recordedResult(over: Partial<RecordOutcomeResultView & { state: 'recorded' }> = {}): RecordOutcomeResultView {
  return {
    state: 'recorded',
    memoryCandidateProposed: true,
    outcome: {
      id: 'evt-1',
      kind: 'lost',
      outcomeDate: '2026-08-01T00:00:00.000Z',
      reasonCodes: ['price'],
      note: 'Lost on price.',
      vehicleOutcome: null,
      sourceAwardLink: null,
      recordedByUserId: 'user-1',
      recordedAt: '2026-08-01T00:00:00.000Z',
      current: true,
    },
    ...over,
  };
}

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

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AntApp>{node}</AntApp>
    </QueryClientProvider>,
  );
}

function modal(over: Record<string, unknown> = {}) {
  return (
    <OpportunityOutcomeModal
      open
      onClose={() => {}}
      clientId={CLIENT}
      source="sam_gov"
      sourceRecordId={SAM_ID}
      kind="lost"
      {...over}
    />
  );
}

beforeEach(() => {
  setupBrowserMocks();
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  apiGetMock.mockResolvedValue({ data: emptyHistory() });
});

describe('THE RULE: submit is disabled until a reason AND a note are both present', () => {
  test('neither present — disabled', async () => {
    wrap(modal());
    await screen.findByTestId('fo-outcome-history');
    const ok = screen.getByRole('button', { name: /record outcome/i });
    expect(ok).toBeDisabled();
  });

  test('a reason with no note — still disabled', async () => {
    wrap(modal());
    await screen.findByTestId('fo-outcome-history');
    fireEvent.click(screen.getByTestId('fo-outcome-reason-price'));
    expect(screen.getByRole('button', { name: /record outcome/i })).toBeDisabled();
  });

  test('a note with no reason — still disabled', async () => {
    wrap(modal());
    await screen.findByTestId('fo-outcome-history');
    fireEvent.change(screen.getByTestId('fo-outcome-note'), {
      target: { value: 'Lost on price.' },
    });
    expect(screen.getByRole('button', { name: /record outcome/i })).toBeDisabled();
  });

  test('both present — enabled, and submitting posts the right body', async () => {
    apiPostMock.mockResolvedValue({ data: recordedResult() });
    wrap(modal());
    await screen.findByTestId('fo-outcome-history');

    fireEvent.click(screen.getByTestId('fo-outcome-reason-price'));
    fireEvent.change(screen.getByTestId('fo-outcome-note'), {
      target: { value: 'Lost on price.' },
    });
    const ok = screen.getByRole('button', { name: /record outcome/i });
    expect(ok).not.toBeDisabled();
    fireEvent.click(ok);

    await waitFor(() => expect(apiPostMock).toHaveBeenCalled());
    const [path, body] = apiPostMock.mock.calls[0]!;
    expect(path).toBe(`/api/intelligence/clients/${CLIENT}/opportunities/sam_gov/${SAM_ID}/outcome`);
    expect(body.kind).toBe('lost');
    expect(body.reasonCodes).toEqual(['price']);
    expect(body.note).toBe('Lost on price.');
  });

  test('reason codes are capped at five', async () => {
    wrap(modal({ kind: 'lost' }));
    await screen.findByTestId('fo-outcome-history');
    const codes = ['price', 'technical_score', 'past_performance_gap', 'no_bid_competitive', 'set_aside_ineligible', 'protest_related'];
    for (const code of codes) fireEvent.click(screen.getByTestId(`fo-outcome-reason-${code}`));
    expect(screen.getByText('Reason (5/5)')).toBeTruthy();
  });
});

describe('THE RULE: every prior outcome is visible, most recent first, none editable', () => {
  test('history renders with the current one tagged', async () => {
    apiGetMock.mockResolvedValue({
      data: {
        state: 'available',
        explanation: '2 outcome records, most recent first.',
        outcomes: [
          {
            id: 'evt-2',
            kind: 'lost',
            outcomeDate: '2026-09-01T00:00:00.000Z',
            reasonCodes: ['technical_score'],
            note: 'Corrected after debrief.',
            vehicleOutcome: null,
            sourceAwardLink: null,
            recordedByUserId: 'user-1',
            recordedAt: '2026-09-01T00:00:00.000Z',
            current: true,
          },
          {
            id: 'evt-1',
            kind: 'lost',
            outcomeDate: '2026-08-01T00:00:00.000Z',
            reasonCodes: ['price'],
            note: 'Initial loss.',
            vehicleOutcome: null,
            sourceAwardLink: null,
            recordedByUserId: 'user-1',
            recordedAt: '2026-08-01T00:00:00.000Z',
            current: false,
          },
        ],
      },
    });
    wrap(modal());
    await screen.findByText('Corrected after debrief.');
    const history = screen.getByTestId('fo-outcome-history');
    expect(history.textContent).toContain('Corrected after debrief.');
    expect(history.textContent).toContain('Initial loss.');
    expect(history.textContent).toContain('Current');

    // No input, textarea or button inside the history list — nothing here
    // lets a person edit an old entry.
    expect(history.querySelectorAll('input, textarea, button')).toHaveLength(0);
  });

  test('no history is a stated fact, not a blank area', async () => {
    wrap(modal());
    await screen.findByText('No outcome recorded yet.');
  });
});

describe('THE RULE: a learning-candidate failure is stated; the outcome still shows as recorded', () => {
  test('memoryCandidateProposed=false renders success with the caveat, not a failure', async () => {
    apiPostMock.mockResolvedValue({ data: recordedResult({ memoryCandidateProposed: false }) });
    wrap(modal());
    await screen.findByTestId('fo-outcome-history');
    fireEvent.click(screen.getByTestId('fo-outcome-reason-price'));
    fireEvent.change(screen.getByTestId('fo-outcome-note'), {
      target: { value: 'Lost on price.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /record outcome/i }));

    const recorded = await screen.findByTestId('fo-outcome-recorded');
    expect(recorded.textContent).toContain('could not be proposed right now');
    expect(recorded.textContent).toContain('does not affect the recorded outcome');
  });

  test('memoryCandidateProposed=true renders the plain success message', async () => {
    apiPostMock.mockResolvedValue({ data: recordedResult({ memoryCandidateProposed: true }) });
    wrap(modal());
    await screen.findByTestId('fo-outcome-history');
    fireEvent.click(screen.getByTestId('fo-outcome-reason-price'));
    fireEvent.change(screen.getByTestId('fo-outcome-note'), {
      target: { value: 'Lost on price.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /record outcome/i }));
    const recorded = await screen.findByTestId('fo-outcome-recorded');
    expect(recorded.textContent).toContain('learning candidate was proposed for review');
  });
});

describe('THE RULE: a refusal renders the server’s own sentence', () => {
  test('a disabled/denied/invalid_request response renders as a warning, not a success', async () => {
    apiPostMock.mockResolvedValue({
      data: { state: 'invalid_request', explanation: 'At least one reason code is required for a "lost" outcome.' },
    });
    wrap(modal());
    await screen.findByTestId('fo-outcome-history');
    fireEvent.click(screen.getByTestId('fo-outcome-reason-price'));
    fireEvent.change(screen.getByTestId('fo-outcome-note'), {
      target: { value: 'Lost on price.' },
    });
    fireEvent.click(screen.getByRole('button', { name: /record outcome/i }));

    const refused = await screen.findByTestId('fo-outcome-refused');
    expect(refused.textContent).toContain('At least one reason code is required');
    expect(screen.queryByTestId('fo-outcome-recorded')).toBeNull();
  });
});
