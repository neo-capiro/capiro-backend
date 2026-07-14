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
 *   D2  quote/source-span gate  — a ≥40-char DIRECT QUOTE the line attributes
 *                                 to source material ("the report states …")
 *                                 that appears in NO tool result this turn —
 *                                 the fabricated-verbatim-quote class.
 *   D4b vehicle conflation      — an appropriations stage word attached to the
 *                                 word "authorization"/"NDAA" (or vice versa).
 *   D6  failed-rule framing     — operative/advancing language about a bill the
 *                                 ledger reports as rule_failed / failed.
 *   D7  LI-as-PE                — prose calling a procurement line item (BLIN
 *                                 shape, or ledger identifierKind) a "Program
 *                                 Element / PE".
 *   D11 member↔district         — a district asserted as a representation mapping
 *                                 that get_representation/resolve_entity did not
 *                                 return this turn (the S3-1 fabrication class).
 *   D9  plus-up attribution     — a plus-up $ figure credited to a PE whose
 *                                 recorded mark-vs-request delta doesn't match it
 *                                 (names the sibling it fits — the S2-11 class).
 *   D3  unit magnitude          — a dollar figure off from the PE's recorded
 *                                 amount by ~1000x or ~1,000,000x (a thousands/
 *                                 millions unit swap).
 *   D8  primary-vehicle overclaim — a "primary" framing when a same-FY sibling
 *                                 PE is materially (3x) larger (auditor-level
 *                                 port of RC1's validatePrimaryVehicleClaim).
 *   D5  sponsor existence       — a claimed bill sponsor that doesn't match
 *                                 get_bill_status's recorded sponsor (S1-9).
 *   D10 stale as-of date        — an explicit "as of DATE" citation staler than
 *                                 the ledger's own status date for that bill.
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
  billStatusRank,
  extractCitedPeCodes,
  validateFormBCitations,
  type FundingVehicle,
} from '@capiro/shared';
import { compilePeFundingEvidence, type EvidencePacket, type FundingYearRecord } from './evidence';

export type AuditorMode = 'off' | 'shadow' | 'annotate' | 'enforce';
export type AuditSeverity = 'critical' | 'high' | 'medium' | 'low';
export type AuditSurface = 'chat' | 'research' | 'outreach' | 'memo' | 'alert';

/** Per-tenant override key under tenants.settings_jsonb.clioFeatureFlags. */
export const MERI_AUDITOR_MODE_FLAG = 'meriAuditorMode' as const;
const AUDITOR_MODES: readonly AuditorMode[] = ['off', 'shadow', 'annotate', 'enforce'];

/**
 * Effective auditor mode for a tenant. A per-tenant override in
 * settings_jsonb.clioFeatureFlags.meriAuditorMode (one of the AuditorMode
 * values) WINS over the global env mode; anything else falls back to envMode.
 * Pure — the caller supplies the tenant's settings object (no I/O here).
 *
 * Override-wins works BOTH directions: hold a noisy tenant on 'shadow' while
 * the global env is 'enforce', or canary a single tenant to 'enforce'/'annotate'
 * while the global stays 'shadow'. Lives in @capiro/meriv2-core (AuditorMode's
 * home) so both apps/api and the orchestrator can import it — NOT in apps/api's
 * tenant-flags.ts, which the orchestrator cannot import.
 */
export function resolveAuditorMode(envMode: AuditorMode, settings: unknown): AuditorMode {
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
    const flags = (settings as Record<string, unknown>).clioFeatureFlags;
    if (flags && typeof flags === 'object' && !Array.isArray(flags)) {
      const v = (flags as Record<string, unknown>)[MERI_AUDITOR_MODE_FLAG];
      if (typeof v === 'string' && (AUDITOR_MODES as readonly string[]).includes(v)) {
        return v as AuditorMode;
      }
    }
  }
  return envMode;
}

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
export function toSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Split text into LINES only (no period-based splitting). `toSentences`'s
 * period-boundary split misreads an abbreviation period ("Rep." / "Sen.") as a
 * sentence end, severing a sponsor claim from the name that follows it on the
 * same line — checks that must see a title + name together use this instead.
 */
export function toLines(text: string): string[] {
  return text
    .split(/\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export const SEVERITY_RANK: Record<AuditSeverity, number> = {
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

// ── D2: quote/source-span gate ────────────────────────────────────────────────

// The line must ATTRIBUTE the quote to source material — an attribution verb or
// a document noun — so rhetorical/scare quotes and coined terms never fire.
// Precision-first: this list is deliberately narrow.
const QUOTE_ATTRIBUTION_CUE =
  /\b(?:according to|state[sd]?|read[s]?|note[sd]?|write[s]?|say[s]?|said|quot(?:e[sd]?|ing)|provides? that|directs? that|report language|bill text|committee report|the (?:report|bill|statute|provision|transcript|testimony|language|text|memo|amendment))\b/i;

/** Straighten smart quotes/apostrophes + collapse whitespace for span matching. */
function normalizeQuoteSpan(s: string): string {
  return s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();
}

// A double-quoted span long enough to be a real source quote, not an idiom.
// 40–600 chars: below 40 is coined-term territory; above 600 is a block quote
// the model would have paraphrased anyway.
const QUOTED_SPAN_RE = /[“"]([^“”"]{40,600})[”"]/g;

/**
 * Flag a long direct quote the line attributes to source material when the
 * quoted span appears (whitespace/case-normalized) in NO tool result captured
 * this turn — the fabricated-verbatim-quote class the v3 plan's registry calls
 * the "quote/source-span gate". Skips entirely when the ledger is empty
 * (nothing to verify against ⇒ fabrication is unprovable, stay silent).
 */
export function checkQuoteSpans(output: string, ledger: ToolResultLedger): AuditFinding[] {
  if (ledger.entries.length === 0) return [];
  const corpus = normalizeQuoteSpan(ledger.entries.map((e) => e.serialized).join('\n'));
  if (corpus.length === 0) return [];
  const findings: AuditFinding[] = [];
  for (const line of toLines(output)) {
    if (!QUOTE_ATTRIBUTION_CUE.test(line)) continue;
    for (const m of line.matchAll(QUOTED_SPAN_RE)) {
      const span = m[1]!.trim();
      // A span carrying a FORM-B token is D1's jurisdiction, not a quote.
      if (!span || span.includes('[S:')) continue;
      if (!corpus.includes(normalizeQuoteSpan(span))) {
        findings.push({
          check: 'D2',
          severity: 'high',
          span: m[0]!.slice(0, 200),
          detail:
            'Quoted span attributed to source material does not appear in any tool result this turn — the quote cannot be verified and may be fabricated. Paraphrase with a citation, or quote the retrieved text verbatim.',
        });
      }
    }
  }
  return findings;
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

// ── D11: member ↔ district mapping ───────────────────────────────────────────

// A congressional district token: 2-letter state + dash + number, or -AL (at-large).
const DISTRICT_RE = /\b([A-Z]{2})-(\d{1,2}|AL)\b/g;
const REPRESENTS_RE = /\b(represent(?:s|ing|ed)?|constituent|district|represents the)\b/i;

/**
 * Flag a member↔district mapping asserted in prose whose district was NOT
 * affirmatively returned by get_representation / resolve_entity this turn — the
 * S3-1 hazard (a district inferred from a roster, which carries no district, or
 * fabricated outright). Fires only when a district token co-occurs with a
 * representation verb AND that district is absent from the turn's representation
 * results; if no representation tool was called at all, any asserted district is
 * ungrounded. Deterministic joins only — never an inference.
 */
export function checkMemberDistrict(output: string, ledger: ToolResultLedger): AuditFinding[] {
  const grounded = new Set<string>();
  let representationCalled = false;
  for (const e of ledger.entries) {
    if (e.tool !== 'get_representation' && e.tool !== 'resolve_entity') continue;
    representationCalled = true;
    for (const m of e.serialized.matchAll(DISTRICT_RE)) grounded.add(m[0].toUpperCase());
  }
  const out: AuditFinding[] = [];
  for (const s of toSentences(output)) {
    if (!REPRESENTS_RE.test(s)) continue;
    const districts = [...new Set([...s.matchAll(DISTRICT_RE)].map((m) => m[0].toUpperCase()))];
    for (const d of districts) {
      if (grounded.has(d)) continue;
      out.push({
        check: 'D11',
        severity: 'critical',
        span: s,
        detail: representationCalled
          ? `District ${d} is asserted as a representation mapping, but get_representation/resolve_entity did not return ${d} this turn.`
          : `District ${d} is asserted as a representation mapping, but no get_representation/resolve_entity lookup was made this turn — member↔district must come from that deterministic join (a roster carries no district), never an inference.`,
      });
    }
  }
  return out;
}

// ── D4 (evidence-backed): direction vs the compiled EvidencePackets ──────────

// Furthest-along appropriations stage wins as "the current authoritative figure".
const STAGE_RANK_EV: Record<string, number> = {
  enacted: 6,
  conference: 5,
  'SAC-D': 4,
  'HAC-D': 3,
  SASC: 2,
  HASC: 1,
  request: 0,
};
const FUNDING_CUE = /\$|\b(fund\w*|mark|request|appropriat\w+|budget|million|billion)\b/i;

/** Compile EvidencePackets from any get_pe_budget_timeline-shaped ledger entry. */
function compilePacketsFromLedger(ledger: ToolResultLedger): EvidencePacket[] {
  const out: EvidencePacket[] = [];
  for (const e of ledger.entries) {
    const r = e.result as Record<string, unknown> | undefined;
    if (!r || typeof r !== 'object') continue;
    const peCode = typeof r.peCode === 'string' ? r.peCode : undefined;
    const years = Array.isArray(r.years) ? (r.years as FundingYearRecord[]) : undefined;
    if (!peCode || !years) continue;
    try {
      out.push(
        ...compilePeFundingEvidence({
          peCode,
          identifierKind:
            r.identifierKind === 'procurement_line_item'
              ? 'procurement_line_item'
              : r.identifierKind === 'pe'
                ? 'pe'
                : undefined,
          capturedAt: typeof r.generatedAt === 'string' ? r.generatedAt : '',
          currentCycleFy: typeof r.currentCycleFy === 'number' ? r.currentCycleFy : undefined,
          years,
        }),
      );
    } catch {
      // A malformed timeline payload is skipped, never fatal.
    }
  }
  return out;
}

/** peCode → the current-cycle AUTHORITATIVE mark's source-derived direction. */
function authoritativeDirectionByPe(
  packets: EvidencePacket[],
): Map<string, 'increase' | 'decrease' | 'flat'> {
  const best = new Map<string, { rank: number; dir: 'increase' | 'decrease' | 'flat' }>();
  for (const p of packets) {
    if (p.semantics.cycle !== 'current' || !p.semantics.comparison) continue;
    const rank = p.semantics.stage ? (STAGE_RANK_EV[p.semantics.stage] ?? -1) : -1;
    const cur = best.get(p.entity.entityId);
    if (!cur || rank > cur.rank) {
      best.set(p.entity.entityId, { rank, dir: p.semantics.comparison.direction });
    }
  }
  const out = new Map<string, 'increase' | 'decrease' | 'flat'>();
  for (const [pe, v] of best) out.set(pe, v.dir);
  return out;
}

/**
 * Evidence-backed D4: for a sentence that names exactly one PE (with a known
 * current-cycle authoritative comparison in the ledger), carries a funding cue,
 * and uses exactly one direction polarity, flag when that polarity contradicts
 * the PE's SOURCE-DERIVED direction. Catches the IMPLICIT reversal ("PE X's
 * funding was cut") that the text-only D4 can't — it re-derives truth from the
 * compiled EvidencePackets rather than from two numbers in the sentence.
 */
export function checkFundingDirectionVsEvidence(
  output: string,
  ledger: ToolResultLedger,
): AuditFinding[] {
  const dirByPe = authoritativeDirectionByPe(compilePacketsFromLedger(ledger));
  if (dirByPe.size === 0) return [];
  const out: AuditFinding[] = [];
  for (const s of toSentences(output)) {
    if (!FUNDING_CUE.test(s)) continue;
    const dec = DECREASE_WORDS.test(s);
    const inc = INCREASE_WORDS.test(s);
    if (dec === inc) continue; // need exactly one polarity
    const codes = extractCitedPeCodes(s).filter((c) => dirByPe.has(c));
    if (codes.length !== 1) continue; // exactly one PE with known evidence → unambiguous
    const pe = codes[0]!;
    const evidenceDir = dirByPe.get(pe)!;
    if (evidenceDir === 'flat') continue;
    const claimedIncrease = inc;
    if ((evidenceDir === 'increase') !== claimedIncrease) {
      out.push({
        check: 'D4',
        severity: 'critical',
        span: s,
        detail: `${pe}'s current authoritative figure is ${evidenceDir} vs the request per the tool data, but this sentence calls it a ${claimedIncrease ? 'increase' : 'decrease'}. Restate the direction from the source.`,
      });
    }
  }
  return out;
}

// ── D9: plus-up attributed to the wrong PE ───────────────────────────────────

const PLUSUP_RE =
  /\b(plus-?up|plused|added|boost(?:ed)?|increase of|increased by|addition of|added to)\b/i;

/** peCode → current-cycle authoritative SIGNED delta (mark − request), $M. */
function authoritativeDeltaByPe(packets: EvidencePacket[]): Map<string, number> {
  const best = new Map<string, { rank: number; delta: number }>();
  for (const p of packets) {
    if (p.semantics.cycle !== 'current' || !p.semantics.comparison) continue;
    const rank = p.semantics.stage ? (STAGE_RANK_EV[p.semantics.stage] ?? -1) : -1;
    const cur = best.get(p.entity.entityId);
    if (!cur || rank > cur.rank) {
      best.set(p.entity.entityId, { rank, delta: p.semantics.comparison.delta });
    }
  }
  const out = new Map<string, number>();
  for (const [pe, v] of best) out.set(pe, v.delta);
  return out;
}

/**
 * Flag a plus-up dollar figure attributed to a PE whose recorded mark-vs-request
 * delta does NOT match it — the wrong-PE plus-up class (S2-11). Fires only on a
 * plus-up sentence with EXACTLY one PE (with a ledger comparison) and EXACTLY one
 * dollar figure whose magnitude is off the PE's actual |delta| beyond tolerance;
 * if a SIBLING PE's delta matches the figure, it is named (the plus-up likely
 * belongs there). Precision-first: abstains on any ambiguity.
 */
export function checkPlusUpAttribution(output: string, ledger: ToolResultLedger): AuditFinding[] {
  const deltaByPe = authoritativeDeltaByPe(compilePacketsFromLedger(ledger));
  if (deltaByPe.size === 0) return [];
  const out: AuditFinding[] = [];
  for (const s of toSentences(output)) {
    if (!PLUSUP_RE.test(s)) continue;
    const codes = extractCitedPeCodes(s).filter((c) => deltaByPe.has(c));
    if (codes.length !== 1) continue;
    const figures: number[] = [];
    const re = new RegExp(MONEY_RE.source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) != null) {
      const v = moneyToMillions(m[1]!, m[2]);
      if (Number.isFinite(v)) figures.push(v);
    }
    if (figures.length !== 1) continue;
    const claimed = Math.abs(figures[0]!);
    const pe = codes[0]!;
    const actual = Math.abs(deltaByPe.get(pe)!);
    const tol = Math.max(1, actual * 0.05);
    if (Math.abs(claimed - actual) <= tol) continue; // matches → fine
    const sibling = [...deltaByPe.entries()].find(
      ([c, d]) => c !== pe && Math.abs(Math.abs(d) - claimed) <= Math.max(1, Math.abs(d) * 0.05),
    );
    out.push({
      check: 'D9',
      severity: 'high',
      span: s,
      detail: `A $${claimed}M plus-up is attributed to ${pe}, but ${pe}'s recorded mark-vs-request delta is $${actual}M${
        sibling ? ` — $${claimed}M matches ${sibling[0]} instead` : ''
      }. Verify the attribution before crediting this PE.`,
    });
  }
  return out;
}

// ── shared: current-cycle authoritative amount per PE (D3 + D8) ──────────────

/** peCode → {fy, amount} of the current-cycle authoritative mark, $M. */
function authoritativeAmountByPe(
  packets: EvidencePacket[],
): Map<string, { fy: number; amount: number }> {
  const best = new Map<string, { rank: number; fy: number; amount: number }>();
  for (const p of packets) {
    if (p.semantics.cycle !== 'current' || !p.semantics.amount) continue;
    const rank = p.semantics.stage ? (STAGE_RANK_EV[p.semantics.stage] ?? -1) : -1;
    const cur = best.get(p.entity.entityId);
    if (!cur || rank > cur.rank) {
      best.set(p.entity.entityId, {
        rank,
        fy: p.semantics.fiscalYear ?? 0,
        amount: p.semantics.amount.value,
      });
    }
  }
  const out = new Map<string, { fy: number; amount: number }>();
  for (const [pe, v] of best) out.set(pe, { fy: v.fy, amount: v.amount });
  return out;
}

// ── D3: unit-magnitude mismatch ───────────────────────────────────────────────

// A claimed figure off from the recorded amount by ~1000x (thousands<->millions)
// or ~1,000,000x (ones<->millions) is the classic unit-swap bug, not a different
// fact. 2% tolerance around the round magnitude keeps this from ever firing on a
// merely-different (but correctly-scaled) number.
const MAGNITUDES = [1000, 1_000_000];

/**
 * Flag a dollar figure whose magnitude relative to the PE's recorded current-
 * cycle amount is off by ~1000x or ~1,000,000x — a thousands/millions or
 * ones/millions unit-swap. Fires only on a funding-cue sentence naming EXACTLY
 * one ledger-known PE and carrying EXACTLY one dollar figure; a genuinely
 * different (correctly-scaled) number never sits this close to a round power of
 * 1000, so this is high-precision by construction.
 */
export function checkUnitMagnitude(output: string, ledger: ToolResultLedger): AuditFinding[] {
  const amtByPe = authoritativeAmountByPe(compilePacketsFromLedger(ledger));
  if (amtByPe.size === 0) return [];
  const out: AuditFinding[] = [];
  for (const s of toSentences(output)) {
    if (!FUNDING_CUE.test(s)) continue;
    const codes = extractCitedPeCodes(s).filter((c) => amtByPe.has(c));
    if (codes.length !== 1) continue;
    const figures: number[] = [];
    const re = new RegExp(MONEY_RE.source, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) != null) {
      const v = moneyToMillions(m[1]!, m[2]);
      if (Number.isFinite(v)) figures.push(v);
    }
    if (figures.length !== 1) continue;
    const claimed = figures[0]!;
    const pe = codes[0]!;
    const actual = amtByPe.get(pe)!.amount;
    if (actual <= 0 || claimed <= 0) continue;
    const ratio = claimed / actual;
    for (const mag of MAGNITUDES) {
      const offByMag = Math.abs(ratio - mag) / mag <= 0.02;
      const offByInverse = Math.abs(ratio - 1 / mag) / (1 / mag) <= 0.02;
      if (offByMag || offByInverse) {
        out.push({
          check: 'D3',
          severity: 'high',
          span: s,
          detail: `This figure parses to $${claimed}M, off from ${pe}'s recorded current-cycle amount ($${actual}M) by roughly a factor of ${mag} — check for a thousands/millions unit mismatch before restating it.`,
        });
        break;
      }
    }
  }
  return out;
}

// ── D8: primary-vehicle overclaim (auditor-level port of RC1's structural check) ─

const PRIMARY_CLAIM_RE_A = /\bprimary\b[^.]*\b(vehicle|lane|line|account|program)\b/i;
const PRIMARY_CLAIM_RE_B = /\b(vehicle|lane|line|account|program)\b[^.]*\bprimary\b/i;

/**
 * Flag a "primary funding vehicle" overclaim: the sentence calls a PE the
 * "primary" lane, but the ledger's compiled EvidencePackets show a SAME-FISCAL-
 * YEAR sibling PE that is materially larger (3x by default, matching RC1's
 * `validatePrimaryVehicleClaim`). Fires only on a primary-framing sentence
 * naming EXACTLY one ledger-known PE; names the larger sibling.
 */
export function checkPrimaryVehicleOverclaim(
  output: string,
  ledger: ToolResultLedger,
  factor = 3,
): AuditFinding[] {
  const amtByPe = authoritativeAmountByPe(compilePacketsFromLedger(ledger));
  if (amtByPe.size < 2) return [];
  const out: AuditFinding[] = [];
  for (const s of toSentences(output)) {
    if (!(PRIMARY_CLAIM_RE_A.test(s) || PRIMARY_CLAIM_RE_B.test(s))) continue;
    const codes = extractCitedPeCodes(s).filter((c) => amtByPe.has(c));
    if (codes.length !== 1) continue;
    const pe = codes[0]!;
    const { fy, amount } = amtByPe.get(pe)!;
    if (amount <= 0) continue;
    const bigger = [...amtByPe.entries()]
      .filter(([c, v]) => c !== pe && v.fy === fy && v.amount > amount * factor)
      .sort((a, b) => b[1].amount - a[1].amount);
    if (!bigger.length) continue;
    const [siblingPe, siblingV] = bigger[0]!;
    out.push({
      check: 'D8',
      severity: 'high',
      span: s,
      detail: `The sentence frames ${pe} as the "primary" vehicle, but ${siblingPe} is materially larger in the same fiscal year ($${siblingV.amount}M vs $${amount}M) per the tool data. Drop the "primary" framing or re-anchor to the larger line.`,
    });
  }
  return out;
}

// ── D5: sponsor entity existence ──────────────────────────────────────────────

const SPONSOR_CLAIM_RE =
  /\bsponsor(?:ed)?\s*(?:is|:|,|by)?\s+((?:Rep\.|Sen\.|Representative|Senator)?\s*[A-Z][a-zA-Z'.-]+(?:\s+[A-Z][a-zA-Z'.-]+){0,3})/i;

function normalizeSponsorName(x: string): string {
  return x
    .replace(/\b(rep|sen|representative|senator)\b\.?/gi, '')
    .replace(/[(),.]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** billId → sponsor name, from any get_bill_status-shaped ledger entry. */
function billSponsorFromLedger(ledger: ToolResultLedger): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of ledger.entries) {
    const r = e.result as Record<string, unknown> | undefined;
    if (!r || typeof r !== 'object') continue;
    const billId = typeof r.billId === 'string' ? r.billId : undefined;
    if (!billId) continue;
    const sponsorObj = r.sponsor as Record<string, unknown> | undefined;
    const name =
      sponsorObj && typeof sponsorObj === 'object' && typeof sponsorObj.name === 'string'
        ? sponsorObj.name
        : typeof r.sponsorName === 'string'
          ? r.sponsorName
          : undefined;
    if (name && name.trim()) out.set(billId, name.trim());
  }
  return out;
}

/**
 * Flag a claimed bill sponsor that doesn't match get_bill_status's recorded
 * sponsor (S1-9). Fires only on a sentence carrying BOTH an explicit sponsor
 * claim ("sponsor: NAME" / "sponsored by NAME") AND a ledger-known billId token
 * verbatim; normalizes titles/punctuation and allows either-direction
 * containment (a last-name-only claim still matches) before flagging.
 */
export function checkSponsorExistence(output: string, ledger: ToolResultLedger): AuditFinding[] {
  const billSponsor = billSponsorFromLedger(ledger);
  if (billSponsor.size === 0) return [];
  const out: AuditFinding[] = [];
  // Lines, not toSentences: "Rep." / "Sen." abbreviation periods would
  // otherwise sever the claimed name from the sentence carrying it.
  for (const s of toLines(output)) {
    const m = SPONSOR_CLAIM_RE.exec(s);
    if (!m) continue;
    const lower = s.toLowerCase();
    const billId = [...billSponsor.keys()].find((id) => lower.includes(id.toLowerCase()));
    if (!billId) continue;
    const claimed = normalizeSponsorName(m[1]!);
    const actualRaw = billSponsor.get(billId)!;
    const actual = normalizeSponsorName(actualRaw);
    if (claimed.length < 3 || actual.length < 3) continue;
    if (claimed.includes(actual) || actual.includes(claimed)) continue; // matches
    out.push({
      check: 'D5',
      severity: 'high',
      span: s,
      detail: `Sponsor claimed as "${m[1]!.trim()}", but the tool data lists "${actualRaw}" as the sponsor of ${billId}.`,
    });
  }
  return out;
}

// ── D10: stale as-of date ─────────────────────────────────────────────────────

const AS_OF_DATE_RE = /\bas of\s+(\d{4}-\d{2}-\d{2})\b/i;

/** billId → statusAt/asOf date string, from any get_bill_status-shaped ledger entry. */
function billStatusAtFromLedger(ledger: ToolResultLedger): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of ledger.entries) {
    const r = e.result as Record<string, unknown> | undefined;
    if (!r || typeof r !== 'object') continue;
    const billId = typeof r.billId === 'string' ? r.billId : undefined;
    const statusAt =
      typeof r.statusAt === 'string' ? r.statusAt : typeof r.asOf === 'string' ? r.asOf : undefined;
    if (billId && statusAt) out.set(billId, statusAt);
  }
  return out;
}

/**
 * Flag an explicit "(as of YYYY-MM-DD)" citation that is STALER than the
 * ledger's actual status date for the same bill — a freshness violation, never
 * a mere style choice. Fires only when the sentence (a) states an explicit
 * as-of date, (b) carries a ledger-known billId token verbatim, and (c) that
 * date is strictly earlier than the ledger's own statusAt/asOf for that bill.
 * Silent on sentences with no explicit as-of date (no recall claimed there).
 */
export function checkAsOfFreshness(output: string, ledger: ToolResultLedger): AuditFinding[] {
  const billAsOf = billStatusAtFromLedger(ledger);
  if (billAsOf.size === 0) return [];
  const out: AuditFinding[] = [];
  for (const s of toSentences(output)) {
    const m = AS_OF_DATE_RE.exec(s);
    if (!m) continue;
    const stated = m[1]!;
    const lower = s.toLowerCase();
    const billId = [...billAsOf.keys()].find((id) => lower.includes(id.toLowerCase()));
    if (!billId) continue;
    const actual = billAsOf.get(billId)!.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(actual)) continue; // can't compare reliably
    if (stated >= actual) continue; // same or newer → fine
    out.push({
      check: 'D10',
      severity: 'medium',
      span: s,
      detail: `This sentence cites ${billId} as of ${stated}, but the tool data has a newer status as of ${actual}. Re-query before stating an as-of date older than the latest retrieved status.`,
    });
  }
  return out;
}

// ── D12: enactment-proof ─────────────────────────────────────────────────────

/** billId → canonical status, from any get_bill_status-shaped ledger entry. */
function billStatusFromLedger(ledger: ToolResultLedger): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of ledger.entries) {
    const r = e.result as Record<string, unknown> | undefined;
    if (!r || typeof r !== 'object') continue;
    const billId = typeof r.billId === 'string' ? r.billId : undefined;
    const status = typeof r.status === 'string' ? r.status : undefined;
    if (billId && status) out.set(billId, status);
  }
  return out;
}

const ENACTMENT_CLAIM_RE =
  /\b(enacted(?:\s+into\s+law)?|became\s+(?:public\s+)?law|signed\s+into\s+law|public\s+law|signed\s+by\s+(?:the\s+)?president)\b/i;
// Hedged / negated enactment talk is honest description, not a claim of enactment.
const ENACTMENT_HEDGE_RE =
  /\b(not\s+(?:yet\s+)?enacted|if\s+enacted|once\s+enacted|would\s+be(?:come)?|pending|awaiting|has\s+not|hasn't|not\s+yet|prior\s+to\s+enactment|before\s+(?:it\s+)?(?:is|becomes))\b/i;

/**
 * D12 (enactment-proof, safe form): flag a sentence asserting a bill is enacted /
 * became law when get_bill_status recorded that SAME bill at a non-enacted
 * status. Enactment is the terminal, signed-into-law rung; claiming it without
 * that status is the highest-stakes status overclaim (a client acting on "it's
 * law" is materially misled). Precision-first: fires ONLY when a ledger-known
 * billId token appears verbatim AND its recorded status !== 'enacted', and never
 * on hedged/negated enactment talk.
 *
 * NOTE: the blueprint's stricter form ("require a structured public-law id + date
 * field before the 'enacted' label") needs a get_bill_status contract carrying
 * publicLawId/enactedAt — those fields don't exist yet, so that presence-check is
 * deferred to a ledger-contract extension. This status-contradiction form is the
 * deterministic slice buildable today.
 */
export function checkEnactmentProof(output: string, ledger: ToolResultLedger): AuditFinding[] {
  const billStatus = billStatusFromLedger(ledger);
  if (billStatus.size === 0) return [];
  const out: AuditFinding[] = [];
  for (const s of toSentences(output)) {
    if (!ENACTMENT_CLAIM_RE.test(s)) continue;
    if (ENACTMENT_HEDGE_RE.test(s)) continue;
    const lower = s.toLowerCase();
    for (const [billId, status] of billStatus) {
      if (status === 'enacted') continue;
      if (!lower.includes(billId.toLowerCase())) continue;
      out.push({
        check: 'D12',
        severity: 'critical',
        span: s,
        detail: `This sentence asserts ${billId} is enacted / became law, but the tool data records it at ${billStatusLabel(status)}. Enactment is the terminal signed-into-law stage — do not state it without an 'enacted' status.`,
      });
    }
  }
  return out;
}

// ── D13: legislative-stage ordering ──────────────────────────────────────────

// Prose milestones → the canonical BillStatus they claim. Past-tense phrasing
// keeps hypotheticals ("if it passes the House") from matching. Enactment is
// left to D12 (it owns the terminal rung); D13 covers mid-ladder over-advancement.
const STAGE_PHRASE_RANK: Array<[RegExp, string]> = [
  [
    /\bpassed\s+(?:the\s+)?(?:house|senate|chamber)\b|\bcleared\s+the\s+(?:house|senate)\b/i,
    'passed_chamber',
  ],
  [
    /\bin\s+conference\b|\bconference\s+(?:committee|report)\b|\bresolving\s+differences\b/i,
    'resolving',
  ],
  [
    /\bsent\s+to\s+the\s+president\b|\bheaded\s+to\s+the\s+president\b|\bto\s+the\s+president'?s?\s+desk\b|\bawaiting\s+the\s+president'?s?\s+signature\b/i,
    'to_president',
  ],
];

/**
 * D13 (stage-ordering): flag a sentence placing a bill FURTHER along the
 * legislative ladder than get_bill_status recorded. Deterministic rank compare
 * (mirrors D10's date compare): fires ONLY when a ledger-known billId token
 * appears verbatim AND the max stage claimed in that sentence strictly outranks
 * the bill's recorded status. Enactment overclaims route to D12, not here.
 */
export function checkStageOrdering(output: string, ledger: ToolResultLedger): AuditFinding[] {
  const billStatus = billStatusFromLedger(ledger);
  if (billStatus.size === 0) return [];
  const out: AuditFinding[] = [];
  for (const s of toSentences(output)) {
    let claimedRank = -1;
    let claimedStatus = '';
    for (const [re, status] of STAGE_PHRASE_RANK) {
      if (re.test(s)) {
        const r = billStatusRank(status);
        if (r > claimedRank) {
          claimedRank = r;
          claimedStatus = status;
        }
      }
    }
    if (claimedRank < 0) continue;
    const lower = s.toLowerCase();
    for (const [billId, status] of billStatus) {
      if (!lower.includes(billId.toLowerCase())) continue;
      const ledgerRank = billStatusRank(status);
      if (claimedRank > ledgerRank) {
        out.push({
          check: 'D13',
          severity: 'high',
          span: s,
          detail: `This sentence places ${billId} at ${billStatusLabel(claimedStatus)} (stage ${claimedRank}), but the tool data records it only at ${billStatusLabel(status)} (stage ${ledgerRank}). Do not describe a bill as further along than its retrieved status.`,
        });
      }
    }
  }
  return out;
}

// ── D14: negative-assertion (narrow ledger-contradiction slice) ──────────────

const NO_SPONSOR_RE = /\b(no\s+sponsor|unsponsored|has\s+no\s+sponsor|without\s+a\s+sponsor)\b/i;

/**
 * D14 (negative-assertion, NARROW slice only): flag a negative/absence claim
 * that the ledger's PRESENT data directly contradicts — here, "no sponsor" for a
 * bill get_bill_status actually gives a sponsor for. Precision-first and
 * abstention-first: it fires ONLY on contradiction-of-present-rows, NEVER on
 * absence of evidence.
 *
 * The GENERAL negative-assertion / coverage-completeness form ("is retrieval
 * complete enough to assert a negative?") is deliberately NOT implemented: a
 * "there are no X" claim is unprovable from partial retrieval, and the v3 plan
 * routes that class (S3-3/4/5) to the LLM skeptic. A deterministic attempt would
 * mis-fire or give false confidence.
 */
export function checkNegativeAssertion(output: string, ledger: ToolResultLedger): AuditFinding[] {
  const billSponsor = billSponsorFromLedger(ledger);
  if (billSponsor.size === 0) return [];
  const out: AuditFinding[] = [];
  for (const s of toLines(output)) {
    if (!NO_SPONSOR_RE.test(s)) continue;
    const lower = s.toLowerCase();
    for (const [billId, sponsor] of billSponsor) {
      if (!lower.includes(billId.toLowerCase())) continue;
      out.push({
        check: 'D14',
        severity: 'high',
        span: s,
        detail: `This sentence asserts ${billId} has no sponsor, but the tool data lists "${sponsor}" as its sponsor.`,
      });
    }
  }
  return out;
}

// ── orchestration + verdict gate ─────────────────────────────────────────────

/**
 * Per-surface fail policy (v3 plan §3.6) applied when mode === 'enforce'.
 * Exported so the skeptic-audit merge (skeptic-audit.ts) re-derives the SAME
 * decision after appending SK findings — one policy, never two.
 */
export function auditDecisionFor(
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
  const raw: AuditFinding[] = [
    ...checkCitations(output, ledger),
    ...checkQuoteSpans(output, ledger),
    ...checkNumericDirection(output),
    ...checkFundingDirectionVsEvidence(output, ledger),
    ...checkVehicleConflation(output),
    ...checkFailedRuleFraming(output, ledger),
    ...checkIdentifierIdentity(output, ledger),
    ...checkMemberDistrict(output, ledger),
    ...checkPlusUpAttribution(output, ledger),
    ...checkUnitMagnitude(output, ledger),
    ...checkPrimaryVehicleOverclaim(output, ledger),
    ...checkSponsorExistence(output, ledger),
    ...checkAsOfFreshness(output, ledger),
    ...checkEnactmentProof(output, ledger),
    ...checkStageOrdering(output, ledger),
    ...checkNegativeAssertion(output, ledger),
  ];
  // Dedupe by (check, span): the text-D4 and evidence-D4 can both fire on one
  // sentence — the reader/ledger should see it once.
  const seen = new Set<string>();
  const findings = raw.filter((f) => {
    const key = `${f.check}::${f.span}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  const topSeverity = findings.length ? findings[0]!.severity : null;
  return {
    mode,
    surface,
    findings,
    topSeverity,
    decision: auditDecisionFor(surface, topSeverity, mode),
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
