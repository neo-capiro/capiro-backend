import { z } from 'zod';
import {
  ApprovalPendingError,
  ComplianceBlockedError,
  PolicyApprovalGate,
  denyAllApprovals,
  staticCompliancePolicy,
  type ApprovalStore,
  type CompliancePolicy,
} from './approval-gate';
import { InMemoryToolRegistry } from '../registry/tool-registry';
import { ApprovalRequiredError, type MeriContext, type ToolDefinition } from '../registry/types';

const ctx: MeriContext = {
  tenantId: 't1',
  userId: 'u1',
  clerkUserId: 'cu1',
  role: 'member' as never,
};

const policyOf = (
  outcome: 'PASS' | 'WARN' | 'BLOCK',
  reasons = ['because'],
  code?: string,
): CompliancePolicy => ({
  evaluate: () => ({ outcome, reasons, code }),
});

describe('PolicyApprovalGate', () => {
  it('PASS → resolves (handler may run)', async () => {
    const gate = new PolicyApprovalGate(policyOf('PASS'));
    await expect(gate.check('save_note', {}, ctx)).resolves.toBeUndefined();
  });

  it('BLOCK → throws ComplianceBlockedError carrying reasons + code', async () => {
    const gate = new PolicyApprovalGate(policyOf('BLOCK', ['gift over limit'], 'gift_rule'));
    await expect(gate.check('send_email', {}, ctx)).rejects.toBeInstanceOf(ComplianceBlockedError);
    try {
      await gate.check('send_email', {}, ctx);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ComplianceBlockedError);
      expect((err as ComplianceBlockedError).reasons).toEqual(['gift over limit']);
      expect((err as ComplianceBlockedError).code).toBe('gift_rule');
      expect((err as ComplianceBlockedError).toolName).toBe('send_email');
    }
  });

  it('WARN with no approval → throws ApprovalPendingError (fail-closed)', async () => {
    const gate = new PolicyApprovalGate(policyOf('WARN', ['needs sign-off']));
    await expect(gate.check('save_note', {}, ctx)).rejects.toBeInstanceOf(ApprovalPendingError);
  });

  it('WARN with a recorded approval → resolves', async () => {
    const approveAll: ApprovalStore = { isApproved: () => true };
    const gate = new PolicyApprovalGate(policyOf('WARN'), approveAll);
    await expect(gate.check('save_note', {}, ctx)).resolves.toBeUndefined();
  });

  it('denyAllApprovals approves nothing', async () => {
    await expect(denyAllApprovals.isApproved('x', {}, ctx)).toBe(false);
  });
});

describe('staticCompliancePolicy', () => {
  it('defaults unlisted tools to WARN (require approval)', async () => {
    const p = staticCompliancePolicy();
    expect(await p.evaluate('anything', {}, ctx)).toMatchObject({ outcome: 'WARN' });
  });

  it('honors explicit per-tool outcomes and a custom fallback', async () => {
    const p = staticCompliancePolicy({
      outcomes: { send_email: 'BLOCK', get_thing: 'PASS' },
      fallback: 'PASS',
    });
    expect((await p.evaluate('send_email', {}, ctx)).outcome).toBe('BLOCK');
    expect((await p.evaluate('get_thing', {}, ctx)).outcome).toBe('PASS');
    expect((await p.evaluate('unlisted', {}, ctx)).outcome).toBe('PASS');
  });

  it('always populates reasons (never silently empty)', async () => {
    const p = staticCompliancePolicy({ outcomes: { save_note: 'WARN' } });
    expect((await p.evaluate('save_note', {}, ctx)).reasons.length).toBeGreaterThan(0);
  });
});

describe('InMemoryToolRegistry + PolicyApprovalGate (write-tool enforcement)', () => {
  const writeTool: ToolDefinition<{ text: string }, { saved: true }> = {
    name: 'save_note',
    description: 'persist a note',
    readOnly: false,
    inputSchema: z.object({ text: z.string() }),
    handler: async () => ({ saved: true }),
  };
  const readTool: ToolDefinition<Record<string, never>, { ok: true }> = {
    name: 'get_thing',
    description: 'read a thing',
    readOnly: true,
    inputSchema: z.object({}),
    handler: async () => ({ ok: true }),
  };

  it('holds a WARN write tool pending approval (ApprovalPendingError)', async () => {
    const registry = new InMemoryToolRegistry({
      approvalGate: new PolicyApprovalGate(staticCompliancePolicy({ fallback: 'WARN' })),
    });
    registry.register(writeTool);
    await expect(registry.invoke('save_note', { text: 'x' }, ctx)).rejects.toBeInstanceOf(
      ApprovalPendingError,
    );
  });

  it('runs a write tool when the policy PASSes', async () => {
    const registry = new InMemoryToolRegistry({
      approvalGate: new PolicyApprovalGate(policyOf('PASS')),
    });
    registry.register(writeTool);
    await expect(registry.invoke('save_note', { text: 'x' }, ctx)).resolves.toEqual({
      saved: true,
    });
  });

  it('never invokes the gate for a read-only tool', async () => {
    const evaluate = jest.fn(() => ({ outcome: 'BLOCK' as const, reasons: ['x'] }));
    const registry = new InMemoryToolRegistry({
      approvalGate: new PolicyApprovalGate({ evaluate }),
    });
    registry.register(readTool);
    await expect(registry.invoke('get_thing', {}, ctx)).resolves.toEqual({ ok: true });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('still fails closed for a write tool when NO gate is configured', async () => {
    const registry = new InMemoryToolRegistry();
    registry.register(writeTool);
    await expect(registry.invoke('save_note', { text: 'x' }, ctx)).rejects.toBeInstanceOf(
      ApprovalRequiredError,
    );
  });
});
