import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  AssociationEntityType,
  EngagementConnectionStatus,
  EngagementProvider,
  EngagementSource,
  EngagementTaskStatus,
  MeetingDebriefStatus,
  MeetingPrepStatus,
  MeetingVisibility,
  Prisma,
} from '@prisma/client';
import mammoth from 'mammoth';
import { sanitizeSignatureHtml } from '../common/sanitize-signature.js';
import { meetingsCrossUserEnabled } from '../common/tenant-flags.js';
import { extractXlsxText, isSpreadsheetAttachment } from './xlsx-extract.js';
import { extractPptxText, isPowerPointAttachment } from './pptx-extract.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  recordAiUsageEvent,
  deriveMeetingVirtuality,
  billStatusLabel,
  currentCycleFyOf,
  DELIVERABLE_RISK_TIERS,
  type AiGenerationUsageLike,
  type TenantContext,
} from '@capiro/shared';
import {
  outreachDraftHoldKey,
  OUTREACH_HOLD_BLOCKING_STATUSES,
  OUTREACH_HOLD_SUBJECT_TYPE,
} from './outreach-hold.js';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DirectoryService, type DirectoryEmailMatch } from '../directory/directory.service.js';
import type { OfficeRecommendation } from '../intelligence/office-recommender.service.js';
import { LobbyIntelService } from '../lobby-intel/lobby-intel.service.js';
import { FederalSpendingService } from '../federal-spending/federal-spending.service.js';
import { ClientAssociationService } from './client-association.service.js';
import { EngagementAiService } from './engagement-ai.service.js';
// #403 outreach gap-closure: credential-resolver type. recordAiUsageEvent +
// AiGenerationUsageLike are imported from @capiro/shared above (Phase-1 M5.0
// lift out of the now-deleted ./ai-usage-record.js), so #403's local import of
// them is intentionally dropped here — same symbols, one source.
import type { ResolvedAiCredential } from './ai-credential-resolver.service.js';
import {
  appendOutreachSignature,
  renderOutreachBody,
  type RenderedOutreachBody,
} from './outreach-email-renderer.js';
import { MeetingNotesCryptoService } from './meeting-notes-crypto.service.js';
import { EngagementMailSender } from './mail-sender.service.js';
import { ClientKbService } from '../embeddings/client-kb.service.js';
import { ContextCompilerService } from '../context/context-compiler.service.js';
import { editRatio } from '../common/text-distance.js';
import {
  billIdFromItemId,
  peCodeFromItemId,
  formatBillTruth,
  formatPeTruth,
  renderClientRelationshipSnapshot,
  renderClientPeopleRoster,
  renderClientTargetOffices,
  type BillTruth,
  type PeTruth,
  type BillVoteRow,
  type GoverningRuleRow,
  type PeYearFunding,
  type TargetOfficeLite,
} from './outreach-context-enrichment.js';
import { outreachClientProfileEnabled } from '../common/tenant-flags.js';
// Wave-2 post-hoc grounding auditor (dark/shadow by default via MERI_AUDITOR_MODE):
// extends the same deterministic post-generation check to the outreach batch
// drafter, re-deriving ground truth from the same PE/bill truth blocks already
// built for the prompt (see enrichOutreachContextItems below).
import { runAuditor, type LedgerEntry } from '@capiro/meriv2-core';
import { resolveTenantAuditorMode } from '../common/auditor-mode.js';

export interface CreateIntegrationInput {
  provider: EngagementProvider;
  accountEmail?: string;
  displayName?: string;
}

export interface MeetingAttendeeInput {
  email?: string;
  name?: string;
  role?: string;
  responseStatus?: string;
}

export interface CreateMeetingInput {
  clientId?: string;
  subject: string;
  description?: string;
  location?: string;
  startsAt: string;
  endsAt: string;
  organizerEmail?: string;
  organizerName?: string;
  attendees?: MeetingAttendeeInput[];
}

export interface UpdateMeetingInput {
  clientId?: string | null;
  subject?: string;
  description?: string | null;
  location?: string | null;
  startsAt?: string;
  endsAt?: string;
  status?: string;
}

export interface CreateTaskInput {
  clientId?: string;
  meetingId?: string;
  contactId?: string;
  mailThreadId?: string;
  title: string;
  description?: string;
  ownerUserId?: string;
  dueDate?: string;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string | null;
  ownerUserId?: string | null;
  dueDate?: string | null;
  status?: EngagementTaskStatus;
}

export interface UpdateMeetingPrepInput {
  summary?: string | null;
  agenda?: string[];
  talkingPoints?: string[];
  risks?: string[];
  followUps?: string[];
  emailEvidence?: string[];
}

export interface AssociationOverrideInput {
  entityType: AssociationEntityType;
  entityId: string;
  clientId?: string;
  /** Meetings only: mark internal (no client) and stop the sync from re-linking. */
  internal?: boolean;
  reason?: string;
}

export interface AttachmentUploadInput {
  clientId?: string;
  meetingId?: string;
  mailMessageId?: string;
  fileName: string;
  contentType: string;
  contentLength: number;
}

export interface ConfirmAttachmentInput {
  clientId?: string;
  meetingId?: string;
  mailMessageId?: string;
  fileName: string;
  contentType: string;
  s3Key: string;
  checksumSha256?: string;
  source?: string;
}

export interface EngagementReportQuery {
  clientId?: string;
  period?: string;
}

export interface CreateReportTargetOfficeInput {
  clientId?: string | null;
  memberPrincipal: string;
  committee?: string | null;
  staffer?: string | null;
  building?: string | null;
  leadOwner?: string | null;
}

export interface UpsertReportTargetOfficeInput extends CreateReportTargetOfficeInput {
  officeKey: string;
  prepStatus?: ReportStatus;
  outreachStatus?: ReportStatus;
  submissionStatus?: ReportStatus;
  source?: string;
}

export type ReportPeriod = 'current' | 'previous' | 'all';
export type ReportStatus = 'auto' | 'not_started' | 'in_progress' | 'complete';
export type OutreachType = 'campaign' | 'follow_up' | 'prep' | 'outbound_campaign';
export type OutreachStatus = 'draft' | 'sent' | 'opened_in_email' | 'failed';

export interface OutreachContextPoolItemInput {
  id?: string;
  sourceType?: string;
  title?: string;
  summary?: string;
  note?: string;
  scope?: string;
  recipientIds?: string[];
  matches?: string[];
}

export interface OutreachRecipientInput {
  id?: string;
  clientId?: string;
  direction?: 'on-behalf' | 'to-clients';
  name?: string;
  email?: string;
  office?: string;
  title?: string;
  chamber?: string;
  state?: string;
  district?: string;
  party?: string;
  directoryContactId?: string;
  directoryContactName?: string;
  committee?: string;
  address?: string;
  relevanceReason?: string;
  personalNote?: string;
  /** Additional Cc / Bcc email addresses copied on this recipient's email. */
  cc?: string[];
  bcc?: string[];
  /**
   * Group representative ONLY: every member to place in the To field. When
   * present, this recipient is sent as ONE shared email to all groupMembers
   * (not one email each).
   */
  groupMembers?: Array<{ email: string; name?: string }>;
  meetingId?: string;
  meetingSubject?: string;
  meetingDateTime?: string;
  attendeeNames?: string;
  attendeeEmails?: string;
  prepSummary?: string;
  debriefSummary?: string;
  meetingLocation?: string;
}

export interface CreateOutreachTemplateInput {
  name: string;
  subject?: string;
  body: string;
}

export interface CreateAiTemplateInput {
  name: string;
  category?: string;
  prompt: string;
  description?: string;
  tone?: string;
}

export interface UpdateAiTemplateInput {
  name?: string;
  category?: string;
  prompt?: string;
  description?: string;
  tone?: string;
}

/** v2 wizard's per-item scoped context object. */
export interface OutreachSelectedContextItemInput {
  id: string;
  kind:
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
  title: string;
  body?: string;
  /** 'all' = shared across every recipient; else recipient-key string. */
  scope: 'all' | string;
  note?: string;
}

/**
 * The RAW structured PeTruth/BillTruth behind an enriched context item's
 * rendered text (see enrichOutreachContextItems), keyed by context-item id.
 * Consumed only by the post-hoc grounding auditor to build ground-truth
 * LedgerEntrys — never rendered into a prompt itself (formatBillTruth /
 * formatPeTruth already own that).
 */
export type OutreachContextTruth =
  | { kind: 'bill'; raw: BillTruth }
  | { kind: 'programElement'; raw: PeTruth };

export interface GenerateBatchEmailInput {
  campaignId?: string;
  clientId?: string;
  templateId: string;
  recipients: OutreachRecipientInput[];
  insights?: string[];
  additionalContext?: string;
  tone?: string;
  // v2 wizard additions, older callers that omit these are unaffected.
  direction?: 'on-behalf' | 'to-clients';
  contextItems?: OutreachSelectedContextItemInput[];
  /**
   * Audience shape for this batch. The v2 wizard sends 'group' when the single
   * supplied recipient represents a whole group that gets ONE shared email — the
   * draft must then use a collective salutation and drop per-member tailoring.
   * Absent/'individual' preserves the existing per-recipient behavior.
   */
  audienceKind?: 'individual' | 'group';
  /**
   * Revision ("Improve") mode. When `existingBody` is present on a SINGLE-recipient
   * batch, the draft is edited in place per `reviseInstruction` (change nothing
   * else) instead of written from scratch — PromptSpec v2 revision mode.
   */
  existingSubject?: string;
  existingBody?: string;
  reviseInstruction?: string;
}

/**
 * One per-recipient result from {@link EngagementService.generateBatchEmails}.
 * `status` is the AUTHORITATIVE sendability signal — callers MUST gate on
 * `status === 'error'`, never on subject/body emptiness (a same-batch generation
 * failure returns empty strings tagged `error`; a legitimately short draft is not
 * an error). This mirrors the frontend WizardV2State.generatedEmails[key].status
 * vocabulary ('ready'|'error') so it forwards to the wizard with zero translation.
 * It is a distinct concept from OutreachRecord.status (campaign-record lifecycle)
 * and EngagementCampaignRecipient.status (legacy) — do not conflate.
 */
export interface OutreachBatchDraftResult {
  recipientId: string;
  subject: string;
  body: string;
  /**
   * 'ready' = sendable; 'error' = generation failed (empty body); 'held' = the
   * post-hoc auditor HELD this draft (enforce mode + a grounding finding) — it
   * is shown for review with `contextNote` but the wizard must treat it as
   * NON-sendable, same as 'error', until a reviewer clears it. 'held' only ever
   * occurs under MERI_AUDITOR_MODE=enforce; shadow/annotate never produce it.
   */
  status: 'ready' | 'error' | 'held';
  /** Failure detail for telemetry/logs ONLY — never surface raw to end users. */
  error?: string;
  /**
   * Internal note for the lobbyist ONLY — never sent to the recipient, never
   * appended to `body`/`subject`. Present only when the post-hoc grounding
   * auditor (MERI_AUDITOR_MODE=annotate|enforce) held findings on this draft;
   * absent in shadow/off mode (i.e. absent by default). See runAuditor wiring
   * in generateBatchEmails.
   */
  contextNote?: string;
}

export interface GenerateTalkingPointsInput {
  insights: string[];
  clientId?: string;
  additionalContext?: string;
}

/** Per-recipient drafted email the v2 wizard sends to the batch sender. */
export interface SendBatchDraftInput {
  recipientId: string;
  subject: string;
  body: string;
}

export interface SendBatchEmailInput {
  clientId?: string;
  /**
   * Existing draft record id to mark as sent. When present the send updates
   * that record in place (draft → sent/failed); when absent a fresh sent
   * record is created so every real send shows up in the Sent history.
   */
  engagementId?: string;
  /** Campaign name used for the persisted Sent record's title. */
  campaignName?: string;
  direction?: 'on-behalf' | 'to-clients';
  recipients: OutreachRecipientInput[];
  drafts: SendBatchDraftInput[];
  /** When true, send a single test copy to the logged-in user instead. */
  testMode?: boolean;
  /** EngagementAttachment ids to attach to every sent email. */
  attachmentIds?: string[];
  /**
   * Append the sender's saved email signature to every email. When omitted,
   * falls back to the sender's append-by-default preference
   * (User.emailSignatureEnabled).
   */
  appendSignature?: boolean;
  /**
   * Which connected inbox to send from (IntegrationConnection id). Chosen by
   * the user in the wizard's sender-mailbox picker. When omitted, the most
   * recently connected inbox (Outlook or Gmail) is used.
   */
  senderConnectionId?: string;
}

export interface CreateOutreachRecordInput {
  type: OutreachType;
  clientId?: string;
  meetingId?: string;
  direction?: 'on-behalf' | 'to-clients';
  title: string;
  subject?: string;
  body?: string;
  recipients?: OutreachRecipientInput[];
  contextPool?: OutreachContextPoolItemInput[];
  metadata?: Record<string, unknown>;
  lastStep?: number;
}

export interface UpdateOutreachRecordInput {
  clientId?: string | null;
  meetingId?: string | null;
  direction?: 'on-behalf' | 'to-clients' | null;
  status?: OutreachStatus;
  title?: string;
  subject?: string | null;
  body?: string | null;
  recipients?: OutreachRecipientInput[];
  contextPool?: OutreachContextPoolItemInput[];
  metadata?: Record<string, unknown>;
  lastStep?: number;
}

export interface OutreachQuery {
  clientId?: string;
  from?: string;
  to?: string;
  type?: string;
  limit?: string;
  // When true, return ONLY soft-deleted records (the "trash"/recovery view).
  // Defaults to false: the normal list excludes deleted records.
  deleted?: boolean;
}

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// Engagement attachment uploads: the union of what the advertised upload flows
// send — client Documents + capability Documents ("PDF, DOC(X), PPT(X), XLS(X),
// CSV, TXT, images") plus the meeting debrief/transcript flow (.txt/.docx/audio/
// video + in-app voice recordings), which shares these endpoints. Notably
// EXCLUDES application/octet-stream (the FE fallback for unknown drag-dropped
// types), so unsupported files fail fast with a clear message instead of landing
// as un-openable blobs.
const ALLOWED_ATTACHMENT_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  // PowerPoint (.ppt / .pptx) — capability + client Documents advertise these.
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Excel (.xls / .xlsx) and CSV — spreadsheets are common client deliverables.
  // Note: some browsers report .csv as application/vnd.ms-excel, which this set
  // also covers.
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'text/plain',
]);
const ALLOWED_ATTACHMENT_MIME_PREFIXES = ['image/', 'audio/', 'video/'];
// SVG is scriptable: a stored image/svg+xml replays from S3 with its declared
// Content-Type and would execute embedded <script> when opened inline, so it
// is excluded despite matching the image/ prefix.
const BLOCKED_ATTACHMENT_MIME = new Set(['image/svg+xml']);
export const ALLOWED_ATTACHMENT_TYPES_LABEL =
  'PDF, DOC(X), PPT(X), XLS(X), CSV, TXT, images, audio, or video';

export function isAllowedAttachmentContentType(contentType: string): boolean {
  const normalized = contentType.trim().toLowerCase();
  // Compare the MIME *essence* (type/subtype without ;charset= or other params).
  // Browsers routinely append parameters (e.g. "image/svg+xml; charset=utf-8"),
  // and an exact-match block-list check would miss those — letting a scriptable
  // SVG through on the image/ prefix. Strip params before BOTH the block and the
  // allow checks so the decision can't be evaded with a trailing parameter.
  const essence = normalized.split(';')[0]!.trim();
  if (BLOCKED_ATTACHMENT_MIME.has(essence)) return false;
  return (
    ALLOWED_ATTACHMENT_MIME.has(essence) ||
    ALLOWED_ATTACHMENT_MIME_PREFIXES.some((prefix) => essence.startsWith(prefix))
  );
}
const REPORT_STATUSES: ReportStatus[] = ['auto', 'not_started', 'in_progress', 'complete'];

/** AiUsageEvent workflows counted against the daily outreach token budget (W3.4). */
const OUTREACH_BUDGET_WORKFLOWS = [
  'outreach_campaign',
  'outreach_draft',
  'template_preview',
  'campaign_email',
] as const;
const OUTBOUND_CAMPAIGN_VARIABLES = [
  'current_date_time',
  'attendee_names',
  'attendee_emails',
  'prep_summary',
  'debrief_summary',
  'meeting_location',
  'meeting_subject',
  'meeting_date_time',
] as const;

interface ReportTargetDraft {
  targetId: string | null;
  clientId: string | null;
  clientName: string | null;
  scopeKey: string;
  officeKey: string;
  memberPrincipal: string;
  committee: string | null;
  staffer: string | null;
  building: string | null;
  leadOwner: string | null;
  source: string;
  storedPrepStatus: ReportStatus;
  storedOutreachStatus: ReportStatus;
  storedSubmissionStatus: ReportStatus;
  meetingIds: Set<string>;
  heldMeetingIds: Set<string>;
  preparedMeetingIds: Set<string>;
  approvedPrepMeetingIds: Set<string>;
  meetings: Map<
    string,
    {
      id: string;
      subject: string;
      startsAt: Date;
      endsAt: Date;
      location: string | null;
      externalUrl: string | null;
    }
  >;
  threadIds: Set<string>;
  sentMessageIds: Set<string>;
  pendingActionIds: Set<string>;
}

// System outreach templates. Each `prompt` is injected as the generation
// `objective` and runs through the existing per-recipient pipeline
// (generate-batch -> generateOutreachDraft -> { subject, body }). The body
// carries the work product as Markdown; for the memo/brief templates that is a
// structured document, for the message templates it is a short email. Every
// prompt bakes in the senior-government-affairs voice and the anti-fabrication
// rules so it stays grounded in the selected context, and avoids literal
// [bracket] tokens (the outreach pipeline rejects unresolved placeholders).
const SYSTEM_AI_TEMPLATES = [
  {
    id: 'system-outreach-message',
    source: 'system' as const,
    name: 'Outreach Message',
    category: 'outreach',
    prompt:
      'Draft a short, polished outreach message to this recipient on behalf of the client. Sound like a real government affairs operator wrote it — direct, human, specific; use em dashes where natural and never open with "Dear". Set a concrete subject line (no "re:" padding). Body under 175 words: open with a natural greeting using the recipient\'s real first name; one sentence on why you are reaching out; one short paragraph tying the client\'s issue to this recipient\'s committee, district/state, agency role, or prior work from the selected context; one specific ask; an offer of helpful follow-up or materials; end with a brief closing line (do not sign a name — the app appends the sender\'s signature separately). Do not overstate the relationship, do not claim the recipient supports anything unless the context proves it, and do not invent facts.',
    description: 'Short, personalized Hill or client message — direct, specific, one clear ask.',
    samplePreview:
      "Subject: FY27 follow-up on directed-energy funding\n\nHi Dana —\n\nFollowing your subcommittee's markup last week, I wanted to flag where our client's work lines up with the committee's directed-energy priorities. They build the beam-control subsystem fielded on two of the programs the mark funds and can turn around test data on short notice.\n\nWould you have 20 minutes in the next two weeks for a short briefing? I'm happy to send a one-pager ahead of time so the conversation is efficient.\n\nThanks for considering it —",
    tone: 'professional',
    usageCount: 0,
  },
  {
    id: 'system-policy-update',
    source: 'system' as const,
    name: 'Policy Update',
    category: 'policy',
    prompt:
      'Write a policy update for a government affairs audience (client or internal team), delivered as an email. Subject: the issue name plus a short hook. Body in skimmable Markdown, grounded only in the supplied client and selected context — do not invent legislation, votes, funding levels, or quotes, and if the context is thin say what is missing. Include only the sections the context supports: **Bottom line** (what happened, why it matters, what the client should do); **What changed** (date, actor, action, procedural status, what is new, what is unresolved); **Why it matters** (direct vs indirect vs political vs funding vs timing impact on the client); **Who is driving this** (relevant members, committees, agencies, coalitions, opponents — and why each matters); **Political read** (momentum, support, opposition, likelihood of movement — do not overstate certainty); **Client implications** (Opportunity / Risk / Watch item / Recommended posture); **Recommended action** (specific next steps); **What we still need to know**.',
    description: 'Timely update on a bill, rule, or development — what changed and what to do.',
    samplePreview:
      '## Bottom line\nThe HAC-D mark restored full program funding, but new report language adds a quarterly reporting requirement. Recommend briefing the client this week and prepping the first report early.\n\n## What changed\nOn June 12 the House defense appropriators reported their FY27 bill, reversing the requested $180M cut and directing quarterly schedule updates to the committee.\n\n## Why it matters\nNear-term funding risk is off the table, but the reporting mandate is a recurring obligation — and a recurring reason to stay in front of staff.\n\n## Recommended action\nBrief the client, draft the first quarterly-update template, and request a staff meeting before full-committee markup.',
    tone: 'professional',
    usageCount: 0,
  },
  {
    id: 'system-client-memo',
    source: 'system' as const,
    name: 'Client Memo',
    category: 'memo',
    prompt:
      'Write a polished client memo, delivered as an email a client could read directly. Subject: a clear memo title. Body in Markdown, grounded only in the supplied client and selected context with no invented facts. Sections: **Bottom line** (the practical takeaway up top — do not bury the lead); **Situation** (what is happening, concise); **Why it matters** (tie to the client\'s business, policy, funding, regulatory, or reputational interests); **Analysis** (key stakeholders, political dynamics, process timing, risks, opportunities); **Recommendation** (what to do, who to engage, when, what materials are needed); **Next steps**; **Open questions**. Sound like a strong government affairs team — thoughtful, direct, useful; use em dashes where natural and never open with "Dear".',
    description: 'Polished, client-ready memo: situation, analysis, recommendation, next steps.',
    samplePreview:
      '## Bottom line\nWe recommend engaging SASC personnel staff this week, before the markup window closes, to lock in the language you need.\n\n## Situation\nThe Senate personnel subcommittee is finalizing its portion of the NDAA. The provision you care about is drafted but not yet adopted.\n\n## Analysis\nTwo offices are supportive and one is undecided; the staff director controls the pen and is data-driven.\n\n## Recommendation\nSend the one-pager to the two supportive offices, then request a 15-minute staff meeting to walk the undecided office through the readiness data.\n\n## Next steps\nConfirm meeting times this week; circulate the revised language by Friday.',
    tone: 'formal',
    usageCount: 0,
  },
  {
    id: 'system-meeting-prep',
    source: 'system' as const,
    name: 'Meeting Prep',
    category: 'meeting',
    prompt:
      'Prepare a meeting prep memo for a single meeting, delivered as an email the lobbyist reads beforehand. Subject: "Meeting prep — " plus the meeting subject or recipient. Use the supplied client, attendees, meeting, and selected context first; do not invent attendees, positions, history, or facts, and mark confidence (High/Medium/Low) where useful. Body in Markdown: **Bottom line** (why this meeting matters, the opportunity, the risk if handled poorly, what to get out of it); **Who is in the room** (per relevant attendee: role, organization, why they matter, known interests, connection to the client — no filler bios); **What they likely care about** (Confirmed from context / Reasonable inference / Unknown); **Relevant recent activity** (only the most relevant items — what happened, why it matters, how it connects to the client); **Client angle** (strongest client-specific angle, proof points, likely objections); **Recommended message**; **Talking points** (5-8, usable live); **Smart questions to ask** (5-8, specific); **Watch-outs**; **Recommended ask** (primary, fallback, follow-up); **Follow-up plan**.',
    description: 'Single-meeting prep: who is in the room, the angle, talking points, the ask.',
    samplePreview:
      "## Bottom line\nThis is your first sit-down with the LD — the goal is to confirm the office's posture on the amendment and secure a staff-level follow-up.\n\n## Who is in the room\n- The Legislative Director, who runs the office's defense portfolio and staffs the member on the relevant subcommittee.\n\n## What they likely care about\nConfirmed from context: district jobs tied to the program. Reasonable inference: schedule risk ahead of markup.\n\n## Talking points\n- Tie the client's work to in-district employment.\n- Offer the test data the committee has asked about.\n\n## Recommended ask\nA 20-minute member meeting before markup; fallback is a staff briefing this week.",
    tone: 'professional',
    usageCount: 0,
  },
  {
    id: 'system-hill-prep',
    source: 'system' as const,
    name: 'Hill Prep (Multiple Meetings)',
    category: 'hill',
    prompt:
      'Prepare a Hill prep packet covering multiple congressional meetings in a day, delivered as one email. Subject: "Hill prep — " plus the client and date if known. This is a single coordinated strategy, not separate summaries. Use only the supplied client, recipients, and selected context; do not invent. Body in Markdown: **Bottom line for the day** (main objective, which meetings matter most, strongest alignment, likely objections, what to avoid saying); **Core message** (the common message across meetings — natural, not a script — with value proposition, policy rationale, local/committee relevance, and the specific ask); **Message discipline** (one-sentence message, top 3 proof points, framing, words or arguments to avoid, sensitive issues); **Meeting-by-meeting** (per office: priority High/Medium/Low, why it matters, office read, best angle, likely concerns, 3-5 tailored talking points, 3-5 questions, recommended ask, follow-up); **Cross-meeting intelligence** (likely supporters, offices needing education, skeptics, offices with appropriations/authorization/oversight leverage, potential champions and blockers); **Suggested meeting order strategy**; **Questions to carry across the day**; **End-of-day follow-up plan**.',
    description:
      'Full Hill-day packet: one message, office-by-office prep, cross-meeting strategy.',
    samplePreview:
      '## Bottom line for the day\nFour meetings, one ask. Lead with Rep. Carter (most aligned) to validate the framing before the two skeptical offices, and close with the appropriations staff.\n\n## Core message\nThe program delivers in-district jobs and a capability the committee has prioritized; we are asking for report language directing a briefing.\n\n## Meeting-by-meeting\n- Carter (High): confirm support, ask him to socialize the language.\n- Diaz (Medium): address the cost concern head-on with the new data.\n\n## End-of-day follow-up plan\nSend tailored one-pagers within 24 hours and request staff meetings with the two undecided offices.',
    tone: 'professional',
    usageCount: 0,
  },
  {
    id: 'system-office-memo',
    source: 'system' as const,
    name: 'Congressional Office Memo',
    category: 'office',
    prompt:
      'Generate a congressional office intelligence memo that helps the lobbyist decide how to approach this office — not just who the member is — delivered as an email. Subject: "Office memo — " plus the office name. Use selected context first; include generic biography only when it affects strategy; do not invent. Body in Markdown: **Bottom line** (why this office matters to the client; champion / persuadable / information target / blocker; best way to approach); **Office profile** (party, state/district, committees, leadership roles, caucuses, relevant staff, district/state interests — only what is supported); **Policy interests** (from bills, committee activity, statements, hearings, funding requests, district economic profile); **Connection to client** (Strong alignment / Possible / Weak / Friction); **Recent activity that matters** (what happened, why it matters, how to use it); **Influence assessment** (policy influence, political relevance, client relevance — each High/Medium/Low, with reasoning); **Best engagement strategy** (messenger, argument, proof point, ask, follow-up material); **Talking points**; **Questions to ask**; **Risks and watch-outs**.',
    description: 'How to approach an office: posture, interests, influence, engagement strategy.',
    samplePreview:
      "## Bottom line\nLikely persuadable. The member sits on the relevant subcommittee and has a major employer in-district, so lead with the jobs angle and bring the readiness data.\n\n## Office profile\nMajority member; serves on the authorizing subcommittee; district hosts a key supplier.\n\n## Connection to client\nPossible alignment — the client's work supports an in-district program.\n\n## Best engagement strategy\nMessenger: the client's program lead. Argument: jobs plus capability. Ask: a member meeting before markup, with a staff briefing as the fallback.",
    tone: 'professional',
    usageCount: 0,
  },
  {
    id: 'system-legislative-impact',
    source: 'system' as const,
    name: 'Legislative Impact Memo',
    category: 'legislation',
    prompt:
      'Analyze legislation from the client\'s perspective, delivered as an email — not a generic bill summary. Subject: "Legislative impact — " plus the bill number or title. Use the supplied bill details, client, and selected context; do not invent provisions, status, sponsors, or predictions. Body in Markdown: **Bottom line** (practical impact in 3-5 bullets); **What the bill does** (only the provisions relevant to the client); **Why it matters to the client** (direct / indirect / competitive / funding / regulatory / political impact); **Key provisions to watch** (per provision: plain-English explanation, client impact, stakeholders affected, risk/opportunity rating, recommended action); **Political and procedural outlook** (status, committee path, leadership dynamics, support/opposition, timing, likelihood — cautious, lobbyist-style language); **Stakeholder map** (sponsors, cosponsors, committees, agencies, supporters, opponents, coalitions, validators); **Recommended position** (Support / Support with changes / Oppose / Monitor / Engage quietly / Seek clarification — with why); **Recommended amendments or changes** (what, why, who might carry it, supporting argument); **Engagement plan** (offices to brief, committees to monitor, coalition opportunities, materials, timeline).',
    description: 'Bill analysis through the client lens: impact, position, amendments, engagement.',
    samplePreview:
      "## Bottom line\n- Section 214 directly affects the client's contract vehicle.\n- Funding is authorized but not yet appropriated.\n- Recommend Support with changes.\n\n## What the bill does\nReauthorizes the program and adds a new reporting gate before obligation.\n\n## Why it matters to the client\nThe reporting gate could delay task orders on their current vehicle.\n\n## Recommended position\nSupport with changes — seek report language clarifying the gate applies only to new starts.\n\n## Engagement plan\nBrief the two authorizing offices and monitor the appropriations mark.",
    tone: 'formal',
    usageCount: 0,
  },
  {
    id: 'system-hearing-prep',
    source: 'system' as const,
    name: 'Hearing Prep',
    category: 'hearing',
    prompt:
      'Prepare a hearing intelligence brief, delivered as an email — what is likely to happen, why it matters, and how to use the hearing before and after. Subject: "Hearing prep — " plus the hearing title. Use the supplied hearing details, witnesses, members, client, and selected context; do not invent testimony, questions, or positions. Body in Markdown: **Bottom line** (why this hearing matters to the client, the main issue, likely political frame, what to watch); **Hearing setup** (committee/subcommittee, chair and ranking member, witnesses, jurisdiction, related bills/programs/funding); **Likely themes** (per theme: why likely, who raises it, client relevance, risk/opportunity); **Witness read** (per witness: role, likely perspective, relevant prior activity, effect on the client); **Member dynamics** (who shapes the hearing and how); **Likely questions** (majority / minority / client-relevant / risk-creating); **Client implications** (policy, oversight, appropriations, regulation, reputation, business development, coalition); **Recommended pre-hearing actions**; **Recommended post-hearing actions**; **Watch-outs**.',
    description: 'Hearing brief: likely themes, witness read, member dynamics, pre/post actions.',
    samplePreview:
      "## Bottom line\nThe hearing is framed around readiness, but the real action for the client is the Q&A on the modernization account — that is where funding signals will surface.\n\n## Hearing setup\nFull committee; the chair and ranking member both have programs in the client's space; two DoD witnesses.\n\n## Likely themes\nReadiness shortfalls, schedule slips, and modernization trade-offs.\n\n## Recommended pre-hearing actions\nSend committee staff a short data sheet on the client's program.\n\n## Recommended post-hearing actions\nFollow up on any question that touches the modernization account within 24 hours.",
    tone: 'professional',
    usageCount: 0,
  },
  {
    id: 'system-pe-brief',
    source: 'system' as const,
    name: 'Defense Program Element Brief',
    category: 'defense',
    prompt:
      'Generate a Defense Program Element intelligence brief connecting budget data to lobbying and business-development strategy, delivered as an email. Subject: "PE brief — " plus the PE code and title. Use the supplied PE data (code, title, service, budget activity, funding history, requested funding, congressional marks, associated programs, office/command, contractors, contracts, hearings, legislation, reports), client, and selected context; do not invent figures or marks, and state confidence. Body in Markdown: **Bottom line** (what the program funds; why it matters to the service, to industry, and to the client); **Funding picture** (prior year, current request, increase/decrease, congressional changes, direction of travel, confidence — what the movement suggests without overstating); **Program read** (mission area, modernization relevance, technology areas, associated programs, milestones, dependencies); **Stakeholder map** (service owner, PEO/PM/command, OSD stakeholders, committees, interested members, contractors, competitors, associations); **Congressional relevance** (appropriations/authorization interest, oversight risk, district/state relevance, prior marks or report language, hearing references); **Industry relevance** (contracting opportunities, competitive positioning, recompete/new-start signals, transition risk); **Client implications** (Opportunity / Risk / Relationship target / Funding target / Intelligence gap); **Recommended engagement strategy**; **Talking points** (5-7); **Questions to ask** (Hill staff, agency, industry, client team); **Watch items** (budget documents, marks, hearings, contract awards, RFIs/RFPs, GAO/CRS/IG reports).',
    description:
      'PE budget intelligence tied to lobbying strategy: funding, stakeholders, watch items.',
    samplePreview:
      '## Bottom line\nPE 0604XXXF funds the next-gen sensor line — the FY27 request is up 18%, and the client is positioned for the integration recompete.\n\n## Funding picture\nPrior year $210M; FY27 request $248M; no marks yet. Direction of travel: up. Confidence: medium.\n\n## Stakeholder map\nService owner: Air Force; PEO and prime known; two subcommittees with jurisdiction.\n\n## Client implications\nOpportunity — recompete on the integration scope. Risk — an incumbent protest could slip the schedule.\n\n## Recommended engagement strategy\nBrief the program office and the two authorizing offices; watch the appropriations mark and the next contract action.',
    tone: 'professional',
    usageCount: 0,
  },
  {
    id: 'system-stakeholder-profile',
    source: 'system' as const,
    name: 'Stakeholder Profile',
    category: 'stakeholder',
    prompt:
      'Generate a stakeholder intelligence profile that helps the lobbyist decide how to approach this person — not just their resume — delivered as an email. Subject: "Stakeholder profile — " plus the name. Use selected context first; do not invent activity, positions, or relationships. Body in Markdown: **Bottom line** (why this person matters, what they likely care about, how to approach them, what to avoid); **Role and influence** (formal authority, informal influence, decision power, relationship to relevant committees/agencies/programs); **Issue alignment** (Strong / Possible / Friction / Unknown); **Relevant activity** (statements, bills, hearings, votes, funding, lobbying connections, agency actions, news — from context); **Relationship strategy** (best reason to engage, messenger, opening, proof point, ask, follow-up); **Talking points** (5, tailored); **Questions to ask** (5); **Watch-outs**.',
    description: 'Read on a person: influence, alignment, and how to build the relationship.',
    samplePreview:
      "## Bottom line\nThe staff director is the real decision-maker here — pragmatic, data-driven, and skeptical of vendor pitches. Lead with the readiness data, not the relationship.\n\n## Role and influence\nControls the subcommittee's pen and the member's schedule on defense issues.\n\n## Issue alignment\nPossible — has backed similar capabilities when the data was strong.\n\n## Relationship strategy\nMessenger: a technical lead, not a lobbyist. Opening: the committee's own readiness question. Ask: a 15-minute briefing.",
    tone: 'professional',
    usageCount: 0,
  },
  {
    id: 'system-daily-brief',
    source: 'system' as const,
    name: 'Daily Client Brief',
    category: 'brief',
    prompt:
      'Generate a daily government affairs brief for a client, delivered as an email. Include only developments that could realistically affect this client — not everything. Subject: "Daily brief — " plus the client and date if known. Use only the supplied client and selected context; do not invent developments. Body in Markdown: **Bottom line** (the short version of what the client needs to know today); **Critical** (items needing attention or action — per item: what happened, why it matters, recommended action, owner if known, timing); **Important** (meaningful but not urgent — what happened, why it matters, recommended action); **Monitor** (lower-priority signals — the signal, why we are watching, what would escalate it); **Recommended actions today**; **Questions for the client** (only those that improve strategy). If nothing material is in the context, say so plainly rather than padding.',
    description: 'Daily client roundup triaged into Critical / Important / Monitor with actions.',
    samplePreview:
      "## Bottom line\nOne item needs a decision today: the markup amendment dropped last night and touches your contract directly.\n\n## Critical\n- A manager's amendment adds a reporting gate on your program. Why it matters: it could delay obligation. Recommended action: approve outreach to the two authorizing offices this morning.\n\n## Important\n- A competitor's contract award posted; worth a competitive read this week.\n\n## Monitor\n- Appropriations mark expected next week.\n\n## Recommended actions today\nApprove the outreach and confirm staff meeting times.",
    tone: 'professional',
    usageCount: 0,
  },
  {
    id: 'system-exec-one-pager',
    source: 'system' as const,
    name: 'Executive One-Pager',
    category: 'executive',
    prompt:
      'Create an executive one-pager for a senior business audience, delivered as an email. They want business impact, risk, and recommended action — not process detail. Subject: "Executive brief — " plus the issue. Use the supplied client and selected context; do not invent. Body in tight Markdown: **Bottom line** (max 3 bullets: what happened, why it matters, what we should do); **Business impact** (only the relevant of: revenue/market, regulatory, funding, competitive, reputation); **Political read** (short — politics, timing, likely path); **Recommended decision** (one of: Act now / Prepare / Monitor / Engage quietly / Escalate / No action needed yet); **Next steps** (3-5 specific). Keep it to roughly a page and cut anything an executive would not act on.',
    description: 'One-page executive brief: business impact, political read, the decision to make.',
    samplePreview:
      "## Bottom line\n- The rule, as proposed, raises our client's compliance cost.\n- The comment window closes in 21 days.\n- Recommend: Prepare comments and brief two offices.\n\n## Business impact\nHigher recurring compliance cost; modest schedule risk on current work.\n\n## Political read\nThe agency wants the rule finalized this year; targeted comments can still shape it.\n\n## Recommended decision\nPrepare — draft comments and line up two supportive offices.\n\n## Next steps\nDraft comments this week; schedule the two briefings; set an internal review before filing.",
    tone: 'formal',
    usageCount: 0,
  },
  {
    id: 'system-strategy-memo',
    source: 'system' as const,
    name: 'Internal Strategy Memo',
    category: 'strategy',
    prompt:
      'Create an internal government affairs strategy memo for planning what to do next, delivered as an email. Be candid, practical, and direct — this is internal. Subject: "Strategy memo — " plus the issue. Use the supplied client, stakeholders, and selected context; do not invent. Body in Markdown: **Bottom line** (the recommended strategy in plain English); **Objective** (what we are trying to accomplish); **Current landscape** (policy status, political dynamics, stakeholders, timing, risks); **Strategic options** (2-4 options — per option: description, upside, downside, required work, likelihood of success, recommended or not); **Recommended path** (target offices or agencies, message, proof points, coalition needs, materials, timing); **Risks** (political, procedural, reputational, client); **Next 7 days**; **Next 30 days**.',
    description: 'Internal game plan: options weighed, a recommended path, and a 7/30-day plan.',
    samplePreview:
      '## Bottom line\nRun a quiet authorization play through SASC rather than a public appropriations push — lower profile, better odds this cycle.\n\n## Objective\nSecure report language directing the briefing without triggering opposition.\n\n## Strategic options\n- Quiet authorization play (recommended): lower profile, needs two champions.\n- Public appropriations push: faster, but invites the opponent to organize.\n\n## Recommended path\nBrief the two supportive SASC offices, hand them the language, and stay off the record.\n\n## Next 7 days\nConfirm the two champions and circulate the language.\n\n## Next 30 days\nTrack the mark and prepare a fallback amendment.',
    tone: 'candid',
    usageCount: 0,
  },
] as const;

type SystemAiTemplate = (typeof SYSTEM_AI_TEMPLATES)[number];
type UserAiTemplate = {
  id: string;
  source: 'user';
  name: string;
  category: string;
  prompt: string;
  description: string | null;
  samplePreview: string | null;
  tone: string;
  usageCount: number;
  createdAt: Date;
  updatedAt: Date;
};
type AiTemplateItem = SystemAiTemplate | UserAiTemplate;

@Injectable()
export class EngagementService {
  private readonly logger = new Logger(EngagementService.name);
  private readonly s3: S3Client;
  private readonly bucket?: string;
  private readonly openAiApiKey?: string;
  private readonly outreachDailyTokenBudget: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly association: ClientAssociationService,
    private readonly ai: EngagementAiService,
    private readonly notesCrypto: MeetingNotesCryptoService,
    private readonly directory: DirectoryService,
    private readonly lobbyIntel: LobbyIntelService,
    private readonly federalSpending: FederalSpendingService,
    private readonly mailSender: EngagementMailSender,
    private readonly clientKb: ClientKbService,
    private readonly contextCompiler: ContextCompilerService,
    config: ConfigService<AppConfig, true>,
  ) {
    this.bucket = config.get('ASSETS_BUCKET', { infer: true });
    this.openAiApiKey = config.get('OPENAI_API_KEY', { infer: true });
    this.outreachDailyTokenBudget = config.get('OUTREACH_DAILY_TOKEN_BUDGET', { infer: true });
    this.s3 = new S3Client({ region: config.get('AWS_REGION_DEFAULT', { infer: true }) });
  }

  /**
   * Per-tenant daily outreach token budget status (plan W3.4 / A7). Sums today's
   * (UTC) input+output tokens across outreach generation workflows and compares
   * to OUTREACH_DAILY_TOKEN_BUDGET. Best-effort: any read failure fails OPEN (no
   * block) — a metering hiccup must never wedge outreach. Budget 0 = disabled.
   */
  private async outreachBudgetStatus(ctx: TenantContext): Promise<{
    used: number;
    budget: number;
    ratio: number;
    hardStop: boolean;
    softWarn: boolean;
  }> {
    const budget = this.outreachDailyTokenBudget;
    if (!budget || budget <= 0) {
      return { used: 0, budget: 0, ratio: 0, hardStop: false, softWarn: false };
    }
    try {
      const now = new Date();
      const startOfDay = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
      );
      const agg = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.aiUsageEvent.aggregate({
          where: {
            tenantId: ctx.tenantId,
            workflow: { in: [...OUTREACH_BUDGET_WORKFLOWS] },
            createdAt: { gte: startOfDay },
          },
          _sum: { inputTokens: true, outputTokens: true },
        }),
      );
      const used = (agg._sum.inputTokens ?? 0) + (agg._sum.outputTokens ?? 0);
      const ratio = used / budget;
      return { used, budget, ratio, hardStop: used >= budget, softWarn: ratio >= 0.8 };
    } catch (err) {
      this.logger.warn(`Outreach budget check failed (failing open): ${(err as Error).message}`);
      return { used: 0, budget, ratio: 0, hardStop: false, softWarn: false };
    }
  }

  /**
   * Persist one AiUsageEvent per successful generation (spend metering).
   * Best-effort by contract: recordAiUsageEvent swallows + logs every error,
   * so awaiting this can never fail the user's generation.
   */
  private recordAiUsage(
    ctx: TenantContext,
    workflow: string,
    generated: AiGenerationUsageLike,
  ): Promise<void> {
    return recordAiUsageEvent(
      { prisma: this.prisma, logger: this.logger },
      { tenantId: ctx.tenantId, userId: ctx.userId },
      workflow,
      generated,
    );
  }

  /**
   * Tenant-wide list of CRM engagement contacts, used by pickers that link an
   * external record (e.g. an acquisition-personnel profile on the Program
   * Element page) to a known contact. Tenant-scoped via RLS; optional fuzzy
   * search over name / email / organization. Lightweight projection only.
   */
  async listContacts(ctx: TenantContext, query: { q?: string; limit?: number } = {}) {
    const term = query.q?.trim();
    const take = Math.min(Math.max(query.limit ?? 50, 1), 100);

    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.engagementContact.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...(term
            ? {
                OR: [
                  { fullName: { contains: term, mode: 'insensitive' } },
                  { email: { contains: term } },
                  { organization: { contains: term, mode: 'insensitive' } },
                ],
              }
            : {}),
        },
        orderBy: [{ updatedAt: 'desc' }],
        take,
        select: {
          id: true,
          fullName: true,
          email: true,
          organization: true,
          title: true,
          clientId: true,
        },
      }),
    );
  }

  capabilities() {
    return {
      ai: this.ai.capabilities(),
      notes: this.notesCrypto.capabilities(),
      attachments: { s3Configured: Boolean(this.bucket), maxBytes: MAX_ATTACHMENT_BYTES },
      outreach: {
        emailDraftHandoff: true,
        campaignSendingConfigured: true,
        campaignSendingProvider: 'microsoft_365',
        campaignSendingScopes: ['Mail.Send'],
      },
      integrations: {
        microsoft365: {
          status: 'requires_oauth_configuration',
          normalizedModels: ['meetings', 'mail_threads', 'mail_messages'],
        },
        googleWorkspace: {
          status: 'requires_oauth_configuration',
          normalizedModels: ['meetings', 'mail_threads', 'mail_messages'],
        },
        imapCaldav: {
          status: 'requires_server_credentials',
          normalizedModels: ['meetings', 'mail_threads', 'mail_messages'],
        },
      },
    };
  }

  listIntegrations(ctx: TenantContext) {
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.integrationConnection.findMany({
        where: {
          tenantId: ctx.tenantId,
          createdByUserId: ctx.userId,
        },
        orderBy: [{ provider: 'asc' }, { createdAt: 'desc' }],
      }),
    );
  }

  createIntegration(ctx: TenantContext, input: CreateIntegrationInput) {
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.integrationConnection.create({
        data: {
          tenantId: ctx.tenantId,
          provider: input.provider,
          accountEmail: input.accountEmail?.trim().toLowerCase() || null,
          displayName: input.displayName?.trim() || null,
          status: EngagementConnectionStatus.needs_configuration,
          scopes: defaultScopes(input.provider),
          syncState: {
            calendar: { cursor: null, updatedAt: null },
            mail: { cursor: null, updatedAt: null },
            webhooks: { configured: false },
          },
          createdByUserId: ctx.userId,
        },
      }),
    );
  }

  listMeetings(
    ctx: TenantContext,
    query: { clientId?: string; from?: string; to?: string; recipientEmails?: string[] },
  ) {
    const { from, to } = toDateWindow(query);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const baseWhere: Prisma.MeetingWhereInput = {
        tenantId: ctx.tenantId,
        ...ownMeetingWhere(ctx.userId),
        startsAt: { gte: from, lt: to },
      };

      if (!query.clientId) {
        const rows = await tx.meeting.findMany({
          where: baseWhere,
          include: meetingInclude(),
          orderBy: { startsAt: 'asc' },
        });
        return this.decorateMeetings(tx, ctx, rows);
      }

      const clientAssociationWhere = await this.clientMeetingAssociationWhere(
        tx,
        ctx.tenantId,
        query.clientId,
        query.recipientEmails ?? [],
      );
      const where: Prisma.MeetingWhereInput = { AND: [baseWhere, clientAssociationWhere] };

      const rows = await tx.meeting.findMany({
        where,
        include: meetingInclude(),
        orderBy: { startsAt: 'asc' },
      });
      return this.decorateMeetings(tx, ctx, rows);
    });
  }

  async getMeeting(ctx: TenantContext, id: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const meeting = await tx.meeting.findFirst({
        where: { id, tenantId: ctx.tenantId, ...ownMeetingWhere(ctx.userId) },
        include: meetingInclude(),
      });
      if (!meeting) throw new NotFoundException('Meeting not found');
      return (await this.decorateMeetings(tx, ctx, [meeting]))[0];
    });
  }

  async createMeeting(ctx: TenantContext, input: CreateMeetingInput) {
    const startsAt = parseDate(input.startsAt, 'startsAt');
    const endsAt = parseDate(input.endsAt, 'endsAt');
    if (endsAt < startsAt) throw new BadRequestException('endsAt must be after startsAt');

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const attendeeEmails = (input.attendees ?? [])
        .map((attendee) => attendee.email)
        .filter((email): email is string => Boolean(email));

      const autoAssociation = input.clientId
        ? {
            clientId: input.clientId,
            score: 1,
            reason: 'Manually selected during meeting creation.',
            signals: { manual: true },
          }
        : await this.association.associate(tx, ctx.tenantId, {
            subject: input.subject,
            body: input.description,
            attendeeEmails: [...attendeeEmails, input.organizerEmail ?? ''],
          });

      const contactsByEmail = await this.upsertAttendeeContacts(
        tx,
        ctx.tenantId,
        input.attendees ?? [],
      );

      // Manual meetings carry no Graph online-meeting object, so classify from the
      // location/description free text (Meetings v2 §5) — a user pasting a Zoom/
      // Teams link into either field makes the meeting Meri-eligible.
      const virtuality = deriveMeetingVirtuality({
        location: input.location ?? null,
        description: input.description ?? null,
      });

      const created = await tx.meeting.create({
        data: {
          tenantId: ctx.tenantId,
          clientId: autoAssociation.clientId,
          source: EngagementSource.manual,
          subject: input.subject.trim(),
          description: input.description?.trim() || null,
          location: input.location?.trim() || null,
          startsAt,
          endsAt,
          organizerEmail: input.organizerEmail?.trim().toLowerCase() || null,
          organizerName: input.organizerName?.trim() || null,
          isVirtual: virtuality.isVirtual,
          joinLink: virtuality.joinLink,
          provider: virtuality.provider,
          associationScore: autoAssociation.score,
          associationReason: autoAssociation.reason,
          associationSignals: autoAssociation.signals as Prisma.InputJsonValue,
          createdByUserId: ctx.userId,
          attendees: {
            create: (input.attendees ?? []).map((attendee) => ({
              tenantId: ctx.tenantId,
              email: attendee.email?.trim().toLowerCase() || null,
              name: attendee.name?.trim() || null,
              role: attendee.role?.trim() || null,
              responseStatus: attendee.responseStatus?.trim() || null,
              contactId: attendee.email
                ? (contactsByEmail.get(attendee.email.trim().toLowerCase())?.id ?? null)
                : null,
            })),
          },
        },
        include: meetingInclude(),
      });
      return (await this.decorateMeetings(tx, ctx, [created]))[0];
    });
  }

  async updateMeeting(ctx: TenantContext, id: string, input: UpdateMeetingInput) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.meeting.findFirst({
        where: { id, tenantId: ctx.tenantId, ...ownMeetingWhere(ctx.userId) },
      });
      if (!existing) throw new NotFoundException('Meeting not found');

      // Re-derive the virtual-meeting classification (Meetings v2 §5) whenever the
      // location or description changes — e.g. editing in a Zoom link should flip
      // the meeting to Meri-eligible. Uses the incoming value for the changed
      // field(s) and the stored value otherwise, and preserves any Graph webLink
      // in metadata as a join-link source.
      const reclassify = 'location' in input || 'description' in input;
      const virtualityUpdate = reclassify
        ? (({ isVirtual, joinLink, provider }) => ({ isVirtual, joinLink, provider }))(
            deriveMeetingVirtuality({
              location: 'location' in input ? (input.location ?? null) : existing.location,
              description:
                'description' in input ? (input.description ?? null) : existing.description,
              metadata: (existing.metadata as Record<string, unknown> | null) ?? null,
            }),
          )
        : {};

      const updated = await tx.meeting.update({
        where: { id },
        data: {
          ...('clientId' in input ? { clientId: input.clientId } : {}),
          ...('subject' in input ? { subject: input.subject?.trim() } : {}),
          ...('description' in input ? { description: input.description?.trim() || null } : {}),
          ...('location' in input ? { location: input.location?.trim() || null } : {}),
          ...('startsAt' in input ? { startsAt: parseDate(input.startsAt, 'startsAt') } : {}),
          ...('endsAt' in input ? { endsAt: parseDate(input.endsAt, 'endsAt') } : {}),
          ...('status' in input ? { status: input.status } : {}),
          ...virtualityUpdate,
        },
        include: meetingInclude(),
      });

      if ('clientId' in input && input.clientId && input.clientId !== existing.clientId) {
        await tx.clientAssociationOverride.create({
          data: {
            tenantId: ctx.tenantId,
            entityType: AssociationEntityType.meeting,
            entityId: id,
            clientId: input.clientId,
            previousClientId: existing.clientId,
            confidenceBefore: existing.associationScore,
            reason: 'Meeting client changed from meeting edit form.',
            userId: ctx.userId,
          },
        });
      }

      return (await this.decorateMeetings(tx, ctx, [updated]))[0];
    });
  }

  /**
   * Share a meeting record to its associated client (Meetings v2 §6). Flips the
   * whole record to `shared` (approved Prep / Notes / Debrief become visible to
   * the org on the client's Documents tab and in the Library). Sharing REQUIRES
   * an associated client. Idempotent: if already shared, the FIRST sharer's
   * attribution is preserved (forward-compatible with the Phase 2 multi-
   * contributor model, where a meeting stays shared while ANY contributor has
   * shared it).
   */
  async shareMeeting(ctx: TenantContext, meetingId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.meeting.findFirst({
        where: { id: meetingId, tenantId: ctx.tenantId, ...ownMeetingWhere(ctx.userId) },
        select: { id: true, clientId: true, visibility: true },
      });
      if (!existing) throw new NotFoundException('Meeting not found');
      if (!existing.clientId) {
        throw new BadRequestException(
          'This meeting must be associated with a client before it can be shared',
        );
      }
      const alreadyShared = existing.visibility === MeetingVisibility.shared;
      const updated = await tx.meeting.update({
        where: { id: meetingId },
        data: {
          visibility: MeetingVisibility.shared,
          // Preserve the first sharer's stamp on a re-share (Phase 2 forward-compat).
          ...(alreadyShared ? {} : { sharedAt: new Date(), sharedByUserId: ctx.userId }),
        },
        include: meetingInclude(),
      });
      return (await this.decorateMeetings(tx, ctx, [updated]))[0];
    });
  }

  /**
   * Un-share a meeting record — returns it to private (Meetings v2 §6). In Phase 1
   * a meeting has a single owner/contributor, so this fully reverts visibility and
   * clears the sharer stamp. (Phase 2 makes un-share per-contributor: the record
   * stays shared until the last contributor un-shares.)
   */
  async unshareMeeting(ctx: TenantContext, meetingId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.meeting.findFirst({
        where: { id: meetingId, tenantId: ctx.tenantId, ...ownMeetingWhere(ctx.userId) },
        select: { id: true },
      });
      if (!existing) throw new NotFoundException('Meeting not found');
      const updated = await tx.meeting.update({
        where: { id: meetingId },
        data: {
          visibility: MeetingVisibility.private,
          sharedAt: null,
          sharedByUserId: null,
        },
        include: meetingInclude(),
      });
      return (await this.decorateMeetings(tx, ctx, [updated]))[0];
    });
  }

  /**
   * Meeting Library (Meetings v2 §6): the user's own meetings (private + shared)
   * that have at least one APPROVED artifact, paginated newest-first. Filterable
   * by client, artifact type, visibility, and date range. Owner-scoped via
   * ownMeetingWhere (the Library is a personal archive — the org-visible view of
   * shared material is the client Documents tab, listSharedMeetingsForClient).
   */
  async listMeetingLibrary(
    ctx: TenantContext,
    query: {
      clientId?: string;
      artifactType?: 'prep' | 'notes' | 'debrief';
      visibility?: 'shared' | 'private';
      from?: string;
      to?: string;
      page?: number;
      limit?: number;
    },
  ) {
    const page = normalizeLibraryPage(query.page);
    const limit = normalizeLibraryLimit(query.limit);
    const startsAt: Prisma.DateTimeFilter = {};
    if (query.from) startsAt.gte = parseDate(query.from, 'from');
    if (query.to) startsAt.lt = parseDate(query.to, 'to');

    const where: Prisma.MeetingWhereInput = {
      tenantId: ctx.tenantId,
      ...ownMeetingWhere(ctx.userId),
      ...(query.clientId ? { clientId: query.clientId } : {}),
      ...(query.visibility
        ? {
            visibility:
              query.visibility === 'shared' ? MeetingVisibility.shared : MeetingVisibility.private,
          }
        : {}),
      ...(query.from || query.to ? { startsAt } : {}),
      AND: [libraryArtifactWhere(query.artifactType)],
    };

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const [total, rows] = await Promise.all([
        tx.meeting.count({ where }),
        tx.meeting.findMany({
          where,
          include: meetingInclude(),
          orderBy: { startsAt: 'desc' },
          skip: (page - 1) * limit,
          take: limit,
        }),
      ]);
      const data = await this.decorateMeetings(tx, ctx, rows);
      return { data, total, page, limit };
    });
  }

  /**
   * Shared meeting records for a client's Documents tab (Meetings v2 §8). Returns
   * the meetings SHARED to this client, newest-shared first. Deliberately TENANT-
   * scoped (NOT ownMeetingWhere) — sharing to the client makes the record visible
   * to the org, the same precedent as listClientDebriefs. Nested notes/debriefs
   * are metadata-only (no decrypted bodies), so this list leaks no artifact content.
   */
  async listSharedMeetingsForClient(ctx: TenantContext, clientId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const [tenant, rows] = await Promise.all([
        tx.tenant.findFirst({ where: { id: ctx.tenantId }, select: { settings: true } }),
        tx.meeting.findMany({
          where: { tenantId: ctx.tenantId, clientId, visibility: MeetingVisibility.shared },
          include: meetingInclude(),
          orderBy: [{ sharedAt: 'desc' }, { startsAt: 'desc' }],
        }),
      ]);
      const decorated = await this.decorateMeetings(tx, ctx, rows);
      // Phase 2 collision model (spec §7, §4.4): when the tenant is on the
      // cross-user flag, collapse per-mailbox rows that share a Graph iCalUId into
      // ONE record — canonical notes, contributors merged (first-sharer primary,
      // colleagues with their own prep/debrief surfaced via the expander), and
      // multi-user notetakers attributed. Non-destructive; off = Phase 1 (one row
      // per record). Rows with no iCalUId (manual meetings) stay standalone.
      return meetingsCrossUserEnabled(tenant?.settings)
        ? mergeSharedMeetingsByICalUid(decorated)
        : decorated;
    });
  }

  /**
   * Augment meeting rows (from meetingInclude) with the computed response fields
   * the Meetings v2 UI needs (docs/plans/2026-07-10-meetings-meri-v2-redesign-plan.md
   * §6): `notesApproved`, the coarse notetaker `meri` state, the `contributors`
   * array (always length-1 in Phase 1 — the single owner), and `sharedBy`. Names
   * are batch-resolved for createdByUserId/sharedByUserId (those are bare UUIDs
   * with no relation, by convention), and the latest bot-session status per meeting
   * is fetched once for the whole set — no N+1.
   */
  private async decorateMeetings<
    T extends {
      id: string;
      createdByUserId: string | null;
      sharedByUserId: string | null;
      notes: unknown[];
      debriefs: Array<{ status: MeetingDebriefStatus }>;
      preps: Array<{ status: MeetingPrepStatus }>;
    },
  >(tx: Prisma.TransactionClient, ctx: TenantContext, rows: T[]) {
    const userIds = [
      ...new Set(
        rows
          .flatMap((r) => [r.createdByUserId, r.sharedByUserId])
          .filter((v): v is string => Boolean(v)),
      ),
    ];
    const meetingIds = rows.map((r) => r.id);
    const [users, sessions] = await Promise.all([
      userIds.length
        ? tx.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, firstName: true, lastName: true, email: true },
          })
        : Promise.resolve([] as Array<{ id: string }>),
      meetingIds.length
        ? tx.meetingBotSession.findMany({
            where: { tenantId: ctx.tenantId, meetingId: { in: meetingIds } },
            select: { meetingId: true, status: true },
            orderBy: { createdAt: 'desc' },
          })
        : Promise.resolve([] as Array<{ meetingId: string; status: string }>),
    ]);
    const nameById = new Map(
      (
        users as Array<{
          id: string;
          firstName?: string | null;
          lastName?: string | null;
          email?: string | null;
        }>
      ).map((u) => [u.id, userDisplayName(u)]),
    );
    const latestSessionByMeeting = new Map<string, string>();
    for (const s of sessions) {
      if (!latestSessionByMeeting.has(s.meetingId))
        latestSessionByMeeting.set(s.meetingId, s.status);
    }

    return rows.map((row) => {
      const artifacts: Array<'prep' | 'notes' | 'debrief'> = [];
      if (row.preps[0]?.status === MeetingPrepStatus.approved) artifacts.push('prep');
      if (row.notes.length > 0) artifacts.push('notes');
      if (row.debriefs.some((d) => d.status === MeetingDebriefStatus.approved)) {
        artifacts.push('debrief');
      }
      const contributors = row.createdByUserId
        ? [
            {
              userId: row.createdByUserId,
              name: nameById.get(row.createdByUserId) ?? null,
              artifacts,
            },
          ]
        : [];
      return {
        ...row,
        notesApproved: row.notes.length > 0,
        meri: coarseMeriState(latestSessionByMeeting.get(row.id) ?? null),
        contributors,
        sharedBy: row.sharedByUserId
          ? { userId: row.sharedByUserId, name: nameById.get(row.sharedByUserId) ?? null }
          : null,
      };
    });
  }

  listMailThreads(ctx: TenantContext, query: { clientId?: string; recipientEmails?: string[] }) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const baseWhere: Prisma.MailThreadWhereInput = {
        tenantId: ctx.tenantId,
        ...ownMailThreadWhere(ctx.userId),
      };
      const where: Prisma.MailThreadWhereInput = query.clientId
        ? {
            AND: [
              baseWhere,
              await this.clientMailThreadAssociationWhere(
                tx,
                ctx.tenantId,
                query.clientId,
                query.recipientEmails ?? [],
              ),
            ],
          }
        : baseWhere;

      return tx.mailThread.findMany({
        where,
        include: {
          client: clientSummarySelect(),
          messages: { orderBy: { receivedAt: 'desc' }, take: 3 },
        },
        orderBy: [{ lastMessageAt: 'desc' }, { updatedAt: 'desc' }],
        take: 50,
      });
    });
  }

  listOutreachRecords(ctx: TenantContext, query: OutreachQuery) {
    const type = normalizeOutreachType(query.type);
    const limit = clampInt(query.limit, 50, 1, 100);
    const dateWindow =
      query.from || query.to
        ? {
            ...(query.from ? { gte: parseDate(query.from, 'from') } : {}),
            ...(query.to ? { lt: parseDate(query.to, 'to') } : {}),
          }
        : undefined;

    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.outreachRecord.findMany({
        where: {
          tenantId: ctx.tenantId,
          deletedAt: query.deleted ? { not: null } : null,
          ...(query.clientId ? { clientId: query.clientId } : {}),
          ...(type ? { type } : {}),
          // A record belongs to the window if it was created OR sent within it:
          // drafts sent days after creation must keep showing as sent once the
          // creation date scrolls out of the range filter.
          ...(dateWindow ? { OR: [{ createdAt: dateWindow }, { sentAt: dateWindow }] } : {}),
        },
        include: outreachInclude(),
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
    );
  }

  async getOutreachRecord(ctx: TenantContext, id: string) {
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.outreachRecord.findFirst({
        where: { id, tenantId: ctx.tenantId, deletedAt: null },
        include: outreachInclude(),
      }),
    );
    if (!row) throw new NotFoundException('Outreach record not found');
    return row;
  }

  async createOutreachRecord(ctx: TenantContext, input: CreateOutreachRecordInput) {
    const type = normalizeOutreachType(input.type);
    if (!type) {
      throw new BadRequestException('type must be campaign, follow_up, prep, or outbound_campaign');
    }
    const direction = normalizeOutreachDirection(input.direction);
    const recipients = applyOutreachDirection(
      normalizeOutreachRecipients(input.recipients),
      direction,
    );
    const contextPool = normalizeOutreachContextPool(input.contextPool);
    const clientId = input.clientId?.trim() || null;
    const meetingId = input.meetingId?.trim() || null;

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.validateOutreachParents(tx, ctx, clientId, meetingId);

      const metadata = mergeJsonObjects(sanitizeOutreachMetadata(input.metadata), {
        direction,
        contextPool,
      });

      return tx.outreachRecord.create({
        data: {
          tenantId: ctx.tenantId,
          clientId,
          meetingId,
          createdByUserId: ctx.userId,
          type,
          status: 'draft',
          title: requiredReportText(input.title, 'title', 240),
          subject: optionalReportText(input.subject, 300),
          body: optionalText(input.body) ?? null,
          recipients: recipients as unknown as Prisma.InputJsonValue,
          recipientCount: recipients.length,
          metadata: metadata as Prisma.InputJsonValue,
          lastStep: clampInt(input.lastStep, 1, 1, 7),
        },
        include: outreachInclude(),
      });
    });
  }

  async updateOutreachRecord(ctx: TenantContext, id: string, input: UpdateOutreachRecordInput) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.outreachRecord.findFirst({
        where: { id, tenantId: ctx.tenantId, deletedAt: null },
      });
      if (!existing) throw new NotFoundException('Outreach record not found');
      if (existing.status !== 'draft' && input.status === 'draft') {
        throw new BadRequestException('Sent outreach cannot be moved back to draft');
      }

      const nextClientId = 'clientId' in input ? input.clientId?.trim() || null : existing.clientId;
      const nextMeetingId =
        'meetingId' in input ? input.meetingId?.trim() || null : existing.meetingId;
      const direction =
        'direction' in input
          ? normalizeOutreachDirection(input.direction)
          : normalizeOutreachDirection(readMetadataString(existing.metadata, 'direction'));
      const contextPool =
        'contextPool' in input
          ? normalizeOutreachContextPool(input.contextPool)
          : normalizeOutreachContextPool(readMetadataUnknown(existing.metadata, 'contextPool'));
      await this.validateOutreachParents(tx, ctx, nextClientId, nextMeetingId);
      const recipients = applyOutreachDirection(
        'recipients' in input
          ? normalizeOutreachRecipients(input.recipients)
          : normalizeOutreachRecipients(existing.recipients),
        direction,
      );
      const mergedMetadata = mergeJsonObjects(
        mergeJsonObjects(
          existing.metadata,
          'metadata' in input ? sanitizeOutreachMetadata(input.metadata) : {},
        ),
        { direction, contextPool },
      );

      return tx.outreachRecord.update({
        where: { id },
        data: {
          ...('clientId' in input ? { clientId: nextClientId } : {}),
          ...('meetingId' in input ? { meetingId: nextMeetingId } : {}),
          ...('status' in input ? { status: normalizeOutreachStatus(input.status) } : {}),
          ...('title' in input ? { title: requiredReportText(input.title, 'title', 240) } : {}),
          ...('subject' in input ? { subject: optionalReportText(input.subject, 300) } : {}),
          ...('body' in input ? { body: optionalText(input.body) ?? null } : {}),
          ...('recipients' in input || 'direction' in input
            ? {
                recipients: recipients as unknown as Prisma.InputJsonValue,
                recipientCount: recipients.length,
              }
            : {}),
          metadata: mergedMetadata as Prisma.InputJsonValue,
          ...('lastStep' in input ? { lastStep: clampInt(input.lastStep, 1, 1, 7) } : {}),
        },
        include: outreachInclude(),
      });
    });
  }

  /**
   * Few-shot voice grounding for AI drafting: the author's "My Writing Style"
   * (+ profile) memory file, and the client's soul/compass when client-scoped.
   * Returns a compact text block to drop into the draft context, or null.
   * RLS-scoped (own user files + tenant-visible client files). Best-effort.
   */
  private async loadUserVoiceBlock(
    ctx: TenantContext,
    clientId: string | null,
  ): Promise<string | null> {
    try {
      // Context Compiler v1 (G1): loading, the withTenantUser/1C tenancy
      // discipline, governance filtering and the packet trace live in
      // ContextCompilerService; this method only composes the outreach block
      // labels from the compiled packet. Block text is unchanged.
      const packet = await this.contextCompiler.compile({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        clientId,
        surface: 'outreach',
        layers: ['user-voice', 'firm-identity', 'client-steering', 'client-people'],
      });

      const parts: string[] = [];
      for (const r of packet.rendered) {
        switch (r.layer) {
          case 'user-voice':
            parts.push(
              r.type === 'user-voice'
                ? `WRITE IN THIS AUTHOR'S VOICE (mirror the style and any sample writings below closely; do not invent facts):\n${r.body}`
                : `About the author:\n${r.body}`,
            );
            break;
          case 'firm-identity':
            parts.push(
              `Firm ${r.type === 'firm-soul' ? 'identity (Firm Soul)' : 'direction (Firm Compass)'}:\n${r.body}`,
            );
            break;
          // client-people = the human-authored relationship file (their team,
          // Hill offices, commitments made, key conversations) — labeled
          // distinctly from strategic memory.
          case 'client-people':
            parts.push(`Client relationships & commitments (from memory):\n${r.body}`);
            break;
          default:
            parts.push(`Client strategic memory (${r.type}):\n${r.body}`);
        }
      }
      return parts.length ? parts.join('\n\n') : null;
    } catch {
      return null;
    }
  }

  async generateOutreachDraft(
    ctx: TenantContext,
    id: string,
    input: {
      objective?: string;
      direction?: 'on-behalf' | 'to-clients';
      recipients?: OutreachRecipientInput[];
      contextPool?: OutreachContextPoolItemInput[];
      promptTemplate?: string;
      metadata?: Record<string, unknown>;
    },
  ) {
    const record = await this.getOutreachRecord(ctx, id);
    if (record.status !== 'draft') {
      throw new BadRequestException('Only draft outreach can be regenerated');
    }

    const direction = normalizeOutreachDirection(
      input.direction ?? readMetadataString(record.metadata, 'direction'),
    );
    const contextPool = normalizeOutreachContextPool(
      input.contextPool ?? readMetadataUnknown(record.metadata, 'contextPool'),
    );
    const recipients = applyOutreachDirection(
      normalizeOutreachRecipients(input.recipients ?? record.recipients),
      direction,
    );
    if ((record.type === 'campaign' || record.type === 'outbound_campaign') && !recipients.length) {
      throw new BadRequestException('At least one recipient is required before drafting');
    }
    const generatedAt = new Date();
    const requestMetadata =
      record.type === 'outbound_campaign'
        ? {
            ...(input.metadata ?? {}),
            outboundCurrentDateTime:
              readString(input.metadata?.outboundCurrentDateTime) || generatedAt.toISOString(),
          }
        : record.type === 'campaign'
          ? {
              ...(input.metadata ?? {}),
              campaignCurrentDateTime:
                readString(input.metadata?.campaignCurrentDateTime) || generatedAt.toISOString(),
              campaignCurrentDateTimeDisplay: formatCurrentDateTime(
                readString(input.metadata?.campaignCurrentDateTime) || generatedAt.toISOString(),
              ),
            }
          : input.metadata;
    const context = await this.outreachContext(
      ctx,
      record,
      recipients,
      mergeJsonObjects(requestMetadata ?? {}, { direction, contextPool }),
    );
    const promptTemplate =
      input.promptTemplate ?? readMetadataString(record.metadata, 'promptTemplate') ?? null;
    // Few-shot voice grounding: the author's writing-style file + the client's
    // soul/compass, so drafts sound like the user and respect client strategy.
    const voiceBlock = await this.loadUserVoiceBlock(ctx, record.client?.id ?? null);
    const contextWithVoice = voiceBlock ? { ...context, userWritingStyle: voiceBlock } : context;
    const generated = await this.ai.generateOutreachDraft(
      {
        workflow: record.type as OutreachType,
        client: record.client ? pruneForAi(record.client) : null,
        meeting: record.meeting ? pruneForAi(record.meeting) : null,
        objective: input.objective ?? readMetadataString(record.metadata, 'objective'),
        recipients: recipients.map(pruneForAi),
        context: contextWithVoice,
        promptTemplate,
        existingSubject: record.subject,
        existingBody: outboundTemplateBody(record, requestMetadata) ?? record.body,
      },
      ctx,
    );
    await this.recordAiUsage(ctx, 'outreach_draft', generated);

    const draftSubject =
      record.type === 'campaign'
        ? resolveGeneratedCampaignDraft(
            generated.subject,
            recipients,
            mergeJsonObjects(record.metadata, requestMetadata ?? {}),
          )
        : generated.subject;
    const draftBody =
      record.type === 'campaign'
        ? resolveGeneratedCampaignDraft(
            generated.body,
            recipients,
            mergeJsonObjects(record.metadata, requestMetadata ?? {}),
          )
        : generated.body;

    const nextMetadata = mergeJsonObjects(
      mergeJsonObjects(record.metadata, {
        ...(requestMetadata ?? {}),
        objective: input.objective ?? readMetadataString(record.metadata, 'objective') ?? null,
        promptTemplate,
        clioContextNote: generated.contextNote,
        ai: {
          provider: generated.provider,
          model: generated.model,
          generatedAt: generatedAt.toISOString(),
          promptSpecVersion: generated.promptSpecVersion ?? 'v1',
          // G3 edit-distance instrumentation: the AS-GENERATED text, preserved
          // immutably here because human edits overwrite subject/body in place.
          // Send-time computes editRatio(generatedBody, sent body) — the
          // blueprint's "draft usefulness" flywheel signal.
          generatedSubject: draftSubject ?? null,
          generatedBody: draftBody ?? null,
        },
      }),
      { direction, contextPool },
    );

    return this.updateOutreachRecord(ctx, id, {
      direction,
      subject: draftSubject,
      body: draftBody,
      recipients,
      contextPool,
      metadata: nextMetadata,
      lastStep: Math.max(record.lastStep, 5),
    });
  }

  async openOutreachInConnectedEmail(ctx: TenantContext, id: string) {
    const record = await this.getOutreachRecord(ctx, id);
    if (record.type === 'campaign') {
      throw new BadRequestException('Campaigns send from Capiro and do not open in email');
    }
    const connected = await this.hasConnectedInbox(ctx);
    if (!connected) {
      throw new BadRequestException('Connect your email in Settings to use this feature');
    }
    const recipients = normalizeOutreachRecipients(record.recipients);
    if (!recipients.length) throw new BadRequestException('At least one recipient is required');
    if (!record.subject || !record.body)
      throw new BadRequestException('Draft subject and body are required');

    const openedAt = new Date();
    const updated = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.outreachRecord.update({
        where: { id },
        data: {
          status: 'opened_in_email',
          openedInEmailAt: openedAt,
          metadata: mergeJsonObjects(record.metadata, {
            openedInEmailAt: openedAt.toISOString(),
          }) as Prisma.InputJsonValue,
        },
        include: outreachInclude(),
      }),
    );

    return {
      record: updated,
      mailtoUrl: buildMailtoUrl(recipients, record.subject, record.body),
    };
  }

  async sendCampaign(ctx: TenantContext, id: string) {
    const record = await this.getOutreachRecord(ctx, id);
    if (record.type !== 'campaign' && record.type !== 'outbound_campaign') {
      throw new BadRequestException('Only campaigns can be sent');
    }

    if (record.status !== 'draft') {
      throw new BadRequestException('Only draft campaigns can be sent');
    }
    if (!record.subject?.trim() || !record.body?.trim()) {
      throw new BadRequestException('Campaign subject and body are required');
    }

    const recipients = normalizeOutreachRecipients(record.recipients);
    if (!recipients.length) throw new BadRequestException('At least one recipient is required');
    const missingEmailRecipients = recipients.filter((recipient) => !recipient.email);
    if (missingEmailRecipients.length) {
      throw new BadRequestException(
        `Every campaign recipient must have an email address. Missing: ${missingEmailRecipients
          .map(outreachRecipientLabel)
          .join(', ')}`,
      );
    }

    const connection = await this.findCampaignSendConnection(ctx);
    const sent: Array<{ email: string; name: string | null; sentAt: string }> = [];
    const errors: Array<{ email: string; message: string }> = [];

    // Campaign-level file attachments: ids are persisted on the record's
    // metadata.attachmentIds by the wizard / outbound review screen. Load them
    // once (skipping any over the Graph inline limit) and attach to every email.
    const metadataAttachmentIds = (record.metadata as Record<string, unknown>)?.attachmentIds;
    const attachmentIds = Array.isArray(metadataAttachmentIds)
      ? metadataAttachmentIds.filter((a): a is string => typeof a === 'string')
      : undefined;
    const campaignAttachments = await this.loadGraphAttachments(ctx, attachmentIds);

    const perRecipientEmails = (record.metadata as Record<string, unknown>)?.perRecipientEmails;
    const emailMap = Array.isArray(perRecipientEmails)
      ? new Map(
          (perRecipientEmails as Array<{ recipientId: string; subject: string; body: string }>).map(
            (e) => [e.recipientId, e],
          ),
        )
      : new Map<string, { recipientId: string; subject: string; body: string }>();

    for (const recipient of recipients) {
      const email = recipient.email!;
      const recipientId = recipient.directoryContactId || recipient.email || '';
      const perEmail = emailMap.get(recipientId);
      try {
        await this.mailSender.sendMail(ctx, connection, {
          subject:
            perEmail?.subject || assembleCampaignBody(record.subject, recipient, record.metadata),
          body: perEmail?.body || assembleCampaignBody(record.body, recipient, record.metadata),
          toRecipients: [{ email, name: recipient.name ?? null }],
          attachments: campaignAttachments,
        });
        sent.push({
          email,
          name: recipient.name ?? null,
          sentAt: new Date().toISOString(),
        });
      } catch (error) {
        errors.push({
          email,
          message: emailSendErrorMessage(error),
        });
      }
    }

    const now = new Date();
    // G3 edit-distance: how much a human reworked the AI draft before sending
    // (0 = verbatim, 1 = full rewrite). Only computable when the as-generated
    // shadow exists (drafts generated after G3 shipped).
    const aiMeta = ((record.metadata as Record<string, unknown> | null)?.ai ?? null) as {
      generatedBody?: string | null;
      generatedSubject?: string | null;
    } | null;
    const editDistance =
      aiMeta?.generatedBody && record.body
        ? {
            bodyEditRatio: editRatio(aiMeta.generatedBody, record.body),
            subjectEditRatio:
              aiMeta.generatedSubject && record.subject
                ? editRatio(aiMeta.generatedSubject, record.subject)
                : null,
          }
        : null;
    const stats = {
      provider: 'microsoft_graph',
      connectionId: connection.id,
      accountEmail: connection.accountEmail ?? null,
      recipientsAttempted: recipients.length,
      recipientsSent: sent.length,
      recipientsFailed: errors.length,
      // Opens are NOT tracked (no tracking pixels — D8). Only real signals are
      // persisted; reply detection updates replyCount when it lands.
      replyCount: 0,
      ...(editDistance ? { editDistance } : {}),
      sent,
      ...(errors.length ? { errors } : {}),
    };

    const updated = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.outreachRecord.update({
        where: { id },
        data: {
          status: errors.length ? 'failed' : 'sent',
          sentAt: errors.length ? null : now,
          stats: stats as Prisma.InputJsonValue,
          metadata: mergeJsonObjects(record.metadata, {
            campaignSend: {
              provider: 'microsoft_graph',
              connectionId: connection.id,
              accountEmail: connection.accountEmail ?? null,
              completedAt: now.toISOString(),
              status: errors.length ? 'failed' : 'sent',
            },
          }) as Prisma.InputJsonValue,
          lastStep: 5,
        },
        include: outreachInclude(),
      }),
    );

    if (errors.length) {
      throw new ServiceUnavailableException(
        `Campaign send failed for ${errors.length} of ${recipients.length} recipients. Successful sends and email provider errors were recorded on the campaign.`,
      );
    }

    return updated;
  }

  async outboundCampaignContactData(ctx: TenantContext, query: { clientId?: string }) {
    const to = new Date();
    const from = addDays(to, -7);
    const clientId = query.clientId?.trim() || null;

    const meetings = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      if (clientId) {
        await ensureExists(
          tx.client.findFirst({
            where: { id: clientId, tenantId: ctx.tenantId },
            select: { id: true },
          }),
          'Client not found',
        );
      }
      const clientAssociationWhere = clientId
        ? await this.clientMeetingAssociationWhere(tx, ctx.tenantId, clientId)
        : null;

      return tx.meeting.findMany({
        where: {
          AND: [
            {
              tenantId: ctx.tenantId,
              ...ownMeetingWhere(ctx.userId),
              connectionId: { not: null },
              source: { not: EngagementSource.manual },
              startsAt: { gte: from, lte: to },
            },
            ...(clientAssociationWhere ? [clientAssociationWhere] : []),
          ],
        },
        include: {
          client: clientSummarySelect(),
          attendees: { orderBy: { createdAt: 'asc' } },
          preps: {
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
          debriefs: {
            include: {
              author: { select: { id: true, email: true, firstName: true, lastName: true } },
            },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
        orderBy: { startsAt: 'desc' },
        take: 100,
      });
    });

    const attendeeEmails = unique(
      meetings.flatMap((meeting) =>
        meeting.attendees
          .map((attendee) => normalizeEmailAddress(attendee.email))
          .filter((email): email is string => Boolean(email)),
      ),
    );
    const directoryMatches = attendeeEmails.length
      ? await this.directory.findContactsByEmails(attendeeEmails, 500).catch(() => [])
      : [];
    const matchesByEmail = new Map<string, DirectoryEmailMatch[]>();
    for (const match of directoryMatches) {
      const email = normalizeEmailAddress(match.attendeeEmail);
      if (!email) continue;
      const rows = matchesByEmail.get(email) ?? [];
      rows.push(match);
      matchesByEmail.set(email, rows);
    }

    const contacts = meetings.flatMap((meeting) => {
      const attendeeNames = meeting.attendees
        .map((attendee) => attendee.name?.trim() || attendee.email?.trim() || '')
        .filter(Boolean)
        .join(', ');
      const attendeeEmailList = meeting.attendees
        .map((attendee) => normalizeEmailAddress(attendee.email))
        .filter((email): email is string => Boolean(email))
        .join(', ');
      const prepSummary = summarizeMeetingPrep(meeting.preps[0] ?? null);
      const readableDebrief = meeting.debriefs.find((debrief) =>
        canReadEncryptedEntry(ctx, debrief),
      );
      const debriefSummary = readableDebrief
        ? summarizeText(
            this.notesCrypto.decrypt({
              bodyCiphertext: readableDebrief.bodyCiphertext,
              iv: readableDebrief.iv,
              authTag: readableDebrief.authTag,
            }),
            1000,
          )
        : '';

      return meeting.attendees
        .map((attendee) => {
          const email = normalizeEmailAddress(attendee.email);
          const match = email ? (matchesByEmail.get(email)?.[0] ?? null) : null;
          const location = formatDirectoryMainOffice(match) || meeting.location || '';
          const name = attendee.name?.trim() || attendee.email?.trim() || '';
          if (!name && !email) return null;
          return {
            id: `${meeting.id}:${attendee.id}`,
            meetingId: meeting.id,
            meetingSubject: meeting.subject,
            meetingDateTime: meeting.startsAt.toISOString(),
            meetingStartsAt: meeting.startsAt,
            clientId: meeting.clientId,
            clientName: meeting.client?.name ?? null,
            attendeeName: name,
            attendeeEmail: email,
            attendeeNames,
            attendeeEmails: attendeeEmailList,
            prepSummary,
            debriefSummary,
            meetingLocation: location,
            directoryContactId: match?.directoryContactId ?? null,
            directoryContactName: match?.directoryContactName ?? null,
            office:
              match?.staff?.officeLocation ||
              match?.member.officeLocation ||
              match?.member.title ||
              null,
            title: match?.staff?.title || match?.member.title || attendee.role || null,
            committee: match?.member.committees[0] ?? null,
            relevanceReason: outboundRelevanceReason(match),
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    });

    return {
      generatedAt: to.toISOString(),
      from: from.toISOString(),
      to: to.toISOString(),
      contacts,
    };
  }

  async listOutreachTemplates(ctx: TenantContext, query: { type?: string }) {
    const type = normalizeOutreachTemplateType(query.type);
    const custom = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.outreachTemplate.findMany({
        where: {
          tenantId: ctx.tenantId,
          createdByUserId: ctx.userId,
          type,
        },
        orderBy: { updatedAt: 'desc' },
      }),
    );

    return [
      ...builtinOutboundCampaignTemplates(),
      ...custom.map((template) => ({
        id: template.id,
        source: 'user' as const,
        type: template.type,
        name: template.name,
        subject: template.subject,
        body: template.body,
        metadata: template.metadata,
        createdAt: template.createdAt,
        updatedAt: template.updatedAt,
      })),
    ];
  }

  async createOutreachTemplate(ctx: TenantContext, input: CreateOutreachTemplateInput) {
    const name = requiredReportText(input.name, 'name', 120);
    const body = requiredReportText(input.body, 'body', 10000);
    const subject = optionalReportText(input.subject, 300);

    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.outreachTemplate.create({
        data: {
          tenantId: ctx.tenantId,
          createdByUserId: ctx.userId,
          type: 'outbound_campaign',
          name,
          subject,
          body,
          metadata: {
            source: 'user',
            variables: OUTBOUND_CAMPAIGN_VARIABLES,
          },
        },
      }),
    );
  }

  // ---- Outreach 2.0 saved audiences (reusable lists/groups) ----
  // User-owned per the design doc: each user's saved lists/groups live in
  // their own contact library (createdByUserId), tenant-scoped via RLS.

  listOutreachAudiences(ctx: TenantContext, kind?: 'list' | 'group') {
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.outreachAudience.findMany({
        where: {
          tenantId: ctx.tenantId,
          createdByUserId: ctx.userId,
          status: { not: 'archived' },
          ...(kind ? { kind } : {}),
        },
        orderBy: { name: 'asc' },
        // Members of one batch-create share an identical created_at, so the
        // id tie-break keeps the order deterministic across reads.
        include: { members: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
      }),
    );
  }

  createOutreachAudience(
    ctx: TenantContext,
    input: {
      kind: 'list' | 'group';
      name: string;
      description?: string;
      members: Array<{
        source: 'congress' | 'client_contact' | 'manual';
        sourceRefId?: string;
        name?: string;
        email: string;
        title?: string;
        office?: string;
      }>;
    },
  ) {
    const name = input.name.trim();
    if (!name) throw new BadRequestException('name is required');
    if (!input.members.length) {
      throw new BadRequestException('an audience needs at least one member');
    }
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.outreachAudience.create({
        data: {
          tenantId: ctx.tenantId,
          createdByUserId: ctx.userId,
          kind: input.kind,
          name,
          description: input.description?.trim() || null,
          // Saved from the wizard = immediately usable; 'draft' is reserved
          // for future in-progress library edits.
          status: 'active',
          members: {
            create: input.members.map((member) => ({
              tenantId: ctx.tenantId,
              source: member.source,
              sourceRefId: member.sourceRefId?.trim() || null,
              name: member.name?.trim() || null,
              email: member.email.trim().toLowerCase(),
              title: member.title?.trim() || null,
              office: member.office?.trim() || null,
            })),
          },
        },
        include: { members: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
      }),
    );
  }

  async listAiTemplates(ctx: TenantContext): Promise<AiTemplateItem[]> {
    const userTemplates = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.outreachAiTemplate.findMany({
        where: { tenantId: ctx.tenantId, userId: ctx.userId },
        orderBy: { updatedAt: 'desc' },
      }),
    );

    return [
      ...(SYSTEM_AI_TEMPLATES as unknown as AiTemplateItem[]),
      ...userTemplates.map(
        (t): UserAiTemplate => ({
          id: t.id,
          source: 'user' as const,
          name: t.name,
          category: t.category,
          prompt: t.prompt,
          description: t.description,
          samplePreview: t.samplePreview,
          tone: t.tone,
          usageCount: t.usageCount,
          createdAt: t.createdAt,
          updatedAt: t.updatedAt,
        }),
      ),
    ];
  }

  async createAiTemplate(ctx: TenantContext, input: CreateAiTemplateInput) {
    const name = requiredReportText(input.name, 'name', 120);
    const prompt = requiredReportText(input.prompt, 'prompt', 5000);
    const category = input.category?.trim().slice(0, 50) || 'general';
    const description = input.description?.trim().slice(0, 500) || null;
    const tone = input.tone?.trim().slice(0, 50) || 'professional';

    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.outreachAiTemplate.create({
        data: {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          name,
          category,
          prompt,
          description,
          tone,
        },
      }),
    );
  }

  async updateAiTemplate(ctx: TenantContext, id: string, input: UpdateAiTemplateInput) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.outreachAiTemplate.findFirst({
        where: { id, tenantId: ctx.tenantId, userId: ctx.userId },
      });
      if (!existing) throw new NotFoundException('AI template not found');

      return tx.outreachAiTemplate.update({
        where: { id },
        data: {
          ...('name' in input && input.name ? { name: input.name.trim().slice(0, 120) } : {}),
          ...('category' in input && input.category
            ? { category: input.category.trim().slice(0, 50) }
            : {}),
          ...('prompt' in input && input.prompt
            ? { prompt: input.prompt.trim().slice(0, 5000) }
            : {}),
          ...('description' in input
            ? { description: input.description?.trim().slice(0, 500) ?? null }
            : {}),
          ...('tone' in input && input.tone ? { tone: input.tone.trim().slice(0, 50) } : {}),
        },
      });
    });
  }

  async deleteAiTemplate(ctx: TenantContext, id: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.outreachAiTemplate.findFirst({
        where: { id, tenantId: ctx.tenantId, userId: ctx.userId },
      });
      if (!existing) throw new NotFoundException('AI template not found');
      return tx.outreachAiTemplate.delete({ where: { id } });
    });
  }

  async previewAiTemplate(ctx: TenantContext, id: string) {
    const systemTemplate = SYSTEM_AI_TEMPLATES.find((t) => t.id === id);
    let templatePrompt: string;
    let templateName: string;

    if (systemTemplate) {
      templatePrompt = systemTemplate.prompt;
      templateName = systemTemplate.name;
    } else {
      const dbTemplate = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.outreachAiTemplate.findFirst({ where: { id, tenantId: ctx.tenantId } }),
      );
      if (!dbTemplate) throw new NotFoundException('AI template not found');
      templatePrompt = dbTemplate.prompt;
      templateName = dbTemplate.name;
    }

    const mockRecipient = {
      name: 'Jane Smith',
      title: 'Legislative Director',
      office: 'House Committee on Science, Space, and Technology',
      chamber: 'House',
      state: 'TX',
      district: '21',
      party: 'R',
      committee: 'House Science, Space, and Technology Committee',
    };

    const generated = await this.ai.generateOutreachDraft(
      {
        workflow: 'campaign',
        client: { name: 'Sample Client Organization', industry: 'Technology' },
        recipients: [mockRecipient],
        context: { preview: true, templateName },
        promptTemplate: 'custom',
        objective: templatePrompt,
      },
      ctx,
    );
    await this.recordAiUsage(ctx, 'template_preview', generated);

    return { subject: generated.subject, body: generated.body, templateName };
  }

  async getOutreachInsights(ctx: TenantContext, query: { clientId?: string }) {
    const clientId = query.clientId?.trim() || null;

    const billSelect = {
      id: true,
      billNumber: true,
      title: true,
      policyArea: true,
      latestActionText: true,
      latestActionDate: true,
    } as const;
    type BillRow = {
      id: string;
      billNumber: string;
      title: string;
      policyArea: string | null;
      latestActionText: string | null;
      latestActionDate: Date | null;
    };
    const toRecentBill = (b: BillRow) => ({
      id: b.id,
      billNumber: b.billNumber,
      title: b.title,
      policyArea: b.policyArea,
      status: b.latestActionDate ? b.latestActionDate.toISOString().slice(0, 10) : null,
      latestAction: b.latestActionText ?? null,
    });
    // congress_bill is a GLOBAL (non-RLS) table, read directly like elsewhere in
    // this method; the 10 most-recently-updated bills are the tenant-agnostic
    // fallback used only when the client tracks nothing of its own.
    const recentGlobalBills = (): Promise<BillRow[]> =>
      this.prisma.congressBill.findMany({
        orderBy: { updateDate: 'desc' },
        take: 10,
        select: billSelect,
      });

    let clientName: string | null = null;
    let clientLdaHistory: Array<{ year: number; filingCount: number; issueAreas: string[] }> = [];
    let recentBills: Array<ReturnType<typeof toRecentBill>> = [];

    if (clientId) {
      // A Capiro client maps to a SET of LDA registrant ids (client.ldaClientIds);
      // the old code did `Number(<uuid>)` → NaN and the guard silently skipped the
      // filing query, so LDA history was ALWAYS empty. Query by the real id set.
      // In parallel, load the client's actively tracked bills — the "reason to
      // write now" hook — which take precedence over the global recent list.
      const [client, trackedBillRefs] = await Promise.all([
        this.prisma.withTenant(ctx.tenantId, (tx) =>
          tx.client.findFirst({
            where: { id: clientId, tenantId: ctx.tenantId },
            select: { name: true, ldaClientIds: true },
          }),
        ),
        this.prisma.withTenant(ctx.tenantId, (tx) =>
          tx.trackedBill.findMany({
            where: { tenantId: ctx.tenantId, clientId },
            orderBy: { updatedAt: 'desc' },
            take: 10,
            select: { billId: true },
          }),
        ),
      ]);
      clientName = client?.name ?? null;
      const ldaClientIds = client?.ldaClientIds ?? [];
      const trackedBillIds = trackedBillRefs.map((t) => t.billId);

      const [ldaFilings, trackedBills] = await Promise.all([
        ldaClientIds.length
          ? this.prisma.ldaFiling.findMany({
              where: { clientId: { in: ldaClientIds } },
              select: { filingYear: true, issueCodes: true },
              orderBy: { dtPosted: 'desc' },
              take: 100,
            })
          : Promise.resolve([] as Array<{ filingYear: number; issueCodes: string[] }>),
        trackedBillIds.length
          ? this.prisma.congressBill.findMany({
              where: { id: { in: trackedBillIds } },
              select: billSelect,
            })
          : Promise.resolve([] as BillRow[]),
      ]);

      if (trackedBills.length) {
        // Preserve the tracked-bill recency order (trackedBillIds is ordered by
        // updatedAt desc; congressBill.findMany order is not guaranteed).
        const byId = new Map(trackedBills.map((b) => [b.id, b]));
        recentBills = trackedBillIds
          .map((id) => byId.get(id))
          .filter((b): b is BillRow => Boolean(b))
          .map(toRecentBill);
      } else {
        // Fall back to global recent bills whenever the client has no RESOLVED
        // tracked bills — this covers both "tracks nothing" and "tracks bills
        // whose ids aren't in congress_bill yet" (fetched only on this path so
        // the common tracked case pays no extra query).
        recentBills = (await recentGlobalBills()).map(toRecentBill);
      }

      const byYear = new Map<number, Set<string>>();
      for (const filing of ldaFilings) {
        if (!byYear.has(filing.filingYear)) byYear.set(filing.filingYear, new Set());
        for (const code of filing.issueCodes) {
          if (code) byYear.get(filing.filingYear)!.add(code);
        }
      }
      clientLdaHistory = Array.from(byYear.entries())
        .sort(([a], [b]) => b - a)
        .slice(0, 5)
        .map(([year, areas]) => ({
          year,
          filingCount: ldaFilings.filter((f) => f.filingYear === year).length,
          issueAreas: Array.from(areas),
        }));
    } else {
      const bills = await recentGlobalBills();
      recentBills = bills.map(toRecentBill);
    }

    const [lobbyCtx, spendCtx] = await Promise.all([
      this.lobbyIntel.getAiContext().catch(() => ({
        surgingIssues: [] as { code: string; name: string; surgePct: number | null }[],
        trendingTopics: [] as { word: string; growthPct: number | null }[],
        latestQuarter: null as string | null,
      })),
      this.federalSpending.getAiContext(clientName),
    ]);

    return {
      surgingIssues: lobbyCtx.surgingIssues.slice(0, 6),
      trendingTopics: lobbyCtx.trendingTopics.slice(0, 8),
      latestQuarter: lobbyCtx.latestQuarter,
      clientSpending: spendCtx.matchedContractor,
      topAgencies: spendCtx.topAgencyTotals.slice(0, 5),
      recentBills,
      clientLdaHistory,
      suggestedTalkingPoints: null as string[] | null,
    };
  }

  async generateTalkingPoints(ctx: TenantContext, input: GenerateTalkingPointsInput) {
    let clientName: string | null = null;
    if (input.clientId) {
      const client = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.client.findFirst({
          where: { id: input.clientId!, tenantId: ctx.tenantId },
          select: { name: true, intakeData: true },
        }),
      );
      clientName = client?.name ?? null;
    }

    const talkingPoints = await this.ai.generateTalkingPoints(
      {
        client: clientName ? { name: clientName } : null,
        selectedInsights: input.insights,
        additionalContext: input.additionalContext,
      },
      ctx,
    );
    await this.recordAiUsage(ctx, 'talking_points', talkingPoints);

    return { talkingPoints };
  }

  async generateBatchEmails(ctx: TenantContext, input: GenerateBatchEmailInput) {
    const {
      templateId,
      insights,
      additionalContext,
      tone,
      clientId,
      contextItems,
      direction,
      audienceKind,
      existingSubject,
      existingBody,
      reviseInstruction,
    } = input;

    // Daily token budget gate (W3.4): hard-stop before spending anything when the
    // tenant has hit its ceiling for the day; a typed 429 the wizard renders with
    // the admin contact. (Soft-warn at 80% rides back on the response below.)
    const budget = await this.outreachBudgetStatus(ctx);
    if (budget.hardStop) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'OUTREACH_TOKEN_BUDGET_EXCEEDED',
          message:
            'Your organization has reached its daily outreach AI limit. Drafting resets at 00:00 UTC — contact your Capiro admin to raise the limit.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // A 'group' batch is ONE shared email whose single recipient is a stand-in
    // for the whole group; per-member enrichment (directory profile, that
    // member's press / meeting / email history) must NOT be hoisted, or the
    // draft tailors itself to one member (see buildOutreachPrompt group branch).
    const isGroup = audienceKind === 'group';

    // Revision ("Improve") mode: the wizard re-POSTs ONE draft with the user's
    // current (possibly hand-edited) body + a freeform instruction. Guarded to a
    // single recipient so a multi-recipient batch can never be revised against
    // one body. Triggers PromptSpec v2 revision mode (edit-in-place, change
    // nothing else) via existingBody + objective=instruction.
    const isReviseSingle = Boolean(existingBody) && input.recipients.length === 1;

    // Defense-in-depth dedup (A13): the wizard already POSTs unique recipients,
    // but a duplicated recipientKey would otherwise fan out a redundant, billable
    // AI call and produce two results under the same key. See dedupeOutreachRecipients.
    const recipients = dedupeOutreachRecipients(input.recipients);

    const systemTemplate = SYSTEM_AI_TEMPLATES.find((t) => t.id === templateId);
    let templatePrompt: string;

    if (systemTemplate) {
      templatePrompt = systemTemplate.prompt;
    } else {
      const dbTemplate = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.outreachAiTemplate.findFirst({ where: { id: templateId, tenantId: ctx.tenantId } }),
      );
      if (!dbTemplate) throw new NotFoundException('Template not found');
      templatePrompt = dbTemplate.prompt;

      await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.outreachAiTemplate.update({
          where: { id: templateId },
          data: { usageCount: { increment: 1 } },
        }),
      );
    }

    // Resolve the logged-in user so generated drafts are signed by the
    // actual sender (not a hardcoded placeholder name).
    const senderUser = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.user.findFirst({
        where: { id: ctx.userId },
        select: { firstName: true, lastName: true, title: true, email: true },
      }),
    );
    const senderName =
      [senderUser?.firstName, senderUser?.lastName].filter(Boolean).join(' ').trim() || null;
    const senderSignature = senderName
      ? [senderName, senderUser?.title?.trim() || null].filter(Boolean).join('\n')
      : null;

    let client: Record<string, unknown> | null = null;
    // Rendered to a compact STRING (not the raw object): PromptSpec v2 only
    // renders string context values, so an object was silently dropped when v2
    // went live. See renderClientRelationshipSnapshot.
    let clientContextForCampaign: string | null = null;
    if (clientId) {
      const [row, context] = await Promise.all([
        this.prisma.withTenant(ctx.tenantId, (tx) =>
          tx.client.findFirst({ where: { id: clientId, tenantId: ctx.tenantId } }),
        ),
        this.clientContext(ctx, clientId).catch(() => null),
      ]);
      if (row) client = pruneForAi(row);
      if (context) clientContextForCampaign = renderClientRelationshipSnapshot(context);
    }

    const insightsContext = insights?.length
      ? `Selected intelligence insights:\n${insights.join('\n')}`
      : null;

    // Accuracy fix (2026-07-11): replace thin client-supplied bill/PE bodies with
    // an AUTHORITATIVE block from our own tables (canonical status + every
    // congressional mark) BEFORE they become prompt text — the fix for reversed
    // funding direction, omitted chamber cuts, and "stalled bill read as
    // advancing". Best-effort per item; a lookup miss keeps the original body.
    const { items: enrichedContextItems, truthByItemId: outreachTruthByItemId } =
      await this.enrichOutreachContextItems(contextItems ?? []);

    // Bucket the v2 wizard's scoped context items so we can hand the AI
    // shared-context-vs-recipient-context distinctly per draft below.
    const sharedItems = enrichedContextItems.filter((c) => c.scope === 'all');
    const recipientScopedItems = new Map<string, typeof sharedItems>();
    for (const c of enrichedContextItems) {
      if (c.scope === 'all') continue;
      const bucket = recipientScopedItems.get(c.scope) ?? [];
      bucket.push(c);
      recipientScopedItems.set(c.scope, bucket);
    }
    const formatItems = (items: OutreachSelectedContextItemInput[]) =>
      items
        .map((c) => {
          const note = c.note ? `\n  Instruction: ${c.note}` : '';
          const body = c.body ? `\n  ${c.body}` : '';
          return `- [${c.kind}] ${c.title}${body}${note}`;
        })
        .join('\n');
    const sharedContextText = sharedItems.length
      ? `Shared context (every recipient):\n${formatItems(sharedItems)}`
      : null;

    // ---- Tier-1 context enrichment (computed once per campaign) ----
    // These channels mirror the single-record generateOutreachDraft path, which
    // the batch generator historically skipped — leaving campaign drafts voice-
    // ungrounded, history-blind, and unaware of the client's own legislative
    // agenda or who the recipient actually is. All are best-effort: a null/empty
    // result simply omits that context, never blocks a draft.

    // Author voice: sender writing-style + client soul/compass memory. Recipient-
    // invariant, so resolve once and reuse. Hoisted into the prompt's AUTHOR
    // VOICE section by buildOutreachPrompt (it reads context.userWritingStyle).
    const voiceBlock = await this.loadUserVoiceBlock(ctx, clientId ?? null).catch(() => null);
    // W5.6: append the author's own recent sent-outreach excerpts (PII-stripped)
    // so drafts mirror their voice. Outreach-only (not in the shared voice block).
    const voiceFewShots = await this.outreachVoiceFewShots(ctx).catch(() => null);
    const userWritingStyle = [voiceBlock, voiceFewShots].filter(Boolean).join('\n\n') || null;

    // Client's tracked legislation with latest action — a timely "reason to write
    // now" hook. Client-level, so resolve once.
    const trackedBillsBlock = clientId
      ? await this.outreachTrackedBillsBlock(ctx, clientId).catch(() => null)
      : null;

    // W5 context channels, all client-level (resolved once): the watchlist
    // priority issues, the tracked-bill ids (for the per-recipient vote join),
    // and the upcoming-hearings window (filtered per recipient by committee).
    const watchlistBlock = clientId
      ? await this.outreachClientWatchlistBlock(ctx, clientId).catch(() => null)
      : null;
    const trackedBillIds = clientId
      ? await this.outreachTrackedBillIds(ctx, clientId).catch(() => [])
      : [];

    // Rich client-profile context (OUTREACH_CLIENT_PROFILE, per-tenant flag). When
    // ON, resolve the recipient-INVARIANT profile blocks once per campaign — the
    // "people this client works with" roster and the coordinated target-office
    // map. Off (or no clientId) → null, so the context object omits them and the
    // prompt is byte-identical to today.
    const clientProfileOn =
      !!clientId &&
      outreachClientProfileEnabled(
        (
          await this.prisma
            .withTenant(ctx.tenantId, (tx) =>
              tx.tenant.findFirst({ where: { id: ctx.tenantId }, select: { settings: true } }),
            )
            .catch(() => null)
        )?.settings,
      );
    const clientPeopleBlock =
      clientProfileOn && clientId
        ? await this.outreachClientPeopleBlock(ctx, clientId).catch(() => null)
        : null;
    const clientTargetOfficesBlock =
      clientProfileOn && clientId
        ? await this.outreachClientTargetOfficesBlock(ctx, clientId).catch(() => null)
        : null;
    const upcomingHearings = await this.outreachUpcomingHearings().catch(() => []);

    // Congressional directory profiles for the recipients, resolved in ONE
    // directory scan for the whole batch (the dataset is cached in-memory but
    // scanning it per recipient would be wasteful), then looked up by email
    // inside the per-recipient worker below.
    const batchRecipientEmails = unique(
      recipients
        .map((r) => (r as Record<string, unknown>).email?.toString()?.trim().toLowerCase() ?? '')
        .filter(Boolean),
    );
    const directoryByEmail = new Map<string, DirectoryEmailMatch>();
    if (batchRecipientEmails.length) {
      // Size the cap to the batch: findContactsByEmails truncates the COMBINED
      // match list (not per-email), so a fixed cap would silently drop profiles
      // for large audiences (e.g. a committee-wide send).
      const matches = await this.directory
        .findContactsByEmails(batchRecipientEmails, Math.max(batchRecipientEmails.length, 200))
        .catch(() => [] as DirectoryEmailMatch[]);
      for (const match of matches) {
        const key = match.attendeeEmail.toLowerCase();
        if (!directoryByEmail.has(key)) directoryByEmail.set(key, match);
      }
    }

    // Recipient correspondence (meetings they attended + client mail threads),
    // resolved in TWO queries for the WHOLE batch and bucketed by email — never
    // per-recipient, which would fan out ~5 client-scoped queries × recipients.
    const { meetingsByEmail, threadsByEmail } = await this.batchRecipientCorrespondence(
      ctx,
      clientId ?? null,
      batchRecipientEmails,
    );

    // ---- Tier-2 context enrichment (computed once per campaign) ----

    // Client's live action recommendations (recommendedAction + why-it-matters),
    // a near-ready ask. Client-level.
    const actionsBlock = clientId
      ? await this.outreachActionsBlock(ctx, clientId).catch(() => null)
      : null;

    // Office-recommender "why this office is a fit for the client" reasoning
    // (one manual-refresh cache row per client), indexed by directory member id
    // for per-recipient lookup by directoryContactId.
    const { byMember: targetRecByMember, computedAt: targetRecComputedAt } = clientId
      ? await this.outreachTargetRecommendations(ctx, clientId).catch(() => ({
          byMember: new Map<string, OfficeRecommendation>(),
          computedAt: null as string | null,
        }))
      : { byMember: new Map<string, OfficeRecommendation>(), computedAt: null as string | null };

    // Recent member press for the recipients, batched by bioguide (bioguide comes
    // from the directory match resolved above; member_press_item is a GLOBAL,
    // non-RLS table so it is read directly, not via withTenant).
    const batchBioguideIds = unique(
      Array.from(directoryByEmail.values())
        .map((match) => match.member?.bioguideId ?? '')
        .filter(Boolean),
    );
    const pressByBioguide = await this.outreachMemberPress(batchBioguideIds).catch(
      () => new Map<string, unknown[]>(),
    );

    // W5 batched per-recipient channels: prior-outreach dedup (by email) and the
    // recipient's votes on tracked bills (by bioguide). One query each.
    const priorContactByEmail = await this.outreachPriorContactByEmail(
      ctx,
      clientId ?? null,
      batchRecipientEmails,
    ).catch(() => new Map<string, { sentAt: Date; subject: string | null }>());
    const votesByBioguide = await this.outreachRelevantVotesByBioguide(
      batchBioguideIds,
      trackedBillIds,
    ).catch(() => new Map<string, string>());

    // Generate per-recipient drafts with bounded concurrency. This was a
    // sequential await-loop, so a campaign's wall-clock was sum-of-all-calls
    // and large batches timed out before every draft came back. Running a few
    // at a time keeps total latency roughly batch/CONCURRENCY while staying
    // well under the AI provider's rate limits. Results stay in recipient
    // order (mapWithConcurrency guarantees it) and every recipient still gets
    // an entry, because the worker catches its own errors and yields a blank
    // draft — identical to the old per-iteration try/catch behavior.
    const OUTREACH_GEN_CONCURRENCY = 4;
    // Resolve the auditor mode ONCE per campaign (all recipients share the
    // tenant) — the per-recipient worker below reads this via closure so a
    // batch never fans out N tenant.settings reads (Phase 2 per-tenant flag).
    const campaignAuditorMode = await resolveTenantAuditorMode(this.prisma, ctx.tenantId);
    const generateForRecipient = async (
      recipient: (typeof recipients)[number],
      index: number,
      creds: ResolvedAiCredential[],
    ): Promise<{ result: OutreachBatchDraftResult; provider: string | null }> => {
      // Must match the frontend's recipientKey() chain (id first) so generated
      // drafts land under the key the wizard looks them up by. Previously this
      // started at directoryContactId, so to-clients recipients (which have
      // `id` but no directoryContactId) got keyed by email and the wizard
      // showed "no draft". The final fallback is the recipient's original
      // index (was `results.length` in the old sequential loop — identical
      // value, but stable now that generation runs concurrently).
      const recipientId =
        (recipient as Record<string, unknown>).id?.toString() ||
        (recipient as Record<string, unknown>).directoryContactId?.toString() ||
        (recipient as Record<string, unknown>).email?.toString() ||
        (recipient as Record<string, unknown>).name?.toString() ||
        String(index);

      // Per-recipient scoped context, drawn from contextItems[].scope == this
      // recipient's stable key. The wizard's recipient key is the same fallback
      // chain used by recipientKey() on the frontend, so look up by every
      // identifier we have rather than guessing.
      const recipientKeyCandidates = [
        (recipient as Record<string, unknown>).id?.toString(),
        (recipient as Record<string, unknown>).directoryContactId?.toString(),
        (recipient as Record<string, unknown>).email?.toString(),
        (recipient as Record<string, unknown>).name?.toString(),
      ].filter((s): s is string => Boolean(s));
      const personalItems = recipientKeyCandidates.flatMap(
        (k) => recipientScopedItems.get(k) ?? [],
      );
      const personalContextText = personalItems.length
        ? `Personalized context for this recipient:\n${formatItems(personalItems)}`
        : null;
      const combinedContextNotes = [sharedContextText, personalContextText]
        .filter((s): s is string => Boolean(s))
        .join('\n\n');

      try {
        // Per-recipient enrichment: directory profile + "why this office fits"
        // reasoning (Tier-1/2), the recipient's prior correspondence, and their
        // recent press. Keyed on email (directory/meetings/mail) and on the
        // recipient's directory member id (target recs, joined to bioguide for
        // press). Failures degrade to nothing via the batch helpers.
        const recipientEmailLower =
          (recipient as Record<string, unknown>).email?.toString()?.trim().toLowerCase() || null;
        const directoryMatch = recipientEmailLower
          ? (directoryByEmail.get(recipientEmailLower) ?? null)
          : null;
        const recipientDirectoryId =
          (recipient as Record<string, unknown>).directoryContactId?.toString() || null;
        const targetRec = recipientDirectoryId
          ? targetRecByMember.get(recipientDirectoryId)
          : undefined;
        // Directory profile ("who") + target rationale ("why them") form one
        // hoisted RECIPIENT PROFILE section.
        const recipientProfile =
          [
            formatRecipientDirectoryProfile(directoryMatch),
            formatTargetRationale(targetRec, targetRecComputedAt),
          ]
            .filter(Boolean)
            .join(' ') || null;
        const bioguideId = directoryMatch?.member?.bioguideId || null;
        const recentNews = bioguideId ? (pressByBioguide.get(bioguideId) ?? []) : [];
        const meetingHistory = recipientEmailLower
          ? (meetingsByEmail.get(recipientEmailLower) ?? [])
          : [];
        const emailHistory = recipientEmailLower
          ? (threadsByEmail.get(recipientEmailLower) ?? [])
          : [];

        // W5 per-recipient channels (all per-member ⇒ suppressed for a group,
        // like the other per-member enrichment above; watchlist is client-level
        // and included for groups too).
        const relevantVotes = bioguideId ? (votesByBioguide.get(bioguideId) ?? null) : null;
        const upcomingHearingsBlock = this.renderRecipientHearings(
          upcomingHearings,
          directoryMatch?.member?.committees ?? [],
        );
        const priorContact = recipientEmailLower
          ? (priorContactByEmail.get(recipientEmailLower) ?? null)
          : null;
        const priorOutreachBlock = priorContact
          ? `Your firm last emailed this recipient on ${priorContact.sentAt
              .toISOString()
              .slice(
                0,
                10,
              )}${priorContact.subject ? ` re: "${priorContact.subject}"` : ''} — do not repeat that ask verbatim; acknowledge or build on it.`
          : null;

        const context: Record<string, unknown> = {
          tone: tone ?? 'professional',
          ...(direction ? { direction } : {}),
          ...(senderName ? { senderName } : {}),
          ...(senderSignature ? { senderSignature } : {}),
          ...(userWritingStyle ? { userWritingStyle } : {}),
          // Per-member fields (profile, that member's press / meeting / email
          // history) are suppressed for a group: they describe ONE member and
          // would bias a one-email-to-all group draft toward that member.
          ...(recipientProfile && !isGroup ? { recipientProfile } : {}),
          ...(trackedBillsBlock ? { trackedBills: trackedBillsBlock } : {}),
          ...(actionsBlock ? { actionRecommendations: actionsBlock } : {}),
          ...(watchlistBlock ? { clientWatchlist: watchlistBlock } : {}),
          ...(recentNews.length && !isGroup ? { recentNews } : {}),
          ...(meetingHistory.length && !isGroup ? { meetingHistory } : {}),
          ...(emailHistory.length && !isGroup ? { emailHistory } : {}),
          ...(relevantVotes && !isGroup ? { relevantVotes } : {}),
          ...(upcomingHearingsBlock && !isGroup ? { upcomingHearings: upcomingHearingsBlock } : {}),
          ...(priorOutreachBlock && !isGroup ? { priorOutreach: priorOutreachBlock } : {}),
          ...(insightsContext ? { insights: insightsContext } : {}),
          ...(additionalContext ? { additionalContext } : {}),
          ...(combinedContextNotes ? { contextItems: combinedContextNotes } : {}),
          ...(clientContextForCampaign ? { clientContext: clientContextForCampaign } : {}),
          // Rich client-profile blocks (OUTREACH_CLIENT_PROFILE) — client-level /
          // recipient-invariant, resolved once above (null when the flag is off).
          ...(clientPeopleBlock ? { clientPeople: clientPeopleBlock } : {}),
          ...(clientTargetOfficesBlock ? { clientTargetOffices: clientTargetOfficesBlock } : {}),
        };

        const generated = await this.ai.generateOutreachDraft(
          {
            workflow: 'campaign',
            client,
            recipients: [recipient as unknown as Record<string, unknown>],
            context,
            promptTemplate: 'custom',
            // In revise mode the freeform instruction becomes the objective the
            // revision-mode prompt edits toward; otherwise the campaign prompt.
            objective: isReviseSingle && reviseInstruction ? reviseInstruction : templatePrompt,
            ...(audienceKind ? { audienceKind } : {}),
            ...(isReviseSingle ? { existingSubject, existingBody } : {}),
          },
          ctx,
          // Campaign-sticky provider (M2/W3.2): use the pinned credential(s) the
          // batch resolved once, so every recipient in this send uses the same
          // provider+model — no mid-campaign voice split from a per-recipient
          // fallback.
          { creds },
        );
        // One usage event per recipient draft; rides inside the concurrent
        // worker so metering overlaps generation instead of serializing it.
        await this.recordAiUsage(ctx, 'outreach_campaign', generated);

        // Wave-2 post-hoc grounding auditor on the OUTREACH surface — SHADOW by
        // default (MERI_AUDITOR_MODE off = no-op). Re-derives ground truth from
        // the SAME PE/bill truth blocks already fed into THIS recipient's prompt
        // (via enrichOutreachContextItems/outreachTruthByItemId — only items
        // actually in scope for this recipient: shared + their personal items)
        // and flags any contradiction in the drafted body. Fully guarded: a bug
        // here can NEVER turn a good draft into an error, and it never touches
        // subject/body — degraded mode (annotate/enforce only) appends a line
        // to the INTERNAL contextNote the lobbyist sees, never the recipient.
        let auditorContextNote: string | undefined;
        // held: set true only when the auditor returns decision==='hold' (enforce
        // mode + a finding on this blocking surface). It flips the returned
        // status to 'held', which the wizard treats as non-sendable — the draft
        // is shown for review (with the internal contextNote) but excluded from
        // the send. Inert under shadow/annotate (decision is never 'hold' there).
        let recipientHeld = false;
        const auditorMode = campaignAuditorMode;
        if (auditorMode !== 'off' && generated.body.trim().length > 0) {
          try {
            const usedItems = [...sharedItems, ...personalItems];
            const ledgerEntries: LedgerEntry[] = [];
            for (const item of usedItems) {
              const truth = outreachTruthByItemId.get(item.id);
              if (!truth) continue;
              if (truth.kind === 'bill') {
                const b = truth.raw;
                ledgerEntries.push({
                  tool: 'get_bill_status',
                  serialized: item.body ?? '',
                  result: {
                    billId: b.id,
                    status: b.status,
                    statusAt: b.statusAt ? new Date(b.statusAt).toISOString() : null,
                    ...(b.sponsorName ? { sponsor: { name: b.sponsorName } } : {}),
                  },
                });
              } else {
                const pe = truth.raw;
                ledgerEntries.push({
                  tool: 'get_pe_budget_timeline',
                  serialized: item.body ?? '',
                  result: {
                    peCode: pe.peCode,
                    years: pe.years,
                    currentCycleFy: pe.currentCycleFy ?? null,
                    identifierKind:
                      pe.budgetExhibitType && /procurement line item/i.test(pe.budgetExhibitType)
                        ? 'procurement_line_item'
                        : 'pe',
                    generatedAt: new Date().toISOString(),
                  },
                });
              }
            }

            const verdict = runAuditor({
              output: generated.body,
              ledger: { entries: ledgerEntries },
              surface: 'outreach',
              mode: auditorMode,
            });
            if (verdict.findings.length > 0) {
              this.logger.warn(
                `[meri-auditor:${auditorMode}] outreach recipient ${recipientId} — ${verdict.findings.length} finding(s), ` +
                  `top=${verdict.topSeverity}, decision=${verdict.decision}: ` +
                  verdict.findings.map((f) => `${f.check}/${f.severity}`).join(', '),
              );
              await this.prisma.withTenant(ctx.tenantId, (tx) =>
                tx.meriAuditLedger.create({
                  data: {
                    tenantId: ctx.tenantId,
                    surface: 'outreach',
                    mode: auditorMode,
                    decision: verdict.decision,
                    topSeverity: verdict.topSeverity ?? null,
                    findingCount: verdict.findings.length,
                    findings: verdict.findings as unknown as Prisma.InputJsonValue,
                    outputChars: generated.body.length,
                  },
                }),
              );
              // Degraded mode (v3 plan §3.6): outreach bodies stay recipient-
              // facing and citation-free — never a banner in body/subject.
              // ANNOTATE/ENFORCE instead append to the INTERNAL contextNote;
              // inert while mode is shadow (the default) — this branch never
              // runs and auditorContextNote stays undefined.
              if (auditorMode === 'annotate' || auditorMode === 'enforce') {
                const checks = [...new Set(verdict.findings.map((f) => f.check))].join(', ');
                auditorContextNote = `⚠️ Unverified — ${verdict.findings.length} grounding finding(s) held for review (${checks}). Treat flagged claims as unconfirmed until a reviewer clears them.`;
              }
              // Enforce = hold: mark this recipient's draft non-sendable. Inert
              // under shadow/annotate (decision is 'hold' only in enforce mode).
              recipientHeld = verdict.decision === 'hold';
              if (recipientHeld) {
                await this.persistOutreachHold(ctx, {
                  recipientId,
                  recipientName: (recipient as Record<string, unknown>).name?.toString() ?? null,
                  clientId: clientId ?? null,
                  subject: generated.subject,
                  body: generated.body,
                  findings: verdict.findings,
                });
              }
            }
          } catch (auditErr) {
            this.logger.warn(
              `[meri-auditor] outreach audit failed for recipient ${recipientId} (draft unaffected): ${(auditErr as Error).message}`,
            );
          }
        }

        return {
          result: {
            recipientId,
            subject: generated.subject,
            body: generated.body,
            status: (recipientHeld ? 'held' : 'ready') as 'ready' | 'held',
            ...(auditorContextNote ? { contextNote: auditorContextNote } : {}),
          },
          provider: generated.provider,
        };
      } catch (err) {
        this.logger.warn(
          `Batch email generation failed for recipient ${recipientId}: ${(err as Error).message}`,
        );
        // Tag the failure explicitly so the wizard classifies it as 'error'
        // from the moment it responds — never a blank draft masquerading as
        // 'ready'. Sendability gates on this status, not on empty content.
        return {
          result: {
            recipientId,
            subject: '',
            body: '',
            status: 'error' as const,
            error: (err as Error).message,
          },
          provider: null,
        };
      }
    };

    // Campaign-sticky provider (M2/W3.2): resolve the credential order ONCE for
    // the whole campaign (Anthropic-first per D2 when configured). Empty ⇒ AI is
    // not configured; fail the whole batch loudly rather than emitting N per-item
    // "not configured" errors.
    const campaignCreds = await this.ai.resolveOutreachCredentials(ctx);
    if (!campaignCreds.length) {
      throw new ServiceUnavailableException(
        'Outreach drafting is not configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY (or a tenant AI key).',
      );
    }

    // Establish + pin the provider on recipient #1 (which ALSO warms the v2 prompt
    // cache: its cache WRITE lands before the fan-out so drafts 2..N read the
    // cached byte-stable prefix — W3.3). Recipient #1 may fall back across the full
    // ordered list; whichever provider wins is then PINNED for every other
    // recipient so one send never mixes provider voices. If #1 fails outright,
    // there is nothing to pin, so the rest fall back across the full list too.
    let results: Array<OutreachBatchDraftResult>;
    if (recipients.length > 1) {
      const head = await generateForRecipient(recipients[0]!, 0, campaignCreds);
      const pinnedCreds =
        head.provider != null
          ? campaignCreds.filter((c) => c.provider === head.provider)
          : campaignCreds;
      const tail = await mapWithConcurrency(
        recipients.slice(1),
        OUTREACH_GEN_CONCURRENCY,
        (recipient, i) => generateForRecipient(recipient, i + 1, pinnedCreds).then((r) => r.result),
      );
      results = [head.result, ...tail];
    } else {
      results = [(await generateForRecipient(recipients[0]!, 0, campaignCreds)).result];
    }

    // Soft-warn banner (W3.4): surfaced once the tenant crosses 80% of the daily
    // budget so the human sees it coming before the hard-stop.
    const budgetWarning = budget.softWarn
      ? `Your organization has used ${Math.round(budget.ratio * 100)}% of today's outreach AI limit.`
      : undefined;

    return { results, ...(budgetWarning ? { budgetWarning } : {}) };
  }

  /**
   * Send the v2 wizard's per-recipient drafts directly from the user's
   * connected inbox. Each recipient receives their own personalized draft;
   * the recipient's `cc`/`bcc` lists are copied onto that one email. In
   * `testMode` a single [TEST] copy is sent to the logged-in user so they
   * can preview formatting before the real send.
   */
  /**
   * §3.3 server-side outreach hold (defense-in-depth): a HELD draft becomes a
   * durable review_request keyed by CONTENT (recipient + exact subject/body),
   * and sendBatchEmails refuses any draft whose content key has a non-approved
   * review. The wizard's client-side 'held' handling stays the first line;
   * this closes the direct-API / wizard-bug bypass. Fail-open on persistence
   * errors (loud log): generation must never lose a draft because the hold row
   * failed — the client-side gate still applies to that draft.
   */
  private async persistOutreachHold(
    ctx: TenantContext,
    held: {
      recipientId: string;
      recipientName: string | null;
      clientId: string | null;
      subject: string;
      body: string;
      findings: unknown[];
    },
  ): Promise<void> {
    try {
      const subjectId = outreachDraftHoldKey(held.recipientId, held.subject, held.body);
      const findingSummary = (held.findings as Array<Record<string, unknown>>)
        .map((f) => `${String(f.check ?? '?')} (${String(f.severity ?? '?')})`)
        .join(', ');
      await this.prisma.withTenant(ctx.tenantId, async (tx) => {
        // Idempotent per content key: a regenerate that reproduces the same
        // held text must not stack duplicate pending reviews.
        const existing = await tx.reviewRequest.findFirst({
          where: {
            tenantId: ctx.tenantId,
            subjectType: OUTREACH_HOLD_SUBJECT_TYPE,
            subjectId,
            status: 'pending',
          },
          select: { id: true },
        });
        if (existing) return;
        await tx.reviewRequest.create({
          data: {
            tenantId: ctx.tenantId,
            // Outreach is an external send — the blueprint's restricted tier.
            riskTier: DELIVERABLE_RISK_TIERS.external_send ?? 'restricted',
            surface: 'outreach',
            subjectType: OUTREACH_HOLD_SUBJECT_TYPE,
            subjectId,
            clientId: held.clientId,
            title: `Held outreach draft — ${held.recipientName || held.recipientId}`.slice(0, 300),
            reason:
              `Grounding auditor held this draft under enforce mode` +
              (findingSummary ? ` (${findingSummary})` : '') +
              `. Approving releases the EXACT held text for sending; any edit produces new content that regenerates its own verdict.`,
            payload: {
              recipientId: held.recipientId,
              subject: held.subject,
              body: held.body,
              findings: held.findings,
            } as Prisma.InputJsonValue,
            requestedBy: ctx.userId ?? null,
          },
        });
      });
    } catch (e) {
      this.logger.error(
        `outreach hold persistence FAILED — the server-side send gate will not cover this draft ` +
          `(the wizard's client-side held status still applies): ${(e as Error).message}`,
      );
    }
  }

  async sendBatchEmails(ctx: TenantContext, input: SendBatchEmailInput) {
    const { recipients, drafts, testMode } = input;
    if (!drafts.length) {
      throw new BadRequestException('No drafts to send. Generate emails first.');
    }
    // v2 Generate & Review drafts are HTML; older/plain drafts are Text. Rendering
    // (sanitize allowlist + plaintext escape + signature append) is the shared
    // OutreachEmailRenderer (W6.1) so every send path produces identical output.
    const renderBody = renderOutreachBody;

    const connection = await this.findCampaignSendConnection(ctx, input.senderConnectionId);

    // Load the sender once: their inbox email (for test mode) and their saved,
    // already-server-sanitized email signature. We append the signature when the
    // caller asks (per-campaign toggle) or, absent that, when the user opted in
    // by default (emailSignatureEnabled). The signature was sanitized at save
    // (sanitize-signature.ts), so it's appended after the body's own sanitize
    // WITHOUT re-stripping — that's how branded markup (logos/tables) survives.
    const sender = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.user.findUnique({
        where: { id: ctx.userId },
        select: {
          email: true,
          firstName: true,
          emailSignatureHtml: true,
          emailSignatureEnabled: true,
        },
      }),
    );
    const appendSignature = input.appendSignature ?? sender?.emailSignatureEnabled ?? false;
    // Re-sanitize on read (idempotent, once per send). The stored value is
    // already sanitized by the PUT /me/email-signature path, but re-running here
    // means even a future writer that bypasses that path can never turn this
    // verbatim append into a stored-XSS sink into outbound email.
    const signatureHtml =
      appendSignature && sender?.emailSignatureHtml
        ? sanitizeSignatureHtml(sender.emailSignatureHtml)
        : '';

    // Signature append uses the shared renderer (W6.1); bind the resolved
    // signature so call sites stay `withSignature(rendered)`.
    const withSignature = (rendered: RenderedOutreachBody): RenderedOutreachBody =>
      appendOutreachSignature(rendered, signatureHtml);

    // Resolve attachments once (same set for every recipient). Files above the
    // Graph simple-send inline limit (~3MB) are skipped and reported back; larger
    // files would need a Graph upload session on a draft message.
    const GRAPH_INLINE_ATTACHMENT_MAX = 3 * 1024 * 1024;
    const skippedAttachments: string[] = [];
    const graphAttachments: Array<{ name: string; contentType: string; contentBytes: string }> = [];
    if (input.attachmentIds?.length) {
      const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.engagementAttachment.findMany({
          where: { tenantId: ctx.tenantId, id: { in: input.attachmentIds! } },
        }),
      );
      for (const row of rows) {
        // Skip without downloading when the stored size is known to be too big;
        // otherwise verify the actual byte length after fetching (byteSize can
        // be null if S3 HeadObject didn't report a length at confirm time).
        if (row.byteSize != null && row.byteSize > GRAPH_INLINE_ATTACHMENT_MAX) {
          skippedAttachments.push(row.fileName);
          continue;
        }
        const bytes = await this.readAttachmentBytes(row.s3Key);
        if (bytes.length > GRAPH_INLINE_ATTACHMENT_MAX) {
          skippedAttachments.push(row.fileName);
          continue;
        }
        graphAttachments.push({
          name: row.fileName,
          contentType: row.contentType,
          contentBytes: bytes.toString('base64'),
        });
      }
    }
    const attachmentsForSend = graphAttachments.length ? graphAttachments : undefined;

    // Test mode: one copy to the logged-in user, no real recipients touched.
    // Includes the signature (when active) so the preview matches the real send.
    if (testMode) {
      if (!sender?.email) throw new BadRequestException('Your user has no email on file');
      const sample = drafts.find((d) => d.subject?.trim() || d.body?.trim()) ?? drafts[0]!;
      const rendered = withSignature(renderBody(sample.body || '(empty draft)'));
      await this.mailSender.sendMail(ctx, connection, {
        subject: `[TEST] ${sample.subject || 'Outreach preview'}`,
        body: rendered.content,
        bodyContentType: rendered.contentType,
        toRecipients: [{ email: sender.email, name: sender.firstName ?? null }],
        attachments: attachmentsForSend,
      });
      return {
        test: true,
        sentTo: sender.email,
        sent: 1,
        failed: 0,
        errors: [] as Array<{ email: string; message: string }>,
        skippedAttachments,
      };
    }

    // Match each recipient to its draft using the same id fallback chain the
    // frontend's recipientKey() uses, so per-recipient drafts line up.
    const draftById = new Map(drafts.map((d) => [d.recipientId, d]));
    const findDraft = (r: OutreachRecipientInput) => {
      for (const key of [r.id, r.directoryContactId, r.email, r.name]) {
        if (key && draftById.has(key)) return draftById.get(key)!;
      }
      return undefined;
    };

    // §3.3 server-side hold gate: refuse to send any draft whose EXACT content
    // was held by the grounding auditor and not yet approved in Reviews. The
    // content key matches persistOutreachHold's, so an unedited held draft is
    // blocked here no matter what the caller claims — the wizard's client-side
    // 'held' status is UX, this is the enforcement boundary. One batch lookup.
    const holdKeys = [
      ...new Set(drafts.map((d) => outreachDraftHoldKey(d.recipientId, d.subject, d.body))),
    ];
    const openHolds = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.reviewRequest.findMany({
        where: {
          tenantId: ctx.tenantId,
          subjectType: OUTREACH_HOLD_SUBJECT_TYPE,
          subjectId: { in: holdKeys },
          status: { in: [...OUTREACH_HOLD_BLOCKING_STATUSES] },
        },
        select: { subjectId: true },
      }),
    );
    const blockedKeys = new Set(openHolds.map((h) => h.subjectId));

    const sent: Array<{ email: string; name: string | null; sentAt: string }> = [];
    const errors: Array<{ email: string; message: string }> = [];
    let heldCount = 0;

    for (const recipient of recipients) {
      // A group representative carries every member in groupMembers → ONE shared
      // email with all of them in To. Everyone else is a single To recipient.
      const groupTo = (recipient.groupMembers ?? [])
        .map((m) => ({ email: (m.email ?? '').trim(), name: m.name ?? null }))
        .filter((m) => m.email);
      const toRecipients = groupTo.length
        ? groupTo
        : recipient.email
          ? [{ email: recipient.email, name: recipient.name ?? null }]
          : [];
      if (toRecipients.length === 0) {
        errors.push({
          email: recipient.name || '(no email)',
          message: 'Recipient is missing an email address',
        });
        continue;
      }
      const draft = findDraft(recipient);
      if (!draft || (!draft.subject?.trim() && !draft.body?.trim())) {
        errors.push({
          email: recipient.email || recipient.name || '(group)',
          message: 'No generated draft for this recipient',
        });
        continue;
      }
      if (blockedKeys.has(outreachDraftHoldKey(draft.recipientId, draft.subject, draft.body))) {
        heldCount++;
        errors.push({
          email: recipient.email || recipient.name || '(group)',
          message:
            'Draft is held by the grounding auditor — a reviewer must approve it in Reviews before it can be sent.',
        });
        continue;
      }
      try {
        const rendered = withSignature(renderBody(draft.body));
        await this.mailSender.sendMail(ctx, connection, {
          subject: draft.subject,
          body: rendered.content,
          bodyContentType: rendered.contentType,
          toRecipients,
          ccRecipients: (recipient.cc ?? [])
            .filter((e) => e?.trim())
            .map((email) => ({ email: email.trim() })),
          bccRecipients: (recipient.bcc ?? [])
            .filter((e) => e?.trim())
            .map((email) => ({ email: email.trim() })),
          attachments: attachmentsForSend,
        });
        sent.push({
          email: recipient.email || toRecipients[0]!.email,
          name: recipient.name ?? null,
          sentAt: new Date().toISOString(),
        });
      } catch (error) {
        errors.push({
          email: recipient.email || recipient.name || '(group)',
          message: emailSendErrorMessage(error),
        });
      }
    }

    // Persist a Sent record so every real send shows up in Outreach → Sent.
    // Before this, batch sends went out via Graph but left no OutreachRecord,
    // so the Sent history stayed empty. Wrapped so a persistence failure can
    // never fail the send itself — the emails have already gone out.
    let persistedRecordId: string | null = null;
    try {
      persistedRecordId = await this.persistSentBatchRecord(ctx, input, {
        sent,
        errors,
        drafts,
      });
    } catch (error) {
      this.logger.error(
        `Batch send succeeded but persisting the Sent record failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return {
      test: false,
      sent: sent.length,
      failed: errors.length,
      /** Of `failed`, how many were refused by the server-side auditor hold gate. */
      held: heldCount,
      errors,
      sentRecipients: sent,
      skippedAttachments,
      engagementId: persistedRecordId,
    };
  }

  /**
   * Persist (create or update) an OutreachRecord reflecting the outcome of a
   * batch send so it appears in Outreach → Sent. If the wizard already saved a
   * draft (input.engagementId), that record is flipped draft → sent/failed in
   * place; otherwise a fresh record is created. A partial send (some sent, some
   * failed) is still recorded as 'sent' — anything that went out must show up.
   */
  private async persistSentBatchRecord(
    ctx: TenantContext,
    input: SendBatchEmailInput,
    outcome: {
      sent: Array<{ email: string; name: string | null; sentAt: string }>;
      errors: Array<{ email: string; message: string }>;
      drafts: SendBatchDraftInput[];
    },
  ): Promise<string | null> {
    const { sent, errors, drafts } = outcome;
    // Nothing actually attempted/sent and no failures to record → skip.
    if (sent.length === 0 && errors.length === 0) return null;

    const direction = normalizeOutreachDirection(input.direction);
    const recipients = applyOutreachDirection(
      normalizeOutreachRecipients(input.recipients),
      direction,
    );
    const firstDraft = drafts.find((d) => d.subject?.trim() || d.body?.trim()) ?? drafts[0];
    const subject = optionalReportText(firstDraft?.subject, 300);
    // The readonly Sent view renders `body` as plain text in a <pre>, so strip
    // tags/entities from the (possibly HTML) draft to a readable summary.
    const bodyText = firstDraft?.body
      ? firstDraft.body
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/(?:p|div|li|h[1-6]|tr)>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/gi, ' ')
          .replace(/&amp;/gi, '&')
          .replace(/&lt;/gi, '<')
          .replace(/&gt;/gi, '>')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
          .slice(0, 20_000) || null
      : null;
    const title = (input.campaignName?.trim() || subject || 'Outreach').slice(0, 240) || 'Outreach';
    // Any success counts as sent; only a total failure is recorded as failed.
    const status: 'sent' | 'failed' = sent.length > 0 ? 'sent' : 'failed';
    const now = new Date();
    const stats = {
      provider: 'microsoft_graph',
      recipientsAttempted: sent.length + errors.length,
      recipientsSent: sent.length,
      recipientsFailed: errors.length,
      // Opens are NOT tracked (no tracking pixels — D8). Only real signals are
      // persisted; reply detection updates replyCount when it lands.
      replyCount: 0,
      sent,
      ...(errors.length ? { errors } : {}),
    };
    const campaignSend = {
      provider: 'microsoft_graph',
      completedAt: now.toISOString(),
      status,
      recipientsSent: sent.length,
      recipientsFailed: errors.length,
    };
    const clientId = input.clientId?.trim() || null;

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      // Update path: the wizard saved a draft first, so flip it in place.
      if (input.engagementId) {
        const existing = await tx.outreachRecord.findFirst({
          where: { id: input.engagementId, tenantId: ctx.tenantId, deletedAt: null },
        });
        if (existing) {
          const updated = await tx.outreachRecord.update({
            where: { id: existing.id },
            data: {
              status,
              sentAt: status === 'sent' ? now : null,
              ...(subject ? { subject } : {}),
              ...(bodyText ? { body: bodyText } : {}),
              recipients: recipients as unknown as Prisma.InputJsonValue,
              recipientCount: recipients.length,
              stats: stats as Prisma.InputJsonValue,
              metadata: mergeJsonObjects(existing.metadata, {
                direction,
                campaignSend,
              }) as Prisma.InputJsonValue,
            },
            select: { id: true },
          });
          return updated.id;
        }
        // engagementId was stale/foreign → fall through to create a new record.
      }

      const created = await tx.outreachRecord.create({
        data: {
          tenantId: ctx.tenantId,
          clientId,
          createdByUserId: ctx.userId,
          type: 'campaign',
          status,
          sentAt: status === 'sent' ? now : null,
          title,
          subject: subject ?? null,
          body: bodyText,
          recipients: recipients as unknown as Prisma.InputJsonValue,
          recipientCount: recipients.length,
          stats: stats as Prisma.InputJsonValue,
          metadata: { direction, campaignSend } as Prisma.InputJsonValue,
          lastStep: 7,
        },
        select: { id: true },
      });
      return created.id;
    });
  }

  async deleteOutreachRecord(ctx: TenantContext, id: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.outreachRecord.findFirst({
        where: { id, tenantId: ctx.tenantId, deletedAt: null },
      });
      if (!existing) throw new NotFoundException('Outreach record not found');
      const deletedAt = new Date();

      return tx.outreachRecord.update({
        where: { id },
        data: {
          deletedAt,
          deletedByUserId: ctx.userId,
          metadata: mergeJsonObjects(existing.metadata, {
            deletedFromCapiro: true,
            deletedAt: deletedAt.toISOString(),
            deletedByUserId: ctx.userId,
          }) as Prisma.InputJsonValue,
        },
        include: outreachInclude(),
      });
    });
  }

  /**
   * Restore a soft-deleted outreach record (the inverse of
   * {@link deleteOutreachRecord}). Clears the deletion tombstone and strips the
   * delete bookkeeping keys from metadata so the record returns to the normal
   * list exactly as it was. Scoped to the caller's tenant; only matches rows
   * that are currently soft-deleted.
   */
  async restoreOutreachRecord(ctx: TenantContext, id: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.outreachRecord.findFirst({
        where: { id, tenantId: ctx.tenantId, deletedAt: { not: null } },
      });
      if (!existing) throw new NotFoundException('Deleted outreach record not found');

      const metadata = { ...((existing.metadata as Record<string, unknown> | null) ?? {}) };
      delete metadata.deletedFromCapiro;
      delete metadata.deletedAt;
      delete metadata.deletedByUserId;

      return tx.outreachRecord.update({
        where: { id },
        data: {
          deletedAt: null,
          deletedByUserId: null,
          metadata: metadata as Prisma.InputJsonValue,
        },
        include: outreachInclude(),
      });
    });
  }

  listTasks(
    ctx: TenantContext,
    query: {
      clientId?: string;
      status?: EngagementTaskStatus;
      openOnly?: boolean;
      dueBefore?: Date;
      limit?: number;
    },
  ) {
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.engagementTask.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...(query.clientId ? { clientId: query.clientId } : {}),
          status: query.status
            ? query.status
            : query.openOnly
              ? {
                  in: [
                    EngagementTaskStatus.todo,
                    EngagementTaskStatus.in_progress,
                    EngagementTaskStatus.blocked,
                  ],
                }
              : { not: EngagementTaskStatus.canceled },
          ...(query.dueBefore ? { dueDate: { lte: query.dueBefore } } : {}),
        },
        include: {
          client: clientSummarySelect(),
          meeting: { select: { id: true, subject: true } },
        },
        orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
        ...(query.limit ? { take: Math.min(50, Math.max(1, query.limit)) } : {}),
      }),
    );
  }

  async reportOverview(ctx: TenantContext, query: EngagementReportQuery) {
    const period = normalizeReportPeriod(query.period);
    const cycle = reportPeriodWindow(period);
    const clientId = query.clientId?.trim() || undefined;
    const dateWhere =
      cycle.from && cycle.to
        ? {
            gte: cycle.from,
            lt: cycle.to,
          }
        : undefined;

    const data = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      if (clientId) {
        await ensureExists(
          tx.client.findFirst({
            where: { id: clientId, tenantId: ctx.tenantId },
            select: { id: true },
          }),
          'Client not found',
        );
      }

      const [storedTargets, meetings, messages, tasks] = await Promise.all([
        tx.engagementReportTargetOffice.findMany({
          where: {
            tenantId: ctx.tenantId,
            ...(clientId ? { OR: [{ clientId }, { scopeKey: 'all' }] } : {}),
          },
          include: { client: { select: { id: true, name: true } } },
          orderBy: [{ memberPrincipal: 'asc' }, { createdAt: 'asc' }],
        }),
        tx.meeting.findMany({
          where: {
            tenantId: ctx.tenantId,
            ...ownMeetingWhere(ctx.userId),
            ...(clientId ? { clientId } : {}),
            ...(dateWhere ? { startsAt: dateWhere } : {}),
          },
          include: {
            client: { select: { id: true, name: true } },
            connection: { select: { accountEmail: true, displayName: true } },
            attendees: { select: { email: true, name: true, role: true } },
            preps: {
              select: { status: true },
              orderBy: { createdAt: 'desc' },
              take: 1,
            },
            tasks: {
              where: {
                status: { notIn: [EngagementTaskStatus.done, EngagementTaskStatus.canceled] },
              },
              select: { id: true, status: true },
            },
          },
          orderBy: { startsAt: 'asc' },
        }),
        tx.mailMessage.findMany({
          where: {
            tenantId: ctx.tenantId,
            ...ownMailMessageWhere(ctx.userId),
            ...(dateWhere
              ? {
                  OR: [{ sentAt: dateWhere }, { receivedAt: dateWhere }],
                }
              : {}),
            ...(clientId ? { thread: { clientId } } : {}),
          },
          select: {
            id: true,
            threadId: true,
            fromEmail: true,
            toRecipients: true,
            ccRecipients: true,
            bccRecipients: true,
            sentAt: true,
            receivedAt: true,
            metadata: true,
            connection: { select: { accountEmail: true, displayName: true } },
            thread: { select: { id: true, subject: true, clientId: true } },
          },
          orderBy: [{ sentAt: 'desc' }, { receivedAt: 'desc' }],
        }),
        tx.engagementTask.findMany({
          where: {
            tenantId: ctx.tenantId,
            ...(clientId ? { clientId } : {}),
            status: { notIn: [EngagementTaskStatus.done, EngagementTaskStatus.canceled] },
          },
          select: {
            id: true,
            title: true,
            clientId: true,
            meetingId: true,
            status: true,
          },
        }),
      ]);

      return { storedTargets, meetings, messages, tasks };
    });

    const emailUniverse = unique([
      ...data.meetings.flatMap((meeting) => [
        meeting.organizerEmail ?? '',
        ...meeting.attendees.map((attendee) => attendee.email ?? ''),
      ]),
      ...data.messages.flatMap((message) => mailMessageEmails(message)),
    ]).filter((email): email is string => Boolean(email));
    const directoryMatches = await this.directoryMatchesForReport(emailUniverse);
    const matchesByEmail = new Map<string, DirectoryEmailMatch[]>();
    for (const match of directoryMatches) {
      const email = normalizeEmailAddress(match.attendeeEmail);
      if (!email) continue;
      const matches = matchesByEmail.get(email) ?? [];
      matches.push(match);
      matchesByEmail.set(email, matches);
    }

    const rows = new Map<string, ReportTargetDraft>();
    const rowKey = (scopeKey: string, officeKey: string) => `${scopeKey}:${officeKey}`;
    const ensureRow = (input: {
      targetId?: string | null;
      clientId?: string | null;
      clientName?: string | null;
      scopeKey: string;
      officeKey: string;
      memberPrincipal: string;
      committee?: string | null;
      staffer?: string | null;
      building?: string | null;
      leadOwner?: string | null;
      source: string;
      storedPrepStatus?: ReportStatus;
      storedOutreachStatus?: ReportStatus;
      storedSubmissionStatus?: ReportStatus;
    }) => {
      const key = rowKey(input.scopeKey, input.officeKey);
      const existing = rows.get(key);
      if (existing) {
        existing.targetId = existing.targetId ?? input.targetId ?? null;
        existing.clientId = existing.clientId ?? input.clientId ?? null;
        existing.clientName = existing.clientName ?? input.clientName ?? null;
        existing.committee = existing.committee || input.committee || null;
        existing.staffer = existing.staffer || input.staffer || null;
        existing.building = existing.building || input.building || null;
        existing.leadOwner = existing.leadOwner || input.leadOwner || null;
        existing.source = existing.source === 'manual' ? existing.source : input.source;
        existing.storedPrepStatus = mergeStoredStatus(
          existing.storedPrepStatus,
          input.storedPrepStatus,
        );
        existing.storedOutreachStatus = mergeStoredStatus(
          existing.storedOutreachStatus,
          input.storedOutreachStatus,
        );
        existing.storedSubmissionStatus = mergeStoredStatus(
          existing.storedSubmissionStatus,
          input.storedSubmissionStatus,
        );
        return existing;
      }

      const created: ReportTargetDraft = {
        targetId: input.targetId ?? null,
        clientId: input.clientId ?? null,
        clientName: input.clientName ?? null,
        scopeKey: input.scopeKey,
        officeKey: input.officeKey,
        memberPrincipal: input.memberPrincipal,
        committee: input.committee ?? null,
        staffer: input.staffer ?? null,
        building: input.building ?? null,
        leadOwner: input.leadOwner ?? null,
        source: input.source,
        storedPrepStatus: input.storedPrepStatus ?? 'auto',
        storedOutreachStatus: input.storedOutreachStatus ?? 'auto',
        storedSubmissionStatus: input.storedSubmissionStatus ?? 'auto',
        meetingIds: new Set(),
        heldMeetingIds: new Set(),
        preparedMeetingIds: new Set(),
        approvedPrepMeetingIds: new Set(),
        meetings: new Map(),
        threadIds: new Set(),
        sentMessageIds: new Set(),
        pendingActionIds: new Set(),
      };
      rows.set(key, created);
      return created;
    };

    for (const target of data.storedTargets) {
      ensureRow({
        targetId: target.id,
        clientId: target.clientId,
        clientName: target.client?.name ?? null,
        scopeKey: target.scopeKey,
        officeKey: target.officeKey,
        memberPrincipal: target.memberPrincipal,
        committee: target.committee,
        staffer: target.staffer,
        building: target.building,
        leadOwner: target.leadOwner,
        source: target.source,
        storedPrepStatus: normalizeReportStatus(target.prepStatus),
        storedOutreachStatus: normalizeReportStatus(target.outreachStatus),
        storedSubmissionStatus: normalizeReportStatus(target.submissionStatus),
      });
    }

    const now = new Date();
    for (const meeting of data.meetings) {
      const meetingEmails = unique([
        meeting.organizerEmail ?? '',
        ...meeting.attendees.map((attendee) => attendee.email ?? ''),
      ]).filter((email): email is string => Boolean(email));
      const matches = uniqueDirectoryMatches(
        meetingEmails.flatMap(
          (email) => matchesByEmail.get(normalizeEmailAddress(email) ?? '') ?? [],
        ),
      );
      const meetingScopeKey = reportScopeKey(clientId ?? meeting.clientId ?? null);
      for (const match of matches) {
        const row = ensureRow({
          clientId: clientId ?? meeting.clientId,
          clientName: meeting.client?.name ?? null,
          scopeKey: meetingScopeKey,
          officeKey: reportOfficeKey(match),
          ...reportTargetDetails(match),
          leadOwner:
            meeting.connection?.displayName || meeting.connection?.accountEmail || undefined,
          source: 'directory',
        });
        row.meetingIds.add(meeting.id);
        if (meeting.endsAt <= now && meeting.status !== 'canceled')
          row.heldMeetingIds.add(meeting.id);
        if (meeting.preps[0]) row.preparedMeetingIds.add(meeting.id);
        if (meeting.preps[0]?.status === MeetingPrepStatus.approved) {
          row.approvedPrepMeetingIds.add(meeting.id);
        }
        for (const task of meeting.tasks) row.pendingActionIds.add(task.id);
        row.meetings.set(meeting.id, {
          id: meeting.id,
          subject: meeting.subject,
          startsAt: meeting.startsAt,
          endsAt: meeting.endsAt,
          location: meeting.location,
          externalUrl: readWebLink(meeting.metadata),
        });
      }
    }

    for (const message of data.messages) {
      const messageEmails = unique(mailMessageEmails(message)).filter((email): email is string =>
        Boolean(email),
      );
      const matches = uniqueDirectoryMatches(
        messageEmails.flatMap(
          (email) => matchesByEmail.get(normalizeEmailAddress(email) ?? '') ?? [],
        ),
      );
      if (!matches.length) continue;
      const messageScopeKey = reportScopeKey(clientId ?? message.thread.clientId ?? null);
      const isSent = isSentMailMessage(message.metadata);
      for (const match of matches) {
        const row = ensureRow({
          clientId: clientId ?? message.thread.clientId,
          scopeKey: messageScopeKey,
          officeKey: reportOfficeKey(match),
          ...reportTargetDetails(match),
          leadOwner:
            message.connection?.displayName || message.connection?.accountEmail || undefined,
          source: 'directory',
        });
        row.threadIds.add(message.threadId);
        if (isSent) row.sentMessageIds.add(message.id);
      }
    }

    const openTaskCount = data.tasks.length;
    const sentMessageIds = new Set(
      data.messages
        .filter((message) => isSentMailMessage(message.metadata))
        .map((message) => message.id),
    );
    const heldMeetingIds = new Set(
      data.meetings
        .filter((meeting) => meeting.endsAt <= now && meeting.status !== 'canceled')
        .map((meeting) => meeting.id),
    );

    const rowsOut = Array.from(rows.values())
      .map((row) => {
        const prepStatus = resolveReportStatus(row.storedPrepStatus, autoPrepStatus(row));
        const outreachStatus = resolveReportStatus(
          row.storedOutreachStatus,
          autoOutreachStatus(row),
        );
        const submissionStatus = resolveReportStatus(row.storedSubmissionStatus, 'not_started');
        return {
          targetId: row.targetId,
          clientId: row.clientId,
          clientName: row.clientName,
          scopeKey: row.scopeKey,
          officeKey: row.officeKey,
          memberPrincipal: row.memberPrincipal,
          committee: row.committee,
          staffer: row.staffer,
          building: row.building,
          leadOwner: row.leadOwner,
          meetingsHeld: row.heldMeetingIds.size,
          outreachSent: row.sentMessageIds.size,
          pendingActions: row.pendingActionIds.size,
          prepStatus,
          outreachStatus,
          submissionStatus,
          source: row.source,
          manuallyOverridden:
            row.storedPrepStatus !== 'auto' ||
            row.storedOutreachStatus !== 'auto' ||
            row.storedSubmissionStatus !== 'auto',
          meetings: Array.from(row.meetings.values()).sort(
            (left, right) => left.startsAt.getTime() - right.startsAt.getTime(),
          ),
        };
      })
      .sort((left, right) => left.memberPrincipal.localeCompare(right.memberPrincipal));

    return {
      cycle,
      summary: {
        targetOffices: rowsOut.length,
        meetingsHeld: heldMeetingIds.size,
        outreachSent: sentMessageIds.size,
        submissionsFiled: rowsOut.filter((row) => row.submissionStatus === 'complete').length,
        pendingActions: openTaskCount,
      },
      rows: rowsOut,
    };
  }

  async createReportTargetOffice(ctx: TenantContext, input: CreateReportTargetOfficeInput) {
    const clientId = input.clientId?.trim() || null;
    const scopeKey = reportScopeKey(clientId);
    const memberPrincipal = requiredReportText(input.memberPrincipal, 'memberPrincipal', 240);
    const officeKey = `manual:${randomUUID()}`;

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      if (clientId) {
        await ensureExists(
          tx.client.findFirst({
            where: { id: clientId, tenantId: ctx.tenantId },
            select: { id: true },
          }),
          'Client not found',
        );
      }

      return tx.engagementReportTargetOffice.create({
        data: {
          tenantId: ctx.tenantId,
          clientId,
          scopeKey,
          officeKey,
          memberPrincipal,
          committee: optionalReportText(input.committee, 120),
          staffer: optionalReportText(input.staffer, 160),
          building: optionalReportText(input.building, 120),
          leadOwner: optionalReportText(input.leadOwner, 120),
          source: 'manual',
          createdByUserId: ctx.userId,
        },
      });
    });
  }

  async upsertReportTargetOffice(ctx: TenantContext, input: UpsertReportTargetOfficeInput) {
    const clientId = input.clientId?.trim() || null;
    const scopeKey = reportScopeKey(clientId);
    const officeKey = requiredReportText(input.officeKey, 'officeKey', 240);
    const memberPrincipal = requiredReportText(input.memberPrincipal, 'memberPrincipal', 240);

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      if (clientId) {
        await ensureExists(
          tx.client.findFirst({
            where: { id: clientId, tenantId: ctx.tenantId },
            select: { id: true },
          }),
          'Client not found',
        );
      }

      return tx.engagementReportTargetOffice.upsert({
        where: {
          tenantId_scopeKey_officeKey: {
            tenantId: ctx.tenantId,
            scopeKey,
            officeKey,
          },
        },
        update: {
          memberPrincipal,
          committee: optionalReportText(input.committee, 120),
          staffer: optionalReportText(input.staffer, 160),
          building: optionalReportText(input.building, 120),
          leadOwner: optionalReportText(input.leadOwner, 120),
          ...(input.prepStatus ? { prepStatus: normalizeReportStatus(input.prepStatus) } : {}),
          ...(input.outreachStatus
            ? { outreachStatus: normalizeReportStatus(input.outreachStatus) }
            : {}),
          ...(input.submissionStatus
            ? { submissionStatus: normalizeReportStatus(input.submissionStatus) }
            : {}),
          source: input.source?.trim().slice(0, 80) || 'manual_override',
        },
        create: {
          tenantId: ctx.tenantId,
          clientId,
          scopeKey,
          officeKey,
          memberPrincipal,
          committee: optionalReportText(input.committee, 120),
          staffer: optionalReportText(input.staffer, 160),
          building: optionalReportText(input.building, 120),
          leadOwner: optionalReportText(input.leadOwner, 120),
          prepStatus: normalizeReportStatus(input.prepStatus),
          outreachStatus: normalizeReportStatus(input.outreachStatus),
          submissionStatus: normalizeReportStatus(input.submissionStatus),
          source: input.source?.trim().slice(0, 80) || 'manual_override',
          createdByUserId: ctx.userId,
        },
      });
    });
  }

  createTask(ctx: TenantContext, input: CreateTaskInput) {
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.engagementTask.create({
        data: {
          tenantId: ctx.tenantId,
          clientId: input.clientId ?? null,
          meetingId: input.meetingId ?? null,
          contactId: input.contactId ?? null,
          mailThreadId: input.mailThreadId ?? null,
          title: input.title.trim(),
          description: input.description?.trim() || null,
          ownerUserId: input.ownerUserId ?? null,
          dueDate: input.dueDate ? parseDate(input.dueDate, 'dueDate') : null,
          createdByUserId: ctx.userId,
        },
      }),
    );
  }

  async updateTask(ctx: TenantContext, id: string, input: UpdateTaskInput) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await ensureExists(tx.engagementTask.findUnique({ where: { id } }), 'Task not found');
      return tx.engagementTask.update({
        where: { id },
        data: {
          ...('title' in input ? { title: input.title?.trim() } : {}),
          ...('description' in input ? { description: input.description?.trim() || null } : {}),
          ...('ownerUserId' in input ? { ownerUserId: input.ownerUserId ?? null } : {}),
          ...('dueDate' in input
            ? { dueDate: input.dueDate ? parseDate(input.dueDate, 'dueDate') : null }
            : {}),
          ...('status' in input ? { status: input.status } : {}),
        },
      });
    });
  }

  async createMeetingNote(
    ctx: TenantContext,
    meetingId: string,
    input: { body: string; confidential?: boolean; accessLevel?: string },
  ) {
    const encrypted = this.notesCrypto.encrypt(input.body);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const meeting = await tx.meeting.findFirst({
        where: { id: meetingId, tenantId: ctx.tenantId, ...ownMeetingWhere(ctx.userId) },
      });
      if (!meeting) throw new NotFoundException('Meeting not found');
      return tx.meetingNote.create({
        data: {
          tenantId: ctx.tenantId,
          meetingId,
          clientId: meeting.clientId,
          authorUserId: ctx.userId,
          bodyCiphertext: encrypted.bodyCiphertext,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          keyVersion: encrypted.keyVersion,
          confidential: input.confidential ?? true,
          accessLevel: input.accessLevel ?? 'tenant_admins_and_author',
        },
        select: noteMetadataSelect(),
      });
    });
  }

  async updateMeetingNote(
    ctx: TenantContext,
    meetingId: string,
    noteId: string,
    input: { body: string; confidential?: boolean; accessLevel?: string },
  ) {
    const encrypted = this.notesCrypto.encrypt(input.body);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.ensureOwnMeeting(tx, ctx, meetingId);
      const note = await tx.meetingNote.findFirst({
        where: { id: noteId, tenantId: ctx.tenantId, meetingId },
        select: { id: true, authorUserId: true },
      });
      if (!note) throw new NotFoundException('Meeting note not found');
      if (!canEditEncryptedEntry(ctx, note)) {
        throw new ForbiddenException('You can only edit your own meeting notes');
      }

      return tx.meetingNote.update({
        where: { id: noteId },
        data: {
          bodyCiphertext: encrypted.bodyCiphertext,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          keyVersion: encrypted.keyVersion,
          ...(input.confidential === undefined ? {} : { confidential: input.confidential }),
          ...(input.accessLevel === undefined ? {} : { accessLevel: input.accessLevel }),
        },
        select: noteMetadataSelect(),
      });
    });
  }

  async createMeetingDebrief(
    ctx: TenantContext,
    meetingId: string,
    input: { body: string; confidential?: boolean; accessLevel?: string },
  ) {
    const encrypted = this.notesCrypto.encrypt(input.body);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const meeting = await tx.meeting.findFirst({
        where: { id: meetingId, tenantId: ctx.tenantId, ...ownMeetingWhere(ctx.userId) },
      });
      if (!meeting) throw new NotFoundException('Meeting not found');
      return tx.meetingDebrief.create({
        data: {
          tenantId: ctx.tenantId,
          meetingId,
          clientId: meeting.clientId,
          authorUserId: ctx.userId,
          bodyCiphertext: encrypted.bodyCiphertext,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          keyVersion: encrypted.keyVersion,
          confidential: input.confidential ?? true,
          accessLevel: input.accessLevel ?? 'tenant_members',
        },
        select: debriefMetadataSelect(),
      });
    });
  }

  async updateMeetingDebrief(
    ctx: TenantContext,
    meetingId: string,
    debriefId: string,
    input: { body: string; confidential?: boolean; accessLevel?: string },
  ) {
    const encrypted = this.notesCrypto.encrypt(input.body);
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.ensureOwnMeeting(tx, ctx, meetingId);
      const debrief = await tx.meetingDebrief.findFirst({
        where: { id: debriefId, tenantId: ctx.tenantId, meetingId },
        select: { id: true, authorUserId: true },
      });
      if (!debrief) throw new NotFoundException('Meeting debrief not found');
      if (!canEditEncryptedEntry(ctx, debrief)) {
        throw new ForbiddenException('You can only edit your own meeting debriefs');
      }

      return tx.meetingDebrief.update({
        where: { id: debriefId },
        data: {
          bodyCiphertext: encrypted.bodyCiphertext,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          keyVersion: encrypted.keyVersion,
          // A manual edit moves an approved/generated debrief back to `edited`
          // (mirrors updateMeetingPrep), so it must be re-approved before it
          // reaches the Library / is shareable.
          status: MeetingDebriefStatus.edited,
          ...(input.confidential === undefined ? {} : { confidential: input.confidential }),
          ...(input.accessLevel === undefined ? {} : { accessLevel: input.accessLevel }),
        },
        select: debriefMetadataSelect(),
      });
    });
  }

  /**
   * Approve a meeting debrief (Meetings v2 §5) — the symmetric counterpart to
   * approveMeetingPrep. Only an `approved` debrief is eligible for the Meeting
   * Library and for sharing. Reuses the same owner-guard + author/admin edit
   * check as updateMeetingDebrief.
   */
  async approveMeetingDebrief(ctx: TenantContext, meetingId: string, debriefId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await this.ensureOwnMeeting(tx, ctx, meetingId);
      const debrief = await tx.meetingDebrief.findFirst({
        where: { id: debriefId, tenantId: ctx.tenantId, meetingId },
        select: { id: true, authorUserId: true },
      });
      if (!debrief) throw new NotFoundException('Meeting debrief not found');
      if (!canEditEncryptedEntry(ctx, debrief)) {
        throw new ForbiddenException('You can only approve your own meeting debriefs');
      }
      return tx.meetingDebrief.update({
        where: { id: debriefId },
        data: { status: MeetingDebriefStatus.approved },
        select: debriefMetadataSelect(),
      });
    });
  }

  async generateMeetingDebriefDraft(
    ctx: TenantContext,
    meetingId: string,
    input: { method: 'upload' | 'manual' | 'voice'; sourceText: string },
  ) {
    const sourceText = input.sourceText.trim();
    if (!sourceText) throw new BadRequestException('sourceText is required');

    const context = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const meeting = await tx.meeting.findFirst({
        where: { id: meetingId, tenantId: ctx.tenantId, ...ownMeetingWhere(ctx.userId) },
        include: {
          client: true,
          attendees: true,
          attachments: { orderBy: { createdAt: 'desc' } },
          preps: { orderBy: { createdAt: 'desc' }, take: 1 },
          tasks: {
            where: {
              status: { notIn: [EngagementTaskStatus.done, EngagementTaskStatus.canceled] },
            },
          },
        },
      });
      if (!meeting) throw new NotFoundException('Meeting not found');

      const effectiveClientId = await this.resolveEffectiveMeetingClientId(tx, ctx, meeting);
      const effectiveClient =
        effectiveClientId && effectiveClientId !== meeting.clientId
          ? await tx.client.findUnique({ where: { id: effectiveClientId } })
          : meeting.client;

      const meetingAssociationWhere = effectiveClientId
        ? await this.clientMeetingAssociationWhere(tx, ctx.tenantId, effectiveClientId)
        : null;
      const recentMeetings = meetingAssociationWhere
        ? await tx.meeting.findMany({
            where: {
              AND: [
                {
                  tenantId: ctx.tenantId,
                  id: { not: meeting.id },
                  ...ownMeetingWhere(ctx.userId),
                },
                meetingAssociationWhere,
              ],
            },
            select: {
              id: true,
              subject: true,
              startsAt: true,
              endsAt: true,
              location: true,
              associationReason: true,
            },
            orderBy: { startsAt: 'desc' },
            take: 5,
          })
        : [];

      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      // Fetch recent email threads from last 30 days associated to this client only.
      // Do NOT infer context from attendee/to/cc domains, which can pull unrelated people.
      const threadFilters: Prisma.MailThreadWhereInput[] = [];
      if (effectiveClientId) {
        threadFilters.push(
          await this.clientMailThreadAssociationWhere(tx, ctx.tenantId, effectiveClientId),
        );
      }

      const recentThreads = threadFilters.length
        ? await tx.mailThread.findMany({
            where: {
              tenantId: ctx.tenantId,
              ...ownMailThreadWhere(ctx.userId),
              lastMessageAt: { gte: thirtyDaysAgo },
              OR: threadFilters,
            },
            select: {
              id: true,
              subject: true,
              snippet: true,
              lastMessageAt: true,
              status: true,
              messages: {
                select: {
                  fromEmail: true,
                  fromName: true,
                  subject: true,
                  bodyText: true,
                  sentAt: true,
                },
                orderBy: { sentAt: 'desc' },
                take: 3,
              },
            },
            orderBy: [{ lastMessageAt: 'desc' }, { updatedAt: 'desc' }],
            take: 15,
          })
        : [];

      return { meeting, client: effectiveClient, effectiveClientId, recentMeetings, recentThreads };
    });

    const [visibleNotes, clientContext, directoryProfiles] = await Promise.all([
      this.listMeetingNotes(ctx, meetingId)
        .then((notes) => notes.filter((note) => !note.restricted))
        .catch(() => []),
      context.effectiveClientId
        ? this.clientContext(ctx, context.effectiveClientId).catch(() => null)
        : Promise.resolve(null),
      this.directoryProfilesForMeeting(context.meeting).catch(() => []),
    ]);

    // Firm identity + author voice + client strategic memory — for FRAMING/tone
    // only (the debrief prompt is strictly grounded in the meeting notes and
    // labels this as background, never as meeting facts).
    const steeringContext = await this.loadUserVoiceBlock(
      ctx,
      context.client?.id ?? context.meeting.clientId ?? null,
    );
    const generated = await this.ai.generateMeetingDebrief(
      {
        meeting: pruneForAi(context.meeting),
        client: context.client ? pruneForAi(context.client) : null,
        attendees: context.meeting.attendees.map(pruneForAi),
        prep: context.meeting.preps[0] ? pruneForAi(context.meeting.preps[0]) : null,
        source: { method: input.method, text: sourceText },
        visibleNotes: visibleNotes.map(pruneForAi),
        clientContext: clientContext ? pruneForAi(clientContext) : null,
        congressionalDirectoryMatches: directoryProfiles.map(pruneForAi),
        recentMeetings: context.recentMeetings.map(pruneForAi),
        recentThreads: context.recentThreads.map(prepareThreadForAi),
        steeringContext,
      },
      ctx,
    );
    await this.recordAiUsage(ctx, 'meeting_debrief', generated);
    return generated;
  }

  async listMeetingNotes(ctx: TenantContext, meetingId: string) {
    const notes = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const meeting = await tx.meeting.findFirst({
        where: { id: meetingId, tenantId: ctx.tenantId, ...ownMeetingWhere(ctx.userId) },
        select: { id: true },
      });
      if (!meeting) throw new NotFoundException('Meeting not found');

      return tx.meetingNote.findMany({
        where: { tenantId: ctx.tenantId, meetingId },
        include: {
          author: { select: { id: true, email: true, firstName: true, lastName: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
    });

    return notes.map((note) => {
      const canReadBody = canReadEncryptedEntry(ctx, note);
      return {
        id: note.id,
        meetingId: note.meetingId,
        clientId: note.clientId,
        body: canReadBody
          ? this.notesCrypto.decrypt({
              bodyCiphertext: note.bodyCiphertext,
              iv: note.iv,
              authTag: note.authTag,
            })
          : null,
        confidential: note.confidential,
        accessLevel: note.accessLevel,
        keyVersion: note.keyVersion,
        authorUserId: note.authorUserId,
        author: note.author,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        restricted: !canReadBody,
      };
    });
  }

  async listMeetingDebriefs(ctx: TenantContext, meetingId: string) {
    const debriefs = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const meeting = await tx.meeting.findFirst({
        where: { id: meetingId, tenantId: ctx.tenantId, ...ownMeetingWhere(ctx.userId) },
        select: { id: true },
      });
      if (!meeting) throw new NotFoundException('Meeting not found');

      return tx.meetingDebrief.findMany({
        where: { tenantId: ctx.tenantId, meetingId },
        include: {
          author: { select: { id: true, email: true, firstName: true, lastName: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
    });

    return debriefs.map((debrief) => {
      const canReadBody = canReadEncryptedEntry(ctx, debrief);
      return {
        id: debrief.id,
        meetingId: debrief.meetingId,
        clientId: debrief.clientId,
        body: canReadBody
          ? this.notesCrypto.decrypt({
              bodyCiphertext: debrief.bodyCiphertext,
              iv: debrief.iv,
              authTag: debrief.authTag,
            })
          : null,
        confidential: debrief.confidential,
        accessLevel: debrief.accessLevel,
        status: debrief.status,
        keyVersion: debrief.keyVersion,
        authorUserId: debrief.authorUserId,
        author: debrief.author,
        createdAt: debrief.createdAt,
        updatedAt: debrief.updatedAt,
        restricted: !canReadBody,
      };
    });
  }

  /**
   * List a client's meeting debriefs (newest first) for the Outreach context
   * builder. Matches the denormalized clientId OR the parent meeting's client,
   * decrypts bodies the caller may read, and access-filters the rest.
   */
  async listClientDebriefs(
    ctx: TenantContext,
    query: { clientId?: string; recipientEmails?: string[] },
  ) {
    const clientId = query.clientId?.trim() || null;
    const emails = (query.recipientEmails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean);
    // Scope debriefs to the campaign's client AND/OR to meetings that involve
    // the chosen recipients (by attendee email) — so a no-client outreach to
    // congressional offices still surfaces relevant debriefs. Bodies remain
    // access-filtered per item below.
    const ors: Prisma.MeetingDebriefWhereInput[] = [];
    if (clientId) ors.push({ clientId }, { meeting: { clientId } });
    if (emails.length) ors.push({ meeting: { attendees: { some: { email: { in: emails } } } } });
    if (ors.length === 0) return [];
    const debriefs = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.meetingDebrief.findMany({
        where: {
          tenantId: ctx.tenantId,
          OR: ors,
        },
        include: {
          author: { select: { id: true, email: true, firstName: true, lastName: true } },
          meeting: { select: { id: true, subject: true, startsAt: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 25,
      }),
    );

    return debriefs.map((debrief) => {
      const canReadBody = canReadEncryptedEntry(ctx, debrief);
      return {
        id: debrief.id,
        meetingId: debrief.meetingId,
        meeting: debrief.meeting,
        clientId: debrief.clientId,
        body: canReadBody
          ? this.notesCrypto.decrypt({
              bodyCiphertext: debrief.bodyCiphertext,
              iv: debrief.iv,
              authTag: debrief.authTag,
            })
          : null,
        confidential: debrief.confidential,
        accessLevel: debrief.accessLevel,
        status: debrief.status,
        authorUserId: debrief.authorUserId,
        author: debrief.author,
        createdAt: debrief.createdAt,
        updatedAt: debrief.updatedAt,
        restricted: !canReadBody,
      };
    });
  }

  /**
   * Tenant-wide context library for the Outreach Build Context step. Returns ALL
   * documents/notes, debriefs, and meeting preps across the tenant — each tagged
   * with its client so the UI groups by client. Intentionally NOT filtered by the
   * campaign's client or recipients (the step shows everything; the user picks).
   * Debrief/note bodies are access-filtered per item (restricted → body omitted);
   * debriefs and preps are newest-first. Document text is extracted lazily when an
   * item is selected, so uploaded docs come back as metadata only here.
   */
  async buildOutreachContextLibrary(ctx: TenantContext) {
    const LIMIT = 300;
    const prepLines = (v: unknown): string[] =>
      Array.isArray(v)
        ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        : [];

    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const [clients, attachments, notes, debriefs, preps] = await Promise.all([
        tx.client.findMany({
          where: { tenantId: ctx.tenantId },
          select: { id: true, name: true, intakeData: true },
        }),
        tx.engagementAttachment.findMany({
          where: { tenantId: ctx.tenantId, clientId: { not: null } },
          orderBy: { createdAt: 'desc' },
          take: LIMIT,
          select: { id: true, clientId: true, fileName: true, createdAt: true },
        }),
        // Notes & preps follow the same per-user meeting-visibility boundary as
        // the rest of the app (ownMeetingWhere): a user only sees notes/preps for
        // meetings they own. (Prep content is plaintext, so this is a real
        // boundary, not just body encryption.) We only drop the client/recipient
        // gating, which was the actual bug.
        tx.meetingNote.findMany({
          where: { tenantId: ctx.tenantId, meeting: ownMeetingWhere(ctx.userId) },
          include: { meeting: { select: { clientId: true, subject: true, startsAt: true } } },
          orderBy: { createdAt: 'desc' },
          take: LIMIT,
        }),
        // Debriefs are tenant-wide (body access-filtered per item) — matching the
        // existing listClientDebriefs behavior the outreach builder already used.
        tx.meetingDebrief.findMany({
          where: { tenantId: ctx.tenantId },
          include: { meeting: { select: { clientId: true, subject: true, startsAt: true } } },
          orderBy: { createdAt: 'desc' },
          take: LIMIT,
        }),
        // distinct on meetingId (ordered meetingId, then createdAt desc → latest
        // prep per meeting) so the cap counts DISTINCT meetings, not prep
        // revisions. Preps are versioned with no cleanup, so a flat take(LIMIT)
        // could let one heavily-regenerated meeting starve others out of the
        // window and make them vanish from the library entirely.
        tx.meetingPrep.findMany({
          where: { tenantId: ctx.tenantId, meeting: ownMeetingWhere(ctx.userId) },
          include: { meeting: { select: { clientId: true, subject: true, startsAt: true } } },
          distinct: ['meetingId'],
          orderBy: [{ meetingId: 'asc' }, { createdAt: 'desc' }],
          take: LIMIT,
        }),
      ]);

      const nameById = new Map(clients.map((c) => [c.id, c.name]));
      const clientName = (id: string | null | undefined): string =>
        id ? (nameById.get(id) ?? 'Unknown client') : 'No client';

      // Per-item safe decrypt: this endpoint aggregates up to LIMIT notes + LIMIT
      // debriefs tenant-wide, so a single corrupt / legacy / future-rotated-key
      // row must NOT 500 the whole library — degrade that one item to body-less.
      const safeDecrypt = (e: {
        bodyCiphertext: string;
        iv: string;
        authTag: string;
      }): string | undefined => {
        try {
          return this.notesCrypto.decrypt(e);
        } catch {
          return undefined;
        }
      };

      type LibItem = {
        id: string;
        clientId: string | null;
        clientName: string;
        title: string;
        sub?: string;
        body?: string;
        tag?: string;
        date?: string;
      };

      const documents: LibItem[] = [];

      // Client profile notes (client profile → Documents → Notes).
      for (const c of clients) {
        const pn = (c.intakeData as { profileNotes?: unknown } | null)?.profileNotes;
        if (typeof pn === 'string' && pn.trim()) {
          documents.push({
            id: `clientnote-${c.id}`,
            clientId: c.id,
            clientName: c.name,
            title: `${c.name} — profile notes`,
            body: pn.trim(),
            tag: 'Client note',
          });
        }
      }
      // Uploaded documents (text extracted lazily on select → no body here).
      for (const a of attachments) {
        documents.push({
          id: `doc-${a.id}`,
          clientId: a.clientId,
          clientName: clientName(a.clientId),
          title: a.fileName,
          tag: 'Document',
          date: a.createdAt.toISOString(),
        });
      }
      // Meeting notes (body access-filtered per item).
      for (const n of notes) {
        const cid = n.clientId ?? n.meeting?.clientId ?? null;
        const can = canReadEncryptedEntry(ctx, n);
        const body = can
          ? safeDecrypt({ bodyCiphertext: n.bodyCiphertext, iv: n.iv, authTag: n.authTag })
          : undefined;
        documents.push({
          id: `meetingnote-${n.id}`,
          clientId: cid,
          clientName: clientName(cid),
          title: n.meeting?.subject ? `Note: ${n.meeting.subject}` : 'Meeting note',
          body,
          tag: !can ? 'Restricted' : body ? 'Note' : 'Unavailable',
          date: n.createdAt.toISOString(),
        });
      }

      const debriefItems: LibItem[] = debriefs.map((d) => {
        const cid = d.clientId ?? d.meeting?.clientId ?? null;
        const can = canReadEncryptedEntry(ctx, d);
        const body = can
          ? safeDecrypt({ bodyCiphertext: d.bodyCiphertext, iv: d.iv, authTag: d.authTag })
          : undefined;
        return {
          id: `debrief-${d.id}`,
          clientId: cid,
          clientName: clientName(cid),
          title: d.meeting?.subject ? `Debrief: ${d.meeting.subject}` : 'Meeting debrief',
          body,
          tag: !can ? 'Restricted' : body ? 'Debrief' : 'Unavailable',
          date: (d.meeting?.startsAt ?? d.createdAt).toISOString(),
        };
      });

      // One (latest) prep per meeting is already guaranteed by `distinct` above;
      // re-sort newest-first here since that query had to order by meetingId.
      const prepItems: LibItem[] = preps
        .map((p) => {
          const cid = p.clientId ?? p.meeting?.clientId ?? null;
          const talking = prepLines(p.talkingPoints);
          const agenda = prepLines(p.agenda);
          const followUps = prepLines(p.followUps);
          const body = [
            p.summary?.trim() || '',
            talking.length ? `Talking points: ${talking.join('; ')}` : '',
            agenda.length ? `Agenda: ${agenda.join('; ')}` : '',
            followUps.length ? `Follow-ups: ${followUps.join('; ')}` : '',
          ]
            .filter(Boolean)
            .join('\n');
          return {
            id: `prep-${p.id}`,
            clientId: cid,
            clientName: clientName(cid),
            title: p.meeting?.subject ? `Prep: ${p.meeting.subject}` : 'Meeting prep',
            body: body || undefined,
            tag: 'Prep',
            date: (p.meeting?.startsAt ?? p.createdAt).toISOString(),
          };
        })
        .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));

      return { documents, debriefs: debriefItems, preps: prepItems };
    });
  }

  async generateMeetingPrep(ctx: TenantContext, meetingId: string, additionalContext?: string) {
    const context = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const meeting = await tx.meeting.findFirst({
        where: { id: meetingId, tenantId: ctx.tenantId, ...ownMeetingWhere(ctx.userId) },
        include: {
          client: true,
          attendees: true,
          tasks: {
            where: {
              status: { notIn: [EngagementTaskStatus.done, EngagementTaskStatus.canceled] },
            },
          },
        },
      });
      if (!meeting) throw new NotFoundException('Meeting not found');

      // Use the current association rules, not only the stored meeting.clientId.
      const attendeeEmails = meeting.attendees
        .map((a) => a.email)
        .filter((e): e is string => Boolean(e));
      const correctClientId = await this.resolveEffectiveMeetingClientId(tx, ctx, meeting);

      // Fetch the correct client based on the association result.
      const client = correctClientId
        ? await tx.client.findUnique({
            where: { id: correctClientId },
            select: {
              id: true,
              name: true,
              website: true,
              primaryContactEmail: true,
              intakeData: true,
            },
          })
        : null;

      const meetingAssociationWhere = correctClientId
        ? await this.clientMeetingAssociationWhere(tx, ctx.tenantId, correctClientId)
        : null;
      // Firm-wide prep context: prior meetings are scoped to the tenant + the
      // matched client, NOT to the requesting user. Any operator preparing for
      // this client sees the firm's collective meeting history with them.
      const recentMeetings = meetingAssociationWhere
        ? await tx.meeting.findMany({
            where: {
              AND: [
                {
                  tenantId: ctx.tenantId,
                  id: { not: meeting.id },
                },
                meetingAssociationWhere,
              ],
            },
            select: {
              id: true,
              subject: true,
              startsAt: true,
              associationReason: true,
              attendees: { select: { email: true, name: true } },
            },
            orderBy: { startsAt: 'desc' },
            take: 5,
          })
        : [];

      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      // Firm-wide prep context: pull email threads associated with the matched
      // client across the tenant's connections (not just the requesting user's
      // mailbox), so prep reflects the firm's full correspondence with the
      // client. Still scoped to client-linked threads only — we never pull by
      // attendee/to/cc domains, so unrelated coworker inbox content is excluded.
      const threadFilters: Prisma.MailThreadWhereInput[] = [];
      if (correctClientId) {
        threadFilters.push(
          await this.clientMailThreadAssociationWhere(tx, ctx.tenantId, correctClientId),
        );
      }

      const recentThreads = threadFilters.length
        ? await tx.mailThread.findMany({
            where: {
              tenantId: ctx.tenantId,
              lastMessageAt: { gte: thirtyDaysAgo },
              OR: threadFilters,
            },
            select: {
              id: true,
              subject: true,
              snippet: true,
              lastMessageAt: true,
              status: true,
              messages: {
                select: {
                  fromEmail: true,
                  fromName: true,
                  subject: true,
                  bodyText: true,
                  sentAt: true,
                },
                orderBy: { sentAt: 'desc' },
                take: 3,
              },
            },
            orderBy: [{ lastMessageAt: 'desc' }, { updatedAt: 'desc' }],
            take: 15,
          })
        : [];

      return { meeting, client, recentMeetings, recentThreads };
    });

    const directoryProfiles = await this.directoryProfilesForMeeting(context.meeting);
    // Firm identity + author voice + client strategic memory — the same steering
    // block outreach uses, so preps reflect the firm, the client's strategy, and
    // the author's voice. Best-effort (null when nothing is written).
    const steeringContext = await this.loadUserVoiceBlock(
      ctx,
      context.client?.id ?? context.meeting.clientId ?? null,
    );
    const promptContext = {
      meeting: pruneForAi(context.meeting),
      client: context.client ? pruneForAi(context.client) : null,
      attendees: context.meeting.attendees.map(pruneForAi),
      congressionalDirectoryMatches: directoryProfiles.map(pruneForAi),
      recentMeetings: context.recentMeetings.map(pruneForAi),
      recentThreads: context.recentThreads.map(prepareThreadForAi),
      tasks: context.meeting.tasks.map(pruneForAi),
      additionalContext: additionalContext?.trim() || null,
      steeringContext,
    };
    const promptHash = createHash('sha256').update(JSON.stringify(promptContext)).digest('hex');
    const generated = await this.ai.generateMeetingPrep(promptContext, ctx);
    await this.recordAiUsage(ctx, 'meeting_prep', generated);

    const correctClientId = context.client?.id || context.meeting.clientId;
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.meetingPrep.create({
        data: {
          tenantId: ctx.tenantId,
          meetingId,
          clientId: correctClientId,
          agenda: generated.agenda,
          talkingPoints: generated.talkingPoints,
          risks: generated.risks,
          followUps: generated.followUps,
          emailEvidence: generated.emailEvidence,
          summary: generated.summary,
          provider: generated.provider,
          model: generated.model,
          promptHash,
          generatedFrom: {
            promptHash,
            meetingId,
            recentMeetings: context.recentMeetings.map((meeting) => meeting.id),
            recentThreads: context.recentThreads.map((thread) => thread.id),
            congressionalDirectoryContactIds: directoryProfiles.map(
              (profile) => profile.directoryContactId,
            ),
          },
        },
      }),
    );
  }

  async updateMeetingPrep(ctx: TenantContext, prepId: string, input: UpdateMeetingPrepInput) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const prep = await tx.meetingPrep.findFirst({
        where: { id: prepId, tenantId: ctx.tenantId },
        select: { id: true, meetingId: true },
      });
      if (!prep) throw new NotFoundException('Meeting prep not found');
      await this.ensureOwnMeeting(tx, ctx, prep.meetingId);

      return tx.meetingPrep.update({
        where: { id: prepId },
        data: {
          ...('summary' in input ? { summary: input.summary?.trim() || null } : {}),
          ...('agenda' in input ? { agenda: normalizeStringArray(input.agenda) } : {}),
          ...('talkingPoints' in input
            ? { talkingPoints: normalizeStringArray(input.talkingPoints) }
            : {}),
          ...('risks' in input ? { risks: normalizeStringArray(input.risks) } : {}),
          ...('followUps' in input ? { followUps: normalizeStringArray(input.followUps) } : {}),
          ...('emailEvidence' in input
            ? { emailEvidence: normalizeStringArray(input.emailEvidence) }
            : {}),
          status: MeetingPrepStatus.edited,
          editedByUserId: ctx.userId,
        },
      });
    });
  }

  async approveMeetingPrep(ctx: TenantContext, prepId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const prep = await tx.meetingPrep.findFirst({
        where: { id: prepId, tenantId: ctx.tenantId },
        select: { id: true, meetingId: true },
      });
      if (!prep) throw new NotFoundException('Meeting prep not found');
      await this.ensureOwnMeeting(tx, ctx, prep.meetingId);

      return tx.meetingPrep.update({
        where: { id: prepId },
        data: {
          status: MeetingPrepStatus.approved,
          editedByUserId: ctx.userId,
        },
      });
    });
  }

  private async directoryProfilesForMeeting(
    meeting: Prisma.MeetingGetPayload<{
      include: { attendees: true };
    }>,
  ) {
    const attendeeEmails = meeting.attendees
      .map((attendee) => attendee.email)
      .filter((email): email is string => Boolean(email));
    const emails = [meeting.organizerEmail, ...attendeeEmails].filter((email): email is string =>
      Boolean(email),
    );
    if (!emails.length) return [];

    try {
      return await this.directory.findContactsByEmails(emails);
    } catch (error) {
      this.logger.warn(
        `Could not enrich meeting ${meeting.id} with congressional directory context: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  }

  private async directoryMatchesForReport(emails: string[]) {
    if (!emails.length) return [];
    try {
      return await this.directory.findContactsByEmails(emails, 500);
    } catch (error) {
      this.logger.warn(
        `Could not enrich engagement report with congressional directory context: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return [];
    }
  }

  async overrideAssociation(ctx: TenantContext, input: AssociationOverrideInput) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      // Marking a meeting "internal" clears its client and is a meetings-only path.
      if (input.internal) {
        if (input.entityType !== AssociationEntityType.meeting) {
          throw new BadRequestException('Only meetings can be marked internal');
        }
        const existing = await tx.meeting.findFirst({
          where: {
            id: input.entityId,
            tenantId: ctx.tenantId,
            ...ownMeetingWhere(ctx.userId),
          },
        });
        if (!existing) throw new NotFoundException('Meeting not found');
        return tx.meeting.update({
          where: { id: input.entityId },
          data: { isInternal: true, clientId: null },
        });
      }

      if (!input.clientId) {
        throw new BadRequestException('clientId is required unless marking internal');
      }
      const clientId = input.clientId;
      await ensureExists(tx.client.findUnique({ where: { id: clientId } }), 'Client not found');

      if (input.entityType === AssociationEntityType.meeting) {
        const existing = await tx.meeting.findFirst({
          where: {
            id: input.entityId,
            tenantId: ctx.tenantId,
            ...ownMeetingWhere(ctx.userId),
          },
        });
        if (!existing) throw new NotFoundException('Meeting not found');
        // Assigning a real client also clears any prior internal flag.
        await tx.meeting.update({
          where: { id: input.entityId },
          data: { clientId, isInternal: false },
        });
        return tx.clientAssociationOverride.create({
          data: {
            tenantId: ctx.tenantId,
            entityType: input.entityType,
            entityId: input.entityId,
            clientId,
            previousClientId: existing.clientId,
            confidenceBefore: existing.associationScore,
            reason: input.reason ?? 'Manual association override.',
            userId: ctx.userId,
          },
        });
      }

      if (input.entityType === AssociationEntityType.mail_thread) {
        const existing = await tx.mailThread.findFirst({
          where: {
            id: input.entityId,
            tenantId: ctx.tenantId,
            ...ownMailThreadWhere(ctx.userId),
          },
        });
        if (!existing) throw new NotFoundException('Mail thread not found');
        await tx.mailThread.update({
          where: { id: input.entityId },
          data: { clientId },
        });
        return tx.clientAssociationOverride.create({
          data: {
            tenantId: ctx.tenantId,
            entityType: input.entityType,
            entityId: input.entityId,
            clientId,
            previousClientId: existing.clientId,
            confidenceBefore: existing.associationScore,
            reason: input.reason ?? 'Manual association override.',
            userId: ctx.userId,
          },
        });
      }

      throw new BadRequestException('Only meeting and mail_thread overrides are supported now');
    });
  }

  async clientContext(ctx: TenantContext, clientId: string) {
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const client = await tx.client.findFirst({
        where: { id: clientId, tenantId: ctx.tenantId, status: { not: 'archived' } },
      });
      if (!client) throw new NotFoundException('Client not found');
      const [meetingAssociationWhere, mailThreadAssociationWhere] = await Promise.all([
        this.clientMeetingAssociationWhere(tx, ctx.tenantId, clientId),
        this.clientMailThreadAssociationWhere(tx, ctx.tenantId, clientId),
      ]);
      const [meetings, threads, contacts, tasks] = await Promise.all([
        tx.meeting.findMany({
          where: {
            AND: [
              { tenantId: ctx.tenantId, ...ownMeetingWhere(ctx.userId) },
              meetingAssociationWhere,
            ],
          },
          include: { attendees: true },
          orderBy: { startsAt: 'desc' },
          take: 10,
        }),
        tx.mailThread.findMany({
          where: {
            AND: [
              { tenantId: ctx.tenantId, ...ownMailThreadWhere(ctx.userId) },
              mailThreadAssociationWhere,
            ],
          },
          orderBy: [{ lastMessageAt: 'desc' }, { updatedAt: 'desc' }],
          take: 10,
        }),
        tx.engagementContact.findMany({
          where: { tenantId: ctx.tenantId, clientId },
          orderBy: { updatedAt: 'desc' },
          take: 40,
        }),
        tx.engagementTask.findMany({
          where: {
            tenantId: ctx.tenantId,
            clientId,
            status: { notIn: [EngagementTaskStatus.done, EngagementTaskStatus.canceled] },
          },
          orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
          take: 20,
        }),
      ]);

      type StakeholderSource = 'contact' | 'meeting' | 'email_thread';
      type Stakeholder = {
        id: string;
        email: string | null;
        fullName: string | null;
        title: string | null;
        organization: string | null;
        score: number;
        recency: number;
        sources: Set<StakeholderSource>;
      };
      const stakeholderMap = new Map<string, Stakeholder>();

      const stakeholderSourceLabel = (sources: Set<StakeholderSource>): string => {
        const labels: string[] = [];
        if (sources.has('contact')) labels.push('Contact');
        if (sources.has('meeting')) labels.push('Meeting');
        if (sources.has('email_thread')) labels.push('Email');
        return labels.join(' + ');
      };

      const upsertStakeholder = (
        key: string,
        value: Omit<Stakeholder, 'score' | 'recency' | 'sources'>,
        scoreBoost: number,
        recencyHint: Date,
        source: StakeholderSource,
      ) => {
        const existing = stakeholderMap.get(key);
        if (!existing) {
          stakeholderMap.set(key, {
            ...value,
            score: scoreBoost,
            recency: recencyHint.getTime(),
            sources: new Set([source]),
          });
          return;
        }
        const mergedSources = new Set(existing.sources);
        mergedSources.add(source);
        stakeholderMap.set(key, {
          ...existing,
          id: existing.id || value.id,
          email: existing.email || value.email,
          fullName: existing.fullName || value.fullName,
          title: existing.title || value.title,
          organization: existing.organization || value.organization,
          score: existing.score + scoreBoost,
          recency: Math.max(existing.recency, recencyHint.getTime()),
          sources: mergedSources,
        });
      };

      for (const contact of contacts) {
        const email = normalizeEmailAddress(contact.email);
        const key = email || `contact:${contact.id}`;
        upsertStakeholder(
          key,
          {
            id: contact.id,
            email: contact.email,
            fullName: contact.fullName,
            title: contact.title,
            organization: contact.organization,
          },
          10,
          contact.updatedAt,
          'contact',
        );
      }

      for (const meeting of meetings) {
        for (const attendee of meeting.attendees) {
          const email = normalizeEmailAddress(attendee.email);
          const key = email || `meeting-attendee:${meeting.id}:${attendee.id}`;
          upsertStakeholder(
            key,
            {
              id: attendee.contactId ?? attendee.id,
              email: attendee.email,
              fullName: attendee.name,
              title: attendee.role,
              organization: null,
            },
            5,
            meeting.startsAt,
            'meeting',
          );
        }
      }

      for (const thread of threads) {
        const threadDate = thread.lastMessageAt ?? thread.updatedAt;
        for (const participant of parseMailThreadParticipants(thread.participants)) {
          const email = normalizeEmailAddress(participant.email);
          const key = email || `thread-participant:${thread.id}:${participant.name ?? 'unknown'}`;
          upsertStakeholder(
            key,
            {
              id: key,
              email: participant.email,
              fullName: participant.name,
              title: participant.role,
              organization: null,
            },
            4,
            threadDate,
            'email_thread',
          );
        }
      }

      const keyStakeholders = Array.from(stakeholderMap.values())
        .sort((left, right) => {
          if (right.score !== left.score) return right.score - left.score;
          return right.recency - left.recency;
        })
        .slice(0, 40)
        .map(({ id, email, fullName, title, organization, sources }) => ({
          id,
          email,
          fullName,
          title,
          organization,
          source: stakeholderSourceLabel(sources),
        }));

      return {
        client,
        recentActivity: [
          ...meetings.map((meeting) => ({
            type: 'meeting',
            id: meeting.id,
            title: meeting.subject,
            date: meeting.startsAt,
          })),
          ...threads.map((thread) => ({
            type: 'mail_thread',
            id: thread.id,
            title: thread.subject,
            date: thread.lastMessageAt ?? thread.updatedAt,
          })),
        ]
          .sort((left, right) => new Date(right.date).getTime() - new Date(left.date).getTime())
          .slice(0, 12),
        keyStakeholders,
        openThreads: threads.filter((thread) => thread.status !== 'closed'),
        openTasks: tasks,
        summary: {
          meetings: meetings.length,
          mailThreads: threads.length,
          contacts: keyStakeholders.length,
          openTasks: tasks.length,
        },
      };
    });
  }

  async createAttachmentUploadUrl(ctx: TenantContext, input: AttachmentUploadInput) {
    if (!this.bucket) throw new ServiceUnavailableException('ASSETS_BUCKET is not configured');
    if (!isAllowedAttachmentContentType(input.contentType)) {
      throw new BadRequestException(
        `Unsupported attachment type "${input.contentType}". Accepted: ${ALLOWED_ATTACHMENT_TYPES_LABEL}.`,
      );
    }
    if (input.contentLength > MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException(`Attachment must be <= ${MAX_ATTACHMENT_BYTES} bytes`);
    }
    // A general outreach attachment may be uploaded with NO parent (client,
    // meeting, or mail message). It lives at the tenant scope — the S3 key and
    // row are keyed by tenantId, and it is attached to emails by id at send
    // time. Any parent that IS supplied is still validated below, so tenant /
    // ownership isolation is unchanged.
    await this.validateAttachmentParents(ctx, input);

    const safeName = safeFileName(input.fileName);
    const s3Key = `tenants/${ctx.tenantId}/engagement/${randomUUID()}/${safeName}`;
    const presigned = await createPresignedPost(this.s3, {
      Bucket: this.bucket,
      Key: s3Key,
      Conditions: [
        ['content-length-range', 1, MAX_ATTACHMENT_BYTES],
        ['eq', '$Content-Type', input.contentType],
        ['starts-with', '$key', `tenants/${ctx.tenantId}/engagement/`],
      ],
      Fields: { 'Content-Type': input.contentType },
      Expires: 300,
    });
    return { ...presigned, s3Key };
  }

  async confirmAttachment(ctx: TenantContext, input: ConfirmAttachmentInput) {
    if (!this.bucket) throw new ServiceUnavailableException('ASSETS_BUCKET is not configured');
    // Re-checked here (not just at presign) — confirm is a separate call and
    // must not record a contentType the presign path would have rejected.
    if (!isAllowedAttachmentContentType(input.contentType)) {
      throw new BadRequestException(
        `Unsupported attachment type "${input.contentType}". Accepted: ${ALLOWED_ATTACHMENT_TYPES_LABEL}.`,
      );
    }
    if (!input.s3Key.startsWith(`tenants/${ctx.tenantId}/engagement/`)) {
      throw new BadRequestException('Attachment key is outside tenant engagement prefix');
    }
    const head = await this.s3
      .send(new HeadObjectCommand({ Bucket: this.bucket, Key: input.s3Key }))
      .catch(() => null);
    if (!head) throw new BadRequestException('Uploaded attachment not found in S3');
    await this.validateAttachmentParents(ctx, input);

    const attachment = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.engagementAttachment.create({
        data: {
          tenantId: ctx.tenantId,
          clientId: input.clientId ?? null,
          meetingId: input.meetingId ?? null,
          mailMessageId: input.mailMessageId ?? null,
          fileName: input.fileName,
          contentType: input.contentType,
          byteSize: head.ContentLength ? Number(head.ContentLength) : null,
          bucket: this.bucket!,
          s3Key: input.s3Key,
          checksumSha256: input.checksumSha256 ?? null,
          source: input.source ?? 'manual',
          uploadedByUserId: ctx.userId,
        },
      }),
    );
    // Client KB (F5): client-linked documents become retrievable knowledge.
    if (attachment.clientId) {
      this.clientKb.indexAttachmentFireAndForget(ctx.tenantId, attachment.id);
    }
    return attachment;
  }

  async listAttachments(
    ctx: TenantContext,
    query: { clientId?: string; meetingId?: string; mailMessageId?: string; unlinked?: boolean },
  ) {
    const hasParent = Boolean(query.clientId || query.meetingId || query.mailMessageId);
    if (!hasParent && !query.unlinked) {
      throw new BadRequestException('An attachment parent (or unlinked=true) is required');
    }
    await this.validateAttachmentParents(ctx, query);
    const { rows, uploaderNameById } = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.engagementAttachment.findMany({
        where: {
          tenantId: ctx.tenantId,
          // "unlinked" = the tenant's general outreach library: files not tied
          // to any client, meeting, or mail message. Explicit opt-in (and only
          // when no parent is given) so a caller can't accidentally page the
          // whole tenant's attachments.
          ...(!hasParent && query.unlinked
            ? { clientId: null, meetingId: null, mailMessageId: null }
            : {}),
          ...(query.clientId ? { clientId: query.clientId } : {}),
          ...(query.meetingId ? { meetingId: query.meetingId } : {}),
          ...(query.mailMessageId ? { mailMessageId: query.mailMessageId } : {}),
        },
        orderBy: { createdAt: 'desc' },
      });
      // Resolve uploader display names (Meetings v2 §8 — the Documents tab shows
      // the uploader). uploadedByUserId is a bare UUID, so batch-look up the users.
      const uploaderIds = [
        ...new Set(rows.map((r) => r.uploadedByUserId).filter((v): v is string => Boolean(v))),
      ];
      const users = uploaderIds.length
        ? await tx.user.findMany({
            where: { id: { in: uploaderIds } },
            select: { id: true, firstName: true, lastName: true, email: true },
          })
        : [];
      const uploaderNameById = new Map(users.map((u) => [u.id, userDisplayName(u)]));
      return { rows, uploaderNameById };
    });
    return Promise.all(
      rows.map(async (row) => ({
        ...row,
        uploadedByName: row.uploadedByUserId
          ? (uploaderNameById.get(row.uploadedByUserId) ?? null)
          : null,
        downloadUrl: await this.createAttachmentDownloadUrl(row.s3Key),
      })),
    );
  }

  async extractAttachmentText(ctx: TenantContext, id: string) {
    if (!this.bucket) throw new ServiceUnavailableException('ASSETS_BUCKET is not configured');

    const attachment = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.engagementAttachment.findFirst({
        where: { id, tenantId: ctx.tenantId },
      }),
    );
    if (!attachment) throw new NotFoundException('Attachment not found');
    // Allow extraction for both meeting attachments (debrief sources) and
    // client-profile documents (used as outreach context).
    if (!attachment.meetingId && !attachment.clientId) {
      throw new BadRequestException('Attachment is not linked to a meeting or client');
    }

    await this.validateAttachmentParents(ctx, {
      clientId: attachment.clientId ?? undefined,
      meetingId: attachment.meetingId ?? undefined,
    });

    const bytes = await this.readAttachmentBytes(attachment.s3Key);
    const contentType = attachment.contentType || 'application/octet-stream';
    const fileName = attachment.fileName || 'attachment';
    let source: 'text' | 'docx' | 'pdf' | 'spreadsheet' | 'pptx' | 'transcription';
    let text: string;

    if (isPlainTextAttachment(fileName, contentType)) {
      source = 'text';
      text = bytes.toString('utf8').trim();
    } else if (isDocxAttachment(fileName, contentType)) {
      source = 'docx';
      const result = await mammoth.extractRawText({ buffer: bytes });
      text = result.value.trim();
    } else if (isPdfAttachment(fileName, contentType)) {
      source = 'pdf';
      text = await extractPdfBuffer(bytes);
    } else if (isSpreadsheetAttachment(fileName, contentType)) {
      source = 'spreadsheet';
      text = await extractXlsxText(bytes);
    } else if (isPowerPointAttachment(fileName, contentType)) {
      source = 'pptx';
      text = await extractPptxText(bytes);
    } else if (isTranscribableAttachment(fileName, contentType)) {
      source = 'transcription';
      text = await this.transcribeAttachmentWithOpenAi(bytes, fileName, contentType);
    } else {
      throw new BadRequestException(
        'Unsupported source. Upload .txt, .csv, .pdf, .docx, .xlsx, .pptx, audio, or video.',
      );
    }

    if (!text) {
      throw new BadRequestException('No usable text could be extracted from this attachment');
    }

    return {
      attachmentId: attachment.id,
      fileName,
      contentType,
      source,
      text,
    };
  }

  /**
   * Server-side attachment create from an in-memory buffer. Mirrors
   * confirmAttachment but PUTs the bytes itself instead of relying on a browser
   * presigned upload — used by the alert→memo flow to auto-file a generated
   * deliverable in the client's Documents, and by the notetaker to file the
   * meeting transcript. Tenant-scoped; client-linked rows are KB-indexed like
   * any other client document. Storing through this path (an
   * EngagementAttachment row) is what wires the object into the existing
   * erasure path — deleteAttachment removes the S3 object, the row, and any KB
   * chunks together.
   */
  async createAttachmentFromBuffer(
    ctx: TenantContext,
    input: {
      clientId?: string | null;
      meetingId?: string | null;
      fileName: string;
      contentType: string;
      buffer: Buffer;
      source?: string;
    },
  ): Promise<{ id: string; fileName: string; s3Key: string }> {
    if (!this.bucket) throw new ServiceUnavailableException('ASSETS_BUCKET is not configured');
    if (!isAllowedAttachmentContentType(input.contentType)) {
      throw new BadRequestException(
        `Unsupported attachment type "${input.contentType}". Accepted: ${ALLOWED_ATTACHMENT_TYPES_LABEL}.`,
      );
    }
    if (input.buffer.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException(`Attachment must be <= ${MAX_ATTACHMENT_BYTES} bytes`);
    }
    await this.validateAttachmentParents(ctx, {
      clientId: input.clientId ?? undefined,
      meetingId: input.meetingId ?? undefined,
    });
    const safeName = safeFileName(input.fileName);
    const s3Key = `tenants/${ctx.tenantId}/engagement/${randomUUID()}/${safeName}`;
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: s3Key,
        Body: input.buffer,
        ContentType: input.contentType,
      }),
    );
    const attachment = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.engagementAttachment.create({
        data: {
          tenantId: ctx.tenantId,
          clientId: input.clientId ?? null,
          meetingId: input.meetingId ?? null,
          fileName: input.fileName,
          contentType: input.contentType,
          byteSize: input.buffer.byteLength,
          bucket: this.bucket!,
          s3Key,
          source: input.source ?? 'intel_memo',
          uploadedByUserId: ctx.userId,
        },
      }),
    );
    if (attachment.clientId) {
      this.clientKb.indexAttachmentFireAndForget(ctx.tenantId, attachment.id);
    }
    return { id: attachment.id, fileName: attachment.fileName, s3Key };
  }

  async deleteAttachment(ctx: TenantContext, id: string) {
    const attachment = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const row = await tx.engagementAttachment.findFirst({
        where: { id, tenantId: ctx.tenantId },
      });
      if (!row) throw new NotFoundException('Attachment not found');
      return row;
    });
    await this.validateAttachmentParents(ctx, {
      clientId: attachment.clientId ?? undefined,
      meetingId: attachment.meetingId ?? undefined,
      mailMessageId: attachment.mailMessageId ?? undefined,
    });

    if (this.bucket) {
      await this.s3
        .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: attachment.s3Key }))
        .catch(() => undefined);
    }

    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.engagementAttachment.delete({ where: { id } }),
    );
    // Client KB (F5): deleting a document removes its chunks from retrieval.
    if (attachment.clientId) {
      this.clientKb.purgeFireAndForget(ctx.tenantId, 'client_doc_chunk', id);
    }
    return { ok: true };
  }

  private async createAttachmentDownloadUrl(s3Key: string): Promise<string | null> {
    if (!this.bucket) return null;
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: s3Key,
        // Defense-in-depth against stored-XSS / content-type confusion: force the
        // browser to DOWNLOAD the object rather than render it as a top-level
        // document, so a scriptable type that ever slipped past upload validation
        // (e.g. an SVG) cannot execute its embedded script when opened. This does
        // not affect <img> previews (they ignore Content-Disposition); the
        // download filename falls back to the key's trailing safe file name.
        ResponseContentDisposition: 'attachment',
      }),
      { expiresIn: 300 },
    );
  }

  /**
   * Fetch EngagementAttachment rows by id and turn them into Graph inline file
   * attachments (base64 contentBytes). Files over the ~3MB Graph simple-send
   * inline limit are skipped rather than failing the whole send. Shared by the
   * campaign send path (sendCampaign) and the wizard batch send path.
   */
  private async loadGraphAttachments(
    ctx: TenantContext,
    attachmentIds: string[] | undefined,
  ): Promise<Array<{ name: string; contentType: string; contentBytes: string }> | undefined> {
    if (!attachmentIds?.length) return undefined;
    const GRAPH_INLINE_ATTACHMENT_MAX = 3 * 1024 * 1024;
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.engagementAttachment.findMany({
        where: { tenantId: ctx.tenantId, id: { in: attachmentIds } },
      }),
    );
    const graphAttachments: Array<{ name: string; contentType: string; contentBytes: string }> = [];
    for (const row of rows) {
      // Skip without downloading when the stored size is known to be too big;
      // otherwise verify the actual byte length after fetching.
      if (row.byteSize != null && row.byteSize > GRAPH_INLINE_ATTACHMENT_MAX) continue;
      const bytes = await this.readAttachmentBytes(row.s3Key);
      if (bytes.length > GRAPH_INLINE_ATTACHMENT_MAX) continue;
      graphAttachments.push({
        name: row.fileName,
        contentType: row.contentType,
        contentBytes: bytes.toString('base64'),
      });
    }
    return graphAttachments.length ? graphAttachments : undefined;
  }

  private async readAttachmentBytes(s3Key: string): Promise<Buffer> {
    if (!this.bucket) throw new ServiceUnavailableException('ASSETS_BUCKET is not configured');
    const object = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: s3Key }));
    const body = object.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
    if (!body?.transformToByteArray) {
      throw new BadRequestException('Could not read uploaded attachment from S3');
    }
    return Buffer.from(await body.transformToByteArray());
  }

  private async transcribeAttachmentWithOpenAi(
    bytes: Buffer,
    fileName: string,
    contentType: string,
  ): Promise<string> {
    if (!this.openAiApiKey) {
      throw new ServiceUnavailableException(
        'OPENAI_API_KEY is required to transcribe audio and video debrief sources',
      );
    }

    const arrayBuffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const form = new FormData();
    form.append('model', 'whisper-1');
    form.append(
      'file',
      new Blob([arrayBuffer], { type: contentType || 'application/octet-stream' }),
      fileName,
    );

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.openAiApiKey}` },
      body: form,
    });
    const payload = (await response.json().catch(() => ({}))) as {
      text?: unknown;
      error?: { message?: string };
    };
    if (!response.ok) {
      throw new BadRequestException(payload.error?.message || 'OpenAI transcription failed');
    }

    const text = typeof payload.text === 'string' ? payload.text.trim() : '';
    if (!text) throw new BadRequestException('OpenAI transcription returned no text');
    return text;
  }

  private async upsertAttendeeContacts(
    tx: Prisma.TransactionClient,
    tenantId: string,
    attendees: MeetingAttendeeInput[],
  ) {
    const contacts = new Map<string, { id: string }>();
    for (const attendee of attendees) {
      const email = attendee.email?.trim().toLowerCase();
      if (!email) continue;
      const contact = await tx.engagementContact.upsert({
        where: { tenantId_email: { tenantId, email } },
        update: {
          fullName: attendee.name?.trim() || undefined,
        },
        create: {
          tenantId,
          email,
          fullName: attendee.name?.trim() || null,
          source: 'meeting_attendee',
        },
        select: { id: true },
      });
      contacts.set(email, contact);
    }
    return contacts;
  }

  private async clientProfileEmails(
    tx: Prisma.TransactionClient,
    tenantId: string,
    clientId: string,
  ): Promise<string[]> {
    const [client, people] = await Promise.all([
      tx.client.findFirst({
        where: { id: clientId, tenantId },
        select: { primaryContactEmail: true },
      }),
      tx.clientPerson.findMany({
        where: { tenantId, clientId, email: { not: null } },
        select: { email: true },
      }),
    ]);

    const values = [
      client?.primaryContactEmail?.trim().toLowerCase() ?? null,
      ...people.map((person) => person.email?.trim().toLowerCase() ?? null),
    ].filter((value): value is string => Boolean(value));

    return Array.from(new Set(values));
  }

  private async clientMeetingAssociationWhere(
    tx: Prisma.TransactionClient,
    tenantId: string,
    clientId: string,
    extraEmails: string[] = [],
  ): Promise<Prisma.MeetingWhereInput> {
    const profileEmails = await this.clientProfileEmails(tx, tenantId, clientId);
    const emails = Array.from(
      new Set([
        ...profileEmails,
        ...extraEmails.map((e) => e.trim().toLowerCase()).filter(Boolean),
      ]),
    );
    const or: Prisma.MeetingWhereInput[] = [{ clientId }];

    if (emails.length) {
      or.push(
        { organizerEmail: { in: emails } },
        { attendees: { some: { email: { in: emails } } } },
      );
    }

    return { OR: or };
  }

  private async clientMailThreadAssociationWhere(
    tx: Prisma.TransactionClient,
    tenantId: string,
    clientId: string,
    extraEmails: string[] = [],
  ): Promise<Prisma.MailThreadWhereInput> {
    const profileEmails = await this.clientProfileEmails(tx, tenantId, clientId);
    const emails = Array.from(
      new Set([
        ...profileEmails,
        ...extraEmails.map((e) => e.trim().toLowerCase()).filter(Boolean),
      ]),
    );
    const or: Prisma.MailThreadWhereInput[] = [{ clientId }];

    if (emails.length) {
      // A thread belongs to the client if any of the client's people — or the
      // selected outreach recipients — appear as the sender, in To, or in Cc on
      // any message (case-insensitive). The recipient lists are JSONB arrays of
      // {email,name}, which Prisma can't filter with `in`, so resolve matching
      // thread ids via a raw query.
      const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT DISTINCT mt.id
        FROM mail_threads mt
        JOIN mail_messages mm ON mm.thread_id = mt.id
        WHERE mt.tenant_id = ${tenantId}::uuid
          AND (
            lower(mm.from_email) = ANY(${emails})
            OR EXISTS (
              SELECT 1 FROM jsonb_array_elements(mm.to_recipients_jsonb) e
              WHERE lower(e->>'email') = ANY(${emails})
            )
            OR EXISTS (
              SELECT 1 FROM jsonb_array_elements(mm.cc_recipients_jsonb) e
              WHERE lower(e->>'email') = ANY(${emails})
            )
          )
      `);
      if (rows.length) {
        or.push({ id: { in: rows.map((r) => r.id) } });
      } else {
        // Fallback so the OR still has a sender match if the raw query yielded
        // nothing (e.g. recipient lists empty): keep the original behavior.
        or.push({ messages: { some: { fromEmail: { in: emails } } } });
      }
    }

    return { OR: or };
  }

  private async resolveEffectiveMeetingClientId(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    meeting: {
      id: string;
      clientId: string | null;
      subject?: string | null;
      description?: string | null;
      organizerEmail?: string | null;
      attendees: Array<{ email: string | null }>;
    },
  ): Promise<string | null> {
    const attendeeEmails = meeting.attendees
      .map((attendee) => attendee.email)
      .filter((email): email is string => Boolean(email));
    const association = await this.association.associate(tx, ctx.tenantId, {
      subject: meeting.subject,
      body: meeting.description,
      attendeeEmails: [...attendeeEmails, meeting.organizerEmail ?? ''],
    });

    if (!meeting.clientId && association.clientId) {
      await tx.meeting.update({
        where: { id: meeting.id },
        data: {
          clientId: association.clientId,
          associationScore: association.score,
          associationReason: association.reason,
          associationSignals: association.signals as Prisma.InputJsonValue,
        },
      });
    }

    return association.clientId || meeting.clientId;
  }

  private async validateOutreachParents(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    clientId: string | null,
    meetingId: string | null,
  ) {
    if (clientId) {
      await ensureExists(
        tx.client.findFirst({
          where: { id: clientId, tenantId: ctx.tenantId },
          select: { id: true },
        }),
        'Client not found',
      );
    }
    if (meetingId) {
      const meeting = await tx.meeting.findFirst({
        where: {
          id: meetingId,
          tenantId: ctx.tenantId,
          ...ownMeetingWhere(ctx.userId),
        },
        select: { clientId: true },
      });
      if (!meeting) throw new NotFoundException('Meeting not found');
      if (clientId && meeting.clientId && meeting.clientId !== clientId) {
        throw new BadRequestException('Meeting belongs to a different client');
      }
    }
  }

  private async validateAttachmentParents(
    ctx: TenantContext,
    input: { clientId?: string | null; meetingId?: string | null; mailMessageId?: string | null },
  ) {
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      if (input.clientId) {
        await ensureExists(
          tx.client.findFirst({
            where: { id: input.clientId, tenantId: ctx.tenantId },
            select: { id: true },
          }),
          'Client not found',
        );
      }
      if (input.meetingId) {
        await this.ensureOwnMeeting(tx, ctx, input.meetingId);
      }
      if (input.mailMessageId) {
        await this.ensureOwnMailMessage(tx, ctx, input.mailMessageId);
      }
    });
  }

  private async ensureOwnMeeting(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    meetingId: string,
  ) {
    const meeting = await tx.meeting.findFirst({
      where: { id: meetingId, tenantId: ctx.tenantId, ...ownMeetingWhere(ctx.userId) },
      select: { id: true, clientId: true },
    });
    if (!meeting) throw new NotFoundException('Meeting not found');
    return meeting;
  }

  private async ensureOwnMailMessage(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    mailMessageId: string,
  ) {
    const message = await tx.mailMessage.findFirst({
      where: { id: mailMessageId, tenantId: ctx.tenantId, ...ownMailMessageWhere(ctx.userId) },
      select: { id: true },
    });
    if (!message) throw new NotFoundException('Mail message not found');
    return message;
  }

  private async hasConnectedInbox(ctx: TenantContext): Promise<boolean> {
    const count = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.integrationConnection.count({
        where: {
          tenantId: ctx.tenantId,
          status: EngagementConnectionStatus.connected,
          provider: { in: [EngagementProvider.microsoft_365, EngagementProvider.google_workspace] },
          createdByUserId: ctx.userId,
        },
      }),
    );
    return count > 0;
  }

  private async findCampaignSendConnection(
    ctx: TenantContext,
    preferredConnectionId?: string | null,
  ) {
    // Any connected inbox the user owns can send — Outlook (Graph) or Gmail.
    // The dispatcher routes on `provider`, so it must be selected.
    const baseWhere = {
      tenantId: ctx.tenantId,
      provider: {
        in: [EngagementProvider.microsoft_365, EngagementProvider.google_workspace],
      },
      status: EngagementConnectionStatus.connected,
      createdByUserId: ctx.userId,
      token: { isNot: null },
    };
    const selectFields = {
      id: true,
      provider: true,
      accountEmail: true,
      displayName: true,
    } as const;

    // When the caller pins a specific mailbox (wizard picker), honor exactly
    // that one — never silently fall back to another inbox, which would send
    // from the wrong identity. If it isn't a connected inbox the user owns,
    // fail loudly.
    if (preferredConnectionId) {
      const chosen = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.integrationConnection.findFirst({
          where: { ...baseWhere, id: preferredConnectionId },
          select: selectFields,
        }),
      );
      if (!chosen) {
        throw new BadRequestException(
          'The selected sending mailbox is not connected. Choose a connected inbox and try again.',
        );
      }
      return chosen;
    }

    const connection = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.integrationConnection.findFirst({
        where: baseWhere,
        orderBy: { updatedAt: 'desc' },
        select: selectFields,
      }),
    );
    if (!connection) {
      throw new BadRequestException(
        'Connect your email in Settings before sending campaigns from Capiro',
      );
    }
    return connection;
  }

  private async outreachContext(
    ctx: TenantContext,
    record: {
      clientId: string | null;
      meetingId: string | null;
      metadata: Prisma.JsonValue;
      meeting?: {
        clientId: string | null;
        organizerEmail: string | null;
        attendees: Array<{ email: string | null }>;
      } | null;
    },
    recipients: OutreachRecipientInput[],
    extraMetadata?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const meetingId = record.meetingId;
    const clientId = record.clientId ?? record.meeting?.clientId ?? null;
    const [notes, debriefs, clientContext, recentClientMeetings, directoryMatches] =
      await Promise.all([
        meetingId ? this.listMeetingNotes(ctx, meetingId).catch(() => []) : Promise.resolve([]),
        meetingId ? this.listMeetingDebriefs(ctx, meetingId).catch(() => []) : Promise.resolve([]),
        clientId ? this.clientContext(ctx, clientId).catch(() => null) : Promise.resolve(null),
        clientId
          ? this.recentClientMeetingsForOutreach(ctx, clientId).catch(() => [])
          : Promise.resolve([]),
        this.directory
          .findContactsByEmails(
            unique([
              ...recipients.map((recipient) => recipient.email ?? ''),
              ...(record.meeting?.attendees ?? []).map((attendee) => attendee.email ?? ''),
              record.meeting?.organizerEmail ?? '',
            ]).filter(Boolean),
            50,
          )
          .catch(() => []),
      ]);

    // Rendered to a compact STRING, not the raw object: PromptSpec v2 only
    // renders string context values (nonEmptyStr), so an object silently drops.
    // Same fix as the batch path (generateBatchEmails) — see
    // renderClientRelationshipSnapshot's other call site.
    return pruneForAi({
      notes: notes.filter((note) => !note.restricted),
      debriefs: debriefs.filter((debrief) => !debrief.restricted),
      clientContext: renderClientRelationshipSnapshot(clientContext),
      recentClientMeetings,
      directoryMatches,
      metadata: mergeJsonObjects(record.metadata, extraMetadata ?? {}),
    });
  }

  private async recentClientMeetingsForOutreach(ctx: TenantContext, clientId: string) {
    const meetings = await this.prisma.withTenant(ctx.tenantId, async (tx) =>
      tx.meeting.findMany({
        where: {
          AND: [
            { tenantId: ctx.tenantId, ...ownMeetingWhere(ctx.userId) },
            await this.clientMeetingAssociationWhere(tx, ctx.tenantId, clientId),
          ],
        },
        select: {
          id: true,
          subject: true,
          startsAt: true,
          endsAt: true,
          location: true,
          organizerEmail: true,
          organizerName: true,
          attendees: {
            select: { id: true, email: true, name: true, role: true },
            orderBy: { createdAt: 'asc' as const },
          },
          preps: {
            orderBy: { createdAt: 'desc' as const },
            take: 1,
          },
          tasks: {
            where: { status: { not: EngagementTaskStatus.canceled } },
            orderBy: [{ dueDate: 'asc' as const }, { createdAt: 'desc' as const }],
          },
        },
        orderBy: { startsAt: 'desc' },
        take: 8,
      }),
    );

    const debriefsByMeeting = await Promise.all(
      meetings.map((meeting) => this.listMeetingDebriefs(ctx, meeting.id).catch(() => [])),
    );

    return meetings.map((meeting, index) => ({
      ...meeting,
      debriefs: (debriefsByMeeting[index] ?? []).filter((debrief) => !debrief.restricted),
    }));
  }

  /**
   * Accuracy fix (2026-07-11): rewrite the body of every attached `bill` /
   * `programElement` context item with an AUTHORITATIVE block sourced from our
   * own (global, non-RLS) tables, so drafts cite real canonical status and every
   * congressional mark instead of narrating from a single stale string. Runs once
   * per campaign, in parallel, best-effort: any lookup error/miss leaves the
   * original client-supplied body untouched (never blocks a draft).
   *
   * Also returns `truthByItemId` — the RAW structured PeTruth/BillTruth behind
   * each rewritten item's rendered text, keyed by context-item id. This is
   * additive (the rendered `text` is byte-identical to what used to be returned
   * bare): the post-hoc grounding auditor (shadow by default) uses the raw truth
   * to build ground-truth LedgerEntrys for whichever items a given recipient's
   * draft actually used — see generateBatchEmails.
   */
  private async enrichOutreachContextItems(items: OutreachSelectedContextItemInput[]): Promise<{
    items: OutreachSelectedContextItemInput[];
    truthByItemId: Map<string, OutreachContextTruth>;
  }> {
    const truthByItemId = new Map<string, OutreachContextTruth>();
    if (!items.length) return { items, truthByItemId };
    const enriched = await Promise.all(
      items.map(async (item) => {
        try {
          if (item.kind === 'bill') {
            const billId = billIdFromItemId(item.id);
            const block = billId ? await this.billTruthBlock(billId) : null;
            if (block) {
              truthByItemId.set(item.id, { kind: 'bill', raw: block.raw });
              return { ...item, body: block.text };
            }
            return item;
          }
          if (item.kind === 'programElement') {
            const peCode = peCodeFromItemId(item.id);
            const block = peCode ? await this.peTruthBlock(peCode) : null;
            if (block) {
              truthByItemId.set(item.id, { kind: 'programElement', raw: block.raw });
              return { ...item, body: block.text };
            }
            // RC1: on a lookup miss do NOT keep the thin client-supplied
            // "Current: $X / Request: $Y" body — an unverified, direction-
            // ambiguous figure must never survive into the prompt as fact.
            return {
              ...item,
              body: `No budget-funding record is available in Capiro's data for program element ${
                peCode ?? item.id
              }. Do NOT state or estimate any dollar figure for it.`,
            };
          }
        } catch (err) {
          this.logger.warn(
            `outreach context enrichment failed for ${item.id}: ${(err as Error).message}`,
          );
        }
        return item;
      }),
    );
    return { items: enriched, truthByItemId };
  }

  /** Authoritative bill-truth block (see outreach-context-enrichment). Null if the
   *  bill isn't on record — the caller then keeps the thin client body. */
  /**
   * Not private: AlertMemoService reuses this for its own live bill-status
   * re-query (5.2C / RC3 fix — the alert memo's fact sheet arrives pre-digested
   * from intel-api's Feed and can go stale before the memo is drafted). Same
   * global, non-RLS tables either way — this stays the single source of truth
   * rather than a second bill-status query getting built for that surface.
   */
  async billTruthBlock(billId: string): Promise<{ text: string; raw: BillTruth } | null> {
    const bill = await this.prisma.congressBill.findUnique({
      where: { id: billId },
      select: {
        id: true,
        title: true,
        status: true,
        statusAt: true,
        latestActionText: true,
        latestActionDate: true,
        sponsorName: true,
        sponsorParty: true,
        sponsorState: true,
        cosponsorsCount: true,
        committees: true,
      },
    });
    if (!bill) return null;

    const [votes, ruleLinks] = await Promise.all([
      this.prisma.rollCallVote.findMany({
        where: { billId },
        orderBy: { voteDate: 'desc' },
        take: 5,
        select: {
          chamber: true,
          rollNumber: true,
          question: true,
          result: true,
          yeas: true,
          nays: true,
          voteDate: true,
        },
      }),
      this.prisma.billRuleLink.findMany({
        where: { targetBillId: billId },
        select: { ruleBillId: true },
      }),
    ]);

    const governingRules: GoverningRuleRow[] = await Promise.all(
      ruleLinks.map(async (l) => {
        const [ruleBill, ruleVotes] = await Promise.all([
          this.prisma.congressBill.findUnique({
            where: { id: l.ruleBillId },
            select: { status: true, latestActionText: true },
          }),
          this.prisma.rollCallVote.findMany({
            where: { billId: l.ruleBillId },
            orderBy: { voteDate: 'desc' },
            take: 3,
            select: {
              chamber: true,
              rollNumber: true,
              question: true,
              result: true,
              yeas: true,
              nays: true,
              voteDate: true,
            },
          }),
        ]);
        return {
          ruleBillId: l.ruleBillId,
          ruleStatus: ruleBill?.status ?? null,
          ruleLatestAction: ruleBill?.latestActionText ?? null,
          ruleVotes: ruleVotes as BillVoteRow[],
        };
      }),
    );

    const committees = Array.isArray(bill.committees)
      ? (bill.committees as unknown[])
          .map((c) =>
            typeof c === 'string'
              ? c
              : c && typeof c === 'object' && 'name' in c
                ? String((c as { name: unknown }).name)
                : null,
          )
          .filter((c): c is string => Boolean(c))
      : [];

    const raw: BillTruth = {
      id: bill.id,
      title: bill.title,
      status: bill.status,
      statusAt: bill.statusAt,
      latestActionText: bill.latestActionText,
      latestActionDate: bill.latestActionDate,
      sponsorName: bill.sponsorName,
      sponsorParty: bill.sponsorParty,
      sponsorState: bill.sponsorState,
      cosponsorsCount: bill.cosponsorsCount,
      committees,
      votes: votes as BillVoteRow[],
      governingRules,
    };
    return { text: formatBillTruth(raw), raw };
  }

  /** Authoritative PE-funding block (see outreach-context-enrichment). Null if the
   *  PE isn't on record — the caller then keeps the thin client body. */
  private async peTruthBlock(peCode: string): Promise<{ text: string; raw: PeTruth } | null> {
    const pe = await this.prisma.programElement.findUnique({
      where: { peCode },
      select: { peCode: true, title: true, service: true, budgetActivityName: true },
    });
    if (!pe) return null;

    const years = await this.prisma.programElementYear.findMany({
      where: { peCode },
      orderBy: { fy: 'desc' },
      select: {
        fy: true,
        request: true,
        hascMark: true,
        sascMark: true,
        hacDMark: true,
        sacDMark: true,
        conference: true,
        ndaaConference: true,
        enacted: true,
      },
    });
    const num = (d: Prisma.Decimal | null): number | null => (d == null ? null : Number(d));
    // The FULL fiscal-year series — the authoritative block renders historical,
    // current-cycle, and outyear rows so trend/direction claims are grounded and
    // an outyear projection is never quoted as the current request.
    const series: PeYearFunding[] = years.map((y) => ({
      fy: y.fy,
      request: num(y.request),
      hascMark: num(y.hascMark),
      sascMark: num(y.sascMark),
      hacDMark: num(y.hacDMark),
      sacDMark: num(y.sacDMark),
      conference: num(y.conference),
      ndaaConference: num(y.ndaaConference),
      enacted: num(y.enacted),
    }));

    const raw: PeTruth = {
      peCode: pe.peCode,
      title: pe.title,
      service: pe.service,
      budgetActivityName: pe.budgetActivityName,
      currentCycleFy: currentCycleFyOf(series),
      years: series,
    };
    return { text: formatPeTruth(raw), raw };
  }

  /**
   * A compact, prompt-ready block of the client's actively tracked bills with
   * their latest action — a timely "reason to write now" hook for outreach.
   * tracked_bill is tenant-scoped (RLS); congress_bill is a GLOBAL table, so the
   * bill-detail read is safe inside the same withTenant transaction. Returns null
   * when the client tracks nothing. (Tier-1 outreach enrichment.)
   */
  private async outreachTrackedBillsBlock(
    ctx: TenantContext,
    clientId: string,
  ): Promise<string | null> {
    const { tracked, bills } = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const tracked = await tx.trackedBill.findMany({
        where: { tenantId: ctx.tenantId, clientId },
        orderBy: { updatedAt: 'desc' },
        take: 8,
        select: { billId: true, note: true },
      });
      if (!tracked.length) return { tracked, bills: [] as Array<Record<string, unknown>> };
      const billIds = tracked.map((t) => t.billId);
      const bills = await tx.congressBill.findMany({
        where: { id: { in: billIds } },
        select: {
          id: true,
          billType: true,
          billNumber: true,
          title: true,
          status: true,
          latestActionText: true,
          latestActionDate: true,
        },
      });
      return { tracked, bills: bills as Array<Record<string, unknown>> };
    });
    if (!tracked.length) return null;

    const byId = new Map(bills.map((b) => [b.id as string, b]));
    const lines = tracked
      .map((t) => {
        const bill = byId.get(t.billId);
        if (!bill) return null;
        const num = [
          (bill.billType as string | null)?.toUpperCase(),
          bill.billNumber as string | null,
        ]
          .filter(Boolean)
          .join(' ')
          .trim();
        const latestActionDate = bill.latestActionDate as Date | null;
        const action = bill.latestActionText
          ? ` — latest action: ${bill.latestActionText as string}${
              latestActionDate ? ` (${latestActionDate.toISOString().slice(0, 10)})` : ''
            }`
          : '';
        // Canonical LegiWatch status (rule_failed / passed_chamber / …) so a
        // stalled tracked bill isn't narrated as advancing from a stale action
        // string. One column on the row already selected — no extra query.
        const status = bill.status as string | null;
        const statusPart = status ? ` [status: ${billStatusLabel(status)}]` : '';
        const note = t.note?.trim() ? ` [client note: ${t.note.trim()}]` : '';
        return `- ${num || t.billId}: ${bill.title as string}${statusPart}${action}${note}`;
      })
      .filter((line): line is string => Boolean(line));

    return lines.length ? `Bills this client is actively tracking:\n${lines.join('\n')}` : null;
  }

  /**
   * The client's live intelligence action recommendations (the recommended
   * action + why it matters) — a near-ready ask. Excludes closed cards
   * (dismissed/archived) and takes the highest-priority few. Tenant + client
   * scoped. Returns null when there are none. (Tier-2 outreach enrichment.)
   */
  private async outreachActionsBlock(ctx: TenantContext, clientId: string): Promise<string | null> {
    const actions = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.actionRecommendation.findMany({
        where: { tenantId: ctx.tenantId, clientId, status: { notIn: ['dismissed', 'archived'] } },
        orderBy: [{ priority: 'desc' }, { deadline: 'asc' }],
        take: 5,
        select: { issueTitle: true, recommendedAction: true, whyItMatters: true, deadline: true },
      }),
    );
    if (!actions.length) return null;
    const lines = actions.map((a) => {
      const deadline = a.deadline ? ` (deadline ${a.deadline.toISOString().slice(0, 10)})` : '';
      return `- ${a.issueTitle}: ${a.recommendedAction}${deadline}\n  Why it matters: ${a.whyItMatters}`;
    });
    return `Recommended actions for this client (from the intelligence action feed):\n${lines.join(
      '\n',
    )}`;
  }

  /**
   * W5.5 — the client's watchlist priority issues (issue areas + tracked tags).
   * Renders the REAL watchlist signal: each tag's declared position (support/
   * oppose/monitor) and priority (low/med/high) when present on the tag object
   * (schema: client_watchlist.tags[].position/.priority). We surface the client's
   * stated stance but never invent one for a tag that has none. Client-level.
   */
  private async outreachClientWatchlistBlock(
    ctx: TenantContext,
    clientId: string,
  ): Promise<string | null> {
    const wl = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clientWatchlist.findFirst({
        where: { tenantId: ctx.tenantId, clientId },
        select: { issueAreas: true, tags: true },
      }),
    );
    if (!wl) return null;
    const tags = Array.isArray(wl.tags) ? wl.tags : [];
    // Each tag carries an optional declared position (support/oppose/monitor) and
    // priority (low/med/high) — surface them so the draft can reflect the client's
    // ACTUAL stance instead of a generic "cares about X". A tag with no stated
    // position renders bare (we still never invent one).
    const tagLabels = tags
      .map((t) => {
        if (!t || typeof t !== 'object') return '';
        const rec = t as { tag?: unknown; position?: unknown; priority?: unknown };
        const label = String(rec.tag ?? '').trim();
        if (!label) return '';
        const pos = typeof rec.position === 'string' ? rec.position.trim() : '';
        const pri = typeof rec.priority === 'string' ? rec.priority.trim() : '';
        const meta = [pos, pri ? `${pri} priority` : ''].filter(Boolean).join(', ');
        return meta ? `${label} (${meta})` : label;
      })
      .filter(Boolean);
    const areas = (wl.issueAreas ?? []).map((s) => s.trim()).filter(Boolean);
    if (!tagLabels.length && !areas.length) return null;
    const parts: string[] = [];
    if (areas.length) parts.push(`Issue areas: ${areas.slice(0, 12).join(', ')}`);
    if (tagLabels.length) parts.push(`Tracked priorities: ${tagLabels.slice(0, 12).join('; ')}`);
    return `Client watchlist (the client's standing priority issues and declared stance — align the ask to these where relevant; do not invent a position the client has not stated):\n${parts.join('\n')}`;
  }

  /**
   * "People this client works with" roster (client_people) — the biggest
   * who-does-this-client-know gap. Client-level / recipient-invariant, gated by
   * OUTREACH_CLIENT_PROFILE. tenant-scoped (RLS). Bounded + rendered by the pure
   * renderClientPeopleRoster. (Rich client-profile context.)
   */
  private async outreachClientPeopleBlock(
    ctx: TenantContext,
    clientId: string,
  ): Promise<string | null> {
    const people = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clientPerson.findMany({
        where: { tenantId: ctx.tenantId, clientId },
        orderBy: [{ lastContact: 'desc' }, { updatedAt: 'desc' }],
        take: 15,
        select: { name: true, title: true, role: true, notes: true, lastContact: true },
      }),
    );
    return renderClientPeopleRoster(people);
  }

  /**
   * The client's coordinated TARGET-OFFICE map: the team's explicit picks
   * (client_targets) UNION Meri's office recommendations (client_target_
   * recommendations), so a draft can frame the recipient as one of a planned set.
   * Client-level / recipient-invariant, gated by OUTREACH_CLIENT_PROFILE. Explicit
   * picks first; recommendations augment committee/billCount and fill the tail.
   */
  private async outreachClientTargetOfficesBlock(
    ctx: TenantContext,
    clientId: string,
  ): Promise<string | null> {
    const [targets, recs] = await Promise.all([
      this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.clientTarget.findMany({
          where: { tenantId: ctx.tenantId, clientId },
          orderBy: { addedAt: 'desc' },
          take: 20,
          select: {
            memberId: true,
            memberName: true,
            party: true,
            state: true,
            chamber: true,
            committee: true,
          },
        }),
      ),
      this.outreachTargetRecommendations(ctx, clientId),
    ]);

    const offices: TargetOfficeLite[] = [];
    const seen = new Set<string>();
    for (const t of targets) {
      const rec = t.memberId ? recs.byMember.get(t.memberId) : undefined;
      offices.push({
        memberId: t.memberId,
        office: t.memberName ?? rec?.office ?? null,
        party: t.party ?? rec?.party ?? null,
        state: t.state ?? rec?.state ?? null,
        chamber: t.chamber ?? rec?.chamber ?? null,
        committee: t.committee ?? rec?.committee ?? null,
        billCount: rec?.billCount ?? null,
        explicit: true,
      });
      if (t.memberId) seen.add(t.memberId);
    }
    // recs.byMember preserves the stored (score-sorted) recommendation order.
    for (const [memberId, rec] of recs.byMember) {
      if (seen.has(memberId)) continue;
      offices.push({
        memberId,
        office: rec.office,
        party: rec.party,
        state: rec.state,
        chamber: rec.chamber,
        committee: rec.committee,
        billCount: rec.billCount,
        explicit: false,
      });
    }
    return renderClientTargetOffices(offices);
  }

  /**
   * W5.2 — prior-outreach dedup. For each recipient email, the most recent SENT
   * outreach in the last 90d, so the draft doesn't repeat an ask verbatim (and the
   * wizard can badge "last contacted Nd ago"). Batched (one query) + tenant-scoped.
   */
  private async outreachPriorContactByEmail(
    ctx: TenantContext,
    clientId: string | null,
    emailsLower: string[],
  ): Promise<Map<string, { sentAt: Date; subject: string | null }>> {
    const out = new Map<string, { sentAt: Date; subject: string | null }>();
    if (!emailsLower.length) return out;
    const wanted = new Set(emailsLower);
    const since = new Date(Date.now() - 90 * 864e5);
    const rows = await this.prisma
      .withTenant(ctx.tenantId, (tx) =>
        tx.outreachRecord.findMany({
          where: {
            tenantId: ctx.tenantId,
            status: 'sent',
            sentAt: { gte: since },
            deletedAt: null,
            ...(clientId ? { clientId } : {}),
          },
          orderBy: { sentAt: 'desc' },
          take: 300,
          select: { subject: true, sentAt: true, recipients: true },
        }),
      )
      .catch(
        () => [] as Array<{ subject: string | null; sentAt: Date | null; recipients: unknown }>,
      );
    for (const r of rows) {
      if (!r.sentAt) continue;
      const recips = Array.isArray(r.recipients) ? r.recipients : [];
      for (const rc of recips) {
        const email =
          rc && typeof rc === 'object'
            ? String((rc as { email?: unknown }).email ?? '')
                .trim()
                .toLowerCase()
            : '';
        if (email && wanted.has(email) && !out.has(email)) {
          out.set(email, { sentAt: r.sentAt, subject: r.subject });
        }
      }
    }
    return out;
  }

  /**
   * W5.2 — public read wrapper around outreachPriorContactByEmail, so the wizard's
   * Recipients step can badge "last contacted Nd ago" DURING selection (before
   * generation runs). Delegates verbatim to the private batch query the generator
   * uses, so the badge and the prompt's priorOutreach line can never drift. Emails
   * with no sent record in the 90-day window are simply absent from the result
   * (never fabricated). Returns ISO date strings for the wire.
   */
  async getRecipientPriorContact(
    ctx: TenantContext,
    input: { clientId?: string | null; emails: string[] },
  ): Promise<Array<{ email: string; sentAt: string; subject: string | null }>> {
    const emailsLower = unique(input.emails.map((e) => e.trim().toLowerCase()).filter(Boolean));
    const byEmail = await this.outreachPriorContactByEmail(
      ctx,
      input.clientId ?? null,
      emailsLower,
    );
    return Array.from(byEmail.entries()).map(([email, v]) => ({
      email,
      sentAt: v.sentAt.toISOString(),
      subject: v.subject,
    }));
  }

  /**
   * W5.3 — upcoming hearings (next 30d) for the recipient's committees. Fetches
   * the window once (global committee_hearing, no RLS); callers filter per
   * recipient by committee name. Returns the raw rows so the per-recipient match
   * can do a tolerant name comparison (directory + hearing naming drift).
   */
  private async outreachUpcomingHearings(): Promise<
    Array<{ committeeName: string; chamber: string; title: string; date: Date }>
  > {
    const now = new Date();
    const startOfToday = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const in30 = new Date(startOfToday.getTime() + 30 * 864e5);
    return this.prisma.committeeHearing
      .findMany({
        where: { date: { gte: startOfToday, lte: in30 } },
        orderBy: { date: 'asc' },
        take: 300,
        select: { committeeName: true, chamber: true, title: true, date: true },
      })
      .catch(() => []);
  }

  /** Render a recipient's upcoming hearings from the pre-fetched window (cap 3). */
  private renderRecipientHearings(
    hearings: Array<{ committeeName: string; chamber: string; title: string; date: Date }>,
    committees: string[],
  ): string | null {
    if (!hearings.length || !committees.length) return null;
    const wanted = committees.map((c) => c.trim().toLowerCase()).filter(Boolean);
    const matches = hearings
      .filter((h) => {
        const name = h.committeeName.trim().toLowerCase();
        return wanted.some((c) => c && (name.includes(c) || c.includes(name)));
      })
      .slice(0, 3);
    if (!matches.length) return null;
    const lines = matches.map(
      (h) => `- ${h.date.toISOString().slice(0, 10)} — ${h.committeeName}: ${h.title}`,
    );
    return `Upcoming hearings on this recipient's committee(s) (next 30 days) — a timely reason to write now:\n${lines.join('\n')}`;
  }

  /**
   * W5.1 — the recipient's recent floor votes on the CLIENT's tracked bills.
   * billIds resolve once per campaign; votes/members are global (no RLS). Returns
   * a bioguide → rendered-block map for per-recipient lookup. Zero fabrication:
   * a recipient with no matching vote gets nothing.
   */
  private async outreachRelevantVotesByBioguide(
    bioguideIds: string[],
    trackedBillIds: string[],
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!bioguideIds.length || !trackedBillIds.length) return out;
    const votes = await this.prisma.rollCallVote
      .findMany({
        where: { billId: { in: trackedBillIds } },
        orderBy: { voteDate: 'desc' },
        take: 120,
        select: {
          id: true,
          billId: true,
          question: true,
          result: true,
          voteDate: true,
          title: true,
        },
      })
      .catch(
        () =>
          [] as Array<{
            id: string;
            billId: string | null;
            question: string | null;
            result: string | null;
            voteDate: Date;
            title: string | null;
          }>,
      );
    if (!votes.length) return out;
    const voteById = new Map(votes.map((v) => [v.id, v]));
    const members = await this.prisma.memberVote
      .findMany({
        where: { voteId: { in: votes.map((v) => v.id) }, bioguideId: { in: bioguideIds } },
        orderBy: { id: 'asc' },
        select: { voteId: true, bioguideId: true, voteCast: true },
      })
      .catch(() => [] as Array<{ voteId: string; bioguideId: string | null; voteCast: string }>);
    const byBioguide = new Map<string, string[]>();
    for (const m of members) {
      if (!m.bioguideId) continue;
      const v = voteById.get(m.voteId);
      if (!v) continue;
      const list = byBioguide.get(m.bioguideId) ?? [];
      if (list.length >= 3) continue;
      const label = v.question || v.title || 'floor vote';
      list.push(
        `- ${v.voteDate.toISOString().slice(0, 10)} — ${label}${v.result ? ` (${v.result})` : ''}: voted ${m.voteCast}`,
      );
      byBioguide.set(m.bioguideId, list);
    }
    for (const [bioguide, lines] of byBioguide) {
      out.set(
        bioguide,
        `This recipient's recent floor votes on the client's tracked bills (reference these accurately; never imply a position beyond the recorded vote):\n${lines.join('\n')}`,
      );
    }
    return out;
  }

  /**
   * W5.6 — voice few-shots: 2-3 excerpts from the user's OWN recently sent
   * outreach, so drafts sound like this author. PII-stripped (emails/phones
   * scrubbed) and capped; style guidance only, never a source of facts. Scoped to
   * the outreach path (appended to the voice block there), not the shared
   * loadUserVoiceBlock used by meeting prep/debrief.
   */
  private async outreachVoiceFewShots(ctx: TenantContext): Promise<string | null> {
    const rows = await this.prisma
      .withTenant(ctx.tenantId, (tx) =>
        tx.outreachRecord.findMany({
          where: {
            tenantId: ctx.tenantId,
            createdByUserId: ctx.userId,
            status: 'sent',
            deletedAt: null,
            body: { not: null },
          },
          orderBy: { sentAt: 'desc' },
          take: 3,
          select: { body: true },
        }),
      )
      .catch(() => [] as Array<{ body: string | null }>);
    const excerpts = rows
      .map((r) => scrubPiiForVoice(r.body ?? ''))
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s.length > 400 ? `${s.slice(0, 399).trim()}…` : s));
    if (!excerpts.length) return null;
    // Total cap ~1200 chars across the (up to 3) excerpts.
    const capped: string[] = [];
    let total = 0;
    for (const e of excerpts) {
      if (total + e.length > 1200) break;
      capped.push(e);
      total += e.length;
    }
    if (!capped.length) return null;
    return `RECENT SENT EXAMPLES BY THIS AUTHOR (mirror the tone, structure, and phrasing — do NOT copy content or reuse their specific facts):\n${capped
      .map((e, i) => `Example ${i + 1}:\n${e}`)
      .join('\n\n')}`;
  }

  /** Tracked bill ids for a client (client-level, resolved once per campaign). */
  private async outreachTrackedBillIds(ctx: TenantContext, clientId: string): Promise<string[]> {
    const rows = await this.prisma
      .withTenant(ctx.tenantId, (tx) =>
        tx.trackedBill.findMany({
          where: { tenantId: ctx.tenantId, clientId },
          select: { billId: true },
          take: 50,
        }),
      )
      .catch(() => [] as Array<{ billId: string }>);
    return rows.map((r) => r.billId);
  }

  /**
   * The Office Recommender's "why this office is a fit for the client" output —
   * one manual-refresh cache row per client holding an OfficeRecommendation[].
   * Indexed by directory member id so a recipient can be matched by its
   * directoryContactId. computedAt is surfaced so the caller can caveat stale
   * reasoning. (Tier-2 outreach enrichment.)
   */
  private async outreachTargetRecommendations(
    ctx: TenantContext,
    clientId: string,
  ): Promise<{ byMember: Map<string, OfficeRecommendation>; computedAt: string | null }> {
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clientTargetRecommendation.findUnique({ where: { clientId } }),
    );
    const byMember = new Map<string, OfficeRecommendation>();
    if (!row) return { byMember, computedAt: null };
    const recs = (row.recommendations ?? []) as unknown as OfficeRecommendation[];
    for (const rec of recs) {
      if (rec?.memberId) byMember.set(rec.memberId, rec);
    }
    return {
      byMember,
      computedAt: row.computedAt ? row.computedAt.toISOString().slice(0, 10) : null,
    };
  }

  /**
   * Recent press for a set of members, batched by bioguide id. member_press_item
   * is a GLOBAL table (no tenant_id / RLS), so it is read directly rather than
   * through withTenant. Keeps the most recent few per member. Dates serialize to
   * ISO via JSON.stringify in the prompt builder. (Tier-2 outreach enrichment.)
   */
  private async outreachMemberPress(bioguideIds: string[]): Promise<Map<string, unknown[]>> {
    const byBioguide = new Map<string, unknown[]>();
    const ids = unique(bioguideIds.filter(Boolean));
    if (!ids.length) return byBioguide;
    const PER_MEMBER = 3;
    const rows = await this.prisma.memberPressItem.findMany({
      where: { bioguideId: { in: ids } },
      orderBy: [{ publishedAt: 'desc' }, { syncedAt: 'desc' }],
      take: Math.min(ids.length * 4, 200),
      select: { bioguideId: true, title: true, link: true, publishedAt: true, summary: true },
    });
    for (const row of rows) {
      const list = byBioguide.get(row.bioguideId) ?? [];
      if (list.length < PER_MEMBER) {
        list.push({
          title: row.title,
          publishedAt: row.publishedAt ?? null,
          summary: row.summary ?? null,
          link: row.link,
        });
        byBioguide.set(row.bioguideId, list);
      }
    }
    return byBioguide;
  }

  /**
   * Recipients' recent correspondence with the sender, resolved for the WHOLE
   * batch in two queries and bucketed by lowercased email (email is the only
   * identifier shared across the directory, meeting-attendee, and mail tables).
   * Meetings match by attendee email (works with or without a client); mail
   * threads are client-scoped, so they load only when clientId is set. Both
   * reads are own-user + tenant scoped and best-effort. Dates serialize to ISO
   * via JSON.stringify in the prompt builder. Per recipient we keep the 3 most
   * recent of each. (Tier-1 outreach enrichment.)
   */
  private async batchRecipientCorrespondence(
    ctx: TenantContext,
    clientId: string | null,
    emailsLower: string[],
  ): Promise<{ meetingsByEmail: Map<string, unknown[]>; threadsByEmail: Map<string, unknown[]> }> {
    const meetingsByEmail = new Map<string, unknown[]>();
    const threadsByEmail = new Map<string, unknown[]>();
    if (!emailsLower.length) return { meetingsByEmail, threadsByEmail };
    const wanted = new Set(emailsLower);
    const PER_RECIPIENT = 3;

    const [meetings, threads] = await Promise.all([
      this.prisma
        .withTenant(ctx.tenantId, (tx) =>
          tx.meeting.findMany({
            where: {
              tenantId: ctx.tenantId,
              ...ownMeetingWhere(ctx.userId),
              attendees: { some: { email: { in: emailsLower } } },
            },
            select: {
              subject: true,
              startsAt: true,
              location: true,
              attendees: { select: { name: true, email: true, role: true } },
            },
            orderBy: { startsAt: 'desc' },
            take: 100,
          }),
        )
        .catch(
          () =>
            [] as Array<{
              subject: string | null;
              startsAt: Date | null;
              location: string | null;
              attendees: Array<{ name: string | null; email: string | null; role: string | null }>;
            }>,
        ),
      clientId
        ? this.listMailThreads(ctx, { clientId, recipientEmails: emailsLower }).catch(() => [])
        : Promise.resolve([]),
    ]);

    for (const meeting of meetings) {
      const item = {
        subject: meeting.subject ?? null,
        date: meeting.startsAt ?? null,
        location: meeting.location ?? null,
        attendees: meeting.attendees ?? [],
      };
      const attendeeEmails = new Set(
        (meeting.attendees ?? [])
          .map((a) => a.email?.trim().toLowerCase())
          .filter((e): e is string => Boolean(e)),
      );
      for (const email of attendeeEmails) {
        if (!wanted.has(email)) continue;
        const list = meetingsByEmail.get(email) ?? [];
        if (list.length < PER_RECIPIENT) {
          list.push(item);
          meetingsByEmail.set(email, list);
        }
      }
    }

    for (const thread of threads as Array<Record<string, unknown>>) {
      const item = {
        subject: (thread.subject as string | null) ?? null,
        lastMessageAt: (thread.lastMessageAt as Date | null) ?? null,
        snippet: (thread.snippet as string | null) ?? null,
      };
      for (const email of threadParticipantEmails(thread)) {
        if (!wanted.has(email)) continue;
        const list = threadsByEmail.get(email) ?? [];
        if (list.length < PER_RECIPIENT) {
          list.push(item);
          threadsByEmail.set(email, list);
        }
      }
    }

    return { meetingsByEmail, threadsByEmail };
  }

  async listCampaigns(ctx: TenantContext, query: { clientId?: string; status?: string }) {
    const clientId = query.clientId?.trim() || null;
    const status = query.status?.trim() || null;
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.engagementCampaign.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...(clientId ? { clientId } : {}),
          ...(status ? { status } : {}),
        },
        include: {
          client: clientSummarySelect(),
          createdBy: { select: { id: true, email: true, firstName: true, lastName: true } },
          recipients: true,
        },
        orderBy: { updatedAt: 'desc' },
      }),
    );
  }

  async createCampaign(
    ctx: TenantContext,
    input: {
      name: string;
      clientId?: string;
      type?: string;
      sourceContext?: Record<string, unknown>;
    },
  ) {
    const clientId = input.clientId?.trim() || null;
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      if (clientId) {
        await ensureExists(
          tx.client.findFirst({
            where: { id: clientId, tenantId: ctx.tenantId },
            select: { id: true },
          }),
          'Client not found',
        );
      }
      return tx.engagementCampaign.create({
        data: {
          tenantId: ctx.tenantId,
          clientId,
          createdByUserId: ctx.userId,
          name: input.name.trim(),
          type: input.type ?? 'custom',
          sourceContext: (input.sourceContext ?? {}) as Prisma.InputJsonValue,
        },
        include: {
          client: clientSummarySelect(),
          createdBy: { select: { id: true, email: true, firstName: true, lastName: true } },
          recipients: true,
        },
      });
    });
  }

  async getCampaign(ctx: TenantContext, id: string) {
    const campaign = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.engagementCampaign.findFirst({
        where: { id, tenantId: ctx.tenantId },
        include: {
          client: clientSummarySelect(),
          createdBy: { select: { id: true, email: true, firstName: true, lastName: true } },
          recipients: { orderBy: { createdAt: 'asc' } },
        },
      }),
    );
    if (!campaign) throw new NotFoundException('Campaign not found');
    return campaign;
  }

  async updateCampaign(
    ctx: TenantContext,
    id: string,
    input: {
      name?: string;
      clientId?: string | null;
      type?: string;
      status?: string;
      subject?: string | null;
      body?: string | null;
      sourceContext?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    },
  ) {
    const campaign = await this.getCampaign(ctx, id);
    const clientId = input.clientId === null ? null : input.clientId?.trim() || campaign.clientId;

    if (clientId && clientId !== campaign.clientId) {
      await this.prisma.withTenant(ctx.tenantId, (tx) =>
        ensureExists(
          tx.client.findFirst({
            where: { id: clientId, tenantId: ctx.tenantId },
            select: { id: true },
          }),
          'Client not found',
        ),
      );
    }

    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.engagementCampaign.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.clientId !== undefined ? { clientId } : {}),
          ...(input.type !== undefined ? { type: input.type } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.subject !== undefined ? { subject: input.subject } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.sourceContext !== undefined
            ? { sourceContext: input.sourceContext as Prisma.InputJsonValue }
            : {}),
          ...(input.metadata !== undefined
            ? {
                metadata: mergeJsonObjects(
                  campaign.metadata,
                  input.metadata,
                ) as Prisma.InputJsonValue,
              }
            : {}),
        },
        include: {
          client: clientSummarySelect(),
          createdBy: { select: { id: true, email: true, firstName: true, lastName: true } },
          recipients: { orderBy: { createdAt: 'asc' } },
        },
      }),
    );
  }

  async deleteCampaign(ctx: TenantContext, id: string) {
    await this.getCampaign(ctx, id);
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.engagementCampaign.delete({ where: { id } }),
    );
    return { ok: true };
  }

  async addCampaignRecipients(
    ctx: TenantContext,
    campaignId: string,
    recipients: Array<{ name?: string; email: string; title?: string; office?: string }>,
  ) {
    await this.getCampaign(ctx, campaignId);
    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.engagementCampaignRecipient.createMany({
        data: recipients.map((r) => ({
          tenantId: ctx.tenantId,
          campaignId,
          email: r.email.trim(),
          name: r.name?.trim() ?? null,
          title: r.title?.trim() ?? null,
          office: r.office?.trim() ?? null,
        })),
        skipDuplicates: true,
      }),
    );
  }

  async removeCampaignRecipient(ctx: TenantContext, campaignId: string, recipientId: string) {
    await this.getCampaign(ctx, campaignId);
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.engagementCampaignRecipient.deleteMany({
        where: { id: recipientId, campaignId, tenantId: ctx.tenantId },
      }),
    );
    return { ok: true };
  }

  async generateCampaignEmail(ctx: TenantContext, id: string, input: { customContext?: string }) {
    const campaign = await this.getCampaign(ctx, id);
    const sourceContext = (campaign.sourceContext ?? {}) as Record<string, unknown>;
    const meetingId = typeof sourceContext.meetingId === 'string' ? sourceContext.meetingId : null;
    const debriefId = typeof sourceContext.debriefId === 'string' ? sourceContext.debriefId : null;
    const customContext =
      typeof sourceContext.customContext === 'string'
        ? sourceContext.customContext
        : typeof input.customContext === 'string'
          ? input.customContext
          : null;

    const [meeting, debrief, prep] = await Promise.all([
      meetingId ? this.getMeeting(ctx, meetingId).catch(() => null) : Promise.resolve(null),
      debriefId
        ? this.prisma
            .withTenant(ctx.tenantId, (tx) =>
              tx.meetingDebrief.findFirst({
                where: { id: debriefId, tenantId: ctx.tenantId },
              }),
            )
            .catch(() => null)
        : Promise.resolve(null),
      meetingId
        ? this.prisma
            .withTenant(ctx.tenantId, (tx) =>
              tx.meetingPrep.findFirst({
                where: { meetingId, tenantId: ctx.tenantId },
                orderBy: { createdAt: 'desc' },
              }),
            )
            .catch(() => null)
        : Promise.resolve(null),
    ]);

    const clientId = campaign.clientId;
    const client = clientId ? await this.clientContext(ctx, clientId).catch(() => null) : null;

    const result = await this.ai.generateCampaignEmail(
      {
        campaign: pruneForAi(campaign),
        client: client ? pruneForAi(client) : null,
        meeting: meeting ? pruneForAi(meeting) : null,
        debrief: debrief ? pruneForAi(debrief) : null,
        prep: prep ? pruneForAi(prep) : null,
        recipients: campaign.recipients.map((r) => ({
          name: r.name,
          email: r.email,
          title: r.title,
          office: r.office,
        })),
        campaignType: campaign.type,
        customContext,
      },
      ctx,
    );
    await this.recordAiUsage(ctx, 'campaign_email', result);

    return this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.engagementCampaign.update({
        where: { id },
        data: {
          subject: result.subject,
          body: result.body,
          metadata: mergeJsonObjects(campaign.metadata, {
            aiGenerated: {
              provider: result.provider,
              model: result.model,
              at: new Date().toISOString(),
            },
          }) as Prisma.InputJsonValue,
        },
        include: {
          client: clientSummarySelect(),
          createdBy: { select: { id: true, email: true, firstName: true, lastName: true } },
          recipients: { orderBy: { createdAt: 'asc' } },
        },
      }),
    );
  }

  async sendCampaignEmails(ctx: TenantContext, id: string) {
    const campaign = await this.getCampaign(ctx, id);
    if (!campaign.subject?.trim() || !campaign.body?.trim()) {
      throw new BadRequestException('Campaign subject and body are required before sending');
    }
    const pendingRecipients = campaign.recipients.filter((r) => r.status === 'pending');
    if (!pendingRecipients.length) {
      throw new BadRequestException('No pending recipients to send to');
    }

    const connection = await this.findCampaignSendConnection(ctx);
    const sent: Array<{ id: string; email: string; sentAt: string }> = [];
    const errors: Array<{ id: string; email: string; message: string }> = [];

    for (const recipient of pendingRecipients) {
      const body = assembleCampaignBody(
        campaign.body,
        {
          name: recipient.name ?? undefined,
          email: recipient.email,
          title: recipient.title ?? undefined,
          office: recipient.office ?? undefined,
        },
        campaign.metadata,
      );
      const subject = assembleCampaignBody(
        campaign.subject,
        {
          name: recipient.name ?? undefined,
          email: recipient.email,
          title: recipient.title ?? undefined,
          office: recipient.office ?? undefined,
        },
        campaign.metadata,
      );
      try {
        await this.mailSender.sendMail(ctx, connection, {
          subject,
          body,
          toRecipients: [{ email: recipient.email, name: recipient.name ?? null }],
        });
        const now = new Date().toISOString();
        await this.prisma.withTenant(ctx.tenantId, (tx) =>
          tx.engagementCampaignRecipient.update({
            where: { id: recipient.id },
            data: { status: 'sent', sentAt: new Date() },
          }),
        );
        sent.push({ id: recipient.id, email: recipient.email, sentAt: now });
      } catch (error) {
        await this.prisma.withTenant(ctx.tenantId, (tx) =>
          tx.engagementCampaignRecipient.update({
            where: { id: recipient.id },
            data: { status: 'failed' },
          }),
        );
        errors.push({
          id: recipient.id,
          email: recipient.email,
          message: emailSendErrorMessage(error),
        });
      }
    }

    const allSent = errors.length === 0;
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.engagementCampaign.update({
        where: { id },
        data: {
          status: allSent ? 'complete' : 'active',
          sentAt: allSent ? new Date() : undefined,
        },
      }),
    );

    if (errors.length) {
      throw new ServiceUnavailableException(
        `Campaign send failed for ${errors.length} of ${pendingRecipients.length} recipients.`,
      );
    }
    return { ok: true, sent: sent.length };
  }

  async sendCampaignTest(ctx: TenantContext, id: string) {
    const campaign = await this.getCampaign(ctx, id);
    if (!campaign.subject?.trim() || !campaign.body?.trim()) {
      throw new BadRequestException('Campaign subject and body are required before sending a test');
    }

    const connection = await this.findCampaignSendConnection(ctx);
    const user = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.user.findFirst({
        where: { id: ctx.userId },
        select: { id: true, email: true, firstName: true },
      }),
    );
    if (!user) throw new BadRequestException('User not found');

    await this.mailSender.sendMail(ctx, connection, {
      subject: `[TEST] ${campaign.subject}`,
      body: campaign.body,
      toRecipients: [{ email: user.email, name: user.firstName ?? null }],
    });
    return { ok: true, sentTo: user.email };
  }
}

function meetingInclude() {
  return {
    client: clientSummarySelect(),
    attendees: { include: { contact: true }, orderBy: { createdAt: 'asc' as const } },
    attachments: { orderBy: { createdAt: 'desc' as const } },
    notes: { select: noteMetadataSelect(), orderBy: { createdAt: 'desc' as const } },
    debriefs: { select: debriefMetadataSelect(), orderBy: { createdAt: 'desc' as const } },
    preps: { orderBy: { createdAt: 'desc' as const }, take: 1 },
    tasks: {
      where: { status: { not: EngagementTaskStatus.canceled } },
      orderBy: [{ dueDate: 'asc' as const }, { createdAt: 'desc' as const }],
    },
  };
}

function isPlainTextAttachment(fileName: string, contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return (
    normalized.startsWith('text/') ||
    /\.(txt|text|md|csv|log)$/i.test(fileName) ||
    normalized === 'application/json'
  );
}

function isDocxAttachment(fileName: string, contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return (
    /\.docx$/i.test(fileName) ||
    normalized === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
}

function isPdfAttachment(fileName: string, contentType: string): boolean {
  return contentType.toLowerCase() === 'application/pdf' || /\.pdf$/i.test(fileName);
}

/** Extract text from a PDF buffer. Lazy-loads pdf-parse (heavy at module load). */
async function extractPdfBuffer(buffer: Buffer): Promise<string> {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  try {
    const parsed = await parser.getText();
    return (parsed.text ?? '').trim();
  } finally {
    await parser.destroy().catch(() => {});
  }
}

function isTranscribableAttachment(fileName: string, contentType: string): boolean {
  const normalized = contentType.toLowerCase();
  return (
    normalized.startsWith('audio/') ||
    normalized.startsWith('video/') ||
    /\.(mp3|mp4|mpeg|mpga|m4a|wav|webm)$/i.test(fileName)
  );
}

/**
 * Exported for NotetakerService: bot dispatch must enforce the SAME ownership
 * predicate as generateMeetingDebriefDraft/createMeetingDebrief, so a dispatch
 * for a meeting the user doesn't own fails fast at dispatch time — not after a
 * whole meeting has already been recorded.
 */
export function ownMeetingWhere(userId: string): Prisma.MeetingWhereInput {
  return {
    OR: [{ createdByUserId: userId }, { connection: { createdByUserId: userId } }],
  };
}

function ownMailThreadWhere(userId: string): Prisma.MailThreadWhereInput {
  return {
    connection: { createdByUserId: userId },
  };
}

function ownMailMessageWhere(userId: string): Prisma.MailMessageWhereInput {
  return {
    connection: { createdByUserId: userId },
  };
}

function outreachInclude() {
  return {
    client: clientSummarySelect(),
    meeting: {
      select: {
        id: true,
        clientId: true,
        subject: true,
        startsAt: true,
        endsAt: true,
        location: true,
        organizerEmail: true,
        organizerName: true,
        metadata: true,
        client: clientSummarySelect(),
        attendees: {
          select: { id: true, email: true, name: true, role: true },
          orderBy: { createdAt: 'asc' as const },
        },
        preps: {
          orderBy: { createdAt: 'desc' as const },
          take: 1,
        },
        debriefs: {
          select: debriefMetadataSelect(),
          orderBy: { createdAt: 'desc' as const },
          take: 1,
        },
      },
    },
    createdBy: { select: { id: true, email: true, firstName: true, lastName: true } },
  };
}

function clientSummarySelect() {
  return {
    select: {
      id: true,
      name: true,
      website: true,
      primaryContactName: true,
      primaryContactEmail: true,
      intakeData: true,
    },
  };
}

function noteMetadataSelect() {
  return {
    id: true,
    meetingId: true,
    clientId: true,
    authorUserId: true,
    author: { select: { id: true, email: true, firstName: true, lastName: true } },
    confidential: true,
    accessLevel: true,
    keyVersion: true,
    createdAt: true,
    updatedAt: true,
  };
}

function debriefMetadataSelect() {
  return {
    id: true,
    meetingId: true,
    clientId: true,
    authorUserId: true,
    author: { select: { id: true, email: true, firstName: true, lastName: true } },
    confidential: true,
    accessLevel: true,
    status: true,
    keyVersion: true,
    createdAt: true,
    updatedAt: true,
  };
}

function canReadEncryptedEntry(
  ctx: TenantContext,
  note: { confidential: boolean; accessLevel: string; authorUserId: string | null },
): boolean {
  if (!note.confidential) return true;
  if (note.authorUserId === ctx.userId) return true;
  if (ctx.role === 'user_admin' || ctx.role === 'capiro_admin') return true;
  return note.accessLevel === 'tenant_members';
}

function canEditEncryptedEntry(ctx: TenantContext, note: { authorUserId: string | null }): boolean {
  if (note.authorUserId === ctx.userId) return true;
  return ctx.role === 'user_admin' || ctx.role === 'capiro_admin';
}

// ── Meetings v2 response helpers ────────────────────────────────────────────
// scheduled → attending (in the call) → attended (call ended, Meri summarizing)
// → done (summary written to Meeting Notes).
type MeriCoarseState = 'scheduled' | 'attending' | 'attended' | 'done';

interface MeetingContributor {
  userId: string;
  name: string | null;
  artifacts: Array<'prep' | 'notes' | 'debrief'>;
}

/** The decorated-meeting fields the cross-user grouping reads. */
interface GroupableMeeting {
  id: string;
  iCalUId: string | null;
  sharedAt: Date | null;
  startsAt: Date;
  contributors: MeetingContributor[];
  notesApproved: boolean;
  meri: MeriCoarseState | null;
}

/**
 * Phase 2 collision model (spec §7, §4.4): collapse decorated meeting rows that
 * share a Graph `iCalUId` into ONE record. Two attendees' mailbox syncs produce
 * two per-mailbox rows with the SAME iCalUId; grouping presents them as one
 * meeting. The FIRST sharer (earliest sharedAt) is the primary contributor;
 * every group member's owner is merged into `contributors` (artifacts unioned,
 * deduped by user); notes are canonical (shown once — `notesApproved` = any
 * member); `notetakers` lists the per-sender names of members whose Meri
 * attended. Rows with no iCalUId (manual meetings / not-yet-backfilled) stay
 * standalone. Pure + non-destructive — the underlying rows are untouched.
 */
function mergeSharedMeetingsByICalUid<T extends GroupableMeeting>(
  rows: T[],
): Array<T & { notetakers: string[]; groupedMeetingIds: string[] }> {
  const sharedKey = (m: GroupableMeeting): number => (m.sharedAt ?? m.startsAt).getTime();
  const notetakersOf = (group: T[]): string[] => [
    ...new Set(
      group
        .filter((g) => g.meri != null)
        .map((g) => g.contributors[0]?.name)
        .filter((n): n is string => Boolean(n)),
    ),
  ];
  const mergeContributors = (ordered: T[]): MeetingContributor[] => {
    const byUser = new Map<string, MeetingContributor>();
    for (const r of ordered) {
      for (const c of r.contributors) {
        const existing = byUser.get(c.userId);
        if (existing) {
          existing.artifacts = [...new Set([...existing.artifacts, ...c.artifacts])];
        } else {
          byUser.set(c.userId, { ...c, artifacts: [...c.artifacts] });
        }
      }
    }
    return [...byUser.values()];
  };

  const out: Array<T & { notetakers: string[]; groupedMeetingIds: string[] }> = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.iCalUId) {
      out.push({ ...row, notetakers: notetakersOf([row]), groupedMeetingIds: [row.id] });
      continue;
    }
    if (seen.has(row.iCalUId)) continue;
    seen.add(row.iCalUId);
    const group = rows.filter((r) => r.iCalUId === row.iCalUId);
    if (group.length === 1) {
      out.push({ ...row, notetakers: notetakersOf(group), groupedMeetingIds: [row.id] });
      continue;
    }
    const ordered = [...group].sort((a, b) => sharedKey(a) - sharedKey(b));
    const primary = ordered[0]!;
    out.push({
      ...primary,
      contributors: mergeContributors(ordered),
      notesApproved: group.some((g) => g.notesApproved),
      notetakers: notetakersOf(ordered),
      groupedMeetingIds: ordered.map((g) => g.id),
    });
  }
  return out;
}

/**
 * Collapse a raw MeetingBotSession.status into the coarse notetaker state the UI
 * renders (Meetings v2 §9): scheduled/attending/done, or null when there is no
 * active notetaker (never sent, or the last session failed/was denied/removed —
 * in which case "Send Meri" should be offered again).
 */
function coarseMeriState(status: string | null): MeriCoarseState | null {
  switch (status) {
    case 'requested':
      return 'scheduled';
    case 'joining':
    case 'in_call':
    case 'recording':
      return 'attending';
    // Call ended (Recall call_ended fires when everyone leaves, possibly before
    // the scheduled end); Meri is turning the transcript into Meeting Notes.
    case 'processing':
    case 'drafting':
      return 'attended';
    case 'done':
      return 'done';
    default:
      return null;
  }
}

/** First+last name, falling back to email — the established display-name convention. */
function userDisplayName(user: {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
}): string | null {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim();
  return name || user.email || null;
}

/** Meeting Library pagination — house convention (default page 1, limit 50, cap 100). */
function normalizeLibraryPage(page?: number): number {
  const p = Number(page ?? 1);
  if (!Number.isFinite(p) || p < 1) return 1;
  return Math.floor(p);
}

function normalizeLibraryLimit(limit?: number): number {
  const l = Number(limit ?? 50);
  if (!Number.isFinite(l) || l < 1) return 50;
  return Math.min(100, Math.floor(l));
}

/**
 * Prisma `where` fragment for Library eligibility — "has at least one approved
 * artifact." A note counts once it exists (notes are final on capture, per §5);
 * prep/debrief must be `approved`. Narrows to a single artifact type when given.
 */
function libraryArtifactWhere(
  artifactType?: 'prep' | 'notes' | 'debrief',
): Prisma.MeetingWhereInput {
  const prep: Prisma.MeetingWhereInput = {
    preps: { some: { status: MeetingPrepStatus.approved } },
  };
  const debrief: Prisma.MeetingWhereInput = {
    debriefs: { some: { status: MeetingDebriefStatus.approved } },
  };
  const notes: Prisma.MeetingWhereInput = { notes: { some: {} } };
  if (artifactType === 'prep') return prep;
  if (artifactType === 'debrief') return debrief;
  if (artifactType === 'notes') return notes;
  return { OR: [prep, debrief, notes] };
}

function normalizeStringArray(value?: string[]): string[] {
  return (value ?? [])
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 80);
}

function normalizeReportPeriod(value?: string): ReportPeriod {
  if (value === 'previous' || value === 'all') return value;
  return 'current';
}

function reportPeriodWindow(period: ReportPeriod) {
  if (period === 'all') return { period, label: 'All time', from: null, to: null };

  const now = new Date();
  const year = now.getUTCFullYear() + (period === 'previous' ? -1 : 0);
  const from = new Date(Date.UTC(year, 0, 1));
  const to = new Date(Date.UTC(year + 1, 0, 1));
  return {
    period,
    label: period === 'previous' ? `Previous cycle (${year})` : `Current cycle (${year})`,
    from,
    to,
  };
}

function reportScopeKey(clientId: string | null | undefined): string {
  return clientId || 'all';
}

function normalizeReportStatus(value?: string | null): ReportStatus {
  return REPORT_STATUSES.includes(value as ReportStatus) ? (value as ReportStatus) : 'auto';
}

function mergeStoredStatus(current: ReportStatus, next?: ReportStatus): ReportStatus {
  if (current !== 'auto') return current;
  return next && next !== 'auto' ? next : current;
}

function resolveReportStatus(stored: ReportStatus, automatic: Exclude<ReportStatus, 'auto'>) {
  return stored === 'auto' ? automatic : stored;
}

function autoPrepStatus(row: ReportTargetDraft): Exclude<ReportStatus, 'auto'> {
  if (row.meetingIds.size === 0) return 'not_started';
  if (row.preparedMeetingIds.size >= row.meetingIds.size) return 'complete';
  if (row.preparedMeetingIds.size > 0 || row.approvedPrepMeetingIds.size > 0) return 'in_progress';
  return 'not_started';
}

function autoOutreachStatus(row: ReportTargetDraft): Exclude<ReportStatus, 'auto'> {
  if (row.sentMessageIds.size > 0) return 'complete';
  if (row.threadIds.size > 0) return 'in_progress';
  return 'not_started';
}

function reportOfficeKey(match: DirectoryEmailMatch): string {
  return `directory:${match.directoryContactId}`;
}

function reportTargetDetails(match: DirectoryEmailMatch) {
  return {
    memberPrincipal: reportMemberPrincipal(match),
    committee: match.member.committees[0] ?? null,
    staffer: match.staff?.fullName ?? null,
    building: reportBuilding(match),
  };
}

function reportMemberPrincipal(match: DirectoryEmailMatch): string {
  const member = match.member;
  const district = member.chamber === 'House' ? `${member.state}-${member.district}` : member.state;
  return `${member.fullName} (${partyInitial(member.partyName)}-${district})`;
}

function partyInitial(partyName: string): string {
  const normalized = partyName.toLowerCase();
  if (normalized.startsWith('dem')) return 'D';
  if (normalized.startsWith('rep')) return 'R';
  if (normalized.startsWith('ind')) return 'I';
  return partyName.slice(0, 1).toUpperCase() || '?';
}

function reportBuilding(match: DirectoryEmailMatch): string | null {
  const value =
    match.staff?.officeLocation ||
    match.member.officeLocation ||
    match.member.addresses.find((address) => address.isMain)?.title ||
    '';
  if (!value) return null;
  if (/rayburn/i.test(value)) return 'Rayburn';
  if (/cannon/i.test(value)) return 'Cannon';
  if (/longworth/i.test(value)) return 'Longworth';
  if (/russell/i.test(value)) return 'Russell';
  if (/dirksen/i.test(value)) return 'Dirksen';
  if (/hart/i.test(value)) return 'Hart';
  return value.slice(0, 120);
}

function uniqueDirectoryMatches(matches: DirectoryEmailMatch[]): DirectoryEmailMatch[] {
  const seen = new Set<string>();
  const next: DirectoryEmailMatch[] = [];
  for (const match of matches) {
    const key = `${match.directoryContactId}:${match.staff?.id ?? 'member'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(match);
  }
  return next;
}

function mailMessageEmails(message: {
  fromEmail: string | null;
  toRecipients: Prisma.JsonValue;
  ccRecipients: Prisma.JsonValue;
  bccRecipients: Prisma.JsonValue;
}): string[] {
  return unique(
    [
      normalizeEmailAddress(message.fromEmail),
      ...recipientEmails(message.toRecipients),
      ...recipientEmails(message.ccRecipients),
      ...recipientEmails(message.bccRecipients),
    ].filter((email): email is string => Boolean(email)),
  );
}

type MailThreadParticipant = {
  email: string | null;
  name: string | null;
  role: string | null;
};

function parseMailThreadParticipants(value: Prisma.JsonValue): MailThreadParticipant[] {
  if (!Array.isArray(value)) return [];

  const rows: MailThreadParticipant[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;

    const email =
      normalizeEmailAddress(
        typeof record.email === 'string'
          ? record.email
          : typeof record.address === 'string'
            ? record.address
            : null,
      ) ?? null;

    const name =
      typeof record.name === 'string' && record.name.trim().length > 0 ? record.name.trim() : null;

    const role =
      typeof record.role === 'string' && record.role.trim().length > 0 ? record.role.trim() : null;

    if (!email && !name) continue;
    rows.push({ email, name, role });
  }

  return rows;
}

function recipientEmails(value: Prisma.JsonValue): string[] {
  return parseMailThreadParticipants(value)
    .map((participant) => participant.email)
    .filter((email): email is string => Boolean(email));
}

function isSentMailMessage(metadata: Prisma.JsonValue): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const record = metadata as Record<string, unknown>;
  const folder = typeof record.folder === 'string' ? record.folder.toLowerCase() : '';
  const folders = Array.isArray(record.folders)
    ? record.folders
        .map((entry) => (typeof entry === 'string' ? entry.toLowerCase() : ''))
        .filter(Boolean)
    : [];
  return folder === 'sentitems' || folder === 'sent items' || folders.includes('sentitems');
}

function readWebLink(metadata: Prisma.JsonValue): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).webLink;
  return typeof value === 'string' && /^https:\/\//i.test(value) ? value : null;
}

function requiredReportText(value: string | undefined | null, field: string, max: number): string {
  const text = value?.trim();
  if (!text) throw new BadRequestException(`${field} is required`);
  return text.slice(0, max);
}

function optionalReportText(value: string | undefined | null, max: number): string | null {
  const text = value?.trim();
  return text ? text.slice(0, max) : null;
}

function optionalText(value?: string | null): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

function builtinOutboundCampaignTemplates() {
  const templates = [
    {
      id: 'builtin-congressional-meeting-minutes',
      name: 'Congressional Meeting Minutes - {meeting_subject}',
      subject: 'Congressional Meeting Minutes - {meeting_subject}',
      description:
        'Formal minutes with date, participant names, location, summary, and next steps.',
      sections: [
        'Summary - Key Takeaways',
        '',
        'Purpose of Engagement',
        '{prep_summary}',
        '',
        'Meeting Debrief',
        '{debrief_summary}',
        '',
        'Follow-Up Items and Next Steps',
        'Use only the saved prep and debrief context above. If a detail is not present in the available Capiro context, omit it rather than making anything up.',
      ],
    },
    {
      id: 'builtin-outbound-memo',
      name: 'Memo',
      subject: 'Memo - {meeting_subject}',
      description:
        'A concise internal memo summarizing context, takeaways, and recommended follow-up.',
      sections: [
        'To: Internal Team',
        'From: Capiro Engagement Manager',
        'Re: {meeting_subject}',
        '',
        'Background',
        '{prep_summary}',
        '',
        'Discussion',
        '{debrief_summary}',
        '',
        'Recommended Next Steps',
      ],
    },
    {
      id: 'builtin-intel-report',
      name: 'Intel Report',
      subject: 'Intel Report - {meeting_subject}',
      description:
        'An analyst-style report focused on stakeholder signals, risks, and opportunities.',
      sections: [
        'Executive Signal',
        '',
        'Stakeholder Context',
        '{attendee_names}',
        '{attendee_emails}',
        '',
        'Intelligence Notes',
        '{prep_summary}',
        '{debrief_summary}',
        '',
        'Risks, Open Questions, and Opportunities',
      ],
    },
    {
      id: 'builtin-client-update',
      name: 'Client Update',
      subject: 'Client Update - {meeting_subject}',
      description: 'A client-ready update summarizing engagement activity and what happens next.',
      sections: [
        'Engagement Overview',
        '{prep_summary}',
        '',
        'What We Heard',
        '{debrief_summary}',
        '',
        'Next Steps',
      ],
    },
    {
      id: 'builtin-follow-up-brief',
      name: 'Follow-Up Brief',
      subject: 'Follow-Up - {meeting_subject}',
      description: 'A practical follow-up brief that turns meeting notes into clear actions.',
      sections: [
        'Thank you for the time and discussion.',
        '',
        'Discussion Recap',
        '{debrief_summary}',
        '',
        'Useful Context',
        '{prep_summary}',
        '',
        'Next Steps',
      ],
    },
    {
      id: 'builtin-action-tracker',
      name: 'Action Items Tracker',
      subject: 'Action Items - {meeting_subject}',
      description: 'An operational template organized around follow-ups, owners, and deadlines.',
      sections: [
        'Action Item Summary',
        '',
        'Known Follow-Ups',
        '{prep_summary}',
        '{debrief_summary}',
        '',
        'Open Items',
        '',
        'Owner / Deadline',
      ],
    },
  ];

  return templates.map((template) => ({
    id: template.id,
    source: 'system' as const,
    type: 'outbound_campaign',
    name: template.name,
    subject: template.subject,
    body: [...outboundLetterhead(), '', ...template.sections].join('\n'),
    metadata: {
      source: 'system',
      description: template.description,
      variables: OUTBOUND_CAMPAIGN_VARIABLES,
    },
    createdAt: null,
    updatedAt: null,
  }));
}

function outboundLetterhead(): string[] {
  return [
    'Date: {current_date_time}',
    'Participant Names: {attendee_names}',
    'Location: {meeting_location}',
    'Meeting: {meeting_subject}',
    'Meeting Date/Time: {meeting_date_time}',
  ];
}

function outboundTemplateBody(
  record: { type: string; body: string | null; metadata: Prisma.JsonValue },
  metadata?: Record<string, unknown>,
): string | null {
  if (record.type !== 'outbound_campaign') return record.body;
  const explicitBody = readNestedString(metadata, ['outboundTemplate', 'body']);
  const storedBody = readNestedString(record.metadata, ['outboundTemplate', 'body']);
  return explicitBody || storedBody || record.body || defaultOutboundCampaignGenerationBrief();
}

function defaultOutboundCampaignGenerationBrief(): string {
  return [
    'Generate a personalized outbound campaign email from the loaded Capiro meeting context.',
    'Start with a letterhead-style block using current date/time, participant names, and location.',
    'Use the recipient context fields for attendee names, attendee emails, prep summary, debrief summary, meeting location, meeting subject, and meeting date/time.',
    'If prep or debrief content is missing for a recipient, omit that detail. Do not make anything up.',
    'Keep the message practical, readable, and specific to the recipient where the context supports it.',
  ].join('\n');
}

function readNestedString(value: unknown, path: string[]): string | null {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return readString(current);
}

function summarizeMeetingPrep(
  prep: {
    summary: string | null;
    agenda: Prisma.JsonValue;
    talkingPoints: Prisma.JsonValue;
    followUps: Prisma.JsonValue;
  } | null,
): string {
  if (!prep) return '';
  const lines = [
    prep.summary,
    ...jsonStringArray(prep.agenda).map((item) => `Agenda: ${item}`),
    ...jsonStringArray(prep.talkingPoints).map((item) => `Talking point: ${item}`),
    ...jsonStringArray(prep.followUps).map((item) => `Follow-up: ${item}`),
  ].filter((line): line is string => Boolean(line?.trim()));
  return summarizeText(lines.join('\n'), 1200);
}

function jsonStringArray(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean)
    .slice(0, 12);
}

function summarizeText(value: string, max = 800): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trim()}...`;
}

function formatDirectoryMainOffice(match?: DirectoryEmailMatch | null): string | null {
  if (!match) return null;
  const address =
    match.member.addresses.find((row) => row.isMain) ?? match.member.addresses[0] ?? null;
  if (!address) return match.staff?.officeLocation || match.member.officeLocation || null;
  const street = [address.address1, address.address2].filter(Boolean).join(', ');
  const cityState = [address.city, address.state].filter(Boolean).join(', ');
  const tail = [cityState, address.zip].filter(Boolean).join(' ');
  return [address.title, street, tail].filter(Boolean).join(', ');
}

function outboundRelevanceReason(match?: DirectoryEmailMatch | null): string | null {
  if (!match) return null;
  return [
    match.matchKind === 'staff' ? match.staff?.title : match.member.title,
    match.member.committees[0],
    match.member.officeLocation,
  ]
    .filter(Boolean)
    .join(' | ');
}

/**
 * Synthesize a short, prompt-ready profile of an outreach recipient from their
 * congressional-directory match: who they are, their committees/leadership, and
 * — for staffers — their role and issue portfolio. Deliberately uses STAFFER-level
 * issue coverage + committees (the real signal) and NEVER the member-level issue
 * tags (member.focusAreas), which are near-universal noise. Returns null when
 * there is no directory match (e.g. a to-clients recipient). (Tier-1 enrichment.)
 */
function formatRecipientDirectoryProfile(match: DirectoryEmailMatch | null): string | null {
  if (!match) return null;
  const m = match.member;
  const locale = [m.state, m.district].filter(Boolean).join('-');
  const seat = [m.partyName, locale].filter(Boolean).join(', ');
  const memberLabel = [
    m.title || m.memberName || match.directoryContactName,
    seat ? `(${seat})` : null,
  ]
    .filter(Boolean)
    .join(' ');
  const committees = m.committees?.length
    ? `Committees: ${m.committees.slice(0, 6).join('; ')}.`
    : null;
  const leadership = m.leadershipPositions?.length
    ? `Leadership: ${m.leadershipPositions.slice(0, 4).join('; ')}.`
    : null;

  if (match.matchKind === 'staff' && match.staff) {
    const s = match.staff;
    const roles = s.roles?.length ? `Role: ${s.roles.slice(0, 4).join(', ')}.` : null;
    const coverage = s.issueAreas?.length
      ? `Issue portfolio: ${s.issueAreas.slice(0, 8).join(', ')}.`
      : null;
    return [
      `${s.fullName}${s.title ? `, ${s.title},` : ','} in the office of ${memberLabel}.`,
      roles,
      coverage,
      committees,
      leadership,
    ]
      .filter(Boolean)
      .join(' ');
  }

  return [`${memberLabel}.`, committees, leadership].filter(Boolean).join(' ');
}

/**
 * Turn an Office Recommender result for a specific office into a one-line "why
 * this office is a fit for the client" rationale, drawn from the transparent
 * signal tags + jurisdiction committee + tracked-bill count. Returns null when
 * there is no recommendation or no usable signal. (Tier-2 outreach enrichment.)
 */
function formatTargetRationale(
  rec: OfficeRecommendation | undefined,
  computedAt: string | null,
): string | null {
  if (!rec) return null;
  const bits: string[] = [];
  const tags = rec.tags ?? [];
  if (rec.committee && (tags.includes('committee') || rec.billCount > 0)) {
    bits.push(
      rec.billCount > 0
        ? `sits on ${rec.committee}, which has jurisdiction over ${rec.billCount} of the client's tracked bill${
            rec.billCount === 1 ? '' : 's'
          }`
        : `sits on ${rec.committee}`,
    );
  } else if (tags.includes('committee') && rec.billCount > 0) {
    bits.push(
      `has jurisdiction over ${rec.billCount} of the client's tracked bill${
        rec.billCount === 1 ? '' : 's'
      }`,
    );
  }
  if (tags.includes('district')) {
    bits.push(`has a constituent / facility nexus in ${rec.state ?? "the client's footprint"}`);
  }
  if (tags.includes('issue')) bits.push("overlaps the client's core issue areas");
  if (tags.includes('leadership')) bits.push('holds a relevant leadership post');
  if (!bits.length) return null;
  const asOf = computedAt ? ` (recommender as of ${computedAt})` : '';
  return `Why this office is a fit for the client: ${bits.join('; ')}${asOf}.`;
}

/**
 * Collect the lowercased email addresses that appear on a mail thread — from its
 * participants list and from the (up to 3) included messages' from/to/cc — so a
 * batch of threads can be bucketed to the specific recipient(s) they involve.
 * Defensive against loosely-typed JSON columns. (Tier-1 outreach enrichment.)
 */
function threadParticipantEmails(thread: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    const email = value.trim().toLowerCase();
    if (email) out.add(email);
  };
  const participants = thread.participants;
  if (Array.isArray(participants)) {
    for (const participant of participants) {
      if (participant && typeof participant === 'object') {
        add((participant as { email?: unknown }).email);
      }
    }
  }
  const messages = thread.messages;
  if (Array.isArray(messages)) {
    for (const message of messages) {
      if (!message || typeof message !== 'object') continue;
      const row = message as Record<string, unknown>;
      add(row.fromEmail);
      for (const key of ['toRecipients', 'ccRecipients'] as const) {
        const recipients = row[key];
        if (!Array.isArray(recipients)) continue;
        for (const recipient of recipients) {
          if (recipient && typeof recipient === 'object') {
            add((recipient as { email?: unknown }).email);
          } else {
            add(recipient);
          }
        }
      }
    }
  }
  return out;
}

function normalizeOutreachType(value?: string | null): OutreachType | null {
  if (
    value === 'campaign' ||
    value === 'follow_up' ||
    value === 'prep' ||
    value === 'outbound_campaign'
  ) {
    return value;
  }
  if (!value || value === 'all') return null;
  throw new BadRequestException(
    'type must be campaign, follow_up, prep, outbound_campaign, or all',
  );
}

function normalizeOutreachTemplateType(value?: string | null): 'outbound_campaign' {
  if (!value || value === 'outbound_campaign') return 'outbound_campaign';
  throw new BadRequestException('template type must be outbound_campaign');
}

function normalizeOutreachStatus(value?: string | null): OutreachStatus {
  if (value === 'draft' || value === 'sent' || value === 'opened_in_email' || value === 'failed') {
    return value;
  }
  throw new BadRequestException('status must be draft, sent, opened_in_email, or failed');
}

function normalizeOutreachRecipients(value?: unknown): OutreachRecipientInput[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const record = entry as Record<string, unknown>;
      const id = readString(record.id);
      const clientId = readString(record.clientId);
      const direction =
        record.direction === 'on-behalf' || record.direction === 'to-clients'
          ? (record.direction as 'on-behalf' | 'to-clients')
          : undefined;
      const email = normalizeEmailAddress(readString(record.email));
      const name = readString(record.name);
      const office = readString(record.office);
      const title = readString(record.title);
      const chamber = readString(record.chamber);
      const state = readString(record.state);
      const district = readString(record.district);
      const party = readString(record.party);
      const directoryContactId = readString(record.directoryContactId);
      const directoryContactName = readString(record.directoryContactName);
      const committee = readString(record.committee);
      const address = readString(record.address);
      const relevanceReason = readString(record.relevanceReason);
      const personalNote = readString(record.personalNote);
      const meetingId = readString(record.meetingId);
      const meetingSubject = readString(record.meetingSubject);
      const meetingDateTime = readString(record.meetingDateTime);
      const attendeeNames = readString(record.attendeeNames);
      const attendeeEmails = readString(record.attendeeEmails);
      const prepSummary = readString(record.prepSummary);
      const debriefSummary = readString(record.debriefSummary);
      const meetingLocation = readString(record.meetingLocation);
      if (!email && !name && !id && !directoryContactId) return null;
      return {
        ...(id ? { id: id.slice(0, 240) } : {}),
        ...(clientId ? { clientId: clientId.slice(0, 80) } : {}),
        ...(direction ? { direction } : {}),
        ...(name ? { name: name.slice(0, 160) } : {}),
        ...(email ? { email } : {}),
        ...(office ? { office: office.slice(0, 240) } : {}),
        ...(title ? { title: title.slice(0, 160) } : {}),
        ...(chamber ? { chamber: chamber.slice(0, 80) } : {}),
        ...(state ? { state: state.slice(0, 80) } : {}),
        ...(district ? { district: district.slice(0, 80) } : {}),
        ...(party ? { party: party.slice(0, 80) } : {}),
        ...(directoryContactId ? { directoryContactId: directoryContactId.slice(0, 240) } : {}),
        ...(directoryContactName
          ? { directoryContactName: directoryContactName.slice(0, 240) }
          : {}),
        ...(committee ? { committee: committee.slice(0, 160) } : {}),
        ...(address ? { address: address.slice(0, 500) } : {}),
        ...(relevanceReason ? { relevanceReason: relevanceReason.slice(0, 240) } : {}),
        ...(personalNote ? { personalNote: personalNote.slice(0, 500) } : {}),
        ...(meetingId ? { meetingId: meetingId.slice(0, 80) } : {}),
        ...(meetingSubject ? { meetingSubject: meetingSubject.slice(0, 240) } : {}),
        ...(meetingDateTime ? { meetingDateTime: meetingDateTime.slice(0, 120) } : {}),
        ...(attendeeNames ? { attendeeNames: attendeeNames.slice(0, 1000) } : {}),
        ...(attendeeEmails ? { attendeeEmails: attendeeEmails.slice(0, 1000) } : {}),
        ...(prepSummary ? { prepSummary: prepSummary.slice(0, 2000) } : {}),
        ...(debriefSummary ? { debriefSummary: debriefSummary.slice(0, 2000) } : {}),
        ...(meetingLocation ? { meetingLocation: meetingLocation.slice(0, 500) } : {}),
      };
    })
    .filter((entry): entry is OutreachRecipientInput => Boolean(entry))
    .slice(0, 500);
}

function normalizeOutreachDirection(value?: unknown): 'on-behalf' | 'to-clients' {
  if (value === 'to-clients') return 'to-clients';
  return 'on-behalf';
}

function applyOutreachDirection(
  recipients: OutreachRecipientInput[],
  direction: 'on-behalf' | 'to-clients',
): OutreachRecipientInput[] {
  return recipients.map((recipient) => ({ ...recipient, direction }));
}

function normalizeOutreachContextPool(value?: unknown): OutreachContextPoolItemInput[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      const record = entry as Record<string, unknown>;
      const id = readString(record.id);
      const sourceType = readString(record.sourceType);
      const title = readString(record.title);
      const summary = readString(record.summary);
      const note = readString(record.note);
      const scope = readString(record.scope);
      const recipientIds = Array.isArray(record.recipientIds)
        ? record.recipientIds
            .map((item) => readString(item))
            .filter((item): item is string => Boolean(item))
            .slice(0, 200)
        : [];
      const matches = Array.isArray(record.matches)
        ? record.matches
            .map((item) => readString(item))
            .filter((item): item is string => Boolean(item))
            .slice(0, 200)
        : [];
      if (!id && !title && !summary && !note) return null;
      return {
        ...(id ? { id: id.slice(0, 240) } : {}),
        ...(sourceType ? { sourceType: sourceType.slice(0, 80) } : {}),
        ...(title ? { title: title.slice(0, 240) } : {}),
        ...(summary ? { summary: summary.slice(0, 2000) } : {}),
        ...(note ? { note: note.slice(0, 2000) } : {}),
        ...(scope ? { scope: scope.slice(0, 240) } : {}),
        ...(recipientIds.length ? { recipientIds } : {}),
        ...(matches.length ? { matches } : {}),
      };
    })
    .filter((entry): entry is OutreachContextPoolItemInput => Boolean(entry))
    .slice(0, 500);
}

function sanitizeOutreachMetadata(value?: Record<string, unknown>): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function mergeJsonObjects(
  base: Prisma.JsonValue | Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const baseRecord =
    base && typeof base === 'object' && !Array.isArray(base)
      ? (base as Record<string, unknown>)
      : {};
  return { ...baseRecord, ...next };
}

function readMetadataString(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  return readString((metadata as Record<string, unknown>)[key]);
}

function readMetadataUnknown(metadata: unknown, key: string): unknown {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  return (metadata as Record<string, unknown>)[key];
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function buildMailtoUrl(recipients: OutreachRecipientInput[], subject: string, body: string) {
  const to = recipients
    .map((recipient) => normalizeEmailAddress(recipient.email))
    .filter((email): email is string => Boolean(email))
    .join(',');
  const params = new URLSearchParams({ subject, body });
  return `mailto:${encodeURIComponent(to)}?${params.toString()}`;
}

function assembleCampaignBody(
  body: string,
  recipient: OutreachRecipientInput,
  metadata?: Prisma.JsonValue,
): string {
  const currentDateTime =
    readMetadataString(metadata ?? null, 'campaignCurrentDateTime') ??
    readMetadataString(metadata ?? null, 'outboundCurrentDateTime') ??
    readNestedString(metadata ?? null, ['ai', 'generatedAt']) ??
    new Date().toISOString();
  return stripUnresolvedTemplateFields(
    body
      .replaceAll('{current_date_time}', formatCurrentDateTime(currentDateTime))
      .replaceAll(
        '{district}',
        recipient.district || recipient.state || readFieldFallback(metadata, '{district}'),
      )
      .replaceAll('{committee}', recipient.committee || readFieldFallback(metadata, '{committee}'))
      .replaceAll('{member_priority}', recipient.relevanceReason || '')
      .replaceAll('{personal_note}', recipient.personalNote || '')
      .replaceAll(
        '{address}',
        recipient.address || recipient.meetingLocation || readFieldFallback(metadata, '{address}'),
      )
      .replaceAll('{attendee_names}', recipient.attendeeNames || recipient.name || '')
      .replaceAll('{attendee_emails}', recipient.attendeeEmails || recipient.email || '')
      .replaceAll('{prep_summary}', recipient.prepSummary || '')
      .replaceAll('{debrief_summary}', recipient.debriefSummary || '')
      .replaceAll('{meeting_location}', recipient.meetingLocation || '')
      .replaceAll('{meeting_subject}', recipient.meetingSubject || '')
      .replaceAll('{meeting_date_time}', recipient.meetingDateTime || ''),
  );
}

function resolveGeneratedCampaignDraft(
  body: string,
  recipients: OutreachRecipientInput[],
  metadata?: unknown,
): string {
  const currentDateTime =
    readMetadataString(metadata ?? null, 'campaignCurrentDateTime') ??
    readMetadataString(metadata ?? null, 'outboundCurrentDateTime') ??
    readNestedString(metadata ?? null, ['ai', 'generatedAt']) ??
    new Date().toISOString();
  const aggregate = aggregateCampaignRecipientValues(recipients);
  return stripUnresolvedTemplateFields(
    body
      .replaceAll('{current_date_time}', formatCurrentDateTime(currentDateTime))
      .replaceAll('{district}', aggregate.district || readFieldFallback(metadata, '{district}'))
      .replaceAll('{committee}', aggregate.committee || readFieldFallback(metadata, '{committee}'))
      .replaceAll('{member_priority}', aggregate.memberPriority)
      .replaceAll('{personal_note}', '')
      .replaceAll('{address}', aggregate.address || readFieldFallback(metadata, '{address}'))
      .replaceAll('{attendee_names}', aggregate.attendeeNames)
      .replaceAll('{attendee_emails}', aggregate.attendeeEmails)
      .replaceAll('{prep_summary}', aggregate.prepSummary)
      .replaceAll('{debrief_summary}', aggregate.debriefSummary)
      .replaceAll('{meeting_location}', aggregate.meetingLocation)
      .replaceAll('{meeting_subject}', aggregate.meetingSubject)
      .replaceAll('{meeting_date_time}', aggregate.meetingDateTime),
  );
}

function aggregateCampaignRecipientValues(recipients: OutreachRecipientInput[]) {
  return {
    district: sharedRecipientValue(
      recipients,
      (recipient) => recipient.district || recipient.state,
    ),
    committee: sharedRecipientValue(recipients, (recipient) => recipient.committee),
    address: sharedRecipientValue(
      recipients,
      (recipient) => recipient.address || recipient.meetingLocation,
    ),
    memberPriority: uniqueText(recipients.map((recipient) => recipient.relevanceReason)).join('; '),
    attendeeNames: uniqueText(
      recipients.map((recipient) => recipient.attendeeNames || recipient.name),
    ).join(', '),
    attendeeEmails: uniqueText(
      recipients.map((recipient) => recipient.attendeeEmails || recipient.email),
    ).join(', '),
    prepSummary: uniqueText(recipients.map((recipient) => recipient.prepSummary)).join('\n\n'),
    debriefSummary: uniqueText(recipients.map((recipient) => recipient.debriefSummary)).join(
      '\n\n',
    ),
    meetingLocation: sharedRecipientValue(recipients, (recipient) => recipient.meetingLocation),
    meetingSubject: sharedRecipientValue(recipients, (recipient) => recipient.meetingSubject),
    meetingDateTime: sharedRecipientValue(recipients, (recipient) => recipient.meetingDateTime),
  };
}

function sharedRecipientValue(
  recipients: OutreachRecipientInput[],
  read: (recipient: OutreachRecipientInput) => string | undefined,
): string {
  const values = uniqueText(recipients.map(read));
  return values.length === 1 ? (values[0] ?? '') : '';
}

function stripUnresolvedTemplateFields(value: string): string {
  return value
    .replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function uniqueText(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)),
    ),
  );
}

function readFieldFallback(metadata: unknown, field: string): string {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return '';
  const fallbacks = (metadata as Record<string, unknown>).fieldFallbacks;
  if (!fallbacks || typeof fallbacks !== 'object' || Array.isArray(fallbacks)) return '';
  const value = (fallbacks as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : '';
}

function formatCurrentDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}

function emailSendErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Email send failed';
  return message
    .replaceAll('Microsoft 365', 'email')
    .replaceAll('Microsoft Graph', 'email provider')
    .replaceAll('Outlook', 'email')
    .replaceAll('Microsoft', 'email provider');
}

function outreachRecipientLabel(recipient: OutreachRecipientInput): string {
  return (
    recipient.name || recipient.directoryContactName || recipient.office || 'Unnamed recipient'
  );
}

function normalizeEmailAddress(value?: string | null): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.includes('@') ? normalized : null;
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function defaultScopes(provider: EngagementProvider): string[] {
  if (provider === EngagementProvider.microsoft_365) {
    return [
      'offline_access',
      'User.Read',
      'Mail.Read',
      'Mail.ReadWrite',
      'Mail.Send',
      'Calendars.Read',
    ];
  }
  if (provider === EngagementProvider.google_workspace) {
    return [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar.readonly',
    ];
  }
  if (provider === EngagementProvider.imap_caldav) return ['imap.read', 'caldav.read'];
  return [];
}

function toDateWindow(query: { from?: string; to?: string }) {
  const from = query.from ? parseDate(query.from, 'from') : startOfToday();
  const to = query.to ? parseDate(query.to, 'to') : addDays(from, 1);
  if (to <= from) throw new BadRequestException('to must be after from');
  return { from, to };
}

function startOfToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function parseDate(value: string | undefined, field: string): Date {
  if (!value) throw new BadRequestException(`${field} is required`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new BadRequestException(`${field} must be a valid date`);
  return date;
}

async function ensureExists<T>(promise: Promise<T | null>, message: string): Promise<T> {
  const value = await promise;
  if (!value) throw new NotFoundException(message);
  return value;
}

/**
 * Collapse duplicate outreach recipients by the SAME identifier chain the batch
 * worker keys results on (id → directoryContactId → email(lowercased) → name),
 * keep-first. Entries with none of those keep their slot (the worker falls back
 * to the array index, which stays unique). Defense-in-depth against a
 * duplicated recipientKey fanning out a redundant, billable AI call (A13).
 * Exported for tests.
 */
export function dedupeOutreachRecipients(
  recipients: OutreachRecipientInput[],
): OutreachRecipientInput[] {
  const out: OutreachRecipientInput[] = [];
  const seen = new Set<string>();
  for (const r of recipients) {
    const rr = r as Record<string, unknown>;
    // Key with the SAME raw id chain the batch worker uses for result.recipientId
    // and the frontend uses for recipientKey (no trim/lowercase). Normalizing the
    // email here would collapse case-variants to one result while the caller keys
    // by the original case, silently dropping the variant recipient. Exact-dup
    // recipientKeys (the real A13 target) still collapse.
    const key =
      rr.id?.toString() ||
      rr.directoryContactId?.toString() ||
      rr.email?.toString() ||
      rr.name?.toString() ||
      '';
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(r);
  }
  return out;
}

/**
 * Scrub a sent-outreach body for use as a voice few-shot (W5.6). Strips HTML to
 * text and redacts emails/phone numbers so an excerpt can never carry a
 * recipient's contact details into another draft's prompt. Exported for the
 * regex-guard test.
 */
export function scrubPiiForVoice(raw: string): string {
  const text = raw
    .replace(/<[^>]+>/g, ' ') // strip HTML tags (bodies are HTML)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]') // email addresses
    .replace(/\+?\d[\d\s().-]{8,}\d/g, '[phone]') // phone-ish digit runs
    .replace(/\s+/g, ' ')
    .trim();
}

function pruneForAi(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  return JSON.parse(
    JSON.stringify(value, (_key, entry) => {
      if (entry instanceof Date) return entry.toISOString();
      return entry;
    }),
  ) as Record<string, unknown>;
}

function prepareThreadForAi(value: unknown): Record<string, unknown> {
  const thread = pruneForAi(value);
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  const messageHighlights = messages
    .slice(0, 3)
    .map((message) => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
      const row = message as Record<string, unknown>;
      const quote = compactThreadText(
        (typeof row.bodyText === 'string' && row.bodyText) ||
          (typeof row.subject === 'string' && row.subject) ||
          '',
      );
      return {
        fromName: typeof row.fromName === 'string' ? row.fromName : null,
        fromEmail: typeof row.fromEmail === 'string' ? row.fromEmail : null,
        sentAt: typeof row.sentAt === 'string' ? row.sentAt : null,
        subject: typeof row.subject === 'string' ? row.subject : null,
        quote,
      };
    })
    .filter(
      (
        entry,
      ): entry is {
        fromName: string | null;
        fromEmail: string | null;
        sentAt: string | null;
        subject: string | null;
        quote: string;
      } => Boolean(entry),
    );

  return {
    id: typeof thread.id === 'string' ? thread.id : null,
    subject: typeof thread.subject === 'string' ? thread.subject : null,
    snippet: compactThreadText(typeof thread.snippet === 'string' ? thread.snippet : ''),
    lastMessageAt: typeof thread.lastMessageAt === 'string' ? thread.lastMessageAt : null,
    status: typeof thread.status === 'string' ? thread.status : null,
    messageHighlights,
  };
}

function compactThreadText(value: string, max = 220): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 1)).trim()}...`;
}

function safeFileName(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return cleaned || 'attachment';
}

/**
 * Run `worker` over `items` with at most `concurrency` in flight at once,
 * returning results in the SAME ORDER as the input (results[i] corresponds to
 * items[i]), regardless of which finished first. The worker receives the item
 * and its original index. Used to parallelize per-recipient AI generation:
 * batch generation was a sequential await-loop, so wall-clock scaled linearly
 * with recipient count and large campaigns blew past the request timeout.
 *
 * Order preservation is essential here — callers key results by the recipient's
 * original index as a last-resort fallback, so out-of-order writes would
 * mis-assign drafts. The worker is expected to handle its own errors (this
 * helper does not catch); a throwing worker rejects the whole batch.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  let nextIndex = 0;

  async function runner(): Promise<void> {
    // Each runner pulls the next unclaimed index until the queue drains.
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await worker(items[current] as T, current);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runner()));
  return results;
}
