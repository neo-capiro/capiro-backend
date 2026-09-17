import type { PrismaClient } from '@prisma/client';
import {
  fetchFloridaChannelSource,
  fetchFloridaSource,
  floridaKalturaEntryId,
} from './adapters/florida-calendar.adapter.js';

/**
 * Strong-proof Florida crosswalk: find the ONE canonical FL hearing whose
 * stored observation source/watch page embeds the SAME publisher media
 * (Kaltura) entry as `watchUrl`. A shared publisher entry id is the
 * publisher's own identity for one recording; date/chamber/body are NEVER
 * proof. Returns null without proof; reports and returns ambiguous when the
 * proof matches more than one proceeding.
 *
 * Bounded matching contract (root review): the candidate set is narrowed to
 * FL canonical hearings on the observation's own meeting date whose stored
 * chamber is compatible — never a scan of every archive observation. A
 * persisted `publisherMediaEntryId` in observation metadata short-circuits
 * probing entirely (no migration: it rides inside the existing JSON).
 * Probes fetch each distinct publisher page at most once per `probeCache`
 * lifetime (pass a fresh map per run) through the INJECTED fetchers, so
 * regression tests never touch the live network and no network ever runs
 * inside a DB transaction (the caller resolves BEFORE reconcile).
 */
export async function findFloridaCanonicalBySharedEntry(
  prisma: PrismaClient,
  watchUrl: string,
  probeCache: Map<string, string | null>,
  options: {
    /** Qualifies and narrows the candidate set; REQUIRED — the crosswalk
     *  refuses to scan unqualified observations. */
    observation: {
      chamber: 'house' | 'senate' | 'joint';
      /** Meeting date YYYY-MM-DD, when qualified (notices always have it). */
      date?: string | null;
    };
    log?: (message: string) => void;
    fetchChamber?: (url: string) => Promise<Uint8Array>;
    fetchChannel?: (url: string) => Promise<{ bytes: Uint8Array; totalPages: number | null }>;
  },
): Promise<{ hearingId: string | null; ambiguous: boolean }> {
  const { observation } = options;
  if (observation.chamber !== 'house' && observation.chamber !== 'senate' && observation.chamber !== 'joint')
    return { hearingId: null, ambiguous: false };
  const log = options.log ?? (() => {});
  const fetchChamber = options.fetchChamber ?? fetchFloridaSource;
  const fetchChannel = options.fetchChannel ?? fetchFloridaChannelSource;
  const probe = async (page: string): Promise<string | null> => {
    if (!probeCache.has(page)) {
      try {
        const host = new URL(page).hostname.toLowerCase();
        const bytes =
          host === 'thefloridachannel.org'
            ? (await fetchChannel(page)).bytes
            : await fetchChamber(page);
        probeCache.set(page, floridaKalturaEntryId(new TextDecoder().decode(bytes)));
      } catch {
        probeCache.set(page, null); // an unreadable page proves nothing either way
      }
    }
    return probeCache.get(page) ?? null;
  };
  const entry = await probe(watchUrl);
  if (!entry) return { hearingId: null, ambiguous: false };

  // Bounded candidate set: FL canonical hearings on the SAME meeting day with
  // a compatible chamber. No date qualification, no crosswalk — the ledger
  // scan stays bounded, never whole-table.
  if (!observation.date || !/^\d{4}-\d{2}-\d{2}$/.test(observation.date))
    return { hearingId: null, ambiguous: false };
  const chamberFilter =
    observation.chamber === 'joint'
      ? { in: ['Joint', 'Senate', 'House'] }
      : observation.chamber === 'senate'
        ? { in: ['Senate', 'Joint'] }
        : { in: ['House', 'Joint'] };
  const hearings = await prisma.committeeHearing.findMany({
    where: {
      geographicJurisdiction: 'FL',
      canonicalHearingId: null,
      date: new Date(`${observation.date}T00:00:00Z`),
      chamber: chamberFilter,
    },
    select: { id: true, chamber: true, committeeName: true, legislativeSession: true },
    take: 200,
  });
  if (!hearings.length) return { hearingId: null, ambiguous: false };
  const hearingById = new Map(hearings.map((h) => [h.id, h]));
  const observations = await prisma.hearingSourceObservation.findMany({
    where: { hearingId: { in: hearings.map((h) => h.id) } },
    select: { hearingId: true, sourceMetadata: true },
    take: 1000,
  });
  const hits = new Set<string>();
  for (const row of observations) {
    const leg = (
      row.sourceMetadata as {
        legislative?: {
          sourceUrl?: unknown;
          fields?: { watchUrl?: unknown };
          publisherMediaEntryId?: unknown;
        };
      } | null
    )?.legislative;
    // Fast path: the observation's own persisted publisher identity — no
    // refetch of archive pages on later runs.
    if (typeof leg?.publisherMediaEntryId === 'string') {
      if (leg.publisherMediaEntryId === entry) {
        hits.add(row.hearingId!);
        continue;
      }
      // A persisted distinct entry on an observation row does NOT clear the
      // other pages the same observation cites (a notice can cite a TFC page
      // in watchUrl while its own source page is a chamber notice).
    }
    const pages = new Set<string>();
    if (typeof leg?.sourceUrl === 'string') pages.add(leg.sourceUrl);
    if (typeof leg?.fields?.watchUrl === 'string') pages.add(leg.fields.watchUrl);
    for (const page of pages) {
      if ((await probe(page)) === entry) {
        hits.add(row.hearingId!);
        break;
      }
    }
  }
  if (hits.size > 1) {
    // Ambiguous proof is REPORTED by the caller and the event skipped — a
    // null here must never be read as "no match, create a new row".
    log(
      `[florida-crosswalk] publisher entry ${entry} is shared by ${hits.size} proceedings on ${observation.date}; not merging`,
    );
    return { hearingId: null, ambiguous: true };
  }
  return { hearingId: [...hits][0] ?? null, ambiguous: false };
}
