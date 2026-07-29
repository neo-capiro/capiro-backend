/**
 * Federal contractor identity — the tiered decision about whether a
 * `federal_contractor` row IS a client, and what evidence says so.
 *
 * Pure and I/O-free so the policy is testable without a database, and so the
 * offline producer (`match-contractor-identifiers.ts`) reaches exactly the same
 * verdict as the request path. A second copy of this logic would drift, and the
 * thing it would drift into is silently confirming the wrong company.
 *
 * ── The failure this exists to prevent ──────────────────────────────────────
 *
 * The pre-existing contractor matcher was name-similarity only. A trigram score
 * over `federal_contractor.name` reached the auto-confirm threshold for any pair
 * of names that merely LOOKED alike, and a confirmed mapping is not cosmetic —
 * it is what the award footprint, the agency-history relevance signals and the
 * District Nexus obligation rails all read. The same class of error on the
 * assistance side produced 173 wrong candidates out of 183 live, several with
 * $B+ obligated attached (2026-07-27 remediation). Nothing structural stopped
 * the contractor side from doing the same thing.
 *
 * So: a name, however similar, is never sufficient to CONFIRM an identity. Only
 * an exact, globally-unique federal identifier is, and only when it is
 * unambiguous. Everything else is a candidate for a human.
 *
 * ── The identity gap this makes explicit ────────────────────────────────────
 *
 * A federal award may name a subsidiary, a legal entity, a historical name, a
 * parent or an operating unit that is not the CRM client's display name.
 * "RAYTHEON TECHNOLOGIES CORPORATION" and "RTX CORPORATION" are the same company
 * and share no distinctive token; "Santa Rosa County" and "Santa Clara County"
 * are different entities and share two. Name similarity has no access to that
 * distinction. `relationshipType` on the mapping is where the answer lives, and
 * only a human puts it there.
 */

/**
 * Why a candidate exists. Ordered strongest-first.
 *
 * `exact_cage` is declared but NOT REACHABLE from `federal_contractor` today:
 * that table carries `uei` and `recipientId` and no CAGE code (its source, the
 * openspending/USAspending top-contractor dataset, does not publish one — see
 * sync-openspending.ts). `Client.cageCode` IS populated, by SAM Entity-Management
 * enrichment, so the client half of a CAGE comparison exists and the source half
 * does not. The value is kept in the vocabulary because the gap is a data gap
 * with a known fix (see docs/funding-opportunities/data-gap-audit.md), not a
 * policy question — and because inventing a second vocabulary later would be
 * worse than declaring the value now.
 */
export const CONTRACTOR_MATCH_BASES = [
  'exact_uei',
  'exact_cage',
  'exact_legal_name_corroborated',
  'exact_legal_name',
  'fuzzy_name',
  'manual_pin',
  'legacy_unrecorded',
] as const;
export type ContractorMatchBasis = (typeof CONTRACTOR_MATCH_BASES)[number];

/**
 * 1 — exact verified identifier (UEI, CAGE, or a source record a human picked).
 * 2 — exact normalized legal name, with or without corroboration.
 * 3 — alias / former name / parent / subsidiary: a reviewed corporate relationship.
 * 4 — fuzzy name.
 */
export type IdentityTier = 1 | 2 | 3 | 4;

export const MATCH_BASIS_TIER: Readonly<Record<ContractorMatchBasis, IdentityTier>> = Object.freeze({
  exact_uei: 1,
  exact_cage: 1,
  manual_pin: 1,
  exact_legal_name_corroborated: 2,
  exact_legal_name: 2,
  fuzzy_name: 4,
  // A legacy row's basis was never recorded. Treated as the WEAKEST tier so no
  // decision is ever made on its behalf — the honest position for evidence
  // nobody wrote down.
  legacy_unrecorded: 4,
});

/** A corroborating fact, beyond the name, that the two records are one entity. */
export type Corroborator = 'uei' | 'cage' | 'domain' | 'state' | 'reviewed_alias' | 'reviewed_relationship';

export interface ClientIdentity {
  clientId: string;
  clientName: string;
  /** `Client.uei`. */
  uei: string | null;
  /** `Client.cageCode`. */
  cageCode: string | null;
  /** Registrable domains from `Client.website`. */
  domains: string[];
  /** `ClientFacility.state` values. */
  states: string[];
}

export interface ContractorCandidate {
  /** `federal_contractor.id` (uuid) — the externalId a mapping pins. */
  contractorId: string;
  contractorName: string;
  /** `federal_contractor.uei`. Null on most rows: the source back-fills it by name. */
  uei: string | null;
  /** Trigram similarity between the two names, 0..1. */
  nameSimilarity: number;
  /** Award footprint, for the explanation. Null = not held, never 0. */
  awardCount: number | null;
  totalObligated: number | null;
  latestAwardDate: string | null;
  /** `federal_contractor.last_synced_at`. */
  sourceSyncedAt: string | null;
  /**
   * Other clients ALREADY confirmed against this same contractor row, in this
   * tenant. A contractor mapped elsewhere is not automatically wrong — a parent
   * legitimately maps to several client records — but it is never unambiguous.
   */
  alreadyConfirmedForClientIds: string[];
}

/** The full, human-checkable explanation. No bare confidence percentage. */
export interface MatchExplanation {
  basis: ContractorMatchBasis;
  tier: IdentityTier;
  /** Identifiers that matched EXACTLY, e.g. `{ uei: 'ABC123456789' }`. */
  exactIdentifiers: Record<string, string>;
  normalizedClientName: string;
  normalizedCandidateName: string;
  corroborators: Corroborator[];
  /** Facts that argue AGAINST the match. Never omitted to make a match look better. */
  conflicts: string[];
  awardCount: number | null;
  totalObligated: number | null;
  latestAwardDate: string | null;
  sourceSyncedAt: string | null;
}

export interface ContractorVerdict {
  contractorId: string;
  contractorName: string;
  explanation: MatchExplanation;
  /** 0..1, for ORDERING the review queue. Never the reason for a decision. */
  confidence: number;
  /**
   * TRUE only for an unambiguous tier-1 identifier match. Every other outcome —
   * including an exact legal-name match — is a candidate for a human.
   */
  autoConfirmEligible: boolean;
  /** Present whenever `autoConfirmEligible` is false, for the review queue. */
  reviewReason: string | null;
}

const UEI_RE = /^[A-Z0-9]{12}$/;
const CAGE_RE = /^[A-Z0-9]{5}$/;

/**
 * Confidence assigned to an exact-UEI contractor match. Deliberately below 1.0,
 * which is reserved for a human's deliberate pin through the manual-attach
 * endpoint: a person choosing a specific record is the only thing in this system
 * that is certain by construction.
 */
export const UEI_MATCH_CONFIDENCE = 0.98;
/** Exact normalized legal name, corroborated by a second non-name fact. */
export const EXACT_NAME_CORROBORATED_CONFIDENCE = 0.9;
/** Exact normalized legal name, nothing else. Ordering only — never auto-confirms. */
export const EXACT_NAME_CONFIDENCE = 0.75;

/**
 * The best candidate must beat the runner-up by at least this much to be called
 * unambiguous. Mirrors AUTO_CONFIRM_AMBIGUITY_MARGIN in entity-resolution.service.ts
 * — the same idea, applied to identifier matches rather than name scores.
 */
export const AMBIGUITY_MARGIN = 0.05;

export function normalizeUei(v: string | null | undefined): string | null {
  const s = (v ?? '').trim().toUpperCase();
  return UEI_RE.test(s) ? s : null;
}

export function normalizeCage(v: string | null | undefined): string | null {
  const s = (v ?? '').trim().toUpperCase();
  return CAGE_RE.test(s) ? s : null;
}

/**
 * Registrable-ish domain from a website URL. Deliberately crude — it exists to
 * be a CORROBORATOR, not an identifier, so a false negative costs a review and a
 * false positive costs nothing on its own (a corroborator never confirms alone).
 */
export function domainOf(website: string | null | undefined): string | null {
  const raw = (website ?? '').trim().toLowerCase();
  if (!raw) return null;
  const m = /^(?:https?:\/\/)?(?:www\.)?([a-z0-9.-]+\.[a-z]{2,})/.exec(raw);
  return m?.[1] ?? null;
}

/**
 * Decide every candidate for one client, together.
 *
 * TOGETHER is the point: ambiguity is a property of the SET, not of a candidate.
 * A single exact-UEI hit is unambiguous; two rows sharing that UEI are not, and
 * neither is judgeable in isolation. Scoring candidates one at a time is how a
 * matcher confirms one of two identical-looking companies.
 *
 * @param fingerprint the shared name normalizer — passed in rather than imported
 *        so this module stays dependency-free AND so it is impossible for the
 *        service and this policy to normalize names differently.
 */
export function decideContractorCandidates(
  client: ClientIdentity,
  candidates: ContractorCandidate[],
  fingerprint: (name: string) => string,
): ContractorVerdict[] {
  const clientUei = normalizeUei(client.uei);
  const clientCage = normalizeCage(client.cageCode);
  const clientFp = fingerprint(client.clientName);
  const clientDomains = new Set(client.domains.map((d) => d.toLowerCase()).filter(Boolean));

  // How many candidates each identifier / normalized name resolves to. Computed
  // over the whole set BEFORE any verdict, because that count is the ambiguity.
  const ueiCounts = new Map<string, number>();
  const fpCounts = new Map<string, number>();
  for (const c of candidates) {
    const u = normalizeUei(c.uei);
    if (u) ueiCounts.set(u, (ueiCounts.get(u) ?? 0) + 1);
    const fp = fingerprint(c.contractorName);
    fpCounts.set(fp, (fpCounts.get(fp) ?? 0) + 1);
  }

  const verdicts: ContractorVerdict[] = candidates.map((c) => {
    const candidateUei = normalizeUei(c.uei);
    const candidateFp = fingerprint(c.contractorName);
    const conflicts: string[] = [];
    const corroborators: Corroborator[] = [];
    const exactIdentifiers: Record<string, string> = {};

    // ── Conflicts, gathered before the basis so they can veto it ────────────
    if (client.uei && !clientUei) {
      conflicts.push(
        `The client's stored UEI "${client.uei}" is not a valid 12-character UEI, so it cannot be used to verify identity.`,
      );
    }
    if (clientUei && candidateUei && clientUei !== candidateUei) {
      conflicts.push(
        `UEIs disagree: client ${clientUei} vs contractor ${candidateUei}. These are different registered entities.`,
      );
    }
    if (clientUei && !candidateUei) {
      conflicts.push(
        'This contractor record carries no UEI, so the client’s UEI cannot confirm it.',
      );
    }
    if (fpCounts.get(candidateFp)! > 1) {
      conflicts.push(
        `${fpCounts.get(candidateFp)} contractor records normalize to the same name "${candidateFp}" — possibly a parent and a subsidiary.`,
      );
    }
    if (candidateUei && ueiCounts.get(candidateUei)! > 1) {
      conflicts.push(
        `${ueiCounts.get(candidateUei)} contractor records share UEI ${candidateUei}, which should be unique.`,
      );
    }
    const otherClients = c.alreadyConfirmedForClientIds.filter((id) => id !== client.clientId);
    if (otherClients.length > 0) {
      conflicts.push(
        `Already confirmed for ${otherClients.length} other client record(s) in this tenant; the corporate relationship between them is not recorded.`,
      );
    }

    // ── Corroborators ──────────────────────────────────────────────────────
    if (clientUei && candidateUei && clientUei === candidateUei) {
      corroborators.push('uei');
      exactIdentifiers.uei = clientUei;
    }
    if (clientCage) {
      // Recorded as a client-side fact only. There is no contractor-side CAGE to
      // compare against (see CONTRACTOR_MATCH_BASES), so this is NOT pushed as a
      // corroborator — doing so would let a fact about one side alone corroborate
      // a match, which is not what corroboration means.
      exactIdentifiers.clientCage = clientCage;
    }
    if (clientDomains.size > 0) {
      const candidateDomain = domainOf(c.contractorName);
      if (candidateDomain && clientDomains.has(candidateDomain)) corroborators.push('domain');
    }

    // ── Basis ──────────────────────────────────────────────────────────────
    const ueiMatch = corroborators.includes('uei');
    const nameExact = clientFp.length > 0 && clientFp === candidateFp;
    // A single-token exact fingerprint can collapse genuinely different firms
    // after suffix stripping ("Apple" vs "Apple Inc" vs an unrelated "Apple
    // Group"), so it is not treated as an exact legal-name match at all.
    const nameExactMultiToken = nameExact && clientFp.includes(' ');
    const nonNameCorroborators = corroborators.filter((x) => x !== 'uei');

    let basis: ContractorMatchBasis;
    let confidence: number;
    if (ueiMatch) {
      basis = 'exact_uei';
      confidence = UEI_MATCH_CONFIDENCE;
    } else if (nameExactMultiToken && nonNameCorroborators.length > 0) {
      basis = 'exact_legal_name_corroborated';
      confidence = EXACT_NAME_CORROBORATED_CONFIDENCE;
    } else if (nameExactMultiToken) {
      basis = 'exact_legal_name';
      confidence = EXACT_NAME_CONFIDENCE;
    } else {
      basis = 'fuzzy_name';
      confidence = Math.min(c.nameSimilarity, 0.7);
    }

    const tier = MATCH_BASIS_TIER[basis];

    // ── Auto-confirm ───────────────────────────────────────────────────────
    //
    // Tier 1 ONLY, and only when nothing in the set makes it ambiguous. An exact
    // legal-name match — even corroborated — routes to review: the policy does
    // NOT permit tier-2 auto-confirm, because the corroborators available from
    // `federal_contractor` today are too thin to distinguish a parent from a
    // subsidiary with the same registered name.
    let autoConfirmEligible = false;
    let reviewReason: string | null = null;

    if (tier !== 1) {
      reviewReason =
        basis === 'fuzzy_name'
          ? 'Name similarity only. A fuzzy name match is never confirmed automatically — it can pin the wrong company, and a confirmed identity drives award attribution.'
          : 'Exact legal name, but no verified identifier. A parent and a subsidiary can share a registered name, so a human decides.';
    } else if (conflicts.length > 0) {
      reviewReason = `Identifier matched, but there are conflicting facts: ${conflicts[0]}`;
    } else if (candidateUei && ueiCounts.get(candidateUei) !== 1) {
      reviewReason = 'The matched UEI resolves to more than one contractor record.';
    } else {
      autoConfirmEligible = true;
    }

    return {
      contractorId: c.contractorId,
      contractorName: c.contractorName,
      explanation: {
        basis,
        tier,
        exactIdentifiers,
        normalizedClientName: clientFp,
        normalizedCandidateName: candidateFp,
        corroborators,
        conflicts,
        awardCount: c.awardCount,
        totalObligated: c.totalObligated,
        latestAwardDate: c.latestAwardDate,
        sourceSyncedAt: c.sourceSyncedAt,
      },
      confidence,
      autoConfirmEligible,
      reviewReason,
    };
  });

  // ── Set-level ambiguity: a near-tied runner-up ───────────────────────────
  //
  // Applied after the per-candidate pass because it is a comparison BETWEEN
  // verdicts. Two candidates within AMBIGUITY_MARGIN of each other are not
  // distinguishable by this system, so neither auto-confirms — including the one
  // that happens to be a hair ahead.
  const ordered = [...verdicts].sort((a, b) => b.confidence - a.confidence);
  const top = ordered[0];
  const runnerUp = ordered[1];
  if (top && runnerUp && top.confidence - runnerUp.confidence < AMBIGUITY_MARGIN) {
    for (const v of [top, runnerUp]) {
      if (v.autoConfirmEligible) {
        v.autoConfirmEligible = false;
        v.reviewReason = `Another candidate scores within ${AMBIGUITY_MARGIN} of this one (“${
          v === top ? runnerUp.contractorName : top.contractorName
        }”), so the match is not unambiguous.`;
      }
    }
  }

  // Only ONE candidate per client may auto-confirm. Two confirmed contractor
  // identities would double-count the same client's obligations if both resolve
  // to overlapping award sets, and nothing downstream deduplicates that.
  let confirmedOne = false;
  for (const v of ordered) {
    if (!v.autoConfirmEligible) continue;
    if (confirmedOne) {
      v.autoConfirmEligible = false;
      v.reviewReason =
        'Another candidate for this client already auto-confirmed; a second identity needs a human to say how the two relate.';
      continue;
    }
    confirmedOne = true;
  }

  return verdicts;
}
