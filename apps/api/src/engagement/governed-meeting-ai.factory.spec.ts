import type {
  EngagementAiService,
  MeetingDebriefDraftInput,
  MeetingPrepInput,
} from './engagement-ai.service.js';
import { createGovernedMeetingAiService } from './governed-meeting-ai.factory.js';
import {
  runWithMeetingGovernedContext,
  type MeetingGovernedContext,
} from './meeting-context-runtime.js';

const CLIENT = '33333333-3333-4333-8333-333333333333';
const MEETING = '44444444-4444-4444-8444-444444444444';

function bundle(mode: 'prep' | 'debrief'): MeetingGovernedContext {
  return {
    kind: 'governed_packet',
    mode,
    meetingId: MEETING,
    clientId: CLIENT,
    packetId: 'packet-1',
    traceHash: 'trace-1',
    modelContextBlock: `<capiro_meeting_context_plane>\nMODE: ${mode}\nGOVERNED\n</capiro_meeting_context_plane>`,
    coverage: {
      complete: true,
      requestedDomains: ['clients'],
      searchedDomains: ['clients'],
      missingDomains: [],
      partialDomains: [],
      recordsReturned: 1,
      paginationComplete: true,
      truncated: false,
      stopReason: 'complete',
    },
  };
}

function prepInput(): MeetingPrepInput {
  return {
    meeting: {
      id: MEETING,
      clientId: CLIENT,
      subject: 'Client meeting',
      attendees: [{ name: 'legacy nested attendee' }],
      tasks: [{ title: 'legacy nested task' }],
      preps: [{ summary: 'legacy prep' }],
    },
    client: { id: CLIENT, name: 'Acme Corp' },
    attendees: [{ name: 'Jamie Contact', email: 'jamie@example.com' }],
    congressionalDirectoryMatches: [{ name: 'Staffer One' }],
    recentMeetings: [{ subject: 'LEGACY RECENT MEETING' }],
    recentThreads: [{ subject: 'LEGACY MAIL THREAD' }],
    tasks: [{ title: 'LEGACY TASK' }],
    additionalContext: 'User focus',
    steeringContext: 'LEGACY COMPILER BLOCK',
  };
}

function debriefInput(): MeetingDebriefDraftInput {
  return {
    meeting: {
      id: MEETING,
      clientId: CLIENT,
      subject: 'Client meeting',
      notes: [{ body: 'legacy nested note' }],
      debriefs: [{ recap: 'legacy debrief' }],
    },
    client: { id: CLIENT, name: 'Acme Corp' },
    attendees: [{ name: 'Jamie Contact', email: 'jamie@example.com' }],
    prep: { summary: 'Prep summary' },
    source: { method: 'upload', text: 'Jamie explicitly committed to send the document.' },
    visibleNotes: [{ body: 'The deadline was not established.' }],
    clientContext: { privateLegacyContext: true },
    congressionalDirectoryMatches: [{ name: 'Staffer One' }],
    recentMeetings: [{ subject: 'LEGACY RECENT MEETING' }],
    recentThreads: [{ subject: 'LEGACY MAIL THREAD' }],
    steeringContext: 'LEGACY COMPILER BLOCK',
  };
}

function harness() {
  const prep = jest.fn().mockResolvedValue({ agenda: [] });
  const debrief = jest.fn().mockResolvedValue({ recap: 'ok' });
  const raw = {
    generateMeetingPrep: prep,
    generateMeetingDebrief: debrief,
    capabilities: jest.fn().mockReturnValue({}),
  } as unknown as EngagementAiService;
  return {
    service: createGovernedMeetingAiService(raw),
    prep,
    debrief,
  };
}

describe('createGovernedMeetingAiService Phase 24', () => {
  test('direct meeting prep AI call without a governed bundle fails closed', async () => {
    const h = harness();
    await expect(h.service.generateMeetingPrep(prepInput(), null)).rejects.toThrow(
      'phase24_meeting_context_plane_bundle_required',
    );
    expect(h.prep).not.toHaveBeenCalled();
  });

  test("prep keeps the firm's client record and takes steering plus supplemental evidence from the bundle", async () => {
    const h = harness();
    const context = { ...bundle('prep'), evidenceSources: [{ id: 'mail:1', kind: 'mail', title: 'Actual source', recordId: '1', observedAt: null, excerpt: 'Supplied excerpt' }] };
    await runWithMeetingGovernedContext(context, () =>
      h.service.generateMeetingPrep(prepInput(), null),
    );

    const [input] = h.prep.mock.calls[0] as [MeetingPrepInput];
    expect(input.meeting).toEqual({
      id: MEETING,
      clientId: CLIENT,
      subject: 'Client meeting',
    });
    expect(input.attendees).toEqual([{ name: 'Jamie Contact', email: 'jamie@example.com' }]);
    expect(input.congressionalDirectoryMatches).toEqual([{ name: 'Staffer One' }]);
    expect(input.recentMeetings).toEqual([{ subject: 'LEGACY RECENT MEETING' }]);
    expect(input.recentThreads).toEqual([{ subject: 'LEGACY MAIL THREAD' }]);
    expect(input.tasks).toEqual([{ title: 'LEGACY TASK' }]);
    expect(input.evidenceSources).toEqual(context.evidenceSources);
    expect(input.steeringContext).toContain('<capiro_meeting_context_plane>');
    expect(JSON.stringify(input)).not.toContain('LEGACY COMPILER BLOCK');
    expect(JSON.stringify(input.meeting)).not.toContain('legacy nested');
  });

  test('debrief preserves transcript and visible notes while removing legacy background as evidence', async () => {
    const h = harness();
    await runWithMeetingGovernedContext(bundle('debrief'), () =>
      h.service.generateMeetingDebrief(debriefInput(), null),
    );

    const [input] = h.debrief.mock.calls[0] as [MeetingDebriefDraftInput];
    expect(input.source.text).toContain('explicitly committed');
    expect(input.visibleNotes).toEqual([{ body: 'The deadline was not established.' }]);
    expect(input.clientContext).toBeNull();
    expect(input.recentMeetings).toEqual([]);
    expect(input.recentThreads).toEqual([]);
    expect(input.steeringContext).toContain('MODE: debrief');
    expect(JSON.stringify(input)).not.toContain('legacy nested note');
    expect(JSON.stringify(input)).not.toContain('LEGACY RECENT MEETING');
  });

  test('meeting or client identity drift is refused before the raw provider seam', async () => {
    const h = harness();
    const input = prepInput();
    input.meeting.id = 'different-meeting';
    await expect(
      runWithMeetingGovernedContext(bundle('prep'), () =>
        h.service.generateMeetingPrep(input, null),
      ),
    ).rejects.toThrow('phase24_meeting_ai_meeting_mismatch');
    expect(h.prep).not.toHaveBeenCalled();
  });
});
