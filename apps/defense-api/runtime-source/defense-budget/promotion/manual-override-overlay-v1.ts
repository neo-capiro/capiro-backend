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
 */
import {
  effectiveOverrideStatusV1,
  type DefenseBudgetManualOverrideV1,
  type ManualOverrideValueV1,
} from './manual-override-v1.js';
import type { SnapshotCanonicalRowV1, SnapshotMoneyV1 } from './snapshot-read-repository-v1.js';

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

export interface SnapshotReadRowV1 extends SnapshotCanonicalRowV1 {
  override: OverrideProvenanceV1 | null;
  officialMoney: SnapshotMoneyV1 | null;
}

export interface OverrideOverlayResultV1 {
  rows: SnapshotReadRowV1[];
  applied: number;
  unmatched: OverrideOverlayEntryV1[];
}

export function overlayTargetKeyV1(target: {
  canonicalEntity: string;
  naturalKey: string;
  fiscalYear?: number | null;
  fundingField?: string | null;
}): string {
  const fy = target.fiscalYear ?? '';
  const field = target.fundingField ?? '';
  return `${target.canonicalEntity}\u0001${target.naturalKey}\u0001${fy}\u0001${field}`;
}

function toOverlayEntryV1(override: DefenseBudgetManualOverrideV1): OverrideOverlayEntryV1 {
  return {
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
  };
}

/**
 * Select the governed value in force for each target.
 *
 * The lifecycle order is deliberate:
 *
 * - A **proposal is invisible** to product reads and does not supersede an
 *   already-approved version. Otherwise one administrator could change the
 *   product merely by proposing v2, defeating the independent-approval rule.
 * - An **approved future-dated** version also does not erase the currently
 *   active predecessor before its effectiveFrom. The predecessor remains in
 *   force until the approved replacement actually starts.
 * - A **revoked** newest decided version terminates the chain. It must never
 *   resurrect an older correction.
 * - An **expired** newest decided version also terminates the chain; expiry ends
 *   the governed correction rather than reviving the value it superseded.
 *
 * This means version ordering is evaluated together with lifecycle state, not
 * as "pick the highest version first, then ask if it is active". That previous
 * ordering let a proposed v2 suppress an approved v1 and made proposal itself a
 * user-visible mutation.
 */
export function inForceOverridesV1(
  overrides: readonly DefenseBudgetManualOverrideV1[],
  asOf: Date,
): OverrideOverlayEntryV1[] {
  const byTarget = new Map<string, DefenseBudgetManualOverrideV1[]>();
  for (const override of overrides) {
    const key = overlayTargetKeyV1(override);
    const group = byTarget.get(key) ?? [];
    group.push(override);
    byTarget.set(key, group);
  }

  const entries: OverrideOverlayEntryV1[] = [];
  for (const group of byTarget.values()) {
    const ordered = [...group].sort((a, b) => b.version - a.version);
    for (const override of ordered) {
      const status = effectiveOverrideStatusV1(override, asOf);

      // A proposal has no governing effect at all. Continue to the prior
      // approved version, if one exists.
      if (status === 'proposed') continue;

      // A future approved replacement has been decided, but is not yet in
      // force. Keep the predecessor visible until effectiveFrom.
      if (status === 'pending') continue;

      // Revocation or expiry is terminal for the decided chain: do not revive
      // a superseded older correction.
      if (status === 'revoked' || status === 'expired') break;

      entries.push(toOverlayEntryV1(override));
      break;
    }
  }

  return entries.sort((a, b) => overlayTargetKeyV1(a).localeCompare(overlayTargetKeyV1(b)));
}

function existingOverlayFieldsV1(row: SnapshotCanonicalRowV1): {
  override: OverrideProvenanceV1 | null;
  officialMoney: SnapshotMoneyV1 | null;
} | null {
  const candidate = row as SnapshotCanonicalRowV1 & Partial<SnapshotReadRowV1>;
  if (!Object.prototype.hasOwnProperty.call(candidate, 'override')) return null;
  return {
    override: candidate.override ?? null,
    officialMoney: candidate.officialMoney ?? null,
  };
}

export function applyOverrideOverlayV1(
  rows: readonly SnapshotCanonicalRowV1[],
  overlay: readonly OverrideOverlayEntryV1[],
): OverrideOverlayResultV1 {
  const byTarget = new Map<string, OverrideOverlayEntryV1>();
  for (const entry of overlay) byTarget.set(overlayTargetKeyV1(entry), entry);

  const matched = new Set<string>();
  let applied = 0;

  const out: SnapshotReadRowV1[] = rows.map((row) => {
    const key = overlayTargetKeyV1({
      canonicalEntity: row.canonicalEntity,
      naturalKey: row.canonicalNaturalKey,
      fiscalYear: row.fiscalYear,
      fundingField: row.fundingField,
    });
    const entry = byTarget.get(key);
    if (entry == null) {
      // A lower read layer may already have applied the governed overlay. An
      // empty second overlay must not erase its provenance/official value.
      const existing = existingOverlayFieldsV1(row);
      return existing == null ? { ...row, override: null, officialMoney: null } : { ...row, ...existing };
    }

    matched.add(key);
    applied += 1;
    return {
      ...row,
      money: {
        originalValue: entry.value.originalValue,
        originalUnit: entry.value.originalUnit,
        valueMillions: entry.value.valueMillions,
      },
      override: entry.provenance,
      officialMoney: row.money,
    };
  });

  const unmatched = overlay.filter((entry) => !matched.has(overlayTargetKeyV1(entry)));
  return { rows: out, applied, unmatched };
}
