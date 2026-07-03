/**
 * Appropriability scorer (F27 — "the moat"): how actionable is this budget line
 * for a company trying to sell into it, as a weighted composite of factors we
 * can actually evidence. Pure module — no DB, no I/O; the derive verb / read
 * service assembles AppropriabilityInput from real rows.
 *
 * HONESTY RULES (non-negotiable, mirrors the mockup + consolidated plan §4):
 *  - A factor is scored ONLY when its underlying signal exists; otherwise it
 *    lands in `unscored` with the reason, and the composite reweights over the
 *    scored factors alone. We never fake a 50 for "unknown".
 *  - Every scored factor carries a render-safe evidence sentence derived from
 *    the actual inputs, so the FactorBars panel can answer "why this number?".
 *  - District relevance is deliberately ABSENT: we have no district data yet.
 *    When that ingest lands it becomes a new factor here, not a UI hack.
 */
import type { PostureResult } from './committee-posture.js';
import type { MaturityLadder } from './maturity-ladder.js';

export interface AppropriabilityInput {
  /** 'RDT&E' | 'PROC' | 'OM' | null (canonical program_element.appropriation_type). */
  appropriationType: string | null;
  /** Sorted-any-order year rows in $M; only request/enacted pairs are read. */
  years: Array<{ fy: number; request: number | null; enacted: number | null }>;
  /** Committee-posture verdict for the open cycle (null = no marks yet). */
  posture: PostureResult | null;
  /** Transition-maturity ladder (null = not applicable, e.g. unclassifiable). */
  ladder: MaturityLadder | null;
  /** Accepted capability matches on this line. */
  capabilityCount: number;
  /** Accepted relationship edges touching this line. */
  relationshipCount: number;
  /** Award-evidenced incumbents (FederalAward rows resolved to this line). */
  awardIncumbentCount: number;
  /** R-3 budget-justification performers (named companies). */
  performerCount: number;
  /** Resolved office/person links (ProgramOffice / person-PE). */
  officeLinkCount: number;
  /** The line has a narrative description (R-2 / P-40 / OP-5). */
  hasNarrative: boolean;
  /** Page-level source citations on the line. */
  sourceCount: number;
}

export interface AppropriabilityFactor {
  key: string;
  label: string;
  /** 0-100. */
  value: number;
  /** Render-safe evidence sentence. */
  evidence: string;
}

export interface AppropriabilityResult {
  /** 0-100 composite over the scored factors; null when < 3 factors scorable. */
  score: number | null;
  tier: 'high' | 'med' | 'low' | null;
  factors: AppropriabilityFactor[];
  /** Factors we could not score, with the honest reason. */
  unscored: Array<{ key: string; label: string; reason: string }>;
  /** Render-safe headline. */
  reason: string;
}

const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v)));

export function scoreAppropriability(input: AppropriabilityInput): AppropriabilityResult {
  const factors: AppropriabilityFactor[] = [];
  const unscored: AppropriabilityResult['unscored'] = [];

  // ── Budget fit: is money present and growing? ────────────────────────────
  const funded = input.years
    .map((y) => ({ fy: y.fy, v: y.enacted ?? y.request }))
    .filter((y): y is { fy: number; v: number } => y.v !== null && y.v !== 0)
    .sort((a, b) => a.fy - b.fy);
  if (funded.length === 0) {
    unscored.push({ key: 'budget_fit', label: 'Budget fit', reason: 'No funded years on record.' });
  } else {
    const latest = funded[funded.length - 1]!;
    const first = funded[0]!;
    const growth = funded.length > 1 && first.v > 0 ? (latest.v - first.v) / first.v : 0;
    // Presence is worth 50; sustained growth up to +50; decline pulls down.
    const value = clamp(50 + growth * 100);
    factors.push({
      key: 'budget_fit',
      label: 'Budget fit',
      value,
      evidence:
        funded.length > 1
          ? `Funded FY${first.fy}–FY${latest.fy}; ${growth >= 0 ? 'grew' : 'declined'} ${Math.abs(Math.round(growth * 100))}% over the window.`
          : `Single funded year (FY${latest.fy}) on record.`,
    });
  }

  // ── Committee posture: adds vs cuts in the open cycle ───────────────────
  if (!input.posture || input.posture.posture === 'insufficient_data') {
    unscored.push({
      key: 'committee_posture',
      label: 'Committee posture',
      reason: 'No committee marks recorded this cycle.',
    });
  } else {
    // How favorable is the committee environment for selling into this line?
    const postureScore: Record<string, number> = {
      plus_up_defense: 85, // committees added — active congressional support
      appropriations_target: 78, // appropriators adding — money in motion
      aligned: 65, // marks at request — steady, uncontested
      conference_target: 60, // chambers diverge — engaged but unsettled
      restoration_opportunity: 45, // one chamber cut — contested
      cut_risk: 25, // cuts — headwind
    };
    const value = postureScore[input.posture.posture] ?? 50;
    factors.push({
      key: 'committee_posture',
      label: 'Committee posture',
      value,
      evidence: input.posture.rationale,
    });
  }

  // ── Color-of-money fit: do we know what kind of buyer this is? ──────────
  const t = (input.appropriationType ?? '').toUpperCase();
  if (!t) {
    unscored.push({
      key: 'color_of_money',
      label: 'Color-of-money fit',
      reason: 'Appropriation type not stated.',
    });
  } else {
    const comScore = t === 'PROC' ? 88 : t === 'OM' ? 70 : 62; // fielding buyer > sustainment > development
    factors.push({
      key: 'color_of_money',
      label: 'Color-of-money fit',
      value: comScore,
      evidence:
        t === 'PROC'
          ? 'Procurement dollars — a fielding buyer exists on this line.'
          : t === 'OM'
            ? 'O&M dollars — sustainment and services demand.'
            : 'RDT&E dollars — development-stage entry (eval/prototyping wedge).',
    });
  }

  // ── Maturity: how far along the transition ladder ───────────────────────
  if (!input.ladder) {
    unscored.push({
      key: 'maturity',
      label: 'Maturity',
      reason: 'Transition maturity not classifiable for this line.',
    });
  } else {
    const value = clamp(20 + input.ladder.current * 16); // rung 0 → 20 … rung 5 → 100
    factors.push({
      key: 'maturity',
      label: 'Maturity',
      value,
      evidence: `Rung ${input.ladder.current}/5 — ${input.ladder.rungs[input.ladder.current]?.label ?? ''}.`,
    });
  }

  // ── Capability fit: is the line mapped to a demand-side capability? ─────
  if (input.capabilityCount === 0) {
    unscored.push({
      key: 'capability_fit',
      label: 'Capability fit',
      reason: 'Not yet mapped to a capability (keyword matcher found no hit).',
    });
  } else {
    factors.push({
      key: 'capability_fit',
      label: 'Capability fit',
      value: clamp(60 + input.capabilityCount * 10),
      evidence: `Mapped to ${input.capabilityCount} ${input.capabilityCount === 1 ? 'capability' : 'capabilities'} via auditable keyword evidence.`,
    });
  }

  // ── Office clarity: do we know who runs the money? ──────────────────────
  if (input.officeLinkCount === 0) {
    unscored.push({
      key: 'office_clarity',
      label: 'Office clarity',
      reason: 'No program office / personnel resolved for this line yet.',
    });
  } else {
    factors.push({
      key: 'office_clarity',
      label: 'Office clarity',
      value: clamp(50 + input.officeLinkCount * 8),
      evidence: `${input.officeLinkCount} office/person link${input.officeLinkCount === 1 ? '' : 's'} resolved (tiered, source-cited).`,
    });
  }

  // ── Incumbent friction: inverse — open field scores higher ──────────────
  if (input.awardIncumbentCount === 0 && input.performerCount === 0) {
    unscored.push({
      key: 'incumbent_friction',
      label: 'Incumbent friction',
      reason: 'No award or performer evidence yet — friction unknown, not zero.',
    });
  } else {
    // Some evidence of who's on the line: more incumbents = more friction = lower score.
    const value = clamp(85 - input.awardIncumbentCount * 15 - input.performerCount * 4);
    factors.push({
      key: 'incumbent_friction',
      label: 'Incumbent friction',
      value,
      evidence: `${input.awardIncumbentCount} award-evidenced incumbent${input.awardIncumbentCount === 1 ? '' : 's'}, ${input.performerCount} budget-justification performer${input.performerCount === 1 ? '' : 's'}.`,
    });
  }

  // ── Evidence strength: how well-sourced is the line itself ──────────────
  {
    const value = clamp((input.hasNarrative ? 45 : 0) + Math.min(input.sourceCount, 10) * 5 + Math.min(input.relationshipCount, 5) * 2);
    if (value === 0) {
      unscored.push({
        key: 'evidence_strength',
        label: 'Evidence strength',
        reason: 'No narrative, citations, or graph edges on this line yet.',
      });
    } else {
      factors.push({
        key: 'evidence_strength',
        label: 'Evidence strength',
        value,
        evidence: `${input.hasNarrative ? 'Narrative present' : 'No narrative'}; ${input.sourceCount} page-level citation${input.sourceCount === 1 ? '' : 's'}; ${input.relationshipCount} graph edge${input.relationshipCount === 1 ? '' : 's'}.`,
      });
    }
  }

  // ── Composite ────────────────────────────────────────────────────────────
  if (factors.length < 3) {
    return {
      score: null,
      tier: null,
      factors,
      unscored,
      reason: 'Too few scorable factors — appropriability unlocks as this line completes enrichment.',
    };
  }
  const score = clamp(factors.reduce((s, f) => s + f.value, 0) / factors.length);
  const tier = score >= 70 ? 'high' : score >= 45 ? 'med' : 'low';
  const strongest = [...factors].sort((a, b) => b.value - a.value)[0]!;
  const weakest = [...factors].sort((a, b) => a.value - b.value)[0]!;
  return {
    score,
    tier,
    factors,
    unscored,
    reason: `Strongest: ${strongest.label.toLowerCase()} (${strongest.value}). Watch: ${weakest.label.toLowerCase()} (${weakest.value}).${unscored.length ? ` ${unscored.length} factor${unscored.length === 1 ? '' : 's'} not yet scorable.` : ''}`,
  };
}
