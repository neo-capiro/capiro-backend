import {
  DEFAULT_COMPLIANCE_RULES,
  EXAMPLE_RULES,
  PROPOSED_CAPIRO_RULES,
  ruleBasedCompliancePolicy,
  type ComplianceRule,
} from './compliance-rules';
import type { CompliancePolicy, ComplianceDecision } from './approval-gate';
import type { MeriContext } from '../registry/types';

const ctx: MeriContext = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  clerkUserId: 'clerk_1',
  role: 'standard_user',
};

/** The seed policy evaluates synchronously; cast the union return for terse asserts. */
function decide(
  policy: CompliancePolicy,
  tool: string,
  input: unknown = {},
): ComplianceDecision & {
  ruleId?: string;
} {
  return policy.evaluate(tool, input, ctx) as ComplianceDecision & { ruleId?: string };
}

describe('ruleBasedCompliancePolicy — default seed', () => {
  const policy = ruleBasedCompliancePolicy();

  it("defaults every write tool to WARN (preserves today's behavior)", () => {
    for (const tool of ['send_email', 'create_task', 'update_client_profile', 'anything_else']) {
      expect(decide(policy, tool).outcome).toBe('WARN');
    }
  });

  it('records the matched rule id on the decision (auditability)', () => {
    expect(decide(policy, 'send_email').ruleId).toBe('write.requires_approval');
  });

  it('the seed set is a single catch-all WARN rule (no invented BLOCK policy)', () => {
    expect(DEFAULT_COMPLIANCE_RULES).toHaveLength(1);
    expect(DEFAULT_COMPLIANCE_RULES[0]?.outcome).toBe('WARN');
  });
});

describe('ruleBasedCompliancePolicy — engine mechanics (via EXAMPLE_RULES)', () => {
  // Prove BLOCK / PASS / input-conditional all work; examples are not policy.
  const policy = ruleBasedCompliancePolicy([...EXAMPLE_RULES, ...DEFAULT_COMPLIANCE_RULES]);

  it('applies a per-tool BLOCK rule', () => {
    const d = decide(policy, 'example_blocked_tool');
    expect(d.outcome).toBe('BLOCK');
    expect(d.code).toBe('example_block');
    expect(d.ruleId).toBe('example.block_tool');
  });

  it('applies a per-tool PASS rule (pre-approved)', () => {
    expect(decide(policy, 'example_safe_tool').outcome).toBe('PASS');
  });

  it('applies an input-conditional BLOCK, else falls through to WARN', () => {
    expect(decide(policy, 'send_email', { to: 'x@example.gov' }).outcome).toBe('BLOCK');
    expect(decide(policy, 'send_email', { to: 'x@acme.com' }).outcome).toBe('WARN');
  });

  it('first matching rule wins (order matters)', () => {
    const first: ComplianceRule = {
      id: 'a.pass',
      description: 'pass first',
      outcome: 'PASS',
      matches: () => true,
    };
    const second: ComplianceRule = {
      id: 'b.block',
      description: 'block second',
      outcome: 'BLOCK',
      matches: () => true,
    };
    expect(decide(ruleBasedCompliancePolicy([first, second]), 't').outcome).toBe('PASS');
    expect(decide(ruleBasedCompliancePolicy([second, first]), 't').outcome).toBe('BLOCK');
  });

  it('fails safe: a rule whose matcher throws is skipped, not crashed open', () => {
    const throwing: ComplianceRule = {
      id: 'boom',
      description: 'throws',
      outcome: 'PASS',
      matches: () => {
        throw new Error('boom');
      },
    };
    // The throwing PASS rule is skipped → falls through to the catch-all WARN.
    const policyWithThrow = ruleBasedCompliancePolicy([throwing, ...DEFAULT_COMPLIANCE_RULES]);
    expect(decide(policyWithThrow, 'send_email').outcome).toBe('WARN');
  });

  it('empty rule set → fallback WARN', () => {
    expect(decide(ruleBasedCompliancePolicy([]), 'anything').outcome).toBe('WARN');
  });
});

describe('PROPOSED_CAPIRO_RULES — the tiered production proposal', () => {
  const policy = ruleBasedCompliancePolicy([...PROPOSED_CAPIRO_RULES]);

  it('holds external sends for approval (WARN, external_send)', () => {
    for (const tool of ['send_email', 'reply_email']) {
      const d = decide(policy, tool, { to: 'x@y.com' });
      expect(d.outcome).toBe('WARN');
      expect(d.code).toBe('external_send');
      expect(d.ruleId).toBe('send.requires_approval');
    }
  });

  it('holds client-profile mutations for approval (WARN, crm_mutation)', () => {
    const d = decide(policy, 'update_client_profile', { clientId: 'c1' });
    expect(d.outcome).toBe('WARN');
    expect(d.code).toBe('crm_mutation');
  });

  it('holds engagement task writes for approval (WARN, crm_mutation, crm_task.requires_approval)', () => {
    for (const tool of ['create_task', 'update_task']) {
      const d = decide(policy, tool, { title: 't' });
      expect(d.outcome).toBe('WARN');
      expect(d.code).toBe('crm_mutation');
      expect(d.ruleId).toBe('crm_task.requires_approval');
    }
  });

  it('holds standing automation for approval (WARN, standing_automation)', () => {
    for (const tool of ['schedule_task', 'cancel_scheduled_task']) {
      expect(decide(policy, tool).outcome).toBe('WARN');
      expect(decide(policy, tool).code).toBe('standing_automation');
    }
  });

  it('pre-approves internal artifacts + task bookkeeping (PASS, audited)', () => {
    for (const tool of [
      'save_note',
      'save_memory',
      'confirm_memory',
      'correct_memory',
      'forget_memory',
      'create_word',
      'create_excel',
      'create_powerpoint',
      'create_meeting_brief',
      'draft_policy_memo',
    ]) {
      const d = decide(policy, tool);
      expect(d.outcome).toBe('PASS');
      expect(d.ruleId).toBe('internal_artifacts.pass');
    }
  });

  it('any write tool NOT named falls back to WARN (new capability never self-approves)', () => {
    const d = decide(policy, 'some_future_write_tool');
    expect(d.outcome).toBe('WARN');
    expect(d.ruleId).toBeUndefined(); // fallback, not a rule
  });
});

// ── G4: risk-tier annotations propagate onto the decision ────────────────────
describe('PROPOSED_CAPIRO_RULES — G4 tier propagation', () => {
  const policy = ruleBasedCompliancePolicy([...PROPOSED_CAPIRO_RULES]);

  it('external send carries tier=restricted', () => {
    expect(decide(policy, 'send_email', { to: 'x@y.com' }).tier).toBe('restricted');
    expect(decide(policy, 'reply_email', {}).tier).toBe('restricted');
  });
  it('CRM mutation + standing automation carry tier=high', () => {
    expect(decide(policy, 'update_client_profile', {}).tier).toBe('high');
    expect(decide(policy, 'create_task', { title: 't' }).tier).toBe('high');
    expect(decide(policy, 'update_task', { taskId: 't' }).tier).toBe('high');
    expect(decide(policy, 'schedule_task', {}).tier).toBe('high');
  });
  it('internal reversible artifacts carry tier=low', () => {
    expect(decide(policy, 'save_note', {}).tier).toBe('low');
    expect(decide(policy, 'create_word', {}).tier).toBe('low');
  });
  it('an unmatched tool has no tier (fallback WARN, tier undefined)', () => {
    expect(decide(policy, 'some_future_write_tool', {}).tier).toBeUndefined();
  });
});
