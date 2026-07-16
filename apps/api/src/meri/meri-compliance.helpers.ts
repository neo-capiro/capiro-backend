/**
 * Compliance guardrails for Meri (P1-7).
 *
 * Two parts:
 *  1. COMPLIANCE_GUARDRAILS — appended to the (cached) static system base so the
 *     model refuses + redirects unlawful/unethical government-affairs requests.
 *  2. screenComplianceRisk — a pure, deterministic pre-screen that flags clearly
 *     high-risk asks for an audit-log entry (it does NOT block; the model decides,
 *     guided by the guardrails). The P1-1 refusal eval fixtures validate behavior.
 *
 * Pure (no I/O) so it unit-tests under `src/**.spec.ts`.
 */

// Canonical text now lives in @capiro/shared (MERI_COMPLIANCE_GUARDRAILS) so the
// legacy chat base and the meriv2-orchestrator chat prompt share ONE source and
// can't drift (1B.6). Re-exported here under the original name; the app-local
// screenComplianceRisk pre-screen below is unchanged.
export { MERI_COMPLIANCE_GUARDRAILS as COMPLIANCE_GUARDRAILS } from '@capiro/shared';

export type ComplianceCategory =
  | 'bribery'
  | 'illegal_contribution'
  | 'quid_pro_quo'
  | 'gift_rule_evasion'
  | 'fara_evasion'
  | 'impersonation'
  | 'fabrication';

export interface ComplianceScreen {
  flagged: boolean;
  category: ComplianceCategory | null;
}

const PATTERNS: Array<{ category: ComplianceCategory; re: RegExp }> = [
  {
    category: 'bribery',
    re: /\bbrib(e|es|ed|ery|ing)\b|(cash|money|envelope|payment)[^.]{0,40}(staffer|aide|member|senator|congress|official)/i,
  },
  {
    category: 'illegal_contribution',
    re: /straw[\s-]?donor|funnel (money|funds|cash)[^.]*(campaign|contribution|donat)|(conceal|hide|disguise|launder)[^.]*(donation|contribution)|(evade|circumvent|get around|avoid)[^.]*contribution limit/i,
  },
  {
    category: 'quid_pro_quo',
    re: /in exchange for (your |the |their )?(vote|support|official)|(donat|contribut|gift)[^.]*in exchange|vote[^.]*in exchange for/i,
  },
  {
    category: 'gift_rule_evasion',
    re: /(evade|avoid|get around|circumvent|skirt)[^.]*gift (rule|limit|ban)|lavish gifts?[^.]*(evade|avoid|without report)/i,
  },
  {
    category: 'fara_evasion',
    re: /without registering[^.]*(fara|foreign)|(avoid|evade|skirt|get around)[^.]*\bfara\b|lobby[^.]*foreign government[^.]*without/i,
  },
  {
    category: 'impersonation',
    re: /pretend(ing)? to be a constituent|fake (name|constituent|address|identit)|impersonat/i,
  },
  {
    category: 'fabrication',
    re: /(fabricate|invent|make up|made up)[^.]*(statistic|data|number|figure|jobs|support)|fake (statistic|data|number)/i,
  },
];

/** Flag a clearly high-risk request for audit logging. First match wins. */
export function screenComplianceRisk(message: string): ComplianceScreen {
  if (typeof message !== 'string' || !message.trim()) return { flagged: false, category: null };
  for (const { category, re } of PATTERNS) {
    if (re.test(message)) return { flagged: true, category };
  }
  return { flagged: false, category: null };
}

/**
 * GAI-24 — deterministic BLOCKING screen, deliberately much tighter than the
 * audit-flag PATTERNS above.
 *
 * The audit-flag set is recall-tuned and MUST stay log-only: turned blocking it
 * would refuse everyday legitimate work — "(money)[^.]{0,40}(congress)" fires on
 * ordinary appropriations questions, bare \bbrib\w*\b on "what counts as bribery
 * under 18 U.S.C. 201?", "avoid[^.]*gift rule" on "how do I avoid VIOLATING the
 * gift rules", "invent" (no \b) inside "inventory data".
 *
 * BLOCK_PATTERNS therefore match only unambiguous first-person solicitations of
 * the prohibited act: an intent/act verb anchored to the illicit object within a
 * single sentence ([^.?!] gaps), word-boundaried. False NEGATIVES are acceptable
 * (the model guardrails still refuse, and screenComplianceRisk still flags for
 * audit); false POSITIVES are the harm this set is designed against. Questions
 * ABOUT legality ("is X illegal?", "what are the gift rules?") deliberately do
 * not match — asking is compliance-seeking, not solicitation.
 */
const BLOCK_PATTERNS: Array<{ category: ComplianceCategory; re: RegExp }> = [
  {
    category: 'bribery',
    // "how do we bribe…", "help me bribe…", "can we get away with bribing…"
    re: /\b(how (do|can|should|would) (i|we)|help (me|us)|can (i|we) get away with|let'?s)\b[^.?!]{0,80}\bbrib(e|es|ed|ery|ing)\b/i,
  },
  {
    category: 'bribery',
    // explicit payment→official→influence chain: "hand the staffer cash so that
    // he moves our earmark", "slip cash to the aide to get our amendment in".
    // Object and recipient may appear in either order; the influence tail is any
    // "so (that)/to <verb>/in return for/for their vote" clause.
    re: /\b(hand|slip|give|offer|pay)\b[^.?!]{0,60}\b(cash|money|an envelope|a payment)\b[^.?!]{0,80}\b(so (that )?(he|she|they|the\b)|to (get|secure|win|influence|move|pass|advance|kill)|in return for|in exchange for|for (his|her|their) (vote|support))/i,
  },
  {
    category: 'illegal_contribution',
    // recruiting/using straw donors, or actively laundering a contribution
    re: /\b(use|set up|recruit|find|through)\b[^.?!]{0,40}\bstraw[\s-]?donors?\b|\b(funnel|launder|disguise|conceal)\b[^.?!]{0,40}\b(money|funds|cash|donations?|contributions?)\b[^.?!]{0,60}\b(campaign|candidate|pac|committee)\b/i,
  },
  {
    category: 'quid_pro_quo',
    // offering/arranging value in exchange for an official act (first-person act verbs)
    re: /\b(offer|promise|give|arrange|structure)\b[^.?!]{0,60}\b(donation|contribution|gift|favor|fundraiser)\b[^.?!]{0,40}\bin exchange for\b[^.?!]{0,40}\b(vote|support|official act|earmark|amendment)/i,
  },
  {
    category: 'gift_rule_evasion',
    // evasion verbs only — 'avoid' is deliberately EXCLUDED so "avoid violating
    // the gift rules" (the classic compliance question) never blocks
    re: /\b(evade|skirt|get around|circumvent)\b[^.?!]{0,40}\bgift (rule|limit|ban)s?\b/i,
  },
  {
    category: 'fara_evasion',
    re: /\b(lobby|advocate|represent|work) (for|on behalf of)\b[^.?!]{0,60}\bforeign (government|principal|ministry|state)\b[^.?!]{0,60}\bwithout (registering|disclosing|disclosure)/i,
  },
  {
    category: 'fara_evasion',
    // evasion verbs only — "avoid FARA exposure — register under LDA instead?"
    // is legitimate election-of-statute practice and must not block
    re: /\b(evade|skirt|get around|circumvent)\b[^.?!]{0,30}\bfara\b/i,
  },
  {
    category: 'impersonation',
    // producing fake-constituent content — not mentions/victim reports
    re: /\b(write|draft|send|create|generate|compose)\b[^.?!]{0,60}\b(pretend\w* to be|as (a|if (i|we) (were|am|are)))\b[^.?!]{0,40}\bconstituents?\b|\bfake constituents?\b|\bfake (names? and )?(identit|address)\w*\b[^.?!]{0,40}\b(letter|email|campaign|comment)/i,
  },
  {
    category: 'fabrication',
    // word-boundaried (the audit-flag copy matches inside "inventory") and
    // anchored to advocacy use
    re: /\b(fabricate|invent|make up)\b[^.?!]{0,50}\b(statistics?|data|numbers?|figures?)\b[^.?!]{0,80}\b(hill|congress|committee|member|testimony|letter|grassroots|support)/i,
  },
];

/**
 * Deterministic block decision (GAI-24). Runs beside screenComplianceRisk —
 * `screenComplianceRisk` keeps flagging broadly for the audit trail; this
 * returns flagged=true only for asks the app should refuse BEFORE any model
 * call, independent of prompt adherence.
 */
export function screenComplianceBlock(message: string): ComplianceScreen {
  if (typeof message !== 'string' || !message.trim()) return { flagged: false, category: null };
  for (const { category, re } of BLOCK_PATTERNS) {
    if (re.test(message)) return { flagged: true, category };
  }
  return { flagged: false, category: null };
}

/** User-facing refusal body for a deterministic compliance block. */
export function complianceRefusalBody(category: ComplianceCategory | null): string {
  const what: Record<ComplianceCategory, string> = {
    bribery: 'offering anything of value to influence an official act',
    illegal_contribution: 'concealing or structuring campaign contributions',
    quid_pro_quo: 'exchanging contributions or gifts for official action',
    gift_rule_evasion: 'evading congressional gift rules',
    fara_evasion: 'avoiding FARA registration or disclosure obligations',
    impersonation: 'impersonating constituents or fabricating identities',
    fabrication: 'fabricating statistics or data for advocacy',
  };
  const subject = category ? what[category] : 'this request';
  return (
    `I can't help with ${subject} — that would violate the compliance guardrails ` +
    `this firm operates under, and this request has been logged for compliance review.\n\n` +
    `If you're trying to accomplish a legitimate goal here, I'm glad to help with a ` +
    `compliant path — for example the disclosure, registration, or gift-rule requirements ` +
    `that apply, or lawful advocacy strategies for the same objective.`
  );
}
