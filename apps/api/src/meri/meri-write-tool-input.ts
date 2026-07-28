import { BadRequestException } from '@nestjs/common';

export interface MeriJsonSchema {
  type?: string;
  enum?: unknown[];
  properties?: Record<string, MeriJsonSchema>;
  required?: string[];
  items?: MeriJsonSchema;
  additionalProperties?: boolean | MeriJsonSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
}

const MAX_SERIALIZED_BYTES = 64 * 1024;
const MAX_DEPTH = 8;
const MAX_ARRAY_LENGTH = 100;
const MAX_OBJECT_KEYS = 100;
const DEFAULT_MAX_STRING_LENGTH = 48_000;

const INTERNAL_AUTHORITY_FIELDS = new Set([
  'tenantId',
  'tenant_id',
  'userId',
  'user_id',
  'actorUserId',
  'actor_user_id',
  'approvedBy',
  'approved_by',
  'approvalStatus',
  'approval_status',
  'fingerprint',
  'policyDecision',
  'policyResult',
  'policyRuleId',
  'riskTier',
  'executionId',
  'proposalId',
  'impersonationSessionId',
]);

const UUID_FIELDS = new Set([
  'clientId',
  'conversationId',
  'memoryItemId',
  'taskId',
  'scheduledTaskId',
  'meetingId',
  'engagementId',
  'artifactId',
]);

const EMAIL_FIELDS = new Set(['email', 'to', 'cc', 'bcc', 'from', 'replyTo', 'recipientEmail']);
const DATE_FIELDS = new Set([
  'date',
  'dueDate',
  'startsAt',
  'endsAt',
  'runAt',
  'lastContact',
  'scheduledFor',
]);

function fail(path: string, message: string): never {
  throw new BadRequestException(`${path}: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function isEmail(value: string): boolean {
  if (value.length > 320 || value.includes('\n') || value.includes('\r')) return false;
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
}

function isIsoDateLike(value: string): boolean {
  if (!value.trim()) return false;
  return Number.isFinite(Date.parse(value));
}

function validateString(value: string, schema: MeriJsonSchema, path: string, fieldName: string): string {
  const min = schema.minLength ?? 0;
  const max = Math.min(schema.maxLength ?? DEFAULT_MAX_STRING_LENGTH, DEFAULT_MAX_STRING_LENGTH);
  if (value.length < min) fail(path, `must contain at least ${min} characters`);
  if (value.length > max) fail(path, `must contain no more than ${max} characters`);
  if (UUID_FIELDS.has(fieldName) && !isUuid(value)) fail(path, 'must be a UUID');
  if ((EMAIL_FIELDS.has(fieldName) || fieldName.endsWith('Email')) && !isEmail(value)) {
    fail(path, 'must be a valid email address');
  }
  if ((DATE_FIELDS.has(fieldName) || fieldName.endsWith('Date')) && !isIsoDateLike(value)) {
    fail(path, 'must be an ISO date or date-time');
  }
  return value;
}

function validateNode(
  value: unknown,
  schema: MeriJsonSchema,
  path: string,
  depth: number,
  fieldName: string,
  seen: WeakSet<object>,
): unknown {
  if (depth > MAX_DEPTH) fail(path, `nesting exceeds ${MAX_DEPTH} levels`);
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    fail(path, `must be one of ${schema.enum.map(String).join(', ')}`);
  }

  if (schema.type === 'string') {
    if (typeof value !== 'string') fail(path, 'must be a string');
    return validateString(value, schema, path, fieldName);
  }
  if (schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) fail(path, 'must be an integer');
    if (schema.minimum !== undefined && value < schema.minimum) fail(path, `must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(path, `must be <= ${schema.maximum}`);
    return value;
  }
  if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'must be a finite number');
    if (schema.minimum !== undefined && value < schema.minimum) fail(path, `must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(path, `must be <= ${schema.maximum}`);
    return value;
  }
  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') fail(path, 'must be a boolean');
    return value;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) fail(path, 'must be an array');
    if (value.length > MAX_ARRAY_LENGTH) fail(path, `must contain at most ${MAX_ARRAY_LENGTH} items`);
    if (seen.has(value)) fail(path, 'must not contain circular references');
    seen.add(value);
    const itemSchema = schema.items ?? {};
    const result = value.map((item, index) =>
      validateNode(item, itemSchema, `${path}[${index}]`, depth + 1, fieldName, seen),
    );
    seen.delete(value);
    return result;
  }

  const expectsObject = schema.type === 'object' || schema.properties !== undefined;
  if (expectsObject) {
    if (!isPlainObject(value)) fail(path, 'must be a plain object');
    if (seen.has(value)) fail(path, 'must not contain circular references');
    seen.add(value);
    const keys = Object.keys(value);
    if (keys.length > MAX_OBJECT_KEYS) fail(path, `must contain at most ${MAX_OBJECT_KEYS} keys`);
    const properties = schema.properties;
    for (const required of schema.required ?? []) {
      if (!(required in value) || value[required] === undefined || value[required] === null) {
        fail(`${path}.${required}`, 'is required');
      }
    }
    const output: Record<string, unknown> = {};
    for (const key of keys.sort()) {
      if (INTERNAL_AUTHORITY_FIELDS.has(key)) {
        fail(`${path}.${key}`, 'is controlled by the server and may not be supplied');
      }
      const propertySchema = properties?.[key];
      if (!propertySchema && properties) {
        if (schema.additionalProperties === true) {
          output[key] = validateNode(value[key], {}, `${path}.${key}`, depth + 1, key, seen);
          continue;
        }
        if (isPlainObject(schema.additionalProperties)) {
          output[key] = validateNode(
            value[key],
            schema.additionalProperties,
            `${path}.${key}`,
            depth + 1,
            key,
            seen,
          );
          continue;
        }
        fail(`${path}.${key}`, 'is not an allowed property');
      }
      output[key] = validateNode(
        value[key],
        propertySchema ?? {},
        `${path}.${key}`,
        depth + 1,
        key,
        seen,
      );
    }
    seen.delete(value);
    return output;
  }

  // Schemas for intentionally free-form metadata omit a type/properties block.
  // They still receive all structural, size, circular-reference, and authority-field checks.
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(path, 'must be a finite number');
    return value;
  }
  if (Array.isArray(value)) {
    return validateNode(value, { type: 'array', items: {} }, path, depth, fieldName, seen);
  }
  if (isPlainObject(value)) {
    return validateNode(
      value,
      { type: 'object', additionalProperties: true },
      path,
      depth,
      fieldName,
      seen,
    );
  }
  fail(path, 'contains an unsupported value');
}

/**
 * Parse one side-effecting tool payload into canonical plain JSON. Proposal
 * creation and actual execution both call this exact parser, preventing schema
 * drift between “what the user reviewed” and “what the server ran.”
 */
export function validateMeriWriteToolInput(
  tool: string,
  input: unknown,
  schema: MeriJsonSchema,
): Record<string, unknown> {
  if (!tool || typeof tool !== 'string') throw new BadRequestException('tool is required');
  const parsed = validateNode(input ?? {}, schema, 'input', 0, 'input', new WeakSet<object>());
  if (!isPlainObject(parsed)) throw new BadRequestException('input must be a plain object');
  const serialized = JSON.stringify(parsed);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SERIALIZED_BYTES) {
    throw new BadRequestException(`input exceeds the ${MAX_SERIALIZED_BYTES}-byte limit`);
  }
  return parsed;
}
