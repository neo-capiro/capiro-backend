/**
 * Pre-synthesis CLAIM GATE (v3 plan Wave 4, ADR-2/3) — the deterministic core.
 *
 * Runs BEFORE prose: validates each `PlannedClaim` against the `EvidencePacket`s
 * it cites, using the `PREDICATE_REGISTRY` to pick a deterministic checker. A
 * claim is `approved` only when its evidence affirmatively supports it,
 * `refuted` when the evidence contradicts it, `unsupported` when no cited packet
 * bears on it, and `needs_skeptic` when its predicate has no deterministic
 * checker yet (the LLM skeptic adjudicates those). The renderer may then emit
 * ONLY approved claims (+ labeled inferences), so a reversed direction, a
 * failed-rule-as-operative, or an LI-as-PE never reaches persuasive prose.
 *
 * Pure + deterministic. This is the gate LOGIC; wiring it into each surface's
 * generation path (ClaimPlan proposal → gate → constrained render) is the
 * per-surface Wave-4 integration that follows. Guarantee is always relative to
 * predicate coverage (predicateCoverage()) — claims outside it are skeptic-judged.
 */

import {
  PREDICATE_REGISTRY,
  type ClaimPlan,
  type EvidencePacket,
  type PlannedClaim,
} from './evidence';

export type ClaimVerdict = 'approved' | 'refuted' | 'unsupported' | 'needs_skeptic';

export interface ClaimJudgment {
  claimId: string;
  predicate: string;
  verdict: ClaimVerdict;
  /** Why — references the evidence or the missing evidence. */
  reason: string;
}

export type ClaimGateDecision = 'approve_all' | 'repair' | 'block';

export interface ClaimGateResult {
  judgments: ClaimJudgment[];
  approved: string[];
  refuted: string[];
  unsupported: string[];
  needsSkeptic: string[];
  /**
   * block  — a load-bearing claim was refuted (its evidence contradicts it).
   * repair — a non-load-bearing claim refuted, or a load-bearing claim is
   *          unsupported by any cited packet.
   * approve_all — nothing refuted/unsupported deterministically; needs_skeptic
   *          residuals go to the skeptic, they don't block the deterministic gate.
   */
  decision: ClaimGateDecision;
}

const EPSILON = 0.05; // $M tolerance for amount equality

/** Packets a claim cites, indexed for the checkers. */
function citedPackets(claim: PlannedClaim, byId: Map<string, EvidencePacket>): EvidencePacket[] {
  return claim.evidenceIds.map((id) => byId.get(id)).filter((p): p is EvidencePacket => p != null);
}

function obj(claim: PlannedClaim): Record<string, unknown> {
  return claim.object && typeof claim.object === 'object'
    ? (claim.object as Record<string, unknown>)
    : {};
}

/** Judge one claim against its cited evidence. */
function judgeClaim(claim: PlannedClaim, byId: Map<string, EvidencePacket>): ClaimJudgment {
  const base = { claimId: claim.claimId, predicate: claim.predicate };
  // Labeled inferences are not gated as facts — the renderer must prefix them.
  if (claim.inference) {
    return { ...base, verdict: 'approved', reason: 'Labeled inference (not gated as a fact).' };
  }
  const spec = PREDICATE_REGISTRY[claim.predicate];
  if (!spec || spec.checker !== 'deterministic') {
    return {
      ...base,
      verdict: 'needs_skeptic',
      reason: 'No deterministic checker for this predicate.',
    };
  }
  const packets = citedPackets(claim, byId);
  const o = obj(claim);

  switch (claim.predicate) {
    case 'funding_direction_vs_request': {
      const fy = typeof o.fiscalYear === 'number' ? o.fiscalYear : undefined;
      const cmp = packets.find(
        (p) => p.semantics.comparison && (fy == null || p.semantics.fiscalYear === fy),
      );
      if (!cmp?.semantics.comparison) {
        return {
          ...base,
          verdict: 'unsupported',
          reason: 'No cited packet carries a same-FY comparison.',
        };
      }
      return o.direction === cmp.semantics.comparison.direction
        ? {
            ...base,
            verdict: 'approved',
            reason: `Matches source-derived direction ${cmp.semantics.comparison.direction}.`,
          }
        : {
            ...base,
            verdict: 'refuted',
            reason: `Claimed ${String(o.direction)}, but evidence says ${cmp.semantics.comparison.direction}.`,
          };
    }
    case 'funding_at_stage': {
      const stage = o.stage;
      const fy = typeof o.fiscalYear === 'number' ? o.fiscalYear : undefined;
      const amt = amountValue(o.amount);
      const pkt = packets.find(
        (p) => p.semantics.stage === stage && (fy == null || p.semantics.fiscalYear === fy),
      );
      if (!pkt?.semantics.amount) {
        return {
          ...base,
          verdict: 'unsupported',
          reason: `No cited packet at stage ${String(stage)}${fy ? ` FY${fy}` : ''}.`,
        };
      }
      if (amt == null)
        return { ...base, verdict: 'approved', reason: 'Stage present; no amount asserted.' };
      return Math.abs(pkt.semantics.amount.value - amt) <= EPSILON
        ? { ...base, verdict: 'approved', reason: 'Amount matches the cited packet.' }
        : {
            ...base,
            verdict: 'refuted',
            reason: `Claimed $${amt}M, packet has $${pkt.semantics.amount.value}M.`,
          };
    }
    case 'bill_status': {
      const pkt = packets.find((p) => typeof p.semantics.status === 'string');
      if (!pkt?.semantics.status)
        return {
          ...base,
          verdict: 'unsupported',
          reason: 'No cited packet carries a bill status.',
        };
      return o.status === pkt.semantics.status
        ? { ...base, verdict: 'approved', reason: `Matches status ${pkt.semantics.status}.` }
        : {
            ...base,
            verdict: 'refuted',
            reason: `Claimed status ${String(o.status)}, evidence says ${pkt.semantics.status}.`,
          };
    }
    case 'rule_operative': {
      const pkt = packets.find((p) => typeof p.semantics.status === 'string');
      if (!pkt?.semantics.status)
        return {
          ...base,
          verdict: 'unsupported',
          reason: 'No cited packet carries a rule/bill status.',
        };
      const actuallyOperative =
        pkt.semantics.status !== 'rule_failed' && pkt.semantics.status !== 'failed';
      return Boolean(o.operative) === actuallyOperative
        ? {
            ...base,
            verdict: 'approved',
            reason: `Operative=${actuallyOperative} matches status ${pkt.semantics.status}.`,
          }
        : {
            ...base,
            verdict: 'refuted',
            reason: `Claimed operative=${String(o.operative)}, but status is ${pkt.semantics.status}.`,
          };
    }
    case 'identifier_kind': {
      const pkt = packets.find((p) => p.entity.identifierKind != null);
      if (!pkt)
        return {
          ...base,
          verdict: 'unsupported',
          reason: 'No cited packet identifies the code kind.',
        };
      const actual =
        pkt.entity.entityType === 'procurement_line_item' ? 'procurement_line_item' : 'pe';
      return o.kind === actual
        ? { ...base, verdict: 'approved', reason: `Kind ${actual} matches the evidence.` }
        : {
            ...base,
            verdict: 'refuted',
            reason: `Claimed ${String(o.kind)}, evidence says ${actual}.`,
          };
    }
    case 'provision_directs_pe': {
      // A CONFIRMED attribution requires a verbatim pe_code match that is accepted.
      const confirmed = Boolean(o.confirmed);
      const pkt = packets.find(
        (p) => p.semantics.matchBasis != null || p.semantics.reviewStatus != null,
      );
      if (!pkt)
        return {
          ...base,
          verdict: 'unsupported',
          reason: 'No cited packet carries a provision match basis.',
        };
      const isFirm =
        pkt.semantics.matchBasis === 'pe_code' && pkt.semantics.reviewStatus === 'accepted';
      if (confirmed && !isFirm) {
        return {
          ...base,
          verdict: 'refuted',
          reason: `Claimed a confirmed provision, but match is ${pkt.semantics.matchBasis}/${pkt.semantics.reviewStatus} (program-level/candidate).`,
        };
      }
      return {
        ...base,
        verdict: 'approved',
        reason: isFirm
          ? 'Verbatim pe_code/accepted match.'
          : 'Stated as non-confirmed / program-level.',
      };
    }
    default:
      return { ...base, verdict: 'needs_skeptic', reason: 'Predicate has no gate branch.' };
  }
}

function amountValue(a: unknown): number | undefined {
  if (a && typeof a === 'object' && typeof (a as { value?: unknown }).value === 'number') {
    return (a as { value: number }).value;
  }
  return typeof a === 'number' ? a : undefined;
}

/**
 * Run the deterministic pre-synthesis gate over a ClaimPlan. Returns per-claim
 * judgments + the overall decision. Only `approved` (+ labeled-inference) claims
 * should render; `needs_skeptic` residuals route to the LLM skeptic.
 */
export function runClaimPlanGate(plan: ClaimPlan, packets: EvidencePacket[]): ClaimGateResult {
  const byId = new Map(packets.map((p) => [p.evidenceId, p]));
  const judgments = plan.claims.map((c) => judgeClaim(c, byId));
  const importance = new Map(plan.claims.map((c) => [c.claimId, c.importance]));

  const approved = judgments.filter((j) => j.verdict === 'approved').map((j) => j.claimId);
  const refuted = judgments.filter((j) => j.verdict === 'refuted').map((j) => j.claimId);
  const unsupported = judgments.filter((j) => j.verdict === 'unsupported').map((j) => j.claimId);
  const needsSkeptic = judgments.filter((j) => j.verdict === 'needs_skeptic').map((j) => j.claimId);

  const loadBearingRefuted = refuted.some((id) => importance.get(id) === 'load_bearing');
  const loadBearingUnsupported = unsupported.some((id) => importance.get(id) === 'load_bearing');

  const decision: ClaimGateDecision = loadBearingRefuted
    ? 'block'
    : refuted.length > 0 || loadBearingUnsupported
      ? 'repair'
      : 'approve_all';

  return { judgments, approved, refuted, unsupported, needsSkeptic, decision };
}
