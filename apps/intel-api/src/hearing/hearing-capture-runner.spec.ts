import { MonotonicTimeline } from './hearing-capture-runner.service.js';

describe('MonotonicTimeline (T10 — reconnect timestamp safety)', () => {
  it('passes timestamps through unchanged on a single socket', () => {
    const t = new MonotonicTimeline();
    t.onOpen();
    expect(t.apply(0, 2000)).toEqual({ startMs: 0, endMs: 2000 });
    expect(t.apply(2000, 5000)).toEqual({ startMs: 2000, endMs: 5000 });
  });

  it('continues past the last segment after a reconnect (no collision)', () => {
    const t = new MonotonicTimeline();
    t.onOpen(); // socket 1
    t.apply(0, 3000);
    const last = t.apply(3000, 7000); // maxEnd now 7000
    expect(last.endMs).toBe(7000);

    // Deepgram reconnects → a fresh socket restarts near 0.
    t.onOpen(); // socket 2: base advances to 7000
    const afterA = t.apply(0, 2500);
    const afterB = t.apply(2500, 4000);
    // Post-reconnect segments are shifted past 7000 — they would otherwise have
    // been (0,2500)/(2500,4000), colliding with socket-1 tuples and being dropped
    // as P2002 replays.
    expect(afterA).toEqual({ startMs: 7000, endMs: 9500 });
    expect(afterB).toEqual({ startMs: 9500, endMs: 11000 });
  });

  it('handles multiple reconnects, staying strictly forward', () => {
    const t = new MonotonicTimeline();
    t.onOpen();
    t.apply(0, 1000);
    t.onOpen(); // base -> 1000
    t.apply(0, 1000); // -> 1000..2000
    t.onOpen(); // base -> 2000
    const seg = t.apply(500, 1500); // -> 2500..3500
    expect(seg).toEqual({ startMs: 2500, endMs: 3500 });
  });
});
