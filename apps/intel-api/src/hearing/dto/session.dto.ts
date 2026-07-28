import { IsArray, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export enum LiveHearingSourceTypeDto {
  hearing = 'hearing',
  markup = 'markup',
  meeting = 'meeting',
  webinar = 'webinar',
  agency_session = 'agency_session',
}

/**
 * Historical enum values remain accepted so an older deployed web bundle gets a
 * compatible response rather than a 400. HearingSessionService normalizes every
 * new session to browser_mic because browser-tab capture is the only active audio
 * implementation in this release.
 */
export enum LiveHearingAudioSourceDto {
  browser_mic = 'browser_mic',
  uploaded_audio = 'uploaded_audio',
  stream_url = 'stream_url',
  conference_bridge = 'conference_bridge',
}

/**
 * audio_and_transcript is retained for wire compatibility but is normalized to
 * transcript_only until an encrypted audio sink and retention lifecycle exist.
 */
export enum RecordingPolicyDto {
  transcript_only = 'transcript_only',
  audio_and_transcript = 'audio_and_transcript',
  no_storage = 'no_storage',
}

export class CreateSessionDto {
  @IsString()
  @MaxLength(300)
  title!: string;

  @IsEnum(LiveHearingSourceTypeDto)
  sourceType!: LiveHearingSourceTypeDto;

  @IsEnum(LiveHearingAudioSourceDto)
  audioSource!: LiveHearingAudioSourceDto;

  @IsOptional()
  @IsEnum(RecordingPolicyDto)
  recordingPolicy?: RecordingPolicyDto;

  /**
   * The page or media URL the analyst will play in a browser tab. Direct HLS,
   * MP4 and audio sources can be previewed in the Live Hearing Room; YouTube,
   * C-SPAN, committee and event pages can be embedded or opened separately.
   * Transcription always comes from the tab audio the analyst explicitly shares;
   * the server never pulls this URL into ffmpeg.
   */
  @IsOptional() @IsString() @MaxLength(2000) sourceUrl?: string;

  /**
   * Consent attestation. REQUIRED (server-enforced) only for PRIVATE source
   * types (meeting / webinar / agency_session) — capturing a private session
   * needs the operator to attest they're authorized. PUBLIC congressional
   * hearing/markup skip it and store consent_status=not_required (public
   * proceedings, consent not required). See HearingSessionService.create.
   * Public types ignore any value sent.
   */
  @IsOptional() @IsString() @MaxLength(2000) consentAttestation?: string;

  @IsOptional() @IsString() clientId?: string;
  @IsOptional() @IsString() matterId?: string;
  @IsOptional() @IsString() hearingId?: string;
  @IsOptional() @IsString() committeeId?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) issueIds?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) billIds?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) programElementIds?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) agencyIds?: string[];
}

export class ConfirmConsentDto {
  /** The user attests consent was obtained from all required parties. */
  @IsString()
  @MaxLength(2000)
  attestation!: string;
}
