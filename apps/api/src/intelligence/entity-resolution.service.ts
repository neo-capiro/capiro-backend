import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  decideContractorCandidates,
  // Imported rather than re-implemented: a second copy of the domain extractor
  // would drift from the one the tiering policy actually uses.
  domainOf,
  type ContractorCandidate,
  type ContractorMatchBasis,
  type IdentityTier,
  type MatchExplanation,
} from './contractor-identity.js';

// ── Stage A/B raw row from SQL ───────────────────────────────────────────────
interface MatchRow {
  external_id: string;
  external_name: string;
  similarity: number;
  state?: string | null;
  // Set only by a verified-identifier match (e.g. UEI-to-UEI). When present,
  // persistSourceCandidates uses this value directly instead of running the
  // row through scoreCandidate's name-fingerprint heuristics, which have
  // nothing meaningful to say about a match that isn't name-based at all.
  preScored?: number;
  // ── Contractor identity tiering (§8) ──────────────────────────────────────
  // Set only for source='contracting', by decideContractorCandidates. When
  // present these carry the verdict AND its evidence, and they are what
  // candidateDecision consults instead of the confidence number: only tier 1
  // (an unambiguous exact identifier) may auto-confirm, so a name — however
  // similar — can no longer become a confirmed corporate identity.
  matchBasis?: ContractorMatchBasis;
  matchTier?: IdentityTier;
  matchEvidence?: MatchExplanation;
  autoConfirmEligible?: boolean;
}

export interface ResolutionSummary {
  totalClients: number;
  mappingsCreated: number;
  autoConfirmed: number;
  needsReview: number;
}

/** The client-scoped contractor review payload (see contractorCandidatesForClient). */
export interface ContractorCandidateView {
  client: { id: string; name: string; uei: string | null; cageCode: string | null };
  candidates: Array<{
    contractorId: string;
    contractorName: string;
    /** For ORDERING the queue. Never displayed as a bare percentage. */
    confidence: number;
    autoConfirmEligible: boolean;
    matchBasis: ContractorMatchBasis;
    matchTier: IdentityTier;
    explanation: MatchExplanation | null;
    mapping: {
      id: string;
      confirmed: boolean;
      matchBasis: string;
      matchTier: number | null;
      relationshipType: string | null;
      rollUpAwards: boolean | null;
    } | null;
  }>;
}

// Suffixes stripped during fingerprinting (word-boundary, case-insensitive).
const SUFFIX_RE =
  /\b(inc|llc|corp|ltd|co|lp|llp|pa|pc|pllc|group|holdings|international|associates|partners|consulting|services|solutions|technologies|enterprises)\b\.?/gi;

// Generic tokens that carry NO entity identity on their own. The trigram matcher
// casts a wide net on the full name, so a short distinctive client name dominated
// by a generic word (e.g. "RTX CORPORATION") trigram-matches dozens of unrelated
// "<X> CORPORATION" filers (FOX/CSX/GATX/VF CORPORATION…) at ~0.6 — flooding the
// review queue with junk. We strip these before checking whether two names share
// any DISTINCTIVE token. SUFFIX_RE already removes inc/llc/corp/etc.; this adds the
// spelled-out forms that survive it.
const GENERIC_NAME_TOKENS = new Set([
  'corporation',
  'company',
  'companies',
  'incorporated',
  'limited',
  'holdings',
  'group',
  'international',
  'corp',
  'inc',
  'llc',
  'co',
  'the',
  'and',
  'of',
  'for',
  'a',
]);

/**
 * Normalise an entity name to the form every similarity judgement in this file
 * is made against: lowercased, corporate suffixes stripped, punctuation
 * flattened.
 *
 * Exported as a free function (the class method below just delegates) so
 * offline tooling can reproduce the matcher's own verdict instead of
 * approximating it. `prune-stale-assistance-recipient-candidates.ts` has to
 * decide which historical rows today's matcher would refuse to write, and that
 * answer is only trustworthy if it uses this exact normalisation — a second
 * copy would drift and start deleting rows the matcher would have kept.
 */
export function fingerprintName(name: string): string {
  return name
    .toLowerCase()
    .replace(SUFFIX_RE, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Distinctive tokens of a fingerprint = tokens that aren't generic corporate words. */
export function distinctiveTokens(fingerprint: string): string[] {
  return fingerprint
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !GENERIC_NAME_TOKENS.has(t));
}

/**
 * True when two fingerprints share at least one distinctive token, OR when either
 * has no distinctive token at all (can't judge — don't penalise). Used to drop
 * pure "<X> CORPORATION"-style trigram collisions before they reach the queue.
 */
export function sharesDistinctiveToken(aFingerprint: string, bFingerprint: string): boolean {
  const a = distinctiveTokens(aFingerprint);
  const b = distinctiveTokens(bFingerprint);
  if (a.length === 0 || b.length === 0) return true;
  const bset = new Set(b);
  return a.some((t) => bset.has(t));
}

// Minimum confidence required to persist a candidate mapping. The per-source SQL
// uses a loose similarity > 0.3 to cast a wide net, but writing everything above
// that floods the review queue with generic-string noise (e.g. employer
// "services" fuzzy-matching dozens of clients). Only candidates clearing this
// floor are written; the rest are dropped before they reach the review queue.
export const MIN_WRITE_CONFIDENCE = 0.4;

/** Confidence at/above which a single best candidate may be auto-confirmed. */
export const AUTO_CONFIRM_THRESHOLD = 0.85;

// Confidence ceiling applied to a candidate we don't trust as a graduated
// signal — either because the two names share no distinctive token, or (for
// assistance_recipient specifically) because they aren't fingerprint-exact at
// all. Strictly below MIN_WRITE_CONFIDENCE so the candidate is dropped, not
// written. One named constant so the two call sites can't silently drift.
const NON_DISTINCTIVE_MATCH_CAP = 0.35;

// Confidence assigned to an assistance_recipient candidate found via an exact
// Client.uei ↔ federal_assistance_award.recipient_uei match (see
// matchAssistanceRecipientByUei). A UEI is a verified, globally-unique federal
// identifier — categorically stronger evidence than any name heuristic in this
// file — so it's scored high enough to sort first in review. Deliberately below
// 1.0 (reserved for a deliberate human pin via the manual-attach endpoint) and
// deliberately still routed through NEVER_AUTO_CONFIRM: District Nexus Rev 2's
// 2026-07-27 remediation found $15B+ in wrong name-based suggestions, so this
// source keeps a human in the loop even for its strongest signal.
export const ASSISTANCE_RECIPIENT_UEI_MATCH_CONFIDENCE = 0.97;

/**
 * The best candidate for a source must beat the runner-up by at least this much
 * to auto-confirm. A near-tie (e.g. two plausible LDA clients with the same
 * name) is ambiguous and routes to human review instead of guessing.
 */
export const AUTO_CONFIRM_AMBIGUITY_MARGIN = 0.05;

export type CandidateDecision = 'skip' | 'review' | 'auto_confirm';

/**
 * Single source of truth for what happens to one scored candidate, given its
 * rank within its source. Only the single best candidate per source may
 * auto-confirm, and only when it clears the threshold AND is clearly ahead of
 * the runner-up. fec_committee never auto-confirms (PAC attribution is
 * compliance-sensitive — always human-reviewed). assistance_recipient never
 * auto-confirms EITHER, deliberately, for both of its candidate paths: a
 * name-fuzzy match (matchAssistanceRecipient — scoreCandidate's name-fingerprint
 * heuristics, capped hard for this source, see NON_DISTINCTIVE_MATCH_CAP) and
 * an exact-UEI match (matchAssistanceRecipientByUei — a verified identifier,
 * not a name heuristic, but still routed to human review; see
 * ASSISTANCE_RECIPIENT_UEI_MATCH_CONFIDENCE for why). Both paths only ever
 * reach 'review', never 'auto_confirm', regardless of confidence.
 */
export function candidateDecision(params: {
  source: string;
  confidence: number;
  isTopForSource: boolean;
  runnerUpConfidence: number | null;
  /**
   * Identity tier, for sources that compute one. Only 'contracting' does today
   * (see contractor-identity.ts). When present it OVERRIDES the confidence-based
   * auto-confirm path entirely — the tier is a statement about the KIND of
   * evidence, and no confidence number can substitute for an identifier.
   */
  matchTier?: IdentityTier;
  /**
   * The tiering policy's own verdict on whether this candidate is unambiguous.
   * Only consulted alongside `matchTier`.
   */
  autoConfirmEligible?: boolean;
}): CandidateDecision {
  const {
    source,
    confidence,
    isTopForSource,
    runnerUpConfidence,
    matchTier,
    autoConfirmEligible,
  } = params;
  const NEVER_AUTO_CONFIRM = new Set(['fec_committee', 'assistance_recipient']);
  const clearWinner =
    runnerUpConfidence === null ||
    confidence - runnerUpConfidence >= AUTO_CONFIRM_AMBIGUITY_MARGIN;

  // TIERED SOURCE (contracting): the tier decides, not the score.
  //
  // This is a deliberate TIGHTENING of prior behaviour. A 'contracting'
  // candidate used to auto-confirm at confidence >= 0.85, which
  // scoreCandidate handed out for any multi-token exact-fingerprint name match —
  // i.e. a NAME could silently become a confirmed corporate identity, and a
  // confirmed identity is what the award footprint, the agency-history relevance
  // signals and the District Nexus obligation rails all read. Now only tier 1
  // (an exact, unique, unambiguous federal identifier) auto-confirms; an exact
  // legal name routes to review. Auto-confirmation gets strictly rarer, never
  // more common.
  if (matchTier !== undefined) {
    const tierAutoConfirm =
      isTopForSource && clearWinner && matchTier === 1 && autoConfirmEligible === true;
    if (confidence < MIN_WRITE_CONFIDENCE && !tierAutoConfirm) return 'skip';
    return tierAutoConfirm ? 'auto_confirm' : 'review';
  }

  const autoConfirm =
    isTopForSource &&
    clearWinner &&
    !NEVER_AUTO_CONFIRM.has(source) &&
    confidence >= AUTO_CONFIRM_THRESHOLD;
  if (confidence < MIN_WRITE_CONFIDENCE && !autoConfirm) return 'skip';
  return autoConfirm ? 'auto_confirm' : 'review';
}

@Injectable()
export class EntityResolutionService {
  private readonly logger = new Logger(EntityResolutionService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Stage B: Fingerprint ──────────────────────────────────────────────────

  fingerprint(name: string): string {
    return fingerprintName(name);
  }

  // ── Stage C: Score a candidate ────────────────────────────────────────────

  private scoreCandidate(
    clientFp: string,
    row: MatchRow,
    source?: string,
    opts?: { anchored?: boolean },
  ): number {
    let confidence = row.similarity;

    // Exact normalized-name ("fingerprint") match is the strongest signal we
    // have. A MULTI-TOKEN exact match (e.g. "lockheed martin" == "lockheed
    // martin") is highly unlikely to be a coincidence, so promote it into
    // auto-confirm territory — this rescues obvious pairs like "Acme Defense
    // Corp" vs "Acme Defense Corporation" that raw trigram scores well below the
    // bar. A SINGLE-TOKEN exact fingerprint (e.g. "acme", "defense") can collapse
    // genuinely different firms after suffix stripping, so it is only strong
    // enough for human review, never auto-confirm.
    const externalFp = this.fingerprint(row.external_name);
    const fingerprintExact = clientFp.length > 0 && clientFp === externalFp;
    const fingerprintMultiToken = clientFp.includes(' ');
    if (fingerprintExact && fingerprintMultiToken) {
      confidence = Math.max(confidence, 0.9);
    } else if (fingerprintExact) {
      confidence = Math.max(confidence, 0.7);
    }

    // Registrant-anchored candidates come from THIS firm's own LDA filings, so a
    // MULTI-TOKEN exact match within that pool is essentially certain — promote it
    // to auto-confirm. Single-token exacts stay review-only even when anchored: a
    // user can type a name the firm never filed for that suffix-strips to the same
    // lone token as a genuinely different client (e.g. "Apple" vs "Apple Inc"),
    // and auto-confirming would pin the wrong entity + drive prepopulation off it.
    if (opts?.anchored && fingerprintExact && fingerprintMultiToken) {
      confidence = Math.max(confidence, 0.95);
    }

    // Distinctiveness guard: a high raw trigram score driven only by a shared
    // generic word ("<X> CORPORATION" vs "RTX CORPORATION") is noise, not a match.
    // If the two names share NO distinctive token, cap below the write floor so the
    // candidate is dropped rather than flooding the review queue. Never lowers a
    // genuine fingerprint-exact match (those share all tokens by definition).
    if (!fingerprintExact) {
      if (!sharesDistinctiveToken(clientFp, externalFp)) {
        confidence = Math.min(confidence, NON_DISTINCTIVE_MATCH_CAP);
      }

      // assistance_recipient's pool (federal_assistance_award recipients) spans
      // wildly heterogeneous entity types — universities, counties, energy
      // companies, foundations — where two DIFFERENT organizations routinely
      // share a real, non-generic word the guard above can't catch: "Olivet
      // University"/"Duke University", "Santa Rosa County"/"Santa Clara
      // County". Verified 2026-07-27: 173 of 183 live candidates were wrong
      // this way, several with $B+ obligated attached (district-nexus
      // remediation). Unlike every other source here, a non-exact name match
      // on this source is not a graduated confidence signal — it's capped
      // below the write floor unconditionally. A verified UEI match bypasses
      // this function entirely via MatchRow.preScored (see
      // matchAssistanceRecipientByUei), so this only affects name-only guesses.
      if (source === 'assistance_recipient') {
        confidence = Math.min(confidence, NON_DISTINCTIVE_MATCH_CAP);
      }
    }

    return Math.min(confidence, 1.0);
  }

  /**
   * Score-sort one source's candidates and persist them, auto-confirming only
   * the single best when {@link candidateDecision} says it is unambiguous. Never
   * downgrades an existing human-confirmed mapping (confirmed is only ever set to
   * true, never back to false). Returns counts for the tenant-wide summary.
   */
  private async persistSourceCandidates(
    clientId: string,
    tenantId: string,
    source: string,
    rows: MatchRow[],
    clientFp: string,
    anchored = false,
  ): Promise<{ created: number; autoConfirmed: number; needsReview: number }> {
    const scored = rows
      .map((row) => ({
        externalId: row.external_id,
        externalName: row.external_name,
        // A verified-identifier match (row.preScored) skips the name-fingerprint
        // heuristics entirely — see MatchRow.preScored.
        confidence: row.preScored ?? this.scoreCandidate(clientFp, row, source, { anchored }),
        matchBasis: row.matchBasis,
        matchTier: row.matchTier,
        matchEvidence: row.matchEvidence,
        autoConfirmEligible: row.autoConfirmEligible,
      }))
      .sort((a, b) => b.confidence - a.confidence);

    let created = 0;
    let autoConfirmed = 0;
    let needsReview = 0;

    for (let i = 0; i < scored.length; i++) {
      const cand = scored[i]!;
      const decision = candidateDecision({
        source,
        confidence: cand.confidence,
        isTopForSource: i === 0,
        runnerUpConfidence: i === 0 ? (scored[1]?.confidence ?? null) : null,
        ...(cand.matchTier !== undefined ? { matchTier: cand.matchTier } : {}),
        ...(cand.autoConfirmEligible !== undefined
          ? { autoConfirmEligible: cand.autoConfirmEligible }
          : {}),
      });
      if (decision === 'skip') continue;
      const autoConfirm = decision === 'auto_confirm';

      // Basis/tier/evidence are written whenever the source computes them. They
      // are the match EXPLANATION — a reviewer needs the identifiers, the
      // normalized names and (especially) the conflicting facts, none of which a
      // confidence percentage conveys.
      const evidence: {
        matchBasis?: string;
        matchTier?: number;
        matchEvidence?: Prisma.InputJsonValue;
      } = {};
      if (cand.matchBasis) evidence.matchBasis = cand.matchBasis;
      if (cand.matchTier !== undefined) evidence.matchTier = cand.matchTier;
      if (cand.matchEvidence) {
        evidence.matchEvidence = cand.matchEvidence as unknown as Prisma.InputJsonValue;
      }

      const updateData: {
        externalName: string;
        confidence: number;
        confirmed?: boolean;
        matchBasis?: string;
        matchTier?: number;
        matchEvidence?: Prisma.InputJsonValue;
      } = {
        externalName: cand.externalName,
        confidence: cand.confidence,
        ...evidence,
      };
      // Only ever upgrade to confirmed; never silently un-confirm a human pick.
      if (autoConfirm) updateData.confirmed = true;

      await this.prisma.withTenant(tenantId, (tx) =>
        tx.clientIntelMapping.upsert({
          where: {
            clientId_source_externalId: { clientId, source, externalId: cand.externalId },
          },
          update: updateData,
          create: {
            tenantId,
            clientId,
            source,
            externalId: cand.externalId,
            externalName: cand.externalName,
            confidence: cand.confidence,
            confirmed: autoConfirm,
            ...evidence,
            // 'self' is asserted ONLY for an auto-confirmed exact-identifier
            // match, where the identifier IS the assertion that these are one
            // entity. Everything else leaves relationshipType null: a reviewer
            // has to say whether the federal record is the client, its parent,
            // its subsidiary or a former name, and guessing 'self' would fabricate
            // that answer.
            ...(autoConfirm && cand.matchTier === 1
              ? { relationshipType: 'self', rollUpAwards: true }
              : {}),
          },
        }),
      );

      created++;
      if (autoConfirm) autoConfirmed++;
      else needsReview++;
    }

    return { created, autoConfirmed, needsReview };
  }

  // ── Stage A: Fuzzy match per source ──────────────────────────────────────

  private async matchLda(clientName: string): Promise<MatchRow[]> {
    return this.prisma.$queryRaw<MatchRow[]>`
      SELECT id::text AS external_id, name AS external_name,
             similarity(name, ${clientName}) AS similarity,
             state
      FROM lda_client
      WHERE similarity(name, ${clientName}) > 0.3
      ORDER BY similarity DESC
      LIMIT 50
    `;
  }

  /**
   * Registrant-anchored LDA candidates: the DISTINCT clients THIS firm has filed
   * for (lda_filing.registrant_id), scored by name similarity to the target. The
   * pool is tiny (the firm's own clients), which eliminates the cross-firm trigram
   * noise ("GE AEROSPACE" vs "DELTA BLACK AEROSPACE") that floods the global pool.
   * No similarity floor — the pool is already curated by firm; scoreCandidate and
   * the write floor decide what persists.
   */
  private async matchLdaByRegistrant(clientName: string, registrantId: number): Promise<MatchRow[]> {
    // DISTINCT ON requires client_id to lead the INNER order-by; we then re-rank
    // the deduped rows by similarity in an OUTER query so the LIMIT keeps the most
    // SIMILAR clients (not the numerically-lowest client_ids — a firm with >500
    // distinct clients would otherwise silently drop high-id matches).
    return this.prisma.$queryRaw<MatchRow[]>`
      SELECT * FROM (
        SELECT DISTINCT ON (client_id)
               client_id::text AS external_id,
               client_name AS external_name,
               similarity(client_name, ${clientName}) AS similarity,
               client_state AS state
        FROM lda_filing
        WHERE registrant_id = ${registrantId}
          AND client_id IS NOT NULL
          AND client_name <> ''
        ORDER BY client_id, similarity(client_name, ${clientName}) DESC
      ) d
      ORDER BY d.similarity DESC
      LIMIT 500
    `;
  }

  /**
   * Pick the LDA candidate set: registrant-anchored when the tenant has a known
   * LDA registrant AND that firm's filings contain a usable match; otherwise fall
   * back to the global fuzzy pool so a client the firm hasn't filed for yet is not
   * missed. Returns the rows + whether they are anchored (drives scoring).
   */
  private async ldaCandidates(
    clientName: string,
    clientFp: string,
    ldaRegistrantId: number | null | undefined,
  ): Promise<{ rows: MatchRow[]; anchored: boolean }> {
    if (ldaRegistrantId != null) {
      const rows = await this.matchLdaByRegistrant(clientName, ldaRegistrantId);
      const usable = rows.some(
        (r) =>
          (clientFp.length > 0 && clientFp === this.fingerprint(r.external_name)) ||
          r.similarity >= 0.4,
      );
      if (usable) return { rows, anchored: true };
    }
    return { rows: await this.matchLda(clientName), anchored: false };
  }

  /**
   * Contractor candidates, TIERED.
   *
   * Two pools are unioned in one query, deliberately:
   *
   *   - the EXACT-UEI pool, which the name-similarity floor would otherwise
   *     exclude entirely. "RTX CORPORATION" and "RAYTHEON TECHNOLOGIES
   *     CORPORATION" are the same registered entity and their trigram similarity
   *     is far below 0.3, so the only way the identifier match is ever seen is by
   *     querying for it directly;
   *   - the name pool, which is what surfaces candidates for a client with no UEI
   *     on file.
   *
   * The verdicts then come from decideContractorCandidates over the WHOLE set,
   * because ambiguity is a property of the set: one exact-UEI hit is
   * unambiguous, two rows sharing that UEI are not, and neither is judgeable
   * alone.
   */
  private async matchContractor(
    clientName: string,
    identity: { clientId: string; uei: string | null; cageCode: string | null; website: string | null; states: string[] },
    alreadyConfirmedByContractorId: Map<string, string[]>,
  ): Promise<MatchRow[]> {
    const uei = (identity.uei ?? '').trim().toUpperCase();
    const ueiUsable = /^[A-Z0-9]{12}$/.test(uei);

    const rows = await this.prisma.$queryRaw<
      Array<{
        external_id: string;
        external_name: string;
        similarity: number;
        uei: string | null;
        total_contracts: number | null;
        last_synced_at: Date | null;
      }>
    >`
      SELECT id::text AS external_id,
             name AS external_name,
             similarity(name, ${clientName}) AS similarity,
             uei,
             total_contracts::float AS total_contracts,
             last_synced_at
      FROM federal_contractor
      WHERE similarity(name, ${clientName}) > 0.3
         OR (${ueiUsable} AND uei = ${ueiUsable ? uei : null})
      ORDER BY similarity DESC
      LIMIT 50
    `;

    const candidates: ContractorCandidate[] = rows.map((r) => ({
      contractorId: r.external_id,
      contractorName: r.external_name,
      uei: r.uei,
      nameSimilarity: Number(r.similarity ?? 0),
      // federal_contractor stores an obligation TOTAL, not an award count or a
      // latest-award date. Reported as null rather than 0 or "unknown date":
      // null means "we hold no figure", and 0 would read as "this contractor has
      // never been awarded anything", which is a different and false claim.
      awardCount: null,
      totalObligated: r.total_contracts,
      latestAwardDate: null,
      sourceSyncedAt: r.last_synced_at ? r.last_synced_at.toISOString() : null,
      alreadyConfirmedForClientIds: alreadyConfirmedByContractorId.get(r.external_id) ?? [],
    }));

    const verdicts = decideContractorCandidates(
      {
        clientId: identity.clientId,
        clientName,
        uei: identity.uei,
        cageCode: identity.cageCode,
        domains: [domainOf(identity.website)].filter((d): d is string => d != null),
        states: identity.states,
      },
      candidates,
      (name) => this.fingerprint(name),
    );

    return verdicts.map((v) => ({
      external_id: v.contractorId,
      external_name: v.contractorName,
      similarity: v.confidence,
      state: null,
      // The tiering policy owns the confidence for this source, so the name
      // heuristics in scoreCandidate are bypassed entirely.
      preScored: v.confidence,
      matchBasis: v.explanation.basis,
      matchTier: v.explanation.tier,
      matchEvidence: v.explanation,
      autoConfirmEligible: v.autoConfirmEligible,
    }));
  }

  /**
   * Which clients each contractor row is ALREADY confirmed against, in this
   * tenant. One query for the whole tenant, not one per candidate — the
   * ambiguity check needs it for every candidate of every client.
   */
  private async confirmedContractorClaims(tenantId: string): Promise<Map<string, string[]>> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientIntelMapping.findMany({
        where: { source: 'contracting', confirmed: true },
        select: { externalId: true, clientId: true },
      }),
    );
    const out = new Map<string, string[]>();
    for (const r of rows) {
      const list = out.get(r.externalId) ?? [];
      list.push(r.clientId);
      out.set(r.externalId, list);
    }
    return out;
  }

  private async matchSec(clientName: string): Promise<MatchRow[]> {
    return this.prisma.$queryRaw<MatchRow[]>`
      SELECT DISTINCT ON (cik) cik AS external_id, company_name AS external_name,
             similarity(company_name, ${clientName}) AS similarity,
             state_of_incorp AS state
      FROM sec_filing
      WHERE similarity(company_name, ${clientName}) > 0.3
      ORDER BY cik, similarity(company_name, ${clientName}) DESC
      LIMIT 50
    `;
  }

  private async matchFec(clientName: string): Promise<MatchRow[]> {
    return this.prisma.$queryRaw<MatchRow[]>`
      SELECT contributor_employer AS external_id,
             contributor_employer AS external_name,
             similarity(contributor_employer, ${clientName}) AS similarity,
             NULL::text AS state
      FROM (SELECT DISTINCT contributor_employer FROM fec_contribution WHERE contributor_employer IS NOT NULL) t
      WHERE similarity(contributor_employer, ${clientName}) > 0.3
      ORDER BY similarity DESC
      LIMIT 50
    `;
  }

  /**
   * Match a client to its OWN PAC committee (FecCommittee). PAC names are noisy
   * ("BOEING COMPANY PAC", "EMPLOYEES OF X POLITICAL ACTION COMMITTEE"), so we
   * strip PAC-specific noise words before scoring. Source 'fec_committee' powers
   * the Schedule B PAC-giving sync; because attributing an org's PAC is compliance-
   * sensitive, these are scored conservatively and NEVER auto-confirmed (see
   * scoreCommittee) — a human must confirm in the mappings review UI.
   */
  private async matchFecCommittee(clientName: string): Promise<MatchRow[]> {
    return this.prisma.$queryRaw<MatchRow[]>`
      SELECT id AS external_id,
             name AS external_name,
             similarity(
               regexp_replace(
                 lower(name),
                 '\\m(pac|political action committee|employees?|company|corp|inc|fund|for|of|the)\\M',
                 ' ', 'g'
               ),
               lower(${clientName})
             ) AS similarity,
             state
      FROM fec_committee
      WHERE committee_type IN ('Q', 'N', 'O', 'V', 'W')  -- PAC-type committees
        AND similarity(
              regexp_replace(
                lower(name),
                '\\m(pac|political action committee|employees?|company|corp|inc|fund|for|of|the)\\M',
                ' ', 'g'
              ),
              lower(${clientName})
            ) > 0.35
      ORDER BY similarity DESC
      LIMIT 25
    `;
  }

  private async matchFara(clientName: string): Promise<MatchRow[]> {
    return this.prisma.$queryRaw<MatchRow[]>`
      SELECT registration_number AS external_id, registrant_name AS external_name,
             similarity(registrant_name, ${clientName}) AS similarity,
             state
      FROM fara_registration
      WHERE similarity(registrant_name, ${clientName}) > 0.3
      ORDER BY similarity DESC
      LIMIT 50
    `;
  }

  private async matchLobbyIntel(clientName: string): Promise<MatchRow[]> {
    return this.prisma.$queryRaw<MatchRow[]>`
      SELECT id::text AS external_id, name AS external_name,
             similarity(name, ${clientName}) AS similarity,
             state
      FROM lobby_intel_mv
      WHERE similarity(name, ${clientName}) > 0.3
      ORDER BY similarity DESC
      LIMIT 50
    `;
  }

  /**
   * Fuzzy client-name-to-recipient-name candidates for District Nexus
   * (source 'assistance_recipient'). federal_assistance_award is a flat
   * award fact table, not a recipient dimension table, so recipients are
   * grouped on the fly (by UEI when present, else by name) before scoring.
   * externalId is the recipient UEI when available, else the recipient name
   * — matching how a manual pin from the search endpoint would key it.
   * Always routed to human review (see candidateDecision) — never auto-
   * confirmed from name similarity alone. As of the 2026-07-27 remediation,
   * scoreCandidate also caps any non-fingerprint-exact row from this source
   * below the write floor (see NON_DISTINCTIVE_MATCH_CAP) — this SQL's job is
   * now just to surface the pool; scoreCandidate decides almost none of it is
   * trustworthy enough to write. See matchAssistanceRecipientByUei for the
   * higher-precision identifier-based path.
   */
  private async matchAssistanceRecipient(clientName: string): Promise<MatchRow[]> {
    return this.prisma.$queryRaw<MatchRow[]>`
      SELECT COALESCE(MAX(recipient_uei), MAX(recipient_name)) AS external_id,
             MAX(recipient_name) AS external_name,
             MAX(sim) AS similarity,
             MAX(recipient_state) AS state
      FROM (
        SELECT recipient_uei, recipient_name, recipient_state,
               similarity(lower(recipient_name), lower(${clientName})) AS sim
        FROM federal_assistance_award
        WHERE recipient_name IS NOT NULL
          -- The % operator is what actually reaches faa_recipient_name_trgm_idx
          -- (gin on lower(recipient_name)); a bare similarity(...) > c is a
          -- plain function call and would seq-scan the largest new table. The
          -- expression must be spelled lower(recipient_name) to match the
          -- functional index. % cuts at pg_trgm.similarity_threshold (0.3 by
          -- default), so the explicit > 0.3 below is the same bar, kept as the
          -- authoritative one in case the GUC is ever changed server-side.
          -- (No backticks in here: this is a JS template literal.)
          AND lower(recipient_name) % lower(${clientName})
          AND similarity(lower(recipient_name), lower(${clientName})) > 0.3
      ) matched
      GROUP BY COALESCE(recipient_uei, recipient_name)
      ORDER BY similarity DESC
      LIMIT 50
    `;
  }

  // A client UEI is exactly 12 alphanumeric characters (SAM.gov format) — same
  // shape the manual-attach search endpoint already validates against.
  private static readonly UEI_RE = /^[A-Z0-9]{12}$/i;

  /**
   * Exact Client.uei ↔ federal_assistance_award.recipient_uei candidates —
   * the "-or-UEI" half of District Nexus Rev 2's assistance-matcher
   * remediation. A UEI is a verified, globally-unique federal identifier, so
   * this needs no name-similarity scoring at all: every row it returns is
   * pre-scored at ASSISTANCE_RECIPIENT_UEI_MATCH_CONFIDENCE (see MatchRow.
   * preScored) and skips scoreCandidate's name-fingerprint heuristics, which
   * would otherwise judge a legal-entity-name mismatch (e.g. client "RTX
   * Corporation" vs recipient "RAYTHEON TECHNOLOGIES CORPORATION") as a weak
   * match despite the identifier match being certain. recipient_uei is
   * indexed (faa_recipient_uei_idx), so this is a fast equality lookup, not a
   * trigram scan.
   */
  private async matchAssistanceRecipientByUei(clientUei: string): Promise<MatchRow[]> {
    if (!EntityResolutionService.UEI_RE.test(clientUei)) return [];
    const rows = await this.prisma.$queryRaw<
      Array<{ external_id: string; external_name: string; state: string | null }>
    >`
      SELECT recipient_uei AS external_id,
             MAX(recipient_name) AS external_name,
             MAX(recipient_state) AS state
      FROM federal_assistance_award
      WHERE recipient_uei = upper(${clientUei})
      GROUP BY recipient_uei
    `;
    return rows.map((r) => ({
      ...r,
      similarity: 1,
      preScored: ASSISTANCE_RECIPIENT_UEI_MATCH_CONFIDENCE,
    }));
  }

  // ── Public: resolve a single client ──────────────────────────────────────

  async resolveClient(
    clientId: string,
    tenantId: string,
    clientName: string,
    opts?: {
      ldaRegistrantId?: number | null;
      clientUei?: string | null;
      clientCageCode?: string | null;
      clientWebsite?: string | null;
      clientStates?: string[];
      /**
       * Pre-computed tenant-wide confirmed contractor claims. Passed in by
       * resolveAllForTenant so a whole-tenant sweep reads them ONCE rather than
       * once per client; omitted on a single-client call, which reads them itself.
       */
      confirmedContractorClaims?: Map<string, string[]>;
    },
  ): Promise<{ created: number; autoConfirmed: number; needsReview: number }> {
    const clientFp = this.fingerprint(clientName);
    const claims =
      opts?.confirmedContractorClaims ?? (await this.confirmedContractorClaims(tenantId));

    // LDA uses the registrant-anchored pool when available (falls back to global);
    // the other sources stay on the global fuzzy pool.
    const lda = await this.ldaCandidates(clientName, clientFp, opts?.ldaRegistrantId);
    const [
      contractorRows,
      secRows,
      fecRows,
      fecCommitteeRows,
      faraRows,
      lobbyRows,
      assistanceNameRows,
      assistanceUeiRows,
    ] = await Promise.all([
      this.matchContractor(
        clientName,
        {
          clientId,
          uei: opts?.clientUei ?? null,
          cageCode: opts?.clientCageCode ?? null,
          website: opts?.clientWebsite ?? null,
          states: opts?.clientStates ?? [],
        },
        claims,
      ),
      this.matchSec(clientName),
      this.matchFec(clientName),
      this.matchFecCommittee(clientName),
      this.matchFara(clientName),
      this.matchLobbyIntel(clientName),
      this.matchAssistanceRecipient(clientName),
      opts?.clientUei ? this.matchAssistanceRecipientByUei(opts.clientUei) : Promise.resolve([]),
    ]);

    const groups: Array<{ source: string; rows: MatchRow[]; anchored: boolean }> = [
      { source: 'lda', rows: lda.rows, anchored: lda.anchored },
      { source: 'contracting', rows: contractorRows, anchored: false },
      { source: 'sec', rows: secRows, anchored: false },
      { source: 'fec_employer', rows: fecRows, anchored: false },
      { source: 'fec_committee', rows: fecCommitteeRows, anchored: false },
      { source: 'fara', rows: faraRows, anchored: false },
      { source: 'lobby_intel', rows: lobbyRows, anchored: false },
      // UEI rows first: when both paths find the same recipient, persistSourceCandidates
      // sorts by confidence before upserting, but listing the higher-trust rows first
      // keeps this readable regardless.
      { source: 'assistance_recipient', rows: [...assistanceUeiRows, ...assistanceNameRows], anchored: false },
    ];

    let created = 0;
    let autoConfirmed = 0;
    let needsReview = 0;
    for (const { source, rows, anchored } of groups) {
      const r = await this.persistSourceCandidates(clientId, tenantId, source, rows, clientFp, anchored);
      created += r.created;
      autoConfirmed += r.autoConfirmed;
      needsReview += r.needsReview;
    }
    return { created, autoConfirmed, needsReview };
  }

  // ── Public: contractor identity review surface ───────────────────────────

  /**
   * Candidate contractor identities for ONE client, with the full explanation and
   * whichever mapping row already exists for each.
   *
   * This is what makes the client-scoped settings flow usable: arriving from a
   * profile CTA, the reviewer sees this client's candidates immediately, each
   * carrying its basis, tier, exact identifiers, corroborators and — the part a
   * confidence percentage can never convey — its CONFLICTING facts.
   *
   * READ-ONLY. It writes nothing, so it is safe on page load. That matters: the
   * only pre-existing way to see contractor candidates was to press a button that
   * wrote mappings for every client in the tenant.
   */
  async contractorCandidatesForClient(
    tenantId: string,
    clientId: string,
  ): Promise<ContractorCandidateView> {
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({
        where: { id: clientId },
        select: {
          id: true,
          name: true,
          uei: true,
          cageCode: true,
          website: true,
          facilities: { select: { state: true } },
        },
      }),
    );
    if (!client) throw new NotFoundException('Client not found');

    const existing = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientIntelMapping.findMany({
        where: { clientId, source: 'contracting' },
        select: {
          id: true,
          externalId: true,
          confirmed: true,
          matchBasis: true,
          matchTier: true,
          relationshipType: true,
          rollUpAwards: true,
        },
      }),
    );
    const byExternalId = new Map(existing.map((m) => [m.externalId, m]));

    const claims = await this.confirmedContractorClaims(tenantId);
    const rows = await this.matchContractor(
      client.name,
      {
        clientId: client.id,
        uei: client.uei,
        cageCode: client.cageCode,
        website: client.website,
        states: client.facilities
          .map((f) => f.state)
          .filter((s): s is string => s != null && s.length > 0),
      },
      claims,
    );

    return {
      client: {
        id: client.id,
        name: client.name,
        uei: client.uei,
        cageCode: client.cageCode,
      },
      candidates: rows
        .map((r) => {
          const mapping = byExternalId.get(r.external_id);
          return {
            contractorId: r.external_id,
            contractorName: r.external_name,
            confidence: r.similarity,
            autoConfirmEligible: r.autoConfirmEligible === true,
            matchBasis: r.matchBasis ?? 'fuzzy_name',
            matchTier: r.matchTier ?? 4,
            explanation: r.matchEvidence ?? null,
            mapping: mapping
              ? {
                  id: mapping.id,
                  confirmed: mapping.confirmed,
                  // A pre-existing row's basis was never recorded. Reported as
                  // 'legacy_unrecorded' rather than back-filled with a guess.
                  matchBasis: mapping.matchBasis ?? 'legacy_unrecorded',
                  matchTier: mapping.matchTier ?? null,
                  relationshipType: mapping.relationshipType ?? null,
                  rollUpAwards: mapping.rollUpAwards ?? null,
                }
              : null,
          };
        })
        .sort((a, b) => b.confidence - a.confidence),
    };
  }

  /**
   * "Find exact identifier matches" — the safe automatic action.
   *
   * Runs the contractor tiering for every client in the tenant and persists the
   * candidates, auto-confirming ONLY an unambiguous tier-1 identifier match. No
   * fuzzy name can be confirmed by it, by construction, because
   * {@link candidateDecision} consults the tier rather than the score for this
   * source.
   *
   * This is the narrow, defensible half of "Resolve All Clients": that action
   * still exists and still covers every source, but neither can auto-confirm a
   * contractor name any more.
   */
  async resolveContractorIdentifiersForTenant(tenantId: string): Promise<ResolutionSummary> {
    const clients = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findMany({
        select: {
          id: true,
          name: true,
          uei: true,
          cageCode: true,
          website: true,
          facilities: { select: { state: true } },
        },
      }),
    );
    // Read ONCE for the sweep, not per client.
    const claims = await this.confirmedContractorClaims(tenantId);

    let mappingsCreated = 0;
    let autoConfirmed = 0;
    let needsReview = 0;
    for (const client of clients) {
      const rows = await this.matchContractor(
        client.name,
        {
          clientId: client.id,
          uei: client.uei,
          cageCode: client.cageCode,
          website: client.website,
          states: client.facilities
            .map((f) => f.state)
            .filter((s): s is string => s != null && s.length > 0),
        },
        claims,
      );
      const r = await this.persistSourceCandidates(
        client.id,
        tenantId,
        'contracting',
        rows,
        this.fingerprint(client.name),
      );
      mappingsCreated += r.created;
      autoConfirmed += r.autoConfirmed;
      needsReview += r.needsReview;
    }

    this.logger.log(
      `resolveContractorIdentifiersForTenant(${tenantId}): ${clients.length} clients, ` +
        `${mappingsCreated} mappings, ${autoConfirmed} auto-confirmed (tier-1 identifiers only)`,
    );
    return { totalClients: clients.length, mappingsCreated, autoConfirmed, needsReview };
  }

  // ── Public: resolve all clients for a tenant ──────────────────────────────

  async resolveAllForTenant(tenantId: string): Promise<ResolutionSummary> {
    // Read the firm's LDA registrant anchor + its clients under tenant scope.
    const { ldaRegistrantId, clients } = await this.prisma.withTenant(tenantId, async (tx) => ({
      ldaRegistrantId:
        (
          await tx.tenant.findUnique({
            where: { id: tenantId },
            select: { ldaRegistrantId: true },
          })
        )?.ldaRegistrantId ?? null,
      clients: await tx.client.findMany({
        select: {
          id: true,
          name: true,
          uei: true,
          cageCode: true,
          website: true,
          facilities: { select: { state: true } },
        },
      }),
    }));

    // Read ONCE for the whole sweep. Reading per client would be an N+1 over a
    // table that grows with every confirmed mapping.
    const claims = await this.confirmedContractorClaims(tenantId);

    let mappingsCreated = 0;
    let autoConfirmed = 0;
    let needsReview = 0;

    for (const client of clients) {
      const result = await this.resolveClient(client.id, tenantId, client.name, {
        ldaRegistrantId,
        clientUei: client.uei,
        clientCageCode: client.cageCode,
        clientWebsite: client.website,
        clientStates: client.facilities
          .map((f) => f.state)
          .filter((s): s is string => s != null && s.length > 0),
        confirmedContractorClaims: claims,
      });
      mappingsCreated += result.created;
      autoConfirmed += result.autoConfirmed;
      needsReview += result.needsReview;
    }

    this.logger.log(
      `resolveAllForTenant(${tenantId}): ${clients.length} clients, ${mappingsCreated} mappings, ` +
        `${autoConfirmed} auto-confirmed` +
        (ldaRegistrantId != null ? ` (registrant-anchored: ${ldaRegistrantId})` : ' (global fuzzy)'),
    );

    return {
      totalClients: clients.length,
      mappingsCreated,
      autoConfirmed,
      needsReview,
    };
  }
}
