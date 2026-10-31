import { createHash } from 'node:crypto';
/** PostgreSQL jsonb does not retain object key order. Array order remains meaningful. */
export function canonicalEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalEvidence);
  if (value && typeof value === 'object' && !(value instanceof Date))
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonicalEvidence(v)]),
    );
  return value;
}
export const evidenceDigest = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonicalEvidence(value)))
    .digest('hex');

/** New scheduling semantics require a fresh review; old stored approvals stay historical. */
export function currentEditorialConfiguration(config: Record<string, unknown>) {
  return (
    config.policyVersion === 2 &&
    ['research_update', 'daily_legislative_brief'].includes(String(config.template)) &&
    Array.isArray(config.includedKinds) &&
    config.includedKinds.length === 1 &&
    config.includedKinds[0] === 'research' &&
    !['reportId', 'reportVersion', 'monitorIds', 'categoryMapping'].some((key) => key in config)
  );
}
