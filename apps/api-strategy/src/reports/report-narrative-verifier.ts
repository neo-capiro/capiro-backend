import {
  REPORT_NARRATIVE_SECTION_IDS,
  type ReportNarrativeEnvelope,
  type ReportNarrativeEvidence,
  type ReportNarrativeRejection,
  type ReportNarrativeRejectionReason,
  type ReportNarrativeSectionId,
  type VerifiedNarrativeParagraph,
  type VerifiedNarrativeSection,
  type VerifiedReportNarrative,
} from "./report-narrative.types.js";

/**
 * Destination-side narrative verification (defense in depth over the
 * orchestrator's own GroundedJson citation gate).
 *
 * The orchestrator already guarantees every paragraph cites at least one real
 * evidence id and that any quoted substring appears verbatim in cited
 * evidence. That gate does not check unquoted paraphrase, so this verifier
 * adds deterministic checks for the three fabrication classes that matter in
 * a client deliverable:
 *
 *   1. numbers — every digit-bearing token must appear in the cited evidence;
 *   2. dates — every month/day/year mention must match a cited evidence date;
 *   3. names — every capitalised name or acronym must appear somewhere in the
 *      full evidence packet.
 *
 * A paragraph that fails any check is dropped (never repaired), the reason is
 * recorded for the audit log, and the renderer falls back to the deterministic
 * fact listing for that section. This is intentionally strict: a rejected
 * true sentence costs a little polish, an accepted false one costs trust.
 */

const MAX_PARAGRAPH_CHARS = 1_400;
const MAX_PARAGRAPHS_PER_SECTION = 4;

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

const MONTH_PATTERN =
  "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DATE_REGEX = new RegExp(
  `\\b${MONTH_PATTERN}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b|\\b${MONTH_PATTERN}\\.?(?:,?\\s+(\\d{4}))\\b|\\b${MONTH_PATTERN}\\b`,
  "gi",
);
const ISO_DATE_REGEX = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
// Digit groups may contain thousands separators but never end on one, so a
// trailing sentence comma ("$1,250,000, backed by") is not swallowed.
const NUMBER_REGEX = /(?<![a-z])[$€£]?(?:\d[\d,]*\d|\d)(?:\.\d+)?%?/gi;
// Sentence splitting must not break on honorifics and common abbreviations,
// otherwise "Sen. Smith" makes "Smith" sentence-initial and skips the check.
const ABBREVIATION_REGEX =
  /\b(Sen|Sens|Rep|Reps|Hon|Dr|Mr|Mrs|Ms|Jr|Sr|St|Gov|Lt|Gen|Col|Maj|Capt|Sgt|Prof|Rev|Amb|Sec|Asst|Dept|Corp|Inc|Ltd|Co|No|vs|etc|approx|Fig|U\.S|D\.C)\.\s/g;
const ABBREVIATION_PLACEHOLDER = "";
const LEAKED_MARKER_REGEX =
  /\b(?:plan|ctx|fact|member|client|health|node|evidence):[a-z0-9_.:-]+|\[[^\]]{0,40}\]|\{[^}]{0,40}\}|<[^>]{1,40}>|(?:^|\s)#{1,6}\s|\*\*/i;

/**
 * Capitalised words that are ordinary English or report vocabulary rather
 * than entity names. Party labels are deliberately NOT here: a fabricated
 * party affiliation must fail the name check unless the evidence states it.
 */
const NAME_STOPWORDS = new Set<string>([
  ...MONTHS,
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "i",
  "a",
  "an",
  "the",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "we",
  "our",
  "they",
  "their",
  "there",
  "here",
  "if",
  "in",
  "on",
  "at",
  "as",
  "by",
  "to",
  "of",
  "for",
  "and",
  "or",
  "but",
  "with",
  "from",
  "into",
  "over",
  "under",
  "after",
  "before",
  "during",
  "while",
  "when",
  "where",
  "which",
  "who",
  "whose",
  "what",
  "how",
  "why",
  "no",
  "not",
  "yes",
  "all",
  "any",
  "each",
  "every",
  "both",
  "either",
  "neither",
  "none",
  "more",
  "most",
  "less",
  "least",
  "many",
  "much",
  "several",
  "some",
  "such",
  "only",
  "also",
  "then",
  "than",
  "so",
  "because",
  "although",
  "however",
  "meanwhile",
  "first",
  "second",
  "third",
  "next",
  "last",
  "final",
  "current",
  "currently",
  "today",
  "now",
  "early",
  "late",
  "mid",
  "near",
  "term",
  "plan",
  "step",
  "steps",
  "strategy",
  "objective",
  "objectives",
  "outcome",
  "outcomes",
  "ask",
  "decision",
  "decisions",
  "risk",
  "risks",
  "milestone",
  "milestones",
  "gate",
  "gates",
  "action",
  "actions",
  "owner",
  "owners",
  "team",
  "leadership",
  "executive",
  "client",
  "report",
  "timeline",
  "roadmap",
  "phase",
  "phases",
  "quarter",
  "week",
  "weeks",
  "month",
  "months",
  "year",
  "years",
  "day",
  "days",
  "fy",
  "q1",
  "q2",
  "q3",
  "q4",
  "sen",
  "rep",
  "dr",
  "mr",
  "ms",
  "mrs",
  "hon",
  "washington",
  "dc",
  "d.c",
  "congress",
  "congressional",
  "senate",
  "house",
  "committee",
  "committees",
  "subcommittee",
  "member",
  "members",
  "office",
  "offices",
  "staff",
  "federal",
  "capitol",
  "hill",
  "administration",
  "agency",
  "agencies",
  "department",
  "program",
  "programs",
  "fiscal",
  "budget",
  "appropriations",
  "authorization",
  "legislative",
  "legislation",
  "policy",
  "regulatory",
  "coalition",
  "procurement",
  "grant",
  "earmark",
  // Amendment-type vocabulary: the type label and generic legislative nouns.
  "amendment",
  "markup",
  "conference",
  "offset",
  "vendor",
  "vehicle",
  "confidential",
  "internal",
  "draft",
  "active",
  "suggested",
  "progress",
  "ongoing",
  "overdue",
  "unassigned",
  "evidence",
  "source",
  "sources",
  "approved",
  "context",
  "situation",
  "stakeholder",
  "stakeholders",
  "target",
  "targets",
  "delivery",
  "readiness",
  "health",
  "score",
  "capiro",
  "meri",
]);

export interface NarrativeVerificationInput {
  envelope: ReportNarrativeEnvelope;
  evidence: readonly ReportNarrativeEvidence[];
}

export function verifyReportNarrative(
  input: NarrativeVerificationInput,
): VerifiedReportNarrative {
  const evidenceById = new Map(
    input.evidence.map((entry) => [entry.id, entry] as const),
  );
  const corpus = buildCorpus(input.evidence.map((entry) => entry.text));
  const allowedSections = new Set<string>(REPORT_NARRATIVE_SECTION_IDS);

  const sections: VerifiedNarrativeSection[] = [];
  const rejections: ReportNarrativeRejection[] = [];
  let accepted = 0;
  let rejected = 0;
  const seenSections = new Set<string>();

  for (const section of input.envelope.sections ?? []) {
    const sectionId = String(section?.id ?? "");
    if (!allowedSections.has(sectionId) || seenSections.has(sectionId)) {
      for (const paragraph of section?.paragraphs ?? []) {
        rejected += 1;
        rejections.push(
          rejection(sectionId, "unknown_section", null, paragraph?.text),
        );
      }
      continue;
    }
    seenSections.add(sectionId);
    const kept: VerifiedNarrativeParagraph[] = [];
    const paragraphs = Array.isArray(section.paragraphs)
      ? section.paragraphs
      : [];
    paragraphs.forEach((paragraph, index) => {
      const text = typeof paragraph?.text === "string" ? paragraph.text : "";
      const evidenceIds = Array.isArray(paragraph?.evidenceIds)
        ? paragraph.evidenceIds.filter(
            (id): id is string => typeof id === "string",
          )
        : [];
      const failure =
        index >= MAX_PARAGRAPHS_PER_SECTION
          ? ({ reason: "too_many_paragraphs", detail: null } as const)
          : verifyParagraph(text, evidenceIds, evidenceById, corpus);
      if (failure) {
        rejected += 1;
        rejections.push(rejection(sectionId, failure.reason, failure.detail, text));
        return;
      }
      accepted += 1;
      kept.push({
        text: normalizeWhitespace(text),
        evidenceIds: [...new Set(evidenceIds)],
        sourceTitles: [
          ...new Set(
            evidenceIds
              .map((id) => evidenceById.get(id)?.sourceTitle)
              .filter((title): title is string => Boolean(title)),
          ),
        ],
      });
    });
    if (kept.length > 0) {
      sections.push({
        id: sectionId as ReportNarrativeSectionId,
        paragraphs: kept,
      });
    }
  }

  return {
    sections,
    model: String(input.envelope.model ?? "unknown"),
    generatedAt: String(input.envelope.generatedAt ?? ""),
    usage: {
      inputTokens: Number(input.envelope.usage?.inputTokens ?? 0) || 0,
      outputTokens: Number(input.envelope.usage?.outputTokens ?? 0) || 0,
    },
    attempts: Number(input.envelope.attempts ?? 0) || 0,
    acceptedParagraphs: accepted,
    rejectedParagraphs: rejected,
    orchestratorDroppedParagraphs:
      Number(input.envelope.droppedParagraphs ?? 0) || 0,
    rejections,
  };
}

interface ParagraphFailure {
  reason: ReportNarrativeRejectionReason;
  detail: string | null;
}

function verifyParagraph(
  text: string,
  evidenceIds: readonly string[],
  evidenceById: ReadonlyMap<string, ReportNarrativeEvidence>,
  corpus: Corpus,
): ParagraphFailure | null {
  const trimmed = text.trim();
  if (!trimmed) return { reason: "empty_text", detail: null };
  if (trimmed.length > MAX_PARAGRAPH_CHARS)
    return { reason: "too_long", detail: String(trimmed.length) };
  if (evidenceIds.length === 0)
    return { reason: "no_evidence_cited", detail: null };
  const unknown = evidenceIds.find((id) => !evidenceById.has(id));
  if (unknown !== undefined)
    return { reason: "unknown_evidence_id", detail: unknown };
  const leaked = LEAKED_MARKER_REGEX.exec(trimmed);
  if (leaked) return { reason: "leaked_marker", detail: leaked[0].trim() };

  const cited = buildCorpus(
    evidenceIds.map((id) => evidenceById.get(id)?.text ?? ""),
  );

  // Dates first: a wrong day inside a date is reported as a date problem, and
  // a grounded date guarantees its own digits appear in the cited evidence.
  const badDate = findUngroundedDate(trimmed, cited);
  if (badDate) return { reason: "ungrounded_date", detail: badDate };

  const badNumber = findUngroundedNumber(trimmed, cited);
  if (badNumber) return { reason: "ungrounded_number", detail: badNumber };

  const badName = findUngroundedName(trimmed, corpus);
  if (badName) return { reason: "ungrounded_name", detail: badName };

  return null;
}

interface Corpus {
  /** Lower-cased text with digit-group commas removed. */
  text: string;
  /** Lower-cased word tokens (possessives and plurals folded). */
  words: Set<string>;
  dates: CanonicalDate[];
}

interface CanonicalDate {
  month: number;
  day: number | null;
  year: number | null;
}

function buildCorpus(texts: readonly string[]): Corpus {
  const joined = texts.join("\n");
  const text = normalizeNumbers(joined).toLowerCase();
  const words = new Set<string>();
  for (const token of text.split(/[^a-z0-9]+/)) {
    if (!token) continue;
    for (const variant of wordVariants(token)) words.add(variant);
  }
  return { text, words, dates: extractDates(joined) };
}

function normalizeNumbers(value: string): string {
  return value.replace(/(\d),(?=\d{3}\b)/g, "$1");
}

function findUngroundedNumber(text: string, cited: Corpus): string | null {
  const normalized = normalizeNumbers(text);
  for (const match of normalized.matchAll(NUMBER_REGEX)) {
    const token = match[0];
    const bare = token.replace(/^[$€£]/, "").replace(/%$/, "");
    if (!bare) continue;
    // Ordinal/list numbering such as "1." or "(2)" carries no factual weight.
    const before = normalized.slice(Math.max(0, match.index! - 1), match.index);
    const after = normalized.slice(
      match.index! + token.length,
      match.index! + token.length + 1,
    );
    if (/^\d$/.test(bare) && (after === "." || after === ")" || before === "(")) {
      continue;
    }
    if (!numberAppears(bare, cited.text)) return token;
  }
  return null;
}

function numberAppears(bare: string, corpusText: string): boolean {
  const escaped = bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\d.])${escaped}(?![\\d])`).test(corpusText);
}

function findUngroundedDate(text: string, cited: Corpus): string | null {
  for (const date of extractDates(text)) {
    const grounded = cited.dates.some(
      (candidate) =>
        candidate.month === date.month &&
        (date.day === null || candidate.day === date.day) &&
        (date.year === null || candidate.year === date.year),
    );
    if (!grounded) return date.raw;
  }
  return null;
}

function extractDates(text: string): Array<CanonicalDate & { raw: string }> {
  const dates: Array<CanonicalDate & { raw: string }> = [];
  for (const match of text.matchAll(ISO_DATE_REGEX)) {
    dates.push({
      raw: match[0],
      year: Number(match[1]),
      month: Number(match[2]) - 1,
      day: Number(match[3]),
    });
  }
  for (const match of text.matchAll(DATE_REGEX)) {
    const monthToken = (match[1] ?? match[4] ?? match[6] ?? "").toLowerCase();
    const month = monthIndex(monthToken);
    if (month === null) continue;
    const day = match[2] ? Number(match[2]) : null;
    const year = match[3]
      ? Number(match[3])
      : match[5]
        ? Number(match[5])
        : null;
    if (day !== null && (day < 1 || day > 31)) continue;
    dates.push({ raw: match[0], month, day, year });
  }
  return dates;
}

function monthIndex(token: string): number | null {
  if (!token) return null;
  // "may" is both a month and a modal verb; require day/year context handled
  // by the caller's regex alternatives — a bare "may" is still a month here
  // only when written capitalised, which the regex cannot see. Treat a bare
  // lower-case "may" as a verb.
  const index = MONTHS.findIndex((month) => month.startsWith(token.slice(0, 3)));
  return index >= 0 ? index : null;
}

function findUngroundedName(text: string, corpus: Corpus): string | null {
  const protectedText = text.replace(
    ABBREVIATION_REGEX,
    (match) => match.trimEnd() + ABBREVIATION_PLACEHOLDER,
  );
  const sentences = protectedText
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.replaceAll(ABBREVIATION_PLACEHOLDER, " "));
  for (const sentence of sentences) {
    const tokens = sentence.split(/\s+/).filter(Boolean);
    let index = 0;
    while (index < tokens.length) {
      if (!isCapitalisedToken(tokens[index]!)) {
        index += 1;
        continue;
      }
      const run: string[] = [];
      let cursor = index;
      while (cursor < tokens.length) {
        const token = tokens[cursor]!;
        if (isCapitalisedToken(token)) {
          run.push(token);
          cursor += 1;
          continue;
        }
        // Allow connective words inside a proper-noun run ("Department of Defense").
        if (
          run.length > 0 &&
          /^(of|the|and|for|on|&|de|du|la|del|von|van)$/i.test(
            stripPunctuation(token),
          ) &&
          cursor + 1 < tokens.length &&
          isCapitalisedToken(tokens[cursor + 1]!)
        ) {
          run.push(token);
          cursor += 1;
          continue;
        }
        break;
      }
      const sentenceInitial = index === 0;
      const candidate = sentenceInitial ? run.slice(1) : run;
      const failure = checkNameRun(
        candidate,
        corpus,
        sentenceInitial ? (run[0] ?? null) : null,
      );
      if (failure) return failure;
      index = cursor;
    }
  }
  return null;
}

function checkNameRun(
  run: readonly string[],
  corpus: Corpus,
  sentenceInitialToken: string | null,
): string | null {
  // A sentence-initial acronym ("NDAA reauthorization…") is still an entity.
  if (sentenceInitialToken && isAcronym(sentenceInitialToken)) {
    const acronym = stripPunctuation(sentenceInitialToken).toLowerCase();
    if (!corpusHasWord(acronym, corpus)) return sentenceInitialToken;
  }
  const words = run
    .map((token) => stripPunctuation(token))
    .filter((token) => token.length > 0);
  if (words.length === 0) return null;
  const phrase = words.join(" ").toLowerCase();
  if (phrase && corpus.text.includes(phrase)) return null;
  for (const word of words) {
    const lower = word.toLowerCase();
    if (NAME_STOPWORDS.has(lower) || NAME_STOPWORDS.has(lower.replace(/\.$/, "")))
      continue;
    if (/^\d/.test(lower)) continue;
    if (!/[a-z]/i.test(word)) continue;
    if (lower.length < 2) continue;
    if (!corpusHasWord(lower, corpus)) return word;
  }
  return null;
}

function corpusHasWord(word: string, corpus: Corpus): boolean {
  for (const variant of wordVariants(word)) {
    if (corpus.words.has(variant)) return true;
  }
  return false;
}

function wordVariants(word: string): string[] {
  const base = word.replace(/[’']s$/, "").replace(/[’']$/, "");
  const variants = new Set<string>([word, base]);
  if (base.endsWith("es")) variants.add(base.slice(0, -2));
  if (base.endsWith("s")) variants.add(base.slice(0, -1));
  variants.add(`${base}s`);
  return [...variants].filter(Boolean);
}

function isCapitalisedToken(token: string): boolean {
  const stripped = stripPunctuation(token);
  if (!stripped) return false;
  if (isAcronym(stripped)) return true;
  return /^[A-Z][a-zA-Z’'.-]*$/.test(stripped) && /[a-z]/.test(stripped);
}

function isAcronym(token: string): boolean {
  const stripped = stripPunctuation(token);
  return /^[A-Z][A-Z0-9&.-]{1,}$/.test(stripped) && /[A-Z]{2}/.test(stripped);
}

function stripPunctuation(token: string): string {
  return token.replace(/^[("'“‘\[]+|[)"'”’\],.;:!?]+$/g, "");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function rejection(
  sectionId: string,
  reason: ReportNarrativeRejectionReason,
  detail: string | null,
  text: unknown,
): ReportNarrativeRejection {
  const excerpt = typeof text === "string" ? normalizeWhitespace(text) : "";
  return {
    sectionId,
    reason,
    detail,
    excerpt: excerpt.length > 160 ? `${excerpt.slice(0, 159)}…` : excerpt,
  };
}
