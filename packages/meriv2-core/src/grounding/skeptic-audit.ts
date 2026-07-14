/**
 * SKEPTIC AUDIT — the LIVE escalation path from the deterministic layer to the
 * LLM skeptic (v3 plan Wave 4 wiring; closes the "skeptic pipeline unwired on
 * both ends" gap).
 *
 * Flow, matching the master plan's design end-to-end:
 *   1. extractResidualClaims — deterministic, precision-first: sentences that
 *      assert something about a LEDGER-KNOWN entity (bill id / PE code present
 *      in the turn's tool results) which NO deterministic check flagged. Those
 *      are exactly the auditor header's "undecidable residuals".
 *   2. Wrap them as a ClaimPlan whose predicate has no deterministic checker →
 *      runClaimPlanGate routes every one to `needs_skeptic` — the gate's
 *      designed residual channel, now with a live caller.
 *   3. runSkeptic adjudicates each residual against the turn's evidence
 *      (adversarial, fail-closed per claim).
 *   4. Confident refutations (high|medium) become SK1 findings; the caller
 *      merges them via mergeSkepticFindings, which re-derives the decision with
 *      the SAME per-surface policy as runAuditor (auditDecisionFor).
 *
 * POLICY: a `refuted` verdict with confidence 'low' (including transport
 * failures — runSkeptic maps errors to refuted/low) is reported for logging
 * but NOT converted into a finding. The skeptic's fail-closed default protects
 * against laundering approvals; converting a transient LLM outage into a HOLD
 * on every memo would trade a grounding risk for an availability incident.
 */

import {
  toLines,
  auditDecisionFor,
  SEVERITY_RANK,
  type AuditFinding,
  type AuditVerdict,
  type ToolResultLedger,
} from './auditor';
import { runClaimPlanGate } from './claim-gate';
import { runSkeptic, type SkepticJudge, type SkepticVerdict } from './skeptic';
import type { ClaimPlan, PlannedClaim } from './evidence';

/** Rollout switch (env `MERI_SKEPTIC_MODE`): off (default) | shadow | enforce. */
export type SkepticMode = 'off' | 'shadow' | 'enforce';

export function resolveSkepticMode(raw: string | undefined): SkepticMode {
  return raw === 'shadow' || raw === 'enforce' ? raw : 'off';
}

// Ledger-known anchors: a residual is only escalated when it asserts something
// about an entity the model actually retrieved this turn — claims about
// un-retrieved entities are D1/D14 territory, and chit-chat stays out entirely.
const BILL_ID_RE = /\b(?:H\.?\s?R\.?|S\.?)\s?\d{1,5}\b/gi;
const PE_CODE_RE = /\b\d{7}[A-Z][A-Z0-9]*\b/g;
// The sentence must ASSERT something checkable — money or a status/action verb.
const MONEY_RE = /\$\s?\d[\d,.]*\s?(?:billion|million|thousand|[BMK])?\b/i;
const ASSERTION_RE =
  /\b(?:passed|enacted|signed|reported|marked|zeroed|cut|increased|decreased|added|plus[- ]up|terminated|failed|advanced|scheduled|funds?|funded|appropriat\w+|authoriz\w+)\b/i;

const MIN_SENTENCE_CHARS = 40;
const DEFAULT_MAX_CLAIMS = 5;
const DEFAULT_EVIDENCE_BUDGET = 20_000;

/**
 * Deterministic residual extractor. Returns up to `maxClaims` sentences that
 * (a) name a bill id or PE code that appears VERBATIM in the ledger corpus,
 * (b) assert money or a status/action, and (c) were NOT already flagged by a
 * deterministic check. Money-bearing sentences are preferred when capping.
 * LINE-based (toLines, not toSentences): a period split would sever "H.R."
 * from its number — the same abbreviation trap D5/D6 avoid.
 */
export function extractResidualClaims(
  output: string,
  ledger: ToolResultLedger,
  deterministicFindings: AuditFinding[],
  maxClaims = DEFAULT_MAX_CLAIMS,
): string[] {
  if (ledger.entries.length === 0) return [];
  const corpus = ledger.entries.map((e) => e.serialized).join('\n');
  const flaggedSpans = deterministicFindings.map((f) => f.span);
  const candidates: Array<{ sentence: string; hasMoney: boolean }> = [];
  for (const sentence of toLines(output)) {
    if (sentence.length < MIN_SENTENCE_CHARS) continue;
    // Already decided deterministically (either direction of containment).
    if (flaggedSpans.some((s) => sentence.includes(s) || s.includes(sentence))) continue;
    const anchors = [
      ...(sentence.match(BILL_ID_RE) ?? []),
      ...(sentence.match(PE_CODE_RE) ?? []),
    ].map((a) => a.replace(/\s+/g, ' ').trim());
    if (anchors.length === 0) continue;
    // Anchor must be ledger-known. Bill ids are matched loosely on the digits
    // (serializations vary: "H.R. 8800" vs "hr-8800-119"); PE codes verbatim.
    const anchored = anchors.some((a) => {
      const digits = a.replace(/\D+/g, '');
      return corpus.includes(a) || (digits.length >= 2 && corpus.includes(digits));
    });
    if (!anchored) continue;
    const hasMoney = MONEY_RE.test(sentence);
    if (!hasMoney && !ASSERTION_RE.test(sentence)) continue;
    candidates.push({ sentence, hasMoney });
  }
  candidates.sort((a, b) => Number(b.hasMoney) - Number(a.hasMoney));
  return candidates.slice(0, Math.max(0, maxClaims)).map((c) => c.sentence);
}

/** Wrap residual sentences as a ClaimPlan the claim gate routes to the skeptic. */
export function buildResidualClaimPlan(
  residuals: string[],
  surface: ClaimPlan['surface'],
): ClaimPlan {
  const claims: PlannedClaim[] = residuals.map((sentence, i) => ({
    claimId: `residual-${i + 1}`,
    subject: { entityType: 'output_sentence', entityId: `residual-${i + 1}` },
    // Deliberately NOT in PREDICATE_REGISTRY: the gate's designed behavior for
    // an unregistered predicate is `needs_skeptic` — the residual channel.
    predicate: 'residual_assertion',
    object: { text: sentence },
    qualifiers: {},
    evidenceIds: [],
    inference: false,
    importance: 'supporting',
  }));
  return { planId: `skeptic-audit-${residuals.length}`, surface, claims, recommendations: [] };
}

export interface SkepticAuditResult {
  /** Confident refutations, as auditor findings (check 'SK1', severity high). */
  findings: AuditFinding[];
  /** Every residual sentence that was escalated (for observability). */
  residuals: string[];
  /** Per-residual verdicts, aligned with `residuals` (for shadow logging). */
  verdicts: SkepticVerdict[];
  /** Refutations demoted for low confidence (incl. transport failures). */
  lowConfidenceRefutations: number;
}

/**
 * Run the full escalation: extract residuals → claim gate (`needs_skeptic`) →
 * skeptic per residual → SK1 findings for confident refutations. Never throws:
 * per-claim failures are fail-closed inside runSkeptic and demoted here by the
 * low-confidence policy; an empty extraction returns an empty result.
 */
export async function runSkepticAudit(
  input: {
    output: string;
    ledger: ToolResultLedger;
    surface: ClaimPlan['surface'];
    deterministicFindings: AuditFinding[];
    maxClaims?: number;
    evidenceCharBudget?: number;
  },
  judge: SkepticJudge,
): Promise<SkepticAuditResult> {
  const residuals = extractResidualClaims(
    input.output,
    input.ledger,
    input.deterministicFindings,
    input.maxClaims ?? DEFAULT_MAX_CLAIMS,
  );
  if (residuals.length === 0) {
    return { findings: [], residuals: [], verdicts: [], lowConfidenceRefutations: 0 };
  }
  const plan = buildResidualClaimPlan(residuals, input.surface);
  const gate = runClaimPlanGate(plan, []);
  const byClaimId = new Map(plan.claims.map((c) => [c.claimId, c]));
  const toJudge = gate.needsSkeptic
    .map((id) => byClaimId.get(id))
    .filter((c): c is PlannedClaim => c != null);

  const evidence = input.ledger.entries
    .map((e) => e.serialized)
    .join('\n')
    .slice(0, input.evidenceCharBudget ?? DEFAULT_EVIDENCE_BUDGET);

  const verdicts = await Promise.all(
    toJudge.map((c) =>
      runSkeptic(
        {
          claim: (c.object as { text: string }).text,
          evidence,
          predicate: c.predicate,
        },
        judge,
      ),
    ),
  );

  const findings: AuditFinding[] = [];
  let lowConfidenceRefutations = 0;
  verdicts.forEach((v, i) => {
    if (!v.refuted) return;
    if (v.confidence === 'low') {
      lowConfidenceRefutations++;
      return;
    }
    const sentence = (toJudge[i]!.object as { text: string }).text;
    findings.push({
      check: 'SK1',
      severity: 'high',
      span: sentence.slice(0, 200),
      detail: `LLM skeptic refuted this claim against the turn's evidence (${v.confidence} confidence): ${v.reason}`,
    });
  });

  return { findings, residuals, verdicts, lowConfidenceRefutations };
}

/**
 * Merge skeptic findings into an auditor verdict, re-deriving topSeverity and
 * the decision with the SAME per-surface policy runAuditor used — one policy,
 * never two. No-op when there is nothing to merge.
 */
export function mergeSkepticFindings(verdict: AuditVerdict, extra: AuditFinding[]): AuditVerdict {
  if (extra.length === 0) return verdict;
  const findings = [...verdict.findings, ...extra].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  );
  const topSeverity = findings[0]!.severity;
  return {
    ...verdict,
    findings,
    topSeverity,
    decision: auditDecisionFor(verdict.surface, topSeverity, verdict.mode),
  };
}
