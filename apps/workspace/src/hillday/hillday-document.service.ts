import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { DirectoryBridgeClient } from './directory-bridge.client.js';
import type {
  CreateHillDayDocumentDto,
  PatchHillDayDocumentDto,
  SetMeetingsDto,
} from './dto/hillday.dto.js';
import { durationLabel, formatWhen } from './generation-prompt.js';
import {
  BLUEPRINT_CATALOG,
  HILL_DAY_BLUEPRINT_NAME,
  HILL_DAY_BLUEPRINT_SLUG,
  findBlueprint,
  type HillDayBlueprint,
} from './hillday-blueprints.catalog.js';
import { DEFAULT_LOOKBACK_DAYS } from './hillday-context.service.js';
import {
  HillDaySourceService,
  initialsOf,
  isUuid,
  type RawEventRow,
} from './hillday-source.service.js';
import type {
  CalendarAttendee,
  CalendarEvent,
  CalendarResponse,
  ClientOption,
  ClientsResponse,
  DocumentSectionView,
  HillDayDocumentView,
  LibraryRow,
  MeetingContextRecord,
  MeetingResolution,
  MeetingSection,
  Page,
  ProvenanceView,
  QualityCheck,
  QualityResponse,
  SourceSet,
  SourceStatusBlock,
  SummaryRow,
} from './hillday.types.js';
import { normalizeAddress, partyLine } from './resolution.rules.js';

const DEFAULT_TZ = 'America/New_York';
const MAX_PAGE = 50;

interface MeetingRow {
  id: string;
  eventId: string;
  ordinal: number;
  event: unknown;
  resolution: unknown;
  context: unknown;
  section: unknown;
  sourceSet: unknown;
  updatedAt: Date;
}

export function encodeCursor(value: Record<string, string>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): Record<string, string> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v;
    return out;
  } catch {
    return null;
  }
}

export function clampLimit(raw: string | number | undefined, fallback = 25): number {
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(MAX_PAGE, n);
}

/** Monday (YYYY-MM-DD) of the week containing `iso` in `timeZone`. */
export function mondayOf(iso: string, timeZone: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekday = get('weekday');
  const idx = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(weekday);
  const local = new Date(Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day'))));
  local.setUTCDate(local.getUTCDate() - Math.max(0, idx));
  return local.toISOString().slice(0, 10);
}

export function localDate(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Classify calendar events for a sponsor (requirements §3 step 3): an event
 * surfaces when it is tagged to the client or an attendee address matches a
 * Directory staffer; internal events are listed but distinguished. Events
 * tagged to ANOTHER client are never shown. The reason is returned per event.
 */
export function classifyEvents(
  rows: RawEventRow[],
  clientId: string,
  clientName: string,
  matched: Set<string>,
  internal: Set<string>,
  timeZone: string,
): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  for (const row of rows) {
    if (row.clientId && row.clientId !== clientId) continue;
    const attendees: CalendarAttendee[] = (row.attendees ?? [])
      .map((a) => ({
        address: normalizeAddress(a.address) ?? '',
        name: a.name?.trim() || null,
        responseStatus: a.responseStatus ?? null,
      }))
      .filter((a) => a.address);
    const external = attendees.filter((a) => !internal.has(a.address));
    const matchedAddresses = external.filter((a) => matched.has(a.address)).map((a) => a.address);
    const tagged = row.clientId === clientId;
    let kind: CalendarEvent['kind'] = 'hill';
    let reason: CalendarEvent['reason'];
    if (row.isInternal) {
      kind = 'internal';
      reason = { kind: 'internal', detail: 'Marked internal in Engagement.', matchedAddresses: [] };
    } else if (tagged && matchedAddresses.length) {
      reason = {
        kind: 'tagged_and_matched',
        detail: `Tagged to ${clientName}; ${matchedAddresses.length} attendee address${matchedAddresses.length === 1 ? '' : 'es'} match Directory staff.`,
        matchedAddresses,
      };
    } else if (tagged && external.length === 0) {
      kind = 'internal';
      reason = {
        kind: 'internal',
        detail: `Tagged to ${clientName}; only firm and client attendees on the invite.`,
        matchedAddresses: [],
      };
    } else if (tagged) {
      reason = {
        kind: 'tagged',
        detail: `Tagged to ${clientName}. No attendee address matches a Directory staffer.`,
        matchedAddresses: [],
      };
    } else if (matchedAddresses.length) {
      reason = {
        kind: 'matched',
        detail: `${matchedAddresses.length} attendee address${matchedAddresses.length === 1 ? '' : 'es'} match Directory staff.`,
        matchedAddresses,
      };
    } else {
      continue;
    }
    const organizerAddress = normalizeAddress(row.organizerEmail);
    out.push({
      eventId: row.id,
      subject: row.subject,
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      timeZone: row.timeZone || timeZone,
      location: row.location?.trim() || null,
      isVirtual: row.isVirtual,
      joinLink: row.joinLink,
      kind,
      clientId: row.clientId,
      organizer: organizerAddress
        ? { address: organizerAddress, name: row.organizerName?.trim() || null, responseStatus: null }
        : null,
      attendees,
      reason,
      source: row.source,
      connectionId: row.connectionId,
    });
  }
  return out;
}

/**
 * Documents, library, sponsor picker, calendar candidates and the assembled
 * document model (requirements §6, §8). The summary table and the sections are
 * generated from the SAME meeting rows — never hand-maintained.
 */
@Injectable()
export class HillDayDocumentService {
  private readonly logger = new Logger(HillDayDocumentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly source: HillDaySourceService,
    private readonly bridge: DirectoryBridgeClient,
  ) {}

  // ── Blueprints ────────────────────────────────────────────────────────────

  async listBlueprints(tenantId: string): Promise<{ blueprints: HillDayBlueprint[] }> {
    const firm: HillDayBlueprint[] = [];
    try {
      const rows = await this.prisma.wsBlueprint.findMany({
        where: { tenantId, versions: { some: { status: 'published' } } },
        select: { id: true, slug: true, name: true, description: true, product: true },
        orderBy: { name: 'asc' },
        take: 20,
      });
      for (const r of rows) {
        firm.push({
          id: r.id,
          slug: r.slug,
          name: r.name,
          description: r.description ?? r.product,
          meta: 'Firm blueprint · Template Studio',
          icon: 'File04',
          sources: ['Portfolio'],
          stepCount: 0,
          scope: 'firm',
          implemented: false,
          isNew: false,
        });
      }
    } catch (err) {
      this.logger.warn(`firm blueprints unavailable: ${(err as Error).message}`);
    }
    return { blueprints: [...BLUEPRINT_CATALOG, ...firm] };
  }

  // ── Library ───────────────────────────────────────────────────────────────

  async listDocuments(
    tenantId: string,
    opts: { clientId?: string; status?: string; cursor?: string; limit?: string },
  ): Promise<Page<LibraryRow>> {
    const limit = clampLimit(opts.limit);
    const cursor = decodeCursor(opts.cursor);
    const before = cursor?.u ? new Date(cursor.u) : null;
    const beforeId = cursor?.i ?? null;
    const clientId = opts.clientId && isUuid(opts.clientId) ? opts.clientId : null;
    let clientName: string | null = null;
    if (clientId) {
      const client = await this.source.getClient(tenantId, null, clientId).catch(() => null);
      clientName = client?.name ?? null;
    }
    const cursorWhere =
      before && beforeId
        ? {
            OR: [{ updatedAt: { lt: before } }, { updatedAt: before, id: { lt: beforeId } }],
          }
        : {};

    const HILL_STATUSES = ['draft', 'generating', 'generated', 'partial', 'delivered'];
    const hillStatus = opts.status && HILL_STATUSES.includes(opts.status) ? opts.status : null;
    const hill = opts.status && !hillStatus
      ? []
      : await this.prisma.wsHillDayDocument.findMany({
      where: {
        tenantId,
        ...(clientId ? { clientId } : {}),
        ...(hillStatus ? { status: hillStatus as never } : {}),
        ...cursorWhere,
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const drafts = await this.prisma.wsDraft.findMany({
      where: {
        tenantId,
        ...(clientName ? { client: clientName } : {}),
        ...(opts.status && (opts.status === 'draft' || opts.status === 'complete')
          ? { status: opts.status }
          : opts.status
            ? { id: { in: [] } }
            : {}),
        ...cursorWhere,
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: { id: true, docTitle: true, product: true, client: true, status: true, updatedAt: true, ownerId: true },
    });

    const owners = await this.source
      .userDisplays([...hill.map((d) => d.ownerId), ...drafts.map((d) => d.ownerId)])
      .catch(() => new Map());
    const owner = (id: string) => owners.get(id) ?? { clerkUserId: id, name: 'Unknown', initials: '?', email: null };

    const rows: LibraryRow[] = [
      ...hill.map<LibraryRow>((d) => ({
        id: d.id,
        kind: 'hillday',
        name: d.name,
        blueprint: HILL_DAY_BLUEPRINT_NAME,
        client: d.clientName,
        status: d.status,
        updatedAt: d.updatedAt.toISOString(),
        owner: { id: d.ownerId, name: owner(d.ownerId).name, initials: owner(d.ownerId).initials },
        route: `/workspace/documents/${d.id}`,
      })),
      ...drafts.map<LibraryRow>((d) => ({
        id: d.id,
        kind: 'draft',
        name: d.docTitle,
        blueprint: d.product ?? 'Document',
        client: d.client,
        status: d.status,
        updatedAt: d.updatedAt.toISOString(),
        owner: { id: d.ownerId, name: owner(d.ownerId).name, initials: owner(d.ownerId).initials },
        route: `/workspace/${d.id}`,
      })),
    ].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : b.id.localeCompare(a.id)));

    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    const nextCursor = rows.length > limit && last ? encodeCursor({ u: last.updatedAt, i: last.id }) : null;
    return { items, nextCursor };
  }

  // ── Documents ─────────────────────────────────────────────────────────────

  async create(tenantId: string, actorId: string, dto: CreateHillDayDocumentDto) {
    const blueprint = findBlueprint(dto.blueprintId);
    if (!blueprint) throw new NotFoundException('Blueprint not found');
    if (!blueprint.implemented) {
      throw new BadRequestException(`${blueprint.name} is not implemented yet — only Hill Day Schedule is.`);
    }
    const userId = await this.source.resolveUserId(actorId).catch(() => null);
    const client = await this.source.getClient(tenantId, userId, dto.clientId);
    if (!client) throw new NotFoundException('Client not found');
    if (!client.wallAllowed) throw new ForbiddenException('You do not have access to this client');
    const doc = await this.prisma.wsHillDayDocument.create({
      data: {
        tenantId,
        ownerId: actorId,
        blueprintSlug: HILL_DAY_BLUEPRINT_SLUG,
        clientId: client.id,
        clientName: client.name,
        name: dto.name.trim(),
        lookbackDays: dto.lookbackDays ?? DEFAULT_LOOKBACK_DAYS,
        timeZone: dto.timeZone ?? DEFAULT_TZ,
      },
    });
    return {
      id: doc.id,
      name: doc.name,
      status: doc.status,
      blueprint: { slug: blueprint.slug, name: blueprint.name },
      client: { id: client.id, name: client.name },
      lookbackDays: doc.lookbackDays,
      timeZone: doc.timeZone,
      createdAt: doc.createdAt.toISOString(),
    };
  }

  async patch(tenantId: string, actorId: string, documentId: string, dto: PatchHillDayDocumentDto) {
    const doc = await this.assertOwner(tenantId, actorId, documentId);
    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name.trim();
    if (dto.lookbackDays !== undefined) data.lookbackDays = dto.lookbackDays;
    if (dto.status !== undefined) {
      if (dto.status === 'delivered' && doc.status !== 'generated' && doc.status !== 'partial' && doc.status !== 'delivered') {
        throw new BadRequestException('Generate the document before delivering it');
      }
      data.status = dto.status === 'draft' ? (doc.generatedAt ? 'generated' : 'draft') : dto.status;
    }
    if (dto.section) {
      const meeting = await this.prisma.wsHillDayMeeting.findFirst({
        where: { id: dto.section.sectionId, tenantId, documentId },
      });
      if (!meeting) throw new NotFoundException('Section not found');
      const current = (meeting.section as MeetingSection | null) ?? {
        sectionId: meeting.id,
        status: 'pending' as const,
        focus: null,
        background: null,
        reason: null,
        flags: [],
        generatedAt: null,
        model: null,
        edited: { focus: false, background: false, at: null },
      };
      const at = new Date().toISOString();
      const next: MeetingSection = {
        ...current,
        focus: dto.section.focus !== undefined ? dto.section.focus : current.focus,
        background: dto.section.background !== undefined ? dto.section.background : current.background,
        status:
          current.status === 'unavailable' && (dto.section.focus || dto.section.background)
            ? 'done'
            : current.status,
        edited: {
          focus: current.edited.focus || dto.section.focus !== undefined,
          background: current.edited.background || dto.section.background !== undefined,
          at,
        },
        flags: [
          ...current.flags.filter((f) => f.kind !== 'user_edited'),
          { kind: 'user_edited', detail: `Edited by hand ${at.slice(0, 10)}; excluded from bulk regeneration.` },
        ],
      };
      await this.prisma.wsHillDayMeeting.update({ where: { id: meeting.id }, data: { section: next as never } });
    }
    if (Object.keys(data).length) {
      await this.prisma.wsHillDayDocument.update({ where: { id: documentId }, data: data as never });
    }
    return this.get(tenantId, documentId);
  }

  // ── Sponsor picker + calendar ─────────────────────────────────────────────

  async listClients(
    tenantId: string,
    actorId: string,
    q: string | undefined,
    cursorRaw: string | undefined,
    limitRaw: string | undefined,
  ): Promise<ClientsResponse> {
    const limit = clampLimit(limitRaw, 25);
    const cursor = decodeCursor(cursorRaw);
    const userId = await this.source.resolveUserId(actorId).catch(() => null);
    const rows = await this.source.listClients(
      tenantId,
      userId,
      q ?? '',
      cursor?.n !== undefined && cursor?.i !== undefined ? { name: cursor.n, id: cursor.i } : null,
      limit,
    );
    const visible = rows.filter((r) => r.wallAllowed);
    const page = visible.slice(0, limit);
    const sources: SourceStatusBlock[] = [{ source: 'portfolio', status: 'ok', detail: null }];
    let objectives = new Map<string, number>();
    let objectivesOk = true;
    try {
      objectives = await this.source.objectiveCounts(tenantId, page.map((r) => r.id));
      sources.push({ source: 'strategies', status: 'ok', detail: null });
    } catch (err) {
      objectivesOk = false;
      sources.push({ source: 'strategies', status: 'unavailable', detail: (err as Error).message });
    }
    const items: ClientOption[] = page.map((r) => ({
      id: r.id,
      name: r.name,
      mono: initialsOf(r.name),
      description: r.sectorTag ?? r.description ?? r.productDescription ?? null,
      objectiveCount: objectivesOk ? objectives.get(r.id) ?? 0 : null,
      officeCount: r.officeCount,
      hasLogo: r.hasLogo,
    }));
    const last = rows[limit - 1];
    const nextCursor = rows.length > limit && last ? encodeCursor({ n: last.name, i: last.id }) : null;
    return { items, nextCursor, sources };
  }

  async calendar(
    tenantId: string,
    actorId: string,
    clientId: string,
    fromRaw: string | undefined,
    toRaw: string | undefined,
    timeZoneRaw: string | undefined,
  ): Promise<CalendarResponse> {
    const timeZone = safeTimeZone(timeZoneRaw) ?? DEFAULT_TZ;
    const userId = await this.source.resolveUserId(actorId).catch(() => null);
    const client = await this.source.getClient(tenantId, userId, clientId);
    if (!client) throw new NotFoundException('Client not found');
    if (!client.wallAllowed) throw new ForbiddenException('You do not have access to this client');

    const from = fromRaw ? new Date(fromRaw) : new Date(`${mondayOf(new Date().toISOString(), timeZone)}T00:00:00`);
    if (Number.isNaN(from.getTime())) throw new BadRequestException('Invalid from date');
    const to = toRaw ? new Date(toRaw) : new Date(from.getTime() + 7 * 86_400_000);
    if (Number.isNaN(to.getTime()) || to <= from) throw new BadRequestException('Invalid to date');
    if (to.getTime() - from.getTime() > 31 * 86_400_000) {
      throw new BadRequestException('Calendar range cannot exceed 31 days');
    }

    const sources: SourceStatusBlock[] = [];
    let rows: RawEventRow[] = [];
    try {
      rows = await this.source.listEvents(tenantId, userId, from, to);
      const connections = await this.source.listConnections(tenantId).catch(() => []);
      if (!connections.length) {
        sources.push({
          source: 'calendar',
          status: rows.length ? 'partial' : 'unavailable',
          detail: 'No calendar connection is configured for this firm; only manually recorded events can surface.',
        });
      }
      // One block per provider (a firm can hold several mailboxes of the same
      // provider): connected count vs. total, worst status wins.
      const byProvider = new Map<string, typeof connections>();
      for (const c of connections) {
        const list = byProvider.get(c.provider) ?? [];
        list.push(c);
        byProvider.set(c.provider, list);
      }
      for (const [provider, list] of byProvider) {
        const connected = list.filter((c) => c.status === 'connected');
        const errored = list.filter((c) => c.status === 'error');
        const status: SourceStatusBlock['status'] =
          connected.length === list.length ? 'ok' : connected.length > 0 || errored.length > 0 ? 'partial' : 'unavailable';
        const lastSync = connected
          .map((c) => c.lastSyncAt?.getTime() ?? 0)
          .reduce((a, b) => Math.max(a, b), 0);
        sources.push({
          source: `calendar:${provider}`,
          status,
          detail:
            status === 'ok'
              ? `${connected.length} mailbox${connected.length === 1 ? '' : 'es'} · last sync ${lastSync ? new Date(lastSync).toISOString() : 'never'}`
              : `${connected.length} of ${list.length} mailboxes connected${
                  errored[0]?.lastError ? ` · ${errored[0].lastError}` : ''
                }`,
        });
      }
    } catch (err) {
      this.logger.warn(`calendar read failed: ${(err as Error).message}`);
      sources.push({ source: 'calendar', status: 'unavailable', detail: (err as Error).message });
      return { clientId, from: from.toISOString(), to: to.toISOString(), timeZone, events: [], upcomingEventAt: null, sources };
    }

    const internal = await this.internalAddresses(tenantId, clientId);
    const candidates = rows.filter((r) => !r.clientId || r.clientId === clientId);
    const addresses = new Set<string>();
    for (const r of candidates) {
      for (const a of r.attendees ?? []) {
        const addr = normalizeAddress(a.address);
        if (addr && !internal.has(addr)) addresses.add(addr);
      }
    }
    const matched = new Set<string>();
    const match = await this.bridge.matchEmails([...addresses]);
    if (match.ok) {
      for (const m of match.data.matches) matched.add(m.attendeeEmail.toLowerCase());
      for (const c of match.data.committeeStaff) matched.add(c.attendeeEmail.toLowerCase());
      sources.push({ source: 'directory', status: 'ok', detail: `${matched.size} of ${addresses.size} addresses matched` });
    } else {
      sources.push({
        source: 'directory',
        status: 'unavailable',
        detail: `${match.detail}; only events tagged to ${client.name} can surface.`,
      });
    }
    const events = classifyEvents(candidates, clientId, client.name, matched, internal, timeZone);
    const upcoming = await this.source.upcomingEventAt(tenantId, clientId, new Date()).catch(() => null);
    return {
      clientId,
      from: from.toISOString(),
      to: to.toISOString(),
      timeZone,
      events,
      upcomingEventAt: upcoming ? upcoming.toISOString() : null,
      sources,
    };
  }

  /** Idempotent: replaces the selection, keeping resolution/context/section for retained events. */
  async setMeetings(tenantId: string, actorId: string, documentId: string, dto: SetMeetingsDto) {
    const doc = await this.assertOwner(tenantId, actorId, documentId);
    const wanted = [...new Set(dto.eventIds.map((id) => id.trim()).filter(Boolean))];
    const userId = await this.source.resolveUserId(actorId).catch(() => null);
    const timeZone = safeTimeZone(dto.timeZone) ?? doc.timeZone ?? DEFAULT_TZ;
    const rows = wanted.length ? await this.source.eventsByIds(tenantId, userId, wanted) : [];
    const internal = await this.internalAddresses(tenantId, doc.clientId);
    const addresses = new Set<string>();
    for (const r of rows) {
      for (const a of r.attendees ?? []) {
        const addr = normalizeAddress(a.address);
        if (addr && !internal.has(addr)) addresses.add(addr);
      }
    }
    const matched = new Set<string>();
    const match = await this.bridge.matchEmails([...addresses]);
    if (match.ok) {
      for (const m of match.data.matches) matched.add(m.attendeeEmail.toLowerCase());
      for (const c of match.data.committeeStaff) matched.add(c.attendeeEmail.toLowerCase());
    }
    // When the Directory is down, keep every visible event the user chose rather
    // than silently dropping "matched-only" ones: the reason says why.
    const events = classifyEvents(rows, doc.clientId, doc.clientName, matched, internal, timeZone);
    const byId = new Map(events.map((e) => [e.eventId, e]));
    for (const r of rows) {
      if (!byId.has(r.id) && (!r.clientId || r.clientId === doc.clientId)) {
        const fallback = classifyEvents([{ ...r, clientId: doc.clientId }], doc.clientId, doc.clientName, matched, internal, timeZone)[0];
        if (fallback) {
          byId.set(r.id, {
            ...fallback,
            clientId: r.clientId,
            reason: match.ok
              ? { kind: 'tagged', detail: 'Selected by you.', matchedAddresses: [] }
              : { kind: 'tagged', detail: `Selected by you; Directory unavailable (${match.detail}).`, matchedAddresses: [] },
          });
        }
      }
    }
    const selected = wanted.map((id) => byId.get(id)).filter((e): e is CalendarEvent => Boolean(e));
    const skipped = wanted.filter((id) => !byId.has(id));
    selected.sort((a, b) => a.startsAt.localeCompare(b.startsAt));

    const existing = await this.prisma.wsHillDayMeeting.findMany({ where: { tenantId, documentId } });
    const keep = new Set(selected.map((e) => e.eventId));
    await this.prisma.$transaction(async (tx) => {
      // Meetings added directly from the Directory (step 3's Directory tab)
      // have a synthetic eventId that is never in `keep` — this replace-by-
      // eventIds logic only governs calendar-backed rows, so manual rows are
      // excluded from deletion here and are not touched by the ordinal
      // reassignment below either (only `selected`, the calendar rows, are).
      const remove = existing
        .filter((m) => !keep.has(m.eventId) && (m.event as unknown as CalendarEvent).source !== 'manual')
        .map((m) => m.id);
      if (remove.length) await tx.wsHillDayMeeting.deleteMany({ where: { id: { in: remove } } });
      for (const [ordinal, ev] of selected.entries()) {
        const current = existing.find((m) => m.eventId === ev.eventId);
        if (current) {
          await tx.wsHillDayMeeting.update({ where: { id: current.id }, data: { ordinal, event: ev as never } });
        } else {
          await tx.wsHillDayMeeting.create({
            data: { tenantId, documentId, eventId: ev.eventId, ordinal, event: ev as never },
          });
        }
      }
      const first = selected[0];
      const weekStart = dto.weekStart ?? (first ? mondayOf(first.startsAt, timeZone) : null);
      await tx.wsHillDayDocument.update({
        where: { id: documentId },
        data: {
          timeZone,
          ...(weekStart ? { weekStart: new Date(`${weekStart}T00:00:00Z`) } : {}),
          // Changing the selection invalidates a previous roll-up until resolution re-runs.
          resolutionStatus: remove.length || selected.some((e) => !existing.some((m) => m.eventId === e.eventId)) ? null : doc.resolutionStatus,
        },
      });
    });
    const meetings = (await this.prisma.wsHillDayMeeting.findMany({
      where: { tenantId, documentId },
      orderBy: { ordinal: 'asc' },
    })) as MeetingRow[];
    return {
      documentId,
      meetings: meetings.map((m) => ({
        meetingId: m.id,
        eventId: m.eventId,
        ordinal: m.ordinal,
        event: m.event as CalendarEvent,
        resolved: Boolean(m.resolution),
      })),
      skipped,
      sources: [
        match.ok
          ? { source: 'directory', status: 'ok', detail: null }
          : { source: 'directory', status: 'unavailable', detail: match.detail },
      ] as SourceStatusBlock[],
    };
  }

  // ── Assembled document ────────────────────────────────────────────────────

  async get(tenantId: string, documentId: string): Promise<HillDayDocumentView> {
    const doc = await this.assertDoc(tenantId, documentId);
    const meetings = (await this.prisma.wsHillDayMeeting.findMany({
      where: { tenantId, documentId },
      orderBy: { ordinal: 'asc' },
    })) as MeetingRow[];
    const [firmName, owners, client, lastJob] = await Promise.all([
      this.source.tenantName(tenantId).catch(() => null),
      this.source.userDisplays([doc.ownerId]).catch(() => new Map()),
      this.source.getClient(tenantId, null, doc.clientId).catch(() => null),
      this.prisma.wsHillDayJob.findFirst({ where: { tenantId, documentId }, orderBy: { createdAt: 'desc' } }),
    ]);
    const owner = owners.get(doc.ownerId) ?? { name: 'Unknown', initials: '?' };
    const tz = doc.timeZone || DEFAULT_TZ;

    const sections: DocumentSectionView[] = meetings.map((m, i) => this.sectionView(m, i + 1, tz));
    const summary: SummaryRow[] = sections.map((s) => {
      const m = meetings.find((row) => row.id === s.meetingId)!;
      const res = m.resolution as MeetingResolution | null;
      const lead =
        res?.attendees.find((a) => a.state === 'resolved' && a.stafferId && !a.committee) ??
        res?.attendees.find((a) => a.state === 'resolved' && a.name) ??
        null;
      return {
        sectionId: s.sectionId,
        meetingId: s.meetingId,
        time: s.time,
        member: s.member,
        office: res?.office.member ? partyLine(res.office) : '',
        room: res?.office.room ?? (m.event as CalendarEvent).location ?? '',
        minutes: s.duration.replace(/\s*min$/, ''),
        staffLead: lead?.name ?? 'To be confirmed',
      };
    });

    const hillDate = this.hillDayDate(meetings, tz);
    const anyEdited = sections.some((s) => s.edited.focus || s.edited.background);
    const provenance = this.provenanceView(doc, meetings, lastJob);
    const dateline = [
      hillDate ?? 'Dates to be confirmed',
      `${sections.length} congressional meeting${sections.length === 1 ? '' : 's'}`,
      `prepared for ${doc.clientName}${firmName ? ` by ${firmName}` : ''}`,
    ].join(' · ');

    return {
      id: doc.id,
      name: doc.name,
      status: doc.status as HillDayDocumentView['status'],
      blueprint: { slug: HILL_DAY_BLUEPRINT_SLUG, name: HILL_DAY_BLUEPRINT_NAME },
      client: { id: doc.clientId, name: doc.clientName, mono: initialsOf(doc.clientName), hasLogo: client?.hasLogo ?? false },
      firm: { name: firmName ?? 'Your firm' },
      owner: { id: doc.ownerId, name: owner.name, initials: owner.initials },
      lookbackDays: doc.lookbackDays,
      timeZone: tz,
      weekStart: doc.weekStart ? doc.weekStart.toISOString().slice(0, 10) : null,
      resolutionStatus: (doc.resolutionStatus as 'clean' | 'partial' | null) ?? null,
      cover: {
        title: HILL_DAY_BLUEPRINT_NAME,
        dateline,
        facts: [
          { k: 'Sponsor', v: doc.clientName },
          { k: 'Prepared by', v: firmName ?? 'Your firm' },
          { k: 'Meetings', v: String(sections.length) },
          { k: 'Date', v: hillDate ?? 'To be confirmed' },
          { k: 'Lead', v: owner.name },
          { k: 'Revision', v: anyEdited ? '2 · edited' : '1 · as generated' },
        ],
      },
      summary,
      sections,
      provenance,
      generation: { lastJobId: lastJob?.id ?? null, status: lastJob?.status ?? null },
      meetingCount: meetings.length,
      updatedAt: doc.updatedAt.toISOString(),
      createdAt: doc.createdAt.toISOString(),
    };
  }

  async quality(tenantId: string, documentId: string): Promise<QualityResponse> {
    const doc = await this.assertDoc(tenantId, documentId);
    const meetings = (await this.prisma.wsHillDayMeeting.findMany({
      where: { tenantId, documentId },
      orderBy: { ordinal: 'asc' },
    })) as MeetingRow[];
    const total = meetings.length;
    const resolutions = meetings.map((m) => m.resolution as MeetingResolution | null);
    const sections = meetings.map((m) => m.section as MeetingSection | null);
    const contexts = meetings.map((m) => m.context as MeetingContextRecord | null);
    const sourceSets = meetings.map((m) => m.sourceSet as SourceSet | null);
    const checks: QualityCheck[] = [];

    const withOffice = resolutions.filter((r) => r?.office.memberId).length;
    const confirmedOffices = resolutions.filter((r) => r?.office.derivedFrom === 'user_correction').length;
    checks.push({
      id: 'offices_resolved',
      label: 'Every meeting has a resolved office',
      state: total > 0 && withOffice === total ? 'pass' : 'warn',
      detail: `${withOffice} of ${total}.${confirmedOffices ? ` ${confirmedOffices} confirmed by you.` : ''}${
        withOffice < total ? ' Use “Change office” on the flagged meetings.' : ''
      }`,
    });

    const titled = resolutions.filter(
      (r) => r && r.attendees.length > 0 && r.attendees.every((a) => a.state === 'resolved' && a.role),
    ).length;
    const manualOffices = resolutions
      .filter((r) => r?.attendees.some((a) => a.manual))
      .map((r) => r?.office.memberName ?? 'one office');
    checks.push({
      id: 'attendee_titles',
      label: 'Attendee titles present',
      state: total > 0 && titled === total ? 'pass' : 'warn',
      detail: `${titled} of ${total}.${manualOffices.length ? ` ${manualOffices.join(', ')} attendees added manually.` : ''}`,
    });

    const threadIds = new Set(contexts.flatMap((c) => c?.threadIds ?? []));
    const usedThreads = new Set(sourceSets.flatMap((s) => s?.correspondence.threadIds ?? []));
    const outside = [...threadIds].filter((id) => sourceSets.length && !usedThreads.has(id)).length;
    checks.push({
      id: 'correspondence_window',
      label: 'Correspondence inside window',
      state: outside === 0 ? 'pass' : 'warn',
      detail: threadIds.size
        ? `${usedThreads.size} thread${usedThreads.size === 1 ? '' : 's'} used, all within ${doc.lookbackDays} days.${
            outside ? ` ${outside} selected thread${outside === 1 ? '' : 's'} fell outside the window and were excluded.` : ''
          }`
        : 'No correspondence selected.',
    });

    const objectiveCount = Math.max(0, ...sourceSets.map((s) => s?.objectives.count ?? 0));
    const objectivesStatus = sourceSets.find((s) => s)?.objectives.status ?? null;
    checks.push({
      id: 'objectives_cited',
      label: 'Client objectives available',
      state: objectiveCount > 0 ? 'pass' : 'warn',
      detail:
        objectivesStatus === 'unavailable'
          ? 'Strategies layer unavailable at generation; Focus written from calendar, Directory and your notes only.'
          : objectiveCount
            ? `Focus written against ${objectiveCount} live strateg${objectiveCount === 1 ? 'y' : 'ies'} for ${doc.clientName}.`
            : `No live strategies recorded for ${doc.clientName}.`,
    });

    const unsupported = sections.flatMap((s, i) =>
      (s?.flags ?? []).filter((f) => f.kind === 'unsupported_claim').map(() => i + 1),
    );
    checks.push({
      id: 'unsupported_claims',
      label: 'No unsupported claims',
      state: unsupported.length === 0 ? 'pass' : 'warn',
      detail: unsupported.length
        ? `${unsupported.length} sentence${unsupported.length === 1 ? '' : 's'} flagged for review in Meeting ${[...new Set(unsupported)].join(', ')}.`
        : 'Every sentence the model wrote is grounded in a supplied source.',
    });

    const failed = sections.map((s, i) => (s?.status === 'unavailable' ? i + 1 : null)).filter((n): n is number => n !== null);
    const pending = sections.filter((s) => !s || s.status === 'pending').length;
    checks.push({
      id: 'generation_complete',
      label: 'Every section drafted',
      state: failed.length === 0 && pending === 0 && total > 0 ? 'pass' : 'warn',
      detail: failed.length
        ? `Meeting ${failed.join(', ')} unavailable (${sections
            .filter((s) => s?.status === 'unavailable')
            .map((s) => s?.reason)
            .filter(Boolean)
            .join('; ')}). Regenerate from the editor.`
        : pending
          ? `${pending} section${pending === 1 ? '' : 's'} not generated yet.`
          : 'Focus and Background drafted for every meeting.',
    });

    const unconfirmed = resolutions
      .map((r, i) => (r?.needsConfirmation ? r.office.memberName ?? `Meeting ${i + 1}` : null))
      .filter((n): n is string => Boolean(n));
    checks.push({
      id: 'attendees_confirmed',
      label: 'Attendees confirmed',
      state: unconfirmed.length === 0 ? 'pass' : 'warn',
      // No single parenthetical cause fits here — the meetings behind
      // `unconfirmed` can be a mix of scheduler-only invites and meetings
      // added manually with no invite at all, so the reason is left to each
      // meeting's own card rather than asserted for all of them at once.
      detail: unconfirmed.length
        ? `Confirm who attends for ${unconfirmed.join(', ')} before delivery.`
        : 'Every meeting has at least one substantive attendee.',
    });

    const passed = checks.filter((c) => c.state === 'pass').length;
    return {
      documentId,
      score: checks.length ? Number((passed / checks.length).toFixed(2)) : 0,
      checks,
      computedAt: new Date().toISOString(),
    };
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  async assertDoc(tenantId: string, documentId: string) {
    const doc = await this.prisma.wsHillDayDocument.findFirst({ where: { id: documentId, tenantId } });
    if (!doc) throw new NotFoundException('Document not found');
    return doc;
  }

  async assertOwner(tenantId: string, actorId: string, documentId: string) {
    const doc = await this.assertDoc(tenantId, documentId);
    if (doc.ownerId !== actorId) throw new ForbiddenException('Only the document owner can change it');
    return doc;
  }

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

  private sectionView(m: MeetingRow, number: number, tz: string): DocumentSectionView {
    const event = m.event as CalendarEvent;
    const res = m.resolution as MeetingResolution | null;
    const section = (m.section as MeetingSection | null) ?? null;
    const when = formatWhen(event.startsAt, tz);
    const office = res?.office ?? null;
    const member = office?.member ?? (office?.derivedFrom === 'committee_staff_association' ? office.memberName ?? event.subject : event.subject);
    const party = office?.member ? partyLine(office) : '';
    const room = office?.room ?? event.location ?? '';
    const attendees = (res?.attendees ?? []).map((a) => ({
      name: a.name ?? a.address ?? 'Attendee',
      role: a.role,
      state: a.state,
    }));
    return {
      sectionId: m.id,
      meetingId: m.id,
      eventId: m.eventId,
      number,
      time: when.time,
      duration: durationLabel(event.startsAt, event.endsAt),
      member,
      subline: [party, room].filter(Boolean).join(' · '),
      facts: [
        { k: 'Office', v: room || 'To be confirmed' },
        { k: 'Attendees', v: attendees.length ? attendees.map((a) => a.name).join(', ') : 'To be confirmed' },
        { k: 'Committees', v: office?.committees.length ? office.committees.join(' · ') : 'Not available' },
        { k: 'Party · state', v: party || 'Not resolved' },
      ],
      focus: section?.focus ?? null,
      background: section?.background ?? null,
      status: section?.status ?? 'pending',
      reason: section?.reason ?? null,
      flags: section?.flags ?? [],
      edited: section?.edited ?? { focus: false, background: false, at: null },
      attendees,
    };
  }

  private hillDayDate(meetings: MeetingRow[], tz: string): string | null {
    const counts = new Map<string, number>();
    for (const m of meetings) {
      const ev = m.event as CalendarEvent;
      if (ev.kind !== 'hill') continue;
      const day = localDate(ev.startsAt, tz);
      counts.set(day, (counts.get(day) ?? 0) + 1);
    }
    if (!counts.size) {
      const first = meetings[0]?.event as CalendarEvent | undefined;
      return first ? formatWhen(first.startsAt, tz).date : null;
    }
    const [day] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
    return formatWhen(`${day}T12:00:00Z`, 'UTC').date;
  }

  private provenanceView(
    doc: { provenance: unknown; generatedAt: Date | null; clientName: string },
    meetings: MeetingRow[],
    lastJob: { quality: number | null } | null,
  ): ProvenanceView {
    const sets = meetings.map((m) => m.sourceSet as SourceSet | null).filter((s): s is SourceSet => Boolean(s));
    const sections = meetings.map((m) => m.section as MeetingSection | null);
    const stafferIds = new Set<string>();
    const memberIds = new Set<string>();
    const threadIds = new Set<string>();
    let notes = 0;
    let prior = 0;
    let objectives = 0;
    for (const s of sets) {
      for (const id of s.directory.staffers) stafferIds.add(id);
      if (s.directory.memberId) memberIds.add(s.directory.memberId);
      for (const id of s.correspondence.threadIds) threadIds.add(id);
      if (s.note.included) notes += 1;
      prior += s.priorEngagement.count;
      objectives = Math.max(objectives, s.objectives.count);
    }
    const directoryRecords = stafferIds.size + memberIds.size;
    const sourceCounts: ProvenanceView['sourceCounts'] = [
      { id: 'directory', label: 'Directory', count: directoryRecords, detail: `${directoryRecords} record${directoryRecords === 1 ? '' : 's'}` },
      { id: 'calendar', label: 'Calendar', count: meetings.length, detail: `${meetings.length} event${meetings.length === 1 ? '' : 's'}` },
      { id: 'objectives', label: `Portfolio · ${doc.clientName}`, count: objectives, detail: `${objectives} live strateg${objectives === 1 ? 'y' : 'ies'}` },
      { id: 'correspondence', label: 'Correspondence', count: threadIds.size, detail: `${threadIds.size} thread${threadIds.size === 1 ? '' : 's'}` },
      { id: 'prior', label: 'Prior engagement', count: prior, detail: `${prior} meeting${prior === 1 ? '' : 's'}` },
      { id: 'notes', label: 'Your context', count: notes, detail: `${notes} note${notes === 1 ? '' : 's'}` },
    ];
    const corrections: string[] = [];
    for (const m of meetings) {
      const res = m.resolution as MeetingResolution | null;
      if (!res) continue;
      if (res.office.derivedFrom === 'user_correction') {
        corrections.push(`Office set to ${res.office.member ?? 'unknown'} by you`);
      }
      for (const a of res.attendees) {
        if (a.correction) corrections.push(`${a.name ?? a.address ?? 'Attendee'}: ${a.correction.detail ?? a.correction.kind}`);
      }
    }
    const prov = (doc.provenance as { model?: string | null } | null) ?? null;
    return {
      generatedAt: doc.generatedAt ? doc.generatedAt.toISOString() : null,
      model: prov?.model ?? sections.find((s) => s?.model)?.model ?? null,
      sourceCounts,
      corrections,
      failedUnits: sections.filter((s) => s?.status === 'unavailable').length,
      quality: lastJob?.quality ?? null,
      totalSources: sourceCounts.reduce((n, s) => n + s.count, 0),
    };
  }
}

function safeTimeZone(tz: string | undefined): string | null {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}
