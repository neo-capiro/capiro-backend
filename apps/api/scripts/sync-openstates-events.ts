/**
 * OpenStates event corroboration for Florida committee proceedings.
 *
 * First-party House/Senate calendars remain authoritative. OpenStates fills
 * source-backed gaps they do not consistently expose in one payload: stable
 * committee organization IDs, agenda entities, official video/audio links,
 * notices, expanded agendas, attendance documents, and participants. Its
 * source priority is deliberately lower than the chamber adapters, so this
 * job can enrich a canonical hearing but cannot regress a first-party fact.
 *
 *   OPENSTATES_EVENTS_STATES=FL pnpm --filter @capiro/api sync:openstates-events
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient, type Prisma } from '@prisma/client';
import { fetchAllPages } from './sync-openstates.js';
import { runWithSyncRun } from '../src/ingestion/sync-run.helper.js';
import { CommitteeSourceRepository } from '../src/hearing-discovery/committee-source.repository.js';
import { HearingReconcilerService } from '../src/hearing-discovery/hearing-reconciler.service.js';
import { StreamCandidateRepository } from '../src/hearing-discovery/stream-candidate.repository.js';
import { findFloridaCanonicalBySharedEntry } from '../src/hearing-discovery/florida-crosswalk.js';
import {
  publicSourceUrl,
  type AgendaItem,
  type CalendarDocument,
  type LegislativeObservation,
} from '../src/hearing-discovery/legislative-calendar.js';
import { contentHash } from '../src/hearing-discovery/hearing-identity.js';
import { floridaBillNumberAliases } from '../src/hearing-discovery/adapters/florida-calendar.adapter.js';
import { lockFloridaOpenstatesEventWriter } from '../src/hearing-discovery/florida-openstates-concurrency.js';

dotenvConfig();

const PARSER_VERSION = 'openstates-events-v2';
const SOURCE_URL = 'https://v3.openstates.org/events';
const EVENT_INCLUDES = ['links', 'sources', 'media', 'documents', 'participants', 'agenda'];
const MAX_EVENT_PAGES = 25;
const UNMAPPED_COMMITTEE_ISSUE =
  'OpenStates committee organization is not yet crosswalked to a canonical state committee.';
const CONFLICTING_COMMITTEE_ISSUE =
  'OpenStates organization and Florida publisher committee evidence conflict; no committee profile was asserted.';
const AMBIGUOUS_PUBLISHER_COMMITTEE_ISSUE =
  'Florida publisher URLs identify multiple committees; no committee profile was asserted.';

export type OpenstatesEventLink = { url?: string; note?: string | null };
export type OpenstatesEventMedia = {
  note?: string;
  date?: string;
  offset?: number;
  classification?: string;
  links?: OpenstatesEventLink[];
};
export type OpenstatesEventDocument = {
  note?: string;
  date?: string;
  classification?: string;
  links?: OpenstatesEventLink[];
};
export type OpenstatesEventParticipant = {
  note?: string;
  name?: string;
  entity_type?: string;
  organization?: { id?: string; name?: string; classification?: string };
  person?: { id?: string; name?: string };
};
export type OpenstatesEventAgendaItem = {
  description?: string;
  classification?: string[];
  order?: number;
  subjects?: string[];
  notes?: string[];
  extras?: Record<string, unknown>;
  related_entities?: Array<{
    entity_type?: string;
    name?: string;
    bill?: unknown;
    person?: unknown;
    organization?: unknown;
  }>;
  media?: OpenstatesEventMedia[];
};
export type OpenstatesEvent = {
  id: string;
  name: string;
  jurisdiction?: { id?: string; name?: string; classification?: string };
  description?: string;
  classification?: string;
  start_date: string;
  end_date?: string;
  all_day?: boolean;
  status?: string;
  upstream_id?: string;
  deleted?: boolean;
  location?: { name?: string; url?: string };
  links?: OpenstatesEventLink[];
  sources?: OpenstatesEventLink[];
  media?: OpenstatesEventMedia[];
  documents?: OpenstatesEventDocument[];
  participants?: OpenstatesEventParticipant[];
  agenda?: OpenstatesEventAgendaItem[];
};

const REVIEWED_JLBC_OPENSTATES_EVENT_ID = 'ocd-event/a02f8006-d61c-436b-bd3b-e5080dad8f67';
const REVIEWED_JLBC_MONTH_SOURCE =
  'https://www.flhouse.gov/Sections/HouseCalendar/finalizedmeetingnotice.aspx?mode=month';
const REVIEWED_JLBC_OFFICIAL_IDENTITY = 'fl:joint:lbc:notice:6914-15223';
const REVIEWED_JLBC_SESSION_ISSUE =
  'Joint notice publisher session conflict: House 2026, Senate 2027. Canonical session remains unknown.';

type ReviewedFloridaEventProjection = {
  officialIdentity: string;
  session: null;
  chamber: 'joint';
  bodySourceKey: string;
  bodyName: string;
  stateCommitteeId: null;
  eventType: 'joint';
};

/**
 * One reviewed OpenStates row is the same proceeding as the two first-party
 * JLBC notices. This is deliberately an assertion bundle, not a general
 * title/time matcher: every stable publisher fact must still agree or the row
 * remains in the provider identity namespace.
 */
function reviewedJlbcProjection(event: OpenstatesEvent): ReviewedFloridaEventProjection | null {
  const organizationParticipants = (event.participants ?? []).filter((participant) =>
    participant.organization?.id?.trim(),
  );
  const participant = organizationParticipants[0];
  const sourceUrls = (event.sources ?? [])
    .map((source) => source.url?.trim())
    .filter((url): url is string => Boolean(url));
  const exactSource = sourceUrls.length === 1 && sourceUrls[0] === REVIEWED_JLBC_MONTH_SOURCE;
  if (
    event.id !== REVIEWED_JLBC_OPENSTATES_EVENT_ID ||
    event.name !== 'Joint Legislative Budget Commission' ||
    event.jurisdiction?.id !== 'ocd-jurisdiction/country:us/state:fl/government' ||
    event.jurisdiction?.name !== 'Florida' ||
    event.jurisdiction?.classification !== 'state' ||
    event.classification !== 'event' ||
    event.status !== 'tentative' ||
    event.deleted !== false ||
    event.start_date !== '2026-09-11T11:00:00-04:00' ||
    event.end_date !== '2026-09-11T14:00:00-04:00' ||
    event.all_day !== false ||
    event.location?.name?.trim() !== '110 SOB' ||
    !exactSource ||
    organizationParticipants.length !== 1 ||
    participant?.entity_type !== 'organization' ||
    participant.name !== 'Joint Legislative Budget Commission' ||
    participant.organization?.id !== 'ocd-organization/e779cf08-9f72-4663-a9e0-ad306359310a' ||
    participant.organization.name !== 'Legislative Budget Commission' ||
    participant.organization.classification !== 'committee'
  )
    return null;
  return {
    officialIdentity: REVIEWED_JLBC_OFFICIAL_IDENTITY,
    session: null,
    chamber: 'joint',
    bodySourceKey: 'fl:joint:lbc',
    bodyName: 'Joint Legislative Budget Commission',
    stateCommitteeId: null,
    eventType: 'joint',
  };
}

type CommitteeCrosswalk = {
  stateCommitteeId: string;
  name: string;
  chamber: 'house' | 'senate' | 'joint' | null;
  session: string | null;
  /** First-party Florida calendar identity when the directory crosswalk proves
   * one; otherwise a provider-scoped identity that cannot collide with it. */
  bodySourceKey: string;
};

function sessionIdentity(session: string, identity: string): string {
  return `${session}\u0000${identity}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function openstatesCommitteeIdentity(sourceEvidence: unknown): string | null {
  const root = record(sourceEvidence);
  const openstates = record(root?.openstates);
  const value = openstates?.committeeId;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function firstPublicUrl(...groups: Array<OpenstatesEventLink[] | undefined>): string | null {
  for (const group of groups) {
    for (const link of group ?? []) {
      if (link.url && publicSourceUrl(link.url)) return link.url;
    }
  }
  return null;
}

function eventSourceUrl(event: OpenstatesEvent): string {
  return (
    firstPublicUrl(event.sources, event.links) ??
    `https://v3.openstates.org/events/${encodeURIComponent(event.id)}`
  );
}

function eventUrls(event: OpenstatesEvent): string[] {
  return [
    ...(event.sources ?? []),
    ...(event.links ?? []),
    ...(event.documents ?? []).flatMap((document) => document.links ?? []),
  ].flatMap((link) => (link.url ? [link.url] : []));
}

/** Resolve a committee body (not an event) from exact Florida publisher URLs.
 * Senate notice numbers in OpenStates documents are demonstrably stale and
 * reused across distinct meetings, but the `/Committees/Show/<CODE>/` segment
 * remains stable committee evidence. Every qualifying URL must agree. */
export function floridaOfficialCommitteeEvidenceFromEvent(event: OpenstatesEvent): {
  key: string | null;
  ambiguous: boolean;
} {
  const identities = new Set<string>();
  for (const raw of eventUrls(event)) {
    try {
      const url = new URL(raw);
      const host = url.hostname.toLowerCase();
      if (host === 'flsenate.gov' || host === 'www.flsenate.gov') {
        const match = /\/Committees\/Show\/([^/]+)(?:\/|$)/i.exec(url.pathname);
        if (match?.[1]) identities.add(`fl:senate:${decodeURIComponent(match[1]).toUpperCase()}`);
      }
    } catch {
      // Malformed provider links prove nothing and cannot become identity.
    }
  }
  return {
    key: identities.size === 1 ? [...identities][0]! : null,
    ambiguous: identities.size > 1,
  };
}

export function floridaOfficialCommitteeKeyFromEvent(event: OpenstatesEvent): string | null {
  return floridaOfficialCommitteeEvidenceFromEvent(event).key;
}

function providerStatus(event: OpenstatesEvent): LegislativeObservation['fields']['status'] {
  const status = (event.status ?? '').toLowerCase();
  if (event.deleted || /cancel/.test(status)) return 'canceled';
  if (/complete|passed|finished/.test(status)) return 'completed';
  if (/progress|live/.test(status)) return 'in_progress';
  if (/postpon/.test(status)) return 'postponed';
  return 'scheduled';
}

function providerChamber(value: string | null | undefined): 'house' | 'senate' | 'joint' | null {
  const normalized = (value ?? '').toLowerCase();
  if (/\bjoint\b|\bconference\b/.test(normalized)) return 'joint';
  if (/\bhouse\b|\blower\b/.test(normalized)) return 'house';
  if (/\bsenate\b|\bupper\b/.test(normalized)) return 'senate';
  return null;
}

function organizationParticipants(event: OpenstatesEvent) {
  const seen = new Set<string>();
  return (event.participants ?? []).flatMap((participant) => {
    const id = participant.organization?.id?.trim();
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [
      {
        id,
        name: participant.organization?.name?.trim() || participant.name?.trim() || event.name,
      },
    ];
  });
}

function documentRows(event: OpenstatesEvent, sourceUrl: string): CalendarDocument[] {
  const rows: CalendarDocument[] = [];
  const seen = new Set<string>();
  const add = (
    link: OpenstatesEventLink,
    fallbackTitle: string,
    kind: string,
    publishedAt: string | null = null,
  ) => {
    if (!link.url || !publicSourceUrl(link.url) || seen.has(link.url)) return;
    seen.add(link.url);
    rows.push({
      key: link.url,
      title: link.note?.trim() || fallbackTitle,
      url: link.url,
      kind,
      publishedAt,
    });
  };
  for (const link of event.links ?? []) add(link, 'OpenStates event link', 'event_link');
  for (const link of event.sources ?? []) add(link, 'Published event source', 'source');
  for (const document of event.documents ?? [])
    for (const link of document.links ?? [])
      add(
        link,
        document.note?.trim() || 'Published meeting document',
        document.classification?.trim() || 'document',
        document.date && Number.isFinite(Date.parse(document.date))
          ? new Date(document.date).toISOString()
          : null,
      );
  for (const media of event.media ?? [])
    for (const link of media.links ?? [])
      add(
        link,
        media.note?.trim() || 'Published meeting media',
        media.classification?.trim() || 'media',
        media.date && Number.isFinite(Date.parse(media.date))
          ? new Date(media.date).toISOString()
          : null,
      );
  if (!rows.length)
    rows.push({
      key: sourceUrl,
      title: 'OpenStates event record',
      url: sourceUrl,
      kind: 'source',
      publishedAt: null,
    });
  return rows;
}

function eventWatchUrl(event: OpenstatesEvent): string | null {
  for (const media of event.media ?? []) {
    if (!/video|livestream|broadcast/i.test(`${media.classification ?? ''} ${media.note ?? ''}`))
      continue;
    const url = firstPublicUrl(media.links);
    if (url) return url;
  }
  return null;
}

function billLabel(entity: NonNullable<OpenstatesEventAgendaItem['related_entities']>[number]) {
  const bill = record(entity.bill);
  for (const value of [bill?.identifier, bill?.bill_number, entity.name])
    if (
      typeof value === 'string' &&
      /\b(?:HB|SB|PCB|SPB|HJR|SJR|HM|SM|HCR|SCR|HR|SR)\s*\d+/i.test(value)
    )
      return value;
  return null;
}

function agendaRows(
  event: OpenstatesEvent,
  sourceUrl: string,
  bills: Map<string, { id: string; sessionKey: string }>,
  session: string,
): AgendaItem[] {
  return (event.agenda ?? []).map((item, index) => {
    const labels = (item.related_entities ?? [])
      .map(billLabel)
      .filter((v): v is string => Boolean(v));
    const resolved = labels
      .flatMap((label) => floridaBillNumberAliases(label))
      .map((alias) => bills.get(alias.toUpperCase().replace(/\s+/g, '')))
      .find((bill) => bill?.sessionKey === session);
    const title = item.description?.trim() || labels[0] || `Agenda item ${index + 1}`;
    return {
      key: `openstates:${contentHash([event.id, item.order ?? index, title]).slice(0, 24)}`,
      position:
        Number.isInteger(item.order) && Number(item.order) >= 0 ? Number(item.order) : index,
      kind: resolved ? 'bill' : labels.length ? 'unresolved_bill' : 'other',
      title,
      ...(resolved
        ? {
            bill: {
              scope: 'state' as const,
              id: resolved.id,
              jurisdiction: 'FL',
              session: resolved.sessionKey,
            },
          }
        : {}),
      sourceUrl,
      evidence: {
        provider: 'openstates',
        classifications: item.classification ?? [],
        subjects: item.subjects ?? [],
        notes: item.notes ?? [],
        relatedBillLabels: labels,
        extras: item.extras ?? {},
      },
    };
  });
}

export function openstatesEventObservation(
  event: OpenstatesEvent,
  committees: Map<string, CommitteeCrosswalk>,
  bills: Map<string, { id: string; sessionKey: string }>,
  officialCommittees: Map<string, CommitteeCrosswalk> = new Map(),
): LegislativeObservation | null {
  if (!event.id?.trim() || !event.name?.trim() || !Number.isFinite(Date.parse(event.start_date)))
    return null;
  const eventSession = event.start_date.slice(0, 4);
  const organizations = organizationParticipants(event);
  const linked = organizations
    .map((org) => committees.get(sessionIdentity(eventSession, org.id)))
    .filter(Boolean) as CommitteeCrosswalk[];
  const publisherEvidence = floridaOfficialCommitteeEvidenceFromEvent(event);
  const publisherCommittee = officialCommittees.get(
    sessionIdentity(eventSession, publisherEvidence.key ?? ''),
  );
  const reviewedProjection = reviewedJlbcProjection(event);
  // A lone successful lookup among multiple participant organizations is not
  // proof that the others refer to the same body. Multi-body events remain
  // unresolved rather than inheriting whichever organization happened to map.
  const linkedCommittee = organizations.length === 1 && linked.length === 1 ? linked[0]! : null;
  const conflictingCommitteeEvidence = Boolean(
    publisherEvidence.ambiguous ||
    (linkedCommittee &&
      publisherCommittee &&
      linkedCommittee.stateCommitteeId !== publisherCommittee.stateCommitteeId),
  );
  const exactCommittee = conflictingCommitteeEvidence
    ? null
    : linkedCommittee
      ? linkedCommittee
      : linked.length === 0 && organizations.length <= 1
        ? (publisherCommittee ?? null)
        : null;
  const chamber =
    reviewedProjection?.chamber ??
    exactCommittee?.chamber ??
    providerChamber(organizations.map((org) => org.name).join(' ')) ??
    providerChamber(event.name);
  if (!chamber) return null;
  const start = new Date(event.start_date);
  const end =
    event.end_date && Number.isFinite(Date.parse(event.end_date)) ? new Date(event.end_date) : null;
  const allDay = Boolean(event.all_day);
  const sourceUrl = eventSourceUrl(event);
  const watchUrl = eventWatchUrl(event);
  // The event window normally owns the session. The single reviewed joint
  // crosswalk above intentionally preserves the first-party session-null
  // posture because its House and Senate notices conflict.
  const session = reviewedProjection ? reviewedProjection.session : eventSession;
  const bodyIdentity = organizations.length
    ? organizations
        .map((org) => org.id)
        .sort()
        .join('|')
    : `event:${event.id}`;
  const issues: string[] = [];
  if (organizations.length > 1)
    issues.push(
      'Multiple committee organizations were published; no single committee profile was asserted.',
    );
  if (publisherEvidence.ambiguous) issues.push(AMBIGUOUS_PUBLISHER_COMMITTEE_ISSUE);
  else if (conflictingCommitteeEvidence) issues.push(CONFLICTING_COMMITTEE_ISSUE);
  if (organizations.length && !exactCommittee && !reviewedProjection)
    issues.push(UNMAPPED_COMMITTEE_ISSUE);
  if (reviewedProjection) issues.push(REVIEWED_JLBC_SESSION_ISSUE);
  if (event.deleted) issues.push('OpenStates marks this event record deleted.');

  return {
    jurisdiction: 'FL',
    session,
    chamber,
    // The supplier event id is the default stable identity OpenStates owns.
    // Never key a proceeding from its Senate MeetingNotice documents: live
    // payloads reuse those stale URLs across several real meeting dates. The
    // one reviewed assertion bundle above is the only explicit exception.
    officialIdentity: reviewedProjection?.officialIdentity ?? `openstates:event:${event.id}`,
    // An OpenStates organization is stable provider evidence, but until it is
    // crosswalked it is not a canonical committee body. Mark it explicitly as
    // unresolved so a later exact roster crosswalk may refine the same
    // first-party meeting instead of conflicting with this provisional key.
    bodySourceKey:
      reviewedProjection?.bodySourceKey ??
      exactCommittee?.bodySourceKey ??
      `unresolved-body:openstates:${bodyIdentity}`,
    bodyName:
      reviewedProjection?.bodyName ?? exactCommittee?.name ?? organizations[0]?.name ?? event.name,
    stateCommitteeId: reviewedProjection
      ? reviewedProjection.stateCommitteeId
      : (exactCommittee?.stateCommitteeId ?? null),
    eventType:
      reviewedProjection?.eventType ??
      (organizations.length > 1 || chamber === 'joint' ? 'joint' : 'committee'),
    sourceUrl,
    publishedAt: null,
    fields: {
      title: event.name,
      status: providerStatus(event),
      time: {
        date: event.start_date.slice(0, 10),
        rawTime: allDay ? null : event.start_date,
        timezone: 'America/New_York',
        precision: allDay ? 'date' : 'instant',
        startsAt: allDay ? null : start.toISOString(),
        endsAt: !allDay && end && end > start ? end.toISOString() : null,
      },
      location: event.location?.name?.trim() || null,
      // The reviewed joint row intentionally carries session=null because its
      // two publishers conflict. Do not attach a session-qualified bill to a
      // session-unknown observation if OpenStates later adds agenda rows.
      agenda: agendaRows(event, sourceUrl, bills, session ?? ''),
      documents: documentRows(event, sourceUrl),
      watchUrl,
    },
    completeFields: [
      'title',
      'time',
      ...(event.status || event.deleted ? (['status'] as const) : []),
      ...(event.location ? (['location'] as const) : []),
      ...(Array.isArray(event.agenda) ? (['agenda'] as const) : []),
      ...(event.links || event.sources || event.documents || event.media
        ? (['documents'] as const)
        : []),
      ...(Array.isArray(event.media) ? (['watchUrl'] as const) : []),
    ],
    completeness: issues.length ? 'partial' : 'complete',
    issues,
  };
}

/** The source ledger always retains the raw OpenStates id, even when one exact
 * reviewed event projects a shared first-party official identity. */
export function openstatesProviderEventId(observation: LegislativeObservation): string {
  const providerPrefix = 'openstates:event:';
  if (observation.officialIdentity.startsWith(providerPrefix))
    return observation.officialIdentity.slice(providerPrefix.length);
  if (
    observation.officialIdentity === REVIEWED_JLBC_OFFICIAL_IDENTITY &&
    observation.jurisdiction === 'FL' &&
    observation.session === null &&
    observation.chamber === 'joint' &&
    observation.bodySourceKey === 'fl:joint:lbc'
  )
    return REVIEWED_JLBC_OPENSTATES_EVENT_ID;
  throw new Error('OpenStates observation is missing its raw provider event id');
}

function normalizeChamber(chamber: string | null): CommitteeCrosswalk['chamber'] {
  if (chamber === 'lower' || chamber === 'house') return 'house';
  if (chamber === 'upper' || chamber === 'senate') return 'senate';
  if (chamber === 'joint') return 'joint';
  return null;
}

export function qualifiedCommitteeChamber(
  chamber: string | null,
  bodySourceKey: string,
): Exclude<CommitteeCrosswalk['chamber'], null> | null {
  const normalized = normalizeChamber(chamber);
  if (!normalized) return null;
  const encoded = /^fl:(house|senate|joint):/i.exec(bodySourceKey)?.[1]?.toLowerCase();
  return encoded && encoded !== normalized ? null : normalized;
}

/** Once this provider ledger has linked an event, that durable mapping outranks
 * discovery-time cross-provider attachment. Re-probing can only rediscover the
 * linked hearing plus its official twin and manufacture a false ambiguity; any
 * reviewed alias/relink is a separate, explicit transaction. */
export function shouldProbeFloridaCrossProvider(priorHearingId: string | null | undefined) {
  return !priorHearingId;
}

function directoryAliasIds(sourceEvidence: unknown): string[] {
  const root = record(sourceEvidence);
  const directory = record(root?.directory);
  return Array.isArray(directory?.aliasIds)
    ? directory.aliasIds.filter((id): id is string => typeof id === 'string' && Boolean(id))
    : [];
}

function officialBodySourceKey(officialSourceKey: string | null, session: string | null) {
  if (!officialSourceKey || !session) return null;
  const prefix = `FL:${session}:`;
  return officialSourceKey.startsWith(prefix) ? officialSourceKey.slice(prefix.length) : null;
}

export function legacyOpenstatesEventIdentity(
  sourceMetadata: unknown,
  expectedSession: string,
  expectedLegacyIdentity: string,
): string | null {
  const legislative = record(record(sourceMetadata)?.legislative);
  const bodySourceKey = legislative?.bodySourceKey;
  if (
    legislative?.jurisdiction !== 'FL' ||
    legislative?.chamber !== 'senate' ||
    legislative?.session !== expectedSession ||
    legislative?.stateCommitteeId !== null ||
    legislative?.officialIdentity !== expectedLegacyIdentity ||
    !/^fl:senate:meeting:\d+$/.test(expectedLegacyIdentity) ||
    typeof bodySourceKey !== 'string' ||
    !/^openstates:event:ocd-event\/[0-9a-f-]{36}$/i.test(bodySourceKey)
  )
    return null;
  return bodySourceKey.slice('openstates:event:'.length);
}

export function repairedOpenstatesSourceMetadata(
  sourceMetadata: unknown,
  targetIdentity: string,
): Prisma.InputJsonValue {
  const root = record(sourceMetadata);
  const legislative = record(root?.legislative);
  if (!root || !legislative || !/^ocd-event\/[0-9a-f-]{36}$/i.test(targetIdentity))
    throw new Error('Legacy OpenStates metadata repair is not qualified');
  return JSON.parse(
    JSON.stringify({
      ...root,
      legislative: {
        ...legislative,
        officialIdentity: `openstates:event:${targetIdentity}`,
      },
    }),
  ) as Prisma.InputJsonValue;
}

async function repairLegacyOpenstatesEventIdentities(
  prisma: PrismaClient,
  sourceId: string,
  currentIdentities: Set<string>,
  session: string,
  log: (message: string) => void,
): Promise<number> {
  const rows = await prisma.hearingSourceObservation.findMany({
    where: { sourceId, externalEventId: { startsWith: 'fl:senate:meeting:' } },
    select: {
      id: true,
      hearingId: true,
      externalEventId: true,
      sourceMetadata: true,
    },
  });
  if (!rows.length) return 0;

  const plans: Array<{
    id: string;
    hearingId: string;
    previousIdentity: string;
    targetIdentity: string;
    sourceMetadata: Prisma.InputJsonValue;
  }> = [];
  for (const row of rows) {
    const targetIdentity = legacyOpenstatesEventIdentity(
      row.sourceMetadata,
      session,
      row.externalEventId,
    );
    if (
      !/^fl:senate:meeting:\d+$/.test(row.externalEventId) ||
      !row.hearingId ||
      !targetIdentity ||
      !currentIdentities.has(targetIdentity)
    )
      throw new Error(
        `Legacy OpenStates identity repair is not qualified for ${row.externalEventId}`,
      );

    const [hearing, collision, sourceObservationCount] = await Promise.all([
      prisma.committeeHearing.findUnique({
        where: { id: row.hearingId },
        select: {
          geographicJurisdiction: true,
          legislativeSession: true,
          chamber: true,
          stateCommitteeId: true,
          bodySourceKey: true,
          canonicalHearingId: true,
        },
      }),
      prisma.hearingSourceObservation.findUnique({
        where: { sourceId_externalEventId: { sourceId, externalEventId: targetIdentity } },
        select: { id: true },
      }),
      prisma.hearingSourceObservation.count({ where: { sourceId, hearingId: row.hearingId } }),
    ]);
    if (
      !hearing ||
      hearing.geographicJurisdiction !== 'FL' ||
      hearing.legislativeSession !== session ||
      hearing.chamber !== 'Senate' ||
      hearing.stateCommitteeId !== null ||
      hearing.bodySourceKey !== `openstates:event:${targetIdentity}` ||
      hearing.canonicalHearingId !== null ||
      sourceObservationCount !== 1 ||
      (collision && collision.id !== row.id)
    )
      throw new Error(
        `Legacy OpenStates hearing repair assertions failed for ${row.externalEventId}`,
      );
    plans.push({
      id: row.id,
      hearingId: row.hearingId,
      previousIdentity: row.externalEventId,
      targetIdentity,
      sourceMetadata: repairedOpenstatesSourceMetadata(row.sourceMetadata, targetIdentity),
    });
  }

  await prisma.$transaction(async (tx) => {
    for (const plan of plans) {
      await tx.legislativeObservationRevision.updateMany({
        where: {
          sourceId,
          externalEventId: plan.previousIdentity,
          hearingId: plan.hearingId,
        },
        data: { externalEventId: plan.targetIdentity },
      });
      await tx.hearingSourceObservation.update({
        where: { id: plan.id },
        data: {
          externalEventId: plan.targetIdentity,
          // Remove the stale first-party alias immediately. Keep the old hash
          // so normal reconciliation records a fresh revision of the corrected
          // observation rather than hiding the parser change.
          sourceMetadata: plan.sourceMetadata,
        },
      });
    }
  });
  for (const plan of plans)
    log(
      `SOURCE_IDENTITY_REPAIR ${JSON.stringify({
        source: 'openstates',
        from: plan.previousIdentity,
        to: plan.targetIdentity,
        hearingId: plan.hearingId,
      })}`,
    );
  return plans.length;
}

function statesFromEnv(value: string | undefined): string[] {
  const states = (value ?? 'FL')
    .split(',')
    .map((state) => state.trim().toUpperCase())
    .filter(Boolean);
  if (states.some((state) => state !== 'FL'))
    throw new Error('OpenStates event reconciliation is currently qualified only for FL');
  return [...new Set(states)];
}

function dateWindow() {
  const year = Number(process.env.OPENSTATES_EVENTS_YEAR ?? new Date().getUTCFullYear());
  if (!Number.isInteger(year) || year < 2000 || year > 2100)
    throw new Error('OPENSTATES_EVENTS_YEAR must be a four-digit year');
  const after = process.env.OPENSTATES_EVENTS_AFTER ?? `${year}-01-01`;
  const before = process.env.OPENSTATES_EVENTS_BEFORE ?? `${year}-12-31`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(after) || !/^\d{4}-\d{2}-\d{2}$/.test(before) || after > before)
    throw new Error('OpenStates event window must be valid YYYY-MM-DD bounds');
  return { after, before };
}

export async function syncFloridaOpenstatesEvents(
  prisma: PrismaClient,
  options: { after: string; before: string; log?: (message: string) => void },
) {
  const log = options.log ?? console.log;
  const repo = new CommitteeSourceRepository(prisma);
  const reconciler = new HearingReconcilerService(prisma);
  const source = await repo.ensureSource({
    committeeSystemCode: null,
    chamber: 'joint',
    sourceType: 'COMMITTEE_API',
    sourceUrl: SOURCE_URL,
    adapterKey: 'openstates-florida-events',
    priority: 30,
    parserVersion: PARSER_VERSION,
    enabled: true,
  });
  const now = new Date();
  await repo.markChecked(source.id, now);

  const [committeeRows, billRows, page] = await Promise.all([
    prisma.stateCommittee.findMany({
      where: { state: 'FL' },
      select: {
        id: true,
        name: true,
        chamber: true,
        legislativeSession: true,
        officialSourceKey: true,
        sourceEvidence: true,
      },
    }),
    prisma.stateBill.findMany({
      where: { state: 'FL' },
      select: { id: true, billNumber: true, identifier: true, sessionKey: true },
    }),
    fetchAllPages<OpenstatesEvent>(
      '/events',
      {
        jurisdiction: 'fl',
        after: options.after,
        before: options.before,
        include: EVENT_INCLUDES,
      },
      MAX_EVENT_PAGES,
    ),
  ]);

  const officialByAlias = new Map<string, (typeof committeeRows)[number]>();
  for (const row of committeeRows) {
    if (!row.officialSourceKey || !row.legislativeSession) continue;
    for (const aliasId of directoryAliasIds(row.sourceEvidence))
      officialByAlias.set(sessionIdentity(row.legislativeSession, aliasId), row);
  }
  const committees = new Map<string, CommitteeCrosswalk>();
  const ambiguousCommitteeIdentities = new Set<string>();
  for (const row of committeeRows) {
    const id = openstatesCommitteeIdentity(row.sourceEvidence);
    if (!id || !row.legislativeSession) continue;
    const identity = sessionIdentity(row.legislativeSession, id);
    if (ambiguousCommitteeIdentities.has(identity)) continue;
    const canonical = row.officialSourceKey
      ? row
      : (officialByAlias.get(sessionIdentity(row.legislativeSession, row.id)) ?? row);
    const session = canonical.legislativeSession ?? row.legislativeSession;
    if (!session || session !== row.legislativeSession) continue;
    const bodySourceKey =
      officialBodySourceKey(canonical.officialSourceKey, session) ?? `openstates:${id}`;
    const chamber = qualifiedCommitteeChamber(canonical.chamber, bodySourceKey);
    if (!chamber) continue;
    const next: CommitteeCrosswalk = {
      stateCommitteeId: canonical.id,
      name: canonical.name,
      chamber,
      session,
      bodySourceKey,
    };
    const existing = committees.get(identity);
    if (existing && existing.stateCommitteeId !== next.stateCommitteeId) {
      // One provider organization pointing at two canonical profiles is not a
      // crosswalk. Leave it unresolved instead of choosing whichever row the
      // database happened to return first.
      committees.delete(identity);
      ambiguousCommitteeIdentities.add(identity);
      continue;
    }
    committees.set(identity, next);
  }
  const officialCommittees = new Map<string, CommitteeCrosswalk>();
  const ambiguousOfficialBodies = new Set<string>();
  for (const row of committeeRows) {
    const bodySourceKey = officialBodySourceKey(row.officialSourceKey, row.legislativeSession);
    if (!bodySourceKey || !row.legislativeSession) continue;
    const chamber = qualifiedCommitteeChamber(row.chamber, bodySourceKey);
    if (!chamber) continue;
    const identity = sessionIdentity(row.legislativeSession, bodySourceKey);
    if (ambiguousOfficialBodies.has(identity)) continue;
    const next: CommitteeCrosswalk = {
      stateCommitteeId: row.id,
      name: row.name,
      chamber,
      session: row.legislativeSession,
      bodySourceKey,
    };
    const existing = officialCommittees.get(identity);
    if (existing && existing.stateCommitteeId !== next.stateCommitteeId) {
      officialCommittees.delete(identity);
      ambiguousOfficialBodies.add(identity);
      continue;
    }
    officialCommittees.set(identity, next);
  }
  const bills = new Map<string, { id: string; sessionKey: string }>();
  for (const bill of billRows)
    for (const key of [bill.billNumber, bill.identifier])
      if (key)
        bills.set(key.toUpperCase().replace(/\s+/g, ''), {
          id: bill.id,
          sessionKey: bill.sessionKey,
        });

  const observations = page.rows
    .map((event) => openstatesEventObservation(event, committees, bills, officialCommittees))
    .filter((event): event is LegislativeObservation => Boolean(event));
  const qualifiedObservations = observations.filter(
    (observation) =>
      !observation.issues.includes(CONFLICTING_COMMITTEE_ISSUE) &&
      !observation.issues.includes(AMBIGUOUS_PUBLISHER_COMMITTEE_ISSUE),
  );
  const identityRepairs = await repairLegacyOpenstatesEventIdentities(
    prisma,
    source.id,
    new Set(qualifiedObservations.map(openstatesProviderEventId)),
    options.after.slice(0, 4),
    log,
  );
  const rawEventIds = observations.map(openstatesProviderEventId);
  const priorObservations = await prisma.hearingSourceObservation.findMany({
    where: { sourceId: source.id, externalEventId: { in: rawEventIds } },
    select: { externalEventId: true, hearingId: true },
  });
  const priorHearingByEvent = new Map(
    priorObservations.map((observation) => [observation.externalEventId, observation.hearingId]),
  );
  let inserted = 0;
  let updated = identityRepairs;
  let unchanged = 0;
  let errors = 0;
  const probeCache = new Map<string, string | null>();
  const byChamber = new Map<string, number>();
  for (const observation of observations) {
    byChamber.set(observation.chamber, (byChamber.get(observation.chamber) ?? 0) + 1);
    try {
      const committeeEvidenceError = observation.issues.find(
        (issue) =>
          issue === CONFLICTING_COMMITTEE_ISSUE || issue === AMBIGUOUS_PUBLISHER_COMMITTEE_ISSUE,
      );
      if (committeeEvidenceError) {
        errors++;
        log(`[openstates-events] ${observation.officialIdentity}: ${committeeEvidenceError}`);
        continue;
      }
      const externalEventId = openstatesProviderEventId(observation);
      if (!externalEventId.startsWith('ocd-event/'))
        throw new Error('OpenStates observation is missing its raw provider event id');
      const watchUrl = observation.fields.watchUrl;
      const priorHearingId = priorHearingByEvent.get(externalEventId);
      const crosswalk =
        watchUrl && shouldProbeFloridaCrossProvider(priorHearingId)
          ? await findFloridaCanonicalBySharedEntry(prisma, watchUrl, probeCache, {
              observation: {
                chamber: observation.chamber,
                date: observation.fields.time?.date ?? null,
              },
              log,
            })
          : { hearingId: null, ambiguous: false };
      if (crosswalk.ambiguous) {
        errors++;
        log(`[openstates-events] ${observation.officialIdentity}: ambiguous publisher media proof`);
        continue;
      }
      const outcome = await reconciler.reconcileEvent(
        source,
        {
          externalEventId,
          chamber: observation.chamber,
          legislative: observation,
          ...(crosswalk.hearingId ? { canonicalHearingId: crosswalk.hearingId } : {}),
        },
        now,
      );
      if (outcome.hearingCreated) inserted++;
      else if (outcome.changedFields.length) updated++;
      else unchanged++;
      if (watchUrl) {
        await prisma.$transaction(async (tx) => {
          // Re-enter the exact per-event lock used by calendar reconcile and
          // reread the durable source ledger after acquiring it. If a reviewed
          // alias repair committed between the two transactions, this writes
          // to the canonical hearing instead of recreating an alias-side row.
          await lockFloridaOpenstatesEventWriter(tx, externalEventId, 'wait');
          const durableObservation = await tx.hearingSourceObservation.findUnique({
            where: {
              sourceId_externalEventId: { sourceId: source.id, externalEventId },
            },
            select: { hearingId: true },
          });
          if (!durableObservation?.hearingId)
            throw new Error('OpenStates source ledger lost its durable hearing link');
          await new StreamCandidateRepository(tx).recordCandidates(
            durableObservation.hearingId,
            [
              {
                provider: '',
                officialPageUrl: watchUrl,
                mediaUrl: null,
                mediaType: 'video',
                capturePolicy: 'BROWSER_CAPTURE_ONLY',
                priority: 30,
              },
            ],
            { now, sourceId: source.id },
          );
        });
      }
      log(
        JSON.stringify({
          provider: 'openstates',
          eventId: observation.officialIdentity,
          hearingId: outcome.hearingId,
          stateCommitteeId: observation.stateCommitteeId,
          created: outcome.hearingCreated,
          changedFields: outcome.changedFields,
        }),
      );
    } catch (error) {
      errors++;
      log(
        `[openstates-events] ${observation.officialIdentity}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (!page.complete) errors++;
  const coverageStatus =
    page.complete && errors === 0 ? 'complete' : observations.length ? 'partial' : 'failed';
  for (const chamber of ['house', 'senate', 'joint'] as const) {
    await prisma.legislativeCalendarCoverage.create({
      data: {
        sourceId: source.id,
        jurisdiction: 'FL',
        chamber,
        session: options.after.slice(0, 4),
        fromDate: new Date(`${options.after}T00:00:00Z`),
        toDate: new Date(`${options.before}T00:00:00Z`),
        status: coverageStatus,
        pages: Math.ceil(page.rows.length / 20),
        items: byChamber.get(chamber) ?? 0,
        details: {
          fetched: page.rows.length,
          qualified: observations.length,
          linkedCommittees: committees.size,
          linkedOfficialCommittees: officialCommittees.size,
          ledgerLinkedEvents: [...priorHearingByEvent.values()].filter(Boolean).length,
          identityRepairs,
          complete: page.complete,
          errors,
        } as Prisma.InputJsonObject,
        attemptedAt: now,
      },
    });
  }
  await repo.recordOutcome(
    source.id,
    {
      ok: page.complete && errors === 0,
      observedEvents: observations.length,
      error:
        page.complete && errors === 0
          ? null
          : `${page.complete ? 0 : 1} incomplete page walk(s); ${errors} reconciliation error(s)`,
    },
    now,
    PARSER_VERSION,
  );
  return {
    inserted,
    updated,
    skipped: unchanged + (page.rows.length - observations.length),
    errors,
    complete: page.complete && errors === 0,
    ...(page.complete && errors === 0
      ? {}
      : { incompleteReason: 'OpenStates event pages or canonical reconciliation were incomplete' }),
  };
}

async function main() {
  const states = statesFromEnv(process.env.OPENSTATES_EVENTS_STATES);
  if (!states.includes('FL')) return;
  const window = dateWindow();
  const prisma = new PrismaClient();
  try {
    await runWithSyncRun(
      prisma,
      'sync-openstates-events-fl',
      () => syncFloridaOpenstatesEvents(prisma, { ...window, log: console.log }),
      { skipIfRunning: true },
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
