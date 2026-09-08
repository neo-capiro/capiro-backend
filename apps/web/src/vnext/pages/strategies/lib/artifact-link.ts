import type { ArtifactType } from '../../../../pages/strategy/types.js';

export function strategyArtifactHref(type: ArtifactType, reference: string): string {
  return type === 'workspace_draft'
    ? `/workspace/draft/${encodeURIComponent(reference)}`
    : `/engagement/outreach/draft/${encodeURIComponent(reference)}`;
}

/** Accept the user-facing Capiro link while preserving support for older references. */
export function strategyArtifactReference(type: ArtifactType, input: string, origin: string): string | null {
  const value = input.trim();
  if (!value || value.length > 2000) return null;
  if (/^[A-Za-z0-9_-]{1,300}$/.test(value)) return value;
  try {
    const link = new URL(value, origin);
    if (link.origin !== new URL(origin).origin) return null;
    const prefix = type === 'workspace_draft' ? '/workspace/draft/' : '/engagement/outreach/draft/';
    if (!link.pathname.startsWith(prefix)) return null;
    const reference = decodeURIComponent(link.pathname.slice(prefix.length));
    return /^[A-Za-z0-9_-]{1,300}$/.test(reference) ? reference : null;
  } catch { return null; }
}
