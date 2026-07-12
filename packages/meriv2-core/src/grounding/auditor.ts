/**
 * Post-hoc grounding AUDITOR (v3 plan Wave 2 — the enforcement milestone).
 *
 * Runs AFTER generation, over the final model output + the same-turn
 * `ToolResultLedger` (raw tool payloads, already RC1-labeled + injection
 * neutralized). It re-derives ground truth from the ledger and flags output
 * sentences that contradict it — the deterministic catcher for the cataloged
 * hallucination classes:
 *
 *   D1  citation existence      — a FORM-B [S:tool:record_id] token whose tool
 *                                 wasn't called this turn or whose record_id
 *                                 isn't verbatim in that tool's result.
 *   D4b vehicle conflation      — an appropriations stage word attached to the
 *                                 word "authorization"/"NDAA" (or vice versa).
 *   D6  failed-rule framing     — operative/advancing language about a bill the
 *                                 ledger reports as rule_failed / failed.
 *   D7  LI-as-PE                — prose calling a procurement line item (BLIN
 *                                 shape, or ledger identifierKind) a "Program
 *                                 Element / PE".
 *
 * DESIGN: deterministic + pure. No LLM, no network. Precision over recall — a
 * check fires only on an unambiguous, ground-truth-backed contradiction, because
 * a false hold on a client-facing draft is itself a harm. The undecidable
 * residuals (composite claims, novel predicates) route to the Wave-2 LLM skeptic
 * (a follow-up); this kernel is the deterministic floor.
 *
 * ROLLOUT: gated by `AuditorMode` (off | shadow | annotate | enforce). Shadow
 * first — capture the ledger, run the auditor, record findings, DO NOT alter
 * output — for ≥1 representative traffic cycle before any surface enforces. The
 * verdict's `decision` encodes the per-surface fail policy so the caller can act
 * once a surface is flipped to enforce.
 */

import {
  FUNDING_STAGE_VEHICLE,
  billStatusLabel,
  extractCitedPeCodes,
  validateFormBCitations,
  type FundingVehicle,
} from '@capiro/shared';

export type AuditorMode = 'off' | 'shadow' | 'annotate' | 'enforce';
export type AuditSeverity = 'critical' | 'high' | 'medium' | 'low';
export type AuditSurface = 'chat' | 'research' | 'outreach' | 'memo' | 'alert';

/** One raw tool result captured during a generation turn (for the ledger). */
export interface LedgerEntry {
  /** The tool name exactly as called (e.g. 'get_pe_budget_timeline'). */
  tool: string;
  /** Serialized result as it was fed to the model — already RC1-labeled. */
  serialized: string;
  /** The parsed result object when the caller has it (enables structured checks). */
  result?: unknown;
  /** Row count for list-shaped tools (0-result telemetry; undefined if N/A). */
  rowCount?: number;
}

/** All tool results captured during ONE generation turn. */
export interface ToolResultLedger {
  entries: LedgerEntry[];
}

export interface AuditFinding {
  /** The check id: 'D1' | 'D4b' | 'D6' | 'D7'. */
  check: string;
  severity: AuditSeverity;
  /** The offending output span (a sentence or token), trimmed. */
  span: string;
  /** Why it was flagged, referencing the ground truth. */
  detail: string;
}

export type AuditDecision = 'deliver' | 'deliver_with_flags' | 'repair' | 'hold';

export interface AuditVerdict {
  mode: AuditorMode;
  surface: AuditSurface;
  findings: AuditFinding[];
  /** Highest severity among findings, or null when clean. */
  topSeverity: AuditSeverity | null;
  /**
   * What the caller should do, given the mode + surface fail policy. In `off`/
   * `shadow` this is always `deliver` (findings are observed, never acted on).
   */
  decision: AuditDecision;
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Split text into rough sentences/lines for span-level analysis. */
function toSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const SEVERITY_RANK: Record<AuditSeverity, number> = {
  critical: 3,
  high: 2,
  medium: 1,
  low: 0,
};

/** BLIN / procurement-line-item shape (mirrors apps/api PROCUREMENT_CODE_REGEX). */
const PROCUREMENT_SHAPE = /^\d{4}[A-Z]{1,2}[0-9A-Z]{2,14}$/;
/** R-1/R-2 Program Element shape (mirrors apps/api PE_CODE_REGEX). */
const PE_SHAPE = /^\d{7}[A-Z][A-Z0-9]*$/;

// ── D1: FORM-B citation existence ────────────────────────────────────────────

/**
 * Flag FORM-B tokens whose tool wasn't called this turn or whose record_id is
 * not a verbatim substring of that tool's serialized result. Reuses the shared
 * validator over a tool→serialized map built from the ledger.
 */
export function checkCitations(output: string, ledger: ToolResultLedger): AuditFinding[] {
  const byTool: Record<string, string> = {};
  for (const e of ledger.entries) {
    byTool[e.tool] = (byTool[e.tool] ?? '') + '\n' + e.serialized;
  }
  const { invalid } = validateFormBCitations(output, byTool);
  return invalid.map((token) => ({
    check: 'D1',
    severity: 'medium' as const,
    span: token,
    detail: `Citation ${token} does not resolve: its tool was not called this turn, or its record_id is not verbatim in that tool's result. The sentence it trails is ungrounded.`,
  }));
}

// ── D4b: authorization vs appropriation conflation ───────────────────────────

// An AUTHORIZATION subject doing an APPROPRIATIONS action, in the SAME clause
// (no . or ; between), and not an enumeration ("NDAA and appropriations …").
const AUTH_DOES_APPROP =
  /\b(?:NDAA|authoriz\w+|HASC|SASC)\b(?!\s+(?:and|or|,|nor))[^.;]{0,40}?\b(?:appropriat\w+|provides? the money|provides? the funding)\b/i;
// An APPROPRIATIONS subject doing an AUTHORIZATION action, same clause.
const APPROP_DOES_AUTH =
  /\b(?:HAC-?D|SAC-?D|appropriations? (?:bill|committee|mark|act|conference))\b(?!\s+(?:and|or|,|nor))[^.;]{0,40}?\bauthoriz\w+\b/i;

/**
 * Flag a sentence that has one vehicle DO the other's job — an authorization
 * subject that "appropriates/funds" money, or an appropriations subject that
 * "authorizes" — the vehicle-conflation class (S1-1/2, S3-8). High-precision by
 * design: the two terms must sit in the SAME clause (no `.`/`;` between), must
 * not be a coordinating enumeration ("NDAA and appropriations committees"), and
 * the legitimate "NDAA conference report" authorization phrasing is exempt. A
 * correctly-contrasting sentence ("The NDAA authorizes the ceiling; the
 * appropriations bill provides the money") does NOT fire — the clause break
 * separates the subjects from the opposing verbs.
 */
export function checkVehicleConflation(output: string): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const s of toSentences(output)) {
    const mentionsNdaaConference = /\bNDAA\b[^.]*\bconference\b|\bconference\b[^.]*\bNDAA\b/i.test(
      s,
    );
    if (mentionsNdaaConference) continue;
    if (AUTH_DOES_APPROP.test(s) || APPROP_DOES_AUTH.test(s)) {
      out.push({
        check: 'D4b',
        severity: 'high',
        span: s,
        detail:
          'Sentence has one budget vehicle do the other’s job. Authorization (NDAA; HASC/SASC) sets policy/ceilings; appropriations (HAC-D/SAC-D/enacted) provide money — they are different bills and must not be blended.',
      });
    }
  }
  return out;
}

// ── D4: numeric direction self-consistency ──────────────────────────────────

const MONEY_RE = /\$\s?([\d,]+(?:\.\d+)?)\s*(b|billion|m|million|k|thousand)?\b/gi;
const DECREASE_WORDS =
  /\b(cut|cuts|reduc\w+|slash\w+|below|decreas\w+|lower\w+|trimm\w+|dropp\w+|fell|falling|shrink\w+|down\b)\b/i;
const INCREASE_WORDS =
  /\b(increas\w+|above|rais\w+|boost\w+|plus-?up|added|grew|grow\w+|higher|restor\w+|rose|rising|up\b)\b/i;
// A comparison context linking a subject figure to a baseline figure. Includes
// below/above because those double as the directional comparison itself
// ("$1.2B, below the $900M request") — no separate preposition is present there.
const COMPARISON_LINK = /\b(from|than|versus|vs\.?|compared to|below|above)\b/i;

/** Normalize a captured "$X <unit>" to USD millions (M is the funding default). */
function moneyToMillions(numStr: string, unit: string | undefined): number {
  const n = Number(numStr.replace(/,/g, ''));
  if (!Number.isFinite(n)) return NaN;
  const u = (unit ?? 'm').toLowerCase();
  if (u === 'b' || u === 'billion') return n * 1000;
  if (u === 'k' || u === 'thousand') return n / 1000;
  return n; // m / million / bare → already millions
}

/**
 * Flag a sentence whose DIRECTION WORD contradicts the numeric order of the two
 * figures it compares — the reversed-comparison class (S1-3, the ICBM figure
 * reversal that shipped to a client: "$112.9M … cut … from the $72.1M request",
 * where 112.9 > 72.1 is a RAISE, not a cut). High-precision: fires only when the
 * sentence has (a) a comparison link (from/than/vs/compared to), (b) EXACTLY one
 * direction polarity (increase XOR decrease), and (c) two parseable figures whose
 * order contradicts that polarity. Self-consistency only — no ledger needed.
 */
export function checkNumericDirection(output: string): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const s of toSentences(output)) {
    if (!COMPARISON_LINK.test(s)) continue;
    const dec = DECREASE_WORDS.test(s);
    const inc = INCREASE_WORDS.test(s);
    if (dec === inc) continue; // need exactly one polarity (0 or 2 = ambiguous)
    const figures: number[] = [];
    let m: RegExpExecArray | null;
    const re = new RegExp(MONEY_RE.source, 'gi');
    while ((m = re.exec(s)) != null) {
      const v = moneyToMillions(m[1]!, m[2]);
      if (Number.isFinite(v)) figures.push(v);
    }
    if (figures.length !== 2) continue; // exactly two figures keeps it unambiguous
    const [subject, baseline] = figures as [number, number];
    if (subject === baseline) continue;
    const actualIncrease = subject > baseline;
    const claimedIncrease = inc;
    if (actualIncrease !== claimedIncrease) {
      out.push({
        check: 'D4',
        severity: 'critical',
        span: s,
        detail: `Direction word contradicts the numbers: the sentence compares $${subject}M and $${baseline}M but calls it a ${claimedIncrease ? 'increase' : 'decrease'}. $${subject}M is ${actualIncrease ? 'ABOVE' : 'BELOW'} $${baseline}M — restate the direction from the figures, or from the source-stated signed delta.`,
      });
    }
  }
  return out;
}

// ── D6: failed / stale rule framing ──────────────────────────────────────────

// Forward-looking / operative phrasing. Deliberately excludes bare "on the
// floor" (it appears in the HONEST "failed on the floor" too); every phrase here
// is unambiguously forward-looking.
const OPERATIVE_FRAMING =
  /\b(under the rule|debate is limited|will be considered|scheduled for the floor|advancing|advances|moving to the floor|expected to pass|headed to the floor|pending floor|rule is in effect|floor consideration|the rule provides)\b/i;
// A sentence that itself acknowledges the failure/stall is HONEST — never flag it.
const FAILURE_ACKNOWLEDGMENT =
  /\b(failed|fails|failing|rejected|defeated|stalled|voted down|did not pass|not agreed to|went down|blocked)\b/i;

/**
 * Flag operative/advancing language about a bill the ledger reports as
 * rule_failed or failed — the stale/failed-rule class (S1-5/6, the H.R. 8800
 * miss). Ground truth comes from any ledger entry whose parsed result carries a
 * `status` of rule_failed/failed; if the output frames that same bill as
 * advancing, that is a critical contradiction.
 */
export function checkFailedRuleFraming(output: string, ledger: ToolResultLedger): AuditFinding[] {
  const failedBillTokens = new Set<string>();
  for (const e of ledger.entries) {
    const r = e.result as Record<string, unknown> | undefined;
    if (!r || typeof r !== 'object') continue;
    const status = typeof r.status === 'string' ? r.status : undefined;
    if (status === 'rule_failed' || status === 'failed') {
      for (const key of ['billId', 'billNumber', 'bill', 'number', 'billIdentifier']) {
        const v = r[key];
        if (typeof v === 'string' && v.trim()) failedBillTokens.add(v.trim().toLowerCase());
      }
    }
  }
  if (failedBillTokens.size === 0) return [];
  const out: AuditFinding[] = [];
  for (const s of toSentences(output)) {
    if (!OPERATIVE_FRAMING.test(s)) continue;
    // Honest failure/stall description → not a hallucination.
    if (FAILURE_ACKNOWLEDGMENT.test(s)) continue;
    const lower = s.toLowerCase();
    // The sentence must plausibly concern one of the failed bills (mentions its
    // identifier, or an H.R./S. bill number that matches a failed token).
    const concernsFailed = [...failedBillTokens].some((t) => lower.includes(t));
    if (concernsFailed) {
      out.push({
        check: 'D6',
        severity: 'critical',
        span: s,
        detail: `Bill is reported ${billStatusLabel('rule_failed')} in the tool data, but this sentence frames it as operative/advancing. A failed rule means the bill is stalled and its debate-limit/MTR provisions are NOT in effect.`,
      });
    }
  }
  return out;
}

// ── D7: procurement line item called a "Program Element" ─────────────────────

/**
 * Flag prose that calls a procurement line item a "PE" / "Program Element"
 * (S2-1). A cited code is a procurement line if its shape is a BLIN, OR a ledger
 * entry for that code carries identifierKind 'procurement_line_item' or a
 * budgetExhibitType naming a P-1 line item.
 */
export function checkIdentifierIdentity(output: string, ledger: ToolResultLedger): AuditFinding[] {
  // Codes the ledger classifies as procurement line items.
  const ledgerProcurement = new Set<string>();
  for (const e of ledger.entries) {
    collectProcurementCodes(e.result, ledgerProcurement);
  }
  const out: AuditFinding[] = [];
  for (const s of toSentences(output)) {
    // Only sentences that use the PE noun for a specific code.
    const peNoun = /\b(?:PE|Program Element)\s+((?:\d[\dA-Z]{3,})[0-9A-Z]*)\b/gi;
    let m: RegExpExecArray | null;
    while ((m = peNoun.exec(s)) != null) {
      const code = m[1]!.toUpperCase();
      const isProcurementShape = PROCUREMENT_SHAPE.test(code) && !PE_SHAPE.test(code);
      if (isProcurementShape || ledgerProcurement.has(code)) {
        out.push({
          check: 'D7',
          severity: 'high',
          span: s,
          detail: `Code ${code} is a procurement line item (P-1 exhibit), not a Program Element (the R-1/R-2 construct). Call it "procurement line item ${code}", never "PE ${code}".`,
        });
      }
    }
  }
  return out;
}

function collectProcurementCodes(result: unknown, into: Set<string>): void {
  if (!result || typeof result !== 'object') return;
  const r = result as Record<string, unknown>;
  const code = typeof r.peCode === 'string' ? r.peCode.toUpperCase() : undefined;
  const kind = typeof r.identifierKind === 'string' ? r.identifierKind : undefined;
  const exhibit = typeof r.budgetExhibitType === 'string' ? r.budgetExhibitType : undefined;
  if (code && (kind === 'procurement_line_item' || /procurement line item/i.test(exhibit ?? ''))) {
    into.add(code);
  }
  // Recurse into arrays / nested objects (search rows, detail.years, etc.).
  for (const v of Object.values(r)) {
    if (Array.isArray(v)) for (const el of v) collectProcurementCodes(el, into);
    else if (v && typeof v === 'object') collectProcurementCodes(v, into);
  }
}

// ── orchestration + verdict gate ─────────────────────────────────────────────

/** Per-surface fail policy (v3 plan §3.6) applied when mode === 'enforce'. */
function decisionFor(
  surface: AuditSurface,
  top: AuditSeverity | null,
  mode: AuditorMode,
): AuditDecision {
  if (top == null) return 'deliver';
  // Shadow + off never alter output — findings are observed only.
  if (mode === 'off' || mode === 'shadow') return 'deliver';
  if (mode === 'annotate') return 'deliver_with_flags';
  // enforce: fully-blocking surfaces hold on any finding; others repair on
  // critical/high, flag on medium/low.
  const blocking = surface === 'outreach' || surface === 'alert' || surface === 'research';
  if (blocking) return 'hold';
  return SEVERITY_RANK[top] >= SEVERITY_RANK.high ? 'repair' : 'deliver_with_flags';
}

export interface AuditInput {
  output: string;
  ledger: ToolResultLedger;
  surface: AuditSurface;
  mode: AuditorMode;
}

/**
 * Run the deterministic post-hoc auditor. Returns all findings + a decision
 * shaped by the mode and the surface fail policy. Pure: safe to call in shadow
 * mode on every turn without touching output.
 */
export function runAuditor(input: AuditInput): AuditVerdict {
  const { output, ledger, surface, mode } = input;
  if (mode === 'off' || typeof output !== 'string' || output.length === 0) {
    return { mode, surface, findings: [], topSeverity: null, decision: 'deliver' };
  }
  const findings: AuditFinding[] = [
    ...checkCitations(output, ledger),
    ...checkNumericDirection(output),
    ...checkVehicleConflation(output),
    ...checkFailedRuleFraming(output, ledger),
    ...checkIdentifierIdentity(output, ledger),
  ];
  findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  const topSeverity = findings.length ? findings[0]!.severity : null;
  return {
    mode,
    surface,
    findings,
    topSeverity,
    decision: decisionFor(surface, topSeverity, mode),
  };
}

/** Stage→vehicle helper re-exported for callers building D4/D4b context. */
export function vehicleOfStageLabel(stageLabel: string): FundingVehicle | null {
  const norm = stageLabel.toLowerCase();
  if (/hasc|sasc|ndaa|authoriz/.test(norm)) return 'authorization';
  if (/hac-?d|sac-?d|conference|enacted|appropriat/.test(norm)) return 'appropriation';
  if (/request/.test(norm)) return 'request';
  // Fall back to the shared stage map when the label is a bare stage key.
  return (FUNDING_STAGE_VEHICLE as Record<string, FundingVehicle>)[norm] ?? null;
}

/** Extract cited budget codes from output (re-export of the shared scanner). */
export const auditExtractCitedCodes = extractCitedPeCodes;
