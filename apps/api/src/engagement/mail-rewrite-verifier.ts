/**
 * Deterministic entailment check for "Rewrite with Meri" — modeled directly
 * on `apps/api-strategy/src/reports/report-narrative-verifier.ts`'s technique
 * (numbers/dates/names in generated prose must trace back to source
 * material), adapted to a source that is the user's own rough notes rather
 * than a cited evidence packet.
 *
 * There is no campaign evidence packet for a one-off email — the notes ARE
 * the evidence. This is deliberately strict in the same spirit as that
 * verifier's own stated philosophy: a rejected true sentence costs a little
 * polish, an accepted fabricated one (a dollar figure, a name, a commitment
 * the user never wrote) costs the user's credibility with the recipient.
 */

const NUMBER_REGEX = /(?<![a-z])[$€£]?(?:\d[\d,]*\d|\d)(?:\.\d+)?%?/gi;

/**
 * Capitalized words/acronyms, excluding sentence-initial common words (a
 * rewrite legitimately starts sentences the notes didn't, so "The", "We",
 * etc. at position 0 of a sentence must not count as an invented name).
 */
// Not exhaustive — a sentence-initial word this list doesn't recognize (e.g.
// "Great news — …") is treated as a possible name and can trigger a false
// positive (an unnecessary retry, or a fallback to the user's own text when
// the rewrite was actually fine). That's the safe direction to fail in: it
// costs a little polish, never a shipped fabrication, which is the same
// trade-off `report-narrative-verifier.ts` makes deliberately.
const SENTENCE_INITIAL_STOPWORDS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'it', 'we', 'our', 'they',
  'their', 'i', 'you', 'your', 'he', 'she', 'his', 'her', 'if', 'in', 'on', 'at',
  'as', 'by', 'to', 'of', 'for', 'and', 'or', 'but', 'with', 'from', 'please',
  'thanks', 'thank', 'hi', 'hello', 'dear', 'best', 'regards', 'sincerely',
]);

/**
 * Capitalized tokens that are never entity names wherever they appear —
 * pronouns, months, weekdays — mirroring `report-narrative-verifier.ts`'s
 * NAME_STOPWORDS decision. "I will follow up by March" must not read as two
 * invented names just because both are capitalized mid-sentence.
 */
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const ALWAYS_NAME_STOPWORDS = new Set([
  'i', ...MONTHS.map((m) => m.toLowerCase()),
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);

export interface MailRewriteVerification {
  verified: boolean;
  /** Tokens present in the rewrite but absent from the source notes. */
  unsupportedNumbers: string[];
  unsupportedNames: string[];
}

function normalizedNumber(token: string): string {
  // Strip thousands separators AND a leading currency symbol, so "$50,000" in
  // one draft matches "50000" in the other — a currency symbol added or
  // dropped in the rewrite isn't the kind of fabrication this guards against;
  // an actually different FIGURE is.
  return token.replace(/^[$€£]/, '').replace(/,/g, '').trim();
}

function extractNumbers(text: string): string[] {
  return Array.from(text.matchAll(NUMBER_REGEX), (m) => normalizedNumber(m[0]));
}

/** Capitalized tokens (names, acronyms, org names), skipping likely sentence-starts. */
function extractNames(text: string): string[] {
  const names: string[] = [];
  // Split on sentence-ending punctuation followed by whitespace, keeping it simple —
  // this doesn't need the abbreviation-awareness a formal report does; an email's
  // rare false-negative here just means one legitimate name check is skipped, not
  // that a fabrication would need to hide behind "Dr." to slip through elsewhere.
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/);
    words.forEach((raw, index) => {
      const word = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
      if (!word || !/^[A-Z]/.test(word)) return;
      if (index === 0 && SENTENCE_INITIAL_STOPWORDS.has(word.toLowerCase())) return;
      names.push(word);
    });
  }
  return names;
}

/**
 * Does the rewrite assert any number or capitalized name that the user's own
 * notes never mentioned? Case-insensitive for names: the source set is built
 * from ALL source words lowercased — not just the capitalized ones — so notes
 * written all-lowercase ("met patrick driscoll last week") still license
 * "Patrick Driscoll" in the rewrite. Numbers compare on their normalized
 * digits so "$2,000" matches a note that wrote "2000".
 */
export function verifyMailRewrite(rawText: string, rewritten: string): MailRewriteVerification {
  // `rewritten` arrives as the rewrite's HTML body — strip tags first, or the
  // closing tag glues onto the final word ("March.</p") and reads as an
  // invented name (and any digit-bearing markup would pollute the numbers).
  // Trim AFTER stripping: a leading stripped tag would otherwise leave
  // whitespace that makes split(/\s+/) yield an empty first word, shifting
  // every index and defeating the sentence-initial stopword check.
  const rewrittenText = rewritten.replace(/<[^>]+>/g, ' ').trim();
  const sourceNumbers = new Set(extractNumbers(rawText));
  const sourceNames = new Set(
    rawText
      .split(/\s+/)
      .map((w) => w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '').toLowerCase())
      .filter(Boolean),
  );

  const unsupportedNumbers = [...new Set(extractNumbers(rewrittenText))].filter(
    (n) => !sourceNumbers.has(n),
  );
  const unsupportedNames = [...new Set(extractNames(rewrittenText))].filter((n) => {
    const lower = n.toLowerCase();
    if (ALWAYS_NAME_STOPWORDS.has(lower)) return false;
    return !sourceNames.has(lower);
  });

  return {
    verified: unsupportedNumbers.length === 0 && unsupportedNames.length === 0,
    unsupportedNumbers,
    unsupportedNames,
  };
}
