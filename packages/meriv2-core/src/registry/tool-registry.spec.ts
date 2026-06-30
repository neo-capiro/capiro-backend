import { z } from 'zod';
import { InMemoryToolRegistry } from './tool-registry';
import {
  ApprovalRequiredError,
  ToolAlreadyRegisteredError,
  ToolInputValidationError,
  ToolNotFoundError,
  type ApprovalGate,
  type MeriContext,
  type ToolDefinition,
} from './types';
import { ScopingError } from '../scoping/scoping-wrapper';

const ctx: MeriContext = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  clerkUserId: 'clerk_1',
  role: 'standard_user',
};

function echoTool(): ToolDefinition<{ value: string }, { echoed: string; tenantId: string }> {
  return {
    name: 'echo',
    description: 'echo the input back, scoped to the caller tenant',
    readOnly: true,
    inputSchema: z.object({ value: z.string() }),
    handler: async (input, c) => ({ echoed: input.value, tenantId: c.tenantId }),
  };
}

describe('InMemoryToolRegistry', () => {
  it('registers, lists, and gets tools', () => {
    const r = new InMemoryToolRegistry();
    r.register(echoTool());
    expect(r.list()).toEqual(['echo']);
    expect(r.get('echo')?.name).toBe('echo');
    expect(r.get('missing')).toBeUndefined();
  });

  it('rejects duplicate registration', () => {
    const r = new InMemoryToolRegistry();
    r.register(echoTool());
    expect(() => r.register(echoTool())).toThrow(ToolAlreadyRegisteredError);
  });

  it('invokes a read tool with validated input and passes the context through', async () => {
    const r = new InMemoryToolRegistry();
    r.register(echoTool());
    const out = await r.invoke<{ echoed: string; tenantId: string }>('echo', { value: 'hi' }, ctx);
    expect(out).toEqual({ echoed: 'hi', tenantId: 'tenant-1' });
  });

  it('throws ToolNotFoundError for unknown tools', async () => {
    const r = new InMemoryToolRegistry();
    await expect(r.invoke('nope', {}, ctx)).rejects.toBeInstanceOf(ToolNotFoundError);
  });

  it('validates input against the zod schema', async () => {
    const r = new InMemoryToolRegistry();
    r.register(echoTool());
    await expect(r.invoke('echo', { value: 42 }, ctx)).rejects.toBeInstanceOf(
      ToolInputValidationError,
    );
  });

  it('enforces scoping before the handler runs', async () => {
    const r = new InMemoryToolRegistry();
    let ran = false;
    r.register({
      name: 'guard',
      description: 'guard',
      readOnly: true,
      inputSchema: z.object({}),
      handler: async () => {
        ran = true;
        return {};
      },
    });
    const bad: MeriContext = { tenantId: '', userId: 'u', clerkUserId: 'c', role: 'standard_user' };
    await expect(r.invoke('guard', {}, bad)).rejects.toBeInstanceOf(ScopingError);
    expect(ran).toBe(false);
  });

  it('fails closed on a write tool with no approval gate', async () => {
    const r = new InMemoryToolRegistry();
    r.register({
      name: 'mutate',
      description: 'mutate',
      readOnly: false,
      inputSchema: z.object({}),
      handler: async () => ({ ok: true }),
    });
    await expect(r.invoke('mutate', {}, ctx)).rejects.toBeInstanceOf(ApprovalRequiredError);
  });

  it('runs the approval gate before a write handler and blocks on rejection', async () => {
    const calls: string[] = [];
    const gate: ApprovalGate = {
      check: async (toolName) => {
        calls.push(toolName);
        throw new Error('BLOCK');
      },
    };
    const r = new InMemoryToolRegistry({ approvalGate: gate });
    let ran = false;
    r.register({
      name: 'mutate',
      description: 'mutate',
      readOnly: false,
      inputSchema: z.object({}),
      handler: async () => {
        ran = true;
        return {};
      },
    });
    await expect(r.invoke('mutate', {}, ctx)).rejects.toThrow('BLOCK');
    expect(calls).toEqual(['mutate']);
    expect(ran).toBe(false);
  });

  it('runs the approval gate then the handler when the gate passes', async () => {
    const gate: ApprovalGate = { check: async () => undefined };
    const r = new InMemoryToolRegistry({ approvalGate: gate });
    r.register({
      name: 'double',
      description: 'double a number',
      readOnly: false,
      inputSchema: z.object({ x: z.number() }),
      handler: async (input) => ({ doubled: input.x * 2 }),
    });
    const out = await r.invoke<{ doubled: number }>('double', { x: 21 }, ctx);
    expect(out).toEqual({ doubled: 42 });
  });
});
