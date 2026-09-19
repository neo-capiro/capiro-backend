import type { FinalSegment } from './hearing.types.js';

/**
 * Pure word-level speaker normalization for finalized Deepgram live frames.
 *
 * A final provider frame is NOT guaranteed to be one speaker turn: with
 * diarization enabled, `channel.alternatives[0].words[]` carries the per-word
 * `speaker`, `start`/`end` (seconds, connection-local) and the punctuated
 * surface form. Taking `words[0].speaker` for the whole frame misattributes
 * every later speaker change, so a mixed frame is split here into contiguous
 * same-speaker runs. Splitting is lossless-only: if any word, timing or text
 * invariant fails, the complete original frame is kept as a single segment
 * with an unknown speaker (never a guessed label) unless EVERY word carries
 * the same one valid label.
 *
 * Adapters add their own timeline base afterwards (server: connectionBaseMs,
 * exactly once; browser: none — the gateway applies its persisted offset).
 * Word order is the provider's actual order; words are never re-sorted and
 * timestamps are never fabricated or widened beyond their real values.
 */

export interface DeepgramWord {
  word?: string;
  punctuated_word?: string;
  start?: number;
  end?: number;
  speaker?: number;
}

export interface DeepgramAlternative {
  transcript?: string;
  confidence?: number;
  words?: DeepgramWord[];
}

function isValidSpeaker(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isFiniteOrderedTiming(word: DeepgramWord): boolean {
  return (
    typeof word.start === 'number' &&
    Number.isFinite(word.start) &&
    typeof word.end === 'number' &&
    Number.isFinite(word.end) &&
    word.start >= 0 &&
    word.end >= word.start
  );
}

/** Every word's preferred surface form (punctuated first), or null when any word lacks usable text. */
function wordTexts(words: DeepgramWord[]): string[] | null {
  const texts: string[] = [];
  for (const word of words) {
    const raw = word.punctuated_word ?? word.word;
    if (typeof raw !== 'string' || raw.length === 0) return null;
    texts.push(raw);
  }
  return texts;
}

/** True when joining the word surface forms reproduces the raw transcript exactly. */
function reconstructionMatches(transcript: string, texts: string[]): boolean {
  return texts.join(' ') === transcript;
}

/**
 * The one label shared by EVERY word, or undefined. A single missing/invalid
 * speaker anywhere means the frame is not truthfully homogeneous — partial
 * evidence must not be generalized into a whole-frame label.
 */
function strictlyHomogeneousLabel(words: DeepgramWord[]): string | undefined {
  if (words.length === 0 || !isValidSpeaker(words[0]!.speaker)) return undefined;
  const label = words[0]!.speaker!;
  for (const word of words) {
    if (!isValidSpeaker(word.speaker) || word.speaker !== label) return undefined;
  }
  return String(label);
}

/**
 * True when provider word timing is globally usable for splitting: each word
 * is finite and ordered, and successive words never move backwards (no
 * out-of-order or nested intervals). Without this, a run's [first.start,
 * last.end] range can shrink coverage or mis-order the emitted segments, so
 * the frame must stay whole.
 */
function isGloballyOrderedTiming(words: DeepgramWord[]): boolean {
  let previousStart = -1;
  let previousEnd = -1;
  for (const word of words) {
    if (!isFiniteOrderedTiming(word)) return false;
    if (word.start! < previousStart || word.start! < previousEnd) return false;
    previousStart = word.start!;
    previousEnd = word.end!;
  }
  return true;
}

/**
 * Normalize one finalized provider alternative into one or more ordered
 * segments. Ranges are connection-local milliseconds derived from actual word
 * `start`/`end`; `frameFallbackMs` (the provider frame's own start/duration)
 * is used only when the frame cannot be split and must be kept whole.
 */
export function finalizeDeepgramAlternative(
  alternative: DeepgramAlternative | undefined,
  frameFallbackMs: { startMs: number; endMs: number },
): FinalSegment[] {
  const transcript = alternative?.transcript;
  if (typeof transcript !== 'string' || transcript.length === 0) return [];
  const confidence = alternative?.confidence;
  const startMs = Math.max(0, Math.round(frameFallbackMs.startMs));
  const endMs = Math.max(startMs, Math.round(frameFallbackMs.endMs));
  const wholeFrame: FinalSegment = { startMs, endMs, text: transcript, confidence };

  const words = alternative?.words;
  if (!Array.isArray(words) || words.length === 0) {
    // No word evidence at all: keep the raw frame, never invent a speaker.
    return [wholeFrame];
  }

  // Whole-frame speaker attribution is truthful only when EVERY word carries
  // the same one valid label; otherwise the kept frame stays unknown.
  const homogeneousLabel = strictlyHomogeneousLabel(words);

  // Lossless split requires complete word text, exact same-source
  // reconstruction of the raw transcript, and globally ordered finite timing
  // (per-word validity plus no cross-word/cross-run shrink or reorder). Any
  // failure keeps the complete original frame.
  const texts = wordTexts(words);
  if (
    texts === null ||
    !isGloballyOrderedTiming(words) ||
    !reconstructionMatches(transcript, texts)
  ) {
    return [{ ...wholeFrame, speakerLabel: homogeneousLabel }];
  }

  // Contiguous same-speaker runs in actual provider order. Speaker 0 is
  // valid; absent/invalid speaker is an explicit unknown run; non-adjacent
  // runs sharing a label are never merged.
  interface Run {
    label?: string;
    startSec: number;
    endSec: number;
    texts: string[];
  }
  const runs: Run[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    const label = isValidSpeaker(word.speaker) ? String(word.speaker) : undefined;
    const last = runs[runs.length - 1];
    if (last && last.label === label) {
      last.endSec = word.end!;
      last.texts.push(texts[i]!);
    } else {
      runs.push({ label, startSec: word.start!, endSec: word.end!, texts: [texts[i]!] });
    }
  }

  if (runs.length === 1) {
    // Ordinary single-speaker frame: preserve the raw transcript path with
    // the established frame range and the one truthful label.
    return [{ ...wholeFrame, speakerLabel: runs[0]!.label }];
  }

  // Every split range must be ordered and round to a distinct (startMs,endMs)
  // pair; a collision would make the persistence dedup key
  // (capture_id,start_ms,end_ms) silently drop later words on replay, so keep
  // the whole frame. Ranges derive only from real first/last word times.
  const rounded = runs.map((run) => ({
    start: Math.round(run.startSec * 1_000),
    end: Math.max(Math.round(run.startSec * 1_000), Math.round(run.endSec * 1_000)),
  }));
  const seen = new Set<string>();
  let previousStart = -1;
  for (const range of rounded) {
    const key = `${range.start}:${range.end}`;
    if (range.start < previousStart || seen.has(key)) {
      return [{ ...wholeFrame, speakerLabel: homogeneousLabel }];
    }
    seen.add(key);
    previousStart = range.start;
  }

  return runs.map((run, index) => ({
    startMs: rounded[index]!.start,
    endMs: rounded[index]!.end,
    text: run.texts.join(' '),
    speakerLabel: run.label,
    confidence,
  }));
}

/**
 * Interim frames keep single-frame delivery (UI replacement semantics), but a
 * mixed/unknown word set must not be represented as the first word's speaker.
 * Only a strictly homogeneous word set yields a label.
 */
export function interimSpeakerLabel(alternative: DeepgramAlternative | undefined): string | undefined {
  const words = alternative?.words;
  if (!Array.isArray(words) || words.length === 0) return undefined;
  return strictlyHomogeneousLabel(words);
}
