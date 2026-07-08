import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { EngagementService } from '../engagement.service.js';
import type { AppConfig } from '../../config/config.schema.js';
import type { MeetingBotProvider, NormalizedBotEvent } from './meeting-bot.provider.js';
import {
  NotetakerService,
  validateMeetingUrl,
  detectPlatform,
  mapRecallStatus,
  formatDebriefBody,
} from './notetaker.service.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
// Loosely-typed async mock: keeps mockResolvedValue/mockResolvedValueOnce open to
// any test fixture without fighting jest's generic inference under ts-jest.
const asyncMock = (value: any) => jest.fn(async (..._args: any[]): Promise<any> => value);

function makeTx() {
  return {
    tenant: {
      findFirst: asyncMock({
        settings: { clioFeatureFlags: { 'notetaker.enabled': true } },
        name: 'Acme Lobbying',
      }),
      findUnique: asyncMock({ slug: 'acme' }),
    },
    user: {
      findUnique: asyncMock({ id: 'u1', clerkUserId: 'clerk_u1' }),
    },
    tenantMembership: {
      findFirst: asyncMock({ role: 'standard_user' }),
    },
    meeting: {
      findFirst: asyncMock({ id: 'm1', clientId: 'c1' }),
      updateMany: asyncMock({ count: 1 }),
    },
    meetingBotSession: {
      create: asyncMock({ id: 's1' }),
      findFirst: asyncMock(null),
      findMany: asyncMock([]),
      update: asyncMock({ id: 's1' }),
      updateMany: asyncMock({ count: 1 }),
    },
  };
}
type Tx = ReturnType<typeof makeTx>;

function makeService(tx: Tx) {
  const prisma = {
    withTenant: (_tenantId: string, fn: (t: Tx) => unknown) => fn(tx),
    withSystem: (fn: (t: Tx) => unknown) => fn(tx),
  } as unknown as PrismaService;

  const bot = {
    dispatchBot: asyncMock({ externalBotId: 'bot_1', raw: {} }),
    createAsyncTranscript: asyncMock({ transcriptId: 'tr1', raw: {} }),
    getTranscript: asyncMock({
      transcriptId: 'tr1',
      utterances: [],
      plainText: 'Speaker 0: hello there',
    }),
    getRecordingId: asyncMock('r1'),
    leaveCall: asyncMock(undefined),
    deleteMedia: asyncMock(undefined),
    verifyAndParseWebhook: jest.fn(),
  };

  const engagement = {
    createAttachmentFromBuffer: asyncMock({
      id: 'a1',
      fileName: 't.txt',
      s3Key: 'tenants/t1/engagement/x/t.txt',
    }),
    generateMeetingDebriefDraft: asyncMock({
      recap: 'Recap.',
      actionItems: ['Do X'],
      notes: 'Notes.',
    }),
    createMeetingDebrief: asyncMock({ id: 'd1' }),
  } as unknown as EngagementService;

  const config = {
    get: (key: string) =>
      key === 'RECALL_API_BASE_URL' ? 'https://us-west-2.recall.ai' : undefined,
  } as unknown as ConfigService<AppConfig, true>;

  const service = new NotetakerService(
    prisma,
    bot as unknown as MeetingBotProvider,
    engagement,
    config,
  );
  return { service, bot, engagement, tx };
}

const ctx = {
  tenantId: 't1',
  tenantSlug: 'acme',
  userId: 'u1',
  clerkUserId: 'clerk_u1',
  role: 'standard_user',
  // Only the fields the service touches matter for these tests.
} as never;

function makeEvent(overrides: Partial<NormalizedBotEvent>): NormalizedBotEvent {
  return {
    kind: 'unknown',
    event: 'test',
    botId: 'bot_1',
    recordingId: null,
    transcriptId: null,
    statusCode: null,
    metadata: { tenantId: 't1', meetingBotSessionId: 's1' },
    raw: {},
    ...overrides,
  };
}

const baseSession = {
  id: 's1',
  meetingId: 'm1',
  clientId: 'c1',
  requestedByUserId: 'u1',
  externalBotId: 'bot_1',
  recordingId: null,
  transcriptId: null,
  debriefId: null,
  recordingPolicy: 'transcript_only',
};

describe('NotetakerService.dispatch (strict consent gate)', () => {
  beforeEach(() => {
    process.env.NOTETAKER_ENABLED = 'true';
  });
  afterEach(() => {
    delete process.env.NOTETAKER_ENABLED;
  });

  const input = {
    meetingUrl: 'https://us02web.zoom.us/j/123',
    authorizedToRecord: true,
    allPartiesWillBeNotified: true,
  };

  test('dispatches, stamping tenant/session metadata for the webhook round-trip', async () => {
    const { service, bot, tx } = makeService(makeTx());
    await service.dispatch(ctx, 'm1', input);
    expect(bot.dispatchBot).toHaveBeenCalledTimes(1);
    const arg = bot.dispatchBot.mock.calls[0]?.[0] as {
      metadata: Record<string, string>;
      disclosureMessage?: string;
    };
    expect(arg.metadata).toMatchObject({ tenantId: 't1', meetingBotSessionId: 's1' });
    expect(arg.disclosureMessage).toContain('Meri Notetaker');
    expect(tx.meetingBotSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'joining', externalBotId: 'bot_1' }),
      }),
    );
  });

  test('refuses when the feature flag is off (env kill-switch)', async () => {
    delete process.env.NOTETAKER_ENABLED;
    const { service, bot } = makeService(makeTx());
    await expect(service.dispatch(ctx, 'm1', input)).rejects.toThrow('not enabled');
    expect(bot.dispatchBot).not.toHaveBeenCalled();
  });

  test('refuses without the recording-authorization affirmation', async () => {
    const { service, bot } = makeService(makeTx());
    await expect(
      service.dispatch(ctx, 'm1', { ...input, authorizedToRecord: false }),
    ).rejects.toThrow('authorization is required');
    expect(bot.dispatchBot).not.toHaveBeenCalled();
  });

  test('refuses all-party states without the notification affirmation', async () => {
    const { service, bot } = makeService(makeTx());
    await expect(
      service.dispatch(ctx, 'm1', {
        ...input,
        allPartiesWillBeNotified: false,
        allPartyStates: ['CA'],
      }),
    ).rejects.toThrow('All-party consent');
    expect(bot.dispatchBot).not.toHaveBeenCalled();
  });

  test('refuses a non-URL join link before any session is created', async () => {
    const tx = makeTx();
    const { service, bot } = makeService(tx);
    await expect(
      service.dispatch(ctx, 'm1', { ...input, meetingUrl: 'join my zoom pls' }),
    ).rejects.toThrow('not a valid URL');
    expect(tx.meetingBotSession.create).not.toHaveBeenCalled();
    expect(bot.dispatchBot).not.toHaveBeenCalled();
  });

  test('refuses a non-meeting URL (e.g. the Outlook calendar webLink) before any session exists', async () => {
    const tx = makeTx();
    const { service, bot } = makeService(tx);
    await expect(
      service.dispatch(ctx, 'm1', {
        ...input,
        meetingUrl:
          'https://outlook.office365.com/owa/?itemid=AAMkAD&exvsurl=1&path=/calendar/item',
      }),
    ).rejects.toThrow("doesn't look like a meeting join URL");
    expect(tx.meetingBotSession.create).not.toHaveBeenCalled();
    expect(bot.dispatchBot).not.toHaveBeenCalled();
  });

  test('refuses when a notetaker is already active for the meeting', async () => {
    const tx = makeTx();
    tx.meetingBotSession.findFirst.mockResolvedValue({ id: 'existing' });
    const { service, bot } = makeService(tx);
    await expect(service.dispatch(ctx, 'm1', input)).rejects.toThrow('already assigned');
    expect(bot.dispatchBot).not.toHaveBeenCalled();
  });

  test('marks the session failed when the provider dispatch throws', async () => {
    const tx = makeTx();
    const { service, bot } = makeService(tx);
    bot.dispatchBot.mockRejectedValue(new Error('recall down'));
    await expect(service.dispatch(ctx, 'm1', input)).rejects.toThrow('recall down');
    expect(tx.meetingBotSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed', error: 'recall down' }),
      }),
    );
  });

  test('rejects the unimplemented audio_and_transcript policy instead of downgrading it', async () => {
    const { service, bot } = makeService(makeTx());
    await expect(
      service.dispatch(ctx, 'm1', {
        ...input,
        recordingPolicy: 'audio_and_transcript',
      }),
    ).rejects.toThrow('not available');
    expect(bot.dispatchBot).not.toHaveBeenCalled();
  });

  test('pulls the bot back OUT of the call when recording its id fails (no untracked bot)', async () => {
    const tx = makeTx();
    tx.meetingBotSession.update.mockRejectedValue(new Error('db blip'));
    const { service, bot } = makeService(tx);
    await expect(service.dispatch(ctx, 'm1', input)).rejects.toThrow('db blip');
    // Compensation: the live bot is removed so the kill switch can't go stale.
    expect(bot.leaveCall).toHaveBeenCalledWith('bot_1');
  });
});

describe('NotetakerService.getSessionForMeeting / remove (visibility + kill switch)', () => {
  test('getSessionForMeeting 404s for a meeting the caller cannot see', async () => {
    const tx = makeTx();
    tx.meeting.findFirst.mockResolvedValue(null);
    const { service } = makeService(tx);
    await expect(service.getSessionForMeeting(ctx, 'm-other')).rejects.toThrow('Meeting not found');
  });

  test('remove leaves the call and marks the session removed', async () => {
    const tx = makeTx();
    tx.meetingBotSession.findFirst
      .mockResolvedValueOnce({ id: 's1', externalBotId: 'bot_1', status: 'recording' })
      // the getSessionForMeeting re-read at the end
      .mockResolvedValueOnce({ id: 's1', status: 'removed' });
    const { service, bot } = makeService(tx);
    await service.remove(ctx, 'm1');
    expect(bot.leaveCall).toHaveBeenCalledWith('bot_1');
    expect(tx.meetingBotSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'removed' } }),
    );
  });

  test('remove refuses while dispatch is still in flight (no false-safe "removed")', async () => {
    const tx = makeTx();
    tx.meetingBotSession.findFirst.mockResolvedValue({
      id: 's1',
      externalBotId: null,
      status: 'requested',
    });
    const { service, bot } = makeService(tx);
    await expect(service.remove(ctx, 'm1')).rejects.toThrow('still being dispatched');
    expect(bot.leaveCall).not.toHaveBeenCalled();
    // Crucially, the session was NOT marked removed.
    expect(tx.meetingBotSession.updateMany).not.toHaveBeenCalled();
  });

  test('remove refuses when there is no active session', async () => {
    const tx = makeTx();
    tx.meetingBotSession.findFirst.mockResolvedValue({
      id: 's1',
      externalBotId: 'bot_1',
      status: 'done',
    });
    const { service, bot } = makeService(tx);
    await expect(service.remove(ctx, 'm1')).rejects.toThrow('No active notetaker');
    expect(bot.leaveCall).not.toHaveBeenCalled();
  });
});

describe('NotetakerService.handleBotEvent (at-least-once webhook semantics)', () => {
  test('recording.done starts async transcription exactly once (atomic claim)', async () => {
    const tx = makeTx();
    tx.meetingBotSession.findFirst.mockResolvedValue(baseSession);
    const { service, bot } = makeService(tx);

    await service.handleBotEvent(makeEvent({ kind: 'recording_ready', recordingId: 'r1' }));
    expect(bot.createAsyncTranscript).toHaveBeenCalledTimes(1);

    // Duplicate delivery: the claim update matches 0 rows → no second transcript.
    tx.meetingBotSession.updateMany.mockResolvedValue({ count: 0 });
    await service.handleBotEvent(makeEvent({ kind: 'recording_ready', recordingId: 'r1' }));
    expect(bot.createAsyncTranscript).toHaveBeenCalledTimes(1);
  });

  test('a failed createAsyncTranscript releases the claim and marks the session failed', async () => {
    const tx = makeTx();
    tx.meetingBotSession.findFirst.mockResolvedValue(baseSession);
    const { service, bot } = makeService(tx);
    bot.createAsyncTranscript.mockRejectedValue(new Error('boom'));

    await service.handleBotEvent(makeEvent({ kind: 'recording_ready', recordingId: 'r1' }));
    expect(tx.meetingBotSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ recordingId: null, status: 'failed' }),
      }),
    );
  });

  test('bot.done falls back to Retrieve Bot when no recording webhook arrived', async () => {
    const tx = makeTx();
    tx.meetingBotSession.findFirst.mockResolvedValue(baseSession);
    const { service, bot } = makeService(tx);

    await service.handleBotEvent(
      makeEvent({ kind: 'status_change', event: 'bot.done', statusCode: 'done' }),
    );
    expect(bot.getRecordingId).toHaveBeenCalledWith('bot_1');
    expect(bot.createAsyncTranscript).toHaveBeenCalledWith('r1');
  });

  test('bot.done with a FAILING recording lookup marks the session failed (never wedges)', async () => {
    const tx = makeTx();
    tx.meetingBotSession.findFirst.mockResolvedValue(baseSession);
    const { service, bot } = makeService(tx);
    bot.getRecordingId.mockRejectedValue(new Error('recall 502'));

    await service.handleBotEvent(
      makeEvent({ kind: 'status_change', event: 'bot.done', statusCode: 'done' }),
    );
    expect(bot.createAsyncTranscript).not.toHaveBeenCalled();
    expect(tx.meetingBotSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed', error: 'recall 502' }),
      }),
    );
  });

  test('no_storage policy skips the transcript attachment but still drafts the debrief', async () => {
    const tx = makeTx();
    tx.meetingBotSession.findFirst.mockResolvedValue({
      ...baseSession,
      recordingPolicy: 'no_storage',
    });
    const { service, engagement } = makeService(tx);

    await service.handleBotEvent(makeEvent({ kind: 'transcript_done', transcriptId: 'tr1' }));
    expect(engagement.createAttachmentFromBuffer).not.toHaveBeenCalled();
    expect(engagement.createMeetingDebrief).toHaveBeenCalledTimes(1);
  });

  test('bot.done with NO recording marks the session failed (never joined)', async () => {
    const tx = makeTx();
    tx.meetingBotSession.findFirst.mockResolvedValue(baseSession);
    const { service, bot } = makeService(tx);
    bot.getRecordingId.mockResolvedValue(null);

    await service.handleBotEvent(
      makeEvent({ kind: 'status_change', event: 'bot.done', statusCode: 'done' }),
    );
    expect(bot.createAsyncTranscript).not.toHaveBeenCalled();
    expect(tx.meetingBotSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
  });

  test('transcript.done runs the debrief pipeline once and deletes provider media', async () => {
    const tx = makeTx();
    tx.meetingBotSession.findFirst.mockResolvedValue(baseSession);
    const { service, bot, engagement } = makeService(tx);

    await service.handleBotEvent(makeEvent({ kind: 'transcript_done', transcriptId: 'tr1' }));
    expect(engagement.generateMeetingDebriefDraft).toHaveBeenCalledTimes(1);
    expect(engagement.createMeetingDebrief).toHaveBeenCalledTimes(1);
    expect(engagement.createAttachmentFromBuffer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ meetingId: 'm1', contentType: 'text/plain', source: 'notetaker' }),
    );
    expect(bot.deleteMedia).toHaveBeenCalledWith('bot_1');
    // Meeting row stamped with the stored transcript location.
    expect(tx.meeting.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { transcriptS3Key: 'tenants/t1/engagement/x/t.txt' },
      }),
    );

    // Duplicate transcript.done: drafting/done claim matches 0 rows → no second debrief.
    tx.meetingBotSession.updateMany.mockResolvedValue({ count: 0 });
    await service.handleBotEvent(makeEvent({ kind: 'transcript_done', transcriptId: 'tr1' }));
    expect(engagement.createMeetingDebrief).toHaveBeenCalledTimes(1);
  });

  test('an empty transcript fails the session instead of drafting an empty debrief', async () => {
    const tx = makeTx();
    tx.meetingBotSession.findFirst.mockResolvedValue(baseSession);
    const { service, bot, engagement } = makeService(tx);
    bot.getTranscript.mockResolvedValue({ transcriptId: 'tr1', utterances: [], plainText: '  ' });

    await service.handleBotEvent(makeEvent({ kind: 'transcript_done', transcriptId: 'tr1' }));
    expect(engagement.generateMeetingDebriefDraft).not.toHaveBeenCalled();
    expect(tx.meetingBotSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed', error: 'Transcript was empty' }),
      }),
    );
  });

  test('provider pipeline_failed marks the session failed', async () => {
    const tx = makeTx();
    tx.meetingBotSession.findFirst.mockResolvedValue(baseSession);
    const { service } = makeService(tx);

    await service.handleBotEvent(
      makeEvent({ kind: 'pipeline_failed', event: 'transcript.failed' }),
    );
    expect(tx.meetingBotSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
  });

  test('resolves the session by externalBotId when bot metadata is missing', async () => {
    const tx = makeTx();
    // First findFirst: the withSystem locate-by-bot-id; second: the tenant-scoped read.
    tx.meetingBotSession.findFirst
      .mockResolvedValueOnce({ id: 's1', tenantId: 't1' })
      .mockResolvedValueOnce(baseSession);
    const { service, bot } = makeService(tx);

    await service.handleBotEvent(
      makeEvent({ kind: 'recording_ready', recordingId: 'r1', metadata: {} }),
    );
    expect(bot.createAsyncTranscript).toHaveBeenCalledWith('r1');
  });

  test('ignores events that match no session', async () => {
    const tx = makeTx();
    tx.meetingBotSession.findFirst.mockResolvedValue(null);
    const { service, bot } = makeService(tx);

    await service.handleBotEvent(
      makeEvent({ kind: 'recording_ready', recordingId: 'r1', metadata: {}, botId: 'bot_x' }),
    );
    expect(bot.createAsyncTranscript).not.toHaveBeenCalled();
  });

  test('an event that matches a session but no handler branch does not throw (and is logged, not silent)', async () => {
    const tx = makeTx();
    tx.meetingBotSession.findFirst.mockResolvedValue(baseSession);
    const { service } = makeService(tx);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    // 'unknown' kind, and transcript_done missing its required transcriptId,
    // both fall through every handler branch — this must not throw silently.
    await expect(service.handleBotEvent(makeEvent({ kind: 'unknown' }))).resolves.toBeUndefined();
    await expect(
      service.handleBotEvent(makeEvent({ kind: 'transcript_done', transcriptId: null })),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('matched no handler'));

    warnSpy.mockRestore();
  });
});

describe('NotetakerService.reconcileStaleTranscripts (self-heal a dropped transcript.done webhook)', () => {
  // Confirmed in prod (2026-07-08): Recall delivered a bot.status_change webhook
  // for a bot fine, but the SAME bot's transcript.done a few seconds later never
  // arrived, leaving the session stuck at 'processing' with recordingId +
  // transcriptId already set — exactly what this sweep finds and finishes.
  const staleRow = {
    id: 's-stale',
    tenantId: 't1',
    meetingId: 'm1',
    clientId: 'c1',
    requestedByUserId: 'u1',
    externalBotId: 'bot_1',
    recordingPolicy: 'transcript_only',
    transcriptId: 'tr1',
  };

  test('finishes a stale session exactly as the webhook path would', async () => {
    const tx = makeTx();
    tx.meetingBotSession.findMany.mockResolvedValue([staleRow]);
    const { service, engagement } = makeService(tx);

    const count = await service.reconcileStaleTranscripts();

    expect(count).toBe(1);
    // The query itself must target the confirmed failure shape.
    expect(tx.meetingBotSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'processing',
          transcriptId: { not: null },
          debriefId: null,
          updatedAt: expect.objectContaining({ lt: expect.any(Date) }),
        }),
      }),
    );
    expect(engagement.generateMeetingDebriefDraft).toHaveBeenCalledTimes(1);
    expect(engagement.createMeetingDebrief).toHaveBeenCalledTimes(1);
    // The atomic claim (shared with the webhook path) must still fire — this is
    // what makes a same-moment real webhook delivery race harmlessly.
    expect(tx.meetingBotSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'drafting', transcriptId: 'tr1' }),
      }),
    );
  });

  test('does nothing when no sessions are stale', async () => {
    const tx = makeTx();
    const { service, engagement } = makeService(tx);

    expect(await service.reconcileStaleTranscripts()).toBe(0);
    expect(engagement.generateMeetingDebriefDraft).not.toHaveBeenCalled();
  });

  test('a per-row failure does not stop the sweep or escape as an unhandled rejection', async () => {
    const tx = makeTx();
    tx.meetingBotSession.findMany.mockResolvedValue([staleRow]);
    // Force the atomic claim itself to blow up (e.g. a transient DB error) —
    // finishTranscript's own try/catches only cover ITS internal awaits, so this
    // exercises the sweep's own backstop catch.
    tx.meetingBotSession.updateMany.mockRejectedValueOnce(new Error('db blip'));
    const { service } = makeService(tx);

    await expect(service.reconcileStaleTranscripts()).resolves.toBe(1);
  });
});

describe('NotetakerService lifecycle (periodic reconciliation timer)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  // advanceTimersByTime is synchronous and doesn't flush the real microtask
  // queue, so a couple of empty microtask turns let the sweep's own
  // .then/.catch/.finally chain settle before assertions run.
  async function tick(ms: number) {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  }

  test('onModuleInit schedules the sweep, and onModuleDestroy stops it', async () => {
    const { service } = makeService(makeTx());
    const spy = jest.spyOn(service, 'reconcileStaleTranscripts').mockResolvedValue(0);

    service.onModuleInit();
    expect(spy).not.toHaveBeenCalled();

    await tick(60_000);
    expect(spy).toHaveBeenCalledTimes(1);

    service.onModuleDestroy();
    await tick(120_000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('a slow-running sweep is not started twice concurrently', async () => {
    const { service } = makeService(makeTx());
    let resolveSweep!: () => void;
    const spy = jest
      .spyOn(service, 'reconcileStaleTranscripts')
      .mockImplementation(
        () => new Promise<number>((resolve) => (resolveSweep = () => resolve(0))),
      );

    service.onModuleInit();
    await tick(60_000);
    expect(spy).toHaveBeenCalledTimes(1);

    // The first sweep is still in flight — a second tick must be skipped.
    await tick(60_000);
    expect(spy).toHaveBeenCalledTimes(1);

    // Flush microtasks BEFORE advancing the clock again, so the resolved
    // sweep's .finally() clears `reconciling` before the next tick checks it.
    resolveSweep();
    await Promise.resolve();
    await Promise.resolve();
    await tick(60_000);
    expect(spy).toHaveBeenCalledTimes(2);

    service.onModuleDestroy();
  });
});

describe('pure helpers', () => {
  test('validateMeetingUrl accepts http(s) and rejects everything else', () => {
    expect(validateMeetingUrl(' https://zoom.us/j/1 ')).toBe('https://zoom.us/j/1');
    expect(() => validateMeetingUrl(undefined)).toThrow('required');
    expect(() => validateMeetingUrl('   ')).toThrow('required');
    expect(() => validateMeetingUrl('not a url')).toThrow('not a valid URL');
    expect(() => validateMeetingUrl('ftp://example.com/x')).toThrow('http(s)');
  });

  test('detectPlatform covers Recall’s full supported set (Zoom/ZoomGov, Meet, Teams incl. US-Gov, Webex, GoTo, Slack Huddles)', () => {
    expect(detectPlatform('https://us02web.zoom.us/j/123')).toBe('zoom');
    expect(detectPlatform('https://agency.zoomgov.com/j/160123')).toBe('zoom');
    expect(detectPlatform('https://meet.google.com/abc-defg-hij')).toBe('meet');
    expect(detectPlatform('https://teams.microsoft.com/l/meetup-join/xyz')).toBe('teams');
    // US-Government Teams (GCC-High / DoD) — routine for a federal-lobbying base.
    expect(detectPlatform('https://gov.teams.microsoft.us/l/meetup-join/19%3ameeting_x')).toBe(
      'teams',
    );
    expect(detectPlatform('https://dod.teams.microsoft.us/l/meetup-join/abc')).toBe('teams');
    expect(detectPlatform('https://acme.webex.com/meet/neo')).toBe('webex');
    expect(detectPlatform('https://meet.goto.com/123456789')).toBe('goto');
    expect(detectPlatform('https://global.gotomeeting.com/join/123456789')).toBe('goto');
    expect(detectPlatform('https://gotomeet.me/neo')).toBe('goto');
    expect(detectPlatform('https://app.slack.com/huddle/T0123/C0456')).toBe('slack');
    // A general Slack link (not a huddle) is NOT a meeting.
    expect(detectPlatform('https://app.slack.com/client/T0123/C0456')).toBeNull();
    expect(detectPlatform('https://example.com/call')).toBeNull();
    // The Outlook calendar webLink is NOT a join link.
    expect(detectPlatform('https://outlook.office365.com/owa/?itemid=AAMkAD')).toBeNull();
    // Never fooled by look-alike hosts.
    expect(detectPlatform('https://zoom.us.evil.com/j/1')).toBeNull();
    expect(detectPlatform('https://teams.microsoft.us.evil.com/l/x')).toBeNull();
  });

  test('mapRecallStatus maps the documented codes and ignores unknown ones', () => {
    expect(mapRecallStatus('joining_call')).toBe('joining');
    expect(mapRecallStatus('in_waiting_room')).toBe('joining');
    expect(mapRecallStatus('in_call_not_recording')).toBe('in_call');
    expect(mapRecallStatus('in_call_recording')).toBe('recording');
    expect(mapRecallStatus('recording_permission_denied')).toBe('denied_consent');
    expect(mapRecallStatus('call_ended')).toBe('processing');
    expect(mapRecallStatus('done')).toBe('processing');
    expect(mapRecallStatus('fatal')).toBe('failed');
    expect(mapRecallStatus('some_future_code')).toBeNull();
    expect(mapRecallStatus(null)).toBeNull();
  });

  test('formatDebriefBody matches the frontend parseDebriefBody contract', () => {
    expect(
      formatDebriefBody({ recap: 'We met.', actionItems: ['Send deck'], notes: 'Good call.' }),
    ).toBe('Recap\nWe met.\n\nAction Items\n- Send deck\n\nNotes\nGood call.');
    expect(formatDebriefBody({ recap: '', actionItems: [], notes: '' })).toBe(
      'Recap\nNo recap saved.\n\nAction Items\nNo action items saved.\n\nNotes\nNo notes saved.',
    );
  });
});
