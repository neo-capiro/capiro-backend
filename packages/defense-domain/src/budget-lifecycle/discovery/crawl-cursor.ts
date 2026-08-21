/**
 * Phase 8 Session 8 — crawl cursor algebra.
 *
 * The Session 7 store already round-trips an opaque
 * `cursor: Record<string, unknown>` per adapter through `loadAdapterState` and
 * `releaseAdapterLease`. Session 8 gives that opaque bag a governed shape,
 * because a live crawl is only affordable if it is incremental, and only correct
 * if the increment cannot skip anything.
 *
 * Design constraints, each from a real observation:
 *
 *  * **Per-collection watermarks, not one global one.** The GovInfo sitemap index
 *    is per collection and its year files advance independently. A single global
 *    watermark would let a BILLS update suppress a CRPT one.
 *
 *  * **Watermarks only ever move forward.** A publisher that briefly serves a
 *    stale sitemap must not rewind the cursor and cause a full re-crawl.
 *
 *  * **A truncated run must be resumable and must say so.** The first crawl of
 *    `BILLS_2023` faces 13,354 packages against a bounded request budget. The
 *    cursor therefore records that a collection is mid-backfill, and the
 *    watermark is NOT advanced past work that was never examined — advancing it
 *    would silently skip the remainder forever.
 */

export const DISCOVERY_CURSOR_SCHEMA = 'phase8_session8_discovery_cursor_v1';

export interface CollectionCursor {
  /** Highest `lastmod` fully processed for this collection. */
  readonly watermark: string | null;
  /** `true` when a bounded run stopped before exhausting this collection. */
  readonly backfillPending: boolean;
  /**
   * Package ids already emitted at the current watermark. Because the watermark
   * comparison is inclusive, this is what stops a boundary entry from being
   * re-emitted on every run without risking a skip.
   */
  readonly emittedAtWatermark: readonly string[];
}

export interface DiscoveryCursor {
  readonly schema: typeof DISCOVERY_CURSOR_SCHEMA;
  readonly collections: Readonly<Record<string, CollectionCursor>>;
  readonly lastRunAt: string | null;
}

const EMPTY_COLLECTION: CollectionCursor = Object.freeze({
  watermark: null,
  backfillPending: false,
  emittedAtWatermark: Object.freeze([]),
});

export function emptyDiscoveryCursor(): DiscoveryCursor {
  return Object.freeze({
    schema: DISCOVERY_CURSOR_SCHEMA,
    collections: Object.freeze({}),
    lastRunAt: null,
  });
}

/**
 * Read an opaque stored cursor.
 *
 * An unrecognised or malformed cursor is treated as empty rather than as an
 * error: a fresh full crawl is always safe, whereas throwing would wedge the
 * adapter permanently on one bad row.
 */
export function parseDiscoveryCursor(raw: Record<string, unknown> | null | undefined): DiscoveryCursor {
  if (!raw || raw.schema !== DISCOVERY_CURSOR_SCHEMA) return emptyDiscoveryCursor();

  const rawCollections = raw.collections;
  if (!rawCollections || typeof rawCollections !== 'object') return emptyDiscoveryCursor();

  const collections: Record<string, CollectionCursor> = {};
  for (const [key, value] of Object.entries(rawCollections as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    const watermark = typeof entry.watermark === 'string' ? entry.watermark : null;
    const emitted = Array.isArray(entry.emittedAtWatermark)
      ? entry.emittedAtWatermark.filter((item): item is string => typeof item === 'string')
      : [];
    collections[key] = Object.freeze({
      watermark: watermark !== null && !Number.isNaN(Date.parse(watermark)) ? watermark : null,
      backfillPending: entry.backfillPending === true,
      emittedAtWatermark: Object.freeze([...emitted].sort()),
    });
  }

  return Object.freeze({
    schema: DISCOVERY_CURSOR_SCHEMA,
    collections: Object.freeze(collections),
    lastRunAt: typeof raw.lastRunAt === 'string' ? raw.lastRunAt : null,
  });
}

export function collectionCursor(cursor: DiscoveryCursor, collection: string): CollectionCursor {
  return cursor.collections[collection] ?? EMPTY_COLLECTION;
}

/**
 * Advance one collection's watermark.
 *
 * `exhausted: false` means the run was cut short by its request budget. The
 * watermark is then left where it was and `backfillPending` is set, because
 * moving it would permanently skip everything the run never looked at.
 */
export function advanceCollectionCursor(input: {
  cursor: DiscoveryCursor;
  collection: string;
  /** Highest `lastmod` actually examined in this run. */
  observedWatermark: string | null;
  /** Package ids emitted whose `lastmod` equals `observedWatermark`. */
  emittedAtWatermark: readonly string[];
  exhausted: boolean;
  nowIso: string;
}): DiscoveryCursor {
  const previous = collectionCursor(input.cursor, input.collection);

  let watermark = previous.watermark;
  let emittedAtWatermark = previous.emittedAtWatermark;

  if (input.exhausted && input.observedWatermark !== null) {
    const next = Date.parse(input.observedWatermark);
    const current = previous.watermark === null ? Number.NEGATIVE_INFINITY : Date.parse(previous.watermark);
    if (!Number.isNaN(next) && next > current) {
      // Watermark moved: the boundary set starts fresh at the new instant.
      watermark = new Date(next).toISOString();
      emittedAtWatermark = Object.freeze([...input.emittedAtWatermark].sort());
    } else if (!Number.isNaN(next) && next === current) {
      // Same boundary instant: accumulate so an inclusive comparison does not
      // re-emit what we already emitted there.
      emittedAtWatermark = Object.freeze(
        [...new Set([...previous.emittedAtWatermark, ...input.emittedAtWatermark])].sort(),
      );
    }
  }

  const collections: Record<string, CollectionCursor> = { ...input.cursor.collections };
  collections[input.collection] = Object.freeze({
    watermark,
    backfillPending: !input.exhausted,
    emittedAtWatermark,
  });

  return Object.freeze({
    schema: DISCOVERY_CURSOR_SCHEMA,
    collections: Object.freeze(collections),
    lastRunAt: input.nowIso,
  });
}

/**
 * `true` when this exact package was already emitted at the current watermark
 * instant, so an inclusive `lastmod` comparison must not emit it again.
 */
export function alreadyEmittedAtWatermark(input: {
  cursor: DiscoveryCursor;
  collection: string;
  packageId: string;
  entryLastmod: string | null;
}): boolean {
  const state = collectionCursor(input.cursor, input.collection);
  if (state.watermark === null || input.entryLastmod === null) return false;
  if (Date.parse(input.entryLastmod) !== Date.parse(state.watermark)) return false;
  return state.emittedAtWatermark.includes(input.packageId);
}

/** Serialise for the opaque store column. */
export function serialiseDiscoveryCursor(cursor: DiscoveryCursor): Record<string, unknown> {
  return {
    schema: cursor.schema,
    collections: Object.fromEntries(
      Object.entries(cursor.collections).map(([key, value]) => [
        key,
        {
          watermark: value.watermark,
          backfillPending: value.backfillPending,
          emittedAtWatermark: [...value.emittedAtWatermark],
        },
      ]),
    ),
    lastRunAt: cursor.lastRunAt,
  };
}

/** `true` when any collection still has un-examined backlog. */
export function hasPendingBackfill(cursor: DiscoveryCursor): boolean {
  return Object.values(cursor.collections).some((entry) => entry.backfillPending);
}
