/**
 * Meri inline citations (P0-3). The canonical implementation now lives in
 * @capiro/shared (MeriCitation + extract/format/validate) so the apps/api legacy
 * chat loop and the meriv2-orchestrator chat loop number/inject/validate the
 * SAME way and can't drift (1B.5). Re-exported here under the original names so
 * existing imports (and meri-citations.helpers.spec.ts) are unchanged.
 */
export {
  extractCitationsFromToolResult,
  formatCitationsForPrompt,
  validateCitationMarkers,
  type MeriCitation,
} from '@capiro/shared';
