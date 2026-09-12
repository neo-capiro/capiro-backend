/**
 * Deterministic government-affairs claim verification (Phase 1 §3.i1).
 *
 * Runs on the FINISHED draft, before the Meri grounding auditor, and every check
 * is ordinary code — no model judges another model here. That matters because the
 * failures this catches are systematic rather than random: an LLM that confuses
 * an authorization ceiling with an enacted appropriation does it consistently and
 * fluently, so a second LLM asked "does this look right?" frequently agrees.
 * Comparing "$4.2 billion" against the actual PE funding series does not.
 *
 * Ten checks, each mapping to a real government-affairs failure mode, always
 * run — there is no longer a per-audience policy that enables a subset of them:
 *
 *   1  unresolved placeholder      — {district} shipped to a member's office
 *   2  numeric grounding          — a dollar figure absent from the truth series
 *   3  bill identifier grounding  — a bill number nobody selected
 *   4  enactment claim            — "now law" for a bill that passed one chamber
 *   5  authorization vs appropriation — the single most consequential DoD error
 *   6  recipient commitment       — "your support for" with no evidence
 *   7  attendance claim           — "as you said at the meeting" for an invite
 *   8  date grounding             — an invented markup date
 *   9  stale source caveat        — a four-month-old status stated as current
 *   10 group common facts         — one member's committee ascribed to all
 *
 * Classification (supported / partially_supported / inference / unsupported /
 * contradicted / stale) and the blocking rules are the plan's, verbatim.
 */
import { Injectable } from '@nestjs/common';
import type { EvidencePacketV2 } from './evidence-packet.types.js';
import { freshnessThresholdDays } from './evidence-freshness.js';
import type { MessagePlan } from './message-plan.schema.js';

/** Deterministic validator ids the verifier runs. */
export type GaValidatorId =
  | 'unresolved_placeholder'
  | 'numeric_grounding'
  | 'bill_identifier_grounding'
  | 'enactment_claim'
  | 'authorization_vs_appropriation'
  | 'recipient_commitment_claim'
  | 'attendance_claim'
  | 'date_grounding'
  | 'stale_source_caveat'
  | 'group_common_facts';

export type ClaimClassification =
  | 'supported'
  | 'partially_supported'
  | 'inference'
  | 'unsupported'
  | 'contradicted'
  | 'stale';

export interface VerifierFinding {
  /** Distinguishes these from Meri auditor findings in the same array (§3.i2). */
  source: 'deterministic_verifier';
  check: GaValidatorId;
  classification: ClaimClassification;
  /** True when this finding alone makes the draft non-sendable. */
  blocking: boolean;
  /** Whether the claim is material (factual) or stylistic. */
  material: boolean;
  message: string;
  /** The offending excerpt, bounded. */
  excerpt?: string;
}

export interface VerifyRequest {
  subject: string;
  body: string;
  packet: EvidencePacketV2;
  /** The validated plan, when one was produced. */
  plan?: MessagePlan | null;
  audienceKind: 'individual' | 'group';
  now: Date;
}

export interface VerifyResult {
  findings: VerifierFinding[];
  /** 'passed' | 'warning' | 'held' — mirrors the Phase 0 audit vocabulary. */
  status: 'passed' | 'warning' | 'held';
  /** True when any blocking finding fired. */
  held: boolean;
}

@Injectable()
export class GenerationVerifierService {
  verify(request: VerifyRequest): VerifyResult {
    const text = `${request.subject}\n${request.body}`;
    const findings: VerifierFinding[] = [
      ...checkPlaceholders(text),
      ...checkNumbers(text, request),
      ...checkBillIdentifiers(text, request),
      ...checkEnactment(text, request),
      ...checkFundingStage(text, request),
      ...checkCommitment(text, request),
      ...checkAttendance(text, request),
      ...checkDates(text, request),
      ...checkStaleCaveat(text, request),
      ...checkGroupFacts(text, request),
    ];

    const held = findings.some((f) => f.blocking);
    return {
      findings,
      held,
      status: held ? 'held' : findings.length ? 'warning' : 'passed',
    };
  }
}

// ── 1. Unresolved placeholders ──────────────────────────────────────────────

const PLACEHOLDER_PATTERNS = [
  /\{\{?\s*[a-z0-9_.\- ]+\s*\}?\}/gi, // {district}, {{committee}}
  /\[[A-Z][A-Z0-9_ ]{2,}\]/g, // [NAME], [COMMITTEE NAME]
  /<[a-z0-9_]+>/gi, // <district>
  /\bTBD\b/g,
  /\bXX+\b/g,
];

function checkPlaceholders(text: string): VerifierFinding[] {
  const hits = new Set<string>();
  for (const re of PLACEHOLDER_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const raw = m[0];
      // Markdown links carry legitimate bracket syntax; do not flag them.
      if (/^\[[^\]]+\]\(/.test(raw)) continue;
      hits.add(raw);
    }
  }
  if (!hits.size) return [];
  return [
    {
      source: 'deterministic_verifier',
      check: 'unresolved_placeholder',
      classification: 'unsupported',
      // Always blocking: a literal {district} in a message to a member's office
      // is unambiguous, unarguable, and embarrassing.
      blocking: true,
      material: true,
      message: `The draft contains unresolved placeholder(s): ${[...hits].slice(0, 6).join(', ')}.`,
      excerpt: [...hits].slice(0, 6).join(', '),
    },
  ];
}

// ── 2. Numeric grounding ────────────────────────────────────────────────────

/** Money and large magnitudes the draft asserts. */
const MONEY_RE = /\$\s?([\d,]+(?:\.\d+)?)\s*(billion|bn|b|million|m|thousand|k)?\b/gi;

interface ParsedAmount {
  raw: string;
  /** Normalized to whole dollars, so $10M and 10,000,000 compare equal (§4.33). */
  dollars: number;
}

export function parseAmounts(text: string): ParsedAmount[] {
  const out: ParsedAmount[] = [];
  for (const m of text.matchAll(MONEY_RE)) {
    const numeric = Number((m[1] ?? '').replace(/,/g, ''));
    if (!Number.isFinite(numeric)) continue;
    const unit = (m[2] ?? '').toLowerCase();
    const multiplier =
      unit === 'billion' || unit === 'bn' || unit === 'b'
        ? 1e9
        : unit === 'million' || unit === 'm'
          ? 1e6
          : unit === 'thousand' || unit === 'k'
            ? 1e3
            : 1;
    out.push({ raw: m[0].trim(), dollars: numeric * multiplier });
  }
  return out;
}

/** Every dollar amount the packet's structured truth actually contains. */
export function truthAmounts(packet: EvidencePacketV2): number[] {
  const amounts: number[] = [];
  for (const e of packet.evidence) {
    const truth = e.structuredTruth;
    if (!truth) continue;
    const years = (truth as { years?: unknown }).years;
    if (!Array.isArray(years)) continue;
    for (const y of years) {
      if (!y || typeof y !== 'object') continue;
      for (const [key, v] of Object.entries(y as Record<string, unknown>)) {
        if (key === 'fy') continue;
        if (typeof v === 'number' && Number.isFinite(v)) {
          // The PE series stores $ MILLIONS; normalize to whole dollars so the
          // comparison is unit-free (this is the $10M-vs-10,000,000 fix).
          amounts.push(v * 1e6);
        }
      }
    }
  }
  return amounts;
}

function checkNumbers(text: string, req: VerifyRequest): VerifierFinding[] {
  const asserted = parseAmounts(text);
  if (!asserted.length) return [];
  const truth = truthAmounts(req.packet);
  // Also allow any amount that appears verbatim in evidence PROSE — a document or
  // an email may legitimately be the source of a figure, and it is quotable.
  const evidenceProse = req.packet.evidence.map((e) => e.evidenceText).join('\n');
  const proseAmounts = parseAmounts(evidenceProse).map((a) => a.dollars);
  const allowed = [...truth, ...proseAmounts];

  const findings: VerifierFinding[] = [];
  for (const amount of asserted) {
    // 0.5% tolerance absorbs legitimate rounding ($112.9M for 112,900,000).
    const match = allowed.some(
      (t) => t > 0 && Math.abs(t - amount.dollars) / t <= 0.005,
    );
    if (match) continue;
    findings.push({
      source: 'deterministic_verifier',
      check: 'numeric_grounding',
      classification: allowed.length ? 'contradicted' : 'unsupported',
      blocking: true,
      material: true,
      message: `The draft states ${amount.raw}, which does not appear in the structured budget or funding evidence for this message.`,
      excerpt: amount.raw,
    });
  }
  return findings;
}

// ── 3. Bill identifier grounding ────────────────────────────────────────────

const BILL_ID_RE = /\b(H\.?R\.?|S\.?|H\.?J\.?Res\.?|S\.?J\.?Res\.?|HB|SB|AB)\s?(\d{1,5})\b/gi;

function normalizeBillId(prefix: string, num: string): string {
  return `${prefix.replace(/[.\s]/g, '').toUpperCase()}${num}`;
}

function checkBillIdentifiers(text: string, req: VerifyRequest): VerifierFinding[] {
  const asserted = new Map<string, string>();
  for (const m of text.matchAll(BILL_ID_RE)) {
    asserted.set(normalizeBillId(m[1] ?? '', m[2] ?? ''), m[0]);
  }
  if (!asserted.size) return [];

  // Everything the packet knows about, from ids, titles, and evidence prose.
  const packetText = req.packet.evidence
    .map((e) => `${e.ref.title} ${e.ref.sourceId} ${e.evidenceText}`)
    .join('\n');
  const known = new Set<string>();
  for (const m of packetText.matchAll(BILL_ID_RE)) {
    known.add(normalizeBillId(m[1] ?? '', m[2] ?? ''));
  }
  // Also accept the raw source ids (e.g. "hr1234-119").
  for (const e of req.packet.evidence) {
    const id = e.ref.sourceId.replace(/[^a-z0-9]/gi, '').toUpperCase();
    if (id) known.add(id);
    for (const k of [...asserted.keys()]) if (id.includes(k)) known.add(k);
  }

  const findings: VerifierFinding[] = [];
  for (const [normalized, raw] of asserted) {
    if (known.has(normalized)) continue;
    findings.push({
      source: 'deterministic_verifier',
      check: 'bill_identifier_grounding',
      classification: 'unsupported',
      blocking: true,
      material: true,
      message: `The draft cites ${raw}, which is not among the bills supplied as evidence for this message.`,
      excerpt: raw,
    });
  }
  return findings;
}

// ── 4. Enactment claims ─────────────────────────────────────────────────────

const ENACTED_RE =
  /\b(enacted|signed into law|became law|is now law|public law|P\.?L\.?\s?\d)\b/i;

function checkEnactment(text: string, req: VerifyRequest): VerifierFinding[] {
  if (!ENACTED_RE.test(text)) return [];

  // Look for a real enactment record in the structured truth: a canonical status
  // that says so, or an enacted funding figure.
  let hasEnactmentRecord = false;
  for (const e of req.packet.evidence) {
    const truth = e.structuredTruth;
    if (!truth) continue;
    const status = String((truth as { status?: unknown }).status ?? '').toLowerCase();
    if (/enacted|became_law|public_law|signed/.test(status)) hasEnactmentRecord = true;
    const years = (truth as { years?: unknown }).years;
    if (Array.isArray(years)) {
      for (const y of years) {
        const enacted = (y as { enacted?: unknown } | null)?.enacted;
        if (typeof enacted === 'number' && enacted > 0) hasEnactmentRecord = true;
      }
    }
  }
  // Or explicit prose in evidence.
  if (!hasEnactmentRecord) {
    const prose = req.packet.evidence.map((e) => e.evidenceText).join('\n');
    if (/\b(became law|signed into law|public law|enacted)\b/i.test(prose)) {
      hasEnactmentRecord = true;
    }
  }
  if (hasEnactmentRecord) return [];

  return [
    {
      source: 'deterministic_verifier',
      check: 'enactment_claim',
      classification: 'contradicted',
      blocking: true,
      material: true,
      message:
        'The draft describes something as enacted or signed into law, but no enactment or public-law record appears in the evidence.',
      excerpt: firstMatch(text, ENACTED_RE),
    },
  ];
}

// ── 5. Authorization vs appropriation ───────────────────────────────────────

const AUTHORIZATION_TERMS = /\b(authoriz\w+|NDAA|authorization bill|policy bill)\b/i;
const APPROPRIATION_TERMS = /\b(appropriat\w+|enacted amount|enacted funding|approps)\b/i;

/**
 * Which funding stages the structured truth actually supports.
 *
 * The two directions of the confusion are separately consequential: describing an
 * NDAA authorization ceiling as money in hand tells a client they are funded when
 * they are not, and describing an enacted appropriation as "only authorized"
 * understates a win. Both are checked.
 */
function checkFundingStage(text: string, req: VerifyRequest): VerifierFinding[] {
  const mentionsAuthorization = AUTHORIZATION_TERMS.test(text);
  const mentionsAppropriation = APPROPRIATION_TERMS.test(text);
  if (!mentionsAuthorization && !mentionsAppropriation) return [];

  let hasEnactedApprop = false;
  let hasAuthorizationOnly = false;
  for (const e of req.packet.evidence) {
    const truth = e.structuredTruth;
    const years = (truth as { years?: unknown } | undefined)?.years;
    if (!Array.isArray(years)) continue;
    for (const y of years) {
      const row = (y ?? {}) as Record<string, unknown>;
      if (typeof row.enacted === 'number' && row.enacted > 0) hasEnactedApprop = true;
      const authorizationish =
        (typeof row.ndaaConference === 'number' && row.ndaaConference > 0) ||
        (typeof row.hascMark === 'number' && row.hascMark > 0) ||
        (typeof row.sascMark === 'number' && row.sascMark > 0);
      if (authorizationish) hasAuthorizationOnly = true;
    }
  }

  const findings: VerifierFinding[] = [];

  // An APPROPRIATION / enacted-amount claim with only authorization-side marks.
  if (mentionsAppropriation && !hasEnactedApprop && hasAuthorizationOnly) {
    findings.push({
      source: 'deterministic_verifier',
      check: 'authorization_vs_appropriation',
      classification: 'contradicted',
      blocking: true,
      material: true,
      message:
        'The draft describes funding as appropriated or enacted, but the budget evidence contains only authorization-stage marks (NDAA/HASC/SASC). These are not interchangeable.',
      excerpt: firstMatch(text, APPROPRIATION_TERMS),
    });
  }

  // An AUTHORIZATION framing where the money is actually enacted.
  if (
    mentionsAuthorization &&
    !mentionsAppropriation &&
    hasEnactedApprop &&
    /\bonly\b|\bmerely\b|\bnot yet funded\b|\bawaiting\b/i.test(text)
  ) {
    findings.push({
      source: 'deterministic_verifier',
      check: 'authorization_vs_appropriation',
      classification: 'contradicted',
      blocking: true,
      material: true,
      message:
        'The draft frames the funding as merely authorized or not yet funded, but the budget evidence shows an ENACTED amount.',
      excerpt: firstMatch(text, AUTHORIZATION_TERMS),
    });
  }

  return findings;
}

// ── 6. Recipient commitment / support claims ────────────────────────────────

const COMMITMENT_RE =
  /\b(your (?:strong )?support for|you support|your commitment to|you committed to|you agreed to|your co-?sponsorship of|as you (?:have )?(?:pledged|promised)|thank you for (?:your )?(?:support|commitment|endorsement))\b/i;

function checkCommitment(text: string, req: VerifyRequest): VerifierFinding[] {
  if (!COMMITMENT_RE.test(text)) return [];

  // Evidence that could establish a position: a recorded vote, cosponsorship, or
  // explicit prose in correspondence. Standing memory does NOT count (§4.6).
  const eligible = req.packet.evidence.filter((e) => e.ref.trust !== 'standing_memory');
  const prose = eligible.map((e) => e.evidenceText).join('\n');
  const hasPositionEvidence =
    /\b(cosponsor|co-sponsor|voted (?:yea|aye|yes|in favor)|signed (?:the )?letter|stated support|endorsed|committed to)\b/i.test(
      prose,
    );
  if (hasPositionEvidence) return [];

  return [
    {
      source: 'deterministic_verifier',
      check: 'recipient_commitment_claim',
      classification: 'unsupported',
      blocking: true,
      material: true,
      message:
        'The draft attributes support, a commitment, or a position to the recipient, but no evidence establishes it.',
      excerpt: firstMatch(text, COMMITMENT_RE),
    },
  ];
}

// ── 7. Attendance claims ────────────────────────────────────────────────────

const ATTENDANCE_RE =
  /\b(when we met|at our meeting|during our (?:meeting|call)|as you (?:said|mentioned|noted) (?:at|during|in)|it was (?:good|great|nice) (?:to see|seeing) you|following our conversation|you attended)\b/i;

function checkAttendance(text: string, req: VerifyRequest): VerifierFinding[] {
  if (!ATTENDANCE_RE.test(text)) return [];

  // A PREP proves intent to meet, never that a meeting happened (§4.34) — the
  // resolver marks preps with isPlanNotOutcome for exactly this check.
  const proving = req.packet.evidence.filter((e) => {
    if (e.ref.trust === 'standing_memory') return false;
    if (e.ref.provenance?.isPlanNotOutcome === true) return false;
    return (
      e.ref.sourceType === 'debrief' ||
      e.ref.sourceType === 'meetingNote' ||
      e.ref.sourceType === 'meetingHistory' ||
      e.ref.sourceType === 'email'
    );
  });
  if (proving.length) return [];

  const onlyPrep = req.packet.evidence.some((e) => e.ref.provenance?.isPlanNotOutcome === true);
  return [
    {
      source: 'deterministic_verifier',
      check: 'attendance_claim',
      classification: 'unsupported',
      blocking: true,
      material: true,
      message: onlyPrep
        ? 'The draft refers to a meeting that took place, but the only meeting evidence is a PREP — a plan for a meeting, which does not establish that it happened or what was said.'
        : 'The draft refers to a prior meeting or conversation, but no meeting note, debrief, or correspondence establishes that it occurred.',
      excerpt: firstMatch(text, ATTENDANCE_RE),
    },
  ];
}

// ── 8. Date grounding ───────────────────────────────────────────────────────

const DATE_RE =
  /\b((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,\s*\d{4})?|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/g;

/**
 * Finds every "ask span" in `text`: the run of characters starting at an
 * ASK_TRIGGER_RE match (a request/CTA phrase — "could we", "let us know",
 * ...) and extending forward to the next clause boundary (sentence-ending
 * punctuation, `;`, `:`, an em/en dash, or end of string).
 *
 * This is deliberately anchored to the TRIGGER, not to "the clause
 * containing a trigger somewhere in it". A prior version scoped the
 * exemption to whichever whole clause held the ask phrase, which still let
 * a factual assertion joined to the ask by `;`, `:`, or an em dash ride
 * inside that same "clause" and get exempted too, e.g.:
 *
 *   "The hearing is scheduled for September 15; could we meet on September 15?"
 *
 * Anchoring the span to the trigger itself means anything BEFORE the
 * trigger — including a factual clause separated only by `;`/`:`/em dash
 * rather than a full sentence boundary — is never part of the span, so its
 * date occurrence is never eligible for the exemption regardless of which
 * punctuation (or none) separates it from the ask.
 */
const ASK_TRIGGER_RE =
  /\b(could we|can we|would you|shall we|let (?:us|me) know|works for|available (?:on|for)|propose(?:s|d)? (?:a |meeting)?|schedule a|find \d+ minutes|would (?:love|welcome) to (?:meet|schedule))\b/gi;

const CLAUSE_BOUNDARY_RE = /[.!?;:—–\n]/;

function findAskSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const re = new RegExp(ASK_TRIGGER_RE.source, ASK_TRIGGER_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const start = m.index;
    const rest = text.slice(start);
    const boundary = CLAUSE_BOUNDARY_RE.exec(rest);
    const end = boundary ? start + boundary.index + 1 : text.length;
    spans.push({ start, end });
    if (re.lastIndex === m.index) re.lastIndex++; // guard against zero-width matches
  }
  return spans;
}

function checkDates(text: string, req: VerifyRequest): VerifierFinding[] {
  const matches = [...text.matchAll(DATE_RE)];
  if (!matches.length) return [];

  const haystack = [
    ...req.packet.evidence.map((e) => e.evidenceText),
    ...req.packet.evidence.map((e) => e.ref.authoritativeAsOf ?? ''),
    ...req.packet.evidence.map((e) => e.ref.sourceCreatedAt ?? ''),
    ...(req.plan?.supportedClaims ?? []).map((c) => c.asOf ?? ''),
  ].join('\n');

  // `clientAsk` / `callToAction` are the client's OWN proposed terms for the
  // outreach (e.g. "Could we schedule a meeting on September 15?") — not a
  // fact being asserted about the world. This exemption is scoped to the
  // OCCURRENCE via its position inside an ask span (see `findAskSpans`), not
  // to the date value globally and not to "a clause that happens to contain
  // an ask phrase somewhere": a date proposed as the ask can ALSO be
  // asserted as a fact elsewhere in the same draft — including immediately
  // before the ask, joined only by `;`, `:`, or an em dash rather than a
  // full sentence boundary — and that factual occurrence must still ground
  // normally against the evidence packet.
  //
  // An occurrence is ask-exempt only when BOTH hold:
  //   (a) the date value appears in the plan's own clientAsk/callToAction
  //       text (schema-validated and persisted before generation, so the
  //       model can't retroactively invent an ask date to launder a claim), AND
  //   (b) the occurrence's character index falls inside an ask span — i.e.
  //       at or after an actual ask-trigger phrase and before the next
  //       clause boundary. A factual occurrence sitting before the trigger
  //       (even sharing a loosely-punctuated "clause" with it) is never
  //       inside any span, so it never qualifies.
  const planAskHaystack = [...(req.plan?.clientAsk ?? []), req.plan?.callToAction ?? ''].join(
    '\n',
  );
  const askSpans = findAskSpans(text);

  const findings: VerifierFinding[] = [];
  for (const match of matches) {
    const raw = match[0];
    const index = match.index ?? 0;
    const isAskOccurrence =
      planAskHaystack.includes(raw) && askSpans.some((s) => index >= s.start && index < s.end);
    if (isAskOccurrence) continue;

    if (haystack.includes(raw)) continue;
    // Compare normalized forms too, so "June 1, 2026" matches "2026-06-01".
    const normalized = normalizeDate(raw);
    if (normalized && haystack.includes(normalized)) continue;

    findings.push({
      source: 'deterministic_verifier',
      check: 'date_grounding',
      classification: 'unsupported',
      blocking: true,
      material: true,
      message: `The draft states the date "${raw}", which does not appear in any supplied source.`,
      excerpt: raw,
    });
  }
  return findings;
}

const MONTHS: Record<string, string> = {
  january: '01',
  february: '02',
  march: '03',
  april: '04',
  may: '05',
  june: '06',
  july: '07',
  august: '08',
  september: '09',
  october: '10',
  november: '11',
  december: '12',
};

function normalizeDate(raw: string): string | null {
  const m = /^([A-Za-z]+)\s+(\d{1,2})(?:,\s*(\d{4}))?$/.exec(raw.trim());
  if (m) {
    const month = MONTHS[(m[1] ?? '').toLowerCase()];
    if (!month || !m[3]) return null;
    return `${m[3]}-${month}-${String(m[2]).padStart(2, '0')}`;
  }
  const s = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(raw.trim());
  if (s) {
    const year = (s[3] ?? '').length === 2 ? `20${s[3]}` : s[3];
    return `${year}-${String(s[1]).padStart(2, '0')}-${String(s[2]).padStart(2, '0')}`;
  }
  return null;
}

// ── 9. Stale-source caveat ──────────────────────────────────────────────────

const CAVEAT_RE = /\b(as of|per the latest|at last check|according to the .* record|current as of)\b/i;

function checkStaleCaveat(text: string, req: VerifyRequest): VerifierFinding[] {
  const stale = req.packet.evidence.filter((e) => {
    if (e.ref.trust !== 'authoritative_structured') return false;
    const asOf = e.ref.authoritativeAsOf;
    if (!asOf) return false;
    const ms = new Date(asOf).getTime();
    if (Number.isNaN(ms)) return false;
    const ageDays = (req.now.getTime() - ms) / 86_400_000;
    return ageDays > freshnessThresholdDays(e.ref.sourceType);
  });
  if (!stale.length) return [];
  if (CAVEAT_RE.test(text)) return [];

  return [
    {
      source: 'deterministic_verifier',
      check: 'stale_source_caveat',
      classification: 'stale',
      blocking: true,
      material: true,
      message: `The draft relies on ${stale.length} source(s) older than this audience's freshness limit (${stale
        .map((e) => e.ref.sourceType)
        .join(', ')}) without stating an as-of date.`,
    },
  ];
}

// ── 10. Group common facts ──────────────────────────────────────────────────

function checkGroupFacts(text: string, req: VerifyRequest): VerifierFinding[] {
  if (req.audienceKind !== 'group') return [];

  // Recipient-scoped evidence in a group draft is the risk: any per-member
  // committee/state/district fact stated to everyone is wrong for most of them.
  const perMemberEvidence = req.packet.evidence.filter((e) => e.scope !== 'all');
  if (!perMemberEvidence.length) return [];

  const findings: VerifierFinding[] = [];
  // Second-person singular possessives about a member's own record.
  const SINGULAR_ATTR_RE =
    /\byour (?:committee|subcommittee|district|state|seat on|position on|record on|leadership of)\b/i;
  if (SINGULAR_ATTR_RE.test(text)) {
    findings.push({
      source: 'deterministic_verifier',
      check: 'group_common_facts',
      classification: 'unsupported',
      blocking: true,
      material: true,
      message:
        'This is one shared message to a group, but the draft asserts a committee, district, state, or position belonging to a single member. Only facts common to every recipient may be stated.',
      excerpt: firstMatch(text, SINGULAR_ATTR_RE),
    });
  }
  return findings;
}

// ── Shared ──────────────────────────────────────────────────────────────────

function firstMatch(text: string, re: RegExp): string | undefined {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const m = new RegExp(re.source, flags).exec(text);
  if (!m) return undefined;
  const start = Math.max(0, m.index - 40);
  const end = Math.min(text.length, m.index + m[0].length + 40);
  return `…${text.slice(start, end).replace(/\s+/g, ' ').trim()}…`;
}
