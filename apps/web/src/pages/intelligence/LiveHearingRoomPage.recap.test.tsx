/**
 * Save Recap — client-first generation + honest rendering/saving.
 *
 * Pins the corrected contract: no client → no generation; a client (default or
 * chosen) → a brief written FOR it; switching clients discards the previous
 * preview and a stale response can never label one client's recap as another's.
 * The preview renders the REAL Markdown (via the safe renderer) — model
 * narrative as headings/prose, never raw `#`/`**` or an opaque id wall. A
 * deterministic (Meri-unavailable) assembly is labelled honestly and gets NO
 * Save affordance. Replacement is explicit: the modal discovers the client's
 * current recap for this session and only then offers "Update existing recap",
 * gating Save while that lookup is unresolved.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HearingBrief } from '../../lib/hearing-watch-api.js';

const mocks = vi.hoisted(() => ({
  generate: vi.fn(),
  save: vi.fn(),
  currentRecap: {
    data: null as null | { id: string },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
}));

vi.mock('../../lib/use-api-scope.js', () => ({ useApiScope: () => 'test-scope' }));
vi.mock('../../lib/use-api.js', () => ({
  useApi: () => ({ get: vi.fn(), post: vi.fn() }),
}));
vi.mock('../../lib/intel-feature-flags.js', () => ({
  useIntelFeatureEnabled: () => true,
}));
vi.mock('../../lib/hearing-watch-api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/hearing-watch-api.js')>();
  return {
    ...actual, // real briefToMarkdown, briefDisplayTitle, developmentCitations, mdEscape
    isMediaUrl: () => false,
    mediaKindOf: () => 'unknown',
    mintWsTicket: vi.fn(),
    useConfirmConsent: () => ({ mutate: vi.fn(), isPending: false }),
    useGenerateBrief: () => ({ mutate: mocks.generate, isPending: false }),
    useSaveRecap: () => ({ mutate: mocks.save, isPending: false }),
    useCurrentHearingRecap: () => mocks.currentRecap,
    useHearingSession: () => ({
      data: undefined,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    useHearingTranscript: () => ({ data: undefined, isLoading: false, isError: false }),
  };
});

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
    clientContext: {
      clientId: 'c-1',
      clientName: 'Anduril',
      status: 'applied',
      relevanceBand: 'HIGH',
    },
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

/** Render the modal the way vNext does — NO antd App provider (the real bug:
 *  AntApp.useApp().message is `{}` there, so a naive message.success throws). */
function renderModalNoAntApp(onClose = vi.fn()) {
  return {
    onClose,
    ...render(
      <SaveRecapModal
        sessionId="session-1"
        sessionTitle="Armed Services"
        defaultClientId="c-1"
        clients={CLIENTS}
        onClose={onClose}
      />,
    ),
  };
}

/** Resolve the Nth generate call the way react-query would. */
function resolveGenerate(nth: number, value: HearingBrief | null) {
  const options = mocks.generate.mock.calls[nth]?.[1] as {
    onSuccess: (v: HearingBrief | null) => void;
  };
  act(() => options.onSuccess(value));
}

/** Reject the Nth generate call (generation failure / Meri unavailable). */
function rejectGenerate(nth: number) {
  const options = mocks.generate.mock.calls[nth]?.[1] as { onError: (e: unknown) => void };
  act(() => options.onError(new Error('Meri unavailable')));
}

async function chooseClient(name: string) {
  fireEvent.mouseDown(screen.getByRole('combobox'));
  fireEvent.click(await screen.findByText(name));
}

beforeEach(() => {
  mocks.generate.mockReset();
  mocks.save.mockReset();
  mocks.currentRecap = { data: null, isLoading: false, isError: false, refetch: vi.fn() };
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

  it('renders a Meri-synthesized recap through the safe renderer (headings, not hash marks), and can regenerate', async () => {
    renderModal('c-1');
    await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1));
    resolveGenerate(
      0,
      brief({
        summaryTitle: 'Acquisition reform takes center stage',
        keyDevelopments: [
          { title: 'Faster acquisition', text: 'Witnesses urged speed.', evidenceIds: [] },
        ],
      }),
    );

    expect(screen.getByText('Meri synthesis')).toBeTruthy();
    expect(screen.getByText('Anduril priorities applied · relevance HIGH')).toBeTruthy();
    // Real rendered structure: an <h1>/<h2> heading, not a literal "# " line.
    const h1 = document.querySelector('.hearing-recap-preview h1');
    expect(h1?.textContent).toBe('Acquisition reform takes center stage');
    expect(document.querySelector('.hearing-recap-preview h2')?.textContent).toBe(
      'Executive summary',
    );
    expect(screen.queryByText(/^# /)).toBeNull();
    // New narrative appears.
    expect(screen.getByText('Faster acquisition')).toBeTruthy();
    expect(screen.getByText('Witnesses urged speed.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Regenerate/ }));
    await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(2));
    expect(mocks.generate.mock.calls[1]?.[0]).toEqual({ sessionId: 'session-1', clientId: 'c-1' });
    // The stale preview is gone while the new request is in flight.
    expect(document.querySelector('.hearing-recap-preview h1')).toBeNull();
  });

  it('labels a deterministic fallback honestly and gives it NO Save affordance', async () => {
    renderModal('c-1');
    await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1));
    resolveGenerate(
      0,
      brief({
        synthesisSource: 'deterministic',
        clientContext: {
          clientId: 'c-1',
          clientName: 'Anduril',
          status: 'unavailable',
          relevanceBand: null,
        },
      }),
    );

    expect(
      screen.getByText('Unofficial transcript-based recap — Meri was unavailable'),
    ).toBeTruthy();
    expect(screen.getByText('No client context available — general recap')).toBeTruthy();
    expect(screen.getByText('Transcript-based recap — Meri synthesis unavailable')).toBeTruthy();
    // Deterministic output is NOT a synthesized recap: no Save button at all.
    expect(screen.queryByRole('button', { name: /Save to Client Profile/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Update existing recap/ })).toBeNull();
  });

  it('distinguishes no-transcript (null) from generation failure (error)', async () => {
    renderModal('c-1');
    await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1));
    // null → nothing transcribed yet.
    resolveGenerate(0, null);
    expect(screen.getByText('No transcript yet')).toBeTruthy();
    expect(screen.queryByText('Recap generation failed')).toBeNull();

    // Retry → error → generation failure, a different message.
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(2));
    rejectGenerate(1);
    expect(screen.getByText('Recap generation failed')).toBeTruthy();
    expect(screen.queryByText('No transcript yet')).toBeNull();
  });

  it('switching client discards the previous preview, regenerates, and ignores the stale response', async () => {
    renderModal('c-1');
    await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1));
    resolveGenerate(0, brief({ summaryTitle: 'Anduril recap' }));
    expect(screen.getByText('Anduril recap')).toBeTruthy();

    await chooseClient('Overland AI');

    await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(2));
    expect(mocks.generate.mock.calls[1]?.[0]).toEqual({ sessionId: 'session-1', clientId: 'c-2' });
    expect(screen.queryByText('Anduril recap')).toBeNull();
    expect(screen.getByText(/Meri is writing the recap for Overland AI/)).toBeTruthy();

    // A late answer to the FIRST request (Anduril) must not surface as Overland's recap.
    resolveGenerate(0, brief({ summaryTitle: 'Stale Anduril recap' }));
    expect(screen.queryByText('Stale Anduril recap')).toBeNull();
    expect(screen.getByText(/Meri is writing the recap for Overland AI/)).toBeTruthy();

    resolveGenerate(
      1,
      brief({
        summaryTitle: 'Overland recap',
        clientContext: {
          clientId: 'c-2',
          clientName: 'Overland AI',
          status: 'applied',
          relevanceBand: 'MEDIUM',
        },
      }),
    );
    expect(screen.getByText('Overland recap')).toBeTruthy();
    expect(screen.getByText('Overland AI priorities applied · relevance MEDIUM')).toBeTruthy();
  });

  it('files the recap under the model summaryTitle with the rendered Markdown payload', async () => {
    renderModal('c-1');
    await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1));
    resolveGenerate(0, brief({ summaryTitle: 'Concise recap title' }));

    fireEvent.click(screen.getByRole('button', { name: /Save to Client Profile/ }));
    expect(mocks.save).toHaveBeenCalledTimes(1);
    const payload = mocks.save.mock.calls[0]?.[0] as {
      sessionId: string;
      clientId: string;
      title: string;
      markdown: string;
      replaceAttachmentId?: string;
    };
    expect(payload.sessionId).toBe('session-1');
    expect(payload.clientId).toBe('c-1');
    // Concise generated title, not the huge formal one.
    expect(payload.title).toBe('Concise recap title');
    // Save payload is the same rendered content the analyst previewed.
    expect(payload.markdown).toContain('# Concise recap title');
    expect(payload.markdown).toContain('## Executive summary');
    // No existing recap → no replaceAttachmentId.
    expect(payload.replaceAttachmentId).toBeUndefined();
  });
});

describe('SaveRecapModal — explicit update of an existing recap', () => {
  it('gates Save while the current-recap lookup is unresolved, then offers Update with the exact id', async () => {
    // Lookup still in flight.
    mocks.currentRecap = { data: null, isLoading: true, isError: false, refetch: vi.fn() };
    renderModal('c-1');
    await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1));
    resolveGenerate(0, brief({ summaryTitle: 'Fresh recap' }));

    // Save exists (synthesized) but is gated while the lookup is unresolved.
    const gated = screen.getByRole('button', { name: /Save to Client Profile/ });
    expect(gated).toBeDisabled();

    // Lookup resolves: this client already has a recap for THIS session.
    mocks.currentRecap = { data: { id: 'att-current' }, isLoading: false, isError: false, refetch: vi.fn() };
    cleanup();
    renderModal('c-1');
    await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(2));
    resolveGenerate(1, brief({ summaryTitle: 'Fresh recap' }));

    const update = screen.getByRole('button', { name: /Update existing recap/ });
    expect(update).not.toBeDisabled();
    fireEvent.click(update);

    const payload = mocks.save.mock.calls[0]?.[0] as { replaceAttachmentId?: string };
    expect(payload.replaceAttachmentId).toBe('att-current');
  });

  it('keeps Save gated on lookup error, explains why, and offers a retry', async () => {
    const refetch = vi.fn();
    mocks.currentRecap = { data: null, isLoading: false, isError: true, refetch };
    renderModal('c-1');
    await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1));
    resolveGenerate(0, brief({ summaryTitle: 'Fresh recap' }));

    // Save gated, with a visible explanation + retry control (not silent).
    expect(screen.getByRole('button', { name: /Save to Client Profile/ })).toBeDisabled();
    expect(screen.getByText('Could not check for an existing recap')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe('SaveRecapModal — provider-independent notifications (vNext)', () => {
  function resolveSave(nth: number, value: unknown) {
    const options = mocks.save.mock.calls[nth]?.[1] as { onSuccess: (v: unknown) => void };
    act(() => options.onSuccess(value));
  }

  it('closes cleanly on a successful save with NO antd App provider (no message.success crash)', async () => {
    const { onClose } = renderModalNoAntApp();
    await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1));
    resolveGenerate(0, brief({ summaryTitle: 'Fresh recap' }));

    fireEvent.click(screen.getByRole('button', { name: /Save to Client Profile/ }));
    expect(mocks.save).toHaveBeenCalledTimes(1);
    // Save succeeds (not reused) → toast via the native fallback, modal closes.
    resolveSave(0, { reused: false, document: { attachmentId: 'a1', fileName: 'r.docx' } });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('kept-existing (reused) save stays OPEN with an inline warning instead of a success toast', async () => {
    const { onClose } = renderModalNoAntApp();
    await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1));
    resolveGenerate(0, brief({ summaryTitle: 'Fresh recap' }));

    fireEvent.click(screen.getByRole('button', { name: /Save to Client Profile/ }));
    // Server reports it kept the existing document — not a success.
    resolveSave(0, { reused: true, document: { attachmentId: 'a1', fileName: 'r.docx' } });
    expect(screen.getByText(/The existing recap for this session was kept/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
