/**
 * Phase 6 Workstream D — stage row emitter.
 *
 * Converts a normalized CongressionalTableV1 plus resolved line bindings into
 * the four things a stage document can truthfully produce: absolute funding
 * positions, non-owning request baselines, typed actions, and explicit
 * omissions.
 *
 * Shared deliberately across the stage workstreams (HASC, SASC, HAC-D, SAC-D,
 * conference). Senate and House layouts differ, but the money, identity, and
 * ownership rules must not fork.
 *
 * Invariants enforced here:
 *   - the funding field is derived from the profile's authority and can never be
 *     chosen by a caller;
 *   - a request value printed in a later-stage table is a comparison baseline and
 *     never transfers request ownership;
 *   - only an `accepted` binding may produce a position — candidate, conflicting,
 *     and unresolved bindings become omissions and cannot machine-pass;
 *   - an action row never becomes an absolute position;
 *   - action rows accept delta semantics only; an absolute total on an action row
 *     is rejected rather than reinterpreted;
 *   - a unit the profile does not declare is rejected rather than inferred;
 *   - a `narrative_only` table produces no money at all, and `totals_only`
 *     forbids deriving a total from a change;
 *   - anything that cannot be emitted truthfully is recorded as a typed omission
 *     rather than dropped.
 */
import type { FundingFieldV1, MoneyUnitV1 } from '../contracts/extraction-artifact-v1.js';
import type { BudgetLineIdentityV1 } from '../contracts/extraction-artifact-v1.js';
import {
  bindingMachinePassAllowed,
  type ResolvedBudgetLineBindingV1,
} from './budget-line-reference-v1.js';
import {
  ACTION_ROW_KINDS,
  DELTA_MONEY_SEMANTICS,
  deriveAbsolutePositionV1,
  rowMoneyV1,
  type CongressionalRowV1,
  type CongressionalTableV1,
  type MoneySemanticV1,
  type RowSemanticKindV1,
} from './congressional-table-v1.js';
import type { DefenseBudgetStageSourceProfileV1 } from './stage-source-profile-v1.js';
import { STAGE_AUTHORITY_FIELD } from './stage-vocabulary-v1.js';

/* ------------------------------------------------------------------ */
/* outputs                                                             */
/* ------------------------------------------------------------------ */

export interface StagePositionV1 {
  identity: BudgetLineIdentityV1;
  /** Derived from the profile authority. Never caller-supplied. */
  field: FundingFieldV1;
  fiscalYear?: number;
  value: string;
  unit: MoneyUnitV1;
  /** `direct` when printed as a total; `derived` when summed from baseline+change. */
  provenance: 'direct' | 'derived';
  /** Retained for derived values so the arithmetic is auditable. */
  derivation?: { baseline: string; change: string };
  rowIndex: number;
  page: number;
  printedPage?: string;
}

/**
 * A request figure reprinted for comparison. Deliberately not a position: it
 * carries no `field`, so it cannot be written into a funding column.
 */
export interface StageBaselineFactV1 {
  identity: BudgetLineIdentityV1;
  fiscalYear?: number;
  value: string;
  unit: MoneyUnitV1;
  rowIndex: number;
  page: number;
  comparisonOnly: true;
}

export interface StageActionDraftV1 {
  identity: BudgetLineIdentityV1;
  rowKind: RowSemanticKindV1;
  semantic: MoneySemanticV1;
  amount: string;
  unit: MoneyUnitV1;
  fiscalYear?: number;
  rowIndex: number;
  page: number;
}

export const STAGE_OMISSION_REASON_V1_VALUES = [
  'binding_not_accepted',
  'no_absolute_position',
  'undeclared_unit',
  'narrative_policy_forbids_money',
  'totals_only_policy_forbids_derivation',
  'row_not_interpretable',
] as const;
export type StageOmissionReasonV1 = (typeof STAGE_OMISSION_REASON_V1_VALUES)[number];

export interface StageOmissionV1 {
  rowIndex: number;
  page: number;
  reason: StageOmissionReasonV1;
  /** Exact printed label, retained as evidence. */
  rawLabel: string;
  detail?: string;
}

export interface StageEmissionV1 {
  field: FundingFieldV1;
  positions: StagePositionV1[];
  baselines: StageBaselineFactV1[];
  actions: StageActionDraftV1[];
  omissions: StageOmissionV1[];
}

/* ------------------------------------------------------------------ */
/* emitter                                                             */
/* ------------------------------------------------------------------ */

export interface StageEmitInput {
  profile: DefenseBudgetStageSourceProfileV1;
  table: CongressionalTableV1;
  /** Resolved binding per row index, from the Workstream B resolver. */
  bindingsByRowIndex: ReadonlyMap<number, ResolvedBudgetLineBindingV1>;
}

/**
 * Emit every truthful fact a stage table supports.
 *
 * Every row produces exactly one outcome: a position, an action, or an
 * omission. Baselines are additional, never a substitute for a position.
 */
export function emitStageRowsV1(input: StageEmitInput): StageEmissionV1 {
  const { profile, table, bindingsByRowIndex } = input;
  const field = STAGE_AUTHORITY_FIELD[profile.authority];
  const declaredUnits = new Set<MoneyUnitV1>(profile.declaredUnits);
  const allowDerivation = profile.tableSemanticsPolicy === 'header_required';
  const moneyForbidden = profile.tableSemanticsPolicy === 'narrative_only';

  const out: StageEmissionV1 = {
    field,
    positions: [],
    baselines: [],
    actions: [],
    omissions: [],
  };

  for (const row of table.rows) {
    const omit = (reason: StageOmissionReasonV1, detail?: string): void => {
      out.omissions.push({
        rowIndex: row.rowIndex,
        page: table.page,
        reason,
        rawLabel: row.rawLabel,
        ...(detail != null ? { detail } : {}),
      });
    };

    if (moneyForbidden) {
      omit('narrative_policy_forbids_money');
      continue;
    }

    const binding = bindingsByRowIndex.get(row.rowIndex);
    if (!binding || !bindingMachinePassAllowed(binding) || binding.targetIdentity == null) {
      omit('binding_not_accepted', binding?.status ?? 'no_binding');
      continue;
    }
    const identity = binding.targetIdentity;

    /* Request baselines are recorded regardless of what else the row yields,
     * and never as a position. */
    for (const money of rowMoneyV1(table, row)) {
      if (money.semantic !== 'request_baseline') continue;
      if (!declaredUnits.has(money.unit)) continue;
      out.baselines.push({
        identity,
        ...(money.fiscalYear != null ? { fiscalYear: money.fiscalYear } : {}),
        value: money.value,
        unit: money.unit,
        rowIndex: row.rowIndex,
        page: table.page,
        comparisonOnly: true,
      });
    }

    if (ACTION_ROW_KINDS.includes(row.semanticKind)) {
      const actionMoney = rowMoneyV1(table, row).filter(
        (money) => money.semantic !== 'request_baseline',
      );
      if (actionMoney.length === 0) {
        omit('row_not_interpretable', `action row ${row.semanticKind} carries no amount`);
        continue;
      }
      const invalidSemantics = actionMoney.filter(
        (money) => !DELTA_MONEY_SEMANTICS.includes(money.semantic),
      );
      if (invalidSemantics.length > 0) {
        omit(
          'row_not_interpretable',
          `action row ${row.semanticKind} carries absolute semantic(s): ${invalidSemantics
            .map((money) => money.semantic)
            .join(',')}`,
        );
        continue;
      }
      for (const money of actionMoney) {
        if (!declaredUnits.has(money.unit)) {
          omit('undeclared_unit', money.unit);
          continue;
        }
        out.actions.push({
          identity,
          rowKind: row.semanticKind,
          semantic: money.semantic,
          amount: money.value,
          unit: money.unit,
          ...(money.fiscalYear != null ? { fiscalYear: money.fiscalYear } : {}),
          rowIndex: row.rowIndex,
          page: table.page,
        });
      }
      continue;
    }

    const derivation = deriveAbsolutePositionV1(table, row, {
      allowBaselinePlusChange: allowDerivation,
    });
    if (derivation.status === 'blocked') {
      if (
        derivation.reason === 'policy_forbids_derivation' ||
        (!allowDerivation && derivation.reason === 'no_baseline')
      ) {
        omit('totals_only_policy_forbids_derivation', derivation.reason);
      } else {
        omit('no_absolute_position', derivation.reason);
      }
      continue;
    }
    if (!declaredUnits.has(derivation.unit)) {
      omit('undeclared_unit', derivation.unit);
      continue;
    }

    out.positions.push({
      identity,
      field,
      ...(derivation.fiscalYear != null ? { fiscalYear: derivation.fiscalYear } : {}),
      value: derivation.value,
      unit: derivation.unit,
      provenance: derivation.status,
      ...(derivation.status === 'derived'
        ? { derivation: { baseline: derivation.baseline, change: derivation.change } }
        : {}),
      rowIndex: row.rowIndex,
      page: table.page,
      ...(table.printedPage != null ? { printedPage: table.printedPage } : {}),
    });
  }

  return out;
}

/**
 * Coverage of an emission by native line kind, for the stage coverage report.
 * Counts positions only: baselines and actions are not coverage of a line.
 */
export function stageCoverageByLineKindV1(
  emission: StageEmissionV1,
): Record<BudgetLineIdentityV1['lineKind'], number> {
  const counts = {
    RDTE_PE: 0,
    PROCUREMENT_BLIN: 0,
    OM_SAG: 0,
    MILCON_PROJECT: 0,
    UNKNOWN: 0,
  } as Record<BudgetLineIdentityV1['lineKind'], number>;
  for (const position of emission.positions) counts[position.identity.lineKind] += 1;
  return counts;
}
