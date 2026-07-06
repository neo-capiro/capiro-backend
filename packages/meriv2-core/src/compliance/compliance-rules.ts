import type { MeriContext } from '../registry/types';
import type { CompliancePolicy, ComplianceDecision, ComplianceOutcome } from './approval-gate';

/**
 * B2 — the compliance rules engine (mechanism).
 *
 * `staticCompliancePolicy` (approval-gate.ts) maps each tool to one fixed
 * outcome. That was the placeholder gate. This is the real engine: a declarative
 * list of RULES, each able to inspect the tool name, the (already-validated)
 * input, AND the caller context, returning PASS / WARN / BLOCK. The first
 * matching rule wins; if none match, a fallback outcome applies. Every decision
 * carries the id of the rule that produced it, so a WARN/BLOCK is auditable
 * back to a specific rule (fed into the ComplianceCheck audit row, SC2.3).
 *
 * WHAT THIS SHIPS WITH — and what it deliberately does NOT: the seed rule set
 * below is intentionally minimal and DEFENSIBLE, not a guess at Capiro's
 * lobbying-compliance policy. Every write tool resolves to WARN (require human
 * approval), which is exactly today's observable behavior (apps/api's tool
 * descriptions say "Requires user approval"; the placeholder gate's fallback is
 * WARN). The engine's value is the MECHANISM to express real per-tool /
 * per-input BLOCK and PASS rules once the domain rules are defined — the
 * lobbying/ethics/gift/pay-to-play BLOCK conditions (SC2.3, §3 Compliance) need
 * Neo's domain input and are NOT invented here. `EXAMPLE_RULES` (exercised only
 * in the spec) proves the BLOCK/PASS/input-conditional paths work end-to-end
 * without asserting any real policy.
 *
 * Pure + DB-free (like the rest of meriv2-core). Persistence of the audit
 * decision and the pending-approval lifecycle live behind the ApprovalStore /
 * apps/api seams (B3/B4).
 */
export interface ComplianceRule {
  /** Stable id, recorded on the decision for audit (never reused/renumbered). */
  readonly id: string;
  readonly description: string;
  readonly outcome: ComplianceOutcome;
  /** Applies this rule when it returns true. Evaluated in list order; first match wins. */
  readonly matches: (toolName: string, input: unknown, ctx: MeriContext) => boolean;
  /** Optional machine code carried onto the decision (e.g. 'gift_rule'). */
  readonly code?: string;
  /** Optional custom human reason; defaults to `description`. */
  readonly reason?: (toolName: string, input: unknown, ctx: MeriContext) => string;
}

export interface RuleBasedPolicyConfig {
  /** Outcome when no rule matches. Fail-safe default: WARN (require approval). */
  readonly fallback?: ComplianceOutcome;
  /** Reason text for the fallback (no rule matched). */
  readonly fallbackReason?: (toolName: string) => string;
}

/**
 * The shipped seed rules. Deliberately just ONE catch-all: every write tool
 * requires human approval (WARN). This preserves today's behavior exactly while
 * moving the decision into the auditable rules engine. Real BLOCK/PASS rules
 * (compliance-sensitive tools, pre-approved low-risk tools) are appended here
 * ONLY once their policy is defined with Neo — see EXAMPLE_RULES for the shape.
 */
export const DEFAULT_COMPLIANCE_RULES: readonly ComplianceRule[] = [
  {
    id: 'write.requires_approval',
    description: 'Any side-effecting tool requires explicit human approval before it runs.',
    outcome: 'WARN',
    matches: () => true, // the gate only invokes the policy for readOnly:false tools
  },
];

/**
 * Illustrative rules — NOT part of the default set. They exist to prove (in the
 * spec) that the engine supports per-tool BLOCK, per-tool PASS, and
 * input-conditional matching. They are examples of the SHAPE a real rule takes,
 * not a statement of Capiro policy. Do not register these without domain sign-off.
 */
export const EXAMPLE_RULES: readonly ComplianceRule[] = [
  {
    id: 'example.block_tool',
    description: 'Example: a specific tool is hard-blocked by policy.',
    outcome: 'BLOCK',
    code: 'example_block',
    matches: (toolName) => toolName === 'example_blocked_tool',
  },
  {
    id: 'example.pass_tool',
    description: 'Example: a low-risk tool is pre-approved (no human gate).',
    outcome: 'PASS',
    matches: (toolName) => toolName === 'example_safe_tool',
  },
  {
    id: 'example.input_conditional',
    description: 'Example: an input-conditional BLOCK (e.g. an external recipient).',
    outcome: 'BLOCK',
    code: 'example_external_recipient',
    matches: (toolName, input) =>
      toolName === 'send_email' &&
      typeof (input as { to?: unknown })?.to === 'string' &&
      (input as { to: string }).to.endsWith('@example.gov'),
  },
];

/**
 * Build a `CompliancePolicy` from an ordered rule list. First matching rule
 * decides; its id is recorded on the decision. No match → `fallback` (WARN).
 * Fail-safe: a rule whose `matches`/`reason` throws is skipped (never crashes
 * the gate open) and evaluation continues to the next rule.
 */
export function ruleBasedCompliancePolicy(
  rules: readonly ComplianceRule[] = DEFAULT_COMPLIANCE_RULES,
  config: RuleBasedPolicyConfig = {},
): CompliancePolicy {
  const fallback: ComplianceOutcome = config.fallback ?? 'WARN';
  return {
    evaluate(toolName: string, input: unknown, ctx: MeriContext): ComplianceDecision {
      for (const rule of rules) {
        let matched = false;
        try {
          matched = rule.matches(toolName, input, ctx);
        } catch {
          // A rule that throws must not crash the gate open — skip it.
          continue;
        }
        if (!matched) continue;
        let reason: string;
        try {
          reason = rule.reason?.(toolName, input, ctx) ?? rule.description;
        } catch {
          reason = rule.description;
        }
        return {
          outcome: rule.outcome,
          reasons: [reason],
          ...(rule.code ? { code: rule.code } : {}),
          // Non-typed extra for audit: which rule fired. Consumers that persist
          // the ComplianceCheck read `ruleId` off the decision when present.
          ruleId: rule.id,
        } as ComplianceDecision & { ruleId: string };
      }
      const reason =
        config.fallbackReason?.(toolName) ??
        `Tool "${toolName}" requires human approval before it can run (no rule matched; default WARN).`;
      return { outcome: fallback, reasons: [reason] };
    },
  };
}
