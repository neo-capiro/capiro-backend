import {
  finalizeDeepgramAlternative,
  interimSpeakerLabel,
  type DeepgramAlternative,
} from './deepgram-word-segments.js';

/**
 * SYNTHETIC CONTRACT TESTS. These frames are hand-built edge shapes that pin
 * the normalization contract; they are NOT retained provider receipts. Root
 * qualifies actual new transcription separately.
 */

function alt(partial: DeepgramAlternative): DeepgramAlternative {
  return partial;
}

const FRAME = { startMs: 0, endMs: 3_500 };

describe('finalizeDeepgramAlternative (synthetic contract shapes)', () => {
  it('splits a 0->1->0 mixed final into three ordered runs with every punctuated word once', () => {
    const segments = finalizeDeepgramAlternative(
      alt({
        transcript: 'Hello there. Yes indeed. Back to me.',
        confidence: 0.92,
        words: [
          { word: 'Hello', punctuated_word: 'Hello', start: 0, end: 0.5, speaker: 0 },
          { word: 'there', punctuated_word: 'there.', start: 0.5, end: 1.0, speaker: 0 },
          { word: 'Yes', punctuated_word: 'Yes', start: 1.2, end: 1.6, speaker: 1 },
          { word: 'indeed', punctuated_word: 'indeed.', start: 1.6, end: 2.0, speaker: 1 },
          { word: 'Back', punctuated_word: 'Back', start: 2.4, end: 2.8, speaker: 0 },
          { word: 'to', punctuated_word: 'to', start: 2.8, end: 3.0, speaker: 0 },
          { word: 'me', punctuated_word: 'me.', start: 3.0, end: 3.5, speaker: 0 },
        ],
      }),
      FRAME,
    );

    expect(segments).toEqual([
      { startMs: 0, endMs: 1_000, text: 'Hello there.', speakerLabel: '0', confidence: 0.92 },
      { startMs: 1_200, endMs: 2_000, text: 'Yes indeed.', speakerLabel: '1', confidence: 0.92 },
      {
        startMs: 2_400,
        endMs: 3_500,
        text: 'Back to me.',
        speakerLabel: '0',
        confidence: 0.92,
      },
    ]);
  });

  it('treats speaker 0 as a valid label and never merges non-adjacent runs', () => {
    const segments = finalizeDeepgramAlternative(
      alt({
        transcript: 'A b C d',
        words: [
          { word: 'A', start: 0, end: 0.5, speaker: 0 },
          { word: 'b', start: 0.5, end: 1.0, speaker: 1 },
          { word: 'C', start: 1.0, end: 1.5, speaker: 0 },
          { word: 'd', start: 1.5, end: 2.0, speaker: 1 },
        ],
      }),
      FRAME,
    );

    expect(segments.map((s) => [s.speakerLabel, s.text])).toEqual([
      ['0', 'A'],
      ['1', 'b'],
      ['0', 'C'],
      ['1', 'd'],
    ]);
  });

  it('keeps an unknown word as its own explicit unknown run between known runs', () => {
    const segments = finalizeDeepgramAlternative(
      alt({
        transcript: 'sure thing maybe so',
        words: [
          { word: 'sure', start: 0, end: 0.5, speaker: 2 },
          { word: 'thing', start: 0.5, end: 1.0, speaker: 2 },
          { word: 'maybe', start: 1.0, end: 1.5 },
          { word: 'so', start: 1.5, end: 2.0, speaker: 2 },
        ],
      }),
      FRAME,
    );

    expect(segments.map((s) => [s.speakerLabel, s.text])).toEqual([
      ['2', 'sure thing'],
      [undefined, 'maybe'],
      ['2', 'so'],
    ]);
  });

  it('keeps the raw transcript path for an ordinary homogeneous frame', () => {
    const segments = finalizeDeepgramAlternative(
      alt({
        transcript: 'The hearing will resume.',
        confidence: 0.8,
        words: [
          { word: 'The', punctuated_word: 'The', start: 0.1, end: 0.4, speaker: 1 },
          { word: 'hearing', punctuated_word: 'hearing', start: 0.4, end: 0.9, speaker: 1 },
          { word: 'will', punctuated_word: 'will', start: 0.9, end: 1.2, speaker: 1 },
          { word: 'resume', punctuated_word: 'resume.', start: 1.2, end: 2.0, speaker: 1 },
        ],
      }),
      { startMs: 100, endMs: 2_000 },
    );

    expect(segments).toEqual([
      {
        startMs: 100,
        endMs: 2_000,
        text: 'The hearing will resume.',
        speakerLabel: '1',
        confidence: 0.8,
      },
    ]);
  });

  it('keeps the whole frame with unknown speaker when words are absent', () => {
    const segments = finalizeDeepgramAlternative(
      alt({ transcript: 'no word array', confidence: 0.7 }),
      { startMs: 10, endMs: 900 },
    );
    expect(segments).toEqual([
      { startMs: 10, endMs: 900, text: 'no word array', speakerLabel: undefined, confidence: 0.7 },
    ]);
  });

  it('keeps the whole frame with unknown speaker when a word lacks usable text', () => {
    const segments = finalizeDeepgramAlternative(
      alt({
        transcript: 'real text',
        words: [
          { word: 'real', start: 0, end: 0.5, speaker: 0 },
          { word: '', punctuated_word: '', start: 0.5, end: 1.0 },
        ],
      }),
      FRAME,
    );
    // Text is not losslessly recoverable and no label covers EVERY word, so
    // the complete frame stays whole and truthfully unknown.
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ text: 'real text', speakerLabel: undefined, startMs: 0 });
  });

  it('does not falsely homogenize [0, undefined] or [undefined, 0] whole-frame fallbacks', () => {
    for (const speakers of [[0, undefined], [undefined, 0]] as const) {
      const segments = finalizeDeepgramAlternative(
        alt({
          transcript: 'first second',
          words: [
            { word: 'first', speaker: speakers[0] },
            { word: 'second', speaker: speakers[1] },
          ],
        }),
        FRAME,
      );
      // Missing timing forces the whole-frame fallback; partial speaker
      // evidence must NOT be generalized into a label.
      expect(segments).toHaveLength(1);
      expect(segments[0]).toMatchObject({ text: 'first second', speakerLabel: undefined });
    }
  });

  it('treats a non-integer/negative speaker as unknown and never as 0', () => {
    for (const bad of [-1, 0.5, Number.NaN] as const) {
      const segments = finalizeDeepgramAlternative(
        alt({
          transcript: 'word one word two',
          words: [
            { word: 'word', punctuated_word: 'word', start: 0, end: 0.5, speaker: 0 },
            { word: 'one', punctuated_word: 'one', start: 0.5, end: 1.0, speaker: bad as number },
            { word: 'word', punctuated_word: 'word', start: 1.0, end: 1.5, speaker: 0 },
            { word: 'two', punctuated_word: 'two', start: 1.5, end: 2.0, speaker: 0 },
          ],
        }),
        FRAME,
      );
      expect(segments.map((s) => [s.speakerLabel, s.text])).toEqual([
        ['0', 'word'],
        [undefined, 'one'],
        ['0', 'word two'],
      ]);
      expect(
        interimSpeakerLabel(alt({ words: [{ speaker: 0 }, { speaker: bad as number }] })),
      ).toBeUndefined();
    }
  });

  it('keeps the whole frame when word times are out of order or nested (coverage would shrink)', () => {
    const outOfOrder = finalizeDeepgramAlternative(
      alt({
        transcript: 'alpha beta gamma',
        words: [
          { word: 'alpha', start: 0, end: 2.0, speaker: 0 },
          { word: 'beta', start: 0.5, end: 1.0, speaker: 1 }, // nested inside alpha
          { word: 'gamma', start: 2.0, end: 2.5, speaker: 1 },
        ],
      }),
      { startMs: 0, endMs: 2_500 },
    );
    expect(outOfOrder).toHaveLength(1);
    expect(outOfOrder[0]).toMatchObject({
      text: 'alpha beta gamma',
      speakerLabel: undefined,
      startMs: 0,
      endMs: 2_500,
    });

    const regressive = finalizeDeepgramAlternative(
      alt({
        transcript: 'alpha beta gamma',
        words: [
          { word: 'alpha', start: 1.0, end: 1.5, speaker: 0 },
          { word: 'beta', start: 0.2, end: 0.7, speaker: 1 }, // starts before alpha
          { word: 'gamma', start: 1.5, end: 2.0, speaker: 1 },
        ],
      }),
      { startMs: 0, endMs: 2_000 },
    );
    expect(regressive).toHaveLength(1);
    expect(regressive[0]).toMatchObject({ text: 'alpha beta gamma', speakerLabel: undefined });
  });

  it('keeps the whole frame when word timing is missing, without a falsely homogeneous label', () => {
    const segments = finalizeDeepgramAlternative(
      alt({
        transcript: 'mixed timing gap',
        words: [
          { word: 'mixed', start: 0, end: 0.5, speaker: 0 },
          { word: 'timing', speaker: 1 },
          { word: 'gap', start: 1.0, end: 1.5, speaker: 0 },
        ],
      }),
      { startMs: 5, endMs: 1_500 },
    );
    expect(segments).toEqual([
      {
        startMs: 5,
        endMs: 1_500,
        text: 'mixed timing gap',
        speakerLabel: undefined,
        confidence: undefined,
      },
    ]);
  });

  it('keeps the whole frame when word reconstruction would change the raw transcript', () => {
    // punctuated_word reconstruction cannot reproduce the raw transcript
    // (smart_format style mismatch), so nothing may be dropped or reattributed.
    const segments = finalizeDeepgramAlternative(
      alt({
        transcript: 'it is 100 percent done',
        words: [
          { word: 'it', punctuated_word: 'It', start: 0, end: 0.5, speaker: 0 },
          { word: 'is', punctuated_word: 'is', start: 0.5, end: 1.0, speaker: 0 },
          { word: 'one', punctuated_word: '100', start: 1.0, end: 1.5, speaker: 1 },
          { word: 'hundred', punctuated_word: 'percent', start: 1.5, end: 2.0, speaker: 1 },
          { word: 'done', punctuated_word: 'done', start: 2.0, end: 2.5, speaker: 1 },
        ],
      }),
      { startMs: 0, endMs: 2_500 },
    );
    expect(segments).toEqual([
      {
        startMs: 0,
        endMs: 2_500,
        text: 'it is 100 percent done',
        speakerLabel: undefined,
        confidence: undefined,
      },
    ]);
  });

  it('keeps the whole frame when rounded split ranges would collide under dedup', () => {
    const segments = finalizeDeepgramAlternative(
      alt({
        transcript: 'hi hi again',
        words: [
          { word: 'hi', start: 0.0001, end: 0.0004, speaker: 0 },
          { word: 'hi', start: 0.0002, end: 0.0004, speaker: 1 },
          { word: 'again', start: 2.0, end: 2.5, speaker: 0 },
        ],
      }),
      { startMs: 0, endMs: 2_500 },
    );
    // Runs 1 and 2 both round to (0,0): persisting both would lose words to
    // the (capture_id,start_ms,end_ms) dedup key, so the frame stays whole.
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ text: 'hi hi again', speakerLabel: undefined });
  });

  it('produces identical ranges for an identical replayed final (deterministic replay)', () => {
    const frame = alt({
      transcript: 'one two three four',
      confidence: 0.5,
      words: [
        { word: 'one', start: 10.0, end: 10.4, speaker: 0 },
        { word: 'two', start: 10.4, end: 10.8, speaker: 0 },
        { word: 'three', start: 11.0, end: 11.5, speaker: 1 },
        { word: 'four', start: 11.5, end: 12.0, speaker: 1 },
      ],
    });
    const first = finalizeDeepgramAlternative(frame, { startMs: 10_000, endMs: 12_000 });
    const second = finalizeDeepgramAlternative(frame, { startMs: 10_000, endMs: 12_000 });
    expect(second).toEqual(first);
    expect(first.map((s) => [s.startMs, s.endMs, s.speakerLabel])).toEqual([
      [10_000, 10_800, '0'],
      [11_000, 12_000, '1'],
    ]);
  });
});

describe('interimSpeakerLabel (synthetic contract shapes)', () => {
  it('keeps a single-speaker interim label but never a mixed first-word label', () => {
    expect(
      interimSpeakerLabel(
        alt({ words: [{ speaker: 3 }, { speaker: 3 }] }),
      ),
    ).toBe('3');
    expect(
      interimSpeakerLabel(
        alt({ words: [{ speaker: 3 }, { speaker: 1 }] }),
      ),
    ).toBeUndefined();
    expect(interimSpeakerLabel(alt({ words: [{ speaker: 0 }] }))).toBe('0');
    expect(interimSpeakerLabel(alt({}))).toBeUndefined();
    expect(interimSpeakerLabel(undefined)).toBeUndefined();
  });
});
