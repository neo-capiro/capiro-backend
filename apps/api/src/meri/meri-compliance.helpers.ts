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
