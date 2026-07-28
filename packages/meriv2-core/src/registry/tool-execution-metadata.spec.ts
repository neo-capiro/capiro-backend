import { actionBehaviorPrompt, toolExecutionMetadataFor } from './tool-execution-metadata';
import { InMemoryToolRegistry } from './tool-registry';
import { z } from 'zod';

const ctx = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'user_1',
  role: 'standard_user' as const,
};

describe('canonical tool execution metadata', () => {
  it('classifies reads, internal artifacts, CRM writes, and external sends deterministically', () => {
    expect(toolExecutionMetadataFor('search_state_bills', true)).toEqual(
      expect.objectContaining({
        readOnly: true,
        executionMode: 'read',
        externalEffect: 'none',
        riskTier: 'low',
      }),
    );
    expect(toolExecutionMetadataFor('create_word', false)).toEqual(
      expect.objectContaining({
        executionMode: 'immediate_internal',
        externalEffect: 'internal_artifact',
        riskTier: 'low',
      }),
    );
    expect(toolExecutionMetadataFor('create_task', false)).toEqual(
      expect.objectContaining({
        executionMode: 'approval_required',
        externalEffect: 'crm_mutation',
        riskTier: 'high',
      }),
    );
    expect(toolExecutionMetadataFor('send_email', false)).toEqual(
      expect.objectContaining({
        executionMode: 'approval_required',
        externalEffect: 'external_send',
        reversible: false,
        riskTier: 'restricted',
      }),
    );
  });

  it('exposes the exact metadata the registry enforces', () => {
    const approvalGate = { check: jest.fn().mockResolvedValue(undefined) };
    const registry = new InMemoryToolRegistry({ approvalGate });
    registry.register({
      name: 'create_task',
      description: 'Create a task',
      inputSchema: z.object({ title: z.string() }),
      readOnly: false,
      handler: jest.fn().mockResolvedValue({ ok: true }),
    });

    expect(registry.executionMetadata('create_task')).toEqual(
      toolExecutionMetadataFor('create_task', false),
    );
  });

  it('derives prompt claims from the same metadata and never calls create_task immediate', () => {
    const tools = [
      toolExecutionMetadataFor('create_word', false),
      toolExecutionMetadataFor('create_task', false),
      toolExecutionMetadataFor('send_email', false),
    ];
    const prompt = actionBehaviorPrompt(tools);

    expect(prompt).toContain('Create Word document (create_word)');
    expect(prompt).toContain('Create task (create_task)');
    expect(prompt).toContain('Send email (send_email)');
    const immediateLine =
      prompt.split('\n').find((line) => line.includes('Runs immediately')) ?? '';
    const approvalLine =
      prompt.split('\n').find((line) => line.includes('waits for explicit approval')) ?? '';
    expect(immediateLine).toContain('create_word');
    expect(immediateLine).not.toContain('create_task');
    expect(approvalLine).toContain('create_task');
    expect(approvalLine).toContain('send_email');
  });

  it('still runs the approval gate before a canonical approval-required write', async () => {
    // Explicit call-order log: `toHaveBeenCalledBefore` is a jest-extended matcher
    // and is not installed here, so ordering is recorded rather than asserted via
    // a matcher that silently does not exist.
    const order: string[] = [];
    const approvalGate = {
      check: jest.fn(async () => {
        order.push('gate');
      }),
    };
    const handler = jest.fn(async () => {
      order.push('handler');
      return { ok: true };
    });
    const registry = new InMemoryToolRegistry({ approvalGate });
    registry.register({
      name: 'create_task',
      description: 'Create a task',
      inputSchema: z.object({ title: z.string() }),
      readOnly: false,
      handler,
    });

    await expect(registry.invoke('create_task', { title: 'Follow up' }, ctx)).resolves.toEqual({
      ok: true,
    });
    expect(order).toEqual(['gate', 'handler']);
  });

  it('does not run the handler when the approval gate rejects the write', async () => {
    const order: string[] = [];
    const approvalGate = {
      check: jest.fn(async () => {
        order.push('gate');
        const error = new Error('Approval required');
        error.name = 'ApprovalPendingError';
        throw error;
      }),
    };
    const handler = jest.fn(async () => {
      order.push('handler');
      return { ok: true };
    });
    const registry = new InMemoryToolRegistry({ approvalGate });
    registry.register({
      name: 'create_task',
      description: 'Create a task',
      inputSchema: z.object({ title: z.string() }),
      readOnly: false,
      handler,
    });

    await expect(registry.invoke('create_task', { title: 'Follow up' }, ctx)).rejects.toThrow(
      'Approval required',
    );
    expect(order).toEqual(['gate']);
    expect(handler).not.toHaveBeenCalled();
  });
});
