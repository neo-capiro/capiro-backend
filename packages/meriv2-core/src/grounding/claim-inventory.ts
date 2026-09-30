import { createHash } from 'node:crypto';
import type { MeriCitation } from '@capiro/shared';
import type { AssuredClaimType, ClaimLedger } from '../assurance/claim-ledger';
import { inferClaimCategories, type ClaimCategory } from '../assurance/evidence-plan';
import { classifyClaimType } from '../assurance/tool-ledger-adapter';

export type MaterialClaimExclusion =
  'greeting' | 'formatting' | 'brainstorm' | 'labelled_recommendation' | 'question' | 'meta';

export interface MaterialClaim {
  id: string;
  text: string;
  sentenceIndex: number;
  clauseIndex: number;
  kind: AssuredClaimType;
  category: ClaimCategory | 'unclassified';
  markers: number[];
  evidenceIds: string[];
  uncited: boolean;
  compound: boolean;
  parentId?: string;
  material: boolean;
  exclusion?: MaterialClaimExclusion;
  asOf?: string;
}

export interface ExtractMaterialClaimsInput {
  replyText: string;
  citations: readonly Pick<MeriCitation, 'n' | 'tool' | 'id' | 'stableId'>[];
  ledger?: ClaimLedger;
  asOf: string;
}

const MARKER_RE = /\[(\d{1,3})\]/g;
const FACTUAL_ASSERTION =
  /(?:\$\s?\d|\b\d{1,4}(?:[,.]\d+)*(?:%|\s+(?:million|billion))?\b|\b[A-Z]{2,}(?:[- ]?\d+)+\b|\b(?:is|are|was|were|has been|have been|passed|failed|signed|enacted|serves?|chairs?|holds?|received|awarded|scheduled|due)\b)/i;
const REAL_ENTITY = /\b(?:the\s+)?[A-Z][\w'’-]+(?:\s+[A-Z][\w'’.-]+){0,5}\b/;
const META =
  /^(?:sources?|notes?|answer|summary|here(?:'s| is)|based on (?:the )?(?:sources|information)|i (?:found|reviewed|can help))\b/i;
const GREETING = /^(?:hi|hello|hey|good (?:morning|afternoon|evening)|thanks|thank you)[!,.\s]*$/i;
const BRAINSTORM = /^(?:ideas?|options?|possibilities|brainstorm)(?:\s*:|$)/i;
const RECOMMENDATION_LABEL = /^(?:recommendations?|suggested next steps?|next steps?)(?:\s*:|$)/i;
const ABBREVIATIONS = /\b(?:Mr|Mrs|Ms|Dr|Sen|Rep|Gov|Gen|St|No|vs|U\.S|e\.g|i\.e)\.$/i;

/**
 * Deterministically inventories prose after release. Examples: "H.R. 1 passed [2]."
 * remains one sentence; "It passed [1], while funding fell [2]" becomes two
 * material clauses; headings and greetings remain represented as excluded rows.
 */
export function extractMaterialClaims(input: ExtractMaterialClaimsInput): MaterialClaim[] {
  const citationByMarker = new Map(input.citations.map((citation) => [citation.n, citation]));
  const ledgerClaims = input.ledger?.claims ?? [];
  const rows: MaterialClaim[] = [];

  for (const [sentenceIndex, sentence] of segmentReply(input.replyText).entries()) {
    const parentId = stableClaimId(sentenceIndex, 0, sentence);
    const clauses = splitClauses(sentence);
    const compound = clauses.length > 1;
    clauses.forEach((clause, clauseIndex) => {
      const text = cleanUnit(clause);
      if (!text) return;
      const markers = [...text.matchAll(MARKER_RE)].map((match) => Number(match[1]));
      const evidenceIds = orderedUnique(
        markers
          .map((marker) => citationByMarker.get(marker))
          .filter((citation): citation is NonNullable<typeof citation> => Boolean(citation))
          .map((citation) => citation.stableId || `${citation.tool}:${citation.id}`),
      );
      const plainText = text
        .replace(MARKER_RE, '')
        .replace(/\s+([.!?,;:])/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
      const ledgerClaim = ledgerClaims.find(
        (claim) =>
          normalize(claim.text) === normalize(plainText) ||
          normalize(claim.text).includes(normalize(plainText)),
      );
      const exclusion = classifyExclusion(plainText, sentence);
      const factualOverride =
        FACTUAL_ASSERTION.test(plainText) &&
        (REAL_ENTITY.test(plainText) || /\b[A-Z]+\.[A-Z.]*\s*\d+\b/.test(plainText));
      const material =
        !exclusion ||
        (factualOverride &&
          (exclusion === 'brainstorm' || exclusion === 'labelled_recommendation'));
      const kind =
        ledgerClaim?.type ??
        (/\b(?:unclear|unknown)\b/i.test(plainText) ? 'uncertainty' : classifyClaimType(plainText));
      const inferred = inferClaimCategories(plainText);
      const ledgerCategory = ledgerClaim?.category;
      const category = isClaimCategory(ledgerCategory)
        ? ledgerCategory
        : (inferred[0] ?? 'unclassified');
      rows.push({
        id: stableClaimId(sentenceIndex, clauseIndex, text),
        text: plainText,
        sentenceIndex,
        clauseIndex,
        kind,
        category,
        markers,
        evidenceIds: orderedUnique([...evidenceIds, ...(ledgerClaim?.sourceIds ?? [])]),
        uncited: material && evidenceIds.length === 0 && (ledgerClaim?.sourceIds.length ?? 0) === 0,
        compound,
        ...(compound ? { parentId } : {}),
        material,
        ...(!material && exclusion ? { exclusion } : {}),
        ...(input.asOf ? { asOf: input.asOf } : {}),
      });
    });
  }
  return rows;
}

export function segmentReply(replyText: string): string[] {
  const text = String(replyText ?? '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!text) return [];
  const lines = text.split('\n');
  const output: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^#{1,6}\s+/.test(line) || /^(?:[-*+] |\d+[.)]\s+)/.test(line)) {
      const prefix = line.match(/^(?:#{1,6}\s+|[-*+] |\d+[.)]\s+)/)?.[0] ?? '';
      const body = line.slice(prefix.length).trim();
      if (!body) output.push(line);
      else output.push(...segmentProse(body));
    } else output.push(...segmentProse(line));
  }
  return output;
}

function segmentProse(text: string): string[] {
  const result: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (!/[.!?]/.test(text[index]!)) continue;
    const candidate = text.slice(start, index + 1);
    if (
      text[index] === '.' &&
      (ABBREVIATIONS.test(candidate) ||
        /\d\.\d$/.test(candidate) ||
        /\b[A-Z](?:\.[A-Z])+\.$/.test(candidate) ||
        /^S\.$/.test(candidate))
    )
      continue;
    let end = index + 1;
    while (/\s*\[\d{1,3}\]/.test(text.slice(end))) {
      const marker = text.slice(end).match(/^\s*\[\d{1,3}\]/)?.[0];
      if (!marker) break;
      end += marker.length;
    }
    if (end === text.length || /\s/.test(text[end] ?? '')) {
      result.push(text.slice(start, end).trim());
      start = end;
      index = end - 1;
    }
  }
  const rest = text.slice(start).trim();
  if (rest) result.push(rest);
  return result;
}

function splitClauses(sentence: string): string[] {
  const semicolon = sentence.split(/\s*;\s*/).filter(Boolean);
  const clauses = semicolon.flatMap((part) =>
    part.split(/\s*,?\s+\b(?:while|whereas)\b\s+/i).filter(Boolean),
  );
  return clauses.flatMap((part) => {
    const conjunction = part.match(/^(.*?\[\d{1,3}\].*?)\s+(?:and|but)\s+(.+\[\d{1,3}\].*)$/i);
    if (
      conjunction &&
      FACTUAL_ASSERTION.test(conjunction[1]!) &&
      FACTUAL_ASSERTION.test(conjunction[2]!)
    ) {
      return [conjunction[1]!, conjunction[2]!];
    }
    const predicates = part.match(
      /^(.+?\b(?:is|was|has been|passed|failed|received)\b.+?)\s+(?:and|but)\s+(.+?\b(?:is|was|has been|passed|failed|received)\b.+)$/i,
    );
    return predicates ? [predicates[1]!, predicates[2]!] : [part];
  });
}

function classifyExclusion(text: string, original: string): MaterialClaimExclusion | undefined {
  if (GREETING.test(text)) return 'greeting';
  if (/\?$/.test(text)) return 'question';
  if (BRAINSTORM.test(text)) return 'brainstorm';
  if (RECOMMENDATION_LABEL.test(text)) return 'labelled_recommendation';
  if (META.test(text)) return 'meta';
  if (/^#{1,6}\s/.test(original) || /^(?:[-*+]\s*)?$/.test(text)) return 'formatting';
  if (
    /^(?:consider|could|might|one option is|another option is)\b/i.test(text) &&
    !FACTUAL_ASSERTION.test(text)
  )
    return 'brainstorm';
  return undefined;
}

function cleanUnit(text: string): string {
  return text
    .replace(/^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/\s+([.!?,;:])$/, '$1')
    .trim();
}

function stableClaimId(sentenceIndex: number, clauseIndex: number, text: string): string {
  return `claim-${sentenceIndex + 1}-${clauseIndex + 1}-${createHash('sha256').update(text).digest('hex').slice(0, 10)}`;
}

function orderedUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(MARKER_RE, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const CLAIM_CATEGORIES: ReadonlySet<string> = new Set([
  'bill_status',
  'member_vote',
  'current_role',
  'budget_amount',
  'budget_delta',
  'enactment',
  'report_language',
  'regulatory_deadline',
  'schedule_commitment',
  'regulatory_stage',
  'district_representation',
  'grant_opportunity',
  'grant_award',
  'procurement_opportunity',
  'client_recommendation',
  'negative_or_exhaustive',
  'general_background',
]);

function isClaimCategory(value: string | undefined): value is ClaimCategory {
  return Boolean(value && CLAIM_CATEGORIES.has(value));
}
