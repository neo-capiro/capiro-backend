import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 1 as const;
export const MAX_DEPTH = 5;
export const MAX_CLAUSES = 50;
export const CUSTOM_FIELD_PREFIX = 'field.';
export const ALLOWED_FIELDS = [
  'entityKind', 'capability', 'component', 'account', 'sourceFamily',
  'publisher', 'qualification', 'fiscalYear', 'stage',
] as const;
export const OPERATORS = ['eq', 'neq', 'in', 'not_in', 'contains', 'exists', 'gte', 'lte'] as const;

export type RuleOperator = typeof OPERATORS[number];
export type RuleScalar = string | number | boolean;
export type RuleValue = RuleScalar | readonly RuleScalar[];
export type RuleNode =
  | { kind: 'and' | 'or'; clauses: RuleNode[] }
  | { kind: 'not'; clause: RuleNode }
  | { kind: 'condition'; field: string; operator: RuleOperator; value: RuleValue };
export type EvaluationResult = 'match' | 'nonmatch' | 'unknown';
export interface CandidateFact {
  [field: string]: unknown;
  _completeness?: 'complete' | 'partial' | 'unavailable' | 'unresolved' | 'insufficient_qualification';
  _unknownReasons?: readonly string[];
}
export interface EvaluationOutcome { result: EvaluationResult; reasons: string[] }
export interface RuleValidationIssue { path: string; message: string }

export class RuleValidationError extends Error {
  constructor(readonly issues: readonly RuleValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
    this.name = 'RuleValidationError';
  }
}

export function condition(field: string, operator: RuleOperator, value: RuleValue): RuleNode {
  return { kind: 'condition', field, operator, value };
}
export function and(...clauses: RuleNode[]): RuleNode { return { kind: 'and', clauses }; }
export function or(...clauses: RuleNode[]): RuleNode { return { kind: 'or', clauses }; }
export function not(clause: RuleNode): RuleNode { return { kind: 'not', clause }; }

export function parseRule(value: unknown): RuleNode {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  validateRule(parsed as RuleNode);
  return parsed as RuleNode;
}

export function validateRule(node: RuleNode, schemaVersion: number = SCHEMA_VERSION): void {
  const issues: RuleValidationIssue[] = [];
  if (schemaVersion !== SCHEMA_VERSION) {
    throw new RuleValidationError([{ path: '$.schemaVersion', message: `Unsupported rule schema version ${schemaVersion}` }]);
  }
  let clauseCount = 0;
  const active = new Set<object>();
  function visit(value: unknown, path: string, depth: number): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { issues.push({ path, message: 'Rule node must be an object' }); return; }
    if (active.has(value as object)) { issues.push({ path, message: 'Cyclic reference detected' }); return; }
    if (depth > MAX_DEPTH) { issues.push({ path, message: `Rule depth exceeds maximum of ${MAX_DEPTH}` }); return; }
    active.add(value as object);
    const record = value as Record<string, unknown>;
    if (record.kind === 'and' || record.kind === 'or') {
      if (!Array.isArray(record.clauses) || record.clauses.length === 0) issues.push({ path, message: 'Group node cannot be empty' });
      else { clauseCount += record.clauses.length; record.clauses.forEach((clause, index) => visit(clause, `${path}.clauses[${index}]`, depth + 1)); }
    } else if (record.kind === 'not') {
      clauseCount += 1; visit(record.clause, `${path}.clause`, depth + 1);
    } else if (record.kind === 'condition') {
      clauseCount += 1; validateCondition(record, path, issues);
    } else issues.push({ path: `${path}.kind`, message: 'Unsupported rule node kind' });
    active.delete(value as object);
  }
  visit(node, '$', 1);
  if (clauseCount > MAX_CLAUSES) issues.push({ path: '$', message: `Total clauses exceed maximum of ${MAX_CLAUSES}` });
  if (issues.length) throw new RuleValidationError(issues);
}

function validateCondition(record: Record<string, unknown>, path: string, issues: RuleValidationIssue[]): void {
  const { field, operator, value } = record;
  if (typeof field !== 'string' || (!ALLOWED_FIELDS.includes(field as typeof ALLOWED_FIELDS[number]) && !validCustomField(field))) {
    issues.push({ path: `${path}.field`, message: `Field '${String(field)}' is not allowed` });
  }
  if (!OPERATORS.includes(operator as RuleOperator)) { issues.push({ path: `${path}.operator`, message: `Operator '${String(operator)}' is not allowed` }); return; }
  if ((operator === 'in' || operator === 'not_in') && (!Array.isArray(value) || value.length === 0 || value.some((item) => !isScalar(item)))) {
    issues.push({ path: `${path}.value`, message: `${operator} value must be an array of scalar values` });
  } else if (operator === 'contains' && typeof value !== 'string') issues.push({ path: `${path}.value`, message: 'contains value must be a string' });
  else if (operator === 'exists' && typeof value !== 'boolean') issues.push({ path: `${path}.value`, message: 'exists value must be a boolean' });
  else if ((operator === 'gte' || operator === 'lte') && typeof value !== 'number' && typeof value !== 'string') issues.push({ path: `${path}.value`, message: `${operator} value must be a number or string` });
  else if (!['in', 'not_in', 'contains', 'exists', 'gte', 'lte'].includes(operator as string) && !isScalar(value)) issues.push({ path: `${path}.value`, message: `${operator} value must be a scalar` });
  if (typeof value === 'string' && /(?:;\s*(?:select|insert|update|delete|drop)\b|\$\{|=>|function\s*\()/i.test(value)) issues.push({ path: `${path}.value`, message: 'Executable expressions and SQL are not allowed' });
}
function validCustomField(field: string): boolean { return field.startsWith(CUSTOM_FIELD_PREFIX) && /^field\.[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(field); }
function isScalar(value: unknown): value is RuleScalar { return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'; }

export function evaluateRule(node: RuleNode, fact: CandidateFact): EvaluationOutcome {
  validateRule(node);
  const reasons: string[] = [];
  const completeness = fact._completeness ?? 'complete';
  if (completeness !== 'complete') return { result: 'unknown', reasons: [...(fact._unknownReasons ?? []), `Candidate completeness is ${completeness}`] };
  function evaluate(current: RuleNode): EvaluationResult {
    if (current.kind === 'condition') return evaluateCondition(current, fact, reasons);
    if (current.kind === 'not') { const result = evaluate(current.clause); return result === 'unknown' ? 'unknown' : result === 'match' ? 'nonmatch' : 'match'; }
    const outcomes = current.clauses.map(evaluate);
    if (current.kind === 'and') {
      if (outcomes.includes('nonmatch')) return 'nonmatch';
      if (outcomes.every((item) => item === 'match')) return 'match';
      reasons.push('AND group contains an unknown clause'); return 'unknown';
    }
    if (outcomes.includes('match')) return 'match';
    if (outcomes.every((item) => item === 'nonmatch')) return 'nonmatch';
    reasons.push('OR group contains an unknown clause'); return 'unknown';
  }
  return { result: evaluate(node), reasons: [...new Set(reasons)] };
}

function evaluateCondition(node: Extract<RuleNode, { kind: 'condition' }>, fact: CandidateFact, reasons: string[]): EvaluationResult {
  const actual = readField(fact, node.field);
  if (node.operator === 'exists') { const exists = actual !== undefined && actual !== null; return exists === node.value ? 'match' : 'nonmatch'; }
  if (actual === undefined || actual === null) { reasons.push(`${node.field} is unavailable`); return 'unknown'; }
  switch (node.operator) {
    case 'eq': return equal(actual, node.value) ? 'match' : 'nonmatch';
    case 'neq': return equal(actual, node.value) ? 'nonmatch' : 'match';
    case 'in': return (node.value as readonly RuleScalar[]).some((item) => equal(actual, item)) ? 'match' : 'nonmatch';
    case 'not_in': return (node.value as readonly RuleScalar[]).some((item) => equal(actual, item)) ? 'nonmatch' : 'match';
    case 'contains': {
      const needle = String(node.value).toLocaleLowerCase();
      if (typeof actual === 'string') return actual.toLocaleLowerCase().includes(needle) ? 'match' : 'nonmatch';
      if (Array.isArray(actual)) return actual.some((item) => String(item).toLocaleLowerCase().includes(needle)) ? 'match' : 'nonmatch';
      reasons.push(`${node.field} is not searchable text`); return 'unknown';
    }
    case 'gte': case 'lte': {
      const comparison = compare(actual, node.value);
      if (comparison === null) { reasons.push(`${node.field} cannot be compared`); return 'unknown'; }
      return node.operator === 'gte' ? (comparison >= 0 ? 'match' : 'nonmatch') : (comparison <= 0 ? 'match' : 'nonmatch');
    }
    default: return 'unknown';
  }
}
function readField(fact: CandidateFact, field: string): unknown {
  if (!field.startsWith(CUSTOM_FIELD_PREFIX)) return fact[field];
  return field.slice(CUSTOM_FIELD_PREFIX.length).split('.').reduce<unknown>((value, segment) => value && typeof value === 'object' ? (value as Record<string, unknown>)[segment] : undefined, fact.field);
}
function equal(left: unknown, right: unknown): boolean { return typeof left === 'string' && typeof right === 'string' ? left.toLocaleLowerCase() === right.toLocaleLowerCase() : left === right; }
function compare(left: unknown, right: unknown): number | null {
  const leftNumber = typeof left === 'number' ? left : typeof left === 'string' && left.trim() ? Number(left) : Number.NaN;
  const rightNumber = typeof right === 'number' ? right : typeof right === 'string' && right.trim() ? Number(right) : Number.NaN;
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  if (typeof left === 'string' && typeof right === 'string') return left.localeCompare(right);
  return null;
}

export function canonicalizeRule(node: RuleNode): string { validateRule(node); return stableJson({ schemaVersion: SCHEMA_VERSION, expression: node }); }
export function hashRule(node: RuleNode, context: unknown = null): string { return createHash('sha256').update(stableJson({ rule: JSON.parse(canonicalizeRule(node)), context })).digest('hex'); }
export function stableJson(value: unknown): string { return JSON.stringify(normalize(value)); }
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]));
  return value;
}
