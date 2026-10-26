import type { TenantContext } from '@capiro/shared';
import { createHash } from 'node:crypto';
import {
  buildMeetingListResult,
  buildMeetingSourceResult,
  parseMeetingReadInput,
  type ExactMeetingSource,
  type MeetingReadRow,
} from './meri-meeting-read.helpers';
import { meetingOwnerProof } from './meri-research-meeting-proof';
import {
  currentOwnerResultAuthorizesReplay,
  currentMeetingSourceScopeAuthorization,
  supportsDurableOwnerReauthorization,
} from './meri-research-replay-authorization';
import { publicResearchSourceTool } from './meri-report-provenance';

const ctx = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  userId: 'actor-1',
} as TenantContext;
const clientId = '22222222-2222-2222-2222-222222222222';

function row(id: string, startsAt: string): MeetingReadRow {
  return {
    id,
    clientId,
    subject: `Meeting ${id}`,
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString(),
    status: 'completed',
    updatedAt: '2026-09-20T00:00:00.000Z',
    sources: [],
    sourceAvailability: {
      notes: 'empty',
      transcript: 'unavailable',
      transcriptReason: 'calendar_event_without_persisted_transcript',
    },
  };
}

function source(body = 'Exact persisted transcript bytes'): ExactMeetingSource {
  const hash = createHash('sha256').update(body).digest('hex');
  return {
    sourceKind: 'transcript',
    sourceId: 'source-1',
    sourceVersion: hash,
    meetingId: 'meeting-1',
    clientId,
    lifecycleStatus: 'ready',
    availability: 'available',
    availabilityReason: null,
    contentHash: hash,
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    body,
  };
}

const meeting = {
  ...row('meeting-1', '2026-09-19T14:00:00.000Z'),
  sourceAvailability: {
    notes: 'empty' as const,
    transcript: 'available' as const,
    transcriptReason: null,
  },
};

describe('read_client_meetings canonical pagination and proof', () => {
  it('continues repeated empty source pages without encoding omitted identities or dates', () => {
    const selection = parseMeetingReadInput(ctx, { clientId, limit: 1 }, clientId);
    const omitted = row('omitted-private-first', '2026-09-01T10:00:00.000Z');
    const first = buildMeetingListResult(ctx, selection, [], true, 1, [omitted]);
    expect(first.coverage).toMatchObject({ complete: false, partial: true, meetingPaginationComplete: false });
    expect(first.meetings).toEqual([]);
    const decoded = Buffer.from(first.coverage.nextCursor!.split(':')[1]!, 'base64url').toString();
    expect(decoded).not.toContain(omitted.id);
    expect(decoded).not.toContain(omitted.startsAt);
    const next = parseMeetingReadInput(ctx, { clientId, limit: 1, cursor: first.coverage.nextCursor }, clientId);
    expect(next.listAfter).toBeNull();
    expect(next.listSkip).toEqual({ count: 1,
      boundarySha256: createHash('sha256').update(JSON.stringify([omitted.id, omitted.startsAt])).digest('hex') });
    const secondOmitted = row('omitted-private-second', '2026-09-02T10:00:00.000Z');
    const second = buildMeetingListResult(ctx, next, [], true, 1, [secondOmitted]);
    const third = parseMeetingReadInput(ctx, { clientId, limit: 1, cursor: second.coverage.nextCursor }, clientId);
    expect(third.listSkip?.count).toBe(2);
    expect(third.listOffset).toBe(2);
    const available = row('later-authorized', '2026-09-03T10:00:00.000Z');
    const last = buildMeetingListResult(ctx, third, [available], false);
    expect(last.meetings).toEqual([available]);
    expect(last.coverage).toMatchObject({ nextCursor: null, complete: false, meetingPaginationComplete: true });
  });

  it('retains a readable keyset anchor and bounds omitted-prefix continuation', () => {
    const selection = parseMeetingReadInput(ctx, { clientId, limit: 2 }, clientId);
    const visible = row('readable', '2026-09-01T10:00:00.000Z');
    const hidden = row('hidden', '2026-09-02T10:00:00.000Z');
    const page = buildMeetingListResult(ctx, selection, [visible], true, 1, [visible, hidden]);
    const next = parseMeetingReadInput(ctx, { clientId, cursor: page.coverage.nextCursor }, clientId);
    expect(next.listAfter).toEqual({ id: visible.id, startsAt: new Date(visible.startsAt) });
    expect(next.listSkip?.count).toBe(1);
    const decoded = JSON.parse(Buffer.from(page.coverage.nextCursor!.split(':')[1]!, 'base64url').toString());
    expect(JSON.stringify(decoded)).not.toContain(hidden.id);
    for (const invalid of [0, -1, 1001, 1.5]) {
      const cursor = 'client-meetings:' + Buffer.from(JSON.stringify({ ...decoded, skippedCount: invalid })).toString('base64url');
      expect(() => parseMeetingReadInput(ctx, { clientId, cursor }, clientId)).toThrow('invalid');
    }
    expect(() => buildMeetingListResult(ctx, { ...next, listSkip: { ...next.listSkip!, count: 1000 } },
      [], true, 1, [hidden])).toThrow('narrow the time window');
  });

  it('pages more than one meeting and keeps a calendar event without transcript explicit', () => {
    const selection = parseMeetingReadInput(ctx, { clientId, limit: 2 }, clientId);
    const first = buildMeetingListResult(
      ctx,
      selection,
      [row('meeting-1', '2026-09-01T10:00:00.000Z'), row('meeting-2', '2026-09-02T10:00:00.000Z')],
      true,
    );
    expect(first.coverage).toMatchObject({
      meetingPaginationComplete: false,
      sourceBodyCoverageComplete: false,
    });
    expect(meetingOwnerProof(first)).toMatchObject({
      owner: 'engagement_meeting_inventory',
      meetings: [{ id: 'meeting-1' }, { id: 'meeting-2' }],
    });
    expect(first.meetings[0]!.sourceAvailability).toEqual({
      notes: 'empty',
      transcript: 'unavailable',
      transcriptReason: 'calendar_event_without_persisted_transcript',
    });
    const next = parseMeetingReadInput(
      ctx,
      { clientId, limit: 2, cursor: first.coverage.nextCursor },
      clientId,
    );
    expect(next.listAfter).toEqual({
      startsAt: new Date('2026-09-02T10:00:00.000Z'),
      id: 'meeting-2',
    });
    expect(() =>
      parseMeetingReadInput(
        { ...ctx, userId: 'other-actor' },
        { clientId, limit: 2, cursor: first.coverage.nextCursor },
        clientId,
      ),
    ).toThrow('does not match');
  });

  it('returns useful exact source windows and binds replay to bytes and source version', () => {
    const body = 'abcdefghij';
    const firstSelection = parseMeetingReadInput(
      ctx,
      {
        clientId,
        meetingId: 'meeting-1',
        sourceKind: 'transcript',
        sourceId: 'source-1',
        characterLimit: 6,
      },
      clientId,
    );
    const first = buildMeetingSourceResult(ctx, firstSelection, meeting, source(body));
    expect(first.source.body).toBe('abcdef');
    expect(first.coverage).toMatchObject({ complete: false, truncated: true });
    expect(meetingOwnerProof(first)).not.toBeNull();

    const secondSelection = parseMeetingReadInput(
      ctx,
      {
        clientId,
        meetingId: 'meeting-1',
        sourceKind: 'transcript',
        sourceId: 'source-1',
        characterLimit: 6,
        cursor: first.coverage.nextCursor,
      },
      clientId,
    );
    const second = buildMeetingSourceResult(ctx, secondSelection, meeting, source(body));
    expect(second.source.body).toBe('ghij');
    expect(second.source.bodyCoverage).toMatchObject({
      characterStart: 6,
      characterEnd: 10,
      truncated: false,
    });

    expect(supportsDurableOwnerReauthorization('read_client_meetings')).toBe(true);
    expect(publicResearchSourceTool('read_client_meetings')).toBe('read_client_meetings');
    expect(currentOwnerResultAuthorizesReplay('read_client_meetings', first, first)).toBe(true);
    const edited = buildMeetingSourceResult(
      ctx,
      parseMeetingReadInput(
        ctx,
        {
          clientId,
          meetingId: 'meeting-1',
          sourceKind: 'transcript',
          sourceId: 'source-1',
          characterLimit: 6,
        },
        clientId,
      ),
      meeting,
      source('edited source bytes'),
    );
    expect(currentOwnerResultAuthorizesReplay('read_client_meetings', first, edited)).toBe(false);
  });

  it('authorizes a fully covered empty inventory without inventing body evidence', () => {
    const selection = parseMeetingReadInput(ctx, { clientId }, clientId);
    const empty = buildMeetingListResult(ctx, selection, [], false);
    expect(empty.coverage.complete).toBe(true);
    expect(meetingOwnerProof(empty)).toMatchObject({
      owner: 'engagement_meeting_inventory',
      meetings: [],
    });
    expect(currentOwnerResultAuthorizesReplay('read_client_meetings', empty, empty)).toBe(true);
  });

  it('binds selected and unfocused replay to the returned client and current wall', async () => {
    const allowedTx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ allowed: true }]),
    } as never;
    const originalInput = {
      clientId,
      meetingId: 'meeting-1',
      sourceKind: 'transcript',
      sourceId: 'source-1',
    };
    const savedResult = buildMeetingSourceResult(
      ctx,
      parseMeetingReadInput(ctx, originalInput, clientId),
      meeting,
      source(),
    );
    await expect(
      currentMeetingSourceScopeAuthorization({
        tx: allowedTx,
        ctx,
        sessionClientId: clientId,
        originalInput,
        savedResult,
      }),
    ).resolves.toMatchObject({ clientId });
    await expect(
      currentMeetingSourceScopeAuthorization({
        tx: allowedTx,
        ctx,
        sessionClientId: null,
        originalInput,
        savedResult,
      }),
    ).resolves.toMatchObject({ clientId });
    await expect(
      currentMeetingSourceScopeAuthorization({
        tx: allowedTx,
        ctx,
        sessionClientId: '33333333-3333-3333-3333-333333333333',
        originalInput,
        savedResult,
      }),
    ).resolves.toBeNull();
    const revokedTx = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ allowed: false }]),
    } as never;
    await expect(
      currentMeetingSourceScopeAuthorization({
        tx: revokedTx,
        ctx,
        sessionClientId: null,
        originalInput,
        savedResult,
      }),
    ).resolves.toBeNull();
  });
});
