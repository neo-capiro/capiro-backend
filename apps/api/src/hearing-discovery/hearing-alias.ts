import type { Prisma, PrismaClient } from '@prisma/client';

type HearingClient = Pick<PrismaClient, 'committeeHearing'>;

/** Congress.gov labels joint proceedings NoChamber. It is a publisher value,
 * not a separate jurisdiction, and must agree across the legacy and canonical writers. */
export function officialHearingChamber(value: string): string {
  const chamber = value.trim().toLowerCase();
  if (chamber === 'house') return 'House';
  if (chamber === 'senate') return 'Senate';
  if (chamber === 'joint' || chamber === 'nochamber') return 'Joint';
  return value;
}

/** Resolve retained IDs without guessing from titles, dates or committee names. */
export async function resolveCanonicalHearingId(db: HearingClient, id: string): Promise<string> {
  const seen = new Set<string>();
  let current = id;
  for (let depth = 0; depth < 8; depth++) {
    if (seen.has(current)) throw new Error('Canonical hearing alias cycle');
    seen.add(current);
    const row = await db.committeeHearing.findUnique({
      where: { id: current },
      select: { canonicalHearingId: true },
    });
    if (!row?.canonicalHearingId) return current;
    current = row.canonicalHearingId;
  }
  throw new Error('Canonical hearing alias chain exceeds limit');
}

/** Resolve selection IDs before database pagination, including historical exports. */
export async function resolveCanonicalHearingIds(
  db: HearingClient,
  ids: string[],
): Promise<string[]> {
  return [
    ...new Set(await Promise.all([...new Set(ids)].map((id) => resolveCanonicalHearingId(db, id)))),
  ];
}

export function canonicalHearingWhere(
  where: Prisma.CommitteeHearingWhereInput = {},
): Prisma.CommitteeHearingWhereInput {
  return { AND: [{ canonicalHearingId: null }, where] };
}

/** A legacy sync must reuse the Senate row before a new cm-* row is inserted.
 * Only an exact, scoped official event identifier permits this cross-source
 * lookup. Existing reviewed aliases take precedence over either prefix. */
export async function resolveOfficialMeetingId(
  db: HearingClient,
  input: { congress: number; eventId: string; chamber: string },
): Promise<string> {
  const chamber = officialHearingChamber(input.chamber).toLowerCase();
  const id = `cm-${input.congress}-${input.eventId}`;
  const candidates = [id];
  if (chamber === 'senate' && /^\d+$/.test(input.eventId))
    candidates.push(`sen-${input.congress}-${input.eventId}`);
  for (const candidate of candidates) {
    const row = await db.committeeHearing.findUnique({
      where: { id: candidate },
      select: { id: true, chamber: true, geographicJurisdiction: true },
    });
    if (
      row &&
      (officialHearingChamber(row.chamber).toLowerCase() !== chamber ||
        (row.geographicJurisdiction && row.geographicJurisdiction !== 'US'))
    )
      throw new Error('Official hearing ID is occupied by a different scope');
    if (
      row &&
      officialHearingChamber(row.chamber).toLowerCase() === chamber &&
      (!row.geographicJurisdiction || row.geographicJurisdiction === 'US')
    )
      return resolveCanonicalHearingId(db, row.id);
  }
  return chamber === 'senate' ? `sen-${input.congress}-${input.eventId}` : id;
}

/** Canonical Senate projections own populated schedule/display fields. The
 * legacy Congress sync may supply missing witnesses/metadata but must not undo
 * a newer Senate reschedule, title or room when it replays an older payload. */
export function supplementCanonicalHearing<T extends Record<string, unknown>>(
  incoming: T,
  existing: Record<string, unknown>,
): Partial<T> {
  return Object.fromEntries(
    Object.entries(incoming).filter(([key, value]) => {
      const prior = existing[key];
      return (
        value != null &&
        (prior == null || prior === '' || (Array.isArray(prior) && prior.length === 0))
      );
    }),
  ) as Partial<T>;
}

/** A central API's missing witness list is not an official withdrawal notice. */
export function preservePublishedWitnesses<T extends Record<string, unknown>>(
  incoming: T,
): Partial<T> {
  if (!Array.isArray(incoming.witnesses) || incoming.witnesses.length > 0) return incoming;
  const { witnesses: _omitted, ...remaining } = incoming;
  return remaining as Partial<T>;
}
