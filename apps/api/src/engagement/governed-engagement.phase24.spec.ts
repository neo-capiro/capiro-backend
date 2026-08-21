import type { TenantContext } from '@capiro/shared';
import type {
  EngagementAiService,
  MeetingDebriefDraftInput,
} from './engagement-ai.service.js';
import type { EngagementService } from './engagement.service.js';
import { createGovernedEngagementService } from './governed-engagement.factory.js';
import { createGovernedMeetingAiService } from './governed-meeting-ai.factory.js';
import type { MeetingGovernedContext } from './meeting-context-runtime.js';

const ctx = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
} as TenantContext;
const meetingId = '33333333-3333-4333-8333-333333333333';
const clientId = '44444444-4444-4444-8444-444444444444';

function bundle(mode: 'prep' | 'debrief'): MeetingGovernedContext {
  return {
    kind: 'governed_packet',
    mode,
    meetingId,
    clientId,
    packetId: 'packet-1',
    traceHash: 'trace-1',
    modelContextBlock: `<capiro_meeting_context_plane>\nMODE: ${mode}\n</capiro_meeting_context_plane>`,
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

function fakeService() {
  const events: string[] = [];
  const steering: string[] = [];
  const raw = {
    loadUserVoiceBlock: jest.fn().mockResolvedValue('LEGACY COMPILER'),
    generateOutreachDraft: jest.fn(),
    generateBatchEmails: jest.fn(),
    generateMeetingPrep: jest.fn(async function (
      this: { loadUserVoiceBlock: (value: TenantContext, id: string) => Promise<string | null> },
      value: TenantContext,
      id: string,
    ) {
      events.push('raw-prep');
      steering.push((await this.loadUserVoiceBlock(value, clientId)) ?? 'none');
      return { meetingId: id };
    }),
    generateMeetingDebriefDraft: jest.fn(async function (
      this: { loadUserVoiceBlock: (value: TenantContext, id: string) => Promise<string | null> },
      value: TenantContext,
      id: string,
    ) {
      events.push('raw-debrief');
      steering.push((await this.loadUserVoiceBlock(value, clientId)) ?? 'none');
      return { meetingId: id };
    }),
  };
  /**
   * createGovernedEngagementService REPLACES these instance methods with its
   * governed wrappers, so `raw.<method>` stops being the jest mock once the
   * factory has run. Keep handles to the originals; asserting on the mutated
   * property inspects the wrapper and silently stops being a mock assertion.
   */
  const originals = {
    generateMeetingPrep: raw.generateMeetingPrep,
    generateMeetingDebriefDraft: raw.generateMeetingDebriefDraft,
    loadUserVoiceBlock: raw.loadUserVoiceBlock,
  };
  return { raw, events, steering, originals };
}

describe('createGovernedEngagementService Phase 24', () => {
  test('prep resolves one packet before raw work and suppresses the legacy compiler', async () => {
    const f = fakeService();
    const meetingContext = {
      resolve: jest.fn().mockImplementation(async () => {
        f.events.push('context-resolved');
        return bundle('prep');
      }),
    };
    const boundary = {
      guard: jest.fn(async (callback: () => unknown) => {
        f.events.push('persistence-boundary');
        return callback();
      }),
    };

    const service = createGovernedEngagementService(
      f.raw as unknown as EngagementService,
      boundary as never,
      meetingContext as never,
    );
    await service.generateMeetingPrep(ctx, meetingId, 'Focus on implementation.');

    expect(meetingContext.resolve).toHaveBeenCalledTimes(1);
    expect(meetingContext.resolve).toHaveBeenCalledWith(ctx, {
      meetingId,
      mode: 'prep',
      userInstruction: 'Focus on implementation.',
    });
    expect(f.events.indexOf('context-resolved')).toBeLessThan(f.events.indexOf('raw-prep'));
    expect(boundary.guard).toHaveBeenCalledTimes(1);
    // Phase 26 removed the legacy compiler entirely; the equivalent property is
    // that the retained legacy steering loader is never reached during a
    // governed meeting run.
    expect(f.originals.loadUserVoiceBlock).not.toHaveBeenCalled();
    expect(f.steering).toEqual([
      '<capiro_meeting_context_plane>\nMODE: prep\n</capiro_meeting_context_plane>',
    ]);
  });

  test('debrief resolves before transcript reasoning and reuses the same request-local bundle', async () => {
    const f = fakeService();
    const meetingContext = { resolve: jest.fn().mockResolvedValue(bundle('debrief')) };
    const boundary = { guard: jest.fn((callback: () => unknown) => callback()) };

    const service = createGovernedEngagementService(
      f.raw as unknown as EngagementService,
      boundary as never,
      meetingContext as never,
    );
    await service.generateMeetingDebriefDraft(ctx, meetingId, {
      method: 'upload',
      sourceText: 'Transcript evidence.',
    });

    expect(meetingContext.resolve).toHaveBeenCalledWith(ctx, {
      meetingId,
      mode: 'debrief',
      sourceMethod: 'upload',
    });
    // Phase 26 removed the legacy compiler entirely; the equivalent property is
    // that the retained legacy steering loader is never reached during a
    // governed meeting run.
    expect(f.originals.loadUserVoiceBlock).not.toHaveBeenCalled();
    expect(f.steering[0]).toContain('MODE: debrief');
  });

  test('the one public debrief bundle survives nested async work and sanitizes the provider input', async () => {
    const provider = jest.fn().mockResolvedValue({ recap: 'ok' });
    const governedAi = createGovernedMeetingAiService({
      generateMeetingDebrief: provider,
    } as unknown as EngagementAiService);
    const raw = {
      loadUserVoiceBlock: jest.fn().mockResolvedValue('LEGACY COMPILER'),
      generateOutreachDraft: jest.fn(),
      generateBatchEmails: jest.fn(),
      generateMeetingPrep: jest.fn(),
      generateMeetingDebriefDraft: jest.fn(async function (
        this: { loadUserVoiceBlock: (value: TenantContext, id: string) => Promise<string | null> },
        value: TenantContext,
      ) {
        await Promise.resolve();
        const steeringContext = await this.loadUserVoiceBlock(value, clientId);
        return governedAi.generateMeetingDebrief(
          {
            meeting: {
              id: meetingId,
              clientId,
              subject: 'Client meeting',
              notes: [{ body: 'legacy nested note' }],
            },
            client: { id: clientId, name: 'Acme Corp' },
            attendees: [{ name: 'Jamie Contact' }],
            prep: null,
            source: { method: 'upload', text: 'The transcript supports this sentence.' },
            visibleNotes: [{ body: 'Visible note.' }],
            clientContext: { legacy: true },
            congressionalDirectoryMatches: [],
            recentMeetings: [{ subject: 'legacy history' }],
            recentThreads: [{ subject: 'legacy mail' }],
            steeringContext,
          },
          value,
        );
      }),
    };
    const service = createGovernedEngagementService(
      raw as unknown as EngagementService,
      { guard: jest.fn((callback: () => unknown) => callback()) } as never,
      { resolve: jest.fn().mockResolvedValue(bundle('debrief')) } as never,
    );

    await service.generateMeetingDebriefDraft(ctx, meetingId, {
      method: 'upload',
      sourceText: 'The transcript supports this sentence.',
    });

    const [input] = provider.mock.calls[0] as [MeetingDebriefDraftInput];
    expect(input.source.text).toBe('The transcript supports this sentence.');
    expect(input.visibleNotes).toEqual([{ body: 'Visible note.' }]);
    expect(input.clientContext).toBeNull();
    expect(input.recentMeetings).toEqual([]);
    expect(input.recentThreads).toEqual([]);
    expect(input.steeringContext).toContain('<capiro_meeting_context_plane>');
    expect(JSON.stringify(input)).not.toContain('legacy nested note');
    expect(JSON.stringify(input)).not.toContain('legacy mail');
  });

  test('invalid debrief source is rejected before Context Plane or raw work', async () => {
    const f = fakeService();
    const meetingContext = { resolve: jest.fn() };
    const service = createGovernedEngagementService(
      f.raw as unknown as EngagementService,
      { guard: jest.fn((callback: () => unknown) => callback()) } as never,
      meetingContext as never,
    );

    await expect(
      service.generateMeetingDebriefDraft(ctx, meetingId, {
        method: 'manual',
        sourceText: '   ',
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(meetingContext.resolve).not.toHaveBeenCalled();
    expect(f.originals.generateMeetingDebriefDraft).not.toHaveBeenCalled();
  });

  test('Context Plane failure blocks raw prep/debrief work and persistence writes', async () => {
    const f = fakeService();
    const meetingContext = {
      resolve: jest.fn().mockRejectedValue(new Error('context_plane_unavailable')),
    };
    const boundary = { guard: jest.fn((callback: () => unknown) => callback()) };

    const service = createGovernedEngagementService(
      f.raw as unknown as EngagementService,
      boundary as never,
      meetingContext as never,
    );

    await expect(service.generateMeetingPrep(ctx, meetingId)).rejects.toThrow(
      'context_plane_unavailable',
    );
    expect(f.originals.generateMeetingPrep).not.toHaveBeenCalled();
    expect(boundary.guard).not.toHaveBeenCalled();
  });
});
