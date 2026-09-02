import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { PutMeetingContextDto } from './dto/hillday.dto.js';
import { HillDaySourceService, type ThreadRow } from './hillday-source.service.js';
import type {
  CarrySelection,
  CarryUnit,
  MeetingContextCandidates,
  MeetingContextRecord,
  MeetingResolution,
  SourceStatusBlock,
  ThreadRef,
  ThreadsResponse,
} from './hillday.types.js';

export const DEFAULT_LOOKBACK_DAYS = 90;
/** Requirements §5: the two highest-salience issue areas are on by default. */
const DEFAULT_ISSUE_AREAS_ON = 2;

export function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

/**
 * Build the carry-over units for a meeting from its resolution. The default
 * rule lives HERE (server-supplied `defaultSelected`), so it can change
 * without a UI release. Current rule: committees on, the two highest-salience
 * issue areas on, bio off, staffers with a Directory record on, unresolved
 * and scheduler-only attendees off.
 */
export function buildCarryUnits(
  resolution: MeetingResolution | null,
  record: MeetingContextRecord | null,
): CarryUnit[] {
  if (!resolution) return [];
  const units: CarryUnit[] = [];
  const office = resolution.office;
  const carry = record?.carry ?? null;
  const pick = (id: string, def: boolean, kind: CarryUnit['kind']): boolean => {
    if (!carry) return def;
    switch (kind) {
      case 'committees':
        return carry.committees;
      case 'bio':
        return carry.bio;
      case 'issue_area':
        return carry.issueAreas.includes(id);
      case 'staffer':
        return carry.staffers.includes(id.replace(/^staffer:/, ''));
      default:
        return def;
    }
  };

  if (office.committees.length) {
    units.push({
      id: 'committees',
      kind: 'committees',
      label: 'Committees',
      defaultSelected: true,
      selected: pick('committees', true, 'committees'),
      detail: office.committees.join(' · '),
      topics: [],
      known: true,
      attendeeState: null,
    });
  }
  const ranked = [...office.focusAreas].sort((a, b) => b.salience - a.salience);
  ranked.forEach((fa, i) => {
    const id = `issue:${slugify(fa.label)}`;
    const def = i < DEFAULT_ISSUE_AREAS_ON;
    units.push({
      id,
      kind: 'issue_area',
      label: fa.label,
      defaultSelected: def,
      selected: pick(id, def, 'issue_area'),
      detail: null,
      topics: [],
      known: true,
      attendeeState: null,
    });
  });
  if (office.bio) {
    units.push({
      id: 'bio',
      kind: 'bio',
      label: 'Bio',
      defaultSelected: false,
      selected: pick('bio', false, 'bio'),
      detail: office.bio,
      topics: [],
      known: true,
      attendeeState: null,
    });
  }
  for (const a of resolution.attendees) {
    const known = Boolean(a.stafferId) && a.state === 'resolved';
    const id = `staffer:${a.attendeeId}`;
    units.push({
      id,
      kind: 'staffer',
      label: a.name ?? a.address ?? 'Attendee',
      defaultSelected: known,
      selected: pick(id, known, 'staffer'),
      detail:
        a.role ??
        (a.state === 'scheduler'
          ? 'Scheduling address — no substantive attendee yet'
          : a.manual
            ? 'Entered by you'
            : 'No Directory record for this address'),
      topics: a.topics ?? [],
      known,
      attendeeState: a.state,
    });
  }
  return units;
}

/** Effective selection: the stored record, else the server defaults. */
export function effectiveCarry(units: CarryUnit[]): CarrySelection {
  return {
    committees: units.some((u) => u.kind === 'committees' && u.selected),
    bio: units.some((u) => u.kind === 'bio' && u.selected),
    issueAreas: units.filter((u) => u.kind === 'issue_area' && u.selected).map((u) => u.id),
    staffers: units
      .filter((u) => u.kind === 'staffer' && u.selected)
      .map((u) => u.id.replace(/^staffer:/, '')),
  };
}

export function ageDays(from: Date | null, now = new Date()): number | null {
  if (!from) return null;
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / 86_400_000));
}

export function toThreadRef(row: ThreadRow, clientId: string, now = new Date()): ThreadRef {
  const participants = (Array.isArray(row.participants) ? row.participants : [])
    .map((p) => (p?.name?.trim() || p?.email?.trim() || '').trim())
    .filter(Boolean);
  return {
    id: row.id,
    subject: row.subject,
    participants: [...new Set(participants)].slice(0, 6),
    messageCount: row.messageCount,
    lastMessageAt: row.lastMessageAt ? row.lastMessageAt.toISOString() : null,
    ageDays: ageDays(row.lastMessageAt, now),
    clientTagged: row.clientId === clientId,
  };
}

/**
 * Step 5 — carry-over selection + user note + correspondence (requirements §5).
 * What the user chooses here is the authoritative record of what may reach
 * the generator; enforcement happens at prompt assembly, not in the UI.
 */
@Injectable()
export class HillDayContextService {
  private readonly logger = new Logger(HillDayContextService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly source: HillDaySourceService,
  ) {}

  async candidates(
    tenantId: string,
    actorId: string,
    documentId: string,
    meetingId: string,
    lookbackOverride: number | null,
  ): Promise<MeetingContextCandidates> {
    const { doc, row } = await this.loadMeeting(tenantId, documentId, meetingId);
    const resolution = row.resolution as MeetingResolution | null;
    const record = row.context as MeetingContextRecord | null;
    const lookbackDays = lookbackOverride ?? record?.lookbackDays ?? doc.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
    const units = buildCarryUnits(resolution, record);
    const threads = await this.threadsFor(tenantId, actorId, doc.clientId, resolution, lookbackDays);
    return {
      meetingId,
      member: resolution?.office ?? null,
      units,
      threads: threads.threads,
      lookbackDays,
      record,
      sources: [
        resolution
          ? { source: 'directory', status: 'ok', detail: null }
          : { source: 'directory', status: 'unavailable', detail: 'Resolution has not run for this meeting' },
        ...threads.sources,
      ],
    };
  }

  async write(
    tenantId: string,
    actorId: string,
    documentId: string,
    meetingId: string,
    dto: PutMeetingContextDto,
  ): Promise<{ record: MeetingContextRecord; sourceCount: number; units: CarryUnit[] }> {
    const { doc, row } = await this.loadMeeting(tenantId, documentId, meetingId);
    if (doc.ownerId !== actorId) {
      throw new BadRequestException('Only the document owner can change its context');
    }
    const resolution = row.resolution as MeetingResolution | null;
    const available = buildCarryUnits(resolution, null);
    const issueIds = new Set(available.filter((u) => u.kind === 'issue_area').map((u) => u.id));
    const stafferIds = new Set(
      available.filter((u) => u.kind === 'staffer').map((u) => u.id.replace(/^staffer:/, '')),
    );
    const record: MeetingContextRecord = {
      // Stored verbatim — the note is a first-hand source (requirements §7).
      note: dto.note,
      carry: {
        committees: Boolean(dto.carry.committees),
        bio: Boolean(dto.carry.bio),
        issueAreas: [...new Set(dto.carry.issueAreas)].filter((id) => issueIds.has(id)),
        staffers: [...new Set(dto.carry.staffers)].filter((id) => stafferIds.has(id)),
      },
      threadIds: [...new Set(dto.threadIds)].slice(0, 64),
      lookbackDays: dto.lookbackDays ?? null,
      savedAt: new Date().toISOString(),
      savedBy: actorId,
    };
    await this.prisma.wsHillDayMeeting.update({
      where: { id: row.id },
      data: { context: record as never },
    });
    const units = buildCarryUnits(resolution, record);
    const sourceCount =
      units.filter((u) => u.selected).length + record.threadIds.length + (record.note.trim() ? 1 : 0);
    return { record, sourceCount, units };
  }

  async threads(
    tenantId: string,
    actorId: string,
    documentId: string,
    meetingId: string | null,
    lookbackOverride: number | null,
  ): Promise<ThreadsResponse> {
    const doc = await this.prisma.wsHillDayDocument.findFirst({ where: { id: documentId, tenantId } });
    if (!doc) throw new NotFoundException('Document not found');
    let resolution: MeetingResolution | null = null;
    let lookback = lookbackOverride ?? doc.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
    if (meetingId) {
      const row = await this.prisma.wsHillDayMeeting.findFirst({
        where: { id: meetingId, tenantId, documentId },
      });
      if (!row) throw new NotFoundException('Meeting not found on this document');
      resolution = row.resolution as MeetingResolution | null;
      const record = row.context as MeetingContextRecord | null;
      lookback = lookbackOverride ?? record?.lookbackDays ?? lookback;
    }
    return this.threadsFor(tenantId, actorId, doc.clientId, resolution, lookback);
  }

  private async threadsFor(
    tenantId: string,
    actorId: string,
    clientId: string,
    resolution: MeetingResolution | null,
    lookbackDays: number,
  ): Promise<ThreadsResponse> {
    const now = new Date();
    const since = new Date(now.getTime() - lookbackDays * 86_400_000);
    const addresses = (resolution?.attendees ?? [])
      .map((a) => a.address)
      .filter((a): a is string => Boolean(a));
    const sources: SourceStatusBlock[] = [];
    let threads: ThreadRef[] = [];
    try {
      const userId = await this.source.resolveUserId(actorId);
      const rows = await this.source.listThreads(tenantId, userId, clientId, addresses, since);
      threads = rows.map((r) => toThreadRef(r, clientId, now));
      sources.push({
        source: 'correspondence',
        status: 'ok',
        detail: `${threads.length} thread(s) in the last ${lookbackDays} days`,
      });
    } catch (err) {
      this.logger.warn(`correspondence read failed: ${(err as Error).message}`);
      sources.push({ source: 'correspondence', status: 'unavailable', detail: (err as Error).message });
    }
    return { lookbackDays, windowStart: since.toISOString(), threads, sources };
  }

  private async loadMeeting(tenantId: string, documentId: string, meetingId: string) {
    const doc = await this.prisma.wsHillDayDocument.findFirst({ where: { id: documentId, tenantId } });
    if (!doc) throw new NotFoundException('Document not found');
    const row = await this.prisma.wsHillDayMeeting.findFirst({
      where: { id: meetingId, tenantId, documentId },
    });
    if (!row) throw new NotFoundException('Meeting not found on this document');
    return { doc, row };
  }
}
