import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { FundingOpportunityPipeline } from './FundingOpportunityPipeline.js';
import {
  PIPELINE_STAGES,
  PIPELINE_STAGES_NEEDING_REASON,
  type PipelineBoardView,
  type PipelineCardView,
} from './funding-opportunities-api.js';

/**
 * The pursuit pipeline board (P35).
 *
 * Four rules carry it: the flag off changes nothing, no move commits without the
 * server, the counts are not the cards, and a keyboard alone can move a stage.
 */

const { apiGetMock, apiPostMock, flags } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
  apiPostMock: vi.fn(),
  flags: { funding_opportunities_pipeline_v2: true } as Record<string, boolean>,
}));

vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGetMock, post: apiPostMock, patch: vi.fn() }),
}));
vi.mock('../../../lib/intel-feature-flags.js', () => ({
  useIntelFeature: (feature: string) => ({ enabled: flags[feature] === true, ready: true }),
  useIntelFeatureEnabled: (feature: string) => flags[feature] === true,
}));

const CLIENT = '11111111-1111-1111-1111-111111111111';
const ROW = 'row-1';

function card(over: Partial<PipelineCardView> = {}): PipelineCardView {
  return {
    rowId: ROW,
    source: 'sam_gov',
    sourceRecordId: 'notice-1',
    title: 'Widget maintenance',
    stage: 'reviewing',
    stageBasis: 'recorded',
    stageExplanation: 'Moved here by a person.',
    version: 3,
    allowedTransitions: ['qualified', 'passed'],
    responseDeadline: '2026-10-01T17:00:00.000Z',
    ...over,
  };
}

function board(over: Partial<PipelineBoardView> = {}): PipelineBoardView {
  return {
    clientId: CLIENT,
    counts: {
      stages: PIPELINE_STAGES.map((stage) => ({
        stage,
        count: stage === 'reviewing' ? 1 : 0,
      })),
      unstaged: { suggested: 0, expired: 0, other: 0 },
      total: 1,
      derivedFromWorkflowStatus: 0,
    },
    cards: [card()],
    cardsTruncated: false,
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

beforeEach(() => {
  setupBrowserMocks();
  apiGetMock.mockReset();
  apiPostMock.mockReset();
  flags.funding_opportunities_pipeline_v2 = true;
});

describe('THE RULE: the flag off changes nothing', () => {
  test('renders nothing at all and makes no request', () => {
    flags.funding_opportunities_pipeline_v2 = false;
    const { container } = wrap(<FundingOpportunityPipeline clientId={CLIENT} />);
    // Asserted on TEXT rather than innerHTML: AntApp's own provider contributes a
    // wrapper element regardless, and an innerHTML check would be asserting the
    // absence of somebody else's div.
    expect(container.textContent).toBe('');
    expect(screen.queryByTestId('fo-pipeline')).toBeNull();
    expect(screen.queryByTestId('fo-pipeline-error')).toBeNull();
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  test('renders nothing without a client, rather than an empty board', () => {
    wrap(<FundingOpportunityPipeline clientId={null} />);
    expect(screen.queryByTestId('fo-pipeline')).toBeNull();
    expect(apiGetMock).not.toHaveBeenCalled();
  });
});

describe('THE RULE: no move commits without the server', () => {
  test('a move posts the target stage AND the version the board was rendered with', async () => {
    apiGetMock.mockResolvedValue({ data: board() });
    apiPostMock.mockResolvedValue({ data: {} });
    wrap(<FundingOpportunityPipeline clientId={CLIENT} />);
    fireEvent.click(await screen.findByTestId(`fo-pipeline-move-${ROW}-qualified`));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalledTimes(1));
    const [url, body] = apiPostMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe(`/api/intelligence/clients/${CLIENT}/pipeline/${ROW}/stage`);
    expect(body.toStage).toBe('qualified');
    // Without this the loser of two simultaneous moves would silently overwrite
    // the winner.
    expect(body.expectedVersion).toBe(3);
  });

  test('offers only the moves the SERVER listed for that card', async () => {
    apiGetMock.mockResolvedValue({ data: board() });
    wrap(<FundingOpportunityPipeline clientId={CLIENT} />);
    await screen.findByTestId(`fo-pipeline-card-${ROW}`);
    expect(screen.getByTestId(`fo-pipeline-move-${ROW}-qualified`)).toBeInTheDocument();
    expect(screen.getByTestId(`fo-pipeline-move-${ROW}-passed`)).toBeInTheDocument();
    // `won` is not reachable from reviewing, and the board does not pretend it is.
    expect(screen.queryByTestId(`fo-pipeline-move-${ROW}-won`)).toBeNull();
  });

  test('a card in a terminal stage says nothing moves out of it', async () => {
    apiGetMock.mockResolvedValue({
      data: board({
        cards: [card({ stage: 'won', allowedTransitions: [] })],
        counts: {
          ...board().counts,
          stages: PIPELINE_STAGES.map((stage) => ({ stage, count: stage === 'won' ? 1 : 0 })),
        },
      }),
    });
    const { container } = wrap(<FundingOpportunityPipeline clientId={CLIENT} />);
    await screen.findByTestId(`fo-pipeline-card-${ROW}`);
    expect(container.textContent ?? '').toMatch(/Nothing moves out of Won/);
  });

  test('a rejected move says why, and where the card still is', async () => {
    apiGetMock.mockResolvedValue({ data: board() });
    apiPostMock.mockRejectedValue({
      response: { status: 400, data: { message: 'reviewing moves to qualified or passed.' } },
    });
    const { container } = wrap(<FundingOpportunityPipeline clientId={CLIENT} />);
    fireEvent.click(await screen.findByTestId(`fo-pipeline-move-${ROW}-qualified`));
    await waitFor(() =>
      expect(container.ownerDocument.body.textContent ?? '').toMatch(
        /reviewing moves to qualified or passed\..*still at Reviewing/s,
      ),
    );
  });

  test('a concurrent-move conflict is reported as one, not as a generic failure', async () => {
    apiGetMock.mockResolvedValue({ data: board() });
    apiPostMock.mockRejectedValue({
      response: { status: 409, data: { message: 'Somebody else moved this opportunity.' } },
    });
    const { container } = wrap(<FundingOpportunityPipeline clientId={CLIENT} />);
    fireEvent.click(await screen.findByTestId(`fo-pipeline-move-${ROW}-qualified`));
    await waitFor(() =>
      expect(container.ownerDocument.body.textContent ?? '').toMatch(
        /Somebody else moved this first/,
      ),
    );
  });

  test('asks for a reason before posting an outcome stage', async () => {
    apiGetMock.mockResolvedValue({ data: board() });
    apiPostMock.mockResolvedValue({ data: {} });
    wrap(<FundingOpportunityPipeline clientId={CLIENT} />);
    fireEvent.click(await screen.findByTestId(`fo-pipeline-move-${ROW}-passed`));

    // Nothing posted yet — the prompt is open.
    expect(apiPostMock).not.toHaveBeenCalled();
    const input = await screen.findByTestId('fo-pipeline-reason-input');
    fireEvent.change(input, { target: { value: 'No capability fit for this scope.' } });
    fireEvent.click(screen.getByText('Record the move'));

    await waitFor(() => expect(apiPostMock).toHaveBeenCalledTimes(1));
    const [, body] = apiPostMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.reason).toBe('No capability fit for this scope.');
  });

  test('does not ask for a reason to advance within the pipeline', async () => {
    apiGetMock.mockResolvedValue({ data: board() });
    apiPostMock.mockResolvedValue({ data: {} });
    wrap(<FundingOpportunityPipeline clientId={CLIENT} />);
    fireEvent.click(await screen.findByTestId(`fo-pipeline-move-${ROW}-qualified`));
    await waitFor(() => expect(apiPostMock).toHaveBeenCalledTimes(1));
    const [, body] = apiPostMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(body.reason).toBeNull();
  });

  test('names every stage that needs a reason in the prompt', async () => {
    apiGetMock.mockResolvedValue({ data: board() });
    wrap(<FundingOpportunityPipeline clientId={CLIENT} />);
    fireEvent.click(await screen.findByTestId(`fo-pipeline-move-${ROW}-passed`));
    const modalText = (await screen.findByTestId('fo-pipeline-reason-input')).ownerDocument.body
      .textContent;
    for (const stage of PIPELINE_STAGES_NEEDING_REASON) {
      expect(modalText ?? '').toMatch(new RegExp(stage, 'i'));
    }
  });
});

describe('THE RULE: the counts are not the cards', () => {
  test('a column shows the server count, not the number of cards it holds', async () => {
    apiGetMock.mockResolvedValue({
      data: board({
        counts: {
          stages: PIPELINE_STAGES.map((stage) => ({ stage, count: stage === 'reviewing' ? 900 : 0 })),
          unstaged: { suggested: 0, expired: 0, other: 0 },
          total: 900,
          derivedFromWorkflowStatus: 0,
        },
        cards: [card()],
        cardsTruncated: true,
      }),
    });
    wrap(<FundingOpportunityPipeline clientId={CLIENT} />);
    const column = await screen.findByTestId('fo-pipeline-column-reviewing');
    expect(column).toHaveTextContent('(900)');
    // …and it says the rest are not shown, rather than implying one card is all.
    expect(screen.getByTestId('fo-pipeline-more-reviewing')).toHaveTextContent(
      '899 more not shown.',
    );
  });

  test('reports unstaged suggestions outside the columns', async () => {
    apiGetMock.mockResolvedValue({
      data: board({
        counts: {
          stages: PIPELINE_STAGES.map((stage) => ({ stage, count: 0 })),
          unstaged: { suggested: 42, expired: 7, other: 0 },
          total: 49,
          derivedFromWorkflowStatus: 0,
        },
        cards: [],
      }),
    });
    wrap(<FundingOpportunityPipeline clientId={CLIENT} />);
    const notes = await screen.findByTestId('fo-pipeline-footnotes');
    expect(notes).toHaveTextContent(/42 suggested opportunities are not in the pipeline/);
    expect(notes).toHaveTextContent(/not a stage somebody is working/);
    expect(notes).toHaveTextContent(/7 closed before this pipeline existed/);
    expect(notes).toHaveTextContent(/not recorded, and it is not guessed/);
    // The suggestions are NOT counted into reviewing.
    expect(screen.getByTestId('fo-pipeline-column-reviewing')).toHaveTextContent('(0)');
  });

  test('says how many placements came from the older status rather than a stage', async () => {
    apiGetMock.mockResolvedValue({
      data: board({
        counts: { ...board().counts, derivedFromWorkflowStatus: 1, total: 1 },
        cards: [
          card({
            stageBasis: 'workflow_status',
            stageExplanation: 'Derived from the workflow status “saved”.',
          }),
        ],
      }),
    });
    wrap(<FundingOpportunityPipeline clientId={CLIENT} />);
    expect(await screen.findByTestId('fo-pipeline-derived-note')).toHaveTextContent(
      /1 of 1 placed from the older Saved\/Pursuing status/,
    );
    expect(screen.getByTestId(`fo-pipeline-derived-${ROW}`)).toHaveTextContent('Derived');
  });

  test('marks nothing as derived when the stage was recorded by a person', async () => {
    apiGetMock.mockResolvedValue({ data: board() });
    wrap(<FundingOpportunityPipeline clientId={CLIENT} />);
    await screen.findByTestId(`fo-pipeline-card-${ROW}`);
    expect(screen.queryByTestId(`fo-pipeline-derived-${ROW}`)).toBeNull();
    expect(screen.queryByTestId('fo-pipeline-derived-note')).toBeNull();
  });

  test('a request failure is not an empty pipeline', async () => {
    apiGetMock.mockRejectedValue(new Error('boom'));
    wrap(<FundingOpportunityPipeline clientId={CLIENT} />);
    expect(await screen.findByTestId('fo-pipeline-error')).toHaveTextContent(
      /request failure, not an empty pipeline/i,
    );
  });
});

describe('THE RULE: a keyboard alone can move a stage', () => {
  test('every move control is a labelled button, reachable without a pointer', async () => {
    apiGetMock.mockResolvedValue({ data: board() });
    wrap(<FundingOpportunityPipeline clientId={CLIENT} />);
    await screen.findByTestId(`fo-pipeline-card-${ROW}`);
    const button = screen.getByLabelText('Move to Qualified');
    expect(button.tagName).toBe('BUTTON');
    expect(button).not.toBeDisabled();
  });

  test('a keyboard activation moves the stage, with no drag involved', async () => {
    apiGetMock.mockResolvedValue({ data: board() });
    apiPostMock.mockResolvedValue({ data: {} });
    wrap(<FundingOpportunityPipeline clientId={CLIENT} />);
    const button = await screen.findByLabelText('Move to Qualified');
    button.focus();
    expect(document.activeElement).toBe(button);
    // `click` is what both Enter and Space dispatch on a native button.
    fireEvent.click(button);
    await waitFor(() => expect(apiPostMock).toHaveBeenCalledTimes(1));
  });

  test('every column announces its stage and its count', async () => {
    apiGetMock.mockResolvedValue({ data: board() });
    wrap(<FundingOpportunityPipeline clientId={CLIENT} />);
    await screen.findByTestId('fo-pipeline-board');
    expect(screen.getByLabelText('Reviewing, 1 opportunities')).toBeInTheDocument();
    expect(screen.getByLabelText('Won, 0 opportunities')).toBeInTheDocument();
  });

  test('the list view offers the same moves as the board', async () => {
    apiGetMock.mockResolvedValue({ data: board() });
    wrap(<FundingOpportunityPipeline clientId={CLIENT} />);
    await screen.findByTestId('fo-pipeline-board');
    fireEvent.click(screen.getByText('List'));
    await screen.findByTestId('fo-pipeline-list');
    expect(screen.getByTestId(`fo-pipeline-list-move-${ROW}-qualified`)).toBeInTheDocument();
    expect(screen.getByTestId(`fo-pipeline-list-move-${ROW}-passed`)).toBeInTheDocument();
  });

  test('the list view explains an unstaged row rather than leaving the cell blank', async () => {
    apiGetMock.mockResolvedValue({
      data: board({
        cards: [
          card({
            stage: null,
            stageBasis: 'unstaged',
            stageExplanation: 'Not in the pipeline.',
            allowedTransitions: ['reviewing'],
          }),
        ],
      }),
    });
    wrap(<FundingOpportunityPipeline clientId={CLIENT} />);
    await screen.findByTestId('fo-pipeline-board');
    fireEvent.click(screen.getByText('List'));
    const list = await screen.findByTestId('fo-pipeline-list');
    expect(list).toHaveTextContent('Not in the pipeline');
  });
});
