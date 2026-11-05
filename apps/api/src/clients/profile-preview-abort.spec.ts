import { EventEmitter } from 'node:events';
import { withProfilePreviewAbort } from './profile-preview-abort.js';
function request() {
  return Object.assign(new EventEmitter(), {
    aborted: false,
    res: Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false }),
  });
}
describe('bounded profile HTTP cancellation', () => {
  it('aborts SDK work on response disconnect and removes its listeners', async () => {
    const req = request();
    let signal: AbortSignal | undefined;
    const result = withProfilePreviewAbort(req as never, async (incoming) => {
      signal = incoming;
      return new Promise((resolve) => incoming.addEventListener('abort', () => resolve('stopped')));
    });
    req.res.emit('close');
    expect(await result).toBe('stopped');
    expect(signal?.aborted).toBe(true);
    expect(req.listenerCount('aborted')).toBe(0);
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
