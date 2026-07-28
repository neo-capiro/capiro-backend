import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

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
}

export interface ResolutionSummary {
  totalClients: number;
  mappingsCreated: number;
  autoConfirmed: number;
  needsReview: number;
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
}): CandidateDecision {
  const { source, confidence, isTopForSource, runnerUpConfidence } = params;
  const NEVER_AUTO_CONFIRM = new Set(['fec_committee', 'assistance_recipient']);
  const clearWinner =
    runnerUpConfidence === null ||
    confidence - runnerUpConfidence >= AUTO_CONFIRM_AMBIGUITY_MARGIN;
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
      });
      if (decision === 'skip') continue;
      const autoConfirm = decision === 'auto_confirm';

      const updateData: { externalName: string; confidence: number; confirmed?: boolean } = {
        externalName: cand.externalName,
        confidence: cand.confidence,
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

  private async matchContractor(clientName: string): Promise<MatchRow[]> {
    return this.prisma.$queryRaw<MatchRow[]>`
      SELECT id::text AS external_id, name AS external_name,
             similarity(name, ${clientName}) AS similarity,
             NULL::text AS state
      FROM federal_contractor
      WHERE similarity(name, ${clientName}) > 0.3
      ORDER BY similarity DESC
      LIMIT 50
    `;
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
    opts?: { ldaRegistrantId?: number | null; clientUei?: string | null },
  ): Promise<{ created: number; autoConfirmed: number; needsReview: number }> {
    const clientFp = this.fingerprint(clientName);

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
      this.matchContractor(clientName),
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
      clients: await tx.client.findMany({ select: { id: true, name: true, uei: true } }),
    }));

    let mappingsCreated = 0;
    let autoConfirmed = 0;
    let needsReview = 0;

    for (const client of clients) {
      const result = await this.resolveClient(client.id, tenantId, client.name, {
        ldaRegistrantId,
        clientUei: client.uei,
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
