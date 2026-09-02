import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  DirectoryBridgeClient,
  type BridgeCommitteeStaffMatch,
  type BridgeMemberContext,
  type BridgeStaffMatch,
  type DirectoryBrowseQuery,
} from './directory-bridge.client.js';
import type { ResolutionCorrectionDto } from './dto/hillday.dto.js';
import { HillDaySourceService } from './hillday-source.service.js';
import type {
  CalendarAttendee,
  CalendarEvent,
  DocumentResolution,
  MeetingResolution,
  OfficeRef,
  ResolvedAttendee,
  ResolvedOffice,
  SourceStatusBlock,
} from './hillday.types.js';
import {
  CONFIRMED_DETAIL,
  attendeeIdFor,
  deriveOffice,
  isSchedulerAddress,
  lastNameMatches,
  normalizeAddress,
  officeRefFromContext,
  rollUpMeeting,
  senateSubdomain,
  stateDetail,
} from './resolution.rules.js';

interface MeetingRow {
  id: string;
  eventId: string;
  ordinal: number;
  event: unknown;
  resolution: unknown;
}

/** ~1pm US Eastern — an arbitrary but reasonable placeholder for a meeting
 *  added from the Directory with no invite to read a real time from. The
 *  whole point of the placeholder is that the user replaces it via
 *  `edit_meeting_facts`, so precision doesn't matter, only validity. */
const PLACEHOLDER_START_HOUR_UTC = 17;
const PLACEHOLDER_DURATION_MS = 30 * 60_000;

/**
 * Resolution over the selected meetings (requirements §4): runs the chain,
 * persists the per-meeting resolution record against the DOCUMENT (never the
 * Directory), applies user corrections as authoritative, and rolls up to
 * clean | partial. Partial never blocks generation.
 */
@Injectable()
export class HillDayResolutionService {
  private readonly logger = new Logger(HillDayResolutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly source: HillDaySourceService,
    private readonly bridge: DirectoryBridgeClient,
  ) {}

  async getResolution(tenantId: string, documentId: string): Promise<DocumentResolution> {
    const doc = await this.assertDocument(tenantId, documentId);
    const meetings = await this.prisma.wsHillDayMeeting.findMany({
      where: { tenantId, documentId },
      orderBy: { ordinal: 'asc' },
    });
    const resolved = meetings
      .map((m) => m.resolution as MeetingResolution | null)
      .filter((r): r is MeetingResolution => Boolean(r));
    return {
      documentId,
      status: (doc.resolutionStatus as 'clean' | 'partial' | null) ?? (resolved.length ? 'partial' : 'partial'),
      meetings: resolved,
      sources: mergeSources(resolved.flatMap((r) => r.sources)),
      resolvedAt: resolved.reduce<string | null>(
        (acc, r) => (acc && acc > r.resolvedAt ? acc : r.resolvedAt),
        null,
      ),
    };
  }

  /**
   * Run (or re-run) resolution over every selected meeting. Existing user
   * corrections survive a re-run: they are re-applied by attendee id, and a
   * user-corrected office is kept verbatim.
   */
  async resolveDocument(
    tenantId: string,
    actorId: string,
    documentId: string,
  ): Promise<DocumentResolution> {
    const doc = await this.assertDocument(tenantId, documentId);
    const meetings = (await this.prisma.wsHillDayMeeting.findMany({
      where: { tenantId, documentId },
      orderBy: { ordinal: 'asc' },
    })) as MeetingRow[];
    if (!meetings.length) {
      throw new BadRequestException('Select at least one meeting before running resolution');
    }

    const internal = await this.internalAddresses(tenantId, doc.clientId);
    const events = meetings.map((m) => m.event as CalendarEvent);
    const allAddresses = new Set<string>();
    for (const ev of events) {
      for (const a of ev.attendees ?? []) {
        const addr = normalizeAddress(a.address);
        if (addr && !internal.has(addr)) allAddresses.add(addr);
      }
      const org = normalizeAddress(ev.organizer?.address);
      if (org && !internal.has(org)) allAddresses.add(org);
    }

    const sources: SourceStatusBlock[] = [];
    const match = await this.bridge.matchEmails([...allAddresses]);
    const staffByEmail = new Map<string, BridgeStaffMatch>();
    const committeeByEmail = new Map<string, BridgeCommitteeStaffMatch>();
    if (match.ok) {
      for (const m of match.data.matches) {
        const key = m.attendeeEmail.toLowerCase();
        // Prefer a staff match over a member match for the same address, and
        // the first staff match when the snapshot lists a staffer twice.
        const existing = staffByEmail.get(key);
        if (!existing || (existing.matchKind === 'member' && m.matchKind === 'staff')) {
          staffByEmail.set(key, m);
        }
      }
      for (const c of match.data.committeeStaff) {
        committeeByEmail.set(c.attendeeEmail.toLowerCase(), c);
      }
      sources.push({
        source: 'directory',
        status: 'ok',
        detail: `${staffByEmail.size + committeeByEmail.size} of ${allAddresses.size} addresses matched`,
      });
    } else {
      sources.push({ source: 'directory', status: 'unavailable', detail: match.detail });
    }

    // Personal-office domains (x.senate.gov) resolve to a senator by last name.
    const domainOffices = await this.resolveDomainOffices([...allAddresses], match.ok);

    const now = new Date().toISOString();
    const results: MeetingResolution[] = [];
    for (const row of meetings) {
      const event = row.event as CalendarEvent;
      const previous = row.resolution as MeetingResolution | null;
      const resolution = this.buildMeetingResolution({
        meetingId: row.id,
        event,
        previous,
        internal,
        staffByEmail,
        committeeByEmail,
        domainOffices,
        directoryOk: match.ok,
        directoryDetail: match.ok ? null : match.detail,
        now,
      });
      await this.prisma.wsHillDayMeeting.update({
        where: { id: row.id },
        data: { resolution: resolution as never },
      });
      results.push(resolution);
    }

    const status = results.every((r) => r.state === 'clean') ? 'clean' : 'partial';
    await this.prisma.wsHillDayDocument.update({
      where: { id: documentId },
      data: { resolutionStatus: status },
    });
    void actorId;
    return {
      documentId,
      status,
      meetings: results,
      sources: mergeSources([...sources, ...results.flatMap((r) => r.sources)]),
      resolvedAt: now,
    };
  }

  /**
   * Add a meeting by picking the member directly from the Directory (step 3's
   * Directory tab) rather than from the calendar — for a Hill Day meeting
   * booked after the packet was started, or on a calendar the sync doesn't
   * reach. There is no invite, so the office is the pick itself (not derived
   * from an attendee chain) and the date/time is a placeholder the user is
   * expected to set via `correct(..., 'edit_meeting_facts')`.
   *
   * Idempotent by member: a retried batch (the wizard commits every pending
   * pick in parallel; a partial failure resends the whole batch) must not
   * create duplicates.
   */
  async addManualMeeting(
    tenantId: string,
    actorId: string,
    documentId: string,
    memberId: string,
  ): Promise<{ resolution: MeetingResolution; event: CalendarEvent }> {
    const doc = await this.assertDocument(tenantId, documentId);
    if (doc.ownerId !== actorId) {
      throw new ForbiddenException('Only the document owner can add a meeting');
    }

    const existing = (await this.prisma.wsHillDayMeeting.findMany({
      where: { tenantId, documentId },
    })) as MeetingRow[];
    const already = existing.find((m) => {
      const ev = m.event as unknown as CalendarEvent;
      const res = m.resolution as unknown as MeetingResolution | null;
      return ev.source === 'manual' && res?.office.memberId === memberId;
    });
    if (already) {
      return {
        resolution: already.resolution as unknown as MeetingResolution,
        event: already.event as unknown as CalendarEvent,
      };
    }

    const res = await this.bridge.memberContext(memberId);
    if (!res.ok) throw new ServiceUnavailableException(`Directory unavailable: ${res.detail}`);
    if (!res.data.context) throw new NotFoundException('Directory member not found');
    const officeRef = officeRefFromContext(res.data.context);

    const startsAt = this.placeholderStart(doc.weekStart);
    const endsAt = new Date(startsAt.getTime() + PLACEHOLDER_DURATION_MS);
    const event: CalendarEvent = {
      eventId: `manual-${randomUUID()}`,
      subject: `Meeting with ${officeRef.member ?? officeRef.memberName ?? 'the office'}`,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      timeZone: doc.timeZone,
      location: officeRef.officeLocation,
      isVirtual: false,
      joinLink: null,
      kind: 'hill',
      clientId: doc.clientId,
      organizer: null,
      attendees: [],
      reason: { kind: 'manual', detail: 'Added manually from the Directory.', matchedAddresses: [] },
      source: 'manual',
      connectionId: null,
    };

    const office: ResolvedOffice = {
      ...officeRef,
      room: officeRef.officeLocation,
      derivedFrom: 'manual_selection',
      correctedBy: actorId,
      alternatives: [],
    };
    const roll = rollUpMeeting([], office);
    const id = randomUUID();
    const resolution: MeetingResolution = {
      meetingId: id,
      eventId: event.eventId,
      state: roll.state,
      office,
      attendees: [],
      internalParticipants: [],
      needsConfirmation: roll.needsConfirmation,
      resolvedAt: new Date().toISOString(),
      sources: [{ source: 'directory', status: 'ok', detail: null }],
    };

    // Ordinal starts well past any calendar-derived range so a later
    // setMeetings() ordinal reassignment (which only touches calendar rows)
    // can never collide with a manual row.
    const manualCount = existing.filter((m) => (m.event as unknown as CalendarEvent).source === 'manual').length;
    await this.prisma.wsHillDayMeeting.create({
      data: {
        id,
        tenantId,
        documentId,
        eventId: event.eventId,
        ordinal: 1000 + manualCount,
        event: event as never,
        resolution: resolution as never,
      },
    });
    await this.refreshDocumentStatus(tenantId, documentId);
    return { resolution, event };
  }

  private placeholderStart(weekStart: Date | null): Date {
    const base = weekStart ? new Date(weekStart) : new Date(Date.now() + 86_400_000);
    base.setUTCHours(PLACEHOLDER_START_HOUR_UTC, 0, 0, 0);
    return base;
  }

  /** Apply one correction. The correction is authoritative for this document. */
  async correct(
    tenantId: string,
    actorId: string,
    documentId: string,
    meetingId: string,
    dto: ResolutionCorrectionDto,
  ): Promise<{ resolution: MeetingResolution; event: CalendarEvent }> {
    const doc = await this.assertDocument(tenantId, documentId);
    const row = await this.prisma.wsHillDayMeeting.findFirst({
      where: { id: meetingId, tenantId, documentId },
    });
    if (!row) throw new NotFoundException('Meeting not found on this document');
    const resolution = row.resolution as unknown as MeetingResolution | null;
    if (!resolution) throw new BadRequestException('Run resolution before correcting it');
    let event = row.event as unknown as CalendarEvent;
    const at = new Date().toISOString();
    const attendees = resolution.attendees.map((a) => ({ ...a }));
    let office: ResolvedOffice = { ...resolution.office };

    const findAttendee = (): ResolvedAttendee | undefined =>
      dto.attendeeId ? attendees.find((a) => a.attendeeId === dto.attendeeId) : undefined;

    switch (dto.kind) {
      case 'assign_staffer': {
        if (!dto.stafferId) throw new BadRequestException('stafferId is required');
        const res = await this.bridge.staffer(dto.stafferId);
        if (!res.ok) throw new ServiceUnavailableException(`Directory unavailable: ${res.detail}`);
        const staffer = res.data.staffer;
        if (!staffer) throw new NotFoundException('Directory staffer not found');
        let target = findAttendee();
        if (!target) {
          const address = normalizeAddress(dto.address);
          target = newAttendee(address);
          attendees.push(target);
        }
        target.state = 'resolved';
        target.stafferId = staffer.id;
        target.name = staffer.fullName;
        target.role = staffer.title || target.role;
        target.issueAreas = staffer.issueAreas ?? [];
        target.topics = staffer.issueAreas ?? [];
        target.directoryOffice = staffer.member ? officeRefFromContext(staffer.member) : null;
        target.committee = null;
        target.manual = false;
        target.detail = CONFIRMED_DETAIL;
        target.correction = {
          kind: 'assign_staffer',
          by: actorId,
          at,
          detail: `Assigned to ${staffer.fullName}${staffer.member ? ` (${staffer.member.fullName})` : ''}`,
        };
        break;
      }
      case 'manual_attendee':
      case 'create_directory_record': {
        const name = (dto.name ?? '').trim();
        if (!name) throw new BadRequestException('name is required');
        let target = findAttendee();
        if (!target) {
          target = newAttendee(normalizeAddress(dto.address));
          target.manual = true;
          attendees.push(target);
        }
        target.name = name;
        target.role = (dto.role ?? '').trim() || target.role;
        target.state = 'resolved';
        target.stafferId = null;
        target.committee = null;
        target.manual = true;
        target.detail = CONFIRMED_DETAIL;
        target.correction = {
          kind: dto.kind,
          by: actorId,
          at,
          detail: `Entered by you as ${name}${target.role ? `, ${target.role}` : ''}`,
        };
        if (dto.kind === 'create_directory_record') {
          const address = target.address ?? normalizeAddress(dto.address);
          if (!address) {
            throw new BadRequestException('An email address is required to create a Directory record');
          }
          target.address = address;
          const id = await this.source.upsertEngagementContact(tenantId, doc.clientId, {
            email: address,
            fullName: name,
            title: target.role,
            organization: office.member,
          });
          if (!id) throw new ServiceUnavailableException('Directory record could not be created');
          target.directoryRecord = { kind: 'engagement_contact', id };
        }
        break;
      }
      case 'accept_stale': {
        const target = findAttendee();
        if (!target) throw new NotFoundException('Attendee not found');
        const chosen =
          dto.useOffice === 'invite' ? target.inviteOffice : target.directoryOffice;
        if (!chosen) throw new BadRequestException('That office is not available for this attendee');
        target.state = 'resolved';
        target.directoryOffice = chosen;
        target.detail = CONFIRMED_DETAIL;
        target.correction = {
          kind: 'accept_stale',
          by: actorId,
          at,
          detail: `${dto.useOffice === 'invite' ? 'Invite' : 'Directory'} office governs: ${chosen.member ?? 'unknown'}`,
        };
        break;
      }
      case 'change_office': {
        if (!dto.memberId) throw new BadRequestException('memberId is required');
        const res = await this.bridge.memberContext(dto.memberId);
        if (!res.ok) throw new ServiceUnavailableException(`Directory unavailable: ${res.detail}`);
        if (!res.data.context) throw new NotFoundException('Directory member not found');
        const ref = officeRefFromContext(res.data.context);
        const alternatives = [office, ...office.alternatives].filter(
          (alt) => alt.memberId && alt.memberId !== ref.memberId,
        );
        office = {
          ...ref,
          room: office.room ?? event.location ?? ref.officeLocation,
          derivedFrom: 'user_correction',
          correctedBy: actorId,
          alternatives: dedupeOffices(alternatives),
        };
        break;
      }
      case 'edit_meeting_facts': {
        // Every field optional, so a form only sends what changed; unset
        // fields fall back to the current value for the endsAt>startsAt check.
        const nextStartsAt = dto.startsAt ?? event.startsAt;
        const nextEndsAt = dto.endsAt ?? event.endsAt;
        if (new Date(nextEndsAt).getTime() <= new Date(nextStartsAt).getTime()) {
          throw new BadRequestException('endsAt must be after startsAt');
        }
        const nextLocation = dto.location !== undefined ? dto.location.trim() || null : event.location;
        event = {
          ...event,
          subject: dto.subject?.trim() || event.subject,
          startsAt: nextStartsAt,
          endsAt: nextEndsAt,
          location: nextLocation,
        };
        // Meeting-level facts, not an office change — no re-derivation, and
        // this must not touch `derivedFrom`/`alternatives`/who resolved it.
        if (dto.location !== undefined) office = { ...office, room: nextLocation };
        break;
      }
      default:
        throw new BadRequestException('Unsupported correction');
    }

    // edit_meeting_facts is excluded too: it may have just set `office.room`
    // above, and this block closes over the ORIGINAL `event`, so running it
    // would silently overwrite that room back to the pre-edit location.
    if (dto.kind !== 'change_office' && dto.kind !== 'edit_meeting_facts') {
      office = deriveOffice({
        attendees,
        inviteDomainOffice: office.derivedFrom === 'invite_domain' ? office : null,
        committee: attendees.find((a) => a.committee)?.committee ?? null,
        room: event.location ?? null,
        previous: office,
      });
    }

    const roll = rollUpMeeting(attendees, office);
    const next: MeetingResolution = {
      ...resolution,
      office,
      attendees,
      state: roll.state,
      needsConfirmation: roll.needsConfirmation,
      resolvedAt: at,
    };
    await this.prisma.wsHillDayMeeting.update({
      where: { id: row.id },
      data: { event: event as never, resolution: next as never },
    });
    await this.refreshDocumentStatus(tenantId, documentId);
    return { resolution: next, event };
  }

  /** Directory lookups the correction affordances need (search + member profile). */
  async searchStaffers(q: string) {
    const trimmed = q.trim();
    if (trimmed.length < 2) return { staffers: [], sources: [ok('directory')] };
    const res = await this.bridge.searchStaffers(trimmed);
    if (!res.ok) return { staffers: [], sources: [unavailable('directory', res.detail)] };
    return {
      staffers: res.data.staffers.map((s) => ({
        id: s.id,
        name: s.fullName,
        title: s.title,
        email: s.email,
        issueAreas: s.issueAreas,
        member: s.member ? officeRefFromContext(s.member) : null,
      })),
      sources: [ok('directory')],
    };
  }

  async searchMembers(q: string, chamber?: string) {
    const trimmed = q.trim();
    if (trimmed.length < 2) return { members: [], sources: [ok('directory')] };
    const res = await this.bridge.searchContacts(trimmed, chamber);
    if (!res.ok) return { members: [], sources: [unavailable('directory', res.detail)] };
    return {
      members: res.data.contacts.map((c) => officeRefFromContext(c)),
      sources: [ok('directory')],
    };
  }

  async memberProfile(memberId: string) {
    const res = await this.bridge.memberContext(memberId);
    if (!res.ok) {
      return { member: null, staff: [], sources: [unavailable('directory', res.detail)] };
    }
    if (!res.data.context) throw new NotFoundException('Directory member not found');
    const ctx = res.data.context;
    return {
      member: officeRefFromContext(ctx),
      staff: (ctx.staff ?? []).map((s) => ({
        id: s.id,
        name: s.fullName,
        title: s.title,
        roles: s.roles,
        issueAreas: s.issueAreas,
        email: s.email,
        isCurrent: s.isCurrent,
      })),
      sources: [ok('directory')],
    };
  }

  /**
   * Full A–Z Directory browse for step 3's Directory tab — same data and
   * behaviour as Outreach's Directory tab (search + state/chamber filters,
   * paginated, no minimum query length so an empty query browses everything).
   * Thin passthrough to the bridge; no reshaping beyond the status envelope.
   */
  async browseDirectory(query: DirectoryBrowseQuery) {
    const res = await this.bridge.browseContacts(query);
    if (!res.ok) {
      return {
        contacts: [],
        total: 0,
        page: query.page ?? 1,
        pageSize: query.pageSize ?? 50,
        availableStates: [],
        availableChambers: [],
        sources: [unavailable('directory', res.detail)],
      };
    }
    return { ...res.data, sources: [ok('directory')] };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async assertDocument(tenantId: string, documentId: string) {
    const doc = await this.prisma.wsHillDayDocument.findFirst({ where: { id: documentId, tenantId } });
    if (!doc) throw new NotFoundException('Document not found');
    return doc;
  }

  private async refreshDocumentStatus(tenantId: string, documentId: string): Promise<void> {
    const meetings = await this.prisma.wsHillDayMeeting.findMany({
      where: { tenantId, documentId },
      select: { resolution: true },
    });
    const resolutions = meetings
      .map((m) => m.resolution as MeetingResolution | null)
      .filter((r): r is MeetingResolution => Boolean(r));
    const status = resolutions.length && resolutions.every((r) => r.state === 'clean') ? 'clean' : 'partial';
    await this.prisma.wsHillDayDocument.update({
      where: { id: documentId },
      data: { resolutionStatus: status },
    });
  }

  /** Firm members + the sponsor's own people: never part of the chain. */
  private async internalAddresses(tenantId: string, clientId: string): Promise<Set<string>> {
    const out = new Set<string>();
    try {
      for (const e of await this.source.tenantMemberEmails(tenantId)) out.add(e);
    } catch (err) {
      this.logger.warn(`tenant member emails unavailable: ${(err as Error).message}`);
    }
    try {
      for (const e of await this.source.clientPeopleEmails(tenantId, clientId)) out.add(e);
    } catch (err) {
      this.logger.warn(`client people emails unavailable: ${(err as Error).message}`);
    }
    return out;
  }

  private async resolveDomainOffices(
    addresses: string[],
    directoryOk: boolean,
  ): Promise<Map<string, OfficeRef>> {
    const out = new Map<string, OfficeRef>();
    if (!directoryOk) return out;
    const subdomains = new Set<string>();
    for (const a of addresses) {
      const sub = senateSubdomain(a);
      if (sub) subdomains.add(sub);
    }
    for (const sub of subdomains) {
      const res = await this.bridge.searchContacts(sub, 'Senate');
      if (!res.ok) continue;
      const hits = res.data.contacts.filter((c) => lastNameMatches(sub, c.memberName || c.fullName));
      if (hits.length === 1) out.set(sub, officeRefFromContext(hits[0]!));
    }
    return out;
  }

  private buildMeetingResolution(input: {
    meetingId: string;
    event: CalendarEvent;
    previous: MeetingResolution | null;
    internal: Set<string>;
    staffByEmail: Map<string, BridgeStaffMatch>;
    committeeByEmail: Map<string, BridgeCommitteeStaffMatch>;
    domainOffices: Map<string, OfficeRef>;
    directoryOk: boolean;
    directoryDetail: string | null;
    now: string;
  }): MeetingResolution {
    const { event, previous } = input;
    const previousById = new Map((previous?.attendees ?? []).map((a) => [a.attendeeId, a]));
    const internalParticipants: CalendarAttendee[] = [];
    const attendees: ResolvedAttendee[] = [];
    const seen = new Set<string>();
    let committee: { id: string; name: string } | null = null;
    let inviteDomainOffice: OfficeRef | null = null;

    const candidates: CalendarAttendee[] = [...(event.attendees ?? [])];
    if (event.organizer && !candidates.some((a) => normalizeAddress(a.address) === normalizeAddress(event.organizer?.address))) {
      candidates.push(event.organizer);
    }

    for (const raw of candidates) {
      const address = normalizeAddress(raw.address);
      if (!address || seen.has(address)) continue;
      seen.add(address);
      if (input.internal.has(address)) {
        internalParticipants.push({ address, name: raw.name ?? null, responseStatus: raw.responseStatus ?? null });
        continue;
      }
      const attendeeId = attendeeIdFor(address);
      const prev = previousById.get(attendeeId);
      if (prev?.correction) {
        // A correction is authoritative — re-applied verbatim on re-run.
        attendees.push({ ...prev });
        if (prev.committee) committee = committee ?? prev.committee;
        continue;
      }

      const sub = senateSubdomain(address);
      let inviteOffice = sub ? input.domainOffices.get(sub) ?? null : null;

      const staff = input.staffByEmail.get(address);
      const cstaff = input.committeeByEmail.get(address);

      // An address that matches a MEMBER's Directory contact is the office's
      // general or scheduling mailbox (members do not publish personal
      // addresses), so it names the office but carries no substantive
      // attendee: scheduler-only, office derived from the invite. Verified live
      // 2026-09-02: `scheduling@collins.senate.gov` is Sen. Collins' contact
      // email and must not read as the senator attending.
      if (staff && staff.matchKind === 'member') {
        const office = officeRefFromContext(staff.member);
        inviteOffice = inviteOffice ?? office;
        if (!inviteDomainOffice) inviteDomainOffice = inviteOffice;
        attendees.push({
          attendeeId,
          address,
          state: 'scheduler',
          stafferId: null,
          name: address,
          role: null,
          issueAreas: [],
          topics: [],
          directoryOffice: null,
          inviteOffice,
          committee: null,
          detail: `Office address for ${office.member ?? 'this member'}. No substantive attendees on the invite yet.`,
          manual: false,
          correction: null,
          directoryRecord: null,
        });
        continue;
      }
      if (inviteOffice && !inviteDomainOffice) inviteDomainOffice = inviteOffice;

      if (staff?.staff) {
        const directoryOffice = officeRefFromContext(staff.member);
        // Stale when the invite domain names a different office than the
        // Directory does, or when the Directory itself lists the position as
        // no longer current. Both offer the user a choice rather than a guess.
        const inviteMismatch = Boolean(
          inviteOffice && inviteOffice.memberId && inviteOffice.memberId !== directoryOffice.memberId,
        );
        const formerPosition = staff.staff.isCurrent === false;
        const stale = inviteMismatch || formerPosition;
        attendees.push({
          attendeeId,
          address,
          state: stale ? 'stale' : 'resolved',
          stafferId: staff.staff.id,
          name: staff.staff.fullName,
          role: staff.staff.title || null,
          issueAreas: staff.staff.issueAreas ?? [],
          topics: staff.staff.issueAreas ?? [],
          directoryOffice,
          inviteOffice,
          committee: null,
          detail: inviteMismatch
            ? stateDetail('stale', {
                name: staff.staff.fullName,
                directoryMember: directoryOffice.memberName,
                inviteMember: inviteOffice?.memberName ?? null,
              })
            : formerPosition
              ? `Directory lists ${staff.staff.fullName} as a former member of ${
                  directoryOffice.memberName ?? 'this'
                } office. Confirm which office governs for this document.`
              : stateDetail('resolved'),
          manual: false,
          correction: null,
          directoryRecord: null,
        });
        continue;
      }

      if (cstaff) {
        committee = committee ?? { id: cstaff.committee.id, name: cstaff.committee.name };
        attendees.push({
          attendeeId,
          address,
          state: 'resolved',
          stafferId: cstaff.staff.id,
          name: cstaff.staff.fullName,
          role: `${cstaff.staff.title || 'Committee staff'}, ${cstaff.committee.name}`,
          issueAreas: [],
          topics: [],
          directoryOffice: null,
          inviteOffice,
          committee: { id: cstaff.committee.id, name: cstaff.committee.name },
          detail: 'Matches a committee staff record in the Directory.',
          manual: false,
          correction: null,
          directoryRecord: null,
        });
        continue;
      }

      if (isSchedulerAddress(address)) {
        attendees.push({
          attendeeId,
          address,
          state: 'scheduler',
          stafferId: null,
          name: address,
          role: null,
          issueAreas: [],
          topics: [],
          directoryOffice: null,
          inviteOffice,
          committee: null,
          detail: stateDetail('scheduler'),
          manual: false,
          correction: null,
          directoryRecord: null,
        });
        continue;
      }

      attendees.push({
        attendeeId,
        address,
        state: 'unresolved',
        stafferId: null,
        name: raw.name?.trim() || address,
        role: null,
        issueAreas: [],
        topics: [],
        directoryOffice: null,
        inviteOffice,
        committee: null,
        detail: input.directoryOk
          ? stateDetail('unresolved')
          : `Directory unavailable (${input.directoryDetail ?? 'no detail'}); this address could not be checked.`,
        manual: false,
        correction: null,
        directoryRecord: null,
      });
    }

    // Attendees added without a real invite address stay on the record —
    // `manual` alone isn't the right test: assign_staffer sets manual:false
    // even when newAttendee(null) created the record from scratch (no
    // attendeeId, no address), which is exactly the case a manual meeting's
    // empty event.attendees[] can never rediscover on the next resolve pass.
    for (const prev of previous?.attendees ?? []) {
      if ((prev.manual || prev.address === null) && !attendees.some((a) => a.attendeeId === prev.attendeeId)) {
        attendees.push({ ...prev });
      }
    }

    const office = deriveOffice({
      attendees,
      inviteDomainOffice,
      committee,
      room: event.location ?? null,
      previous: previous?.office ?? null,
    });
    const roll = rollUpMeeting(attendees, office);
    const sources: SourceStatusBlock[] = [
      { source: 'calendar', status: 'ok', detail: event.source },
      input.directoryOk
        ? ok('directory')
        : unavailable('directory', input.directoryDetail ?? 'Directory unavailable'),
    ];
    return {
      meetingId: input.meetingId,
      eventId: event.eventId,
      state: roll.state,
      office,
      attendees,
      internalParticipants,
      needsConfirmation: roll.needsConfirmation,
      resolvedAt: input.now,
      sources,
    };
  }
}

function newAttendee(address: string | null): ResolvedAttendee {
  return {
    attendeeId: address ? attendeeIdFor(address) : `att_m_${randomUUID().slice(0, 8)}`,
    address,
    state: 'unresolved',
    stafferId: null,
    name: null,
    role: null,
    issueAreas: [],
    topics: [],
    directoryOffice: null,
    inviteOffice: null,
    committee: null,
    detail: '',
    manual: false,
    correction: null,
    directoryRecord: null,
  };
}

function dedupeOffices(list: OfficeRef[]): OfficeRef[] {
  const out: OfficeRef[] = [];
  const seen = new Set<string>();
  for (const o of list) {
    const key = o.memberId ?? o.member ?? '';
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(o);
  }
  return out;
}

function ok(source: string): SourceStatusBlock {
  return { source, status: 'ok', detail: null };
}

function unavailable(source: string, detail: string): SourceStatusBlock {
  return { source, status: 'unavailable', detail };
}

/** One block per source: the worst status wins, details joined. */
export function mergeSources(blocks: SourceStatusBlock[]): SourceStatusBlock[] {
  const rank = { ok: 0, partial: 1, unavailable: 2 } as const;
  const out = new Map<string, SourceStatusBlock>();
  for (const b of blocks) {
    const cur = out.get(b.source);
    if (!cur) {
      out.set(b.source, { ...b });
      continue;
    }
    if (rank[b.status] > rank[cur.status]) out.set(b.source, { ...b });
  }
  return [...out.values()];
}
