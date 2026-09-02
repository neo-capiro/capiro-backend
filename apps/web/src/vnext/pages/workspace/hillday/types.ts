/**
 * Hill Day module — domain types.
 *
 * These MIRROR the server contract in apps/workspace/src/hillday/hillday.types.ts
 * (the `/workspace-api/hillday/*` endpoint family, requirements §6). Keep the two
 * files in step; the UI owns only the presentation helpers at the bottom.
 */
import type { HillDayIcon } from './ui.js';

/** The pill/status badge tones (Untitled UI badge colour families). */
export type PillTone = 'gray' | 'navy' | 'warn' | 'ok' | 'dark';

export type SourceStatus = 'ok' | 'partial' | 'unavailable';

export interface SourceStatusBlock {
  source: string;
  status: SourceStatus;
  detail: string | null;
}

// ── Blueprints + library ────────────────────────────────────────────────────

export interface Blueprint {
  id: string;
  slug: string;
  name: string;
  description: string;
  meta: string;
  icon: string;
  sources: string[];
  stepCount: number;
  scope: 'global' | 'firm';
  implemented: boolean;
  isNew: boolean;
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

// ── Calendar ────────────────────────────────────────────────────────────────

export type EventKind = 'hill' | 'internal';

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
  reason: { kind: 'tagged' | 'matched' | 'tagged_and_matched' | 'internal' | 'manual'; detail: string; matchedAddresses: string[] };
  source: string;
  connectionId: string | null;
}

export interface CalendarResponse {
  clientId: string;
  from: string;
  to: string;
  timeZone: string;
  events: CalendarEvent[];
  upcomingEventAt: string | null;
  sources: SourceStatusBlock[];
}

// ── Directory browse (step 3's Directory tab — a meeting not yet on the
// calendar) ──────────────────────────────────────────────────────────────

export interface DirectoryBrowseContact {
  id: string;
  fullName: string;
  honorific: string;
  title: string;
  office: string;
  chamber: string;
  state: string;
  district: string;
  party: string;
  partyName: string;
  committees: string[];
  leadershipPositions: string[];
  staff: Array<{
    id: string;
    fullName: string;
    title: string;
    roles: string[];
    issueAreas: string[];
    email: string;
    officeLocation: string;
    isCurrent: boolean;
  }>;
}

export interface DirectoryBrowsePayload {
  contacts: DirectoryBrowseContact[];
  total: number;
  page: number;
  pageSize: number;
  availableStates: string[];
  availableChambers: string[];
  sources: SourceStatusBlock[];
}

export interface DirectoryBrowseQuery {
  q?: string;
  state?: string;
  chamber?: string;
  page?: number;
  pageSize?: number;
}

// ── Resolution ──────────────────────────────────────────────────────────────

export type AttendeeState = 'resolved' | 'unresolved' | 'stale' | 'scheduler';

export interface OfficeRef {
  memberId: string | null;
  member: string | null;
  memberName: string | null;
  chamber: string | null;
  party: string | null;
  partyName: string | null;
  state: string | null;
  district: string | null;
  committees: string[];
  focusAreas: Array<{ label: string; salience: number }>;
  bio: string | null;
  officeLocation: string | null;
}

export interface ResolvedOffice extends OfficeRef {
  room: string | null;
  derivedFrom:
    | 'staffer_office_association'
    | 'member_on_invite'
    | 'invite_domain'
    | 'committee_staff_association'
    | 'user_correction'
    /** Picked directly from the Directory (step 3's Directory tab). */
    | 'manual_selection'
    | null;
  correctedBy: string | null;
  alternatives: OfficeRef[];
}

export interface ResolvedAttendee {
  attendeeId: string;
  address: string | null;
  state: AttendeeState;
  stafferId: string | null;
  name: string | null;
  role: string | null;
  issueAreas: string[];
  topics: string[];
  directoryOffice: OfficeRef | null;
  inviteOffice: OfficeRef | null;
  committee: { id: string; name: string } | null;
  detail: string;
  manual: boolean;
  correction: { kind: string; by: string; at: string; detail: string | null } | null;
  directoryRecord: { kind: 'engagement_contact'; id: string } | null;
}

export interface MeetingResolution {
  meetingId: string;
  eventId: string;
  state: 'clean' | 'partial';
  office: ResolvedOffice;
  attendees: ResolvedAttendee[];
  internalParticipants: CalendarAttendee[];
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

export type CorrectionKind =
  | 'assign_staffer'
  | 'manual_attendee'
  | 'accept_stale'
  | 'create_directory_record'
  | 'change_office'
  /** Edits the meeting's own facts (subject/time/location) — valid on any meeting. */
  | 'edit_meeting_facts';

export interface CorrectionBody {
  kind: CorrectionKind;
  attendeeId?: string;
  stafferId?: string;
  name?: string;
  role?: string;
  address?: string;
  memberId?: string;
  useOffice?: 'directory' | 'invite';
  // edit_meeting_facts
  subject?: string;
  startsAt?: string;
  endsAt?: string;
  location?: string;
}

/** A correction response now echoes the meeting's event snapshot too, so the
 *  caller can refresh its local time/subject/location display cache. */
export interface CorrectionResult {
  resolution: MeetingResolution;
  event: CalendarEvent;
}

export interface StafferHit {
  id: string;
  name: string;
  title: string;
  email: string;
  issueAreas: string[];
  member: OfficeRef | null;
}

// ── Context ─────────────────────────────────────────────────────────────────

export interface CarrySelection {
  committees: boolean;
  bio: boolean;
  issueAreas: string[];
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

export interface CarryUnit {
  id: string;
  kind: 'committees' | 'issue_area' | 'bio' | 'staffer';
  label: string;
  defaultSelected: boolean;
  selected: boolean;
  detail: string | null;
  topics: string[];
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

export interface MeetingContextCandidates {
  meetingId: string;
  member: OfficeRef | null;
  units: CarryUnit[];
  threads: ThreadRef[];
  lookbackDays: number;
  record: MeetingContextRecord | null;
  sources: SourceStatusBlock[];
}

export interface PutContextBody {
  note: string;
  carry: CarrySelection;
  threadIds: string[];
  lookbackDays?: number;
}

// ── Generation ──────────────────────────────────────────────────────────────

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

// ── Document ────────────────────────────────────────────────────────────────

export type SectionStatus = 'pending' | 'done' | 'unavailable';

export interface SectionFlag {
  kind: 'unsupported_claim' | 'needs_confirmation' | 'generation_failed' | 'partial_resolution' | 'user_edited';
  detail: string;
}

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
  cover: { title: string; dateline: string; facts: Array<{ k: string; v: string }> };
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

export interface ExportView {
  exportId: string;
  documentId: string;
  status: 'queued' | 'ready' | 'failed';
  format: 'pdf';
  pageSize: 'letter' | 'a4';
  filename: string | null;
  sizeBytes: number | null;
  url: string | null;
  expiresAt: string | null;
  error: string | null;
  createdAt: string;
}

export interface SetMeetingsResponse {
  documentId: string;
  meetings: Array<{ meetingId: string; eventId: string; ordinal: number; event: CalendarEvent; resolved: boolean }>;
  skipped: string[];
  sources: SourceStatusBlock[];
}

export interface CreatedDocument {
  id: string;
  name: string;
  status: string;
  blueprint: { slug: string; name: string };
  client: { id: string; name: string };
  lookbackDays: number;
  timeZone: string;
  createdAt: string;
}

// ── Presentation helpers (UI-owned) ─────────────────────────────────────────

/** Library status → pill tone + label. */
export function statusPill(row: Pick<LibraryRow, 'kind' | 'status'>): { tone: PillTone; label: string } {
  switch (row.status) {
    case 'generating':
      return { tone: 'navy', label: 'Generating' };
    case 'generated':
      return { tone: 'ok', label: 'Generated' };
    case 'partial':
      return { tone: 'warn', label: 'Partial' };
    case 'delivered':
      return { tone: 'dark', label: 'Delivered' };
    case 'complete':
      return { tone: 'ok', label: 'Complete' };
    default:
      return { tone: 'gray', label: 'Draft' };
  }
}

/** Blueprint icon names as the kit registry knows them. */
export function blueprintIcon(icon: string): HillDayIcon {
  return icon as HillDayIcon;
}

/** "4m ago" / "2h ago" / "Aug 10". */
export function relativeTime(iso: string, now = new Date()): string {
  const then = new Date(iso);
  const diff = Math.max(0, now.getTime() - then.getTime());
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return then.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
