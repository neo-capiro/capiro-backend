/**
 * Validation + safe merge for firm/user-authored Meri skills (P3-4).
 *
 * Firms can author their own skills that plug into the P0-5 registry. This is
 * the security-critical core: strict validation/sanitization of a user-submitted
 * skill (id shape, length caps, count caps, tool allowlist, no overriding a
 * built-in/reserved trigger), and a safe merge where built-in skills always win.
 * Pure so it unit-tests under `src/**.spec.ts`. Persistence (a tenant-scoped
 * table) + CRUD endpoints + the authoring UI are the remaining integration
 * (requires a migration); this module is what they call to stay safe.
 */
import {
  MERI_PROCEDURE_CAPABILITIES,
  MERI_PROCEDURE_SCOPES,
  type MeriProcedureManifest,
  type MeriSkill,
} from './skills/skill.types.js';
import {
  COMMITMENTS_AUDIT_CAPABILITIES,
  COMMITMENTS_AUDIT_COVERAGE_STATES,
  COMMITMENTS_AUDIT_STATUSES,
} from './skills/commitments-audit.procedure.js';

const LIMITS = {
  name: 80,
  addendum: 2000,
  triggers: 5,
  tools: 12,
  sections: 12,
  sectionLen: 80,
  heading: 120,
  procedureBytes: 12_000,
};

const PROCEDURE_KEYS = new Set([
  'purpose',
  'scopes',
  'evidencePrerequisites',
  'allowedCapabilities',
  'output',
  'completion',
  'effectPolicy',
  'examples',
  'caseIds',
]);
const OUTPUT_KEYS = new Set([
  'fields',
  'statuses',
  'coverageStates',
  'unknownValue',
  'preserveModality',
  'honorRequestedWindow',
  'defaultRecentWindowDays',
  'reportPartialCoverage',
]);
const EFFECT_KEYS = new Set(['mode', 'prohibitedEffects']);
const PROCEDURE_CAPABILITY_SET = new Set<string>(MERI_PROCEDURE_CAPABILITIES);
const PROCEDURE_SCOPE_SET = new Set<string>(MERI_PROCEDURE_SCOPES);

/** Triggers owned by built-in skills/intents; firm skills may not claim these. */
export const RESERVED_TRIGGERS = new Set([
  'generate_briefing',
  'generate_draft',
  'analyze_bill',
  'prep_hearing',
  'draft_coalition_letter',
  'track_amendment',
]);

export interface FirmSkillValidation {
  ok: boolean;
  skill: MeriSkill | null;
  errors: string[];
}

export interface FirmSkillValidationOptions {
  /** Authoritative registry subset; supplied by the server, not by the skill. */
  readOnlyTools?: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
  errors: string[],
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) errors.push(`${label} has unknown fields: ${unknown.join(', ')}`);
}

function stringArray(
  value: unknown,
  label: string,
  errors: string[],
  min: number,
  max: number,
  itemMax: number,
): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    errors.push(`${label} must contain ${min}-${max} items`);
    return [];
  }
  if (
    value.some((item) => typeof item !== 'string' || !item.trim() || item.trim().length > itemMax)
  ) {
    errors.push(`${label} items must be non-empty strings (<=${itemMax} chars)`);
    return [];
  }
  const normalized = value.map((item) => (item as string).trim());
  if (new Set(normalized).size !== normalized.length) errors.push(`${label} contains duplicates`);
  return normalized;
}

function sameMembers(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && expected.every((item) => actual.includes(item));
}

function validateProcedureManifest(input: unknown, errors: string[]): MeriProcedureManifest | null {
  if (!isRecord(input)) {
    errors.push('procedure must be an object');
    return null;
  }
  if (JSON.stringify(input).length > LIMITS.procedureBytes) {
    errors.push(`procedure is too large (<=${LIMITS.procedureBytes} bytes)`);
  }
  rejectUnknownKeys(input, PROCEDURE_KEYS, 'procedure', errors);

  const purpose = typeof input.purpose === 'string' ? input.purpose.trim() : '';
  if (!purpose || purpose.length > 500) errors.push('procedure.purpose is required (<=500 chars)');

  const scopes = stringArray(input.scopes, 'procedure.scopes', errors, 1, 4, 32);
  const invalidScopes = scopes.filter((scope) => !PROCEDURE_SCOPE_SET.has(scope));
  if (invalidScopes.length)
    errors.push(`procedure has invalid scopes: ${invalidScopes.join(', ')}`);

  const evidencePrerequisites = stringArray(
    input.evidencePrerequisites,
    'procedure.evidencePrerequisites',
    errors,
    1,
    12,
    240,
  );
  const allowedCapabilities = stringArray(
    input.allowedCapabilities,
    'procedure.allowedCapabilities',
    errors,
    1,
    16,
    64,
  );
  const invalidCapabilities = allowedCapabilities.filter(
    (capability) => !PROCEDURE_CAPABILITY_SET.has(capability),
  );
  if (invalidCapabilities.length) {
    errors.push(`procedure has unknown capabilities: ${invalidCapabilities.join(', ')}`);
  }

  const outputInput = input.output;
  if (!isRecord(outputInput)) errors.push('procedure.output must be an object');
  const output = isRecord(outputInput) ? outputInput : {};
  rejectUnknownKeys(output, OUTPUT_KEYS, 'procedure.output', errors);
  const fields = stringArray(output.fields, 'procedure.output.fields', errors, 1, 24, 80);
  const statuses = stringArray(output.statuses, 'procedure.output.statuses', errors, 0, 12, 80);
  const coverageStates = stringArray(
    output.coverageStates,
    'procedure.output.coverageStates',
    errors,
    0,
    12,
    80,
  );
  const unknownValue = typeof output.unknownValue === 'string' ? output.unknownValue.trim() : '';
  if (!unknownValue || unknownValue.length > 40) {
    errors.push('procedure.output.unknownValue is required (<=40 chars)');
  }
  for (const key of [
    'preserveModality',
    'honorRequestedWindow',
    'reportPartialCoverage',
  ] as const) {
    if (typeof output[key] !== 'boolean') errors.push(`procedure.output.${key} must be boolean`);
  }
  const defaultRecentWindowDays = output.defaultRecentWindowDays;
  if (
    defaultRecentWindowDays !== null &&
    (!Number.isInteger(defaultRecentWindowDays) ||
      (defaultRecentWindowDays as number) < 1 ||
      (defaultRecentWindowDays as number) > 365)
  ) {
    errors.push('procedure.output.defaultRecentWindowDays must be null or an integer from 1-365');
  }

  const completion = stringArray(input.completion, 'procedure.completion', errors, 1, 16, 240);
  const effectInput = input.effectPolicy;
  if (!isRecord(effectInput)) errors.push('procedure.effectPolicy must be an object');
  const effectPolicy = isRecord(effectInput) ? effectInput : {};
  rejectUnknownKeys(effectPolicy, EFFECT_KEYS, 'procedure.effectPolicy', errors);
  const mode = effectPolicy.mode;
  if (mode !== 'read_only' && mode !== 'approval_required') {
    errors.push('procedure.effectPolicy.mode must be read_only or approval_required');
  }
  const prohibitedEffects = stringArray(
    effectPolicy.prohibitedEffects,
    'procedure.effectPolicy.prohibitedEffects',
    errors,
    0,
    12,
    120,
  );
  if (
    mode === 'read_only' &&
    allowedCapabilities.some((capability) => !capability.endsWith('.read'))
  ) {
    errors.push('read_only procedure cannot request a write capability');
  }

  const examples = stringArray(input.examples, 'procedure.examples', errors, 1, 8, 240);
  const caseIds = stringArray(input.caseIds, 'procedure.caseIds', errors, 1, 20, 40);
  if (caseIds.some((caseId) => !/^[A-Z][A-Z0-9]*-[A-Z0-9]+$/.test(caseId))) {
    errors.push('procedure.caseIds must use canonical uppercase IDs');
  }

  if (errors.length) return null;
  return {
    purpose,
    scopes: scopes as MeriProcedureManifest['scopes'],
    evidencePrerequisites,
    allowedCapabilities: allowedCapabilities as MeriProcedureManifest['allowedCapabilities'],
    output: {
      fields,
      statuses,
      coverageStates,
      unknownValue,
      preserveModality: output.preserveModality as boolean,
      honorRequestedWindow: output.honorRequestedWindow as boolean,
      defaultRecentWindowDays: defaultRecentWindowDays as number | null,
      reportPartialCoverage: output.reportPartialCoverage as boolean,
    },
    completion,
    effectPolicy: {
      mode: mode as MeriProcedureManifest['effectPolicy']['mode'],
      prohibitedEffects,
    },
    examples,
    caseIds,
  };
}

function validateCommitmentsContract(skill: MeriSkill, errors: string[]): void {
  if (skill.id !== 'commitments_audit') return;
  const procedure = skill.procedure;
  if (!procedure) {
    errors.push('commitments_audit requires its fixed procedure manifest');
    return;
  }
  if (skill.name !== 'Commitments & Deliverables') errors.push('commitments_audit name is fixed');
  if (!sameMembers(skill.triggers, ['commitments_audit'])) {
    errors.push('commitments_audit trigger is fixed');
  }
  if (!sameMembers(procedure.scopes, ['general', 'client'])) {
    errors.push('commitments_audit scopes must be general and client');
  }
  if (!sameMembers(procedure.allowedCapabilities, COMMITMENTS_AUDIT_CAPABILITIES)) {
    errors.push('commitments_audit read capabilities are fixed');
  }
  if (!sameMembers(procedure.output.statuses, COMMITMENTS_AUDIT_STATUSES)) {
    errors.push('commitments_audit statuses are fixed');
  }
  if (!sameMembers(procedure.output.coverageStates, COMMITMENTS_AUDIT_COVERAGE_STATES)) {
    errors.push('commitments_audit coverage states are fixed');
  }
  const requiredFields = [
    'source',
    'sourceVersion',
    'locator',
    'observedAt',
    'promise',
    'madeAt',
    'madeWhere',
    'owner',
    'dueDate',
    'dependency',
    'acceptance',
    'linkedRecordId',
    'nativeStatus',
    'proposedFollowUp',
    'auditStatus',
    'citations',
  ];
  if (!requiredFields.every((field) => procedure.output.fields.includes(field))) {
    errors.push('commitments_audit output fields are incomplete');
  }
  if (
    procedure.output.unknownValue !== 'unknown' ||
    !procedure.output.preserveModality ||
    !procedure.output.honorRequestedWindow ||
    procedure.output.defaultRecentWindowDays !== null ||
    !procedure.output.reportPartialCoverage
  ) {
    errors.push('commitments_audit modality, unknown, window, and coverage policy is fixed');
  }
  if (procedure.effectPolicy.mode !== 'read_only') {
    errors.push('commitments_audit must remain read_only');
  }
  const caseIds = Array.from({ length: 7 }, (_, index) => `CD-0${index + 1}`);
  if (!sameMembers(procedure.caseIds, caseIds)) errors.push('commitments_audit case IDs are fixed');
}

export function validateFirmSkill(
  input: Record<string, unknown>,
  allowedTools: readonly string[],
  options: FirmSkillValidationOptions = {},
): FirmSkillValidation {
  const errors: string[] = [];

  const id = String(input.id ?? '').trim();
  if (!/^[a-z0-9_]{2,48}$/.test(id)) errors.push('id must be 2-48 chars of [a-z0-9_]');

  const name = String(input.name ?? '').trim();
  if (!name || name.length > LIMITS.name) errors.push(`name is required (<=${LIMITS.name} chars)`);

  const triggers = Array.isArray(input.triggers)
    ? input.triggers
        .filter((t): t is string => typeof t === 'string')
        .map((t) => t.trim())
        .filter(Boolean)
    : [];
  if (triggers.length === 0 || triggers.length > LIMITS.triggers) {
    errors.push(`1-${LIMITS.triggers} triggers required`);
  }
  for (const t of triggers) {
    if (RESERVED_TRIGGERS.has(t)) errors.push(`trigger "${t}" is reserved by a built-in skill`);
  }

  const systemAddendum = String(input.systemAddendum ?? '').trim();
  if (!systemAddendum || systemAddendum.length > LIMITS.addendum) {
    errors.push(`systemAddendum is required (<=${LIMITS.addendum} chars)`);
  }

  const requiredToolsRaw = Array.isArray(input.requiredTools)
    ? input.requiredTools.filter((t): t is string => typeof t === 'string')
    : [];
  const unknownTools = requiredToolsRaw.filter((t) => !allowedTools.includes(t));
  if (unknownTools.length) errors.push(`unknown tools: ${unknownTools.join(', ')}`);
  const requiredTools = requiredToolsRaw.filter((t) => allowedTools.includes(t));
  if (requiredTools.length > LIMITS.tools) errors.push(`too many tools (<=${LIMITS.tools})`);

  let procedure: MeriProcedureManifest | undefined;
  if (input.procedure !== undefined) {
    procedure = validateProcedureManifest(input.procedure, errors) ?? undefined;
  }
  if (procedure?.effectPolicy.mode === 'read_only' && options.readOnlyTools) {
    const readOnlyTools = new Set(options.readOnlyTools);
    const writeTools = requiredTools.filter((tool) => !readOnlyTools.has(tool));
    if (writeTools.length) {
      errors.push(`read_only procedure cannot request write tools: ${writeTools.join(', ')}`);
    }
  }

  let template: MeriSkill['template'] = null;
  const tin = input.template;
  if (tin && typeof tin === 'object') {
    const t = tin as Record<string, unknown>;
    const heading = String(t.heading ?? '').trim();
    const sections = Array.isArray(t.sections)
      ? t.sections
          .filter((s): s is string => typeof s === 'string')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
    if (heading && sections.length > 0) {
      if (sections.length > LIMITS.sections)
        errors.push(`too many template sections (<=${LIMITS.sections})`);
      template = {
        heading: heading.slice(0, LIMITS.heading),
        sections: sections.slice(0, LIMITS.sections).map((s) => s.slice(0, LIMITS.sectionLen)),
      };
    }
  }

  const skill: MeriSkill = {
    id,
    name,
    triggers,
    systemAddendum,
    requiredTools,
    template,
    ...(procedure ? { procedure } : {}),
  };
  validateCommitmentsContract(skill, errors);
  if (errors.length) return { ok: false, skill: null, errors };
  return {
    ok: true,
    errors: [],
    skill,
  };
}

/**
 * Merge firm skills into the built-in set. Built-ins are authoritative: a firm
 * skill is dropped if any of its triggers is already claimed (by a built-in or
 * an earlier firm skill), so firms can extend but never hijack core behavior.
 */
export function mergeSkills(
  builtIn: readonly MeriSkill[],
  firm: readonly MeriSkill[],
): MeriSkill[] {
  const claimed = new Set(builtIn.flatMap((s) => s.triggers));
  const out: MeriSkill[] = [...builtIn];
  for (const fs of firm) {
    if (fs.triggers.some((t) => claimed.has(t))) continue;
    fs.triggers.forEach((t) => claimed.add(t));
    out.push(fs);
  }
  return out;
}

/**
 * Match a firm skill for one turn (F6b). Built-in skills resolve by classified
 * intent elsewhere; firm skills additionally fire when the user literally says
 * a trigger phrase ("earmark request memo"), since the intent classifier only
 * knows the built-in intents. Safe-merge semantics apply first, so a firm
 * skill whose triggers collide with a built-in can never match.
 */
export function matchFirmSkillForTurn(
  intent: string,
  message: string,
  firmSkills: readonly MeriSkill[],
  builtIn: readonly MeriSkill[],
): MeriSkill | null {
  if (!firmSkills.length) return null;
  const merged = mergeSkills(builtIn, firmSkills);
  const builtInIds = new Set(builtIn.map((s) => s.id));
  const survivors = merged.filter((s) => !builtInIds.has(s.id));
  const byIntent = survivors.find((s) => s.triggers.includes(intent));
  if (byIntent) return byIntent;
  const lower = message.toLowerCase();
  return (
    survivors.find((s) =>
      s.triggers.some((t) => t.length >= 4 && lower.includes(t.toLowerCase())),
    ) ?? null
  );
}
