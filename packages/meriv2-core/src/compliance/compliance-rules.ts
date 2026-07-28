import type { RiskTier } from '@capiro/shared';
import type { MeriContext } from '../registry/types';
import type { CompliancePolicy, ComplianceDecision, ComplianceOutcome } from './approval-gate';

/** Immutable identifier for the policy semantics used by Phase 0 proposals. */
export const CAPIRO_COMPLIANCE_POLICY_VERSION = '2026-07-27.meriv2-p0.v1';

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
  /** G4: named risk tier this rule represents (blueprint §3.3). */
  readonly tier?: RiskTier;
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
 * PROPOSED production ruleset — tiered by blast radius, awaiting Neo's sign-off
 * (merging the PR that wires this IS the sign-off). Rationale, tier by tier:
 *
 * WARN (human approval required) — actions that leave the firm or mutate the
 * client record:
 *   - send_email / reply_email: external communications. STRICTER than legacy
 *     chat, which sends after a conversational OK; here every send needs an
 *     explicit approval click.
 *   - update_client_profile: CRM record mutation — client data is the product.
 *   - create_task / update_task: engagement (CRM) task writes — a real record
 *     mutation, and both tools' own catalog descriptions promise "Requires user
 *     approval", so they gate like update_client_profile (their sibling write).
 *   - schedule_task / cancel_scheduled_task: standing automation that will act
 *     again later without a human in the loop.
 *
 * PASS (pre-approved, still audited) — internal, reversible artifacts and task
 * bookkeeping. The legacy chat surface has executed exactly these freely in
 * production since 2026-06-10 (prompt-level propose-then-ask + per-action
 * audit), so PASS here is no more permissive than current observable behavior:
 *   - save_note, save_memory (internal knowledge, user-visible/undoable)
 *   - create_word, create_excel, create_powerpoint, create_meeting_brief,
 *     draft_policy_memo (document drafts — inert until a human sends them)
 *
 * Fallback WARN: any write tool not named above (including future ones) holds
 * for approval by default — new capability never silently self-approves.
 *
 * No BLOCK rules yet: the lobbying/ethics/gift/pay-to-play BLOCK conditions
 * (SC2.3) still need Neo's domain definitions; EXAMPLE_RULES proves the BLOCK
 * path works when they arrive.
 */
export const PROPOSED_CAPIRO_RULES: readonly ComplianceRule[] = [
  {
    id: 'send.requires_approval',
    description: 'Outbound email leaves the firm — requires explicit human approval.',
    outcome: 'WARN',
    tier: 'restricted',
    code: 'external_send',
    matches: (toolName) => toolName === 'send_email' || toolName === 'reply_email',
  },
  {
    id: 'client_profile.requires_approval',
    description:
      'Client-record mutations (create or update) change the CRM — require human approval.',
    outcome: 'WARN',
    tier: 'high',
    code: 'crm_mutation',
    matches: (toolName) => toolName === 'update_client_profile' || toolName === 'create_client',
  },
  {
    id: 'crm_task.requires_approval',
    description: 'Engagement task writes mutate the CRM record — require human approval.',
    outcome: 'WARN',
    tier: 'high',
    code: 'crm_mutation',
    matches: (toolName) => toolName === 'create_task' || toolName === 'update_task',
  },
  {
    id: 'automation.requires_approval',
    description:
      'Standing automation (scheduled tasks) acts later without a human — requires approval.',
    outcome: 'WARN',
    tier: 'high',
    code: 'standing_automation',
    matches: (toolName) => toolName === 'schedule_task' || toolName === 'cancel_scheduled_task',
  },
  {
    id: 'internal_artifacts.pass',
    description:
      'Internal, reversible artifacts and task bookkeeping are pre-approved (audited, parity with the legacy surface).',
    outcome: 'PASS',
    tier: 'low',
    matches: (toolName) =>
      [
        'save_note',
        'save_memory',
        // Shared-memory mutation is scope/role sensitive. Phase 0 deliberately
        // leaves confirm/correct/forget out of this unconditional PASS rule, so
        // an unknown or shared-scope mutation fails to WARN and requires approval.
        'create_word',
        'create_excel',
        'create_powerpoint',
        'create_meeting_brief',
        'draft_policy_memo',
      ].includes(toolName),
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
          ...(rule.tier ? { tier: rule.tier } : {}),
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
