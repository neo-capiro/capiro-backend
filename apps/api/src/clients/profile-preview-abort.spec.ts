import { EventEmitter, getEventListeners } from 'node:events';
import {
  PROFILE_IDENTITY_PREVIEW_TIMEOUT_MS,
  withProfilePreviewAbort,
} from './profile-preview-abort.js';
function request() {
  return Object.assign(new EventEmitter(), {
    aborted: false,
    res: Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false }),
  });
}
describe('bounded profile HTTP cancellation', () => {
  afterEach(() => jest.useRealTimers());
  it('aborts SDK work on response disconnect and removes its listeners', async () => {
    const req = request();
    let signal: AbortSignal | undefined;
    const result = withProfilePreviewAbort(req as never, async (incoming) => {
      signal = incoming;
      return new Promise((resolve) => incoming.addEventListener('abort', () => resolve('stopped')));
    });
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    req.res.emit('close');
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(req.listenerCount('aborted')).toBe(0);
    expect(req.res.listenerCount('close')).toBe(0);
  });
  it('enforces the aggregate deadline even when a source ignores cancellation', async () => {
    jest.useFakeTimers();
    const req = request();
    let signal!: AbortSignal;
    let finish!: (value: string) => void;
    const pending = withProfilePreviewAbort(
      req as never,
      async (incoming) => {
        signal = incoming;
        return new Promise<string>((resolve) => {
          finish = resolve;
        });
      },
      PROFILE_IDENTITY_PREVIEW_TIMEOUT_MS,
    );
    const rejected = expect(pending).rejects.toMatchObject({ status: 504 });
    await jest.advanceTimersByTimeAsync(PROFILE_IDENTITY_PREVIEW_TIMEOUT_MS - 1);
    expect(signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await rejected;
    expect(signal.aborted).toBe(true);
    expect(req.listenerCount('aborted')).toBe(0);
    expect(req.res.listenerCount('close')).toBe(0);
    expect(req.res.listenerCount('error')).toBe(0);
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    expect(jest.getTimerCount()).toBe(0);
    finish('late source response');
    await Promise.resolve();
  });
  it('allows a successful identity preview past 30s and clears its deadline', async () => {
    jest.useFakeTimers();
    const req = request();
    let signal!: AbortSignal;
    let finish!: (value: string) => void;
    const pending = withProfilePreviewAbort(
      req as never,
      async (incoming) => {
        signal = incoming;
        return new Promise<string>((resolve) => {
          finish = resolve;
        });
      },
      PROFILE_IDENTITY_PREVIEW_TIMEOUT_MS,
    );
    await jest.advanceTimersByTimeAsync(45_000);
    expect(signal.aborted).toBe(false);
    finish('verified candidates');
    await expect(pending).resolves.toBe('verified candidates');
    expect(jest.getTimerCount()).toBe(0);
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    expect(req.res.listenerCount('close')).toBe(0);
  });
  it('does not start work for an already disconnected caller', async () => {
    const req = request();
    req.aborted = true;
    const work = jest.fn();
    await expect(
      withProfilePreviewAbort(req as never, work, PROFILE_IDENTITY_PREVIEW_TIMEOUT_MS),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(work).not.toHaveBeenCalled();
    expect(req.res.listenerCount('close')).toBe(0);
  });
  it('does not abort a normally completed response', async () => {
    const req = request();
    expect(
      await withProfilePreviewAbort(req as never, async (signal) => {
        req.res.writableEnded = true;
        req.res.emit('close');
        return signal.aborted;
      }),
    ).toBe(false);
    expect(req.res.listenerCount('error')).toBe(0);
  });
});
