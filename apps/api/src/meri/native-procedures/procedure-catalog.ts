import type { MeriFirmSkillsService } from '../meri-firm-skills.service.js';
import type { MeriProcedureScope } from '../skills/skill.types.js';
import {
  MERI_BUILTIN_PROCEDURE_IDS,
  MERI_BUILTIN_PROCEDURES,
  builtinProcedureDigest,
  parseSelectedProcedureSelector,
  type MeriSelectedProcedureSelector,
} from './selected-procedure.js';

/**
 * Wave5 MO01/ST16 — read-only procedure catalog for the conversation picker.
 *
 * The browser may only CHOOSE a procedure; it never sends instructions, tools or
 * authority. This module answers "which procedures may the current user select
 * right now?" so the picker has an exact selector to hand to the private
 * validate route. It is deliberately a projection over the EXISTING canonical
 * owners and adds no second store:
 *
 *  - the six builtins come from `MERI_BUILTIN_PROCEDURE_IDS` /
 *    `MERI_BUILTIN_PROCEDURES` with the digest from `builtinProcedureDigest`;
 *  - eligible firm procedures come from the validated `MeriFirmSkillsService.list`
 *    tenant projection (its `procedureDigest` is already the exact manifest digest).
 *
 * Listing grants no execution authority: the native resolver
 * (`resolveSelectedProcedureAdmission`) re-reads the canonical owner and decides
 * every invocation. Admin authoring stays on the user_admin firm-skills routes.
 */

/**
 * The exact validated projection `MeriFirmSkillsService.list()` already returns.
 * Reused rather than mirrored so the two can never drift.
 */
export type MeriFirmProcedureCatalogRow = Awaited<
  ReturnType<MeriFirmSkillsService['list']>
>[number];

/** Public, non-authority display metadata for one selectable procedure. */
export interface MeriProcedureCatalogDisplay {
  /** Builtin id, or the tenant firm row id. */
  id: string;
  /** Builtin id (equal to id), or the tenant firm row canonical skill id. */
  canonicalId: string;
  /** Human label: the stored row name, or the canonical builtin id. */
  label: string;
  /** Manifest purpose, or null when the stored row carries none. */
  purpose: string | null;
  scopes: MeriProcedureScope[];
}

export interface MeriProcedureCatalogEntry {
  /** Exact selector, ready to send to the private validate route unchanged. */
  selector: MeriSelectedProcedureSelector;
  display: MeriProcedureCatalogDisplay;
}

export interface MeriProcedureCatalog {
  version: 1;
  tenantId: string;
  generatedAt: number;
  entries: MeriProcedureCatalogEntry[];
  counts: { builtin: number; firm: number; total: number };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/**
 * Every emitted selector must survive the canonical closed-shape parser, so the
 * catalog can only ever offer something the resolver could actually admit. A row
 * whose identity cannot form a valid selector is hidden (truthfully unavailable)
 * rather than offered and then refused.
 */
function isClosedShape(selector: MeriSelectedProcedureSelector): boolean {
  try {
    parseSelectedProcedureSelector(selector);
    return true;
  } catch {
    return false;
  }
}

function builtinEntries(): MeriProcedureCatalogEntry[] {
  return MERI_BUILTIN_PROCEDURE_IDS.map((id) => ({
    selector: {
      source: 'builtin',
      id,
      version: MERI_BUILTIN_PROCEDURES[id].version,
      manifestDigest: builtinProcedureDigest(id),
    },
    display: {
      id,
      canonicalId: id,
      label: id,
      purpose: MERI_BUILTIN_PROCEDURES[id].manifest.purpose,
      scopes: [...MERI_BUILTIN_PROCEDURES[id].manifest.scopes],
    },
  }));
}

/**
 * A firm row is a selectable procedure only when it is enabled, stored-valid
 * (`runnable`) and actually carries a procedure manifest — the same conditions
 * the native resolver enforces. Disabled, malformed and non-procedure rows are
 * hidden; deleted and foreign rows are never returned by the tenant-scoped owner.
 */
function isEligibleFirmProcedure(row: MeriFirmProcedureCatalogRow): boolean {
  return (
    row.enabled &&
    row.runnable &&
    typeof row.procedureDigest === 'string' &&
    row.procedureDigest.length > 0
  );
}

/**
 * The display purpose of a firm row. Read from the stored (already validated)
 * payload and trimmed the same way the store validator trims it, so the shown
 * purpose matches the manifest the digest commits to. Display only.
 */
function storedProcedurePurpose(skill: unknown): string | null {
  if (!skill || typeof skill !== 'object') return null;
  const procedure = (skill as { procedure?: unknown }).procedure;
  if (!procedure || typeof procedure !== 'object') return null;
  const purpose = (procedure as { purpose?: unknown }).purpose;
  if (typeof purpose !== 'string') return null;
  const trimmed = purpose.trim();
  return trimmed === '' ? null : trimmed;
}

function firmEntry(row: MeriFirmProcedureCatalogRow): MeriProcedureCatalogEntry {
  return {
    selector: {
      source: 'firm',
      recordId: row.id,
      version: row.version,
      manifestDigest: row.procedureDigest as string,
    },
    display: {
      id: row.id,
      canonicalId: row.skillId,
      label: row.name,
      purpose: storedProcedurePurpose(row.skill),
      scopes: [...row.procedureScopes],
    },
  };
}

/**
 * Project the current-tenant procedure catalog: the six canonical builtins first
 * in canonical order, then the eligible firm procedures in the owner's order.
 * Deterministic for a given (tenantId, firmRows, now).
 */
export function projectProcedureCatalog(input: {
  tenantId: string;
  firmRows: readonly MeriFirmProcedureCatalogRow[];
  now: number;
}): MeriProcedureCatalog {
  const builtin = builtinEntries().filter((entry) => isClosedShape(entry.selector));
  const firm = input.firmRows
    .filter(isEligibleFirmProcedure)
    .map(firmEntry)
    .filter((entry) => isClosedShape(entry.selector));
  const entries = [...builtin, ...firm];

  return deepFreeze({
    version: 1 as const,
    tenantId: input.tenantId,
    generatedAt: input.now,
    entries,
    counts: { builtin: builtin.length, firm: firm.length, total: entries.length },
  });
}
