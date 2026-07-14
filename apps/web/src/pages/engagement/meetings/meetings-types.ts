// Types for the redesigned Meetings module (Meetings & Meri v2). These mirror
// the decorated meeting payload the API now returns (GET /api/engagement/meetings
// and the share/library/shared-meetings endpoints) — see the Wave-1 backend.

export type MeetingProvider = 'zoom' | 'meet' | 'teams' | 'webex' | 'goto' | 'slack';
// scheduled → attending (in the call) → attended (call ended, Meri summarizing to
// Meeting Notes) → done (summary written).
export type MeriState = 'scheduled' | 'attending' | 'attended' | 'done';
export type MeetingVisibility = 'private' | 'shared';
export type PrepStatus = 'generated' | 'edited' | 'approved' | 'stale' | 'failed';
export type DebriefStatus = 'generated' | 'edited' | 'approved';
export type ArtifactKind = 'prep' | 'notes' | 'debrief';

export interface ArtifactAuthor {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
}

export interface MeetingAttendee {
  id: string;
  email: string | null;
  name: string | null;
  role: string | null;
}

export interface MeetingPrep {
  id: string;
  status: PrepStatus;
  agenda: string[];
  talkingPoints: string[];
  risks: string[];
  followUps: string[];
  emailEvidence: string[];
  summary: string | null;
  provider: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MeetingNoteSummary {
  id: string;
  confidential: boolean;
  accessLevel?: string;
  authorUserId?: string | null;
  author?: ArtifactAuthor | null;
  createdAt: string;
}

export interface MeetingDebriefSummary {
  id: string;
  confidential: boolean;
  accessLevel?: string;
  status?: DebriefStatus;
  authorUserId?: string | null;
  author?: ArtifactAuthor | null;
  createdAt: string;
}

/** Full debrief with decrypted body — GET /meetings/:id/debriefs. */
export interface MeetingDebrief extends MeetingDebriefSummary {
  body: string | null;
  restricted: boolean;
  updatedAt: string;
}

/** Full note with decrypted body — GET /meetings/:id/notes (Meri's summary lands
 *  here in the notes-first flow). */
export interface MeetingNote extends MeetingNoteSummary {
  body: string | null;
  restricted: boolean;
  updatedAt: string;
}

export interface MeetingAttachment {
  id: string;
  meetingId: string | null;
  fileName: string;
  contentType: string;
  byteSize: number | null;
  source: string;
  createdAt: string;
  downloadUrl?: string | null;
}

export interface MeetingContributor {
  userId: string;
  name: string | null;
  artifacts: ArtifactKind[];
}

export interface MeetingClientRef {
  id: string;
  name: string;
  website?: string | null;
  primaryContactName?: string | null;
  primaryContactEmail?: string | null;
}

/** The decorated meeting object returned by the API. */
export interface Meeting {
  id: string;
  subject: string;
  source: string;
  description: string | null;
  location: string | null;
  startsAt: string;
  endsAt: string;
  organizerEmail: string | null;
  organizerName: string | null;
  status: string;
  metadata: Record<string, unknown> | null;
  isInternal?: boolean;
  // Virtual-meeting classification (stored) + private-until-shared visibility.
  isVirtual: boolean;
  joinLink: string | null;
  provider: MeetingProvider | string | null;
  visibility: MeetingVisibility;
  sharedAt: string | null;
  sharedByUserId: string | null;
  client: MeetingClientRef | null;
  attendees: MeetingAttendee[];
  attachments: MeetingAttachment[];
  preps: MeetingPrep[];
  notes: MeetingNoteSummary[];
  debriefs: MeetingDebriefSummary[];
  // Computed response fields (API decorate layer).
  notesApproved: boolean;
  meri: MeriState | null;
  contributors: MeetingContributor[];
  sharedBy: { userId: string; name: string | null } | null;
  // Phase 2 cross-user grouping only: per-sender names of the notetakers that
  // attended (§4.4). Present on grouped shared records; absent otherwise.
  notetakers?: string[];
}

export type MeetingBotStatus =
  | 'requested'
  | 'joining'
  | 'in_call'
  | 'recording'
  | 'processing'
  | 'drafting'
  | 'done'
  | 'failed'
  | 'no_show'
  | 'denied_consent'
  | 'removed';

export interface MeetingBotSession {
  id: string;
  meetingId: string;
  clientId: string | null;
  provider: string;
  platform: string | null;
  status: MeetingBotStatus;
  recordingPolicy: string;
  externalBotId: string | null;
  debriefId: string | null;
  error: string | null;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MeetingDebriefDraft {
  recap: string;
  actionItems: string[];
  notes: string;
  provider: 'openai' | 'anthropic';
  model: string;
}

/** GET /meetings/library — the paginated Library envelope. */
export interface MeetingLibraryResponse {
  data: Meeting[];
  total: number;
  page: number;
  limit: number;
}

/** The current calendar view mode; chips switch the calendar body, not a filter. */
export type MeetingViewMode = 'day' | 'month' | 'list';

/** Whether a meeting is eligible for the Meri notetaker (spec §4.1). */
export function eligibleForMeri(m: Pick<Meeting, 'isVirtual' | 'joinLink'>): boolean {
  return m.isVirtual && Boolean(m.joinLink);
}

/** Approved prep for a meeting, if any (the current prep is the latest one). */
export function approvedPrep(m: Meeting): MeetingPrep | null {
  const prep = m.preps[0];
  return prep && prep.status === 'approved' ? prep : null;
}

/** Approved debrief for a meeting, if any. */
export function approvedDebrief(m: Meeting): MeetingDebriefSummary | null {
  return m.debriefs.find((d) => d.status === 'approved') ?? null;
}

/**
 * The current prep once it counts as COMPLETED — i.e. it has been generated,
 * even if not yet approved (a `failed` generation does not count). Drives the
 * green P/N/D status: green = the artifact exists, not merely = approved.
 */
export function completedPrep(m: Meeting): MeetingPrep | null {
  const prep = m.preps[0];
  return prep && prep.status !== 'failed' ? prep : null;
}

/** A debrief once it counts as COMPLETED — any generated/edited/approved debrief. */
export function completedDebrief(m: Meeting): MeetingDebriefSummary | null {
  return m.debriefs[0] ?? null;
}
