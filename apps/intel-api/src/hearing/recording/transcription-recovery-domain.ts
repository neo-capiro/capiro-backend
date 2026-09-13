import type { FinalSegment } from '../hearing.types.js';

export interface RecoveryWord {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  confidence?: number;
  speaker?: number;
}
/** Keep persisted finals authoritative. Only uncovered, timed words become new
 * evidence; retries cannot rewrite existing text or duplicate overlapping speech. */
export function uncoveredSegments(
  words: RecoveryWord[],
  offsetMs: number,
  durationMs: number,
  covered: Array<{ startMs: number; endMs: number }>,
): FinalSegment[] {
  if (words.length > 10000) throw Error('Recovery transcript exceeds bounded word count');
  const results: FinalSegment[] = [];
  let group: RecoveryWord[] = [];
  const flush = () => {
    if (!group.length) return;
    results.push({
      startMs: offsetMs + Math.round(group[0]!.start * 1000),
      endMs: offsetMs + Math.round(group.at(-1)!.end * 1000),
      text: group.map((w) => w.punctuated_word ?? w.word).join(' '),
      speakerLabel: group[0]!.speaker === undefined ? undefined : 'recovery-' + group[0]!.speaker,
      confidence: group.reduce((sum, w) => sum + (w.confidence ?? 0), 0) / group.length,
    });
    group = [];
  };
  let previous = -1;
  for (const word of words) {
    const start = offsetMs + Math.round(word.start * 1000),
      end = offsetMs + Math.round(word.end * 1000);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      word.start < 0 ||
      end <= start ||
      end > offsetMs + durationMs + 500 ||
      start < previous ||
      typeof word.word !== 'string' ||
      word.word.length > 1000 ||
      (word.punctuated_word !== undefined &&
        (typeof word.punctuated_word !== 'string' || word.punctuated_word.length > 1000))
    )
      throw Error('recovery_word_timing_invalid');
    previous = start;
    if (covered.some((range) => start < range.endMs && end > range.startMs)) {
      flush();
      continue;
    }
    if (
      group.length &&
      (word.start - group.at(-1)!.end > 1 ||
        word.speaker !== group[0]!.speaker ||
        group.length >= 60)
    )
      flush();
    group.push(word);
  }
  flush();
  return results;
}
