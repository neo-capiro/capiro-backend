/**
 * Phase 7 Workstream M — grouping canonical rows by parent, at read time.
 *
 * `SnapshotReadPortV1.loadRows` is deliberately generic: it returns a flat list
 * of rows for whatever entities/keys a query asks for, with no join or hierarchy
 * baked in (see `snapshot-read-repository-v1.ts`'s own docstring). Every family
 * that assembles a parent-with-children response — a PE with its years, a
 * project with its performers — needs the same grouping step. Putting it here,
 * once, generically, means procurement/O&M/MILCON get it for free later instead
 * of each family reinventing a `Map` build-up.
 *
 * Grouping is by the row's own `parentNaturalKey` field, never by parsing
 * `canonicalNaturalKey` apart. Natural-key string formats are ad hoc per entity
 * (pipe-delimited today, unescaped, and at least one family's real format
 * disagrees with its own registry documentation) — parsing them back into
 * components is fragile in a way reading a dedicated field is not.
 */
import type { SnapshotCanonicalRowV1 } from './snapshot-read-repository-v1.js';

/**
 * Groups rows by `parentNaturalKey`. Rows whose `parentNaturalKey` is `null`
 * (root entities, e.g. the PE identity row itself) are returned separately under
 * `roots` rather than under a `null`/`''` bucket, so a caller cannot accidentally
 * treat "no parent" as if it were a parent key of its own.
 */
export interface GroupedSnapshotRowsV1<
  TRow extends SnapshotCanonicalRowV1 = SnapshotCanonicalRowV1,
> {
  roots: TRow[];
  byParent: Map<string, TRow[]>;
}

export function groupSnapshotRowsByParentV1<TRow extends SnapshotCanonicalRowV1>(
  rows: readonly TRow[],
): GroupedSnapshotRowsV1<TRow> {
  const roots: TRow[] = [];
  const byParent = new Map<string, TRow[]>();
  for (const row of rows) {
    if (row.parentNaturalKey == null) {
      roots.push(row);
      continue;
    }
    const bucket = byParent.get(row.parentNaturalKey);
    if (bucket) bucket.push(row);
    else byParent.set(row.parentNaturalKey, [row]);
  }
  return { roots, byParent };
}

/**
 * Indexes rows by their own natural key. Only safe when the caller already
 * knows the row set is scoped to one `canonicalEntity` (a natural key is unique
 * within an entity, not across entities) — mixing entities in would let one
 * entity's row silently overwrite another's under a colliding key string.
 *
 * Returns every row under each key, not just the first: a natural key is unique
 * per snapshot for a given entity, so more than one row under the same key means
 * either two different entities were mixed in (caller error) or a real
 * duplicate-key defect upstream — either way the caller should see all of them
 * rather than have one silently dropped.
 */
export function indexSnapshotRowsByNaturalKeyV1<TRow extends SnapshotCanonicalRowV1>(
  rows: readonly TRow[],
): Map<string, TRow[]> {
  const byKey = new Map<string, TRow[]>();
  for (const row of rows) {
    const bucket = byKey.get(row.canonicalNaturalKey);
    if (bucket) bucket.push(row);
    else byKey.set(row.canonicalNaturalKey, [row]);
  }
  return byKey;
}
