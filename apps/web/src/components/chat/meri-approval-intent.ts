/**
 * Deterministic "did the user just approve the held write(s) in chat?" matcher.
 *
 * Why this exists: MeriV2 holds gated writes as `pending_approval` cards, and
 * clicking "Approve & run" was the ONLY channel that actually approved them.
 * Typing "I approve" started a NEW turn instead — which used to wipe every
 * outstanding card (the `start` handler cleared them), so the approval both
 * failed AND destroyed the thing it was approving. The model then re-proposed,
 * hashed to a fresh fingerprint, and the loop repeated forever. Confirmed live:
 * a user approved three client creations plus five profile updates in one
 * sitting and not a single row was written.
 *
 * The fingerprint stays the unit of approval — this matcher NEVER re-derives a
 * proposal, it only maps "the human said yes" onto cards already on screen and
 * already read. Nothing the user has not seen can be approved this way.
 *
 * Deliberately CONSERVATIVE. A false positive here executes a real write
 * (sending mail, creating a client), so:
 *   - Bare affirmatives ("yes", "ok", "sure") do NOT match. Meri frequently
 *     ends a turn with an unrelated question ("Would you like me to prepare
 *     meeting briefs?"), and a bare "yes" answers THAT at least as often as it
 *     approves a card.
 *   - Any negation or hedge disqualifies the whole message.
 *   - The message must be short. "I approve of how you structured the memo, but
 *     rewrite section 3" is prose, not a command.
 *   - Explicit approval vocabulary is required.
 */

/** Approval verbs/phrases that, on their own, unambiguously mean "run it". */
const APPROVAL_PHRASES = [
  'go ahead',
  'do it',
  'run it',
  'send it',
  'ship it',
  'make it so',
  'lgtm',
  'proceed',
  'confirmed',
  'confirm',
];

/**
 * Single tokens matched with typo tolerance (see `isFuzzyApprove`). Kept
 * separate from the phrase list because only single words get fuzzy-matched —
 * fuzzy-matching multi-word phrases invites false positives.
 */
const APPROVE_TOKENS = ['approve', 'approved', 'approves', 'approval'];

/**
 * Anything here disqualifies the message outright, even if it also contains an
 * approval word. "don't approve", "approve everything except the last one",
 * and "why do I need to approve?" must all fall through to the model.
 */
const DISQUALIFIERS =
  /\b(no|not|dont|don't|do not|never|stop|cancel|wait|hold|except|but|unless|instead|why|what|how|when|who|which|should|could|would|can|does|is it|\?)/i;

/** Longest message (in words) still treated as a command rather than prose. */
const MAX_WORDS = 8;

/**
 * Optimal string alignment distance (Damerau-Levenshtein restricted to
 * adjacent transpositions), capped early once it exceeds `max`.
 *
 * Transposition support is the whole point: the real-world miss that motivated
 * this was "i apporve all of it" — "apporve" is one transposition from
 * "approve" (OSA distance 1) but TWO plain-Levenshtein substitutions. Using
 * plain Levenshtein with a threshold of 2 would also swallow "improve", which
 * is a genuinely different instruction.
 */
export function osaDistance(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows = a.length + 1;
  const cols = b.length + 1;
  // Flat Int32Array rather than number[][]: under noUncheckedIndexedAccess a
  // nested array reads as `number | undefined` at every cell, which buries the
  // recurrence in non-null assertions. Typed-array reads are plain `number`.
  const d = new Int32Array(rows * cols);
  // `?? 0` is unreachable — every (i,j) below is in range — but it keeps the
  // recurrence free of non-null assertions under noUncheckedIndexedAccess.
  const at = (i: number, j: number): number => d[i * cols + j] ?? 0;
  for (let i = 0; i < rows; i += 1) d[i * cols] = i;
  for (let j = 0; j < cols; j += 1) d[j] = j;
  for (let i = 1; i < rows; i += 1) {
    let rowMin = Number.POSITIVE_INFINITY;
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, at(i - 2, j - 2) + 1);
      }
      d[i * cols + j] = v;
      if (v < rowMin) rowMin = v;
    }
    // Every remaining path runs through this row, so we can stop early.
    if (rowMin > max) return max + 1;
  }
  return at(a.length, b.length);
}

/** True when `token` is an approval word, allowing a single typo. */
function isFuzzyApprove(token: string): boolean {
  if (token.length < 6) return false; // too short to fuzzy-match safely
  return APPROVE_TOKENS.some((t) => osaDistance(token, t, 1) <= 1);
}

export interface ApprovalIntent {
  /** The user unambiguously approved. */
  approved: boolean;
  /** They said "all"/"everything" — approve the whole outstanding set. */
  all: boolean;
}

/**
 * Classify a chat message as an approval of the currently-displayed held
 * writes. Returns `approved: false` for anything ambiguous — the caller then
 * sends the message to the model as a normal turn, which is always safe.
 */
export function detectApprovalIntent(raw: string): ApprovalIntent {
  const none: ApprovalIntent = { approved: false, all: false };
  const text = (raw ?? '').trim().toLowerCase();
  if (!text) return none;

  // Strip trailing punctuation but keep '?' visible to the disqualifier.
  const normalized = text.replace(/[.!,;:]+$/g, '').trim();
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > MAX_WORDS) return none;
  if (DISQUALIFIERS.test(normalized)) return none;

  const tokens = words.map((w) => w.replace(/[^a-z']/g, ''));
  const hasApproveWord = tokens.some(isFuzzyApprove);
  const hasApprovePhrase = APPROVAL_PHRASES.some((p) => normalized.includes(p));
  if (!hasApproveWord && !hasApprovePhrase) return none;

  const all = /\b(all|everything|both|each|every)\b/.test(normalized);
  return { approved: true, all };
}
