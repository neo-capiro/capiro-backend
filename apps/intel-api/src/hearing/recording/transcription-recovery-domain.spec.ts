import { recoveryWindowWords, uncoveredSegments } from './transcription-recovery-domain.js';
describe('saved audio transcript recovery', () => {
  it('maps timestamps while preserving existing final evidence and separating partial overlaps', () => {
    const words = ['one', 'two', 'three', 'four'].map((word, i) => ({
      word,
      start: i,
      end: i + 0.8,
      speaker: 0,
    }));
    expect(uncoveredSegments(words, 10000, 4000, [{ startMs: 10500, endMs: 11200 }])).toEqual([
      expect.objectContaining({
        startMs: 12000,
        endMs: 13800,
        text: 'three four',
        speakerLabel: 'recovery-0',
      }),
    ]);
  });
  it('does not manufacture speech during a recess', () =>
    expect(uncoveredSegments([], 0, 240000, [])).toEqual([]));
  it('retains a boundary word only when its ending is within actual recorded lookahead', () => {
    // Timing returned by the owned eight-to-twelve-minute provider diagnostic.
    const boundary = { word: 'discussing', start: 239.625, end: 240.665 };
    const words = recoveryWindowWords([boundary, { word: 'next', start: 241, end: 241.5 }], 240000);
    expect(() => uncoveredSegments(words, 480000, 240000, [])).toThrow('timing');
    expect(uncoveredSegments(words, 480000, 242000, [])).toEqual([
      expect.objectContaining({ text: 'discussing', startMs: 719625, endMs: 720665 }),
    ]);
  });
  it('keeps existing finals authoritative throughout the lookahead overlap', () => {
    const words = recoveryWindowWords(
      [{ word: 'discussing', start: 239.625, end: 240.665 }],
      240000,
    );
    expect(uncoveredSegments(words, 480000, 242000, [{ startMs: 720100, endMs: 720800 }])).toEqual(
      [],
    );
    expect(
      uncoveredSegments([{ word: 'discussing', start: 0, end: 0.665 }], 720000, 242000, [
        { startMs: 719625, endMs: 720665 },
      ]),
    ).toEqual([]);
  });
  it('does not promote lookahead-only words, including a truncated lookahead tail', () => {
    expect(
      recoveryWindowWords(
        [
          { word: 'following', start: 240, end: 240.4 },
          { word: 'tail', start: 241.8, end: 243 },
        ],
        240000,
      ),
    ).toEqual([]);
  });
  it('still rejects invalid owned timing and out-of-bounds words at the end of saved audio', () => {
    expect(() =>
      uncoveredSegments(
        recoveryWindowWords([{ word: 'bad', start: NaN, end: 1 }], 1000),
        0,
        1000,
        [],
      ),
    ).toThrow('timing');
    expect(() =>
      uncoveredSegments(
        recoveryWindowWords([{ word: 'tail', start: 0.8, end: 2 }], 1000),
        0,
        1000,
        [],
      ),
    ).toThrow('timing');
  });
  it('rejects provider timing outside the saved media and backwards timestamps', () => {
    expect(() => uncoveredSegments([{ word: 'outside', start: 9, end: 11 }], 0, 1000, [])).toThrow(
      'timing',
    );
    expect(() =>
      uncoveredSegments(
        [
          { word: 'a', start: 2, end: 3 },
          { word: 'b', start: 1, end: 2 },
        ],
        0,
        4000,
        [],
      ),
    ).toThrow('timing');
  });
});
