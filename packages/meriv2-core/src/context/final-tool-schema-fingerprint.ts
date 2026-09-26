import { createHash } from 'node:crypto';

export const MERI_FINAL_TOOL_SCHEMA_VERSION = 'meriv3.final-offered-schema.v1' as const;

/** Canonical JSON for content-addressing JSON values across API/orchestrator. */
export function canonicalMeriJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value) as string;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(canonicalMeriJson).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalMeriJson(item)}`).join(',')}}`;
  }
  throw new Error('meri_schema_not_json');
}

/** Fingerprints the exact ordered provider-facing function schema array. */
export function fingerprintMeriFinalToolSchemas(
  schemas: readonly unknown[],
  version: string = MERI_FINAL_TOOL_SCHEMA_VERSION,
): string {
  if (!Array.isArray(schemas) || !version.trim()) throw new Error('meri_schema_invalid');
  return createHash('sha256')
    .update(canonicalMeriJson({ version, schemas }), 'utf8')
    .digest('hex');
}
