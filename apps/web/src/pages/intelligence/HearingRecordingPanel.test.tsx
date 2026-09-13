import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), scope: 'tenant:owner' }));
vi.mock('../../lib/use-api.js', () => ({ useApi: () => mocks }));
vi.mock('../../lib/use-api-scope.js', () => ({ useApiScope: () => mocks.scope }));
import { HearingRecordingPanel } from './HearingRecordingPanel.js';
const epoch = (id: string, startMs: number, end: number) => ({
  id,
  startMs,
  durableEndMs: end,
  durableSequence: 19,
  durableBytes: 50000,
  state: 'ready',
  complete: true,
  reason: null,
  decodedDurationMs: end - startMs,
  playable: true,
});
beforeEach(() => {
  mocks.scope = 'tenant:owner';
  mocks.get
    .mockReset()
    .mockImplementation(async (url: string) => ({
      data: url.endsWith('/capability')
        ? { available: true, retentionDays: 30 }
        : {
            recordingPolicy: 'audio_and_transcript',
            recording: {
              id: 'recording',
              state: 'partial',
              expiresAt: '2099-01-01',
              transcriptState: 'partial',
              analysisState: 'ready',
              epochs: [epoch('one', 0, 10000), epoch('two', 20000, 30000)],
            },
          },
    }));
  mocks.post.mockReset().mockResolvedValue({ data: { url: 'https://private.example/audio' } });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = (evidenceTime?: { ms: number; revision: number }) => (
    <QueryClientProvider client={client}>
      <HearingRecordingPanel
        sessionId="session"
        live={false}
        canEnable={false}
        evidenceTime={evidenceTime}
      />
    </QueryClientProvider>
  );
  return { ...render(view()), view };
}
describe('browser retained evidence playback', () => {
  it('seeks within an already issued URL and preserves the selected speed after URL refresh', async () => {
    const { container, rerender, view } = mount();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Play saved audio' }))[0]!);
    await waitFor(() => expect(container.querySelector('audio')).not.toBeNull());
    const audio = container.querySelector('audio')!;
    fireEvent.loadedMetadata(audio);
    fireEvent.change(screen.getByLabelText('Playback speed'), { target: { value: '1.5' } });
    rerender(view({ ms: 4000, revision: 1 }));
    await waitFor(() => expect(audio.currentTime).toBe(4));
    expect(audio.playbackRate).toBe(1.5);
    mocks.post.mockResolvedValueOnce({ data: { url: 'https://private.example/refreshed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh playback' }));
    await waitFor(() => expect(audio.src).toContain('refreshed'));
    fireEvent.loadedMetadata(audio);
    expect(audio.currentTime).toBe(4);
    expect(audio.playbackRate).toBe(1.5);
  });
  it('stops previous audio and discards a pending URL when the requested evidence is in a gap', async () => {
    const { container, rerender, view } = mount();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Play saved audio' }))[0]!);
    await waitFor(() => expect(container.querySelector('audio')).not.toBeNull());
    let resolve!: (v: unknown) => void;
    mocks.post.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    rerender(view({ ms: 21000, revision: 1 }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    rerender(view({ ms: 15000, revision: 2 }));
    expect(screen.getByText(/No saved audio covers this moment/)).toBeInTheDocument();
    await act(async () => resolve({ data: { url: 'https://private.example/late' } }));
    expect(container.querySelector('audio')).toBeNull();
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  });
  it('drops signed playback when tenant scope changes', async () => {
    const { container, rerender, view } = mount();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Play saved audio' }))[0]!);
    await waitFor(() => expect(container.querySelector('audio')).not.toBeNull());
    mocks.scope = 'another-tenant:owner';
    rerender(view());
    expect(container.querySelector('audio')).toBeNull();
  });
});
