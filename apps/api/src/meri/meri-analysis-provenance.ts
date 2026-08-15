import { createHash } from 'node:crypto';

/**
 * Deterministic JSON serialization for audit/provenance hashes.
 *
 * Analysis results originate as JSON, but ordinary JSON.stringify preserves
 * object insertion order. Two logically identical result/spec objects could
 * therefore produce different hashes. This serializer sorts object keys while
 * deliberately preserving array order (chart rows and series are ordered).
 * Unsupported object values follow JSON semantics: undefined/function/symbol
 * properties are omitted and array holes become null.
 */
export function canonicalAnalysisJson(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : 'null';
    case 'bigint':
      // Sandbox/API payloads must be JSON-safe. Encoding an unexpected bigint
      // as a decimal string is deterministic and avoids a hashing crash.
      return JSON.stringify(value.toString());
    case 'undefined':
    case 'function':
    case 'symbol':
      return 'null';
    case 'object':
      break;
    default:
      return 'null';
  }

  if (Array.isArray(value)) {
    return `[${value
      .map((item) =>
        item === undefined || typeof item === 'function' || typeof item === 'symbol'
          ? 'null'
          : canonicalAnalysisJson(item),
      )
      .join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const fields = Object.keys(record)
    .filter((key) => {
      const item = record[key];
      return item !== undefined && typeof item !== 'function' && typeof item !== 'symbol';
    })
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalAnalysisJson(record[key])}`);
  return `{${fields.join(',')}}`;
}

export function sha256CanonicalAnalysisJson(value: unknown): string {
  return createHash('sha256').update(canonicalAnalysisJson(value), 'utf8').digest('hex');
}
