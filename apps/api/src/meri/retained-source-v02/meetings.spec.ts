import { createHash } from 'node:crypto';
import { projectMeetingSourceV02, type MeetingV02ProjectionRequest } from './meetings.js';

const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const id = (digit: string) =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const clientId = id('9');
const meetingId = id('8');
const noteId = id('7');
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function base(operation: MeetingV02ProjectionRequest['operation']): MeetingV02ProjectionRequest {
  const selection =
    operation === 'meeting.list_upcoming_meetings'
      ? { clientId, limit: 10, withinDays: 30 }
      : operation === 'meeting.query_debriefs'
        ? { clientId, debriefId: null, from: null, to: null, limit: 25, characterLimit: 1500 }
        : { clientId, meetingId: null, from: null, to: null, limit: 25 };
  return {
    operation,
    selection,
    cursor: null,
    nowMs: NOW,
    authority: {
      requestId: id('1'),
      traceId: id('2'),
      binding: {
        tenantId: id('3'),
        actorId: id('4'),
        conversationId: id('5'),
        runId: id('6'),
        attemptId: id('a'),
        workerId: id('b'),
        writerFence: 1,
      },
      subject: {
        kind: 'client',
        entityIds: [clientId],
        tenantId: id('3'),
        actorId: id('4'),
        entityType: 'client',
        authorizationDecisionId: id('c'),
        policyRevision: 'policy-1',
        scopes: [
          { tenantId: id('3'), kind: 'client', resourceId: clientId, policyRevision: 'policy-1' },
        ],
        rosterVersionId: null,
      },
    },
    read: {
      tool: operation.slice('meeting.'.length) as MeetingV02ProjectionRequest['read']['tool'],
      tenantId: id('3'),
      actorId: id('4'),
      clientId,
      sourceIds: ['meetings'],
      retrievedAt: new Date(NOW).toISOString(),
      limitations: [
        'Current meeting owner read has no snapshot identity or proven complete source history.',
      ],
    },
    result: {},
  };
}

function upcoming(): MeetingV02ProjectionRequest {
  const request = base('meeting.list_upcoming_meetings');
  request.result = {
    count: 1,
    window: {
      from: new Date(NOW).toISOString(),
      to: new Date(NOW + 30 * 86400000).toISOString(),
      withinDays: 30,
    },
    meetings: [
      {
        id: meetingId,
        subject: 'Review',
        startsAt: new Date(NOW + 3600000),
        endsAt: new Date(NOW + 7200000),
        location: null,
        isVirtual: true,
        joinLink: null,
        status: 'scheduled',
        isInternal: false,
        organizer: null,
        client: { id: clientId, name: 'Selected client' },
        attendees: [],
      },
    ],
  };
  return request;
}

function debrief(): MeetingV02ProjectionRequest {
  const request = base('meeting.query_debriefs');
  const body = 'Approved note';
  request.result = {
    tool: 'query_debriefs',
    generatedAt: new Date(NOW).toISOString(),
    clientId,
    total: 1,
    returned: 1,
    scope: {
      debriefId: null,
      from: null,
      to: null,
      timeField: 'meeting.startsAt',
      statusEligibility: 'approved_only',
      characterOffset: null,
      characterLimit: 1500,
      listLimit: 25,
      cursorApplied: false,
    },
    coverage: {
      sourceStatus: 'healthy',
      sourceReason: null,
      pageComplete: true,
      complete: true,
      partial: false,
      paginationComplete: true,
      bodyCoverageComplete: true,
      truncated: false,
      nextCursor: null,
      totalIsReturnedPageOnly: true,
      appliesTo: 'approved_only_eligible_debriefs',
      note: 'Exact approved row only.',
    },
    debriefs: [
      {
        id: noteId,
        meetingId,
        clientId,
        meeting: {
          id: meetingId,
          clientId,
          subject: 'Review',
          startsAt: new Date(NOW).toISOString(),
        },
        body,
        status: 'approved',
        authorUserId: null,
        author: null,
        createdAt: new Date(NOW - 2000).toISOString(),
        updatedAt: new Date(NOW - 1000).toISOString(),
        bodyCoverage: {
          characterStart: 0,
          characterEnd: body.length,
          totalCharacters: body.length,
          complete: true,
          pageComplete: true,
          truncated: false,
          nextCursor: null,
          note: 'Exact body.',
        },
        provenance: {
          sourceTable: 'meeting_debriefs',
          sourceRecordId: noteId,
          sourceVersion: new Date(NOW - 1000).toISOString(),
          parentMeetingId: meetingId,
          currentClientId: clientId,
          bodySha256: sha(body),
          returnedBodySha256: sha(body),
        },
      },
    ],
  };
  return request;
}

function meetingInventory(): MeetingV02ProjectionRequest {
  const request = base('meeting.read_client_meetings');
  request.result = {
    tool: 'read_client_meetings',
    generatedAt: new Date(NOW).toISOString(),
    clientId,
    scope: {
      meetingId: null,
      sourceKind: null,
      sourceId: null,
      from: null,
      to: null,
      cursorApplied: false,
      limit: 25,
    },
    coverage: {
      sourceStatus: 'healthy',
      pageComplete: true,
      meetingPaginationComplete: true,
      sourceInventoryComplete: true,
      sourceBodyCoverageComplete: false,
      complete: false,
      partial: true,
      truncated: true,
      omittedMeetings: 0,
      nextCursor: null,
      note: 'Inventory only, bodies require an exact source read.',
    },
    returned: 1,
    meetings: [
      {
        id: meetingId,
        clientId,
        subject: 'Review',
        startsAt: new Date(NOW).toISOString(),
        endsAt: new Date(NOW + 3600000).toISOString(),
        status: 'scheduled',
        updatedAt: new Date(NOW).toISOString(),
        sources: [],
        sourceAvailability: {
          notes: 'empty',
          transcript: 'unavailable',
          transcriptReason: 'calendar_event_without_persisted_transcript',
        },
      },
    ],
  };
  return request;
}

function meetingSourceBody(): MeetingV02ProjectionRequest {
  const request = base('meeting.read_client_meetings');
  const body = 'Exact approved meeting note';
  const version = new Date(NOW - 1000).toISOString();
  request.selection = {
    clientId,
    meetingId,
    sourceKind: 'note',
    sourceId: noteId,
    characterOffset: 0,
    characterLimit: 5000,
  };
  request.result = {
    tool: 'read_client_meetings',
    generatedAt: new Date(NOW).toISOString(),
    clientId,
    scope: {
      meetingId,
      sourceKind: 'note',
      sourceId: noteId,
      from: null,
      to: null,
      cursorApplied: false,
      characterOffset: 0,
      characterLimit: 5000,
    },
    coverage: {
      sourceStatus: 'healthy',
      pageComplete: true,
      meetingPaginationComplete: true,
      sourceInventoryComplete: true,
      sourceBodyCoverageComplete: true,
      complete: true,
      partial: false,
      truncated: false,
      nextCursor: null,
      note: 'Exact body.',
    },
    returned: 1,
    meeting: {
      id: meetingId,
      clientId,
      subject: 'Review',
      startsAt: new Date(NOW).toISOString(),
      endsAt: new Date(NOW + 3600000).toISOString(),
      status: 'scheduled',
      updatedAt: version,
      sourceAvailability: {
        notes: 'available',
        transcript: 'unavailable',
        transcriptReason: 'calendar_event_without_persisted_transcript',
      },
    },
    source: {
      sourceKind: 'note',
      sourceId: noteId,
      sourceVersion: version,
      meetingId,
      clientId,
      lifecycleStatus: 'approved',
      availability: 'available',
      availabilityReason: null,
      contentHash: sha(body),
      createdAt: new Date(NOW - 2000).toISOString(),
      updatedAt: version,
      body,
      bodyCoverage: {
        characterStart: 0,
        characterEnd: body.length,
        totalCharacters: body.length,
        complete: true,
        pageComplete: true,
        truncated: false,
        nextCursor: null,
      },
      provenance: {
        owner: 'meeting_notes',
        sourceKind: 'note',
        sourceId: noteId,
        sourceVersion: version,
        meetingId,
        currentClientId: clientId,
        bodySha256: sha(body),
        returnedBodySha256: sha(body),
        encoding: 'utf8',
        sourceByteLength: Buffer.byteLength(body),
        returnedByteLength: Buffer.byteLength(body),
      },
    },
  };
  return request;
}

describe('Core meeting 0.2 owner projection', () => {
  it('retains client-bound upcoming rows and discloses unknown source coverage', () => {
    const page = projectMeetingSourceV02(upcoming());
    expect(page).toMatchObject({
      kind: 'meeting-upcoming-page',
      count: 1,
      evidenceReady: false,
      negativeAssertion: { kind: 'none' },
      coverage: {
        enumeration: 'unknown',
        enumerableTotal: null,
        returnedCount: 1,
        sourcesRequested: ['meetings'],
        sourcesChecked: ['meetings'],
        truncated: false,
      },
      sources: [
        {
          sourceId: 'meetings',
          status: 'partial',
          snapshotVersionId: null,
          freshness: 'unknown',
          asOf: null,
        },
      ],
    });
    expect((page.meetings as Array<{ startsAt: string }>)[0]?.startsAt).toBe(
      new Date(NOW + 3600000).toISOString(),
    );
  });

  it('refuses a selected-client calendar row for another client', () => {
    const request = upcoming();
    (request.result as { meetings: Array<{ client: { id: string } }> }).meetings[0]!.client.id =
      id('0');
    expect(() => projectMeetingSourceV02(request)).toThrow('selected client');
  });

  it('requires matching owner inventory, subject, and current read time', () => {
    const request = upcoming();
    request.read.sourceIds = [];
    expect(() => projectMeetingSourceV02(request)).toThrow('source inventory');
    request.read.sourceIds = ['meetings'];
    request.authority.subject.entityIds = [id('0')];
    expect(() => projectMeetingSourceV02(request)).toThrow('subject');
    request.authority.subject.entityIds = [clientId];
    request.read.retrievedAt = new Date(NOW - 120000).toISOString();
    expect(() => projectMeetingSourceV02(request)).toThrow('not current');
  });

  it('projects approved debrief source rows without upgrading page completion to source completeness', () => {
    const page = projectMeetingSourceV02(debrief());
    expect(page).toMatchObject({
      kind: 'debrief-source-page',
      total: 1,
      returned: 1,
      pageCoverage: { complete: true },
      coverage: { enumeration: 'unknown', truncated: false },
      continuation: { cursor: null, requiredReads: [] },
      evidenceReady: false,
    });
  });

  it('refuses debrief lifecycle and body hash substitutions', () => {
    const request = debrief();
    const row = (request.result as { debriefs: Array<{ status: string; body: string }> })
      .debriefs[0]!;
    row.status = 'draft';
    expect(() => projectMeetingSourceV02(request)).toThrow('lifecycle');
    row.status = 'approved';
    row.body = 'changed';
    expect(() => projectMeetingSourceV02(request)).toThrow('provenance');
  });

  it('projects meeting inventory and refuses client reassignment', () => {
    const request = meetingInventory();
    const page = projectMeetingSourceV02(request);
    expect(page).toMatchObject({
      kind: 'meeting-inventory-page',
      returned: 1,
      coverage: { enumeration: 'unknown', truncated: true },
      pageCoverage: { sourceBodyCoverageComplete: false },
    });
    (request.result as { meetings: Array<{ clientId: string }> }).meetings[0]!.clientId = id('0');
    expect(() => projectMeetingSourceV02(request)).toThrow('selected client');
  });

  it('projects exact note body provenance and refuses substituted bytes', () => {
    const request = meetingSourceBody();
    const page = projectMeetingSourceV02(request);
    expect(page).toMatchObject({
      kind: 'meeting-source-body-page',
      returned: 1,
      source: {
        body: 'Exact approved meeting note',
        provenance: { owner: 'meeting_notes', currentClientId: clientId },
      },
      continuation: { requiredReads: [] },
      evidenceReady: false,
    });
    (request.result as { source: { body: string } }).source.body = 'changed';
    expect(() => projectMeetingSourceV02(request)).toThrow('provenance');
  });

  it('refuses absent owner limitation facts', () => {
    const request = meetingInventory();
    request.read.limitations = [];
    expect(() => projectMeetingSourceV02(request)).toThrow('limitations');
  });
});
