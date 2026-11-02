import { describe, expect, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from './engagement.service.js';
import { parseMeetingCommand } from './meeting-command.input.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ctx = {
  tenantId: id(1),
  userId: id(2),
  clerkUserId: 'synthetic-clerk',
  role: 'standard_user',
} as TenantContext;
const now = '2026-10-31T12:00:00.000Z';

const contextSummary = {
  version: 'd2-debrief-context-v1',
  boundTokens: 8000,
  totalTokens: 1234,
  sourceTruncated: false,
  sections: [
    { name: 'source', tokens: 900, state: 'kept' as const },
    { name: 'prep', tokens: 120, state: 'shortened' as const },
  ],
};

function command(operation: 'debrief-create' | 'note-create', includeContext = true) {
  return parseMeetingCommand({
    schemaVersion: 1,
    requestId: id(3),
    operation,
    meetingId: id(5),
    expectedClientId: null,
    expectedRevision: now,
    meeting: null,
    artifacts: [],
    artifact: {
      id: null,
      revision: null,
      body: operation === 'debrief-create' ? 'Composed debrief body' : 'Note body',
      confidential: false,
      ...(includeContext ? { generatedFrom: contextSummary } : {}),
    },
  });
}

/**
 * Drives the executor's artifact branch directly: the same parsed command, the same
 * transaction shape, and createMeetingDebrief captured at its own seam. This is the
 * boundary where the audited context either reaches persistence or is dropped.
 */
function harness() {
  const created: Array<{ meetingId: string; input: Record<string, unknown> }> = [];
  const service = Object.create(EngagementService.prototype) as unknown as {
    createMeetingDebrief: (
      ctx: TenantContext,
      meetingId: string,
      input: Record<string, unknown>,
    ) => Promise<{ id: string }>;
    runMeetingCommand: (
      ctx: TenantContext,
      command: unknown,
      execution: { tx: unknown; afterCommit: unknown[] },
    ) => Promise<Record<string, unknown>>;
  };
  service.createMeetingDebrief = async (_ctx, meetingId, input) => {
    created.push({ meetingId, input });
    return { id: id(7) };
  };
  const tx = {
    meeting: { findFirst: async () => ({ clientId: id(4), updatedAt: new Date(now) }) },
    $queryRaw: async () => [{ revision: new Date(now) }],
  };
  return { service, created, tx };
}

describe('the debrief create command carries the audited context to persistence', () => {
  test('generatedFrom reaches createMeetingDebrief unchanged', async () => {
    const h = harness();

    const receipt = await h.service.runMeetingCommand(ctx, command('debrief-create'), {
      tx: h.tx,
      afterCommit: [],
    });

    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.input).toMatchObject({
      body: 'Composed debrief body',
      confidential: false,
      generatedFrom: contextSummary,
    });
    // The receipt is the canonical reference projection: no body, no context echo.
    expect(receipt).not.toHaveProperty('generatedFrom');
    expect(receipt).not.toHaveProperty('body');
    expect(JSON.stringify(receipt)).not.toContain('d2-debrief-context-v1');
  });

  test('a debrief create without the summary sends no generatedFrom key at all', async () => {
    const h = harness();

    await h.service.runMeetingCommand(ctx, command('debrief-create', false), {
      tx: h.tx,
      afterCommit: [],
    });

    expect(h.created[0]!.input).not.toHaveProperty('generatedFrom');
  });

  test('a note create never receives the field (the schema refuses it first)', async () => {
    // Parsing is the gate: the command cannot even be built with the context attached.
    expect(() => command('note-create')).toThrow('Review');
  });
});
