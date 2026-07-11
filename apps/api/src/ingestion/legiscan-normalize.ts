/**
 * Pure normalize + per-child-table upsert for a LegiScan `getBill` payload
 * (State Legislation Platform, Phase 0 S1.4). Shared by `backfill-legiscan-datasets`
 * and `sync-legiscan-bills` so both paths write byte-identical rows.
 *
 * Per-child-table strategy is deliberate, not uniform (verification finding —
 * a blanket delete-and-recreate would reset `firstSeenAt` and fabricate
 * momentum evidence the SLA telemetry and sponsor-momentum emitter both rely
 * on):
 *  - actions:   append-only anti-join on (billKey, date, orderKey) — history
 *               is cumulative, existing rows (and firstSeenAt) never touched.
 *  - sponsors:  diff-sync — new rows inserted (stamping firstSeenAt),
 *               withdrawals (absent from payload) deleted, retained rows
 *               never blanket-recreated.
 *  - versions/links/calendar events: delete-and-recreate (small sets, no
 *               watermark semantics on the child rows themselves).
 *  - votes:     upserted by natural id, never deleted (immutable once
 *               recorded).
 */
import type { PrismaClient } from '@prisma/client';
import { isValidCanonicalId } from '@capiro/shared';
import type {
  LegiscanBill,
  LegiscanPerson,
  LegiscanRollCall,
  LegiscanSession,
} from '../external/legiscan/legiscan.client.js';

/** DD1 sessionKey: LegiScan session.year_start, or "<year_start>x<session_id>" for specials. */
export function computeSessionKey(
  session: Pick<LegiscanSession, 'year_start' | 'special' | 'session_id'>,
): string {
  return session.special === 1
    ? `${session.year_start}x${session.session_id}`
    : `${session.year_start}`;
}

/** Normalize a LegiScan bill number ("HB 1234", "H.B. 1234") to the DD1 key segment ("hb1234"). */
export function normalizeBillNumber(number: string): string {
  return (number ?? '').toLowerCase().replace(/\./g, '').replace(/\s+/g, '');
}

/**
 * The bill's display number, resilient to LegiScan's per-operation field split:
 * getMasterList returns it as `number`; getBill AND the bulk dataset return it
 * as `bill_number` (with `number` null). normalizeLegiscanBill is only ever fed
 * getBill/dataset payloads (the drain + the backfill), so reading `raw.number`
 * alone yielded undefined → an invalid canonical key → null → EVERY bill
 * silently dropped (0 rows on the 2026-07-11 activation backfill; unit tests
 * missed it because the fixture used `number` and the TS type declared it
 * required). Prefer bill_number, fall back to number for any masterlist-shaped
 * caller. Verified against a live getBill + getDataset for DC B26-0001.
 */
export function billDisplayNumber(
  raw: Pick<LegiscanBill, 'number' | 'bill_number'>,
): string {
  return (raw.bill_number ?? raw.number ?? '').trim();
}

/** Build + validate the DD1 canonical key. Null when any part is malformed. */
export function buildStateBillKey(
  state: string,
  sessionKey: string,
  billNumber: string,
): string | null {
  const key = `${state.toLowerCase()}-${sessionKey}-${normalizeBillNumber(billNumber)}`;
  return isValidCanonicalId('stateBillKey', key) ? key : null;
}

export interface NormalizedStateBill {
  billKey: string;
  state: string;
  sessionKey: string;
  legiscanSessionId: number;
  identifier: string;
  billNumber: string;
  title: string;
  chamber: string | null;
  classification: string[];
  subjects: string[];
  description: string | null;
  sponsorName: string | null;
  sponsorParty: string | null;
  sponsorCount: number;
  legiscanStatus: number;
  legiscanProgress: Array<{ date: string; event: number }>;
  textDate: Date | null;
  latestActionDate: Date | null;
  latestActionText: string | null;
  url: string | null;
  stateUrl: string | null;
  legiscanBillId: number;
  legiscanChangeHash: string;
  /** Current committee referral (Phase 1 M2.2) — LegiScan's getBill.committee, or null when the bill isn't currently in committee. */
  committee: { legiscanCommitteeId: number; name: string; chamber: string | null } | null;
  actions: Array<{
    date: Date;
    text: string;
    chamber: string | null;
    importance: number | null;
    orderKey: number;
  }>;
  sponsors: Array<{
    legiscanPeopleId: number;
    name: string;
    party: string | null;
    sponsorType: 'primary' | 'cosponsor';
    sponsorOrder: number;
  }>;
  versions: Array<{
    legiscanDocId: number;
    versionType: string;
    date: Date;
    stateUrl: string | null;
    mime: string | null;
  }>;
  links: Array<{ legiscanRelatedBillId: number; linkType: string }>;
  calendarEvents: Array<{
    eventType: string;
    date: Date;
    time: string | null;
    location: string | null;
    eventKey: string;
  }>;
  voteStubs: LegiscanBill['votes'];
}

function safeDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Normalize a LegiScan-sourced chamber string to OpenStates' 'upper'/'lower'
 * vocabulary. LegiScan's committee.chamber is a single-letter code ('H' House,
 * 'S' Senate, 'A' Assembly — verified against the LegiScan API user manual +
 * fulltext-search chamber-prefix docs); bill.current_body/body is the same code
 * family. `state_legislator.chamber` (OpenStates) is 'upper'/'lower', so a
 * committee first seen via a LegiScan bill referral and later via OpenStates
 * roster normalization (M2.2) converge on the SAME `StateCommittee.id`.
 *
 * W4.1 hardening: also accept the already-normalized forms ('upper'/'lower')
 * and the spelled-out chamber names ('house'/'senate'/'assembly'), since this
 * now normalizes `state_bill.chamber` too (consumed by the chokepoint
 * own-chamber leadership filter) and its exact stored form is not guaranteed
 * uniform across all 50 states' LegiScan feeds. An unrecognized value maps to
 * null rather than a guess (the chokepoint filter then skips, never mis-attributes).
 */
export function normalizeLegiscanChamber(
  code: string | null | undefined,
): 'upper' | 'lower' | null {
  switch ((code ?? '').trim().toUpperCase()) {
    case 'H':
    case 'A':
    case 'HOUSE':
    case 'ASSEMBLY':
    case 'LOWER':
      return 'lower';
    case 'S':
    case 'SENATE':
    case 'UPPER':
      return 'upper';
    default:
      return null;
  }
}

const SAST_LINK_TYPES: Record<number, string> = {
  1: 'same_as',
  2: 'similar',
  3: 'replaced_by',
  4: 'replaces',
  5: 'companion',
  6: 'related', // LegiScan's "Cross-Filed" / catch-all
};

/** Pure transform: LegiScan getBill payload -> our normalized shape. Caller supplies `state` explicitly (never inferred from the payload) since the drain loop always knows which state's cursor it's processing. */
export function normalizeLegiscanBill(
  raw: LegiscanBill,
  state: string,
): NormalizedStateBill | null {
  const sessionKey = computeSessionKey(raw.session);
  const displayNumber = billDisplayNumber(raw);
  const billKey = buildStateBillKey(state, sessionKey, displayNumber);
  if (!billKey) return null;

  const history = raw.history ?? [];
  const actions = history.map((h, idx) => ({
    date: safeDate(h.date) ?? new Date(0),
    text: h.action,
    chamber: h.chamber ?? null,
    importance: typeof h.importance === 'number' ? h.importance : null,
    orderKey: idx,
  }));

  const sponsors = (raw.sponsors ?? []).map((s, idx) => ({
    legiscanPeopleId: s.people_id,
    name: s.name,
    party: s.party ?? null,
    sponsorType: (s.sponsor_type_id === 1 ? 'primary' : 'cosponsor') as 'primary' | 'cosponsor',
    sponsorOrder: s.sponsor_order ?? idx,
  }));

  const versions = (raw.texts ?? []).map((t) => ({
    legiscanDocId: t.doc_id,
    versionType: t.type,
    date: safeDate(t.date) ?? new Date(0),
    stateUrl: t.state_link ?? t.url ?? null,
    mime: t.mime ?? null,
  }));
  const textDates = versions.map((v) => v.date.getTime()).filter((t) => t > 0);
  const textDate = textDates.length ? new Date(Math.max(...textDates)) : null;

  const links = (raw.sasts ?? [])
    .filter((s) => typeof s.sast_bill_id === 'number')
    .map((s) => ({
      legiscanRelatedBillId: s.sast_bill_id as number,
      linkType: SAST_LINK_TYPES[s.type_id] ?? 'related',
    }));

  const calendarEvents = (raw.calendar ?? [])
    .filter((c) => c.date)
    .map((c) => {
      const date = safeDate(c.date) as Date;
      const eventType = c.type ?? 'event';
      const eventKey = `${billKey}:${eventType}:${date.toISOString().slice(0, 10)}:${c.location ?? ''}`;
      return { eventType, date, time: c.time ?? null, location: c.location ?? null, eventKey };
    });

  const latestAction = history.length ? history[history.length - 1] : null;

  return {
    billKey,
    state: state.toUpperCase(),
    sessionKey,
    legiscanSessionId: raw.session.session_id,
    identifier: displayNumber,
    billNumber: normalizeBillNumber(displayNumber),
    title: raw.title,
    chamber: raw.current_body ?? raw.body ?? null,
    classification: raw.bill_type ? [raw.bill_type] : [],
    subjects: (raw.subjects ?? []).map((s) => s.subject_name).filter((s): s is string => !!s),
    description: raw.description ?? null,
    sponsorName:
      sponsors.find((s) => s.sponsorType === 'primary')?.name ?? sponsors[0]?.name ?? null,
    sponsorParty:
      sponsors.find((s) => s.sponsorType === 'primary')?.party ?? sponsors[0]?.party ?? null,
    sponsorCount: sponsors.length,
    legiscanStatus: raw.status,
    legiscanProgress: (raw.progress ?? []).map((p) => ({ date: p.date, event: p.event })),
    textDate,
    latestActionDate: latestAction ? safeDate(latestAction.date) : null,
    latestActionText: latestAction?.action ?? null,
    url: raw.url ?? null,
    stateUrl: raw.state_link ?? raw.url ?? null,
    legiscanBillId: raw.bill_id,
    legiscanChangeHash: raw.change_hash,
    committee:
      raw.committee?.committee_id != null && raw.committee.name
        ? {
            legiscanCommitteeId: raw.committee.committee_id,
            name: raw.committee.name,
            chamber: normalizeLegiscanChamber(raw.committee.chamber),
          }
        : null,
    actions,
    sponsors,
    versions,
    links,
    calendarEvents,
    voteStubs: raw.votes ?? [],
  };
}

function slugifyCommitteeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
}

/**
 * Upsert the bill's current committee referral into `state_committee` and
 * return its id (Phase 1 M2.2). Uses the SAME `"<state>-<chamber>-<slug(name)>"`
 * scheme `normalize-state-committees.ts` uses for the OpenStates roster path,
 * so a committee first seen here and later normalized from
 * `StateLegislator.committees` (or vice versa) converges on one row. A
 * referral with an unrecognized chamber code resolves to `null` — the id
 * scheme needs a chamber, and guessing one would be exactly the kind of guess
 * PD2 forbids.
 */
export async function resolveCurrentCommittee(
  prisma: PrismaClient,
  state: string,
  committee: NormalizedStateBill['committee'],
): Promise<string | null> {
  if (!committee || !committee.chamber) return null;
  const id = `${state}-${committee.chamber}-${slugifyCommitteeName(committee.name)}`;
  await prisma.stateCommittee.upsert({
    where: { id },
    create: {
      id,
      state,
      chamber: committee.chamber,
      name: committee.name,
      legiscanCommitteeId: committee.legiscanCommitteeId,
    },
    update: { name: committee.name, legiscanCommitteeId: committee.legiscanCommitteeId },
  });
  return id;
}

/**
 * Upsert one normalized bill + its children, per the per-table strategies
 * documented above. Runs each child table's write in its own statement (not
 * one giant transaction) — mirrors the federal sync scripts' per-bill
 * try/catch granularity so one malformed child doesn't lose the whole bill.
 */
export async function upsertNormalizedStateBill(
  prisma: PrismaClient,
  n: NormalizedStateBill,
): Promise<{ isNew: boolean }> {
  const existing = await prisma.stateBill.findUnique({
    where: { id: n.billKey },
    select: { id: true },
  });
  const isNew = !existing;

  const currentCommitteeId = await resolveCurrentCommittee(prisma, n.state, n.committee);

  const billData = {
    state: n.state,
    session: n.sessionKey,
    sessionKey: n.sessionKey,
    identifier: n.identifier,
    billNumber: n.billNumber,
    title: n.title,
    chamber: n.chamber,
    classification: n.classification,
    subjects: n.subjects,
    description: n.description,
    sponsorName: n.sponsorName,
    sponsorParty: n.sponsorParty,
    sponsorCount: n.sponsorCount,
    legiscanStatus: n.legiscanStatus,
    legiscanProgress: n.legiscanProgress,
    textDate: n.textDate,
    latestActionDate: n.latestActionDate,
    latestActionText: n.latestActionText,
    url: n.url,
    stateUrl: n.stateUrl,
    legiscanBillId: n.legiscanBillId,
    legiscanChangeHash: n.legiscanChangeHash,
    currentCommitteeId,
    syncedAt: new Date(),
  };
  await prisma.stateBill.upsert({
    where: { id: n.billKey },
    create: { id: n.billKey, ...billData },
    update: billData,
  });

  // Actions: append-only anti-join on (billKey, date, orderKey). Never
  // touches firstSeenAt on existing rows — the SLA telemetry anchor.
  if (n.actions.length) {
    const existingActions = await prisma.stateBillAction.findMany({
      where: { billKey: n.billKey },
      select: { date: true, orderKey: true },
    });
    const seen = new Set(
      existingActions.map((a) => `${a.date.toISOString().slice(0, 10)}:${a.orderKey}`),
    );
    const toInsert = n.actions.filter(
      (a) => !seen.has(`${a.date.toISOString().slice(0, 10)}:${a.orderKey}`),
    );
    if (toInsert.length) {
      await prisma.stateBillAction.createMany({
        data: toInsert.map((a) => ({ billKey: n.billKey, ...a })),
        skipDuplicates: true,
      });
    }
  }

  // Sponsors: diff-sync. New via anti-join (stamping firstSeenAt); withdrawals
  // (absent from payload) deleted; retained rows never blanket-recreated.
  const existingSponsors = await prisma.stateBillSponsor.findMany({
    where: { billKey: n.billKey },
    select: { legiscanPeopleId: true },
  });
  const existingIds = new Set(existingSponsors.map((s) => s.legiscanPeopleId));
  const payloadIds = new Set(n.sponsors.map((s) => s.legiscanPeopleId));
  const newSponsors = n.sponsors.filter((s) => !existingIds.has(s.legiscanPeopleId));
  if (newSponsors.length) {
    await prisma.stateBillSponsor.createMany({
      data: newSponsors.map((s) => ({ billKey: n.billKey, ...s })),
      skipDuplicates: true,
    });
  }
  const withdrawnIds = [...existingIds].filter((id) => id != null && !payloadIds.has(id));
  if (withdrawnIds.length) {
    await prisma.stateBillSponsor.deleteMany({
      where: { billKey: n.billKey, legiscanPeopleId: { in: withdrawnIds as number[] } },
    });
  }

  // Versions/links/calendar events: delete-and-recreate (small sets, no
  // watermark semantics on the rows themselves).
  await prisma.stateBillVersion.deleteMany({ where: { billKey: n.billKey } });
  if (n.versions.length) {
    await prisma.stateBillVersion.createMany({
      data: n.versions.map((v) => ({ billKey: n.billKey, ...v })),
      skipDuplicates: true,
    });
  }

  await prisma.stateBillLink.deleteMany({ where: { billKey: n.billKey } });
  if (n.links.length) {
    await prisma.stateBillLink.createMany({
      data: n.links.map((l) => ({ billKey: n.billKey, ...l })),
      skipDuplicates: true,
    });
  }

  await prisma.stateBillCalendarEvent.deleteMany({ where: { billKey: n.billKey } });
  if (n.calendarEvents.length) {
    await prisma.stateBillCalendarEvent.createMany({
      data: n.calendarEvents.map((c) => ({ billKey: n.billKey, ...c })),
      skipDuplicates: true,
    });
  }

  return { isNew };
}

/**
 * Backfill `related_bill_key` on `state_bill_link` rows whose target has since
 * been ingested (the sasts target may not exist yet at link-write time).
 */
export async function backfillStateBillLinkTargets(prisma: PrismaClient): Promise<number> {
  const result = await prisma.$executeRawUnsafe(`
    UPDATE "state_bill_link" l
    SET "related_bill_key" = sb.id
    FROM "state_bill" sb
    WHERE l."related_bill_key" IS NULL
      AND sb."legiscan_bill_id" = l."legiscan_related_bill_id"
  `);
  return result;
}

// ── Sessions (S1.2/S2.2 state_session) ──────────────────────────────────────

export function stateSessionId(state: string, legiscanSessionId: number): string {
  return `${state.toLowerCase()}-${legiscanSessionId}`;
}

/** Upsert a state_session row. See the LegiscanSession.sine_die doc comment re: defensive date parsing. */
export async function upsertStateSession(
  prisma: PrismaClient,
  state: string,
  session: LegiscanSession,
): Promise<void> {
  const id = stateSessionId(state, session.session_id);
  const sessionKey = computeSessionKey(session);
  const sineDie =
    session.sine_die != null && session.sine_die !== 0 && session.sine_die !== '0'
      ? safeDate(String(session.sine_die))
      : null;
  const data = {
    state: state.toUpperCase(),
    legiscanSessionId: session.session_id,
    sessionKey,
    name: session.session_name,
    yearStart: session.year_start,
    yearEnd: session.year_end,
    special: session.special === 1,
    sineDie,
    prior: session.prior === 1,
    lastSyncedAt: new Date(),
  };
  await prisma.stateSession.upsert({
    where: { id },
    create: { id, ...data },
    update: data,
  });
}

// ── Roll-call votes (S1.3.3 drain / S1.3.1 backfill) ────────────────────────

export function stateRollCallId(state: string, legiscanRollCallId: number): string {
  return `${state.toLowerCase()}-rc-${legiscanRollCallId}`;
}

/**
 * Upsert one roll call + its per-member rows. Votes are immutable once
 * recorded (LegiScan never revises a historical tally) — member rows are
 * inserted with `skipDuplicates`, never deleted/replaced. Caller (the drain
 * verb) is responsible for skipping the `getRollCall` fetch entirely when a
 * roll call with matching totals is already stored — this function itself is
 * safe to call repeatedly (fully idempotent).
 */
export async function upsertStateRollCallVote(
  prisma: PrismaClient,
  state: string,
  billKey: string | null,
  rc: LegiscanRollCall,
): Promise<void> {
  const id = stateRollCallId(state, rc.roll_call_id);
  const passed = typeof rc.passed === 'number' ? rc.passed === 1 : null;
  const date = safeDate(rc.date) ?? new Date(0);
  const data = {
    billKey,
    legiscanRollCallId: rc.roll_call_id,
    chamber: rc.chamber ?? null,
    date,
    motion: rc.desc ?? null,
    yeas: rc.yea ?? 0,
    nays: rc.nay ?? 0,
    nv: rc.nv ?? 0,
    absent: rc.absent ?? 0,
    passed,
    sourceUrl: null as string | null,
  };
  await prisma.stateRollCallVote.upsert({
    where: { id },
    create: { id, ...data },
    update: data,
  });

  const memberRows = (rc.votes ?? []).filter((v) => typeof v.people_id === 'number');
  if (memberRows.length) {
    await prisma.stateMemberVote.createMany({
      data: memberRows.map((v) => ({
        voteId: id,
        legiscanPeopleId: v.people_id,
        voteCast: v.vote_text,
      })),
      skipDuplicates: true,
    });
  }
}

// ── People / legislators (S1.3.4 sync-openstates people loop + crosswalk) ──

/**
 * Match a LegiScan person to an existing OpenStates-keyed state_legislator row
 * by (state, district, party-insensitive name) and stamp `legiscanPeopleId` +
 * an entity_crosswalk row. Best-effort — logs unresolved matches rather than
 * failing (people crosswalk hardening is explicitly scoped to continue past
 * Phase 0, S2 §S2 success criteria S2-C targets >99%, not 100%).
 */
export async function crosswalkLegiscanPerson(
  prisma: PrismaClient,
  state: string,
  person: LegiscanPerson,
): Promise<boolean> {
  const normalizedName = person.name.trim().toLowerCase();
  const candidates = await prisma.stateLegislator.findMany({
    where: { state: state.toUpperCase(), active: true },
    select: { id: true, name: true, district: true },
  });
  const match = candidates.find(
    (c) =>
      c.name.trim().toLowerCase() === normalizedName ||
      (person.district &&
        c.district === person.district &&
        c.name
          .trim()
          .toLowerCase()
          .includes(normalizedName.split(' ').pop() ?? '')),
  );
  if (!match) return false;

  await prisma.stateLegislator.update({
    where: { id: match.id },
    data: { legiscanPeopleId: person.people_id },
  });
  await prisma.entityCrosswalk.upsert({
    where: { idType_idValue: { idType: 'legiscan_people', idValue: String(person.people_id) } },
    create: {
      idType: 'legiscan_people',
      idValue: String(person.people_id),
      entityType: 'state_legislator',
      entityKey: match.id,
      source: 'sync-openstates',
    },
    update: { entityKey: match.id, source: 'sync-openstates' },
  });
  return true;
}

/** entity_crosswalk rows for a state bill's LegiScan + OpenStates ids (S2.3). */
export async function crosswalkStateBill(
  prisma: PrismaClient,
  billKey: string,
  legiscanBillId: number,
  openstatesId?: string | null,
): Promise<void> {
  await prisma.entityCrosswalk.upsert({
    where: { idType_idValue: { idType: 'legiscan_bill', idValue: String(legiscanBillId) } },
    create: {
      idType: 'legiscan_bill',
      idValue: String(legiscanBillId),
      entityType: 'state_bill',
      entityKey: billKey,
      source: 'sync-legiscan-bills',
    },
    update: { entityKey: billKey, source: 'sync-legiscan-bills' },
  });
  if (openstatesId) {
    await prisma.entityCrosswalk.upsert({
      where: { idType_idValue: { idType: 'openstates_bill', idValue: openstatesId } },
      create: {
        idType: 'openstates_bill',
        idValue: openstatesId,
        entityType: 'state_bill',
        entityKey: billKey,
        source: 'sync-legiscan-bills',
      },
      update: { entityKey: billKey, source: 'sync-legiscan-bills' },
    });
  }
}
