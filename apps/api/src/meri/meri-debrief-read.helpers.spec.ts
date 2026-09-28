import { BadRequestException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { classifyApiToolReadOutcome } from '@capiro/shared/meri-read-outcome';
import { buildDebriefReadResult, parseDebriefReadInput } from './meri-debrief-read.helpers';

const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as TenantContext;

function row(body = 'Exact debrief source text') {
  return {
    id: 'debrief-1',
    meetingId: 'meeting-1',
    clientId: 'client-1',
    body,
    status: 'approved',
    authorUserId: 'user-1',
    author: {
      id: 'user-1',
      email: 'owner@example.com',
      firstName: 'Owner',
      lastName: 'User',
    },
    createdAt: new Date('2026-09-20T10:00:00.000Z'),
    updatedAt: new Date('2026-09-21T10:00:00.000Z'),
    meeting: {
      id: 'meeting-1',
      clientId: 'client-1',
      subject: 'Client review',
      startsAt: new Date('2026-09-19T14:00:00.000Z'),
    },
  };
}

function page(rows = [row()], nextAfter: { createdAt: Date; id: string } | null = null) {
  return { rows, sourceStatus: 'healthy' as const, sourceReason: null, nextAfter };
}

describe('bounded exact query_debriefs projection', () => {
  it('does not invent a default time window and returns exact source text', () => {
    const selection = parseDebriefReadInput(ctx, { clientId: 'client-1' }, 'client-1');
    const result = buildDebriefReadResult(ctx, selection, page());

    expect(selection.from).toBeNull();
    expect(selection.to).toBeNull();
    expect(result.scope).toMatchObject({ from: null, to: null, timeField: 'meeting.startsAt' });
    expect(result.debriefs[0]!.body).toBe('Exact debrief source text');
    expect(result.coverage.complete).toBe(true);
    expect(classifyApiToolReadOutcome('query_debriefs', result)).toEqual({ kind: 'complete' });
  });

  it('marks a first-25/list continuation as partial rather than complete', () => {
    const selection = parseDebriefReadInput(
      ctx,
      { clientId: 'client-1', limit: 1 },
      'client-1',
    );
    const result = buildDebriefReadResult(
      ctx,
      selection,
      page([row()], { createdAt: row().createdAt, id: row().id }),
    );

    expect(result.coverage).toMatchObject({ complete: false, partial: true, paginationComplete: false });
    expect(result.coverage.nextCursor).toEqual(expect.stringMatching(/^debrief:/));
    expect(classifyApiToolReadOutcome('query_debriefs', result)).toEqual({
      kind: 'partial',
      reason: 'debrief_coverage_incomplete',
    });
  });

  it('provides an actor/client/version-bound exact body cursor for long text', () => {
    const longBody = 'abcdef'.repeat(1500);
    const selection = parseDebriefReadInput(
      ctx,
      { clientId: 'client-1', debriefId: 'debrief-1', characterLimit: 100 },
      'client-1',
    );
    const first = buildDebriefReadResult(ctx, selection, page([row(longBody)]));
    const cursor = first.coverage.nextCursor;

    expect(first.debriefs[0]!.body).toBe(longBody.slice(0, 100));
    expect(first.debriefs[0]!.bodyCoverage).toMatchObject({
      complete: false,
      characterStart: 0,
      characterEnd: 100,
    });
    expect(first.coverage.complete).toBe(false);
    expect(classifyApiToolReadOutcome('query_debriefs', first)).toEqual({ kind: 'complete' });

    const continuation = parseDebriefReadInput(
      ctx,
      { clientId: 'client-1', debriefId: 'debrief-1', cursor, characterLimit: 100 },
      'client-1',
    );
    const second = buildDebriefReadResult(ctx, continuation, page([row(longBody)]));
    expect(second.debriefs[0]!.body).toBe(longBody.slice(100, 200));

    expect(() =>
      parseDebriefReadInput(
        { ...ctx, userId: 'different-user' },
        { clientId: 'client-1', debriefId: 'debrief-1', cursor },
        'client-1',
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      buildDebriefReadResult(ctx, continuation, page([{
        ...row(`${longBody} edited`),
        updatedAt: new Date('2026-09-22T10:00:00.000Z'),
      }]),
    )).toThrow('changed since the previous body page');
  });

  it('qualifies complete zero only after a healthy authorized query', () => {
    const selection = parseDebriefReadInput(ctx, { clientId: 'client-1' }, 'client-1');
    const empty = buildDebriefReadResult(ctx, selection, page([]));
    const degraded = buildDebriefReadResult(ctx, selection, {
      rows: [],
      sourceStatus: 'degraded',
      sourceReason: 'authorized_debrief_scan_bound_reached',
      nextAfter: null,
    });

    expect(classifyApiToolReadOutcome('query_debriefs', empty)).toEqual({ kind: 'empty' });
    expect(classifyApiToolReadOutcome('query_debriefs', degraded)).toEqual({
      kind: 'partial',
      reason: 'debrief_source_coverage_incomplete',
    });
    expect(degraded.coverage.nextCursor).toBeNull();
  });
});
