import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsIn,
  IsOptional,
  IsObject,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { AssociationEntityType, EngagementProvider, EngagementTaskStatus } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { EngagementService } from './engagement.service.js';
import { OutreachJobService, outreachRecipientKey } from './outreach-job.service.js';
import { NotetakerService } from './notetaker/notetaker.service.js';
import { OutreachDraftService } from './outreach-draft.service.js';
import { OutreachSendIntentService } from './outreach-send-intent.service.js';

/**
 * Coerce empty/whitespace-only strings to `undefined` BEFORE validation runs.
 *
 * Many optional recipient/context fields are declared `@IsOptional() @Length(1, N)`.
 * class-validator's `@IsOptional()` only skips `null`/`undefined` — an empty
 * string `''` still hits `@Length(1, N)` and fails min-length, which (under the
 * global `forbidNonWhitelisted` ValidationPipe) 400s the entire save/generate
 * request. The wizard legitimately emits `''` for fields like `relevanceReason`
 * when a recipient has no committee/focus area, so saving an in-progress
 * outreach failed. Stacking this transform makes `''` become `undefined` so
 * `@IsOptional()` correctly skips it, while genuinely-provided non-empty values
 * still get the `@Length(1, N)` check. Applied via `transform: true` in main.ts.
 */
function EmptyToUndefined() {
  return Transform(({ value }) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value,
  );
}

class CreateIntegrationDto {
  @IsEnum(EngagementProvider)
  provider!: EngagementProvider;

  @IsOptional()
  @IsEmail()
  accountEmail?: string;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  displayName?: string;
}

class AttendeeDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @Length(1, 160)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(1, 80)
  role?: string;

  @IsOptional()
  @IsString()
  @Length(1, 80)
  responseStatus?: string;
}

class CreateMeetingDto {
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsString()
  @Length(1, 240)
  subject!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @Length(1, 240)
  location?: string;

  @IsDateString()
  startsAt!: string;

  @IsDateString()
  endsAt!: string;

  @IsOptional()
  @IsEmail()
  organizerEmail?: string;

  @IsOptional()
  @IsString()
  @Length(1, 160)
  organizerName?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(80)
  @ValidateNested({ each: true })
  @Type(() => AttendeeDto)
  attendees?: AttendeeDto[];
}

class UpdateMeetingDto {
  @IsOptional()
  @IsUUID()
  clientId?: string | null;

  @IsOptional()
  @IsString()
  @Length(1, 240)
  subject?: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsString()
  location?: string | null;

  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @IsOptional()
  @IsDateString()
  endsAt?: string;

  @IsOptional()
  @IsString()
  @Length(1, 80)
  status?: string;
}

class CreateNoteDto {
  @IsString()
  @MinLength(1)
  body!: string;

  @IsOptional()
  @IsBoolean()
  confidential?: boolean;

  @IsOptional()
  @IsString()
  accessLevel?: string;
}

class CreateDebriefDto extends CreateNoteDto {}

class GenerateDebriefDraftDto {
  @IsIn(['upload', 'manual', 'voice'])
  method!: 'upload' | 'manual' | 'voice';

  @IsString()
  @MinLength(1)
  sourceText!: string;
}

class DispatchNotetakerDto {
  @IsString()
  @Length(1, 2000)
  meetingUrl!: string;

  // Strict-consent affirmation — must be true (re-enforced in the service).
  @IsBoolean()
  authorizedToRecord!: boolean;

  @IsOptional()
  @IsBoolean()
  allPartiesWillBeNotified?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @IsString({ each: true })
  allPartyStates?: string[];

  // 'audio_and_transcript' is deliberately NOT accepted: the MVP pipeline always
  // deletes vendor media after pulling the transcript, so offering it would be a
  // silent downgrade of a consent-critical choice. Add it here only when audio
  // retention is actually implemented.
  @IsOptional()
  @IsIn(['no_storage', 'transcript_only'])
  recordingPolicy?: 'no_storage' | 'transcript_only';

  @IsOptional()
  @IsDateString()
  joinAt?: string;
}

class GenerateMeetingPrepDto {
  @IsOptional()
  @IsString()
  @Length(0, 4000)
  additionalContext?: string;
}

class UpdateMeetingPrepDto {
  @IsOptional()
  @IsString()
  summary?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(80)
  @IsString({ each: true })
  agenda?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(80)
  @IsString({ each: true })
  talkingPoints?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(80)
  @IsString({ each: true })
  risks?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(80)
  @IsString({ each: true })
  followUps?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(80)
  @IsString({ each: true })
  emailEvidence?: string[];
}

// Meeting Library filters (Meetings v2 §6). page/limit follow the house
// pagination convention (default 1 / 50, capped at 100 server-side).
class MeetingLibraryQueryDto {
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsOptional()
  @IsIn(['prep', 'notes', 'debrief'])
  artifactType?: 'prep' | 'notes' | 'debrief';

  @IsOptional()
  @IsIn(['shared', 'private'])
  visibility?: 'shared' | 'private';

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

class CreateTaskDto {
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsOptional()
  @IsUUID()
  meetingId?: string;

  @IsOptional()
  @IsUUID()
  contactId?: string;

  @IsOptional()
  @IsUUID()
  mailThreadId?: string;

  @IsString()
  @Length(1, 240)
  title!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsUUID()
  ownerUserId?: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;
}

class UpdateTaskDto {
  @IsOptional()
  @IsString()
  @Length(1, 240)
  title?: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsUUID()
  ownerUserId?: string | null;

  @IsOptional()
  @IsDateString()
  dueDate?: string | null;

  @IsOptional()
  @IsEnum(EngagementTaskStatus)
  status?: EngagementTaskStatus;
}

class AssociationOverrideDto {
  @IsEnum(AssociationEntityType)
  entityType!: AssociationEntityType;

  @IsUUID()
  entityId!: string;

  @IsOptional()
  @IsUUID()
  clientId?: string;

  /**
   * When true, mark the entity (meetings only) as internal — clears any client
   * association and stops the sync from re-linking it. Mutually exclusive with
   * clientId; one of the two must be provided.
   */
  @IsOptional()
  @IsBoolean()
  internal?: boolean;

  @IsOptional()
  @IsString()
  reason?: string;
}

class AttachmentUploadDto {
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsOptional()
  @IsUUID()
  meetingId?: string;

  @IsOptional()
  @IsUUID()
  mailMessageId?: string;

  @IsString()
  @Length(1, 240)
  fileName!: string;

  @IsString()
  @Length(1, 160)
  contentType!: string;

  @IsInt()
  @Min(1)
  @Max(25 * 1024 * 1024)
  contentLength!: number;
}

class ConfirmAttachmentDto {
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsOptional()
  @IsUUID()
  meetingId?: string;

  @IsOptional()
  @IsUUID()
  mailMessageId?: string;

  @IsString()
  @Length(1, 240)
  fileName!: string;

  @IsString()
  @Length(1, 160)
  contentType!: string;

  @IsString()
  s3Key!: string;

  @IsOptional()
  @IsString()
  checksumSha256?: string;

  // Free-text provenance tag. Defaults to "manual" server-side. Used to scope an
  // attachment to a sub-entity without a dedicated column — e.g. "capability:<id>"
  // for documents uploaded from a capability drawer (which also carry clientId, so
  // they appear in the client Documents tab too).
  @IsOptional()
  @IsString()
  @Length(1, 120)
  source?: string;
}

const campaignTypes = [
  'post_meeting_followup',
  'congressional_outreach',
  'program_update',
  'custom',
] as const;

const campaignStatuses = ['draft', 'active', 'paused', 'complete'] as const;

class CreateCampaignDto {
  @IsString()
  @Length(1, 240)
  name!: string;

  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsOptional()
  @IsIn(campaignTypes)
  type?: (typeof campaignTypes)[number];

  @IsOptional()
  @IsObject()
  sourceContext?: Record<string, unknown>;
}

class UpdateCampaignDto {
  @IsOptional()
  @IsString()
  @Length(1, 240)
  name?: string;

  @IsOptional()
  @IsUUID()
  clientId?: string | null;

  @IsOptional()
  @IsIn(campaignTypes)
  type?: (typeof campaignTypes)[number];

  @IsOptional()
  @IsIn(campaignStatuses)
  status?: (typeof campaignStatuses)[number];

  @IsOptional()
  @IsString()
  @Length(0, 300)
  subject?: string | null;

  @IsOptional()
  @IsString()
  body?: string | null;

  @IsOptional()
  @IsObject()
  sourceContext?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

class CampaignRecipientDto {
  @IsOptional()
  @IsString()
  @Length(1, 160)
  name?: string;

  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  @Length(1, 240)
  title?: string;

  @IsOptional()
  @IsString()
  @Length(1, 240)
  office?: string;
}

class AddCampaignRecipientsDto {
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => CampaignRecipientDto)
  recipients!: CampaignRecipientDto[];
}

class GenerateCampaignEmailDto {
  @IsOptional()
  @IsString()
  customContext?: string;
}

const reportStatuses = ['auto', 'not_started', 'in_progress', 'complete'] as const;
const outreachTypes = ['campaign', 'follow_up', 'prep', 'outbound_campaign'] as const;
const outreachStatuses = ['draft', 'sent', 'opened_in_email', 'failed'] as const;
const outreachPromptTemplates = [
  'custom',
  'thank_you',
  'follow_up',
  'memo',
  'post_meeting_memo',
  'introduction',
  'meeting_request',
  'status_update',
] as const;

class CreateReportTargetOfficeDto {
  @IsOptional()
  @IsUUID()
  clientId?: string | null;

  @IsString()
  @Length(1, 240)
  memberPrincipal!: string;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  committee?: string | null;

  @IsOptional()
  @IsString()
  @Length(1, 160)
  staffer?: string | null;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  building?: string | null;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  leadOwner?: string | null;
}

class UpsertReportTargetOfficeDto extends CreateReportTargetOfficeDto {
  @IsString()
  @Length(1, 240)
  officeKey!: string;

  @IsOptional()
  @IsIn(reportStatuses)
  prepStatus?: (typeof reportStatuses)[number];

  @IsOptional()
  @IsIn(reportStatuses)
  outreachStatus?: (typeof reportStatuses)[number];

  @IsOptional()
  @IsIn(reportStatuses)
  submissionStatus?: (typeof reportStatuses)[number];

  @IsOptional()
  @IsString()
  @Length(1, 80)
  source?: string;
}

class OutreachContextPoolItemDto {
  @IsOptional()
  @IsString()
  @Length(1, 240)
  id?: string;

  @IsOptional()
  @IsString()
  @Length(1, 80)
  sourceType?: string;

  @IsOptional()
  @IsString()
  @Length(1, 240)
  title?: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  summary?: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  note?: string;

  @IsOptional()
  @IsString()
  @Length(1, 240)
  scope?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  recipientIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  matches?: string[];
}

class GroupMemberDto {
  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  @Length(0, 240)
  name?: string;
}

class OutreachRecipientDto {
  @IsOptional()
  @IsString()
  @EmptyToUndefined()
  @Length(1, 240)
  id?: string;

  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsOptional()
  @IsIn(['on-behalf', 'to-clients'])
  direction?: 'on-behalf' | 'to-clients';

  @IsOptional()
  @IsString()
  @EmptyToUndefined()
  @Length(1, 160)
  name?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @EmptyToUndefined()
  @Length(1, 240)
  office?: string;

  @IsOptional()
  @IsString()
  @EmptyToUndefined()
  @Length(1, 160)
  title?: string;

  @IsOptional()
  @IsString()
  @EmptyToUndefined()
  @Length(1, 80)
  chamber?: string;

  @IsOptional()
  @IsString()
  @EmptyToUndefined()
  @Length(1, 80)
  state?: string;

  @IsOptional()
  @IsString()
  @EmptyToUndefined()
  @Length(1, 80)
  district?: string;

  @IsOptional()
  @IsString()
  @EmptyToUndefined()
  @Length(1, 80)
  party?: string;

  @IsOptional()
  @IsString()
  @EmptyToUndefined()
  @Length(1, 240)
  directoryContactId?: string;

  @IsOptional()
  @IsString()
  @EmptyToUndefined()
  @Length(1, 240)
  directoryContactName?: string;

  @IsOptional()
  @IsString()
  @EmptyToUndefined()
  @Length(1, 160)
  committee?: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  address?: string;

  @IsOptional()
  @IsString()
  @EmptyToUndefined()
  @Length(1, 240)
  relevanceReason?: string;

  // The wizard tags each recipient with its provenance (e.g. "District nexus",
  // "Directory"). Display-only, but it IS sent in the generate/send payload, so
  // it must be whitelisted — otherwise forbidNonWhitelisted 400s the whole batch
  // and the wizard silently falls back to placeholder drafts. Allow empty too.
  @IsOptional()
  @IsString()
  @Length(0, 240)
  sourceLabel?: string;

  @IsOptional()
  @IsString()
  @EmptyToUndefined()
  @Length(1, 500)
  personalNote?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsEmail({}, { each: true })
  cc?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsEmail({}, { each: true })
  bcc?: string[];

  // Group representative only: all members for the To field (one shared email).
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => GroupMemberDto)
  groupMembers?: GroupMemberDto[];

  /**
   * Phase 0 (§3.c1) — the generation slot(s) this recipient's draft belongs to.
   * The wizard sends its GenerationTargetKey; one generated draft can back
   * several slots (the same person in two lists is generated once, on purpose).
   *
   * NOTE: `recipientKey` is deliberately NOT accepted from the browser — it is
   * derived server-side with the same precedence as outreachRecipientKey().
   */
  @IsOptional()
  @IsString()
  @EmptyToUndefined()
  @Length(1, 512)
  generationKey?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  @Length(1, 512, { each: true })
  generationKeys?: string[];

  @IsOptional()
  @IsUUID()
  meetingId?: string;

  @IsOptional()
  @IsString()
  @EmptyToUndefined()
  @Length(1, 240)
  meetingSubject?: string;

  @IsOptional()
  @IsString()
  @EmptyToUndefined()
  @Length(1, 120)
  meetingDateTime?: string;

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  attendeeNames?: string;

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  attendeeEmails?: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  prepSummary?: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  debriefSummary?: string;

  @IsOptional()
  @IsString()
  @Length(0, 500)
  meetingLocation?: string;
}

class CreateOutreachTemplateDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(1, 300)
  subject?: string;

  @IsString()
  @Length(1, 10000)
  body!: string;
}

// Outreach 2.0 saved audiences (reusable lists/groups; user-owned).
class OutreachAudienceMemberDto {
  @IsIn(['congress', 'client_contact', 'manual'])
  source!: 'congress' | 'client_contact' | 'manual';

  @IsOptional()
  @IsString()
  @EmptyToUndefined()
  @Length(1, 240)
  sourceRefId?: string;

  @IsOptional()
  @IsString()
  @EmptyToUndefined()
  @Length(1, 160)
  name?: string;

  @IsEmail()
  email!: string;

  @IsOptional()
  @IsString()
  @EmptyToUndefined()
  @Length(1, 240)
  title?: string;

  @IsOptional()
  @IsString()
  @EmptyToUndefined()
  @Length(1, 240)
  office?: string;
}

class CreateOutreachAudienceDto {
  @IsIn(['list', 'group'])
  kind!: 'list' | 'group';

  @IsString()
  @Length(1, 120)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(1, 500)
  description?: string;

  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => OutreachAudienceMemberDto)
  members!: OutreachAudienceMemberDto[];
}

class ListOutreachAudiencesQueryDto {
  @IsOptional()
  @IsIn(['list', 'group'])
  kind?: 'list' | 'group';
}

class CreateAiTemplateDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  @IsOptional()
  @IsString()
  @Length(1, 50)
  category?: string;

  @IsString()
  @MinLength(1)
  prompt!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @Length(1, 50)
  tone?: string;
}

class UpdateAiTemplateDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(1, 50)
  category?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  prompt?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @Length(1, 50)
  tone?: string;
}

class GenerateTalkingPointsDto {
  @IsArray()
  @IsString({ each: true })
  insights!: string[];

  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsOptional()
  @IsString()
  additionalContext?: string;
}

/**
 * Optional per-item context object the v2 wizard sends. The shape mirrors
 * the wizard's `SelectedContextItem`: every item carries an explicit scope
 * (either 'all' for shared or a recipient key string for per-recipient
 * targeting) and a free-form note. The service may use these to build
 * recipient-specific prompts; older callers that send `insights[]` or
 * `additionalContext` continue to work unchanged.
 */
class OutreachSelectedContextItemDto {
  @IsString()
  id!: string;

  // MUST stay in sync with the frontend ContextKind union
  // (apps/web/src/pages/engagement/outreach/v2/types.ts). Saved meeting
  // debriefs are a selectable context source that sends kind:'debrief'; a kind
  // missing here makes forbidNonWhitelisted 400 the whole generate-batch and
  // the wizard silently falls back to placeholder drafts.
  @IsIn([
    'bill',
    'stateBill',
    'intel',
    'email',
    'meeting',
    'note',
    'document',
    'debrief',
    'prep',
    'programElement',
  ])
  kind!:
    | 'bill'
    | 'stateBill'
    | 'intel'
    | 'email'
    | 'meeting'
    | 'note'
    | 'document'
    | 'debrief'
    | 'prep'
    | 'programElement';

  @IsString()
  title!: string;

  @IsOptional()
  @IsString()
  body?: string;

  @IsString()
  scope!: 'all' | string;

  @IsOptional()
  @IsString()
  note?: string;
}

export class GenerateBatchEmailDto {
  @IsOptional()
  @IsUUID()
  campaignId?: string;

  /**
   * Phase 0 (§3.c1) — the OutreachRecord every generated version is filed under.
   *
   * Declared OPTIONAL at the DTO layer so the pre-Phase-0 wizard keeps working
   * with ENGAGEMENT_VERSIONED_OUTREACH=false; the SERVICE requires it (a typed
   * 400) whenever the flag is on. Making it structurally required here would 400
   * every legacy caller the moment this code deploys, before the flag flip.
   */
  @IsOptional()
  @IsUUID()
  outreachRecordId?: string;

  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsString()
  @MinLength(1)
  templateId!: string;

  @IsArray()
  // Bound the synchronous AI fan-out (A8). Each recipient is one billable AI
  // call; the sync path also runs under the ~180s ALB idle timeout, so >100 in a
  // single request would time out regardless. Background generation (W4) lifts
  // this. The message is surfaced to the wizard, so keep it actionable.
  @ArrayMaxSize(100, {
    message: 'Generate at most 100 recipients at a time — split the campaign into smaller batches.',
  })
  @ValidateNested({ each: true })
  @Type(() => OutreachRecipientDto)
  recipients!: OutreachRecipientDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  insights?: string[];

  @IsOptional()
  @IsString()
  additionalContext?: string;

  @IsOptional()
  @IsString()
  tone?: string;

  // ---- v2 wizard additions (additive, no breaking change for v1) ----
  @IsOptional()
  @IsIn(['on-behalf', 'to-clients'])
  direction?: 'on-behalf' | 'to-clients';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => OutreachSelectedContextItemDto)
  contextItems?: OutreachSelectedContextItemDto[];

  // 'group' → the single recipient represents a whole group getting ONE shared
  // email (collective salutation, no per-member tailoring). Absent = individual.
  @IsOptional()
  @IsIn(['individual', 'group'])
  audienceKind?: 'individual' | 'group';

  // ---- Revision ("Improve") mode: single-recipient edit-in-place ----
  @IsOptional()
  @IsString()
  @Length(0, 4000)
  existingSubject?: string;

  @IsOptional()
  @IsString()
  @Length(0, 40000)
  existingBody?: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  reviseInstruction?: string;
}

/**
 * Async generation-job submit (plan W4): the generate-batch payload + a
 * client-generated idempotency key. A retried POST with the same requestKey
 * returns the existing job (server dedup), so a flaky network never double-fans.
 */
export class OutreachGenerateJobDto extends GenerateBatchEmailDto {
  @IsString()
  @Length(8, 128)
  requestKey!: string;
}

/** Body for the "last contacted" badge lookup (W5.2). Cap matches the saved-audience
 *  member cap (CreateOutreachAudienceDto @ArrayMaxSize(500)), so applying a full
 *  audience in the Recipients step never 400s and silently drops badges. */
export class GetPriorContactDto {
  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsArray()
  @ArrayMaxSize(500)
  @IsEmail({}, { each: true })
  emails!: string[];
}

class SendBatchDraftDto {
  @IsString()
  @Length(1, 240)
  recipientId!: string;

  @IsString()
  @Length(0, 300)
  subject!: string;

  @IsString()
  @Length(0, 20000)
  body!: string;
}

class SendBatchEmailDto {
  @IsOptional()
  @IsUUID()
  clientId?: string;

  // When the wizard has already saved a draft, its record id rides along so the
  // send updates THAT record in place (draft → sent) instead of orphaning it.
  // Absent (sent without saving) → the service creates a fresh sent record so
  // every real send still lands in the Sent history.
  @IsOptional()
  @IsUUID()
  engagementId?: string;

  // Campaign name for the persisted Sent record's title (falls back to the
  // first draft subject). Purely cosmetic; the send itself doesn't need it.
  @IsOptional()
  @IsString()
  @MaxLength(240)
  campaignName?: string;

  @IsOptional()
  @IsIn(['on-behalf', 'to-clients'])
  direction?: 'on-behalf' | 'to-clients';

  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => OutreachRecipientDto)
  recipients!: OutreachRecipientDto[];

  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => SendBatchDraftDto)
  drafts!: SendBatchDraftDto[];

  @IsOptional()
  @IsBoolean()
  testMode?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(25)
  @IsUUID('4', { each: true })
  attachmentIds?: string[];

  @IsOptional()
  @IsBoolean()
  appendSignature?: boolean;

  // Which connected inbox to send from (IntegrationConnection id), chosen in
  // the wizard's sender-mailbox picker. Omitted → most recently connected inbox.
  @IsOptional()
  @IsUUID()
  senderConnectionId?: string;
}

/** Async send-job submit (plan W4.3): the send-batch payload + idempotency key. */
export class OutreachSendJobDto extends SendBatchEmailDto {
  @IsString()
  @Length(8, 128)
  requestKey!: string;
}

// ── Phase 0: immutable draft versions + durable send intents ─────────────────

/**
 * Append a new IMMUTABLE version of one draft slot (§3.c1).
 *
 * `baseVersionId` is the optimistic-concurrency token: the server refuses (409)
 * if it is no longer the artifact's current version, so two tabs cannot silently
 * overwrite each other.
 */
export class CreateDraftVersionDto {
  @IsUUID()
  baseVersionId!: string;

  @IsString()
  @Length(0, 300)
  subject!: string;

  @IsString()
  @Length(0, 40000)
  body!: string;

  @IsIn(['manual', 'improve', 'revert'])
  editKind!: 'manual' | 'improve' | 'revert';
}

/**
 * Create a durable send intent (§3.d2).
 *
 * Carries DRAFT VERSION IDS ONLY. There is deliberately no subject/body field:
 * the outbound text is read from the immutable audited version server-side, which
 * is what makes the raw-body bypass structurally impossible rather than merely
 * discouraged.
 */
export class CreateSendIntentDto {
  @IsUUID()
  outreachRecordId!: string;

  /** Client idempotency token, minted once per Send click and reused on retry. */
  @IsString()
  @Length(8, 128)
  requestKey!: string;

  /** Which connected inbox to send from. Required — never inferred for a real send. */
  @IsUUID()
  senderConnectionId!: string;

  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  draftVersionIds!: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(25)
  @IsUUID('4', { each: true })
  attachmentIds?: string[];

  @IsOptional()
  @IsBoolean()
  appendSignature?: boolean;

  /** Test send: one copy to the authenticated user; no real recipient rows. */
  @IsOptional()
  @IsBoolean()
  testMode?: boolean;
}

class CreateOutreachRecordDto {
  @IsIn(outreachTypes)
  type!: (typeof outreachTypes)[number];

  @IsOptional()
  @IsUUID()
  clientId?: string;

  @IsOptional()
  @IsUUID()
  meetingId?: string;

  @IsOptional()
  @IsIn(['on-behalf', 'to-clients'])
  direction?: 'on-behalf' | 'to-clients';

  @IsString()
  @Length(1, 240)
  title!: string;

  @IsOptional()
  @IsString()
  @Length(1, 300)
  subject?: string;

  @IsOptional()
  @IsString()
  body?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => OutreachRecipientDto)
  recipients?: OutreachRecipientDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => OutreachContextPoolItemDto)
  contextPool?: OutreachContextPoolItemDto[];

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(7)
  lastStep?: number;
}

class UpdateOutreachRecordDto {
  @IsOptional()
  @IsUUID()
  clientId?: string | null;

  @IsOptional()
  @IsUUID()
  meetingId?: string | null;

  @IsOptional()
  @IsIn(['on-behalf', 'to-clients'])
  direction?: 'on-behalf' | 'to-clients' | null;

  @IsOptional()
  @IsIn(outreachStatuses)
  status?: (typeof outreachStatuses)[number];

  @IsOptional()
  @IsString()
  @Length(1, 240)
  title?: string;

  @IsOptional()
  @IsString()
  @Length(1, 300)
  subject?: string | null;

  @IsOptional()
  @IsString()
  body?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => OutreachRecipientDto)
  recipients?: OutreachRecipientDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => OutreachContextPoolItemDto)
  contextPool?: OutreachContextPoolItemDto[];

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(7)
  lastStep?: number;
}

class GenerateOutreachDraftDto {
  @IsOptional()
  @IsString()
  objective?: string;

  @IsOptional()
  @IsIn(['on-behalf', 'to-clients'])
  direction?: 'on-behalf' | 'to-clients';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => OutreachRecipientDto)
  recipients?: OutreachRecipientDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => OutreachContextPoolItemDto)
  contextPool?: OutreachContextPoolItemDto[];

  @IsOptional()
  @IsIn(outreachPromptTemplates)
  promptTemplate?: (typeof outreachPromptTemplates)[number];

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

class ListContactsQueryDto {
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

@Controller('engagement')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class EngagementController {
  constructor(
    private readonly service: EngagementService,
    private readonly notetaker: NotetakerService,
    private readonly outreachJobs: OutreachJobService,
    private readonly drafts: OutreachDraftService,
    private readonly sendIntents: OutreachSendIntentService,
  ) {}

  @Get('capabilities')
  capabilities() {
    // Phase 0 §3.i1: the web app must know whether versioned outreach and the
    // v2 send gate are on, so it can pick the right send path. Booleans only —
    // no secrets, and the raw auditor mode is never exposed.
    return {
      ...this.service.capabilities(),
      ...this.service.engagementTrustBoundaryCapabilities(),
    };
  }

  // Tenant-wide CRM contact list for link pickers (e.g. linking an
  // acquisition-personnel record to a known contact from the Program Element
  // page). Declared as a static segment so it never collides with the dynamic
  // ':id' meeting/contact routes below.
  @Get('contacts')
  listContacts(@CurrentTenant() ctx: TenantContext, @Query() query: ListContactsQueryDto) {
    return this.service.listContacts(ctx, query);
  }

  @Get('integrations')
  @Roles('standard_user')
  integrations(@CurrentTenant() ctx: TenantContext) {
    return this.service.listIntegrations(ctx);
  }

  @Post('integrations')
  @Roles('standard_user')
  createIntegration(@CurrentTenant() ctx: TenantContext, @Body() body: CreateIntegrationDto) {
    return this.service.createIntegration(ctx, body);
  }

  @Get('meetings')
  meetings(
    @CurrentTenant() ctx: TenantContext,
    @Query('clientId') clientId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('recipientEmails') recipientEmails?: string,
  ) {
    return this.service.listMeetings(ctx, {
      clientId,
      from,
      to,
      recipientEmails: recipientEmails
        ? recipientEmails
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
    });
  }

  // Declared as a static segment BEFORE the dynamic ':id' route below so
  // 'library' is never captured as a meeting id (same ordering rule as
  // 'contacts' above).
  @Get('meetings/library')
  meetingLibrary(@CurrentTenant() ctx: TenantContext, @Query() query: MeetingLibraryQueryDto) {
    return this.service.listMeetingLibrary(ctx, query);
  }

  @Get('meetings/:id')
  meeting(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.getMeeting(ctx, id);
  }

  @Post('meetings')
  createMeeting(@CurrentTenant() ctx: TenantContext, @Body() body: CreateMeetingDto) {
    return this.service.createMeeting(ctx, body);
  }

  @Put('meetings/:id')
  updateMeeting(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: UpdateMeetingDto,
  ) {
    return this.service.updateMeeting(ctx, id, body);
  }

  // Private-until-shared (Meetings v2 §6). Share requires an associated client
  // (enforced in the service); the confirmation "what/where/who" is populated by
  // the client from the meeting payload before this is called.
  @Post('meetings/:id/share')
  shareMeeting(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.shareMeeting(ctx, id);
  }

  @Post('meetings/:id/unshare')
  unshareMeeting(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.unshareMeeting(ctx, id);
  }

  @Post('meetings/:id/notes')
  createNote(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') meetingId: string,
    @Body() body: CreateNoteDto,
  ) {
    return this.service.createMeetingNote(ctx, meetingId, body);
  }

  @Get('meetings/:id/notes')
  meetingNotes(@CurrentTenant() ctx: TenantContext, @Param('id') meetingId: string) {
    return this.service.listMeetingNotes(ctx, meetingId);
  }

  @Patch('meetings/:id/notes/:noteId')
  updateNote(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') meetingId: string,
    @Param('noteId') noteId: string,
    @Body() body: CreateNoteDto,
  ) {
    return this.service.updateMeetingNote(ctx, meetingId, noteId, body);
  }

  @Post('meetings/:id/debriefs')
  createDebrief(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') meetingId: string,
    @Body() body: CreateDebriefDto,
  ) {
    return this.service.createMeetingDebrief(ctx, meetingId, body);
  }

  @Get('meetings/:id/debriefs')
  meetingDebriefs(@CurrentTenant() ctx: TenantContext, @Param('id') meetingId: string) {
    return this.service.listMeetingDebriefs(ctx, meetingId);
  }

  @Patch('meetings/:id/debriefs/:debriefId')
  updateDebrief(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') meetingId: string,
    @Param('debriefId') debriefId: string,
    @Body() body: CreateDebriefDto,
  ) {
    return this.service.updateMeetingDebrief(ctx, meetingId, debriefId, body);
  }

  // Approve a debrief (Meetings v2 §6) — symmetric with meeting-preps/:id/approve.
  // Only an approved debrief reaches the Library / is shareable.
  @Post('meetings/:id/debriefs/:debriefId/approve')
  approveDebrief(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') meetingId: string,
    @Param('debriefId') debriefId: string,
  ) {
    return this.service.approveMeetingDebrief(ctx, meetingId, debriefId);
  }

  @Post('meetings/:id/debrief-draft')
  generateDebriefDraft(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') meetingId: string,
    @Body() body: GenerateDebriefDraftDto,
  ) {
    return this.service.generateMeetingDebriefDraft(ctx, meetingId, body);
  }

  @Post('meetings/:id/notetaker')
  dispatchNotetaker(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') meetingId: string,
    @Body() body: DispatchNotetakerDto,
  ) {
    return this.notetaker.dispatch(ctx, meetingId, body);
  }

  @Get('meetings/:id/notetaker')
  meetingNotetaker(@CurrentTenant() ctx: TenantContext, @Param('id') meetingId: string) {
    return this.notetaker.getSessionForMeeting(ctx, meetingId);
  }

  // Kill switch (plan §5 consent control): the bot leaves the call immediately.
  @Delete('meetings/:id/notetaker')
  removeNotetaker(@CurrentTenant() ctx: TenantContext, @Param('id') meetingId: string) {
    return this.notetaker.remove(ctx, meetingId);
  }

  @Post('meetings/:id/prep')
  generatePrep(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') meetingId: string,
    @Body() body: GenerateMeetingPrepDto,
  ) {
    return this.service.generateMeetingPrep(ctx, meetingId, body.additionalContext);
  }

  @Patch('meeting-preps/:id')
  updatePrep(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') prepId: string,
    @Body() body: UpdateMeetingPrepDto,
  ) {
    return this.service.updateMeetingPrep(ctx, prepId, body);
  }

  @Post('meeting-preps/:id/approve')
  approvePrep(@CurrentTenant() ctx: TenantContext, @Param('id') prepId: string) {
    return this.service.approveMeetingPrep(ctx, prepId);
  }

  @Get('mail-threads')
  mailThreads(
    @CurrentTenant() ctx: TenantContext,
    @Query('clientId') clientId?: string,
    @Query('recipientEmails') recipientEmails?: string,
  ) {
    return this.service.listMailThreads(ctx, {
      clientId,
      recipientEmails: recipientEmails
        ? recipientEmails
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
    });
  }

  @Get('debriefs')
  clientDebriefs(
    @CurrentTenant() ctx: TenantContext,
    @Query('clientId') clientId?: string,
    @Query('recipientEmails') recipientEmails?: string,
  ) {
    return this.service.listClientDebriefs(ctx, {
      clientId,
      recipientEmails: recipientEmails
        ? recipientEmails
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
    });
  }

  // Shared meeting records for a client's Documents tab (Meetings v2 §8). Tenant-
  // scoped (shared material is org-visible), NOT owner-scoped — mirrors the
  // client-scoped debriefs feed above. Query-param client scoping matches the
  // existing /engagement/attachments?clientId= and /engagement/debriefs?clientId= idiom.
  @Get('shared-meetings')
  sharedMeetings(@CurrentTenant() ctx: TenantContext, @Query('clientId') clientId: string) {
    return this.service.listSharedMeetingsForClient(ctx, clientId);
  }

  @Get('outreach')
  outreachRecords(
    @CurrentTenant() ctx: TenantContext,
    @Query('clientId') clientId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('type') type?: string,
    @Query('limit') limit?: string,
    @Query('deleted') deleted?: string,
  ) {
    return this.service.listOutreachRecords(ctx, {
      clientId,
      from,
      to,
      type,
      limit,
      deleted: deleted === 'true' || deleted === '1',
    });
  }

  @Get('outreach/outbound/contact-data')
  outboundCampaignContactData(
    @CurrentTenant() ctx: TenantContext,
    @Query('clientId') clientId?: string,
  ) {
    return this.service.outboundCampaignContactData(ctx, { clientId });
  }

  @Get('outreach/templates')
  outreachTemplates(@CurrentTenant() ctx: TenantContext, @Query('type') type?: string) {
    return this.service.listOutreachTemplates(ctx, { type });
  }

  @Post('outreach/templates')
  createOutreachTemplate(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: CreateOutreachTemplateDto,
  ) {
    return this.service.createOutreachTemplate(ctx, body);
  }

  @Get('outreach/ai-templates')
  listAiTemplates(@CurrentTenant() ctx: TenantContext) {
    return this.service.listAiTemplates(ctx);
  }

  @Post('outreach/ai-templates')
  createAiTemplate(@CurrentTenant() ctx: TenantContext, @Body() body: CreateAiTemplateDto) {
    return this.service.createAiTemplate(ctx, body);
  }

  @Put('outreach/ai-templates/:id')
  updateAiTemplate(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: UpdateAiTemplateDto,
  ) {
    return this.service.updateAiTemplate(ctx, id, body);
  }

  @Delete('outreach/ai-templates/:id')
  deleteAiTemplate(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.deleteAiTemplate(ctx, id);
  }

  // Live, billable AI call. Cap well below the global 600/min per-IP limit
  // (A7); the global 30/s `short` burst limit still applies unchanged.
  @Throttle({ long: { ttl: 60_000, limit: 30 } })
  @Get('outreach/ai-templates/:id/preview')
  previewAiTemplate(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.previewAiTemplate(ctx, id);
  }

  @Get('outreach/insights')
  outreachInsights(@CurrentTenant() ctx: TenantContext, @Query('clientId') clientId?: string) {
    return this.service.getOutreachInsights(ctx, { clientId });
  }

  // Billable AI call (A7). Cap below the global 600/min per-IP limit.
  @Throttle({ long: { ttl: 60_000, limit: 40 } })
  @Post('outreach/insights/talking-points')
  generateTalkingPoints(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: GenerateTalkingPointsDto,
  ) {
    return this.service.generateTalkingPoints(ctx, body);
  }

  // The most expensive endpoint: fans out one AI call per recipient (up to 100).
  // Cap at 120/min per IP (A7) — an order of magnitude below the global 600/min,
  // but with headroom for a many-group campaign: one "Generate" click costs
  // (1 flat chunk + N group) parallel POSTs, and a regenerate-all repeats them.
  // Only the per-minute window is overridden — the 30/s `short` limit is left
  // intact so those near-simultaneous POSTs are not falsely rejected.
  @Throttle({ long: { ttl: 60_000, limit: 120 } })
  @Post('outreach/generate-batch')
  generateBatchEmails(@CurrentTenant() ctx: TenantContext, @Body() body: GenerateBatchEmailDto) {
    return this.service.generateBatchEmails(ctx, body);
  }

  @Post('outreach/send-batch')
  sendBatchEmails(@CurrentTenant() ctx: TenantContext, @Body() body: SendBatchEmailDto) {
    return this.service.sendBatchEmails(ctx, body);
  }

  // "Last contacted Nd ago" badge lookup for the Recipients step (W5.2). Cheap
  // read (no AI), so no @Throttle override — same class as outreach-insights.
  @Post('outreach/prior-contact')
  getPriorContact(@CurrentTenant() ctx: TenantContext, @Body() body: GetPriorContactDto) {
    return this.service.getRecipientPriorContact(ctx, body);
  }

  // Async generation job (plan W4): returns 202 + jobId in ms; the claim-sweep
  // worker drafts off the request path. Gated on OUTREACH_ASYNC_GEN so the sync
  // generate-batch above stays the path until the async flag is flipped on.
  @Throttle({ long: { ttl: 60_000, limit: 120 } })
  @Post('outreach/jobs/generate')
  async submitGenerateJob(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: OutreachGenerateJobDto,
  ) {
    if (!this.outreachJobs.asyncEnabled('generate')) {
      throw new BadRequestException('Async outreach generation is not enabled in this environment');
    }
    const { requestKey, recipients, ...params } = body;
    return this.outreachJobs.submit(ctx, {
      requestKey,
      kind: 'generate',
      params: params as Record<string, unknown>,
      recipients: (recipients ?? []) as Array<Record<string, unknown>>,
    });
  }

  // Async send job (plan W4.3): at-most-once, idempotent on requestKey. Each
  // draft is merged into its recipient to form the per-item send payload. Gated
  // on OUTREACH_ASYNC_SEND (sync send-batch stays the path until flipped).
  @Post('outreach/jobs/send')
  async submitSendJob(@CurrentTenant() ctx: TenantContext, @Body() body: OutreachSendJobDto) {
    if (!this.outreachJobs.asyncEnabled('send')) {
      throw new BadRequestException('Async outreach send is not enabled in this environment');
    }
    const { requestKey, recipients, drafts, ...params } = body;
    const draftByKey = new Map(drafts.map((d) => [d.recipientId, d]));
    // One item per recipient that has a matching draft; the draft's subject/body
    // ride in the item payload alongside the recipient fields.
    const items = (recipients ?? [])
      .map((r, i): Record<string, unknown> | null => {
        const key = outreachRecipientKey(r as unknown as Record<string, unknown>, i);
        const draft = draftByKey.get(key);
        if (!draft) return null;
        return {
          ...(r as unknown as Record<string, unknown>),
          subject: draft.subject,
          body: draft.body,
        };
      })
      .filter((x): x is Record<string, unknown> => x !== null);
    return this.outreachJobs.submit(ctx, {
      requestKey,
      kind: 'send',
      params: params as Record<string, unknown>,
      recipients: items,
    });
  }

  @Get('outreach/jobs/:id')
  async getOutreachJob(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    const job = await this.outreachJobs.getJob(ctx, id);
    if (!job) throw new NotFoundException('Outreach job not found');
    return job;
  }

  @Post('outreach/jobs/:id/cancel')
  cancelOutreachJob(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.outreachJobs.cancelJob(ctx, id);
  }

  // Retry ONE failed generation item (plan W4.4) without resubmitting the whole
  // batch. Gated the same way as generate-job submission.
  @Post('outreach/jobs/:id/items/:itemId/retry')
  retryOutreachJobItem(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
  ) {
    if (!this.outreachJobs.asyncEnabled('generate')) {
      throw new BadRequestException('Async outreach generation is not enabled in this environment');
    }
    return this.outreachJobs.retryItem(ctx, id, itemId);
  }

  // ── Phase 0: immutable draft versions ──────────────────────────────────────
  // All declared BEFORE 'outreach/:id' so the dynamic route cannot swallow
  // 'draft-artifacts' / 'draft-versions' / 'send-intents' as record ids.

  /** Every draft slot for one outreach record, with its current version. */
  @Get('outreach/:outreachRecordId/draft-artifacts')
  listDraftArtifacts(
    @CurrentTenant() ctx: TenantContext,
    @Param('outreachRecordId') outreachRecordId: string,
  ) {
    return this.drafts.listForOutreach(ctx, outreachRecordId);
  }

  /**
   * Append a new immutable version (manual edit / Improve / Revert).
   *
   * Throttled like the other write endpoints: this can trigger an AUDIT but never
   * a new drafting LLM call, so it does not need the tight generate-batch budget —
   * and autosave means a user legitimately produces a steady trickle of these.
   */
  @Throttle({ long: { ttl: 60_000, limit: 240 } })
  @Post('outreach/draft-artifacts/:artifactId/versions')
  createDraftVersion(
    @CurrentTenant() ctx: TenantContext,
    @Param('artifactId') artifactId: string,
    @Body() body: CreateDraftVersionDto,
  ) {
    return this.drafts.createEditedVersion(ctx, artifactId, body);
  }

  /** One immutable version, owner-scoped. */
  @Get('outreach/draft-versions/:versionId')
  getDraftVersion(@CurrentTenant() ctx: TenantContext, @Param('versionId') versionId: string) {
    return this.drafts.getVersion(ctx, versionId);
  }

  // ── Phase 0: durable send intents ──────────────────────────────────────────

  /**
   * Create a durable send intent. The intent and every delivery row are committed
   * BEFORE any provider request; the worker then delivers at-most-once.
   */
  @Post('outreach/send-intents')
  createSendIntent(@CurrentTenant() ctx: TenantContext, @Body() body: CreateSendIntentDto) {
    return this.sendIntents.createIntent(ctx, body);
  }

  @Get('outreach/send-intents/:id')
  getSendIntent(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.sendIntents.getIntent(ctx, id);
  }

  /**
   * Cancel what has not left yet. Pending deliveries become skipped; a delivery
   * already in flight is NOT cancelled (we will not claim success for a message
   * that may already have been delivered) and is reported back in `inFlight`.
   */
  @Post('outreach/send-intents/:id/cancel')
  cancelSendIntent(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.sendIntents.cancelIntent(ctx, id);
  }

  // Tenant-wide context library for the Build Context step (docs/notes, debriefs,
  // preps grouped by client). Declared before 'outreach/:id' so the dynamic route
  // doesn't swallow 'context-library' as an id.
  @Get('outreach/context-library')
  outreachContextLibrary(@CurrentTenant() ctx: TenantContext) {
    return this.service.buildOutreachContextLibrary(ctx);
  }

  // Saved audiences must be declared BEFORE 'outreach/:id' or the dynamic
  // route would swallow 'audiences' as an id.
  @Get('outreach/audiences')
  listOutreachAudiences(
    @CurrentTenant() ctx: TenantContext,
    @Query() query: ListOutreachAudiencesQueryDto,
  ) {
    return this.service.listOutreachAudiences(ctx, query.kind);
  }

  @Post('outreach/audiences')
  createOutreachAudience(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: CreateOutreachAudienceDto,
  ) {
    return this.service.createOutreachAudience(ctx, body);
  }

  @Get('outreach/:id')
  outreachRecord(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.getOutreachRecord(ctx, id);
  }

  @Post('outreach')
  createOutreachRecord(@CurrentTenant() ctx: TenantContext, @Body() body: CreateOutreachRecordDto) {
    return this.service.createOutreachRecord(ctx, body);
  }

  @Patch('outreach/:id')
  updateOutreachRecord(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: UpdateOutreachRecordDto,
  ) {
    return this.service.updateOutreachRecord(ctx, id, body);
  }

  // Single-record AI regeneration (billable). Cap below the global per-IP limit (A7).
  @Throttle({ long: { ttl: 60_000, limit: 40 } })
  @Post('outreach/:id/generate-draft')
  generateOutreachDraft(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: GenerateOutreachDraftDto,
  ) {
    return this.service.generateOutreachDraft(ctx, id, body);
  }

  @Post('outreach/:id/open-email')
  openOutreachEmail(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.openOutreachInConnectedEmail(ctx, id);
  }

  @Post('outreach/:id/send-campaign')
  sendCampaign(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.sendCampaign(ctx, id);
  }

  @Delete('outreach/:id')
  deleteOutreachRecord(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.deleteOutreachRecord(ctx, id);
  }

  @Post('outreach/:id/restore')
  restoreOutreachRecord(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.restoreOutreachRecord(ctx, id);
  }

  @Get('reports/overview')
  reportOverview(
    @CurrentTenant() ctx: TenantContext,
    @Query('clientId') clientId?: string,
    @Query('period') period?: string,
  ) {
    return this.service.reportOverview(ctx, { clientId, period });
  }

  @Post('reports/target-offices')
  createReportTargetOffice(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: CreateReportTargetOfficeDto,
  ) {
    return this.service.createReportTargetOffice(ctx, body);
  }

  @Post('reports/target-offices/overrides')
  upsertReportTargetOffice(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: UpsertReportTargetOfficeDto,
  ) {
    return this.service.upsertReportTargetOffice(ctx, body);
  }

  @Get('tasks')
  tasks(@CurrentTenant() ctx: TenantContext, @Query('clientId') clientId?: string) {
    return this.service.listTasks(ctx, { clientId });
  }

  @Post('tasks')
  createTask(@CurrentTenant() ctx: TenantContext, @Body() body: CreateTaskDto) {
    return this.service.createTask(ctx, body);
  }

  @Patch('tasks/:id')
  updateTask(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: UpdateTaskDto,
  ) {
    return this.service.updateTask(ctx, id, body);
  }

  @Post('associations/override')
  overrideAssociation(@CurrentTenant() ctx: TenantContext, @Body() body: AssociationOverrideDto) {
    return this.service.overrideAssociation(ctx, body);
  }

  @Get('context/:clientId')
  clientContext(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.clientContext(ctx, clientId);
  }

  @Post('attachments/upload-url')
  createAttachmentUploadUrl(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: AttachmentUploadDto,
  ) {
    return this.service.createAttachmentUploadUrl(ctx, body);
  }

  @Post('attachments/confirm')
  confirmAttachment(@CurrentTenant() ctx: TenantContext, @Body() body: ConfirmAttachmentDto) {
    return this.service.confirmAttachment(ctx, body);
  }

  @Get('attachments')
  attachments(
    @CurrentTenant() ctx: TenantContext,
    @Query('clientId') clientId?: string,
    @Query('meetingId') meetingId?: string,
    @Query('mailMessageId') mailMessageId?: string,
    @Query('unlinked') unlinked?: string,
  ) {
    return this.service.listAttachments(ctx, {
      clientId,
      meetingId,
      mailMessageId,
      // General (client-free) outreach library: files with no parent entity.
      unlinked: unlinked === 'true' || unlinked === '1',
    });
  }

  @Post('attachments/:id/extract-text')
  extractAttachmentText(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.extractAttachmentText(ctx, id);
  }

  @Delete('attachments/:id')
  deleteAttachment(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.deleteAttachment(ctx, id);
  }

  @Get('campaigns')
  listCampaigns(
    @CurrentTenant() ctx: TenantContext,
    @Query('clientId') clientId?: string,
    @Query('status') status?: string,
  ) {
    return this.service.listCampaigns(ctx, { clientId, status });
  }

  @Post('campaigns')
  createCampaign(@CurrentTenant() ctx: TenantContext, @Body() body: CreateCampaignDto) {
    return this.service.createCampaign(ctx, body);
  }

  @Get('campaigns/:id')
  getCampaign(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.getCampaign(ctx, id);
  }

  @Patch('campaigns/:id')
  updateCampaign(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: UpdateCampaignDto,
  ) {
    return this.service.updateCampaign(ctx, id, body);
  }

  @Delete('campaigns/:id')
  deleteCampaign(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.deleteCampaign(ctx, id);
  }

  @Post('campaigns/:id/recipients')
  addCampaignRecipients(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: AddCampaignRecipientsDto,
  ) {
    return this.service.addCampaignRecipients(ctx, id, body.recipients);
  }

  @Delete('campaigns/:id/recipients/:recipientId')
  removeCampaignRecipient(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('recipientId') recipientId: string,
  ) {
    return this.service.removeCampaignRecipient(ctx, id, recipientId);
  }

  @Post('campaigns/:id/generate')
  generateCampaignEmail(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: GenerateCampaignEmailDto,
  ) {
    return this.service.generateCampaignEmail(ctx, id, body);
  }

  @Post('campaigns/:id/send')
  sendCampaignEmails(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.sendCampaignEmails(ctx, id);
  }

  @Post('campaigns/:id/send-test')
  sendCampaignTest(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.sendCampaignTest(ctx, id);
  }
}
