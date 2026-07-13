/**
 * Vendor-agnostic contract for a "meeting bot" provider — a service that can send
 * a bot to JOIN a live Zoom / Google Meet / Microsoft Teams meeting, record it,
 * transcribe it (on OUR Deepgram), and stream back signed lifecycle events.
 *
 * The concrete implementation for GA is {@link RecallProvider} (Recall.ai). This
 * interface + DI token exists so the vendor is swappable (e.g. self-hosted
 * Attendee) without touching business logic — see
 * docs/plans/meeting-notetaker-bot-plan.md §3/§7.
 *
 * Phase 0 delivers this contract + the Recall implementation only. Wiring a
 * dispatch endpoint, a /webhooks/recall receiver, and persistence into the
 * meeting debrief is Phase 1.
 */

/**
 * How long recorded media may live (our policy, enforced at our storage layer).
 * MVP implements 'transcript_only' (default) and 'no_storage' (debrief only, no
 * transcript at rest); 'audio_and_transcript' is REJECTED at dispatch until audio
 * retention is actually built — the pipeline always delete_media's vendor
 * recordings after pulling the transcript.
 */
export type RecordingPolicy = 'no_storage' | 'transcript_only' | 'audio_and_transcript';

export interface DispatchBotInput {
  /** The meeting join URL (Zoom/Meet/Teams). */
  meetingUrl: string;
  /** Display name the bot shows in the participant list (part of the consent disclosure). */
  botName: string;
  /**
   * Opaque key/value metadata echoed back on every webhook for this bot. We stash
   * `{ tenantId, meetingBotSessionId }` here so the (tenant-less) webhook receiver
   * can resolve the tenant and wrap its DB writes in prisma.withTenant.
   */
  metadata?: Record<string, string>;
  /** Our recording policy for this session (drives provider retention + our S3 handling). */
  recordingPolicy: RecordingPolicy;
  /**
   * Normalized platform label (zoom|meet|teams|webex|slack|null). Lets a provider
   * gate platform-specific features — e.g. the branded camera tile is supported on
   * Zoom/Meet/Teams/Webex but NOT Slack huddles, so it's only attached off-Slack.
   */
  platform?: string | null;
  /** ISO8601 time to join later; omit to join immediately. */
  joinAt?: string;
  /**
   * In-meeting consent disclosure the bot posts to chat on join, and re-posts to
   * each late-joiner so everyone is notified. Required by the strict-consent
   * posture (see docs/plans/meeting-notetaker-consent-copy.md). Omit = no chat.
   */
  disclosureMessage?: string;
}

export interface DispatchBotResult {
  /** The provider's bot id (Recall bot id). */
  externalBotId: string;
  raw: unknown;
}

export interface CreateTranscriptOptions {
  /** Deepgram model, e.g. 'nova-3'. */
  model?: string;
  /** BCP-47 language, e.g. 'en'. */
  languageCode?: string;
}

export interface CreateTranscriptResult {
  transcriptId: string;
  raw: unknown;
}

export interface TranscriptWord {
  text: string;
  /** Seconds from meeting start, or null if unavailable. */
  startSec: number | null;
  endSec: number | null;
}

export interface TranscriptUtterance {
  /** Diarized/labelled speaker name (never a stored voiceprint — see consent policy). */
  speaker: string | null;
  speakerId: number | null;
  isHost: boolean;
  email: string | null;
  languageCode: string | null;
  words: TranscriptWord[];
  /** The utterance's words joined into one line. */
  text: string;
}

export interface NormalizedTranscript {
  transcriptId: string;
  utterances: TranscriptUtterance[];
  /**
   * Flattened, speaker-labelled plaintext ready to hand to
   * EngagementService.generateMeetingDebriefDraft({ method: 'upload', sourceText }).
   */
  plainText: string;
}

/**
 * Lifecycle of an async transcription job, as reported by the provider's transcript
 * resource (independent of whether the `transcript.done` webhook was delivered).
 * `unknown` = a state we don't recognize — treated as "keep waiting", never failed.
 */
export type TranscriptLifecycle = 'processing' | 'done' | 'failed' | 'unknown';

/** Terminal-ness of a bot as reported by Retrieve Bot (drives the recording-leg self-heal). */
export interface BotCompletion {
  /**
   * `live` = still in/entering the call; `done` = the call ended (recordingId set if
   * anything was captured); `fatal` = the bot errored out; `unknown` = no status yet.
   */
  state: 'live' | 'done' | 'fatal' | 'unknown';
  /** The finished recording id, if the bot produced one. */
  recordingId: string | null;
}

/**
 * Thrown by {@link MeetingBotProvider.getTranscript} when the transcript exists but
 * its media/download URL is not ready yet (async transcription still running). This
 * is NOT a failure — the caller must keep waiting rather than fail the session. A
 * long meeting can be transcribing for minutes after the job was created, well past
 * any "stale webhook" reconciliation window.
 */
export class TranscriptNotReadyError extends Error {
  constructor(message = 'Transcript is not ready yet') {
    super(message);
    this.name = 'TranscriptNotReadyError';
  }
}

/** Coarse classification of an inbound provider webhook, normalized across vendors. */
export type BotWebhookEventKind =
  | 'status_change'
  | 'recording_ready'
  | 'transcript_done'
  | 'transcript_data'
  /** The provider's recording or async-transcription pipeline failed terminally. */
  | 'pipeline_failed'
  | 'unknown';

export interface NormalizedBotEvent {
  kind: BotWebhookEventKind;
  /** The raw provider event string (e.g. 'bot.status_change', 'transcript.done'). */
  event: string;
  botId: string | null;
  recordingId: string | null;
  transcriptId: string | null;
  /** Provider status code for status_change events (e.g. 'done', 'fatal', 'in_call_recording'). */
  statusCode: string | null;
  /** Metadata we attached at dispatch time, echoed back by the provider. */
  metadata: Record<string, unknown>;
  raw: unknown;
}

export interface MeetingBotProvider {
  /** Dispatch a bot to join + record a meeting. Returns the provider bot id. */
  dispatchBot(input: DispatchBotInput): Promise<DispatchBotResult>;

  /**
   * Create an async transcript on a FINISHED recording using our own (BYO) Deepgram
   * key. Recall's async flow is: dispatch → recording-ready webhook (gives a
   * recordingId) → createAsyncTranscript(recordingId) → transcript.done webhook →
   * getTranscript(transcriptId).
   */
  createAsyncTranscript(
    recordingId: string,
    opts?: CreateTranscriptOptions,
  ): Promise<CreateTranscriptResult>;

  /**
   * Fetch + normalize a completed transcript (follows the provider's download URL).
   * Throws {@link TranscriptNotReadyError} if the transcript exists but is still
   * transcribing — the caller must keep waiting, not fail.
   */
  getTranscript(transcriptId: string): Promise<NormalizedTranscript>;

  /**
   * Read the transcript job's lifecycle WITHOUT downloading it — lets the
   * reconciliation sweep tell "still transcribing a long meeting" apart from
   * "genuinely failed", so it never prematurely fails an in-flight transcript.
   */
  getTranscriptStatus(transcriptId: string): Promise<TranscriptLifecycle>;

  /**
   * Read a bot's terminal state directly (Retrieve Bot). Powers the recording-leg
   * self-heal: a session stuck at `recording` because a `call_ended`/`recording.done`
   * webhook was dropped can be advanced (or failed) by polling the bot itself.
   */
  getBotCompletion(externalBotId: string): Promise<BotCompletion>;

  /**
   * Look up the finished recording id for a bot directly (Retrieve Bot). Fallback
   * for providers/flows where the "recording ready" webhook doesn't arrive or
   * doesn't carry the recording id — e.g. Recall's `bot.done` choreography.
   * Returns null when the bot has no completed recording (never joined / no-show).
   */
  getRecordingId(externalBotId: string): Promise<string | null>;

  /** Remove the bot from the meeting (irreversible). */
  leaveCall(externalBotId: string): Promise<void>;

  /** Permanently delete all stored recording media for a bot (irreversible). */
  deleteMedia(externalBotId: string): Promise<void>;

  /**
   * Verify a signed inbound webhook and return the normalized event. Throws on a
   * missing/invalid signature (the caller maps that to 400/401). `rawBody` MUST be
   * the exact unparsed bytes the provider signed.
   */
  verifyAndParseWebhook(
    headers: Record<string, string | undefined>,
    rawBody: Buffer | string,
  ): NormalizedBotEvent;
}

/** DI token — inject with `@Inject(MEETING_BOT_PROVIDER) private readonly bot: MeetingBotProvider`. */
export const MEETING_BOT_PROVIDER = 'MEETING_BOT_PROVIDER';
