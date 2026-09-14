import type { Prisma, PrismaClient } from '@prisma/client';

type HearingClient = Pick<PrismaClient, 'committeeHearing'>;

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
  const id = `cm-${input.congress}-${input.eventId}`;
  const candidates = [id];
  if (input.chamber.toLowerCase() === 'senate' && /^\d+$/.test(input.eventId))
    candidates.push(`sen-${input.congress}-${input.eventId}`);
  for (const candidate of candidates) {
    const row = await db.committeeHearing.findUnique({
      where: { id: candidate },
      select: { id: true, chamber: true, geographicJurisdiction: true },
    });
    if (
      row &&
      (row.chamber.toLowerCase() !== input.chamber.toLowerCase() ||
        (row.geographicJurisdiction && row.geographicJurisdiction !== 'US'))
    )
      throw new Error('Official hearing ID is occupied by a different scope');
    if (
      row &&
      row.chamber.toLowerCase() === input.chamber.toLowerCase() &&
      (!row.geographicJurisdiction || row.geographicJurisdiction === 'US')
    )
      return resolveCanonicalHearingId(db, row.id);
  }
  return input.chamber.toLowerCase() === 'senate' ? `sen-${input.congress}-${input.eventId}` : id;
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
