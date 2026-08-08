/**
 * Phase 7 Workstream M — applying a governed override at read time.
 *
 * This is Workstream K's one unfinished piece, and it belongs here because it is
 * a read concern. K decided what a governed correction *is*: immutable,
 * versioned, author ≠ approver, two-step, stored in its own table. It
 * deliberately stopped short of making one visible, because a canonical row is
 * immutable and an override is not a canonical fact.
 *
 * The rule K established and this module implements (session-5 property 17):
 * **an override is never a source observation and never a column on a canonical
 * row. It is applied beside the snapshot, at read time, with a visible
 * provenance label.**
 *
 * ---------------------------------------------------------------------------
 * Three consequences
 * ---------------------------------------------------------------------------
 *
 * **1. The official value survives the override.**
 *
 * An overridden row carries both: `money` is what the reader should show,
 * `officialMoney` is what the government document said. Replacing one with the
 * other would make the correction unfalsifiable — nobody could see what was
 * corrected, and the next promotion's collision check would have nothing to
 * compare against. A correction that hides what it corrected is a rewrite.
 *
 * **2. A proposal is not in force.**
 *
 * `effectiveOverrideStatusV1` already encodes this and is reused rather than
 * re-decided: `proposed` is one admin's opinion, and the two-step flow exists
 * precisely so that opinion changes nothing until a second admin approves it.
 * Pending, expired, and revoked are equally not in force.
 *
 * **3. An override with no row is surfaced, not applied and not dropped.**
 *
 * If an active override targets an identity the active snapshot does not
 * contain, this module reports it as unmatched rather than synthesizing a row.
 * Synthesizing one would invent canonical lineage that does not exist —
 * verification ids, an artifact, a source document — for a value no document
 * asserts. Dropping it silently would be worse: it is exactly the "active
 * override silently overwritten by a new snapshot" that plan §K.5 forbids, just
 * moved to the read path. So it comes back as data the caller can alert on.
 */
import {
  effectiveOverrideStatusV1,
  type DefenseBudgetManualOverrideV1,
  type ManualOverrideValueV1,
} from './manual-override-v1.js';
import type { SnapshotCanonicalRowV1, SnapshotMoneyV1 } from './snapshot-read-repository-v1.js';

/* ------------------------------------------------------------------ */
/* M3.1 Shapes                                                         */
/* ------------------------------------------------------------------ */

/**
 * The label a reader sees. Carries who and why, not just that something was
 * changed: a number a client is about to act on that does not match the
 * published document must be able to explain itself without a second lookup.
 */
export interface OverrideProvenanceV1 {
  label: 'manual_override';
  overrideId: string;
  version: number;
  reason: string;
  approverActorId: string | null;
  approvedAt: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface OverrideOverlayEntryV1 {
  canonicalEntity: string;
  naturalKey: string;
  fiscalYear: number | null;
  fundingField: string | null;
  value: ManualOverrideValueV1;
  provenance: OverrideProvenanceV1;
}

/** A canonical row as a product read returns it, override applied or not. */
export interface SnapshotReadRowV1 extends SnapshotCanonicalRowV1 {
  /** Present only when a governed override is in force for this exact target. */
  override: OverrideProvenanceV1 | null;
  /** What the snapshot itself says, retained whenever `override` is present. */
  officialMoney: SnapshotMoneyV1 | null;
}

export interface OverrideOverlayResultV1 {
  rows: SnapshotReadRowV1[];
  applied: number;
  /** In-force overrides whose target is absent from the row set. */
  unmatched: OverrideOverlayEntryV1[];
}

/* ------------------------------------------------------------------ */
/* M3.2 Selecting what is in force                                     */
/* ------------------------------------------------------------------ */

/**
 * The overlay target key.
 *
 * Fiscal year and funding field are part of the identity: an override of FY2027
 * `request` must not shadow FY2028 `enacted` on the same line. Null and absent
 * collapse to the same token so a record that omits a field and one that sets it
 * null address the same target.
 */
export function overlayTargetKeyV1(target: {
  canonicalEntity: string;
  naturalKey: string;
  fiscalYear?: number | null;
  fundingField?: string | null;
}): string {
  const fy = target.fiscalYear ?? '';
  const field = target.fundingField ?? '';
  return `${target.canonicalEntity}${target.naturalKey}${fy}${field}`;
}

/**
 * The in-force overrides, one per target, highest version wins.
 *
 * A target legitimately has several rows: a correction supersedes a correction,
 * and every version is retained because history is not deleted. Only the newest
 * approved-and-in-force one describes what the value should be now — but the
 * older ones are not filtered out first, because a *revoked* newer version must
 * not let an older one come back into force. Status is evaluated per record and
 * the highest surviving version wins, so a revocation is final.
 */
export function inForceOverridesV1(
  overrides: readonly DefenseBudgetManualOverrideV1[],
  asOf: Date,
): OverrideOverlayEntryV1[] {
  const highestVersionByTarget = new Map<string, number>();
  for (const override of overrides) {
    const key = overlayTargetKeyV1(override);
    const current = highestVersionByTarget.get(key);
    if (current == null || override.version > current) {
      highestVersionByTarget.set(key, override.version);
    }
  }

  const entries: OverrideOverlayEntryV1[] = [];
  for (const override of overrides) {
    const key = overlayTargetKeyV1(override);
    if (highestVersionByTarget.get(key) !== override.version) continue;
    if (effectiveOverrideStatusV1(override, asOf) !== 'active') continue;
    entries.push({
      canonicalEntity: override.canonicalEntity,
      naturalKey: override.naturalKey,
      fiscalYear: override.fiscalYear ?? null,
      fundingField: override.fundingField ?? null,
      value: override.value,
      provenance: {
        label: 'manual_override',
        overrideId: override.overrideId,
        version: override.version,
        reason: override.governance.reason,
        approverActorId: override.governance.approverActorId ?? null,
        approvedAt: override.approvedAt ?? null,
        effectiveFrom: override.effectiveFrom,
        effectiveTo: override.effectiveTo ?? null,
      },
    });
  }
  return entries;
}

/* ------------------------------------------------------------------ */
/* M3.3 Applying                                                       */
/* ------------------------------------------------------------------ */

/**
 * Apply the overlay to a row set.
 *
 * Returns new row objects and never mutates the input. Read results are cached
 * and shared; an in-place edit here would leak one tenant's overlay into the
 * next reader of the same cached array, and an override is global rather than
 * tenant-scoped, so the bug would be invisible in a single-tenant test.
 */
export function applyOverrideOverlayV1(
  rows: readonly SnapshotCanonicalRowV1[],
  overlay: readonly OverrideOverlayEntryV1[],
): OverrideOverlayResultV1 {
  const byTarget = new Map<string, OverrideOverlayEntryV1>();
  for (const entry of overlay) byTarget.set(overlayTargetKeyV1(entry), entry);

  const matched = new Set<string>();
  let applied = 0;

  const out: SnapshotReadRowV1[] = rows.map((row) => {
    // A canonical row calls it `canonicalNaturalKey` and an override calls it
    // `naturalKey`. Mapped explicitly rather than by widening the key function's
    // parameter type, so the two names cannot quietly drift apart into a key
    // that matches nothing and an overlay that silently never applies.
    const key = overlayTargetKeyV1({
      canonicalEntity: row.canonicalEntity,
      naturalKey: row.canonicalNaturalKey,
      fiscalYear: row.fiscalYear,
      fundingField: row.fundingField,
    });
    const entry = byTarget.get(key);
    if (entry == null) return { ...row, override: null, officialMoney: null };
    matched.add(key);
    applied += 1;
    return {
      ...row,
      money: {
        originalValue: entry.value.originalValue,
        originalUnit: entry.value.originalUnit,
        valueMillions: entry.value.valueMillions,
      },
      // The canonical row hash is deliberately unchanged. It identifies the
      // government fact this row is, and an override does not make it a
      // different fact — it makes it a fact someone has corrected.
      override: entry.provenance,
      officialMoney: row.money,
    };
  });

  const unmatched = overlay.filter((entry) => !matched.has(overlayTargetKeyV1(entry)));
  return { rows: out, applied, unmatched };
}
