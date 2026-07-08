import {
  Injectable,
  Logger,
  BadRequestException,
  HttpException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Webhook } from 'svix';
import type { AppConfig } from '../../config/config.schema.js';
import { MERI_CAMERA_JPEG_B64 } from './meri-camera-image.js';
import {
  type MeetingBotProvider,
  type DispatchBotInput,
  type DispatchBotResult,
  type CreateTranscriptOptions,
  type CreateTranscriptResult,
  type NormalizedTranscript,
  type TranscriptUtterance,
  type NormalizedBotEvent,
  type BotWebhookEventKind,
} from './meeting-bot.provider.js';

/** Outbound request timeout to the Recall REST API. */
const RECALL_TIMEOUT_MS = 30_000;

/**
 * Non-2xx from the Recall API, carrying the status + (truncated) response body so
 * call sites can translate SPECIFIC vendor rejections (e.g. a bad meeting_url)
 * into user-actionable errors. Extends ServiceUnavailableException so untranslated
 * cases keep today's 503 behavior. Exported for unit tests.
 */
export class RecallApiHttpError extends ServiceUnavailableException {
  constructor(
    readonly httpStatus: number,
    readonly detail: string,
  ) {
    super(`Recall API error (HTTP ${httpStatus})`);
  }
}
/**
 * How long Recall retains the recording media. Async (BYO-Deepgram) transcription
 * needs the media to exist to transcribe + download, so literal zero-retention is
 * NOT possible on this path (see docs/plans §4). We keep it short and delete_media
 * after pulling the transcript. Real-time streaming would allow true ZDR — that is
 * a Phase-1 decision, not the async MVP default.
 */
const RECALL_MEDIA_RETENTION_HOURS = 24;
/** Default BYO-Deepgram model for async transcription. */
const DEFAULT_DEEPGRAM_MODEL = 'nova-3';

/**
 * Recall.ai implementation of {@link MeetingBotProvider}.
 *
 * Verified against docs.recall.ai (2026-07): Create Bot is `POST /api/v1/bot/`,
 * auth is the `Authorization: Token <key>` scheme (NOT Bearer), hosts are
 * region-specific — Capiro's workspace is us-west-2.recall.ai — the BYO-Deepgram key is
 * configured in Recall's dashboard per region (NOT passed here), async transcripts
 * are created on the RECORDING, and webhooks are Svix-signed.
 *
 * Phase 0 = this provider only. It is DI-registered via NotetakerModule but has no
 * consumer yet; the dispatch endpoint + /webhooks/recall receiver land in Phase 1.
 */
@Injectable()
export class RecallProvider implements MeetingBotProvider {
  private readonly logger = new Logger(RecallProvider.name);
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly webhookSecret: string | undefined;

  constructor(config: ConfigService<AppConfig, true>) {
    // RECALL_API_BASE_URL has a schema default; strip any trailing slash so we can
    // safely append `/api/v1/...`.
    this.baseUrl = config.get('RECALL_API_BASE_URL', { infer: true }).replace(/\/+$/, '');
    this.apiKey = config.get('RECALL_API_KEY', { infer: true });
    this.webhookSecret = config.get('RECALL_WEBHOOK_SECRET', { infer: true });
  }

  async dispatchBot(input: DispatchBotInput): Promise<DispatchBotResult> {
    const body: Record<string, unknown> = {
      meeting_url: input.meetingUrl,
      bot_name: input.botName,
      recording_config: {
        // Short timed retention so the async BYO-Deepgram transcript can be created
        // and downloaded; we delete_media once the transcript is pulled.
        retention: { type: 'timed', hours: RECALL_MEDIA_RETENTION_HOURS },
      },
    };
    if (input.metadata) body.metadata = input.metadata;
    if (input.joinAt) body.join_at = input.joinAt;
    // Brand the bot's camera tile with the Meri mark so participants see whose
    // tool is present (also softens the anonymous/"(Unverified)" appearance). This
    // is Recall's automatic_video_output — a static JPEG streamed as the bot's
    // camera feed; it is NOT the name-adjacent profile avatar (that needs a
    // signed-in bot — see docs/plans/meeting-notetaker-signed-in-bots.md). Same
    // image whether or not we're recording. Supported on Zoom/Meet/Teams/Webex but
    // NOT Slack huddles, so skip it there to avoid a create-bot rejection.
    if (input.platform !== 'slack') {
      const cameraImage = { kind: 'jpeg', b64_data: MERI_CAMERA_JPEG_B64 };
      body.automatic_video_output = {
        in_call_recording: cameraImage,
        in_call_not_recording: cameraImage,
      };
    }
    if (input.disclosureMessage) {
      // Top-level `chat` object (NOT under recording_config): post the consent
      // disclosure the moment the bot joins, and re-post to each late-joiner so
      // everyone is notified. send_to 'everyone' works across Zoom/Meet/Teams.
      body.chat = {
        on_bot_join: { send_to: 'everyone', message: input.disclosureMessage },
        on_participant_join: { exclude_host: true, message: input.disclosureMessage },
      };
    }

    let bot: { id: string } | undefined;
    try {
      bot = await this.request<{ id: string }>('POST', '/api/v1/bot/', body);
    } catch (err) {
      // Recall's create-bot 400 on the URL is really the USER's error (they
      // pasted a calendar link, not a join link) — translate it so the modal
      // shows something actionable instead of "Recall API error (HTTP 400)".
      if (
        err instanceof RecallApiHttpError &&
        err.httpStatus === 400 &&
        err.detail.includes('meeting_url')
      ) {
        throw new BadRequestException(
          'The meeting provider rejected that link — paste the actual Zoom / Google Meet / Teams join URL from the calendar invite',
        );
      }
      throw err;
    }
    if (!bot?.id) {
      this.logger.warn('Recall create-bot returned no id');
      throw new ServiceUnavailableException('Recall did not return a bot id');
    }
    return { externalBotId: bot.id, raw: bot };
  }

  async createAsyncTranscript(
    recordingId: string,
    opts?: CreateTranscriptOptions,
  ): Promise<CreateTranscriptResult> {
    const deepgramOptions: Record<string, unknown> = {
      model: opts?.model ?? DEFAULT_DEEPGRAM_MODEL,
    };
    if (opts?.languageCode) deepgramOptions.language = opts.languageCode;

    const transcript = await this.request<{ id: string }>(
      'POST',
      `/api/v1/recording/${encodeURIComponent(recordingId)}/create_transcript/`,
      {
        // BYO-Deepgram: the customer's Deepgram key/project are configured in the
        // Recall dashboard per region; here we only select the provider.
        provider: { deepgram_async: deepgramOptions },
        diarization: { use_separate_streams_when_available: true },
      },
    );
    if (!transcript?.id) {
      throw new ServiceUnavailableException('Recall did not return a transcript id');
    }
    return { transcriptId: transcript.id, raw: transcript };
  }

  async getTranscript(transcriptId: string): Promise<NormalizedTranscript> {
    const resource = await this.request<{ data?: { download_url?: string } }>(
      'GET',
      `/api/v1/transcript/${encodeURIComponent(transcriptId)}/`,
    );
    const downloadUrl = resource?.data?.download_url;
    if (!downloadUrl) {
      throw new ServiceUnavailableException('Recall transcript has no download_url yet');
    }
    // download_url is a pre-signed URL — fetch WITHOUT the Recall auth header.
    const segments = await this.fetchJson<RecallTranscriptSegment[]>(downloadUrl, {
      method: 'GET',
    });
    const utterances = (Array.isArray(segments) ? segments : []).map(normalizeSegment);
    const plainText = utterances
      .map((u) => (u.speaker ? `${u.speaker}: ${u.text}` : u.text))
      .filter((line) => line.trim().length > 0)
      .join('\n');
    return { transcriptId, utterances, plainText };
  }

  async getRecordingId(externalBotId: string): Promise<string | null> {
    const bot = await this.request<{ recordings?: Array<{ id?: string }> }>(
      'GET',
      `/api/v1/bot/${encodeURIComponent(externalBotId)}/`,
    );
    const id = bot?.recordings?.[0]?.id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  }

  async leaveCall(externalBotId: string): Promise<void> {
    await this.request('POST', `/api/v1/bot/${encodeURIComponent(externalBotId)}/leave_call/`, {});
  }

  async deleteMedia(externalBotId: string): Promise<void> {
    await this.request(
      'POST',
      `/api/v1/bot/${encodeURIComponent(externalBotId)}/delete_media/`,
      {},
    );
  }

  verifyAndParseWebhook(
    headers: Record<string, string | undefined>,
    rawBody: Buffer | string,
  ): NormalizedBotEvent {
    if (!this.webhookSecret) {
      // Fail closed: never accept an unsigned/unverifiable webhook.
      throw new ServiceUnavailableException('RECALL_WEBHOOK_SECRET is not configured');
    }
    // Recall sends modern Svix headers (webhook-id/-timestamp/-signature); accept
    // the legacy svix-* names too. Svix's verify() expects the svix-* keys.
    const id = headers['webhook-id'] ?? headers['svix-id'];
    const timestamp = headers['webhook-timestamp'] ?? headers['svix-timestamp'];
    const signature = headers['webhook-signature'] ?? headers['svix-signature'];
    if (!id || !timestamp || !signature) {
      throw new BadRequestException('Missing Recall webhook signature headers');
    }

    const payload = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const wh = new Webhook(this.webhookSecret);
    let parsed: unknown;
    try {
      parsed = wh.verify(payload, {
        'svix-id': id,
        'svix-timestamp': timestamp,
        'svix-signature': signature,
      });
    } catch (err) {
      this.logger.warn(`Recall webhook signature verification failed: ${(err as Error).message}`);
      throw new UnauthorizedException('Invalid Recall webhook signature');
    }
    return normalizeEvent(parsed);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.apiKey) {
      throw new ServiceUnavailableException('RECALL_API_KEY is not configured');
    }
    return this.fetchJson<T>(`${this.baseUrl}${path}`, {
      method,
      headers: {
        // Recall uses the Token scheme, not Bearer.
        Authorization: `Token ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private async fetchJson<T>(url: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RECALL_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        this.logger.warn(
          `Recall API ${init.method} ${url} -> HTTP ${res.status} ${detail.slice(0, 500)}`,
        );
        throw new RecallApiHttpError(res.status, detail.slice(0, 500));
      }
      // Some endpoints (leave_call, delete_media) may return an empty body. The
      // abort timer stays armed through this body read (cleared only in the
      // finally below), so a stalled transfer — headers received but the body
      // hanging, e.g. a dropped pre-signed download_url stream — still aborts at
      // RECALL_TIMEOUT_MS instead of hanging forever.
      const text = await res.text();
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new ServiceUnavailableException('Recall API returned a non-JSON response');
      }
    } catch (err) {
      // Preserve our own HTTP exceptions (non-ok / non-JSON) unchanged.
      if (err instanceof HttpException) throw err;
      if ((err as Error).name === 'AbortError') {
        throw new ServiceUnavailableException(
          `Recall request timed out after ${RECALL_TIMEOUT_MS / 1000}s`,
        );
      }
      throw new ServiceUnavailableException(`Recall request failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── payload normalization (kept as pure module fns so they unit-test easily) ────

interface RecallTranscriptSegment {
  participant?: {
    id?: number;
    name?: string | null;
    is_host?: boolean;
    email?: string | null;
  };
  language_code?: string | null;
  words?: Array<{
    text?: string;
    start_timestamp?: { relative?: number | null } | null;
    end_timestamp?: { relative?: number | null } | null;
  }>;
}

function normalizeSegment(seg: RecallTranscriptSegment): TranscriptUtterance {
  const words = (seg.words ?? []).map((w) => ({
    text: w.text ?? '',
    startSec: w.start_timestamp?.relative ?? null,
    endSec: w.end_timestamp?.relative ?? null,
  }));
  return {
    speaker: seg.participant?.name ?? null,
    speakerId: seg.participant?.id ?? null,
    isHost: seg.participant?.is_host ?? false,
    email: seg.participant?.email ?? null,
    languageCode: seg.language_code ?? null,
    words,
    text: words
      .map((w) => w.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim(),
  };
}

/** Safely read a nested string value from an unknown object. */
function readString(obj: unknown, ...path: string[]): string | null {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur && typeof cur === 'object' && key in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return null;
    }
  }
  return typeof cur === 'string' ? cur : null;
}

function readObject(obj: unknown, ...path: string[]): Record<string, unknown> {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur && typeof cur === 'object' && key in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return {};
    }
  }
  return cur && typeof cur === 'object' && !Array.isArray(cur)
    ? (cur as Record<string, unknown>)
    : {};
}

/**
 * Normalize a verified Recall webhook payload. Recall's shapes are double-nested
 * (data.data.code for status; data.transcript.id / data.recording.id for the async
 * lifecycle) and the `event` string carries the real type. We read defensively from
 * the documented locations and always surface `raw` so a Phase-1 receiver can reach
 * anything not modeled here. Docs: docs.recall.ai/docs/bot-status-change-events,
 * .../real-time-event-payloads, .../async-transcription.
 *
 * Exported for unit tests (pure function, no Recall calls).
 */
export function normalizeEvent(payload: unknown): NormalizedBotEvent {
  const event = readString(payload, 'event') ?? '';
  let kind: BotWebhookEventKind = 'unknown';
  if (event === 'bot.status_change' || event.startsWith('bot.')) kind = 'status_change';
  else if (event === 'transcript.done') kind = 'transcript_done';
  else if (event === 'transcript.failed' || event === 'recording.failed') kind = 'pipeline_failed';
  else if (event === 'transcript.data' || event === 'transcript.partial_data')
    kind = 'transcript_data';
  // ONLY recording.done means "media finished and ready to transcribe". Other
  // recording.* events (started/processing/deleted) must NOT trigger async
  // transcription — creating a transcript on an unfinished recording fails and
  // would surface a spurious `failed` status to the user.
  else if (event === 'recording.done') kind = 'recording_ready';

  return {
    kind,
    event,
    botId: readString(payload, 'data', 'bot', 'id'),
    recordingId: readString(payload, 'data', 'recording', 'id'),
    transcriptId: readString(payload, 'data', 'transcript', 'id'),
    statusCode: readString(payload, 'data', 'data', 'code'),
    metadata: readObject(payload, 'data', 'bot', 'metadata'),
    raw: payload,
  };
}
