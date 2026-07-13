import type { ApprovalGate, MeriContext } from '../registry/types';

/**
 * MeriV2 approval / compliance gate (Workstream B).
 *
 * The registry runs `ApprovalGate.check()` before ANY write tool
 * (`readOnly:false`) and only executes the handler if `check` returns; a throw
 * stops the action before it runs (`tool-registry.ts`). This module turns a
 * `CompliancePolicy` decision (PASS / WARN / BLOCK) into that enforcement.
 *
 * It is intentionally fail-closed and DB-free:
 *   - the actual rules (lobbying / ethics / gift / per-tenant policy) live
 *     behind the `CompliancePolicy` seam (Phase-2 engine, B2);
 *   - whether a WARN has already been approved lives behind the `ApprovalStore`
 *     seam (the pending-action model, B3/B4), so persistence stays in apps/api.
 * meriv2-core only owns the mechanism.
 */

import type { RiskTier } from '@capiro/shared';

export type ComplianceOutcome = 'PASS' | 'WARN' | 'BLOCK';
// Re-export the shared taxonomy for compliance-engine importers (the Alert
// pattern: the type lives in @capiro/shared, core re-exports).
export type { RiskTier } from '@capiro/shared';
export { RISK_TIERS, RISK_TIER_DEFAULT_OUTCOME, DELIVERABLE_RISK_TIERS } from '@capiro/shared';

export interface ComplianceDecision {
  readonly outcome: ComplianceOutcome;
  /**
   * Human-readable reasons for the outcome. Always populated for WARN/BLOCK and
   * carried through to the thrown error / audit row — a compliance decision is
   * never silently swallowed.
   */
  readonly reasons: string[];
  /** Optional stable machine code for the dominant reason (e.g. `gift_rule`). */
  readonly code?: string;
  /** G4: the named risk tier behind this outcome, when the rule declares one. */
  readonly tier?: RiskTier;
}

/**
 * A compliance precheck: given a write tool, its already-validated input, and
 * the caller, decide PASS (proceed), WARN (requires explicit human approval),
 * or BLOCK (never execute). This is the pluggable seam for the Phase-2 rules
 * engine and per-tenant policy; the gate below turns the decision into
 * enforcement.
 */
export interface CompliancePolicy {
  evaluate(
    toolName: string,
    input: unknown,
    ctx: MeriContext,
  ): ComplianceDecision | Promise<ComplianceDecision>;
}

/** Thrown for a BLOCK decision — the action is never executed. */
export class ComplianceBlockedError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly reasons: string[],
    public readonly code?: string,
  ) {
    super(`Tool "${toolName}" blocked by compliance: ${reasons.join('; ') || 'no reason given'}`);
    this.name = 'ComplianceBlockedError';
  }
}

/**
 * Thrown for a WARN decision that has not been approved — the action is held
 * pending explicit human approval. The caller (surface layer) catches this to
 * propose the action to the user; once approved, the recorded approval flows
 * back through the `ApprovalStore`.
 */
export class ApprovalPendingError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly reasons: string[],
    public readonly code?: string,
  ) {
    super(
      `Tool "${toolName}" requires approval: ${reasons.join('; ') || 'human approval required'}`,
    );
    this.name = 'ApprovalPendingError';
  }
}

/**
 * Decides whether a proposed (WARN) write-tool invocation has already been
 * approved by a human. Pure interface so meriv2-core stays DB-free; the real
 * implementation (a pending-action row the user approved, B3/B4) plugs in from
 * apps/api without touching the gate. The default approves nothing.
 */
export interface ApprovalStore {
  isApproved(toolName: string, input: unknown, ctx: MeriContext): boolean | Promise<boolean>;
}

/** Default `ApprovalStore`: nothing is pre-approved (WARN always => pending). */
export const denyAllApprovals: ApprovalStore = {
  isApproved: () => false,
};

/**
 * The registry's write-tool gate, implemented as a compliance engine.
 *
 *   PASS  -> return (handler runs)
 *   BLOCK -> throw `ComplianceBlockedError` (handler never runs)
 *   WARN  -> run IFF `ApprovalStore.isApproved` is true, else throw
 *            `ApprovalPendingError`
 *
 * Fail-closed by construction: a WARN with no recorded approval, or any policy
 * throw, prevents execution.
 */
export class PolicyApprovalGate implements ApprovalGate {
  constructor(
    private readonly policy: CompliancePolicy,
    private readonly approvals: ApprovalStore = denyAllApprovals,
  ) {}

  async check(toolName: string, input: unknown, ctx: MeriContext): Promise<void> {
    const decision = await this.policy.evaluate(toolName, input, ctx);
    if (decision.outcome === 'PASS') return;
    if (decision.outcome === 'BLOCK') {
      throw new ComplianceBlockedError(toolName, decision.reasons, decision.code);
    }
    // WARN: requires explicit approval.
    const approved = await this.approvals.isApproved(toolName, input, ctx);
    if (!approved) {
      throw new ApprovalPendingError(toolName, decision.reasons, decision.code);
    }
  }
}

export interface StaticCompliancePolicyConfig {
  /** Per-tool outcome overrides, keyed by tool name. */
  outcomes?: Record<string, ComplianceOutcome>;
  /** Outcome for any tool not in `outcomes`. Defaults to WARN (require approval). */
  fallback?: ComplianceOutcome;
  /** Optional custom reason text for a (tool, outcome). */
  reasonFor?: (toolName: string, outcome: ComplianceOutcome) => string;
}

/**
 * A simple, explicit `CompliancePolicy` for wiring a real gate BEFORE the
 * Phase-2 rules engine (B2) exists. Every write tool defaults to WARN (requires
 * human approval) unless mapped otherwise. Deterministic and DB-free; swap it
 * for the real engine later without touching `PolicyApprovalGate`.
 */
export function staticCompliancePolicy(
  config: StaticCompliancePolicyConfig = {},
): CompliancePolicy {
  const outcomes = config.outcomes ?? {};
  const fallback: ComplianceOutcome = config.fallback ?? 'WARN';
  return {
    evaluate(toolName: string): ComplianceDecision {
      const outcome = outcomes[toolName] ?? fallback;
      const reason =
        config.reasonFor?.(toolName, outcome) ??
        (outcome === 'BLOCK'
          ? `Tool "${toolName}" is blocked by policy`
          : outcome === 'WARN'
            ? `Tool "${toolName}" requires human approval before it can run`
            : `Tool "${toolName}" is permitted`);
      return { outcome, reasons: [reason] };
    },
  };
}
