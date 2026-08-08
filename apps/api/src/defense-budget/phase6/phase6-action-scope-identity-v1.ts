/**
 * Phase 7 Gap 5 decision B3 — the one genuine Phase 6 semantic addition in this
 * pass. Everything else in Gap 5/B is plumbing; this is a real identity design.
 *
 * `buildStageActionProjectionV1` (`phase6-projection-builder-v1.ts`) has only
 * ever handled identity-scoped actions — one native line, via
 * `nativeIdentityHashV1(BudgetLineIdentityV1)` — and refused everything else
 * with `no_single_native_identity`. `DefenseBudgetStageActionV1` has always
 * carried `packageScope`/`accountScope` (bare strings) and
 * `sourceIdentity`/`destinationIdentity` (for a two-sided transfer), but
 * nothing ever turned them into a stable identity a `canonical_stage_action`
 * natural key could lead with. This module is that identity.
 *
 * Three kinds, matching the three shapes `defense-budget-stage-action-v1.ts`'s
 * own schema already recognizes as valid "primary scope" or "transfer
 * endpoints" — this does not invent a fourth shape, it names the three that
 * already exist:
 *
 *   PACKAGE       — `packageScope` is set. Scoped to (packageScope, vehicleClass,
 *                    fiscalYear, stage) — `vehicleClass` because it is the real
 *                    field the action already carries for "which vehicle", not
 *                    a fabricated per-instance vehicle ID.
 *   ACCOUNT       — `accountScope` is set. Scoped to (accountScope, fiscalYear,
 *                    stage). Deliberately not split into component +
 *                    appropriation-account substructure the upstream data does
 *                    not provide — inventing that split would be inferring an
 *                    account, which is explicitly forbidden.
 *   TRANSFER_PAIR — both `sourceIdentity` and `destinationIdentity` are set on
 *                    the same action row, i.e. a genuine two-sided transfer
 *                    event. Scoped to (from, to, fiscalYear, stage), each end a
 *                    full `BudgetLineIdentityV1`. A→B and B→A hash differently
 *                    by construction, since `from`/`to` are ordered fields, not
 *                    a sorted pair.
 *
 * What this deliberately does NOT cover: an action carrying only ONE of
 * `sourceIdentity`/`destinationIdentity` (one leg of a transfer with the other
 * endpoint unknown to this row) has no complete identity here and must be
 * refused — see `deriveActionScopeIdentityV1`'s `incomplete_transfer_endpoint`
 * result. That is the schema's own "requires transfer endpoints" branch
 * admitting a shape narrower than the action's own validation requires; this
 * module does not fabricate the missing side.
 *
 * "Implemented transfer" (an actual movement of funds, `TRANSFER_PAIR`) and
 * "transfer authority" (a general provision that merely permits a transfer,
 * which has no two-sided identity at all — it is package- or account-scoped,
 * or has no scope beyond the provision itself) are kept distinct on purpose:
 * a `general_provision` or `directive` action type never reaches this module's
 * TRANSFER_PAIR branch, because it will not carry both endpoint identities.
 */
import { z } from 'zod';
import { sha256Hex } from '../contracts/canonical-json.js';
import {
  budgetLineIdentityV1Schema,
  type BudgetLineIdentityV1,
} from '../contracts/extraction-artifact-v1.js';
import { nativeIdentityKeyV1 } from '../stages/budget-line-reference-v1.js';
import { stageV1Schema, type StageV1 } from '../stages/stage-vocabulary-v1.js';

const nonBlank = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: 'must be nonblank',
  });

export const PHASE6_ACTION_VEHICLE_CLASS_V1_VALUES = [
  'committee_report',
  'conference_report',
  'joint_explanatory_statement',
  'public_law',
  'reprogramming_document',
  'execution_source',
] as const;
export const phase6ActionVehicleClassV1Schema = z.enum(PHASE6_ACTION_VEHICLE_CLASS_V1_VALUES);
export type Phase6ActionVehicleClassV1 = z.infer<typeof phase6ActionVehicleClassV1Schema>;

const packageScopeSchema = z
  .object({
    kind: z.literal('PACKAGE'),
    packageScope: nonBlank,
    vehicleClass: phase6ActionVehicleClassV1Schema,
    fiscalYear: z.number().int().min(1900).max(2200),
    stage: stageV1Schema,
  })
  .strict();

const accountScopeSchema = z
  .object({
    kind: z.literal('ACCOUNT'),
    accountScope: nonBlank,
    fiscalYear: z.number().int().min(1900).max(2200),
    stage: stageV1Schema,
  })
  .strict();

const transferPairSchema = z
  .object({
    kind: z.literal('TRANSFER_PAIR'),
    from: budgetLineIdentityV1Schema,
    to: budgetLineIdentityV1Schema,
    fiscalYear: z.number().int().min(1900).max(2200),
    stage: stageV1Schema,
  })
  .strict();

export const phase6ActionScopeIdentityV1Schema = z.discriminatedUnion('kind', [
  packageScopeSchema,
  accountScopeSchema,
  transferPairSchema,
]);
export type Phase6ActionScopeIdentityV1 = z.infer<typeof phase6ActionScopeIdentityV1Schema>;

/**
 * The natural-key string for a scope identity, in the same
 * `TAG:field:field:...` shape `nativeIdentityKeyV1` uses for a single line —
 * so a promotion trace reads a scope identity's key exactly the way it already
 * reads a native line's, just with a different tag.
 *
 * `TRANSFER_PAIR` is deliberately NOT order-normalized (no sorting `from`/`to`).
 * A→B and B→A are different movements and must key differently — sorting them
 * into a canonical pair order would be exactly the "direction doesn't matter"
 * bug this contract exists to prevent.
 */
export function phase6ActionScopeIdentityKeyV1(identity: Phase6ActionScopeIdentityV1): string {
  switch (identity.kind) {
    case 'PACKAGE':
      return [
        'PHASE6_PACKAGE',
        identity.packageScope,
        identity.vehicleClass,
        identity.fiscalYear,
        identity.stage,
      ].join(':');
    case 'ACCOUNT':
      return ['PHASE6_ACCOUNT', identity.accountScope, identity.fiscalYear, identity.stage].join(
        ':',
      );
    case 'TRANSFER_PAIR':
      return [
        'PHASE6_TRANSFER_PAIR',
        nativeIdentityKeyV1(identity.from),
        nativeIdentityKeyV1(identity.to),
        identity.fiscalYear,
        identity.stage,
      ].join(':');
  }
}

export function phase6ActionScopeIdentityHashV1(identity: Phase6ActionScopeIdentityV1): string {
  return sha256Hex(phase6ActionScopeIdentityKeyV1(identity));
}

/* ------------------------------------------------------------------ */
/* Derivation from the action's own already-existing scope fields      */
/* ------------------------------------------------------------------ */

export const ACTION_SCOPE_DERIVATION_REFUSAL_V1_VALUES = [
  /**
   * Exactly one of `sourceIdentity`/`destinationIdentity` was set. This row
   * names one leg of a transfer without the other end, and this module does
   * not fabricate the missing side — a title, an inferred mirror account, or a
   * "the other 50%" guess are all exactly what "do not infer an account" and
   * "do not use titles as identity" forbid.
   */
  'incomplete_transfer_endpoint',
  /** No primary scope and no transfer endpoints at all — same input, wrong module. */
  'no_scope_present',
] as const;
export type ActionScopeDerivationRefusalV1 =
  (typeof ACTION_SCOPE_DERIVATION_REFUSAL_V1_VALUES)[number];

export type ActionScopeDerivationResultV1 =
  | { ok: true; identity: Phase6ActionScopeIdentityV1 }
  | { ok: false; reason: ActionScopeDerivationRefusalV1; detail: string };

export interface ActionScopeSourceV1 {
  packageScope?: string;
  accountScope?: string;
  sourceIdentity?: BudgetLineIdentityV1;
  destinationIdentity?: BudgetLineIdentityV1;
  vehicleClass: Phase6ActionVehicleClassV1;
  fiscalYear: number;
  stage: StageV1;
}

/**
 * Derives a scope identity for an action that has no single native
 * `identity` — the caller (`buildStageActionProjectionV1`) still checks
 * `action.identity` first and only reaches this for the remaining three
 * shapes. Order matches `defense-budget-stage-action-v1.ts`'s own primary-scope
 * precedence: package, then account, then transfer endpoints.
 */
export function deriveActionScopeIdentityV1(
  source: ActionScopeSourceV1,
): ActionScopeDerivationResultV1 {
  if (source.packageScope != null) {
    return {
      ok: true,
      identity: {
        kind: 'PACKAGE',
        packageScope: source.packageScope,
        vehicleClass: source.vehicleClass,
        fiscalYear: source.fiscalYear,
        stage: source.stage,
      },
    };
  }
  if (source.accountScope != null) {
    return {
      ok: true,
      identity: {
        kind: 'ACCOUNT',
        accountScope: source.accountScope,
        fiscalYear: source.fiscalYear,
        stage: source.stage,
      },
    };
  }
  if (source.sourceIdentity != null && source.destinationIdentity != null) {
    return {
      ok: true,
      identity: {
        kind: 'TRANSFER_PAIR',
        from: source.sourceIdentity,
        to: source.destinationIdentity,
        fiscalYear: source.fiscalYear,
        stage: source.stage,
      },
    };
  }
  if (source.sourceIdentity != null || source.destinationIdentity != null) {
    return {
      ok: false,
      reason: 'incomplete_transfer_endpoint',
      detail:
        'action names only one side of a transfer (source or destination, not both); the other ' +
        'endpoint is not on this row and will not be inferred',
    };
  }
  return {
    ok: false,
    reason: 'no_scope_present',
    detail: 'action carries no package scope, account scope, or transfer endpoints',
  };
}
