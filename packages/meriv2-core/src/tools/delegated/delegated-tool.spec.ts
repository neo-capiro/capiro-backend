import { createDelegatedTool, registerDelegatedTools, type ToolExecutor } from './delegated-tool';
import { InMemoryToolRegistry } from '../../registry/tool-registry';
import {
  ApprovalRequiredError,
  ComplianceBlockedError,
  PolicyApprovalGate,
  staticCompliancePolicy,
  type MeriContext,
} from '../../index';

const ctx: MeriContext = {
  tenantId: 't1',
  userId: 'u1',
  clerkUserId: 'cu1',
  role: 'member' as never,
};

class SpyExecutor implements ToolExecutor {
  calls: Array<{ toolName: string; input: Record<string, unknown>; tenantId: string }> = [];
  result: unknown = { ok: true };
  async execute(c: MeriContext, toolName: string, input: Record<string, unknown>) {
    this.calls.push({ toolName, input, tenantId: c.tenantId });
    return this.result;
  }
}

describe('createDelegatedTool', () => {
  it('forwards (ctx, name, input) to the executor and returns its result', async () => {
    const exec = new SpyExecutor();
    exec.result = { items: [1, 2], count: 2 };
    const tool = createDelegatedTool(
      { name: 'search_congress_bills', description: 'x', readOnly: true },
      exec,
    );
    const out = await tool.handler({ q: 'ndaa', limit: 5 }, ctx);
    expect(out).toEqual({ items: [1, 2], count: 2 });
    expect(exec.calls).toEqual([
      { toolName: 'search_congress_bills', input: { q: 'ndaa', limit: 5 }, tenantId: 't1' },
    ]);
  });

  it('carries the readOnly flag through', () => {
    expect(
      createDelegatedTool({ name: 'a', description: 'x', readOnly: true }, new SpyExecutor())
        .readOnly,
    ).toBe(true);
    expect(
      createDelegatedTool({ name: 'b', description: 'x', readOnly: false }, new SpyExecutor())
        .readOnly,
    ).toBe(false);
  });

  it('accepts an arbitrary object input (apps/api is the validation authority)', () => {
    const tool = createDelegatedTool(
      { name: 'a', description: 'x', readOnly: true },
      new SpyExecutor(),
    );
    expect(tool.inputSchema.safeParse({ anything: true, nested: { x: 1 } }).success).toBe(true);
    expect(tool.inputSchema.safeParse({}).success).toBe(true);
  });
});

describe('delegated tools through the registry (choke-point guarantees)', () => {
  it('a delegated READ tool runs after scoping, then delegates', async () => {
    const exec = new SpyExecutor();
    const registry = new InMemoryToolRegistry();
    registry.register(
      createDelegatedTool({ name: 'search_lda_filings', description: 'x', readOnly: true }, exec),
    );
    const out = await registry.invoke('search_lda_filings', { registrant: 'Acme' }, ctx);
    expect(out).toEqual({ ok: true });
    expect(exec.calls[0]?.toolName).toBe('search_lda_filings');
  });

  it('a delegated WRITE tool is gated BEFORE delegation (no gate → never executes)', async () => {
    const exec = new SpyExecutor();
    const registry = new InMemoryToolRegistry(); // no approvalGate configured
    registry.register(
      createDelegatedTool({ name: 'send_email', description: 'x', readOnly: false }, exec),
    );
    await expect(registry.invoke('send_email', { to: 'x' }, ctx)).rejects.toBeInstanceOf(
      ApprovalRequiredError,
    );
    // Critical: the delegated call was NEVER made — the write was stopped at the gate.
    expect(exec.calls).toEqual([]);
  });

  it('a delegated WRITE tool blocked by policy never delegates', async () => {
    const exec = new SpyExecutor();
    const registry = new InMemoryToolRegistry({
      approvalGate: new PolicyApprovalGate(
        staticCompliancePolicy({ outcomes: { send_email: 'BLOCK' } }),
      ),
    });
    registry.register(
      createDelegatedTool({ name: 'send_email', description: 'x', readOnly: false }, exec),
    );
    await expect(registry.invoke('send_email', { to: 'x' }, ctx)).rejects.toBeInstanceOf(
      ComplianceBlockedError,
    );
    expect(exec.calls).toEqual([]);
  });
});

describe('registerDelegatedTools', () => {
  it('registers each spec and returns the names', () => {
    const exec = new SpyExecutor();
    const registry = new InMemoryToolRegistry();
    const names = registerDelegatedTools(
      (def) => registry.register(def),
      [
        { name: 'search_congress_bills', description: 'x', readOnly: true },
        { name: 'search_lda_filings', description: 'y', readOnly: true },
      ],
      exec,
    );
    expect(names).toEqual(['search_congress_bills', 'search_lda_filings']);
    expect(registry.list()).toEqual(['search_congress_bills', 'search_lda_filings']);
  });
});
