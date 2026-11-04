import { describe, expect, jest, test } from '@jest/globals';
import { ConflictException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  commitMeetingCommand,
  readMeetingCommand,
  type MeetingCommandResult,
} from './meeting-command.js';
import { parseMeetingCommand, meetingCommandDigest } from './meeting-command.input.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ctx = {
  tenantId: id(1),
  userId: id(2),
  clerkUserId: 'synthetic-clerk',
  role: 'standard_user',
} as TenantContext;
const now = '2026-10-24T12:00:00.000Z';
const input = {
  schemaVersion: 1,
  requestId: id(3),
  operation: 'create',
  meetingId: null,
  expectedClientId: null,
  expectedRevision: null,
  meeting: {
    subject: 'Synthetic',
    description: null,
    location: null,
    startsAt: now,
    endsAt: '2026-10-24T13:00:00.000Z',
    assignClient: true,
    clientId: id(4),
  },
  artifact: null,
  artifacts: [],
};
const result: MeetingCommandResult = {
  meetingId: id(5),
  clientId: id(4),
  revision: now,
  artifacts: [],
};
type Row = Record<string, any>;

function harness() {
  const state = { receipts: new Map<string, Row>(), mutations: 0, audits: 0 };
  const controls = {
    member: true,
    wall: true,
    available: true,
    failAudit: false,
    failReceipt: false,
    lostCommit: false,
    revision: now,
  };
  const key = (tenant: string, actor: string, request: string) =>
    JSON.stringify([tenant, actor, request]);
  const query = (args: any[]) =>
    Array.isArray(args[0])
      ? { sql: args[0].join('?'), values: args.slice(1) }
      : { sql: args[0].sql, values: args[0].values };
  const tx: Row = {
    tenantMembership: {
      findFirst: async ({ where }: Row) =>
        controls.member && where.userId === ctx.userId ? { role: ctx.role } : null,
    },
    client: { findFirst: async ({ where }: Row) => ({ id: where.id }) },
    $queryRawUnsafe: async () => [{ allowed: controls.wall }],
    meeting: {
      findFirst: async () =>
        controls.available
          ? { id: id(5), clientId: id(4), updatedAt: new Date(controls.revision) }
          : null,
    },
    auditLog: {
      create: async () => {
        if (controls.failAudit) throw new Error('audit unavailable');
        state.audits += 1;
      },
    },
    $queryRaw: async (...args: any[]) => {
      const { sql, values } = query(args);
      if (sql.includes('FROM meeting_command_receipts')) {
        const row = state.receipts.get(key(values[0], values[1], values[2]));
        return row ? [structuredClone(row)] : [];
      }
      if (sql.includes('updated_at')) return [{ revision: new Date(controls.revision) }];
      if (sql.includes('metadata_revision')) return [{ revision: 2 }];
      return [];
    },
    $executeRaw: async (...args: any[]) => {
      const { sql, values: v } = query(args);
      expect(sql).toContain('INSERT INTO meeting_command_receipts');
      if (controls.failReceipt) throw new Error('receipt unavailable');
      state.receipts.set(key(v[0], v[1], v[2]), {
        requestId: v[2],
        payloadDigest: v[3],
        operation: v[4],
        requestedMeetingId: v[5],
        expectedClientId: v[6],
        clientIds: v[7],
        status: v[8],
        result: v[9] ? JSON.parse(v[9]) : null,
        message: v[10],
        createdAt: new Date(now),
      });
      return 1;
    },
  };
  const withTenant = jest.fn(async (tenant: string, work: (tx: Row) => Promise<unknown>) => {
    expect(tenant).toBe(ctx.tenantId);
    const before = structuredClone(state);
    let value: unknown;
    try {
      value = await work(tx);
    } catch (error) {
      Object.assign(state, before);
      throw error;
    }
    if (controls.lostCommit) {
      controls.lostCommit = false;
      throw new Error('committed response lost');
    }
    return value;
  });
  const prisma = { withTenant } as unknown as PrismaService;
  const run = jest.fn(async () => {
    state.mutations += 1;
    return structuredClone(result);
  });
  return { state, controls, tx, prisma, run, withTenant };
}

describe('meeting domain command receipts', () => {
  test('commits mutation/audit/receipt together and replays the same historical result', async () => {
    const h = harness();
    const first = await commitMeetingCommand(h.prisma, ctx, input, h.run);
    expect(first.fresh).toBe(true);
    expect(first.receipt).toMatchObject({ status: 'completed', result, available: true });
    h.controls.available = false;
    const replay = await commitMeetingCommand(h.prisma, ctx, input, h.run);
    expect(replay).toMatchObject({
      fresh: false,
      receipt: { status: 'completed', result, available: false },
    });
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.state.audits).toBe(1);
    expect(h.state.mutations).toBe(1);
    await expect(readMeetingCommand(h.prisma, ctx, input.requestId)).resolves.toMatchObject({
      result,
      available: false,
    });
  });

  test('a conflicting replay cannot become a false no-write refusal', async () => {
    const h = harness();
    const original = await commitMeetingCommand(h.prisma, ctx, input, h.run);
    await expect(
      commitMeetingCommand(
        h.prisma,
        ctx,
        { ...input, meeting: { ...input.meeting, subject: 'Changed' } },
        h.run,
      ),
    ).rejects.toThrow('another meeting action');
    expect(h.state.receipts.size).toBe(1);
    await expect(readMeetingCommand(h.prisma, ctx, input.requestId)).resolves.toEqual(
      original.receipt,
    );
  });

  test('known rollback persists an immutable refusal and never re-executes that request', async () => {
    const h = harness();
    const run = jest.fn(async () => {
      h.state.mutations += 1;
      throw new ConflictException('stale');
    });
    const outcome = await commitMeetingCommand(h.prisma, ctx, input, run);
    expect(outcome).toMatchObject({
      fresh: false,
      receipt: { status: 'refused', result: null, refusal: { code: 'MEETING_COMMAND_REFUSED' } },
    });
    expect(h.state.mutations).toBe(0);
    expect(h.state.audits).toBe(0);
    await expect(commitMeetingCommand(h.prisma, ctx, input, h.run)).resolves.toEqual(outcome);
    expect(h.run).not.toHaveBeenCalled();
  });

  test.each(['failAudit', 'failReceipt'] as const)(
    '%s rolls back all effects and preserves same-key recovery',
    async (failure) => {
      const h = harness();
      h.controls[failure] = true;
      await expect(commitMeetingCommand(h.prisma, ctx, input, h.run)).rejects.toThrow(
        'unavailable',
      );
      expect(h.state.mutations).toBe(0);
      expect(h.state.audits).toBe(0);
      expect(h.state.receipts.size).toBe(0);
      h.controls[failure] = false;
      await expect(commitMeetingCommand(h.prisma, ctx, input, h.run)).resolves.toMatchObject({
        fresh: true,
      });
      expect(h.state.mutations).toBe(1);
    },
  );

  test('commit-response loss recovers by lookup or replay without another write', async () => {
    const h = harness();
    h.controls.lostCommit = true;
    await expect(commitMeetingCommand(h.prisma, ctx, input, h.run)).rejects.toThrow(
      'response lost',
    );
    await expect(readMeetingCommand(h.prisma, ctx, input.requestId)).resolves.toMatchObject({
      result,
    });
    await expect(commitMeetingCommand(h.prisma, ctx, input, h.run)).resolves.toMatchObject({
      fresh: false,
    });
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  test.each(['member', 'wall'] as const)(
    'current %s revocation denies new work, lookup and replay',
    async (permission) => {
      const h = harness();
      await commitMeetingCommand(h.prisma, ctx, input, h.run);
      h.controls[permission] = false;
      await expect(readMeetingCommand(h.prisma, ctx, input.requestId)).rejects.toThrow();
      await expect(commitMeetingCommand(h.prisma, ctx, input, h.run)).rejects.toThrow();
      await expect(
        commitMeetingCommand(h.prisma, ctx, { ...input, requestId: id(8) }, h.run),
      ).rejects.toThrow();
      expect(h.run).toHaveBeenCalledTimes(1);
      expect(h.state.receipts.size).toBe(1);
    },
  );

  test('stale parent revision refuses before the domain writer', async () => {
    const h = harness();
    h.controls.revision = '2026-10-24T12:01:00.000Z';
    const update = {
      ...input,
      operation: 'update',
      meetingId: id(5),
      expectedClientId: id(4),
      expectedRevision: now,
    };
    await expect(commitMeetingCommand(h.prisma, ctx, update, h.run)).resolves.toMatchObject({
      receipt: { status: 'refused' },
    });
    expect(h.run).not.toHaveBeenCalled();
  });

  test('another actor cannot obtain the original receipt', async () => {
    const h = harness();
    await commitMeetingCommand(h.prisma, ctx, input, h.run);
    await expect(
      readMeetingCommand(h.prisma, { ...ctx, userId: id(9) }, input.requestId),
    ).rejects.toThrow();
  });
});

describe('meeting command input binding', () => {
  test('attachments bind their existing integer metadata revision, not a nonexistent timestamp', async () => {
    const h = harness();
    const command = {
      ...input,
      operation: 'share',
      meetingId: id(5),
      expectedClientId: id(4),
      expectedRevision: now,
      meeting: null,
      artifacts: [{ type: 'attachment', id: id(10), revision: 2 }],
    };
    expect(parseMeetingCommand(command).artifacts[0]!.revision).toBe(2);
    expect(() =>
      parseMeetingCommand({ ...command, artifacts: [{ ...command.artifacts[0], revision: now }] }),
    ).toThrow();
    expect(() =>
      parseMeetingCommand({ ...command, artifacts: [{ type: 'note', id: id(10), revision: 2 }] }),
    ).toThrow();
    await expect(commitMeetingCommand(h.prisma, ctx, command, h.run)).resolves.toMatchObject({
      fresh: true,
    });
    const stale = {
      ...command,
      requestId: id(11),
      artifacts: [{ ...command.artifacts[0], revision: 1 }],
    };
    await expect(commitMeetingCommand(h.prisma, ctx, stale, h.run)).resolves.toMatchObject({
      receipt: { status: 'refused' },
    });
    expect(h.run).toHaveBeenCalledTimes(1);
  });
  test('same selected set canonicalizes its order and binds actor/request/revision', () => {
    const share = {
      ...input,
      operation: 'share',
      meetingId: id(5),
      expectedClientId: id(4),
      expectedRevision: now,
      meeting: null,
      artifacts: [
        { type: 'note', id: id(10), revision: now },
        { type: 'debrief', id: id(11), revision: now },
      ],
    };
    const a = parseMeetingCommand(share);
    const b = parseMeetingCommand({ ...share, artifacts: [...share.artifacts].reverse() });
    expect(meetingCommandDigest(ctx, a)).toBe(meetingCommandDigest(ctx, b));
    expect(meetingCommandDigest({ ...ctx, userId: id(7) }, a)).not.toBe(
      meetingCommandDigest(ctx, a),
    );
    expect(
      meetingCommandDigest(ctx, { ...a, expectedRevision: '2026-10-24T12:01:00.000Z' }),
    ).not.toBe(meetingCommandDigest(ctx, a));
  });
  test.each([
    { ...input, extra: true },
    { ...input, requestId: 'invalid' },
    { ...input, operation: 'share' },
    { ...input, operation: 'note-create' },
    { ...input, meeting: { ...input.meeting, endsAt: now } },
  ])('rejects malformed or incoherent command %j', (value) => {
    expect(() => parseMeetingCommand(value)).toThrow('Review');
  });
});

describe('D2 audited debrief context on the meeting command', () => {
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
  const debriefCreate = {
    schemaVersion: 1,
    requestId: id(3),
    operation: 'debrief-create',
    meetingId: id(5),
    expectedClientId: null,
    expectedRevision: now,
    meeting: null,
    artifacts: [],
    artifact: {
      id: null,
      revision: null,
      body: 'Composed debrief body',
      confidential: false,
      generatedFrom: contextSummary,
    },
  };

  test('accepts the summary on a debrief create and keeps it intact', () => {
    expect(parseMeetingCommand(debriefCreate).artifact?.generatedFrom).toEqual(contextSummary);
  });

  test('a debrief create without the summary still parses', () => {
    const { generatedFrom: _omit, ...artifact } = debriefCreate.artifact;
    const parsed = parseMeetingCommand({ ...debriefCreate, artifact });
    expect(parsed.artifact).not.toHaveProperty('generatedFrom');
  });

  test('refuses the summary on a note create', () => {
    expect(() =>
      parseMeetingCommand({ ...debriefCreate, operation: 'note-create' }),
    ).toThrow('Review');
  });

  test('refuses the summary on a debrief update and on approve', () => {
    for (const operation of ['debrief-update', 'debrief-approve'] as const) {
      expect(() => parseMeetingCommand({ ...debriefCreate, operation })).toThrow('Review');
    }
  });

  test('refuses a malformed summary (negative token count)', () => {
    expect(() =>
      parseMeetingCommand({
        ...debriefCreate,
        artifact: {
          ...debriefCreate.artifact,
          generatedFrom: { ...contextSummary, totalTokens: -1 },
        },
      }),
    ).toThrow('Review');
  });

  test('refuses an oversized section list and unknown keys', () => {
    const tooMany = Array.from({ length: 21 }, (_, index) => ({
      name: `section-${index}`,
      tokens: 1,
      state: 'kept' as const,
    }));
    expect(() =>
      parseMeetingCommand({
        ...debriefCreate,
        artifact: {
          ...debriefCreate.artifact,
          generatedFrom: { ...contextSummary, sections: tooMany },
        },
      }),
    ).toThrow('Review');
    expect(() =>
      parseMeetingCommand({
        ...debriefCreate,
        artifact: {
          ...debriefCreate.artifact,
          generatedFrom: { ...contextSummary, raw: 'provider envelope' },
        },
      }),
    ).toThrow('Review');
  });
});
