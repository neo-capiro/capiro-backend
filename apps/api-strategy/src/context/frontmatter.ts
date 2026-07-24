/**
 * Stage D: hand-rolled YAML-frontmatter parser + validator for the Meri
 * Strategy Context Pack (src/context/templates/ is the in-repo contract).
 *
 * PURE module — no Nest, no Prisma, no I/O. The grammar is deliberately the
 * flat subset the 14 templates actually use: a leading `---` fence, flat
 * `key: value` scalar lines (bare scalar | double-quoted string | true/false |
 * null), and a closing `---`. Nested keys, arrays, and block scalars are
 * STRUCTURAL errors — the contract is flat by design, and a tiny exact parser
 * beats a permissive dependency (house rule: no new npm deps).
 *
 * Every failure — structural or semantic — is reported as a FIELD-LEVEL
 * FieldError so the UI can annotate the offending line/key (the Stage D
 * acceptance criterion). Vocabularies are exported as consts; Stage E (fact
 * extraction / conflict detection) reuses them.
 */

export interface FieldError {
  field: string;
  message: string;
}

export type FrontmatterValue = string | boolean | null;
export type Frontmatter = Record<string, FrontmatterValue>;

export interface ParseResult {
  frontmatter: Frontmatter | null;
  body: string;
  errors: FieldError[];
}

// ---------------------------------------------------------------------------
// Vocabularies (the template contract). Stage E imports these — keep exported.
// ---------------------------------------------------------------------------

/** The 14 known document types, in template-pack order (00..13). */
export const DOCUMENT_TYPES = [
  'context_manifest',
  'strategy_brief',
  'client_constraints',
  'ask_and_options',
  'stakeholder_map',
  'calendar_and_deadlines',
  'decision_rules',
  'current_plan',
  'evidence_register',
  'meeting_intelligence',
  'decision_log',
  'agent_mission',
  'execution_playbook',
  'agent_permissions',
] as const;
export type DocumentTypeValue = (typeof DOCUMENT_TYPES)[number];

/** document_type -> SpContextDocument.templateKey (the NN_name file stem). */
export const TEMPLATE_KEY_BY_TYPE: Readonly<Record<DocumentTypeValue, string>> = {
  context_manifest: '00_context_manifest',
  strategy_brief: '01_strategy_brief',
  client_constraints: '02_client_constraints',
  ask_and_options: '03_ask_and_options',
  stakeholder_map: '04_stakeholder_map',
  calendar_and_deadlines: '05_calendar_and_deadlines',
  decision_rules: '06_decision_rules',
  current_plan: '07_current_plan',
  evidence_register: '08_evidence_register',
  meeting_intelligence: '09_meeting_intelligence',
  decision_log: '10_decision_log',
  agent_mission: '11_agent_mission',
  execution_playbook: '12_execution_playbook',
  agent_permissions: '13_agent_permissions',
};

/** SpContextDocState mirror. */
export const CONTEXT_STATES = ['draft', 'active', 'superseded', 'archived'] as const;
export type ContextStateValue = (typeof CONTEXT_STATES)[number];

/** SpContextScope mirror. NOTE: 'meeting' is in the PACK but deferred here. */
export const CONTEXT_SCOPES = ['once', 'node', 'strategy', 'client', 'firm'] as const;
export type ContextScopeValue = (typeof CONTEXT_SCOPES)[number];

export const AUTHORITIES = [
  'firm_approved',
  'client_approved',
  'working_draft',
  'external_authoritative',
  'meeting_intelligence',
] as const;
export type AuthorityValue = (typeof AUTHORITIES)[number];

export const CONFIDENTIALITIES = ['client_confidential', 'firm_internal'] as const;
export type ConfidentialityValue = (typeof CONFIDENTIALITIES)[number];

/** The literal placeholder the blank templates ship with — never a real date. */
export const DATE_PLACEHOLDER = 'YYYY-MM-DD';

/**
 * The literal id placeholders the blank templates ship with — never real ids.
 * Exact-literal matches only (a real Clerk id like 'user_2NNEq…' must pass);
 * symmetric with DATE_PLACEHOLDER so filled-in dates can't smuggle these
 * fabricated ids past validation into Stage E.
 */
export const ID_PLACEHOLDERS = ['client_123', 'strategy_456', 'user_123', 'meeting_789'] as const;

/** The id-carrying frontmatter fields the templates ship placeholders in. */
const ID_FIELDS = ['client_id', 'strategy_id', 'node_id', 'meeting_id', 'owner'] as const;

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const FENCE = /^---\s*$/;
const KEY_VALUE = /^([A-Za-z_][A-Za-z0-9_]*):\s?(.*)$/;

/**
 * Parse the leading `---` frontmatter block. Returns the parsed flat map, the
 * body (everything after the closing fence), and structural errors. On a
 * structural failure the frontmatter is null and the body falls back to the
 * whole input (nothing is guessed).
 */
export function parseFrontmatter(raw: string): ParseResult {
  const lines = raw.split(/\r?\n/);
  const errors: FieldError[] = [];

  if (lines.length === 0 || !FENCE.test(lines[0] ?? '')) {
    return {
      frontmatter: null,
      body: raw,
      errors: [{ field: '_structure', message: "missing opening '---' frontmatter fence on line 1" }],
    };
  }

  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FENCE.test(lines[i] ?? '')) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    return {
      frontmatter: null,
      body: raw,
      errors: [{ field: '_structure', message: "missing closing '---' frontmatter fence" }],
    };
  }

  const fm: Frontmatter = {};
  for (let i = 1; i < closeIdx; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue; // blank lines inside the block are fine
    if (/^\s/.test(line)) {
      errors.push({
        field: '_structure',
        message: `line ${i + 1}: nested/indented keys are not allowed (frontmatter is flat \`key: value\` only)`,
      });
      continue;
    }
    if (/^-\s/.test(line)) {
      errors.push({
        field: '_structure',
        message: `line ${i + 1}: array items are not allowed (frontmatter is flat \`key: value\` only)`,
      });
      continue;
    }
    const m = KEY_VALUE.exec(line);
    if (!m) {
      errors.push({
        field: '_structure',
        message: `line ${i + 1}: not a flat \`key: value\` line`,
      });
      continue;
    }
    const key = m[1]!;
    const rawValue = (m[2] ?? '').trim();
    if (Object.prototype.hasOwnProperty.call(fm, key)) {
      errors.push({ field: key, message: 'duplicate key' });
      continue;
    }
    const parsed = parseScalar(key, rawValue, i + 1);
    if ('error' in parsed) {
      errors.push(parsed.error);
      continue;
    }
    fm[key] = parsed.value;
  }

  if (errors.some((e) => e.field === '_structure')) {
    // Structural failure: don't hand back a half-parsed map anyone might trust.
    return { frontmatter: null, body: raw, errors };
  }

  const body = lines.slice(closeIdx + 1).join('\n');
  return { frontmatter: fm, body, errors };
}

function parseScalar(
  key: string,
  rawValue: string,
  lineNo: number,
): { value: FrontmatterValue } | { error: FieldError } {
  if (rawValue === '') {
    return { error: { field: key, message: `line ${lineNo}: empty value (use null explicitly)` } };
  }
  if (rawValue === 'null') return { value: null };
  if (rawValue === 'true') return { value: true };
  if (rawValue === 'false') return { value: false };
  if (rawValue.startsWith('[') || rawValue.startsWith('{')) {
    return {
      error: {
        field: key,
        message: `line ${lineNo}: arrays/objects are not allowed (flat scalars only)`,
      },
    };
  }
  if (rawValue.startsWith('"')) {
    if (rawValue.length < 2 || !rawValue.endsWith('"')) {
      return { error: { field: key, message: `line ${lineNo}: unterminated double-quoted string` } };
    }
    return { value: rawValue.slice(1, -1) };
  }
  // Bare scalar — kept as the literal string (enum tokens, ids, etc.).
  return { value: rawValue };
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Real-calendar-date check. `new Date('2027-02-30')` ROLLS OVER to March 2 in
 * V8 (it does not NaN), so we round-trip the UTC date part back to the input —
 * any rollover fails the equality (same trick as src/strategy/dates.ts).
 */
export function isRealIsoDate(value: string): boolean {
  if (!DATE_SHAPE.test(value)) return false;
  const d = new Date(value);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function checkVocab(
  errors: FieldError[],
  fm: Frontmatter,
  field: string,
  vocab: readonly string[],
): void {
  const v = fm[field];
  if (typeof v !== 'string' || !vocab.includes(v)) {
    errors.push({
      field,
      message: `must be one of: ${vocab.join(', ')}${v === undefined ? ' (missing)' : ''}`,
    });
  }
}

function checkDateOrNull(errors: FieldError[], fm: Frontmatter, field: string): void {
  const v = fm[field];
  if (v === null || v === undefined) {
    // as_of is required by all 14 templates and drives Stage E conflict
    // resolution (README rule 5: 'newer as_of date') — null is NOT allowed.
    if (field === 'as_of') {
      errors.push({ field, message: 'as_of is required (a real YYYY-MM-DD date, not null)' });
    }
    return;
  }
  if (typeof v !== 'string') {
    errors.push({ field, message: 'must be a YYYY-MM-DD date string or null' });
    return;
  }
  if (v === DATE_PLACEHOLDER) {
    errors.push({ field, message: `placeholder date '${DATE_PLACEHOLDER}' — fill in a real date` });
    return;
  }
  if (!isRealIsoDate(v)) {
    errors.push({ field, message: 'not a valid YYYY-MM-DD calendar date' });
  }
}

/**
 * Enforce the template contract on a parsed frontmatter map. Returns
 * field-level errors only (empty array = valid).
 */
export function validateFrontmatter(fm: Frontmatter): FieldError[] {
  const errors: FieldError[] = [];

  checkVocab(errors, fm, 'document_type', DOCUMENT_TYPES);

  if (fm.schema_version !== '1.0') {
    errors.push({ field: 'schema_version', message: "must be '1.0'" });
  }

  checkVocab(errors, fm, 'state', CONTEXT_STATES);

  const scope = fm.scope;
  if (scope === 'meeting') {
    // The PACK defines a meeting scope (09_meeting_intelligence.md) but the
    // meetings association is a later phase — give the SPECIFIC remediation.
    errors.push({
      field: 'scope',
      message:
        'meeting scope is deferred (meetings association is a later phase) — re-scope to strategy',
    });
  } else {
    checkVocab(errors, fm, 'scope', CONTEXT_SCOPES);
  }

  checkVocab(errors, fm, 'authority', AUTHORITIES);
  checkVocab(errors, fm, 'confidentiality', CONFIDENTIALITIES);

  if (typeof fm.source_of_truth !== 'boolean') {
    errors.push({ field: 'source_of_truth', message: 'must be a boolean (true or false)' });
  }

  checkDateOrNull(errors, fm, 'as_of');
  checkDateOrNull(errors, fm, 'valid_until');

  // Placeholder ids — symmetric with the DATE_PLACEHOLDER check: the shipped
  // literal ids ('client_123', …) pass requireId (any non-empty string), so
  // without this they would persist as fabricated ids for Stage E to consume.
  for (const field of ID_FIELDS) {
    const v = fm[field];
    if (typeof v === 'string' && (ID_PLACEHOLDERS as readonly string[]).includes(v)) {
      errors.push({ field, message: `placeholder id '${v}' — fill in a real id` });
    }
  }

  // Scope consistency: a scoped document must carry the matching id.
  const requireId = (idField: string) => {
    const v = fm[idField];
    if (typeof v !== 'string' || v.trim() === '') {
      errors.push({ field: idField, message: `${idField} is required when scope is '${String(scope)}'` });
    }
  };
  if (scope === 'client') requireId('client_id');
  if (scope === 'strategy') requireId('strategy_id');
  if (scope === 'node') requireId('node_id');

  const supersedes = fm.supersedes;
  if (supersedes !== undefined && supersedes !== null) {
    if (typeof supersedes !== 'string' || supersedes.trim() === '') {
      errors.push({ field: 'supersedes', message: 'must be null or a non-empty string' });
    }
  }

  return errors;
}
