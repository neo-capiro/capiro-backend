import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { Webhook } from 'svix';
import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/config.schema.js';
import { RecallProvider, normalizeEvent } from './recall.provider.js';

function makeProvider(overrides: Partial<Record<string, string | undefined>> = {}) {
  const values: Record<string, string | undefined> = {
    RECALL_API_BASE_URL: 'https://us-west-2.recall.ai',
    RECALL_API_KEY: 'test-api-key',
    RECALL_WEBHOOK_SECRET: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
    ...overrides,
  };
  const config = { get: (key: string) => values[key] } as unknown as ConfigService<AppConfig, true>;
  return new RecallProvider(config);
}

/** Svix-sign a payload the way Recall does, so verification runs the real path. */
function signedHeaders(secret: string, payload: string) {
  const wh = new Webhook(secret);
  const id = 'msg_test_1';
  const timestamp = new Date();
  const signature = wh.sign(id, timestamp, payload);
  return {
    'webhook-id': id,
    'webhook-timestamp': `${Math.floor(timestamp.getTime() / 1000)}`,
    'webhook-signature': signature,
  };
}

describe('RecallProvider.verifyAndParseWebhook', () => {
  const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
  const payload = JSON.stringify({
    event: 'bot.status_change',
    data: {
      data: { code: 'in_call_recording' },
      bot: { id: 'bot_1', metadata: { tenantId: 't1', meetingBotSessionId: 's1' } },
    },
  });

  test('accepts a correctly signed payload and normalizes it', () => {
    const provider = makeProvider();
    const event = provider.verifyAndParseWebhook(signedHeaders(secret, payload), payload);
    expect(event.kind).toBe('status_change');
    expect(event.statusCode).toBe('in_call_recording');
    expect(event.botId).toBe('bot_1');
    expect(event.metadata).toEqual({ tenantId: 't1', meetingBotSessionId: 's1' });
  });

  test('rejects a tampered payload', () => {
    const provider = makeProvider();
    const headers = signedHeaders(secret, payload);
    const tampered = payload.replace('in_call_recording', 'done');
    expect(() => provider.verifyAndParseWebhook(headers, tampered)).toThrow(
      'Invalid Recall webhook signature',
    );
  });

  test('rejects when signature headers are missing', () => {
    const provider = makeProvider();
    expect(() => provider.verifyAndParseWebhook({}, payload)).toThrow(
      'Missing Recall webhook signature headers',
    );
  });

  test('fails closed when no webhook secret is configured', () => {
    const provider = makeProvider({ RECALL_WEBHOOK_SECRET: undefined });
    expect(() => provider.verifyAndParseWebhook(signedHeaders(secret, payload), payload)).toThrow(
      'RECALL_WEBHOOK_SECRET is not configured',
    );
  });

  test('accepts legacy svix-* header names', () => {
    const provider = makeProvider();
    const modern = signedHeaders(secret, payload);
    const legacy = {
      'svix-id': modern['webhook-id'],
      'svix-timestamp': modern['webhook-timestamp'],
      'svix-signature': modern['webhook-signature'],
    };
    expect(provider.verifyAndParseWebhook(legacy, payload).kind).toBe('status_change');
  });
});

describe('RecallProvider.dispatchBot error translation', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  const dispatchInput = {
    meetingUrl: 'https://outlook.office365.com/owa/?itemid=x',
    botName: 'Meri Notetaker (recording)',
    recordingPolicy: 'transcript_only' as const,
  };

  // Plain object shaped like the Response surface fetchJson touches — the jest
  // node env's Response global is not fetch-compatible.
  const fakeResponse = (status: number, body: unknown) => ({
    ok: false,
    status,
    text: async () => JSON.stringify(body),
  });

  test("Recall's meeting_url 400 becomes an actionable BadRequest, not a generic 503", async () => {
    global.fetch = jest.fn(async () =>
      fakeResponse(400, {
        meeting_url: ['The meeting_url is malformed, or for an unsupported platform.'],
      }),
    ) as unknown as typeof fetch;
    const provider = makeProvider();
    await expect(provider.dispatchBot(dispatchInput)).rejects.toThrow(
      'paste the actual Zoom / Google Meet / Teams join URL',
    );
  });

  test('other Recall 4xx/5xx stay generic (no detail leaked to the user)', async () => {
    global.fetch = jest.fn(async () =>
      fakeResponse(429, { detail: 'quota exceeded' }),
    ) as unknown as typeof fetch;
    const provider = makeProvider();
    await expect(provider.dispatchBot(dispatchInput)).rejects.toThrow(
      'Recall API error (HTTP 429)',
    );
  });
});

describe('RecallProvider.dispatchBot — branded camera tile (automatic_video_output)', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  // Capture the create-bot request body and return a valid bot id.
  function captureBody() {
    const calls: Array<{ url: string; body: unknown }> = [];
    global.fetch = jest.fn(async (url: string, init: { body?: string }) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body) : undefined });
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'bot_1' }) };
    }) as unknown as typeof fetch;
    return calls;
  }

  const base = {
    meetingUrl: 'https://us02web.zoom.us/j/1',
    botName: 'Meri Notetaker (recording)',
    recordingPolicy: 'transcript_only' as const,
  };

  test('attaches the Meri JPEG as the camera feed for both recording states on a normal platform', async () => {
    const calls = captureBody();
    await makeProvider().dispatchBot({ ...base, platform: 'zoom' });
    const body = calls[0]?.body as {
      automatic_video_output?: {
        in_call_recording?: { kind?: string; b64_data?: string };
        in_call_not_recording?: { kind?: string; b64_data?: string };
      };
    };
    const avo = body.automatic_video_output;
    expect(avo?.in_call_recording?.kind).toBe('jpeg');
    expect(avo?.in_call_not_recording?.kind).toBe('jpeg');
    // Real base64 payload, not empty.
    expect((avo?.in_call_recording?.b64_data ?? '').length).toBeGreaterThan(1000);
    expect(avo?.in_call_not_recording?.b64_data).toBe(avo?.in_call_recording?.b64_data);
  });

  test('omits the camera feed for Slack huddles (unsupported by Recall)', async () => {
    const calls = captureBody();
    await makeProvider().dispatchBot({ ...base, platform: 'slack' });
    const body = calls[0]?.body as { automatic_video_output?: unknown };
    expect(body.automatic_video_output).toBeUndefined();
  });
});

describe('normalizeEvent classification', () => {
  test('bot.* events are status changes with the nested code', () => {
    const event = normalizeEvent({
      event: 'bot.done',
      data: { data: { code: 'done' }, bot: { id: 'b1', metadata: { tenantId: 't1' } } },
    });
    expect(event.kind).toBe('status_change');
    expect(event.statusCode).toBe('done');
  });

  test('ONLY recording.done is recording_ready — started/processing/deleted are not', () => {
    const done = normalizeEvent({
      event: 'recording.done',
      data: { recording: { id: 'r1' }, bot: { id: 'b1', metadata: {} } },
    });
    expect(done.kind).toBe('recording_ready');
    expect(done.recordingId).toBe('r1');

    for (const name of ['recording.started', 'recording.processing', 'recording.deleted']) {
      expect(normalizeEvent({ event: name, data: {} }).kind).toBe('unknown');
    }
  });

  test('transcript.done carries the transcript id', () => {
    const event = normalizeEvent({
      event: 'transcript.done',
      data: { transcript: { id: 'tr1' }, bot: { id: 'b1', metadata: {} } },
    });
    expect(event.kind).toBe('transcript_done');
    expect(event.transcriptId).toBe('tr1');
  });

  test('transcript.failed / recording.failed are pipeline failures', () => {
    expect(normalizeEvent({ event: 'transcript.failed', data: {} }).kind).toBe('pipeline_failed');
    expect(normalizeEvent({ event: 'recording.failed', data: {} }).kind).toBe('pipeline_failed');
  });

  test('malformed payloads normalize without throwing', () => {
    expect(normalizeEvent(null).kind).toBe('unknown');
    expect(normalizeEvent({}).kind).toBe('unknown');
    expect(normalizeEvent({ event: 42 }).kind).toBe('unknown');
    expect(normalizeEvent({ event: 'bot.status_change' }).metadata).toEqual({});
  });
});
