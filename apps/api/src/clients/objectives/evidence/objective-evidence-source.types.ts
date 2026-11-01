import type { RetainedNewsRights } from '../../../intelligence/news/news-evidence-read.js';

export type ObjectiveEvidenceReference =
  | { kind: 'document'; attachmentId: string }
  | { kind: 'news'; articleId: string; observationId: string };
export type ObjectiveEvidenceSelector = ObjectiveEvidenceReference & { expectedDigest: string };
export interface ObjectiveEvidenceSnapshot {
  selector: ObjectiveEvidenceSelector;
  version: string;
  digest: string;
  provenanceDigest: string;
  title: string;
  sourceSystem: 'client_document' | 'retained_news';
  sourceUrl: string | null;
  summary: string | null;
  rights: 'private_document' | RetainedNewsRights;
  complete: boolean;
  observedAt: string | null;
}
export interface ObjectiveEvidenceScope {
  clientId: string;
  objectiveId: string;
  objectiveVersion: number;
}
export type ObjectiveEvidenceInspection =
  | { status: 'current' | 'stale'; snapshot: ObjectiveEvidenceSnapshot }
  | { status: 'unavailable' };
