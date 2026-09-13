import { uncoveredSegments } from './transcription-recovery-domain.js';
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
