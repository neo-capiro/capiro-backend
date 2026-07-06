import { z } from 'zod';
import {
  InMemoryToolRegistry,
  PolicyApprovalGate,
  ruleBasedCompliancePolicy,
  type ApprovalStore,
  type MeriContext,
  type ToolDefinition,
} from '../../../src/index';
import type { EvalCase } from '../types';

/**
 * Compliance-gate enforcement (B1-B4, SC2.3). Deterministic — no LLM, no DB.
 * Proves the invariant the whole compliance workstream rests on: a write tool
 * NEVER executes through the registry unless policy PASSes or a human has
 * approved it. Exercises all three outcomes:
 *   - BLOCK  → ComplianceBlockedError, handler never runs
 *   - WARN + not approved → ApprovalPendingError, handler never runs
 *   - WARN + approved     → handler runs exactly once
 *
 * A regression that lets a gated write slip through (the exact failure the
 * gate exists to prevent) turns this case RED.
 */
type Empty = Record<string, never>;

const ctx: MeriContext = {
  tenantId: 'tenant-a',
  userId: 'user-a',
  clerkUserId: 'clerk_a',
  role: 'standard_user',
};

/** Approval store toggled per-scenario. */
class FixedApprovalStore implements ApprovalStore {
  constructor(private readonly approved: boolean) {}
  async isApproved(): Promise<boolean> {
    return this.approved;
  }
}

function writeTool(ran: { count: number }): ToolDefinition<Empty, { ok: true }> {
  return {
    name: 'send_email',
    description: 'a side-effecting write tool',
    readOnly: false,
    inputSchema: z.object({}),
    handler: async () => {
      ran.count += 1;
      return { ok: true };
    },
  };
}

async function expectThrow(fn: () => Promise<unknown>, name: string): Promise<string | null> {
  try {
    await fn();
    return `expected ${name} but the call resolved`;
  } catch (e) {
    return (e as Error).name === name ? null : `expected ${name}, got ${(e as Error).name}`;
  }
}

export const complianceGateCase: EvalCase = {
  id: 'compliance.gate.enforcement',
  category: 'compliance',
  description:
    'a gated write only executes on PASS or explicit approval; BLOCK/WARN-unapproved never run it',
  async run() {
    const problems: string[] = [];

    // Scenario 1: BLOCK rule → ComplianceBlockedError, handler never runs.
    {
      const ran = { count: 0 };
      const registry = new InMemoryToolRegistry({
        approvalGate: new PolicyApprovalGate(
          ruleBasedCompliancePolicy([
            {
              id: 'test.block_send',
              description: 'block sends',
              outcome: 'BLOCK',
              matches: (t) => t === 'send_email',
            },
          ]),
          new FixedApprovalStore(true), // approved, but BLOCK wins
        ),
      });
      registry.register(writeTool(ran));
      const err = await expectThrow(
        () => registry.invoke('send_email', {}, ctx),
        'ComplianceBlockedError',
      );
      if (err) problems.push(`BLOCK: ${err}`);
      if (ran.count !== 0) problems.push(`BLOCK: handler ran ${ran.count}x (must be 0)`);
    }

    // Scenario 2: WARN + not approved → ApprovalPendingError, handler never runs.
    {
      const ran = { count: 0 };
      const registry = new InMemoryToolRegistry({
        approvalGate: new PolicyApprovalGate(
          ruleBasedCompliancePolicy(), // default: all writes WARN
          new FixedApprovalStore(false),
        ),
      });
      registry.register(writeTool(ran));
      const err = await expectThrow(
        () => registry.invoke('send_email', {}, ctx),
        'ApprovalPendingError',
      );
      if (err) problems.push(`WARN-unapproved: ${err}`);
      if (ran.count !== 0) problems.push(`WARN-unapproved: handler ran ${ran.count}x (must be 0)`);
    }

    // Scenario 3: WARN + approved → handler runs exactly once.
    {
      const ran = { count: 0 };
      const registry = new InMemoryToolRegistry({
        approvalGate: new PolicyApprovalGate(
          ruleBasedCompliancePolicy(),
          new FixedApprovalStore(true),
        ),
      });
      registry.register(writeTool(ran));
      try {
        await registry.invoke('send_email', {}, ctx);
      } catch (e) {
        problems.push(`WARN-approved: unexpected throw ${(e as Error).name}`);
      }
      if (ran.count !== 1) problems.push(`WARN-approved: handler ran ${ran.count}x (must be 1)`);
    }

    return {
      pass: problems.length === 0,
      detail:
        problems.length === 0
          ? 'gate enforced BLOCK + WARN-unapproved (no execution) and WARN-approved (executed once)'
          : `gate ENFORCEMENT FAILURES: ${problems.join('; ')}`,
    };
  },
};
