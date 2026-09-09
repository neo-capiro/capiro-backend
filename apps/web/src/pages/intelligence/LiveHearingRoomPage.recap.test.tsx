/**
 * Save Recap — client-first generation.
 *
 * The modal used to generate the brief on mount, before its own client picker
 * rendered, so the chosen client only ever decided WHERE a generic recap was
 * filed. These pin the corrected contract: no client → no generation; a client
 * (default or chosen) → a brief written FOR it; switching clients discards the
 * previous preview and regenerates; a stale response can never label one
 * client's recap as another's; and the preview says honestly whether Meri
 * synthesized it and whether the client's context actually applied.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HearingBrief } from '../../lib/hearing-watch-api.js';

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  save: vi.fn(),
}));

vi.mock('../../lib/use-api.js', () => ({
  useApi: () => ({ get: vi.fn(), post: vi.fn() }),
}));
vi.mock('../../lib/intel-feature-flags.js', () => ({
  useIntelFeatureEnabled: () => true,
}));
vi.mock('../../lib/hearing-watch-api.js', () => ({
  briefToMarkdown: (b: { title: string }) => `# ${b.title}`,
  isMediaUrl: () => false,
  mediaKindOf: () => 'unknown',
  mintWsTicket: vi.fn(),
  useConfirmConsent: () => ({ mutate: vi.fn(), isPending: false }),
  useGenerateBrief: () => ({ mutate: mocks.generate, isPending: false }),
  useSaveRecap: () => ({ mutate: mocks.save, isPending: false }),
  useHearingSession: () => ({ data: undefined, isLoading: false, isError: false, refetch: vi.fn() }),
  useHearingTranscript: () => ({ data: undefined, isLoading: false, isError: false }),
}));

import { SaveRecapModal } from './LiveHearingRoomPage.js';

const CLIENTS = [
  { id: 'c-1', name: 'Anduril' },
  { id: 'c-2', name: 'Overland AI' },
];

function brief(partial: Partial<HearingBrief> = {}): HearingBrief {
  return {
    sessionId: 'session-1',
    title: 'HASC posture hearing',
    generatedAt: '2026-09-08T12:00:00.000Z',
    executiveSummary: 'Summary.',
    keyMoments: [],
    relevantQuotes: [],
    supporters: [],
    opponents: [],
    tone: 'neutral',
    risks: [],
    opportunities: [],
    recommendedNextSteps: [],
    draftClientEmail: { subject: 's', body: 'b' },
    synthesisSource: 'orchestrator',
    clientContext: { clientId: 'c-1', clientName: 'Anduril', status: 'applied', relevanceBand: 'HIGH' },
    ...partial,
  };
}

function renderModal(defaultClientId?: string) {
  return render(
    <AntApp>
      <SaveRecapModal
        sessionId="session-1"
        sessionTitle="Armed Services"
        defaultClientId={defaultClientId}
        clients={CLIENTS}
        onClose={vi.fn()}
      />
    </AntApp>,
  );
}

/** Resolve the Nth generate call the way react-query would. */
function resolveGenerate(nth: number, value: HearingBrief | null) {
  const options = mocks.generate.mock.calls[nth]?.[1] as { onSuccess: (v: HearingBrief | null) => void };
  act(() => options.onSuccess(value));
}

async function chooseClient(name: string) {
  fireEvent.mouseDown(screen.getByRole('combobox'));
  fireEvent.click(await screen.findByText(name));
}

beforeEach(() => {
  mocks.generate.mockReset();
  mocks.save.mockReset();
});
afterEach(cleanup);

describe('SaveRecapModal — client-first generation', () => {
  it('does not generate until a client is chosen, then writes the recap FOR that client', async () => {
    renderModal(undefined);
    expect(screen.getByText('Choose the client this recap is for')).toBeTruthy();
    expect(mocks.generate).not.toHaveBeenCalled();

    await chooseClient('Anduril');

    await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1));
    expect(mocks.generate.mock.calls[0]?.[0]).toEqual({ sessionId: 'session-1', clientId: 'c-1' });
    expect(screen.getByText(/Meri is writing the recap for Anduril/)).toBeTruthy();
  });

  it("generates immediately for the session's linked client", async () => {
    renderModal('c-1');
    await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1));
    expect(mocks.generate.mock.calls[0]?.[0]).toEqual({ sessionId: 'session-1', clientId: 'c-1' });
  });

  it('labels a Meri-synthesized recap with the client context that applied, and can regenerate', async () => {
    renderModal('c-1');
    await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1));
    resolveGenerate(0, brief());

    expect(screen.getByText('Meri synthesis')).toBeTruthy();
    expect(screen.getByText('Anduril priorities applied · relevance HIGH')).toBeTruthy();
    expect(screen.getByText('# HASC posture hearing')).toBeTruthy();
    expect(screen.queryByText(/not analysed/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Regenerate/ }));
    await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(2));
    expect(mocks.generate.mock.calls[1]?.[0]).toEqual({ sessionId: 'session-1', clientId: 'c-1' });
    // The stale preview is gone while the new request is in flight.
    expect(screen.queryByText('# HASC posture hearing')).toBeNull();
  });

  it('is honest about a source-verified assembly with no client context — and still lets you save it', async () => {
    renderModal('c-1');
    await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1));
    resolveGenerate(
      0,
      brief({
        synthesisSource: 'deterministic',
        clientContext: { clientId: 'c-1', clientName: 'Anduril', status: 'unavailable', relevanceBand: null },
      }),
    );

    expect(screen.getByText('Source-verified assembly — Meri was unavailable')).toBeTruthy();
    expect(screen.getByText('No client context available — general recap')).toBeTruthy();
    expect(screen.getByText('This recap was assembled from the transcript, not analysed')).toBeTruthy();
    const save = screen.getByRole('button', { name: /Save to Client Profile/ });
    expect(save).not.toBeDisabled();
  });

  it('switching client discards the previous preview, regenerates, and ignores the stale response', async () => {
    renderModal('c-1');
    await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1));
    resolveGenerate(0, brief());
    expect(screen.getByText('# HASC posture hearing')).toBeTruthy();

    await chooseClient('Overland AI');

    await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(2));
    expect(mocks.generate.mock.calls[1]?.[0]).toEqual({ sessionId: 'session-1', clientId: 'c-2' });
    expect(screen.queryByText('# HASC posture hearing')).toBeNull();
    expect(screen.getByText(/Meri is writing the recap for Overland AI/)).toBeTruthy();

    // A late answer to the FIRST request (Anduril) must not surface as Overland's recap.
    resolveGenerate(0, brief({ title: 'Stale Anduril recap' }));
    expect(screen.queryByText('# Stale Anduril recap')).toBeNull();
    expect(screen.getByText(/Meri is writing the recap for Overland AI/)).toBeTruthy();

    resolveGenerate(1, brief({ title: 'Overland recap', clientContext: { clientId: 'c-2', clientName: 'Overland AI', status: 'applied', relevanceBand: 'MEDIUM' } }));
    expect(screen.getByText('# Overland recap')).toBeTruthy();
    expect(screen.getByText('Overland AI priorities applied · relevance MEDIUM')).toBeTruthy();
  });

  it('files the recap for the chosen client', async () => {
    renderModal('c-1');
    await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1));
    resolveGenerate(0, brief());

    fireEvent.click(screen.getByRole('button', { name: /Save to Client Profile/ }));
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.save.mock.calls[0]?.[0]).toEqual({
      sessionId: 'session-1',
      clientId: 'c-1',
      title: 'Hearing recap — Armed Services',
      markdown: '# HASC posture hearing',
    });
  });
});
