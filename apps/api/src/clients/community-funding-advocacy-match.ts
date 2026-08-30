/**
 * Pure CPF/CDS → client match resolution for Advocacy History discovery.
 *
 * Kept out of client-profile-fill-completion.service.ts so the matching
 * hierarchy is unit-testable without Nest/Prisma. The gather rail in the
 * completion service owns SQL, finding emission, and backfill/health state;
 * this module only answers "does this canonical community_funding_request
 * belong on THIS client's review queue, and if so how?"
 *
 * Matching precedence (brief §17 — fail closed, never fuzzy-alone):
 *   1. confirmed client_intel_mapping (source=community_funding)
 *   2. exact normalized recipient name == client name
 *   3. exact alias/DBA — only when the caller supplies a confirmed alias set
 *      (no general entity-resolution framework invented here)
 *   4. strong fuzzy recipient match PLUS independent geography corroboration
 *      (client facility state intersects request state)
 *   5. otherwise no auto-finding
 *
 * Ambiguous fuzzy candidates (two+ strong fuzzy hits without a unique best
 * score, or fuzzy without geography) are skipped — never auto-emitted.
 */

import { normalizeIdentityText } from '../government-data/community-funding/community-funding.parser.js';

export const COMMUNITY_FUNDING_INTEL_MAPPING_SOURCE = 'community_funding';
/** Floor for pg_trgm / token-overlap fuzzy recipient match before geography is considered. */
export const COMMUNITY_FUNDING_FUZZY_THRESHOLD = 0.72;

export type CommunityFundingMatchMethod =
  | 'confirmed_client_intel_mapping'
  | 'exact_recipient_normalized'
  | 'exact_alias'
  | 'fuzzy_recipient_with_geography';

export type CommunityFundingMatchDecision =
  | {
      matched: true;
      method: CommunityFundingMatchMethod;
      confidence: number;
      similarity: number | null;
      geographyCorroborated: boolean;
    }
  | {
      matched: false;
      reason:
        | 'no_signal'
        | 'weak_fuzzy_without_geography'
        | 'ambiguous_fuzzy'
        | 'below_threshold';
    };

export interface CommunityFundingMatchInput {
  /** Canonical request id (UUID). */
  requestId: string;
  recipientName: string;
  recipientNormalized: string;
  state: string | null;
  /** Confirmed intel-mapping externalIds for this client (request ids). */
  confirmedRequestIds: ReadonlySet<string>;
  /** Client's own display/legal name (raw). */
  clientName: string;
  /** Optional extra exact-match strings (DBA / known aliases), already normalized or raw. */
  clientAliasesNormalized?: ReadonlySet<string>;
  /** Client facility / HQ state codes (uppercase 2-letter). */
  clientStates: ReadonlySet<string>;
  /**
   * Optional live similarity score from SQL (GREATEST(similarity, word_similarity)).
   * When omitted, a pure token Jaccard against the normalized recipient is used.
   */
  recipientSimilarity?: number;
}

export function communityFundingMatchConfidence(
  isConfirmed: boolean,
  method: CommunityFundingMatchMethod,
  similarity: number | null,
): number {
  if (isConfirmed || method === 'confirmed_client_intel_mapping') return 1;
  if (method === 'exact_recipient_normalized' || method === 'exact_alias') return 0.98;
  // Fuzzy + geography: scale by similarity, floor at threshold, never reach 1.
  const sim = similarity ?? COMMUNITY_FUNDING_FUZZY_THRESHOLD;
  return Number(
    Math.min(0.92, Math.max(COMMUNITY_FUNDING_FUZZY_THRESHOLD, 0.55 + sim * 0.4)).toFixed(3),
  );
}

/** Token Jaccard on normalizeIdentityText output — offline stand-in for pg_trgm in pure tests. */
export function recipientTokenOverlap(a: string, b: string): number {
  const ta = new Set(normalizeIdentityText(a).split(' ').filter(Boolean));
  const tb = new Set(normalizeIdentityText(b).split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

/**
 * Resolve one canonical request against one client. Does NOT emit findings and
 * does not know about multi-request ambiguity — the gather rail applies
 * `filterAmbiguousCommunityFundingMatches` across the batch after this.
 */
export function resolveCommunityFundingRecipientMatch(
  input: CommunityFundingMatchInput,
): CommunityFundingMatchDecision {
  if (input.confirmedRequestIds.has(input.requestId)) {
    return {
      matched: true,
      method: 'confirmed_client_intel_mapping',
      confidence: 1,
      similarity: null,
      geographyCorroborated: false,
    };
  }

  const clientNorm = normalizeIdentityText(input.clientName);
  const recipientNorm =
    input.recipientNormalized?.trim() ||
    normalizeIdentityText(input.recipientName);

  if (clientNorm && recipientNorm && clientNorm === recipientNorm) {
    return {
      matched: true,
      method: 'exact_recipient_normalized',
      confidence: communityFundingMatchConfidence(false, 'exact_recipient_normalized', 1),
      similarity: 1,
      geographyCorroborated: false,
    };
  }

  const aliases = input.clientAliasesNormalized ?? new Set<string>();
  if (recipientNorm && aliases.has(recipientNorm)) {
    return {
      matched: true,
      method: 'exact_alias',
      confidence: communityFundingMatchConfidence(false, 'exact_alias', 1),
      similarity: 1,
      geographyCorroborated: false,
    };
  }

  const similarity =
    typeof input.recipientSimilarity === 'number'
      ? input.recipientSimilarity
      : recipientTokenOverlap(input.clientName, input.recipientName);

  if (similarity < COMMUNITY_FUNDING_FUZZY_THRESHOLD) {
    return { matched: false, reason: similarity > 0 ? 'below_threshold' : 'no_signal' };
  }

  const requestState = (input.state ?? '').trim().toUpperCase();
  const geoOk =
    Boolean(requestState) &&
    input.clientStates.size > 0 &&
    input.clientStates.has(requestState);

  if (!geoOk) {
    return { matched: false, reason: 'weak_fuzzy_without_geography' };
  }

  return {
    matched: true,
    method: 'fuzzy_recipient_with_geography',
    confidence: communityFundingMatchConfidence(
      false,
      'fuzzy_recipient_with_geography',
      similarity,
    ),
    similarity,
    geographyCorroborated: true,
  };
}

/**
 * Fail-closed ambiguity filter for a batch of already-resolved matches for ONE
 * client. Confirmed / exact matches always pass. Fuzzy matches only pass when
 * there is a unique top similarity score among fuzzy candidates (no ties at
 * the top). Ties at the top fuzzy score are all dropped.
 */
export function filterAmbiguousCommunityFundingMatches<
  T extends { decision: CommunityFundingMatchDecision; requestId: string },
>(rows: T[]): T[] {
  const kept: T[] = [];
  const fuzzy: Array<T & { similarity: number }> = [];

  for (const row of rows) {
    if (!row.decision.matched) continue;
    if (row.decision.method === 'fuzzy_recipient_with_geography') {
      fuzzy.push({ ...row, similarity: row.decision.similarity ?? 0 });
    } else {
      kept.push(row);
    }
  }

  if (!fuzzy.length) return kept;

  const best = Math.max(...fuzzy.map((f) => f.similarity));
  const top = fuzzy.filter((f) => Math.abs(f.similarity - best) < 1e-9);
  if (top.length !== 1) {
    // Ambiguous: drop all top-tied fuzzy rows (fail closed).
    return kept;
  }
  kept.push(top[0]!);
  // Lower-scoring fuzzy rows that still cleared the threshold + geo are kept
  // only when they are not part of a top-tie — they are distinct weaker hits
  // for different recipients and are legitimate separate findings.
  for (const f of fuzzy) {
    if (f.requestId === top[0]!.requestId) continue;
    if (Math.abs(f.similarity - best) < 1e-9) continue;
    kept.push(f);
  }
  return kept;
}

export function communityFundingFindingTitle(input: {
  chamber: string;
  requestType: string;
  fiscalYear: number;
  recipientName: string;
}): string {
  const kind =
    input.requestType === 'cds' || input.chamber === 'senate'
      ? 'Congressionally Directed Spending'
      : 'Community Project Funding';
  return `${kind} request (FY${input.fiscalYear}) identified for ${input.recipientName}`;
}

export function communityFundingFindingSummary(input: {
  chamber: string;
  requestType: string;
  fiscalYear: number;
  requesterName: string;
  recipientName: string;
  projectTitle: string;
  requestedAmountUsd: string | number;
  finalAmountUsd?: string | number | null;
  amountStageRaw: string;
  appropriationsAccountRaw?: string | null;
  subcommittee?: string | null;
}): string {
  const kind =
    input.requestType === 'cds' || input.chamber === 'senate'
      ? 'Congressionally Directed Spending'
      : 'Community Project Funding';
  const amount = input.finalAmountUsd ?? input.requestedAmountUsd;
  const stage = input.amountStageRaw.replace(/_/g, ' ');
  const account = input.appropriationsAccountRaw
    ? ` Account: ${input.appropriationsAccountRaw}.`
    : '';
  const sub = input.subcommittee ? ` Subcommittee: ${input.subcommittee}.` : '';
  return (
    `Public ${kind} request for FY${input.fiscalYear}: ` +
    `"${input.projectTitle}" for ${input.recipientName}, requested by ${input.requesterName}. ` +
    `Amount (${stage}): $${amount}.${account}${sub} ` +
    `This is public evidence that a funding request was submitted for this recipient — ` +
    `it does not by itself prove the recipient lobbied Congress, personally submitted the request, or secured the funds.`
  );
}
