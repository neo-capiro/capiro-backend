/**
 * Hill Day workflow — domain types shared by the resolution, context,
 * generation, document and export services, and mirrored by the web client
 * (apps/web/src/vnext/pages/workspace/hillday/types.ts).
 *
 * Every read of a third-party layer carries a SourceStatusBlock. A source that
 * fails resolves to `unavailable` or `partial` with the source named — never to
 * a fabricated zero and never to an empty section (requirements §1).
 */

export type SourceStatus = 'ok' | 'partial' | 'unavailable';

export interface SourceStatusBlock {
  /** e.g. `calendar:microsoft_365`, `directory`, `correspondence`, `objectives`, `model`. */
  source: string;
  status: SourceStatus;
  detail: string | null;
}

// ── Calendar ────────────────────────────────────────────────────────────────

export type EventKind = 'hill' | 'internal';
export type EventReasonKind = 'tagged' | 'matched' | 'tagged_and_matched' | 'internal' | 'manual';

export interface CalendarAttendee {
  address: string;
  name: string | null;
  responseStatus: string | null;
}

export interface CalendarEvent {
  eventId: string;
  subject: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
  location: string | null;
  isVirtual: boolean;
  joinLink: string | null;
  kind: EventKind;
  clientId: string | null;
  organizer: CalendarAttendee | null;
  attendees: CalendarAttendee[];
  reason: { kind: EventReasonKind; detail: string; matchedAddresses: string[] };
  source: string;
  connectionId: string | null;
}

export interface CalendarResponse {
  clientId: string;
  from: string;
  to: string;
  timeZone: string;
  events: CalendarEvent[];
  /** The client's next tagged event on or after now — lets the picker jump to the right week. */
  upcomingEventAt: string | null;
  sources: SourceStatusBlock[];
}

// ── Resolution ──────────────────────────────────────────────────────────────

export type AttendeeState = 'resolved' | 'unresolved' | 'stale' | 'scheduler';

/** A congressional office as the Directory describes it. */
export interface OfficeRef {
  /** Directory contact id, e.g. `member-1234`. Null for a committee-only office. */
  memberId: string | null;
  /** Display label, e.g. `Sen. Roger Wicker (R-MS)`. */
  member: string | null;
  memberName: string | null;
  chamber: string | null;
  party: string | null;
  partyName: string | null;
  state: string | null;
  district: string | null;
  /** Committee labels including role, e.g. `Armed Services (Chair)`. */
  committees: string[];
  focusAreas: Array<{ label: string; salience: number }>;
  bio: string | null;
  officeLocation: string | null;
}

export type OfficeDerivation =
  | 'staffer_office_association'
  | 'member_on_invite'
  | 'invite_domain'
  | 'committee_staff_association'
  | 'user_correction'
  /** Picked directly from the Directory (step 3's Directory tab) — an
   *  initial selection, not a correction of a wrong inference. */
  | 'manual_selection';

export interface ResolvedOffice extends OfficeRef {
  room: string | null;
  derivedFrom: OfficeDerivation | null;
  /** Clerk user id when the office was set or accepted by a person. */
  correctedBy: string | null;
  /** Other candidate offices (a stale association offers both). */
  alternatives: OfficeRef[];
}

export type CorrectionKind =
  | 'assign_staffer'
  | 'manual_attendee'
  | 'accept_stale'
  | 'create_directory_record'
  | 'change_office'
  /** Edits the meeting's own facts (subject/time/location) — the general
   *  "every resolved field is editable" mechanism, valid on any meeting. */
  | 'edit_meeting_facts';

export interface AttendeeCorrection {
  kind: CorrectionKind;
  by: string;
  at: string;
  detail: string | null;
}

export interface ResolvedAttendee {
  attendeeId: string;
  address: string | null;
  state: AttendeeState;
  /** Directory staffer id (`staff-123`) when resolved to a record. */
  stafferId: string | null;
  name: string | null;
  role: string | null;
  issueAreas: string[];
  topics: string[];
  /** Office the Directory places this staffer in. */
  directoryOffice: OfficeRef | null;
  /** Office the invite implies (from the address domain), when derivable. */
  inviteOffice: OfficeRef | null;
  /** Committee for committee staff (no member office of their own). */
  committee: { id: string; name: string } | null;
  /** Human-readable explanation of the state, shown under the name. */
  detail: string;
  manual: boolean;
  correction: AttendeeCorrection | null;
  /** The tenant Directory record created for an unresolved address. */
  directoryRecord: { kind: 'engagement_contact'; id: string } | null;
}

export interface MeetingResolution {
  meetingId: string;
  eventId: string;
  state: 'clean' | 'partial';
  office: ResolvedOffice;
  attendees: ResolvedAttendee[];
  /** Firm- or client-side participants; excluded from the chain. */
  internalParticipants: CalendarAttendee[];
  /** True while the invite carries only a scheduling address. */
  needsConfirmation: boolean;
  resolvedAt: string;
  sources: SourceStatusBlock[];
}

export interface DocumentResolution {
  documentId: string;
  status: 'clean' | 'partial';
  meetings: MeetingResolution[];
  sources: SourceStatusBlock[];
  resolvedAt: string | null;
}

// ── Carry-over context ──────────────────────────────────────────────────────

export interface CarrySelection {
  committees: boolean;
  bio: boolean;
  /** Issue-area unit ids (slugs) to carry. */
  issueAreas: string[];
  /** Attendee ids whose staffer record (role + topics) is carried. */
  staffers: string[];
}

export interface MeetingContextRecord {
  note: string;
  carry: CarrySelection;
  threadIds: string[];
  lookbackDays: number | null;
  savedAt: string;
  savedBy: string;
}

export type CarryUnitKind = 'committees' | 'issue_area' | 'bio' | 'staffer';

export interface CarryUnit {
  id: string;
  kind: CarryUnitKind;
  label: string;
  /** Server-supplied default (requirements §5) — the rule lives here, not in the UI. */
  defaultSelected: boolean;
  /** Effective selection: the stored record when present, else the default. */
  selected: boolean;
  detail: string | null;
  topics: string[];
  /** For staffer units: whether a Directory record backs it. */
  known: boolean;
  attendeeState: AttendeeState | null;
}

export interface ThreadRef {
  id: string;
  subject: string;
  participants: string[];
  messageCount: number;
  lastMessageAt: string | null;
  ageDays: number | null;
  clientTagged: boolean;
}

export interface ThreadsResponse {
  lookbackDays: number;
  windowStart: string;
  threads: ThreadRef[];
  sources: SourceStatusBlock[];
}

export interface MeetingContextCandidates {
  meetingId: string;
  member: OfficeRef | null;
  units: CarryUnit[];
  threads: ThreadRef[];
  lookbackDays: number;
  record: MeetingContextRecord | null;
  sources: SourceStatusBlock[];
}

// ── Generation ──────────────────────────────────────────────────────────────

export type SectionStatus = 'pending' | 'done' | 'unavailable';

export type SectionFlagKind =
  | 'unsupported_claim'
  | 'needs_confirmation'
  | 'generation_failed'
  | 'partial_resolution'
  | 'user_edited';

export interface SectionFlag {
  kind: SectionFlagKind;
  detail: string;
}

export interface MeetingSection {
  sectionId: string;
  status: SectionStatus;
  focus: string | null;
  background: string | null;
  reason: string | null;
  flags: SectionFlag[];
  generatedAt: string | null;
  model: string | null;
  edited: { focus: boolean; background: boolean; at: string | null };
}

/** The exact source set assembled into one unit's prompt — logged, not reconstructed. */
export interface SourceSet {
  assembledAt: string;
  model: string | null;
  calendar: { eventId: string; subject: string };
  directory: {
    memberId: string | null;
    committees: boolean;
    issueAreas: string[];
    bio: boolean;
    staffers: string[];
  };
  excluded: {
    issueAreas: string[];
    staffers: string[];
    committees: boolean;
    bio: boolean;
  };
  objectives: { count: number; ids: string[]; status: SourceStatus };
  note: { included: boolean; chars: number };
  correspondence: { threadIds: string[]; messages: number; status: SourceStatus };
  priorEngagement: { count: number };
  promptChars: number;
}

export type UnitState = 'queued' | 'running' | 'done' | 'failed';

export interface JobUnit {
  meetingId: string;
  state: UnitState;
  sectionId: string | null;
  reason: string | null;
  at: string;
}

export interface JobEvent {
  seq: number;
  event: 'unit' | 'complete' | 'failed';
  data: Record<string, unknown>;
}

export interface JobStatus {
  jobId: string;
  documentId: string;
  status: 'queued' | 'running' | 'complete' | 'failed';
  units: JobUnit[];
  quality: number | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

// ── Document model ──────────────────────────────────────────────────────────

export interface SummaryRow {
  sectionId: string;
  meetingId: string;
  time: string;
  member: string;
  office: string;
  room: string;
  minutes: string;
  staffLead: string;
}

export interface DocumentSectionView {
  sectionId: string;
  meetingId: string;
  eventId: string;
  number: number;
  time: string;
  duration: string;
  member: string;
  subline: string;
  facts: Array<{ k: string; v: string }>;
  focus: string | null;
  background: string | null;
  status: SectionStatus;
  reason: string | null;
  flags: SectionFlag[];
  edited: { focus: boolean; background: boolean; at: string | null };
  attendees: Array<{ name: string; role: string | null; state: AttendeeState }>;
}

export interface ProvenanceView {
  generatedAt: string | null;
  model: string | null;
  sourceCounts: Array<{ id: string; label: string; count: number; detail: string | null }>;
  corrections: string[];
  failedUnits: number;
  quality: number | null;
  totalSources: number;
}

export interface HillDayDocumentView {
  id: string;
  name: string;
  status: 'draft' | 'generating' | 'generated' | 'partial' | 'delivered';
  blueprint: { slug: string; name: string };
  client: { id: string; name: string; mono: string; hasLogo: boolean };
  firm: { name: string };
  owner: { id: string; name: string; initials: string };
  lookbackDays: number;
  timeZone: string;
  weekStart: string | null;
  resolutionStatus: 'clean' | 'partial' | null;
  cover: {
    title: string;
    dateline: string;
    facts: Array<{ k: string; v: string }>;
  };
  summary: SummaryRow[];
  sections: DocumentSectionView[];
  provenance: ProvenanceView;
  generation: { lastJobId: string | null; status: string | null };
  meetingCount: number;
  updatedAt: string;
  createdAt: string;
}

export interface QualityCheck {
  id: string;
  label: string;
  state: 'pass' | 'warn';
  detail: string;
}

export interface QualityResponse {
  documentId: string;
  score: number;
  checks: QualityCheck[];
  computedAt: string;
}

export interface LibraryRow {
  id: string;
  kind: 'hillday' | 'draft';
  name: string;
  blueprint: string;
  client: string | null;
  status: string;
  updatedAt: string;
  owner: { id: string; name: string; initials: string };
  route: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ClientOption {
  id: string;
  name: string;
  mono: string;
  description: string | null;
  objectiveCount: number | null;
  officeCount: number;
  hasLogo: boolean;
}

export interface ClientsResponse extends Page<ClientOption> {
  sources: SourceStatusBlock[];
}
