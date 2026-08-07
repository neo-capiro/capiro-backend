/**
 * Phase 7 Workstream K — `defense_budget_manual_override_v1`.
 *
 * A governed human correction to a canonical value, held as an immutable
 * overlay *beside* the snapshot rather than inside it.
 *
 * Three properties make it safe:
 *
 * 1. **An override is never a government source observation.** The legacy path
 *    wrote a human decision through the PE writer under a `manual_override`
 *    source string, which made it indistinguishable from a parsed J-book line
 *    and let it flip a winner flag. An override here targets a canonical
 *    identity and is applied at read time with its own provenance label, so
 *    government truth and human judgement never merge.
 * 2. **The author may not be the approver.** Enforced inside the schema, the
 *    same way `promotion-authorization-v1.ts` enforces authorizer≠reviewer, so
 *    a caller cannot skip it by forgetting to invoke a checker.
 * 3. **Records are immutable and versioned.** Revoking or amending an override
 *    supersedes it with a new version that links back through
 *    `priorOverrideId`; nothing is edited or deleted, so the history of who
 *    changed a published number and why stays auditable.
 *
 * Expiry is *derived*, never stored as a mutable flag — an override does not
 * silently stay active because a background job failed to run. `status` records
 * only the decisions a human made (`approved` / `revoked`); whether an approved
 * override is in force at a given instant is a question about its dates, and
 * `effectiveOverrideStatusV1` answers it.
 *
 * This module holds no money as a JavaScript number. Values are canonical
 * decimal strings, exactly as the canonical row carries them.
 */
import { z } from 'zod';
import { sha256CanonicalJson, stripUndefinedProperties } from '../contracts/canonical-json.js';
import { isCanonicalDecimalString } from '../contracts/decimal-string.js';
import {
  CANONICAL_ENTITY_V1_VALUES,
  type CanonicalEntityV1,
} from './canonical-mapping-registry-v1.js';
import {
  FUNDING_FIELD_V1_VALUES,
  MONEY_UNIT_V1_VALUES,
} from '../contracts/extraction-artifact-v1.js';
import type { ManualOverlayV1 } from './promotion-planner-v1.js';

export const DEFENSE_BUDGET_MANUAL_OVERRIDE_SCHEMA_VERSION =
  'defense_budget_manual_override_v1' as const;

const nonBlank = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, { message: 'must be nonblank' });

/** An ISO-8601 instant. Compared as instants, never as strings. */
const isoInstant = z.string().refine((value) => Number.isFinite(Date.parse(value)), {
  message: 'must be an ISO-8601 instant',
});

const canonicalDecimal = z
  .string()
  .refine(isCanonicalDecimalString, { message: 'must be a canonical decimal string' });

/* ------------------------------------------------------------------ */
/* K1. The overridden value                                            */
/* ------------------------------------------------------------------ */

/**
 * What the override asserts the value should be. Mirrors `CanonicalMoneyV1`:
 * the printed figure, its unit, and the normalized millions figure travel
 * together so nothing downstream has to reconstruct one from another.
 */
export const manualOverrideValueV1Schema = z
  .object({
    originalValue: canonicalDecimal,
    originalUnit: z.enum(MONEY_UNIT_V1_VALUES),
    valueMillions: canonicalDecimal,
  })
  .strict();
export type ManualOverrideValueV1 = z.infer<typeof manualOverrideValueV1Schema>;

/* ------------------------------------------------------------------ */
/* K2. Governance                                                      */
/* ------------------------------------------------------------------ */

/**
 * Who authored the correction and who approved it, recorded at approval time
 * so the separation stays auditable without re-deriving it from mutable role
 * tables — the same reason `PromotionSegregationEvidenceV1` is stored.
 */
export const manualOverrideGovernanceV1Schema = z
  .object({
    authorActorId: nonBlank,
    approverActorId: nonBlank,
    approverRole: z.literal('capiro_admin'),
    /** Free-text justification. An override with no stated reason is refused. */
    reason: nonBlank,
    /**
     * Evidence for the correction — a data-issue ID, a corrected source
     * document, a ticket. Deduplicated and sorted so the record hash does not
     * depend on the order a caller happened to supply them in.
     */
    evidenceIds: z
      .array(nonBlank)
      .min(1)
      .transform((values) => [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))),
    /** Optional change-request/ticket reference, mirroring authorization. */
    changeRequestRef: nonBlank.nullish(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.authorActorId === value.approverActorId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a manual override may not be approved by its own author',
        path: ['approverActorId'],
      });
    }
  });
export type ManualOverrideGovernanceV1 = z.infer<typeof manualOverrideGovernanceV1Schema>;

/* ------------------------------------------------------------------ */
/* K3. The override record                                             */
/* ------------------------------------------------------------------ */

/**
 * Decisions a human made. Expiry is deliberately absent: it is a function of
 * `effectiveTo` and the current instant, not a state someone has to remember to
 * write. See `effectiveOverrideStatusV1`.
 */
export const MANUAL_OVERRIDE_STATUS_V1_VALUES = ['approved', 'revoked'] as const;
export type ManualOverrideStatusV1 = (typeof MANUAL_OVERRIDE_STATUS_V1_VALUES)[number];

export const defenseBudgetManualOverrideV1Schema = z
  .object({
    schemaVersion: z.literal(DEFENSE_BUDGET_MANUAL_OVERRIDE_SCHEMA_VERSION),
    overrideId: nonBlank,

    /* Target — a canonical identity, never a legacy peCode. */
    canonicalEntity: z.enum(CANONICAL_ENTITY_V1_VALUES),
    naturalKey: nonBlank,
    fiscalYear: z.number().int().nullish(),
    fundingField: z.enum(FUNDING_FIELD_V1_VALUES).nullish(),

    value: manualOverrideValueV1Schema,
    governance: manualOverrideGovernanceV1Schema,

    status: z.enum(MANUAL_OVERRIDE_STATUS_V1_VALUES),
    /** Monotonic per target identity. A correction supersedes, never edits. */
    version: z.number().int().positive(),
    /** The override this one supersedes, when it is not the first. */
    priorOverrideId: nonBlank.nullish(),

    effectiveFrom: isoInstant,
    /** Open-ended when null. */
    effectiveTo: isoInstant.nullish(),
    approvedAt: isoInstant,
    /** Set only when `status` is `revoked`; the record itself stays immutable. */
    revokedAt: isoInstant.nullish(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.effectiveTo != null &&
      Date.parse(value.effectiveTo) <= Date.parse(value.effectiveFrom)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'effectiveTo must be after effectiveFrom',
        path: ['effectiveTo'],
      });
    }
    if (value.status === 'revoked' && value.revokedAt == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a revoked override must record when it was revoked',
        path: ['revokedAt'],
      });
    }
    if (value.status !== 'revoked' && value.revokedAt != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'only a revoked override may carry a revocation timestamp',
        path: ['revokedAt'],
      });
    }
    if (value.version === 1 && value.priorOverrideId != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'the first version of an override supersedes nothing',
        path: ['priorOverrideId'],
      });
    }
    if (value.version > 1 && value.priorOverrideId == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a superseding override must link the version it replaces',
        path: ['priorOverrideId'],
      });
    }
  });
export type DefenseBudgetManualOverrideV1 = z.infer<typeof defenseBudgetManualOverrideV1Schema>;

export function parseManualOverrideV1(input: unknown): DefenseBudgetManualOverrideV1 {
  return defenseBudgetManualOverrideV1Schema.parse(input);
}

/* ------------------------------------------------------------------ */
/* K4. Effective status                                                */
/* ------------------------------------------------------------------ */

/**
 * Whether an override is in force at `asOf`.
 *
 * Revocation beats dates — a revoked override is revoked even inside its
 * effective window. `pending` is distinct from `expired` so a future-dated
 * correction is never mistaken for one that has lapsed.
 */
export function effectiveOverrideStatusV1(
  override: DefenseBudgetManualOverrideV1,
  asOf: Date,
): 'active' | 'expired' | 'revoked' | 'pending' {
  if (override.status === 'revoked') return 'revoked';
  const instant = asOf.getTime();
  if (instant < Date.parse(override.effectiveFrom)) return 'pending';
  if (override.effectiveTo != null && instant >= Date.parse(override.effectiveTo)) return 'expired';
  return 'active';
}

/**
 * Adapt a governed override to the overlay shape the planner already diffs.
 *
 * The collision policy itself is Workstream C's and is already tested: an
 * `active` overlay whose official value *changes* beneath it blocks with
 * `manual_override_collision`, while an unchanged value does not. K's job is to
 * decide which overrides are active at plan time, not to re-decide what a
 * collision means. `pending` maps to `expired` because both mean "not in force,
 * do not defend" — the planner has no third state and does not need one.
 */
export function toManualOverlayV1(
  override: DefenseBudgetManualOverrideV1,
  asOf: Date,
): ManualOverlayV1 {
  const effective = effectiveOverrideStatusV1(override, asOf);
  return {
    canonicalEntity: override.canonicalEntity as CanonicalEntityV1,
    naturalKey: override.naturalKey,
    fiscalYear: override.fiscalYear ?? null,
    fundingField: override.fundingField ?? null,
    status: effective === 'active' ? 'active' : effective === 'revoked' ? 'revoked' : 'expired',
  };
}

/* ------------------------------------------------------------------ */
/* K5. Identity and immutability                                       */
/* ------------------------------------------------------------------ */

/**
 * Deterministic hash of an override record, for append-only storage and for
 * proving a stored row was not edited in place.
 */
export function manualOverrideHashV1(override: DefenseBudgetManualOverrideV1): string {
  return sha256CanonicalJson(
    stripUndefinedProperties(override as unknown as Record<string, unknown>) as never,
  );
}

/**
 * The identity an override defends, as a single comparable key, over the same
 * four coordinates the planner keys overlays on.
 *
 * Serialized rather than delimiter-joined: natural keys here are themselves
 * pipe-delimited (`ARMY|OMA|SAG-111`), so any printable separator risks two
 * distinct targets colliding on one key. The planner solves this with a NUL
 * delimiter, which is correct but makes its source file read as binary to
 * ripgrep and silently skippable by a repo-wide search - not a property worth
 * copying into a second file.
 */
export function manualOverrideTargetKeyV1(
  override: Pick<
    DefenseBudgetManualOverrideV1,
    'canonicalEntity' | 'naturalKey' | 'fiscalYear' | 'fundingField'
  >,
): string {
  return JSON.stringify([
    override.canonicalEntity,
    override.naturalKey,
    override.fiscalYear ?? null,
    override.fundingField ?? null,
  ]);
}
