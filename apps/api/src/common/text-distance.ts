/**
 * Edit-distance instrumentation primitives (G3, blueprint §12.6 "draft
 * usefulness: first-draft acceptance, edit distance").
 *
 * Pure + dependency-free. A word-level Levenshtein (not char-level) because
 * the signal we want is "how much did a human rework the draft", and word
 * operations approximate human edits far better than characters on
 * multi-hundred-word bodies — while keeping the DP table small enough to run
 * inline at send time. Inputs are normalized (HTML stripped, whitespace
 * collapsed, lowercased) so formatting-only churn doesn't read as editing.
 */

/** Strip tags + collapse whitespace + lowercase → comparable word stream. */
export function normalizeForDistance(text: string): string[] {
  return String(text ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/** Word-level Levenshtein distance between two texts. Bounded: inputs are
 *  truncated to the first 4000 words each (an email/draft is far smaller; the
 *  bound keeps worst-case work at ~16M cells). */
export function wordEditDistance(a: string, b: string): number {
  const wa = normalizeForDistance(a).slice(0, 4000);
  const wb = normalizeForDistance(b).slice(0, 4000);
  if (wa.length === 0) return wb.length;
  if (wb.length === 0) return wa.length;

  let prev = new Array<number>(wb.length + 1);
  let curr = new Array<number>(wb.length + 1);
  for (let j = 0; j <= wb.length; j++) prev[j] = j;
  for (let i = 1; i <= wa.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= wb.length; j++) {
      const cost = wa[i - 1] === wb[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[wb.length]!;
}

/**
 * The flywheel metric: 0 = sent verbatim, 1 = fully rewritten. Distance
 * normalized by the larger word count, so insertions and rewrites both
 * register proportionally.
 */
export function editRatio(generated: string, final: string): number {
  const genLen = normalizeForDistance(generated).slice(0, 4000).length;
  const finLen = normalizeForDistance(final).slice(0, 4000).length;
  const denom = Math.max(genLen, finLen);
  if (denom === 0) return 0;
  return Math.min(1, wordEditDistance(generated, final) / denom);
}
