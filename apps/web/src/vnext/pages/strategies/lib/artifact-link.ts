import type { ArtifactType } from '../../../../pages/strategy/types.js';

export function strategyArtifactHref(type: ArtifactType, reference: string): string {
  return type === 'workspace_draft'
    ? `/workspace/draft/${encodeURIComponent(reference)}`
    : `/engagement/outreach/draft/${encodeURIComponent(reference)}`;
}
