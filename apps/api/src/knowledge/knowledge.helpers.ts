import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import type {
  KnowledgeJsonObject,
  KnowledgeJsonValue,
  KnowledgeRef,
} from './knowledge.types.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^[a-z][a-z0-9_]{0,95}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/i;

export function requireUuid(value: string, field: string): string {
  const normalized = requireText(value, field, 36);
  if (!UUID_PATTERN.test(normalized)) {
    throw new BadRequestException(`${field} must be a UUID.`);
  }
  return normalized.toLowerCase();
}

export function requireText(value: string, field: string, maxLength: number): string {
  const normalized = (value ?? '').trim();
  if (!normalized) throw new BadRequestException(`${field} is required.`);
  if (normalized.length > maxLength) {
    throw new BadRequestException(`${field} must be at most ${maxLength} characters.`);
  }
  return normalized;
}

export function optionalText(
  value: string | null | undefined,
  field: string,
  maxLength: number,
): string | null {
  if (value == null) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) {
    throw new BadRequestException(`${field} must be at most ${maxLength} characters.`);
  }
  return normalized;
}

export function requireToken(value: string, field: string): string {
  const normalized = requireText(value, field, 96).toLowerCase();
  if (!TOKEN_PATTERN.test(normalized)) {
    throw new BadRequestException(`${field} must use lower snake_case.`);
  }
  return normalized;
}

export function requireSha256(value: string, field: string): string {
  const normalized = requireText(value, field, 64).toLowerCase();
  if (!HASH_PATTERN.test(normalized)) {
    throw new BadRequestException(`${field} must be a 64-character SHA-256 hex digest.`);
  }
  return normalized;
}

export function requireDate(value: Date, field: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new BadRequestException(`${field} must be a valid Date.`);
  }
  return new Date(value.getTime());
}

export function normalizeJsonObject(
  value: KnowledgeJsonObject | undefined,
  field: string,
  fallback: KnowledgeJsonObject,
): KnowledgeJsonObject {
  const candidate = value ?? fallback;
  if (!candidate || Array.isArray(candidate) || typeof candidate !== 'object') {
    throw new BadRequestException(`${field} must be a JSON object.`);
  }
  assertJsonValue(candidate, field);
  return cloneJson(candidate) as KnowledgeJsonObject;
}

export function requireNonEmptyJsonObject(
  value: KnowledgeJsonObject,
  field: string,
): KnowledgeJsonObject {
  const normalized = normalizeJsonObject(value, field, {});
  if (Object.keys(normalized).length === 0) {
    throw new BadRequestException(`${field} must identify the source evidence.`);
  }
  return normalized;
}

export function normalizeRefs(
  refs: KnowledgeRef[] | undefined,
  field: string,
): KnowledgeRef[] {
  if (refs == null) return [];
  if (!Array.isArray(refs)) throw new BadRequestException(`${field} must be an array.`);
  return refs.map((ref, index) => {
    if (!ref || Array.isArray(ref) || typeof ref !== 'object') {
      throw new BadRequestException(`${field}[${index}] must be an object.`);
    }
    const normalized: KnowledgeRef = {
      type: requireToken(ref.type, `${field}[${index}].type`),
      id: requireText(ref.id, `${field}[${index}].id`, 320),
    };
    const label = optionalText(ref.label, `${field}[${index}].label`, 320);
    if (label) normalized.label = label;
    if (ref.metadata !== undefined) {
      normalized.metadata = normalizeJsonObject(
        ref.metadata,
        `${field}[${index}].metadata`,
        {},
      );
    }
    return normalized;
  });
}

export function assertJsonValue(value: unknown, field: string): asserts value is KnowledgeJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${field}[${index}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) {
        throw new BadRequestException(`${field}.${key} cannot be undefined.`);
      }
      assertJsonValue(entry, `${field}.${key}`);
    }
    return;
  }
  throw new BadRequestException(`${field} must be JSON serializable.`);
}

export function cloneJson<T extends KnowledgeJsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Stable JSON representation used only for deterministic identity hashing. */
export function stableStringify(value: KnowledgeJsonValue): string {
  return JSON.stringify(sortJson(value));
}

export function sha256Identity(value: KnowledgeJsonObject): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

/** SHA-256 of canonical source text, encoded as UTF-8. */
export function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function jsonEquals(left: KnowledgeJsonValue, right: KnowledgeJsonValue): boolean {
  return stableStringify(left) === stableStringify(right);
}

function sortJson(value: KnowledgeJsonValue): KnowledgeJsonValue {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    const sorted: KnowledgeJsonObject = {};
    for (const key of Object.keys(value).sort()) {
      const entry = value[key];
      if (entry === undefined) {
        throw new BadRequestException(`Stable JSON value ${key} cannot be undefined.`);
      }
      sorted[key] = sortJson(entry);
    }
    return sorted;
  }
  return value;
}
