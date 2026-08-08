/**
 * Funding Opportunities v2 — display model.
 *
 * Pure display helpers mapping the REAL API shapes (funding-opportunities-api.ts)
 * onto the mockup's visual vocabulary (chips, fit strength, due urgency, evidence
 * marks). No fetching here; the page owns the queries.
 *
 * The honesty rules of the legacy surface are PRESERVED, not re-skinning them away:
 * null money renders as the placeholder (never $0), eligibility and relevance stay
 * separate, and a machine recommendation never moves a stage.
 */
import {
  ELIGIBILITY_LABELS,
  INBOX_FILTER_LABELS,
  KIND_LABELS,
  PIPELINE_STAGE_LABELS,
  RECOMMENDATION_LABELS,
  SOURCE_LABELS,
  formatDeadline,
  formatInboxCount,
  formatMoney,
  moneyLine,
  type EligibilityState,
  type FundingOpportunity,
  type InboxFilter,
  type InboxRow,
  type MachineRecommendation,
  type OpportunityKind,
  type OpportunitySource,
  type PipelineStageView,
} from '../funding-opportunities-api.js';

/* ── Recommendation chip (mockup chip()) ─────────────────────────────────── */

/** Mockup glyph per machine recommendation / outcome. */
export function recChip(rec: string | null | undefined): { text: string; cls: string } {
  switch (rec) {
    case 'pursue':
      return { text: '● PURSUE', cls: 'fo-v2-chip-pursue' };
    case 'monitor':
      return { text: '◐ MONITOR', cls: 'fo-v2-chip-monitor' };
    case 'needs_review':
      return { text: '⚠ NEEDS REVIEW', cls: 'fo-v2-chip-review' };
    case 'pass':
      return { text: '⊘ PASS', cls: 'fo-v2-chip-pass' };
    case 'passed':
      return { text: '⊘ PASSED', cls: 'fo-v2-chip-passed' };
    case 'submitted':
      return { text: '⧗ SUBMITTED', cls: 'fo-v2-chip-submitted' };
    case 'won':
      return { text: '✓ WON', cls: 'fo-v2-chip-won' };
    case 'lost':
      return { text: '✕ LOST', cls: 'fo-v2-chip-lost' };
    case 'shape_now':
      return { text: '◈ SHAPE NOW', cls: 'fo-v2-chip-forecast' };
    default:
      return { text: '◐ MONITOR', cls: 'fo-v2-chip-monitor' };
  }
}

/* ── Fit strength (mockup fitStyle()) ────────────────────────────────────── */

export function fitClass(fit: string | null | undefined): string {
  if (fit === 'Strong fit') return 'fo-v2-fit-strong';
  if (fit === 'Weak fit') return 'fo-v2-fit-weak';
  return 'fo-v2-fit-mod';
}

/** Derive a fit word from the relevance score bands the legacy UI uses. */
export function fitFromScore(score: number | null | undefined): string {
  if (score == null) return 'Moderate fit';
  if (score >= 70) return 'Strong fit';
  if (score < 35) return 'Weak fit';
  return 'Moderate fit';
}

/* ── Due line (mockup dueStyle()) ────────────────────────────────────────── */

export function dueDisplay(
  responseDeadline: string | null,
  note: string | null,
): { text: string; urgent: boolean } {
  const d = formatDeadline(responseDeadline, note);
  const urgent = d.daysRemaining != null && d.daysRemaining <= 14;
  const days = d.daysRemaining != null ? ` · ${d.daysRemaining} D` : '';
  return { text: `${d.text.toUpperCase()}${days}`, urgent };
}

/* ── Evidence mark (from matchedSignals / eligibility) ───────────────────── */

export function evidenceMark(o: {
  matchedSignals?: Array<{ strength: string }>;
  eligibility?: { state: string };
}): { text: string; cls: 'ok' | 'mid' | 'warn' } {
  const elig = o.eligibility?.state;
  if (elig === 'eligible') return { text: '■ VERIFIED', cls: 'ok' };
  if (elig === 'needs_review') return { text: '◧ PARTIAL', cls: 'mid' };
  if (elig === 'ineligible') return { text: '⚠ CONFLICTING', cls: 'warn' };
  return { text: '◧ PARTIAL', cls: 'mid' };
}

/* ── Client mark (initials block) ────────────────────────────────────────── */

export function clientInitials(name: string): string {
  const words = name.trim().split(/\s+/);
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/* ── Labels re-exported for the page (single import site) ────────────────── */
export {
  ELIGIBILITY_LABELS,
  INBOX_FILTER_LABELS,
  KIND_LABELS,
  PIPELINE_STAGE_LABELS,
  RECOMMENDATION_LABELS,
  SOURCE_LABELS,
  formatInboxCount,
  formatMoney,
  moneyLine,
};
export type {
  EligibilityState,
  FundingOpportunity,
  InboxFilter,
  InboxRow,
  MachineRecommendation,
  OpportunityKind,
  OpportunitySource,
  PipelineStageView,
};
