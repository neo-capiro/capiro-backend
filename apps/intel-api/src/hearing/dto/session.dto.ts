import { IsArray, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export enum LiveHearingSourceTypeDto {
  hearing = 'hearing',
  markup = 'markup',
  meeting = 'meeting',
  webinar = 'webinar',
  agency_session = 'agency_session',
}

export enum LiveHearingAudioSourceDto {
  browser_mic = 'browser_mic',
  uploaded_audio = 'uploaded_audio',
  stream_url = 'stream_url',
  conference_bridge = 'conference_bridge',
}

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
  attestation!: string;
}
