import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), scope: 'tenant:owner' }));
vi.mock('../../lib/use-api.js', () => ({ useApi: () => mocks }));
vi.mock('../../lib/use-api-scope.js', () => ({ useApiScope: () => mocks.scope }));
import { PublicHearingAudioPanel } from './PublicHearingAudioPanel.js';
const epoch = (id: string, startMs: number, durableEndMs: number) => ({
  id,
  startMs,
  durableEndMs,
  durableBytes: 320044,
  state: 'ready',
  transcriptState: 'partial',
  expiresAt: '2099-01-01',
  reason: null,
});
const part = (positionMs: number) => ({
  partId: 'part-' + Math.floor(positionMs / 5000),
  startMs: Math.floor(positionMs / 5000) * 5000,
  endMs: (Math.floor(positionMs / 5000) + 1) * 5000,
  url: 'https://private.example/part-' + Math.floor(positionMs / 5000),
  expiresAt: '2099-01-01',
});
beforeEach(() => {
  mocks.scope = 'tenant:owner';
  mocks.get
    .mockReset()
    .mockResolvedValue({
      data: { epochs: [epoch('first', 0, 10000), epoch('second', 20000, 30000)] },
    });
  mocks.post
    .mockReset()
    .mockImplementation(async (_url: string, body: { positionMs: number }) => ({
      data: part(body.positionMs),
    }));
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    this.dispatchEvent(new Event('pause'));
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = (id: string) => (
    <QueryClientProvider client={client}>
      <PublicHearingAudioPanel hearingId={id} />
    </QueryClientProvider>
  );
  return { ...render(view('hearing-a')), view };
}
describe('canonical server private playback', () => {
  it('preserves playback speed and resumes the next contiguous part after a programmatic pause', async () => {
    const { container } = mount();
    fireEvent.click(await screen.findByRole('button', { name: '0:00:00–0:00:10' }));
    const audio = container.querySelector('audio')!;
    await waitFor(() => expect(audio.src).toContain('part-0'));
    fireEvent.change(screen.getByLabelText('Server audio playback speed'), {
      target: { value: '1.5' },
    });
    fireEvent.loadedMetadata(audio);
    expect(audio.playbackRate).toBe(1.5);
    expect(audio.play).toHaveBeenCalledTimes(1);
    fireEvent.ended(audio);
    await waitFor(() => expect(audio.src).toContain('part-1'));
    fireEvent.loadedMetadata(audio);
    expect(audio.playbackRate).toBe(1.5);
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(mocks.post).toHaveBeenLastCalledWith(
      '/intel-api/public-hearings/hearing-a/audio/epochs/first/playback',
      { positionMs: 5000 },
    );
  });
  it('posts an integer positionMs after a fractional currentTime time update', async () => {
    const { container } = mount();
    fireEvent.click(await screen.findByRole('button', { name: '0:00:00–0:00:10' }));
    const audio = container.querySelector('audio')!;
    await waitFor(() => expect(audio.src).toContain('part-0'));
    // A real HTMLMediaElement reports currentTime in fractional seconds
    // (e.g. 344.336s). A naive `* 1000` produces 344.33599999999996 ms, which
    // the backend rejects (400 "Valid audio position required").
    fireEvent.timeUpdate(audio, { target: { currentTime: 0.344336 } });
    fireEvent.click(screen.getByRole('button', { name: 'Play from position' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    const body = mocks.post.mock.calls.at(-1)?.[1] as { positionMs: number };
    expect(Number.isSafeInteger(body.positionMs)).toBe(true);
    expect(body.positionMs).toBe(344);
  });
  it('stops at a coverage gap and does not request or play another interval automatically', async () => {
    const { container } = mount();
    await screen.findByLabelText('Seek saved server audio');
    const slider = screen.getByLabelText('Seek saved server audio');
    fireEvent.change(slider, { target: { value: '9000' } });
    fireEvent.keyUp(slider, { key: 'ArrowRight' });
    const audio = container.querySelector('audio')!;
    await waitFor(() => expect(audio.src).toContain('part-1'));
    fireEvent.ended(audio);
    await screen.findByText(/No saved audio covers this position/);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(audio.getAttribute('src')).toBeNull();
  });
  it('discards a late signed URL after switching tenant scope', async () => {
    let resolveOld!: (value: unknown) => void;
    mocks.post.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const { container, rerender, view } = mount();
    fireEvent.click(await screen.findByRole('button', { name: '0:00:00–0:00:10' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    mocks.scope = 'another-tenant:owner';
    rerender(view('hearing-a'));
    await screen.findByRole('button', { name: '0:00:00–0:00:10' });
    await act(async () => resolveOld({ data: part(0) }));
    expect(container.querySelector('audio')?.getAttribute('src')).toBeNull();
  });
  it('refreshes an expired URL once and exposes playback failure without a retry loop', async () => {
    const { container } = mount();
    fireEvent.click(await screen.findByRole('button', { name: '0:00:00–0:00:10' }));
    const audio = container.querySelector('audio')!;
    await waitFor(() => expect(audio.src).toContain('part-0'));
    fireEvent.error(audio);
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
    fireEvent.error(audio);
    await screen.findByText(/could not play after refreshing access/);
    expect(mocks.post).toHaveBeenCalledTimes(2);
  });
});

it('publishes only playable retained coverage and clears it when the player unmounts', async () => {
  const onCoverage = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  mocks.get.mockResolvedValue({ data: { epochs: [epoch('good', 0, 10000), { ...epoch('expired', 20000, 30000), expiresAt: '2020-01-01' }] } });
  const { unmount } = render(<QueryClientProvider client={client}><PublicHearingAudioPanel hearingId="coverage" onCoverage={onCoverage} /></QueryClientProvider>);
  await waitFor(() => expect(onCoverage).toHaveBeenLastCalledWith([{ startMs: 0, endMs: 10000 }]));
  unmount();
  expect(onCoverage).toHaveBeenLastCalledWith([]);
});
