// Types for the redesigned Meetings module (Meetings & Meri v2). These mirror
// the decorated meeting payload the API now returns (GET /api/engagement/meetings
// and the share/library/shared-meetings endpoints) — see the Wave-1 backend.

export type MeetingProvider = 'zoom' | 'meet' | 'teams' | 'webex' | 'goto' | 'slack';
// scheduled → attending (in the call) → attended (call ended, Meri summarizing to
// Meeting Notes) → done (summary written). `failed` = Meri did not capture the
// meeting for a reason the user didn't ask for (consent declined, provider
// error, no-show) — see `meriError` on Meeting for the surfaced explanation.
export type MeriState = 'scheduled' | 'attending' | 'attended' | 'done' | 'failed';
export type MeetingVisibility = 'private' | 'shared';
export type PrepStatus = 'generated' | 'edited' | 'approved' | 'stale' | 'failed';
export type DebriefStatus = 'generated' | 'edited' | 'approved';
// Phase 2 §d: notes gain their first lifecycle status, mirroring Prep/Debrief
// in spirit. 'draft' (captured, never approved) | 'edited' (was approved, then
// edited — needs re-approval) | 'approved' (explicit approve call).
export type MeetingNoteStatus = 'draft' | 'edited' | 'approved';
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
  clientId?: string | null;
  generatedFrom?: {
    briefing?: {
      version: 2;
      takeaways: Array<{ text: string; factIds: string[] }>;
      sections: Record<string, { status: string; items: Array<{ text: string; factIds: string[] }>; gap: string }>;
      facts: Array<{ id: string; sourceId: string; quote: string }>;
      coverage: { extractedBatches: number; totalBatches: number; factCount: number; reviewedFactCount: number; selectedFactCount: number; partial: boolean };
      limitations: string[];
    };
    clientId?: string | null;
    grounding?: {
      version: 1;
      contentEdited: boolean;
      attendees: Array<{ id: string; name: string; email: string | null }>;
      sources: Array<{ id: string; kind: string; title: string; recordId: string | null; observedAt: string | null; excerpt: string }>;
      references: Array<{ section: string; itemIndex: number; sourceIds: string[] }>;
      limitations: string[];
    };
  } | null;
  status: PrepStatus;
  agenda: string[];
  talkingPoints: string[];
  risks: string[];
  followUps: string[];
  emailEvidence: string[];
  summary: string | null;
  provider: string | null;
  model: string | null;
  // Phase 2 §d: sharing only — approval is still tracked via `status` above.
  sharedAt: string | null;
  sharedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MeetingNoteSummary {
  id: string;
  confidential: boolean;
  accessLevel?: string;
  // Phase 2 §d: existence is never approval — see MeetingNoteStatus.
  status?: MeetingNoteStatus;
  approvedAt?: string | null;
  approvedByUserId?: string | null;
  sharedAt?: string | null;
  sharedByUserId?: string | null;
  authorUserId?: string | null;
  author?: ArtifactAuthor | null;
  createdAt: string;
}

export interface MeetingDebriefSummary {
  id: string;
  confidential: boolean;
  accessLevel?: string;
  status?: DebriefStatus;
  // Phase 2 §d: sharing only — approval is still tracked via `status` above.
  sharedAt?: string | null;
  sharedByUserId?: string | null;
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
  // Phase 2 §d: attachments' first approval concept (single-user — any user
  // with meeting access, including the uploader, may approve).
  approvedAt?: string | null;
  approvedByUserId?: string | null;
  sharedAt?: string | null;
  sharedByUserId?: string | null;
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
  // Set only when meri === 'failed' — why Meri produced no notes.
  meriError?: string | null;
  contributors: MeetingContributor[];
  sharedBy: { userId: string; name: string | null } | null;
  // Phase 2 cross-user grouping only: per-sender names of the notetakers that
  // attended (§4.4). Present on grouped shared records; absent otherwise.
  notetakers?: string[];
  /**
   * EM-08 — ONLY present on rows returned by GET /meetings/library. Names the
   * real, current reason each row qualifies for the Library: which artifact
   * kind(s) have (or once had) an approved version. `current: true` means the
   * artifact the Prep/Notes/Debrief tabs show RIGHT NOW is approved (Materials
   * should show it); `current: false` means an approved version existed in the
   * past but has since been superseded (e.g. prep was approved, then
   * regenerated) — the row is still legitimately in the Library (approval is a
   * historical fact, never erased), but nothing currently approved is visible
   * on the meeting, which is exactly the "Materials — but still listed" case
   * this field exists to explain.
   */
  libraryQualifiedBy?: Array<{ kind: ArtifactKind; current: boolean }>;
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

/** The active tab in the meeting detail panel (Phase 2 §2a: now controlled by
 *  the parent EngagementPage so it round-trips through the URL). */
export type DetailTab = 'prep' | 'notes' | 'debrief';

/** Calendar providers use both spellings for a cancelled event. */
export function isCancelledMeeting(m: { status?: string }): boolean {
  return ['cancelled', 'canceled'].includes(m.status?.trim().toLowerCase() ?? '');
}

/** Whether a meeting is eligible for the Meri notetaker (spec §4.1). */
export function eligibleForMeri(m: Pick<Meeting, 'isVirtual' | 'joinLink'> & { status?: string }): boolean {
  return !isCancelledMeeting(m) && m.isVirtual && Boolean(m.joinLink);
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

/**
 * Notes count as COMPLETED once at least one exists — same "exists, not
 * approved" completion semantics as completedPrep/completedDebrief above.
 * Approval (MeetingNoteStatus) is a separate, later gate (Library eligibility
 * / sharing), deliberately NOT folded into this helper — see §j.
 */
export function completedNotes(m: Meeting): boolean {
  return m.notes.length > 0;
}

const ARTIFACT_KIND_LABEL: Record<ArtifactKind, string> = {
  prep: 'Prep',
  notes: 'Notes',
  debrief: 'Debrief',
};

/**
 * EM-08 — the Library's own honest description of why a row is there, built
 * from the real `libraryQualifiedBy` the server now attaches (see
 * listMeetingLibrary). Kinds currently approved and visible on the meeting
 * come first; a kind that qualified only historically (approved once, since
 * superseded — prep-only, see the server-side comment) is named explicitly
 * rather than silently folded in, so "Materials —" never again means
 * "nothing explains this row" — the caller decides the Materials-column
 * short form and the row's own longer disclosure text from the same data.
 *
 * Falls back to deriving "current" straight from the already-decorated
 * fields (approvedPrep/notesApproved/approvedDebrief) when `libraryQualifiedBy`
 * is absent — older callers/fixtures that don't send it still get a correct
 * (if necessarily historical-blind) answer instead of a hard crash.
 */
export function libraryQualification(m: Meeting): {
  current: ArtifactKind[];
  historicalOnly: ArtifactKind[];
} {
  if (!m.libraryQualifiedBy) {
    const current: ArtifactKind[] = [];
    if (approvedPrep(m)) current.push('prep');
    if (m.notesApproved) current.push('notes');
    if (approvedDebrief(m)) current.push('debrief');
    return { current, historicalOnly: [] };
  }
  const entries = m.libraryQualifiedBy;
  return {
    current: entries.filter((e) => e.current).map((e) => e.kind),
    historicalOnly: entries.filter((e) => !e.current).map((e) => e.kind),
  };
}

/** Plain-language label for a Library row's Materials column: current
 *  approved kinds first; if NONE are current but something qualified
 *  historically, say so explicitly rather than showing a bare "—" that looks
 *  like nothing explains the row's presence. */
export function libraryMaterialsLabel(m: Meeting): string {
  const { current, historicalOnly } = libraryQualification(m);
  if (current.length > 0) return current.map((k) => ARTIFACT_KIND_LABEL[k]).join(' · ');
  if (historicalOnly.length > 0) {
    return `${historicalOnly.map((k) => ARTIFACT_KIND_LABEL[k]).join(' · ')} (approved previously)`;
  }
  return '—';
}

/** Longer, hoverable disclosure for the same row — the concrete answer to
 *  "why is this in the Library and what does Materials mean here", for a
 *  title attribute or similar affordance. Explicitly distinguishes a
 *  currently-visible approval from one that's since been superseded, so a
 *  "Materials —" row is never a dead end. */
export function libraryQualificationTitle(m: Meeting): string {
  const { current, historicalOnly } = libraryQualification(m);
  if (current.length === 0 && historicalOnly.length === 0) {
    return 'No approved prep, notes, or debrief currently found for this meeting.';
  }
  const parts: string[] = [];
  if (current.length > 0) {
    parts.push(`Currently approved: ${current.map((k) => ARTIFACT_KIND_LABEL[k]).join(', ')}.`);
  }
  if (historicalOnly.length > 0) {
    parts.push(
      `Previously approved, since superseded by an unapproved regenerate: ${historicalOnly
        .map((k) => ARTIFACT_KIND_LABEL[k])
        .join(', ')}. Open the meeting to review and re-approve.`,
    );
  }
  return parts.join(' ');
}
