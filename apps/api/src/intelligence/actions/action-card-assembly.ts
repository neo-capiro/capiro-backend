/**
 * Deterministic narrative assembly for action cards (plan §10). Pure — no DB, no
 * NestJS, NO LLM, NO randomness. Given the stored facts for one action, builds the
 * four card narrative fields (issueTitle / whatChanged / whyItMatters /
 * recommendedAction) plus a suggested artifact type, using fixed string templates.
 *
 * Every number and proper noun in the output comes ONLY from the input facts — this
 * module never invents figures. (LLM polish, if any, is a separate downstream step;
 * this layer guarantees a correct, auditable baseline.)
 *
 * Money convention: delta amounts are $ MILLIONS (project-wide; see
 * program-element-writer) — EXCEPT quantity_change (unit counts) and
 * unit_cost_change (as-printed P-1 exhibit values, units not normalized), which
 * buildWhatChanged renders as counts / with an explicit as-published caveat so
 * a downstream LLM never reads them as $ millions.
 */

import type { ActionType, ArtifactType, DeadlineSource } from './action-recommendation.types.js';

/** A relevance path + its evidence strings (shape mirrors §2.3 PathResult). */
export interface RelevancePathFact {
  path: string;
  evidence: string[];
}

/**
 * The budget delta the card is built around. Amounts are $ MILLIONS for money
 * deltas; unit COUNTS for quantity_change; as-printed exhibit values for
 * unit_cost_change (see buildWhatChanged).
 */
export interface DeltaFact {
  deltaType: string;
  amountFrom: number;
  amountTo: number;
  deltaPct: number;
  assertedFy: number | string;
  /**
   * program_element_delta.fromRef — the position the value moved FROM (e.g.
   * 'request', 'hascMark', 'pb_prior'; the terminated PE code on a
   * transfer_candidate), if known.
   */
  stageFrom?: string;
  /**
   * program_element_delta.toRef — the position the value moved TO (e.g.
   * 'hascMark', 'conference' = NDAA conference report, 'enacted', 'pb_current',
   * 'fy2027:<line description>' on procurement deltas), if known.
   */
  stageTo?: string;
}

/**
 * A committee report provision linked to this PE (§8.2 "show report language").
 * Verbatim `text` + the deterministic classifier's `actionType`
 * (directs_briefing | cuts | adds | restricts | …). Surfaced on the card so a
 * reviewer sees the actual report language behind a mark, and the recommended
 * next action can reference it — never invented.
 */
export interface ProvisionFact {
  id: string;
  committee: string;
  fy: number;
  heading: string;
  text: string;
  actionType: string | null;
}

export interface AssembleCardFacts {
  actionType: ActionType;
  clientName: string;
  peCode: string;
  peTitle: string;
  programName?: string;
  delta: DeltaFact;
  relevancePaths: RelevancePathFact[];
  deadline?: string | null;
  deadlineSource?: DeadlineSource | null;
  /** G5: committee report provisions on record for this PE (may be empty). */
  provisions?: ProvisionFact[];
}

export interface AssembledCard {
  issueTitle: string;
  whatChanged: string;
  whyItMatters: string;
  recommendedAction: string;
  suggestedArtifactType?: ArtifactType;
}

/** Render an amount in $ MILLIONS compactly (e.g. 12.5 -> "$12.5M", 800 -> "$800M"). */
function formatMillions(amountM: number): string {
  const rounded = Math.round(amountM * 10) / 10;
  // Drop a trailing ".0" for whole numbers.
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `$${text}M`;
}

/** "+12%" / "-8%" with the sign always shown; rounds to a whole percent. */
function formatSignedPct(pct: number): string {
  const rounded = Math.round(pct);
  const sign = rounded >= 0 ? '+' : '';
  return `${sign}${rounded}%`;
}

/**
 * RC1: budget-line position refs → human label + legislative vehicle. The keys
 * are the EXACT fromRef/toRef tokens delta-compute.ts / delta-engine.service.ts
 * write to program_element_delta — keep in sync with those writers.
 *
 * ⚠ 'conference' here is the NDAA (authorization-track) conference report: the
 * delta refs keep 'conference' as the stage identity while the VALUE comes from
 * ndaaConference, and the appropriations conference column is reserved/
 * unpopulated and produces no deltas (delta-compute.ts, conference_vs_marks).
 * Do NOT reuse the appropriations-ladder stage→vehicle map for these refs.
 */
interface StageRefDescription {
  label: string;
  vehicle: 'authorization' | 'appropriations' | null;
}
const STAGE_REF_DESCRIPTION: Record<string, StageRefDescription> = {
  request: { label: "President's request", vehicle: null },
  hascMark: { label: 'HASC mark', vehicle: 'authorization' },
  sascMark: { label: 'SASC mark', vehicle: 'authorization' },
  hacDMark: { label: 'HAC-D mark', vehicle: 'appropriations' },
  sacDMark: { label: 'SAC-D mark', vehicle: 'appropriations' },
  conference: { label: 'NDAA conference report', vehicle: 'authorization' },
  enacted: { label: 'enacted appropriation', vehicle: 'appropriations' },
  pb_current: { label: "current President's Budget", vehicle: null },
  pb_prior: { label: "prior President's Budget", vehicle: null },
};

/**
 * Human phrase for the budget-line position a delta moved TO (falling back to
 * the FROM side, then to 'current'). Known refs carry their authorization/
 * appropriations vehicle so the model can never attach a mark to the wrong
 * bill; unknown refs degrade to the cleaned raw token (never invented).
 */
function stagePhrase(stageTo?: string, stageFrom?: string): string {
  const ref = stageTo ?? stageFrom;
  if (!ref) return 'current';
  const d = STAGE_REF_DESCRIPTION[ref];
  if (!d) return ref.replace(/_/g, ' ');
  return d.vehicle ? `${d.label} (${d.vehicle})` : d.label;
}

/** "150" / "1,250" — a unit COUNT (procurement quantities are not dollars). */
function formatCount(n: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(n);
}

/** The `fy2027:Line Description` from/to refs on procurement deltas → the description. */
function procurementLineFromRef(ref?: string): string | null {
  if (!ref) return null;
  const m = /^fy\d{4}:(.+)$/.exec(ref);
  return m ? m[1]! : null;
}

/**
 * Render a fiscal year as a 2-digit suffix for the "FYxx" label, accepting either a
 * full year (2026 -> "26"), a 2-digit value (26 -> "26"), or a string ("FY2026" /
 * "2026" -> "26"). Any unparseable value is passed through unchanged.
 */
function fyShort(assertedFy: number | string): string {
  const digits = String(assertedFy).replace(/\D/g, '');
  if (digits.length >= 2) return digits.slice(-2);
  return String(assertedFy);
}

/** Human-readable relevance-path phrases, joined for the why-it-matters sentence. */
function describeRelevance(paths: RelevancePathFact[]): string {
  if (paths.length === 0) {
    return 'this client has a tracked interest in this program';
  }
  // Prefer the evidence strings (they are already client-specific); fall back to the
  // path name when a path carries no evidence.
  const phrases = paths.map((p) =>
    p.evidence.length > 0 ? p.evidence.join('; ') : p.path.replace(/_/g, ' '),
  );
  return phrases.join('; ');
}

/** Trailing deadline clause for the recommended action. */
function deadlineClause(deadline?: string | null): string {
  if (!deadline) {
    return ' There is no known deadline.';
  }
  return ` Target completion by ${deadline}.`;
}

/**
 * Assemble the narrative for one card. The `whatChanged` sentence is shared across
 * action types (it states the objective budget fact); `whyItMatters` cites the
 * client-specific relevance paths; `recommendedAction` and `suggestedArtifactType`
 * vary by `actionType`.
 */
export function assembleCard(facts: AssembleCardFacts): AssembledCard {
  const { delta } = facts;
  const fy = `FY${fyShort(delta.assertedFy)}`;
  const whatChanged = buildWhatChanged(facts, fy);

  const whyItMatters = `This matters to ${facts.clientName} because ${describeRelevance(facts.relevancePaths)}.`;

  const programLabel = facts.programName ?? facts.peTitle;
  const {
    issueTitle,
    recommendedAction: baseAction,
    suggestedArtifactType,
  } = byActionType(facts.actionType, {
    clientName: facts.clientName,
    peCode: facts.peCode,
    programLabel,
    fy,
    deadline: facts.deadline,
  });

  // G5 (§8.2 "show report language"): when committee report language is on
  // record for this PE, quote it (heading + committee/FY, bounded) so the
  // recommended next action is grounded in the actual directive, not invented.
  const recommendedAction = baseAction + reportLanguageClause(facts.provisions);

  return { issueTitle, whatChanged, whyItMatters, recommendedAction, suggestedArtifactType };
}

/** Trailing clause citing on-record report language (verbatim heading, bounded). */
function reportLanguageClause(provisions?: ProvisionFact[]): string {
  if (!provisions || provisions.length === 0) return '';
  const p = provisions[0]!;
  // Quote the heading (short, as-printed) and name the committee/FY; the full
  // verbatim text lives in the evidence ref, not the narrative.
  const more = provisions.length > 1 ? ` (+${provisions.length - 1} more on record)` : '';
  const verb = p.actionType ? p.actionType.replace(/_/g, ' ') : 'addresses';
  return (
    ` Report language on record — ${p.committee} FY${fyShort(p.fy)} "${p.heading.trim()}" ` +
    `(${verb})${more}; build on or counter it rather than starting from scratch.`
  );
}

/**
 * RC1: the objective what-changed sentence, by delta shape. Every figure states
 * what it IS — a $ MILLIONS amount with its budget-stage + vehicle position, a
 * unit COUNT, or an as-printed exhibit value — so a downstream LLM can never
 * narrate a quantity as dollars, attach a mark to the wrong bill, or read two
 * PB cycles as congressional action.
 */
function buildWhatChanged(facts: AssembleCardFacts, fy: string): string {
  const { delta } = facts;
  const head = `${facts.peTitle} (PE ${facts.peCode})`;
  const direction = delta.amountTo >= delta.amountFrom ? 'increased' : 'decreased';
  const pct = formatSignedPct(delta.deltaPct);

  switch (delta.deltaType) {
    case 'quantity_change': {
      // Amounts are unit COUNTS from the P-1 exhibit, never dollars.
      const desc = procurementLineFromRef(delta.stageTo) ?? procurementLineFromRef(delta.stageFrom);
      const line = desc ? ` for "${desc}"` : '';
      return (
        `${head} procurement quantity${line} ${direction} from ` +
        `${formatCount(delta.amountFrom)} to ${formatCount(delta.amountTo)} units (${pct}) for ${fy}.`
      );
    }
    case 'unit_cost_change': {
      // Unit costs are stored AS PRINTED in the P-1 exhibit (units vary by book
      // and are NOT normalized to $ millions) — state the relative change and
      // pass the raw figures through with that caveat, never a $M label.
      const desc = procurementLineFromRef(delta.stageTo) ?? procurementLineFromRef(delta.stageFrom);
      const line = desc ? ` for "${desc}"` : '';
      return (
        `${head} unit cost${line} ${direction} ${pct} for ${fy} ` +
        `(from ${formatCount(delta.amountFrom)} to ${formatCount(delta.amountTo)} as printed in the ` +
        `P-1 exhibit — units as published, not normalized to $ millions).`
      );
    }
    case 'transfer_candidate': {
      // Stored against the NEW-start PE; stageFrom carries the terminated PE code.
      const fromPe = delta.stageFrom ? `PE ${delta.stageFrom}` : 'another line';
      return (
        `${head} is a new start at ${formatMillions(delta.amountTo)} for ${fy} while ${fromPe} ` +
        `was terminated — a POSSIBLE transfer (title-similarity candidate only, not an asserted fact).`
      );
    }
    case 'new_start':
      return (
        `${head} is a NEW START at ${formatMillions(delta.amountTo)} in the ` +
        `${stagePhrase(delta.stageTo, delta.stageFrom)} position for ${fy}.`
      );
    case 'termination':
      return (
        `${head} was dropped for ${fy} — ${formatMillions(delta.amountFrom)} in the ` +
        `${stagePhrase(delta.stageFrom, delta.stageTo)} position, now absent from the current President's Budget.`
      );
    default:
      return (
        `${head} ${direction} from ${formatMillions(delta.amountFrom)} to ` +
        `${formatMillions(delta.amountTo)} (${pct}) in the ` +
        `${stagePhrase(delta.stageTo, delta.stageFrom)} position for ${fy}.`
      );
  }
}

interface ActionTemplateCtx {
  clientName: string;
  peCode: string;
  programLabel: string;
  fy: string;
  deadline?: string | null;
}

/** Per-action-type title, recommended action, and suggested artifact. */
function byActionType(
  actionType: ActionType,
  ctx: ActionTemplateCtx,
): { issueTitle: string; recommendedAction: string; suggestedArtifactType?: ArtifactType } {
  const dl = deadlineClause(ctx.deadline);
  switch (actionType) {
    case 'protect_funding':
      return {
        issueTitle: `Protect ${ctx.programLabel} funding (PE ${ctx.peCode})`,
        recommendedAction:
          `Engage relevant committee staff to defend the ${ctx.fy} mark for ` +
          `${ctx.programLabel} and prevent erosion in conference.${dl}`,
        suggestedArtifactType: 'committee_staff_memo',
      };
    case 'restore_cut':
      return {
        issueTitle: `Restore cut to ${ctx.programLabel} (PE ${ctx.peCode})`,
        recommendedAction:
          `Build the case to restore the reduction to ${ctx.programLabel} in the ` +
          `${ctx.fy} markup and secure an offset.${dl}`,
        suggestedArtifactType: 'committee_staff_memo',
      };
    case 'add_report_language':
      return {
        issueTitle: `Add report language for ${ctx.programLabel} (PE ${ctx.peCode})`,
        recommendedAction:
          `Draft proposed report language directing emphasis on ${ctx.programLabel} ` +
          `and circulate to committee staff for the ${ctx.fy} report.${dl}`,
        suggestedArtifactType: 'committee_staff_memo',
      };
    case 'oppose_restriction':
      return {
        issueTitle: `Oppose restriction on ${ctx.programLabel} (PE ${ctx.peCode})`,
        recommendedAction:
          `Prepare talking points opposing the proposed restriction on ` +
          `${ctx.programLabel} and brief allied offices ahead of the ${ctx.fy} vote.${dl}`,
        suggestedArtifactType: 'talking_points',
      };
    case 'district_one_pager':
      return {
        issueTitle: `District impact one-pager for ${ctx.programLabel} (PE ${ctx.peCode})`,
        recommendedAction:
          `Produce a district-impact one-pager tying ${ctx.programLabel} to ` +
          `${ctx.clientName}'s local footprint for the member's office.${dl}`,
        suggestedArtifactType: 'member_one_pager',
      };
    case 'monitor_procurement':
      return {
        issueTitle: `Monitor procurement on ${ctx.programLabel} (PE ${ctx.peCode})`,
        recommendedAction:
          `Track SAM.gov and contracting activity tied to ${ctx.programLabel}; ` +
          `log new solicitations and award actions without contacting procurement officials.${dl}`,
        suggestedArtifactType: 'procurement_watch_note',
      };
    case 'client_alert':
      return {
        issueTitle: `Alert ${ctx.clientName}: ${ctx.programLabel} change (PE ${ctx.peCode})`,
        recommendedAction:
          `Send ${ctx.clientName} a concise alert summarizing the ${ctx.fy} change to ` +
          `${ctx.programLabel} and the recommended next step.${dl}`,
        suggestedArtifactType: 'client_email',
      };
    case 'schedule_outreach':
      return {
        issueTitle: `Schedule outreach on ${ctx.programLabel} (PE ${ctx.peCode})`,
        recommendedAction:
          `Schedule outreach to the identified audience to advance ${ctx.clientName}'s ` +
          `position on ${ctx.programLabel} for ${ctx.fy}.${dl}`,
        suggestedArtifactType: 'internal_brief',
      };
    case 'escalate_uncertainty':
      return {
        issueTitle: `Confirm match before acting on ${ctx.programLabel} (PE ${ctx.peCode})`,
        recommendedAction:
          `Do not contact any audience yet. Confirm the program match underlying this ` +
          `card before taking any action on ${ctx.programLabel}.${dl}`,
        suggestedArtifactType: 'internal_brief',
      };
    case 'update_compliance_notes':
      return {
        issueTitle: `Update compliance notes for ${ctx.programLabel} (PE ${ctx.peCode})`,
        recommendedAction:
          `Update the compliance record for ${ctx.programLabel} to reflect the ` +
          `${ctx.fy} change and any contact-use constraints.${dl}`,
        suggestedArtifactType: 'internal_brief',
      };
    default: {
      // Exhaustiveness guard: a new ActionType must be handled above.
      const _never: never = actionType;
      throw new Error(`Unhandled actionType: ${String(_never)}`);
    }
  }
}
