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
  mocks.get.mockReset().mockImplementation(async (url: string) => ({
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
function mount(initialEvidenceTime?: { ms: number; revision: number }) {
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
  return { ...render(view(initialEvidenceTime)), view };
}
describe('browser retained evidence playback', () => {
  it('waits for recording status before resolving an evidence seek and plays it only once', async () => {
    const original = mocks.get.getMockImplementation()!;
    let resolve!: (value: unknown) => void;
    mocks.get.mockImplementation((url: string) =>
      url.endsWith('/capability')
        ? original(url)
        : new Promise((done) => {
            resolve = done;
          }),
    );
    const { rerender, view } = mount({ ms: 4000, revision: 1 });
    expect(screen.getByRole('status')).toHaveTextContent('Loading recording status');
    expect(screen.queryByText(/no saved audio/i)).not.toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
    await act(async () => resolve(await original('/recording')));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    rerender(view({ ms: 4000, revision: 1 }));
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
  it('explains inaccessible recording status and retries the pending seek after access recovers', async () => {
    const original = mocks.get.getMockImplementation()!;
    mocks.get.mockImplementation((url: string) =>
      url.endsWith('/capability')
        ? original(url)
        : Promise.reject({
            response: { status: 404, data: { code: 'RECORDING_ACCESS_UNAVAILABLE' } },
          }),
    );
    mount({ ms: 4000, revision: 1 });
    expect(await screen.findByRole('alert')).toHaveTextContent('check your active membership');
    expect(screen.queryByText(/No saved audio covers/)).not.toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
    mocks.get.mockImplementation(original);
    fireEvent.click(screen.getByRole('button', { name: 'Retry recording status' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/access is unavailable/)).not.toBeInTheDocument();
  });
  it.each([
    [401, 'Your session has expired'],
    [403, 'Recording access is unavailable'],
    [404, 'Recording access is unavailable'],
    [502, 'its coverage is not yet known'],
  ])('does not infer an audio gap from HTTP %s', async (status, message) => {
    const original = mocks.get.getMockImplementation()!;
    mocks.get.mockImplementation((url: string) =>
      url.endsWith('/capability') ? original(url) : Promise.reject({ response: { status } }),
    );
    mount({ ms: 4000, revision: 1 });
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.queryByText(/No saved audio covers/)).not.toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it.each([
    ['expired', 'Saved audio retention has expired'],
    ['permission_unavailable', 'source permission has expired or changed'],
  ])(
    'shows %s instead of a gap and suppresses stale play controls',
    async (availability, message) => {
      const original = mocks.get.getMockImplementation()!;
      mocks.get.mockImplementation(async (url: string) => {
        const result = await original(url);
        if (!url.endsWith('/capability')) result.data.recording.playbackAvailability = availability;
        return result;
      });
      mount({ ms: 4000, revision: 1 });
      expect(await screen.findByText(new RegExp(message))).toBeInTheDocument();
      expect(screen.queryByText(/No saved audio covers/)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Play saved audio' })).not.toBeInTheDocument();
      expect(mocks.post).not.toHaveBeenCalled();
    },
  );
  it('distinguishes saved audio awaiting preparation from a real coverage gap and retries', async () => {
    const original = mocks.get.getMockImplementation()!;
    mocks.get.mockImplementation(async (url: string) => {
      const result = await original(url);
      if (!url.endsWith('/capability')) {
        result.data.recording.epochs[0].state = 'queued';
        result.data.recording.epochs[0].playable = false;
      }
      return result;
    });
    mount({ ms: 4000, revision: 1 });
    expect(await screen.findByRole('alert')).toHaveTextContent('still being saved or prepared');
    expect(screen.queryByText(/No saved audio covers/)).not.toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
    mocks.get.mockImplementation(original);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh recording status' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
  });
  it('discards an in-flight signed URL when a status refresh withdraws access', async () => {
    const { container } = mount();
    let resolve!: (value: unknown) => void;
    mocks.post.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    fireEvent.click((await screen.findAllByRole('button', { name: 'Play saved audio' }))[0]!);
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    mocks.get.mockRejectedValue({ response: { status: 403 } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh recording status' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Recording access is unavailable');
    await act(async () => resolve({ data: { url: 'https://private.example/late' } }));
    expect(container.querySelector('audio')).toBeNull();
  });
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
