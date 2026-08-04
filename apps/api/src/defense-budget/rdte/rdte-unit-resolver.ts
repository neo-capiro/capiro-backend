/**
 * rdte-unit-resolver — resolve money units from explicit source text or
 * manifest policy.
 *
 * Rules (Phase 4 plan §7):
 *   - no magnitude inference;
 *   - no default-to-thousands when source and manifest are both silent;
 *   - conflicting unit labels are blocking;
 *   - unit evidence must identify the page/table/header that supplied the unit;
 *   - all money remains exact decimal strings.
 *
 * Pure module.
 */
import { z } from 'zod';
import type { MoneyUnitV1 } from '../contracts/decimal-string.js';

export const unitEvidenceV1Schema = z
  .object({
    page: z.number().int().positive().optional(),
    printedPage: z.string().optional(),
    tableLabel: z.string().optional(),
    headerText: z.string().optional(),
    rawText: z.string(),
  })
  .strict();
export type UnitEvidenceV1 = z.infer<typeof unitEvidenceV1Schema>;

export type UnitResolution =
  | {
      status: 'resolved';
      unit: MoneyUnitV1;
      evidence: UnitEvidenceV1;
    }
  | {
      status: 'missing';
      reason: string;
    }
  | {
      status: 'conflict';
      units: readonly MoneyUnitV1[];
      evidence: readonly UnitEvidenceV1[];
      reason: string;
    };

const THOUSANDS_RE = /\$\s*in\s*thousands\b|\bin\s*thousands\b|\bthousands\s*of\s*dollars\b/i;
const MILLIONS_RE = /\$\s*in\s*millions\b|\bin\s*millions\b|\bmillions\s*of\s*dollars\b/i;
const DOLLARS_RE = /\$\s*in\s*dollars\b|\bin\s*dollars\b|\bdollars\b/i;

/**
 * Resolve the money unit for a table/page from explicit text candidates.
 * Candidates are scanned in order; the first explicit unit label wins.
 * Multiple DIFFERENT explicit units produce a blocking conflict.
 */
export function resolveRdteUnit(input: {
  candidates: readonly UnitEvidenceV1[];
  manifestUnit?: MoneyUnitV1;
}): UnitResolution {
  const detected: Array<{ unit: MoneyUnitV1; evidence: UnitEvidenceV1 }> = [];

  for (const evidence of input.candidates) {
    const text = evidence.rawText;
    if (THOUSANDS_RE.test(text)) {
      detected.push({ unit: 'thousands', evidence });
    } else if (MILLIONS_RE.test(text)) {
      detected.push({ unit: 'millions', evidence });
    } else if (DOLLARS_RE.test(text)) {
      detected.push({ unit: 'dollars', evidence });
    }
  }

  const uniqueUnits = [...new Set(detected.map((d) => d.unit))];

  if (uniqueUnits.length > 1) {
    return {
      status: 'conflict',
      units: uniqueUnits,
      evidence: detected.map((d) => d.evidence),
      reason: `conflicting unit labels detected: ${uniqueUnits.join(', ')}`,
    };
  }

  if (uniqueUnits.length === 1 && detected[0] != null) {
    return {
      status: 'resolved',
      unit: detected[0].unit,
      evidence: detected[0].evidence,
    };
  }

  if (input.manifestUnit != null) {
    return {
      status: 'resolved',
      unit: input.manifestUnit,
      evidence: {
        rawText: 'manifest policy',
        headerText: 'manifest',
      },
    };
  }

  return {
    status: 'missing',
    reason: 'no explicit unit label in source and no manifest policy unit',
  };
}
