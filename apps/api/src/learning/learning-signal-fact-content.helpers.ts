/**
 * `client_profile_fill_finding.proposed_value_jsonb` has no single fixed
 * shape — it varies by `kind` (a person finding carries name/email/role, a
 * capability finding carries name/type/description, ...). Rather than
 * special-case every kind, preserve structured field values, including lists and numeric attributes, in
 * one embeddable line — good enough for a similarity search, not intended
 * to be a polished human-facing sentence.
 */
export function factTextFromValue(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  if (!value || typeof value !== 'object') return null;
  const parts = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v != null && (typeof v !== 'string' || v.trim()))
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v.trim() : JSON.stringify(v)}`);
  return parts.length ? parts.join('; ') : null;
}
