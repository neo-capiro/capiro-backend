import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  captureMeetingV02OwnerRead,
  prepareMeetingV02OwnerInput,
  projectMeetingSourceV02,
  type MeetingV02ProjectionRequest,
} from './meetings.js';

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
      resultSha256: '0'.repeat(64),
      limitations: [
        'Current meeting owner read has no snapshot identity or proven complete source history.',
      ],
    },
    result: {},
  };
}

function observe(request: MeetingV02ProjectionRequest): MeetingV02ProjectionRequest {
  const { retrievedAt: _retrievedAt, resultSha256: _resultSha256, ...facts } = request.read;
  request.read = captureMeetingV02OwnerRead({
    ...facts,
    result: request.result,
    observedAtMs: NOW,
  });
  return request;
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
  return observe(request);
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
  return observe(request);
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
  return observe(request);
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
  return observe(request);
}

describe('Core meeting 0.2 owner projection', () => {
  it('pins the complete Meri PR158 meeting output schema dependency closure', () => {
    const files = {
      'mail-base.schema.json': 'e3de878198bbd557843ac440e48664ad5175eecd99f7ec932021ffc465bf8c5b',
      'mail-common.schema.json': '7d7ac22eff809cc31e84d1fc9b2fada1b56c316f73e50115207b579de0d92c4b',
      'mail-retrieval.schema.json': '6058aa0d735b595a093907eec8bf7e4e8f4eb96952f497caa3c1eb00f3ad1a8c',
      'meetings.schema.json': 'b7ec6ecbdaab3fcccac3b83b9530828c90bda96685385b6f49f929fbd2776664',
    };
    for (const [name, expected] of Object.entries(files))
      expect(createHash('sha256').update(readFileSync(join(__dirname, name))).digest('hex'))
        .toBe(expected);
  });

  it('maps normalized upcoming selection to its private owner without cursor metadata', () => {
    const selection = upcoming().selection;
    expect(prepareMeetingV02OwnerInput('meeting.list_upcoming_meetings', selection, null)).toEqual({
      cursor: null,
      legacyInput: selection,
    });
    expect(() =>
      prepareMeetingV02OwnerInput('meeting.list_upcoming_meetings', selection, { cursor: null }),
    ).toThrow('upcoming metadata');
  });

  it('moves opaque debrief and meeting cursors into the private owner input', () => {
    const debriefSelection = {
      clientId, debriefId: noteId, from: null, to: null,
      limit: 25, characterOffset: 0, characterLimit: 5000,
    };
    const meetingSelection = meetingSourceBody().selection;
    for (const [operation, selection] of [
      ['meeting.query_debriefs', debriefSelection],
      ['meeting.read_client_meetings', meetingSelection],
    ] as const) {
      const original = { ...selection };
      const { characterOffset: _offset, ...continuationInput } = selection;
      expect(prepareMeetingV02OwnerInput(operation, selection, { cursor: 'opaque-cursor' }))
        .toStrictEqual({
          cursor: 'opaque-cursor',
          legacyInput: { ...continuationInput, cursor: 'opaque-cursor' },
        });
      expect(selection).toEqual(original);
    }
  });

  it('refuses missing or extra 0.2 cursor metadata before calling an owner', () => {
    const selection = debrief().selection;
    expect(() => prepareMeetingV02OwnerInput('meeting.query_debriefs', selection, null))
      .toThrow('meeting metadata');
    expect(() => prepareMeetingV02OwnerInput('meeting.query_debriefs', selection,
      { cursor: null, other: 'not canonical' })).toThrow('meeting metadata fields');
  });

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
    observe(request);
    expect(() => projectMeetingSourceV02(request)).toThrow('selected client');
  });

  it('refuses a projected page that violates a nested Meri output schema', () => {
    const request = upcoming();
    (request.result as { meetings: Array<{ attendees: unknown[] }> }).meetings[0]!.attendees = [
      { name: 'Missing required attendee fields' },
    ];
    observe(request);
    expect(() => projectMeetingSourceV02(request)).toThrow('output schema mismatch');
  });

  it('enforces Meri output maxLength and maxItems limits', () => {
    const request = upcoming();
    const row = (request.result as { meetings: Array<{ subject: string; attendees: unknown[] }> })
      .meetings[0]!;
    row.subject = 'x'.repeat(4097);
    observe(request);
    expect(() => projectMeetingSourceV02(request)).toThrow('output schema mismatch');
    row.subject = 'Review';
    row.attendees = Array.from({ length: 4097 }, () => ({
      name: null, email: null, role: null, responseStatus: null,
    }));
    observe(request);
    expect(() => projectMeetingSourceV02(request)).toThrow('output schema mismatch');
  });

  it('enforces the response byte ceiling and a smaller supplied claims budget', () => {
    const request = upcoming();
    request.maxOutputBytes = 256;
    expect(() => projectMeetingSourceV02(request)).toThrow('output exceeds byte cap');
    request.maxOutputBytes = 16 * 1024 * 1024 + 1;
    expect(() => projectMeetingSourceV02(request)).toThrow('maxOutputBytes');
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

  it('refuses a result changed after the source facts were captured', () => {
    const request = upcoming();
    (request.result as { meetings: Array<{ subject: string }> }).meetings[0]!.subject = 'Later';
    expect(() => projectMeetingSourceV02(request)).toThrow('same-read source facts');
  });

  it('refuses a source-read timestamp that predates the owner result', () => {
    const request = debrief();
    request.read.retrievedAt = new Date(NOW - 5000).toISOString();
    expect(() => projectMeetingSourceV02(request)).toThrow('later than its same-read observation');
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
    observe(request);
    expect(() => projectMeetingSourceV02(request)).toThrow('lifecycle');
    row.status = 'approved';
    row.body = 'changed';
    observe(request);
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
    observe(request);
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
    observe(request);
    expect(() => projectMeetingSourceV02(request)).toThrow('provenance');
  });

  it('refuses absent owner limitation facts', () => {
    const request = meetingInventory();
    request.read.limitations = [];
    expect(() => projectMeetingSourceV02(request)).toThrow('limitations');
  });
});
