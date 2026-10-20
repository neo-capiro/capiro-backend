import { ServiceUnavailableException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { MeriToolsService } from '../meri-tools.service.js';
import { withMeriToolExecutionControl } from '../meri-tool-request-control.js';
import type { RetainedSourceV02Admission } from './admission.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const ctx = { tenantId: TENANT, userId: ACTOR } as TenantContext;

function admission(
  operation: RetainedSourceV02Admission['operation']['id'],
  input: Record<string, unknown>,
  metadata: unknown,
): RetainedSourceV02Admission {
  return {
    operation: { id: operation, version: '0.2.0' },
    binding: {
      tenantId: TENANT, actorId: ACTOR,
      conversationId: '44444444-4444-4444-8444-444444444444',
      runId: '55555555-5555-4555-8555-555555555555',
      attemptId: '66666666-6666-4666-8666-666666666666',
      workerId: '77777777-7777-4777-8777-777777777777',
      writerFence: 1,
    },
    subject: {
      kind: 'client', entityType: 'client', entityIds: [CLIENT], tenantId: TENANT,
      actorId: ACTOR,
      authorizationDecisionId: '88888888-8888-4888-8888-888888888888',
      policyRevision: 'policy-1', scopes: [], rosterVersionId: null,
    },
    input, metadata, normalizationContext: null,
    argumentsSha256: 'a'.repeat(64), requestSha256: 'b'.repeat(64),
    clientId: CLIENT, hardExpiryMs: Date.now() + 30_000,
  };
}

function harness() {
  const service = Object.create(MeriToolsService.prototype) as MeriToolsService;
  const sequence: string[] = [];
  const wall = jest.fn(async () => { sequence.push('wall'); });
  const upcoming = jest.fn(async () => {
    sequence.push('upcoming');
    return { meetings: [], count: 0, window: {} };
  });
  const debriefs = jest.fn(async () => {
    sequence.push('debriefs');
    return { tool: 'query_debriefs', debriefs: [] };
  });
  const meetings = jest.fn(async () => {
    sequence.push('meetings');
    return { tool: 'read_client_meetings', meetings: [] };
  });
  Object.assign(service, {
    assertMeetingReadAllowed: wall,
    listUpcomingMeetings: upcoming,
    queryDebriefs: debriefs,
    readClientMeetings: meetings,
  });
  return { service, sequence, wall, upcoming, debriefs, meetings };
}

function run<T>(read: () => Promise<T>): Promise<T> {
  return withMeriToolExecutionControl(
    { signal: new AbortController().signal, deadlineAt: Date.now() + 30_000 },
    read,
  );
}

describe('MeriToolsService retained meeting owner read', () => {
  it('places the selected-client wall before and after the canonical upcoming read', async () => {
    const { service, sequence, wall, upcoming } = harness();
    const selection = { clientId: CLIENT, limit: 10, withinDays: 30 };
    const owner = await run(() => service.readRetainedMeetingSourceV02(
      ctx, admission('meeting.list_upcoming_meetings', selection, null),
    ));
    expect(sequence).toEqual(['wall', 'upcoming', 'wall']);
    expect(wall).toHaveBeenCalledTimes(2);
    expect(upcoming).toHaveBeenCalledWith(ctx, selection);
    expect(owner).toMatchObject({
      cursor: null,
      read: {
        tool: 'list_upcoming_meetings', tenantId: TENANT, actorId: ACTOR,
        clientId: CLIENT, sourceIds: ['meetings'],
      },
    });
    expect(owner.read.resultSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Date.parse(owner.read.retrievedAt)).toBeGreaterThan(0);
  });

  it('refuses personal calendar before any owner I/O', async () => {
    const { service, wall, upcoming } = harness();
    const request = admission('meeting.list_upcoming_meetings',
      { clientId: null, limit: 10, withinDays: 30 }, null);
    request.subject.kind = 'personal';
    request.subject.entityType = 'user';
    request.subject.entityIds = [ACTOR];
    await expect(run(() => service.readRetainedMeetingSourceV02(ctx, request)))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(wall).not.toHaveBeenCalled();
    expect(upcoming).not.toHaveBeenCalled();
  });

  it('adapts debrief and meeting body continuations without an offset conflict', async () => {
    const { service, debriefs, meetings } = harness();
    const debriefSelection = {
      clientId: CLIENT, debriefId: '99999999-9999-4999-8999-999999999999',
      from: null, to: null, limit: 25, characterOffset: 0, characterLimit: 5000,
    };
    const debriefRead = await run(() => service.readRetainedMeetingSourceV02(ctx,
      admission('meeting.query_debriefs', debriefSelection, { cursor: 'debrief-cursor' })));
    expect(debriefs).toHaveBeenCalledWith(ctx, {
      clientId: CLIENT, debriefId: debriefSelection.debriefId,
      from: null, to: null, limit: 25, characterLimit: 5000, cursor: 'debrief-cursor',
    });
    expect(debriefRead.cursor).toBe('debrief-cursor');
    expect(debriefSelection.characterOffset).toBe(0);

    const meetingSelection = {
      clientId: CLIENT, meetingId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      sourceKind: 'note', sourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      characterOffset: 0, characterLimit: 5000,
    };
    const meetingRead = await run(() => service.readRetainedMeetingSourceV02(ctx,
      admission('meeting.read_client_meetings', meetingSelection, { cursor: 'meeting-cursor' })));
    expect(meetings).toHaveBeenCalledWith(ctx, {
      clientId: CLIENT, meetingId: meetingSelection.meetingId,
      sourceKind: 'note', sourceId: meetingSelection.sourceId,
      characterLimit: 5000, cursor: 'meeting-cursor',
    });
    expect(meetingRead.cursor).toBe('meeting-cursor');
    expect(meetingSelection.characterOffset).toBe(0);
  });

  it('does not capture a page when the post-owner client wall fails', async () => {
    const { service, wall, upcoming } = harness();
    wall.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => {
      throw new Error('grant revoked');
    });
    await expect(run(() => service.readRetainedMeetingSourceV02(ctx,
      admission('meeting.list_upcoming_meetings',
        { clientId: CLIENT, limit: 10, withinDays: 30 }, null)))).rejects.toThrow('grant revoked');
    expect(upcoming).toHaveBeenCalledTimes(1);
    expect(wall).toHaveBeenCalledTimes(2);
  });
});
