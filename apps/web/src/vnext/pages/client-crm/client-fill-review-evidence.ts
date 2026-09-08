import type { FillFinding } from '../../adapters/legacy/useClientFillWithMeri.js';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function sourceUrl(value: unknown): string | null {
  const url = text(value);
  if (!url) return null;
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol) ? url : null;
  } catch {
    return null;
  }
}

/** A proposal's score cannot establish which organization a public record concerns. */
export function clientAttributionEvidence(finding: FillFinding) {
  const proposed = record(finding.proposedValue);
  const metadata = record(proposed.metadata);
  const match = record(metadata.clientMatch);
  const source = text(proposed.sourceType);
  if (source !== 'fara' && source !== 'testimony') return null;
  const confirmed = match.method === 'confirmed_client_intel_mapping';
  const basis = confirmed
    ? 'Confirmed client-to-source mapping'
    : match.method === 'organization_name'
      ? 'Organization name match; confirmation is still required'
      : match.method === 'name_similarity'
        ? 'Name similarity only'
        : 'No client-matching explanation was provided';
  const identity: Array<[string, string]> = [];
  for (const [label, value] of [
    ['Registrant', metadata.registrantName],
    ['Represented organization', metadata.foreignPrincipal],
    ['Witness and affiliation in source', metadata.witness],
  ] as const) {
    const resolved = text(value);
    if (resolved) identity.push([label, resolved]);
  }
  const matchedRole =
    match.matchedRole === 'registrant'
      ? 'Registrant'
      : match.matchedRole === 'foreign_principal'
        ? 'Represented organization'
        : null;
  if (matchedRole) identity.push(['Field used for the match', matchedRole]);
  return { confirmed, basis, identity, url: sourceUrl(proposed.sourceUrl) };
}

/** Accepted server findings are durable applications; local selections are separate. */
export function appliedFindingCount(findings: FillFinding[], lastApplyCount = 0): number {
  return Math.max(
    findings.filter((finding) => finding.status === 'accepted' || Boolean(finding.appliedAt))
      .length,
    lastApplyCount,
  );
}
