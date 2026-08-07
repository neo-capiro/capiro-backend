/**
 * Deterministic canonical JSON serialization + SHA-256 content hashing.
 *
 * Canonical JSON:
 *   - object keys sorted lexicographically (recursively)
 *   - array order preserved
 *   - no insignificant whitespace
 *   - rejects undefined, functions, symbols, BigInt, non-finite numbers, cycles
 *
 * The same logical value must produce byte-identical output on every replay.
 */
import { createHash } from 'node:crypto';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** Serialize a JSON-safe value to canonical form. Throws on non-JSON values. */
export function canonicalJsonStringify(value: JsonValue): string {
  return serialize(value, new Set());
}

/** SHA-256 (lowercase hex) of the canonical JSON form of a value. */
export function sha256CanonicalJson(value: JsonValue): string {
  return createHash('sha256').update(canonicalJsonStringify(value), 'utf8').digest('hex');
}

/** SHA-256 (lowercase hex) of an arbitrary UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * SHA-256 (lowercase hex) of raw bytes. Use this for PDFs, JSON file bytes,
 * parser outputs, and S3 objects — any binary data where the hash must cover
 * the original bytes, not an encoded string representation.
 *
 * Do NOT use sha256Hex for binary data: sha256Hex hashes the UTF-8 encoding
 * of its string argument, which is NOT the same as hashing raw bytes.
 */
export function sha256Bytes(input: Buffer | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Drop object properties whose value is `undefined`, recursively.
 *
 * An optional property that is explicitly `undefined` and one that is absent
 * are the same value in TypeScript, but only the absent form is canonically
 * serializable. Schemas whose parse output is hashed or embedded in an
 * artifact should normalize through this so that callers who build objects
 * with `{ field: maybe ?? undefined }` produce the same bytes as callers who
 * omit the field. This does not relax `serialize`: it removes the ambiguity
 * before serialization rather than silently tolerating it during.
 */
export function stripUndefinedProperties<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefinedProperties(item)) as unknown as T;
  }
  if (value === null || typeof value !== 'object') return value;
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined) continue;
    out[key] = stripUndefinedProperties(item);
  }
  return out as T;
}

function serialize(value: JsonValue, seen: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number': {
      if (!Number.isFinite(value)) {
        throw new Error(`non-finite number is not JSON-safe: ${value}`);
      }
      return String(value);
    }
    case 'object': {
      if (seen.has(value)) throw new Error('cyclic value is not JSON-safe');
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          return `[${value.map((item) => serialize(item, seen)).join(',')}]`;
        }
        const record = value as { [key: string]: JsonValue };
        const keys = Object.keys(record).sort();
        const parts = keys.map((key) => {
          const item = record[key];
          if (item === undefined) {
            throw new Error(`undefined value at key "${key}" is not JSON-safe`);
          }
          return `${JSON.stringify(key)}:${serialize(item, seen)}`;
        });
        return `{${parts.join(',')}}`;
      } finally {
        seen.delete(value);
      }
    }
    default:
      throw new Error(`value of type ${typeof value} is not JSON-safe`);
  }
}
