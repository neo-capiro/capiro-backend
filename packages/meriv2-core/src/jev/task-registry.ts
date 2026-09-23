import type { JevTask } from './jev-config';

export const JEV_TASK_REGISTRY_VERSION = 'jev-task-registry.v2' as const;
export interface JevTaskRegistration { questionVersion: string; questionType: 'choice' | 'noul' | 'score'; fallback: 'no_change'; rolloutCapability: string; provisional: boolean }
export const JEV_TASK_REGISTRY: Readonly<Record<JevTask, JevTaskRegistration>> = {
  claim_support: { questionVersion: 'claim_support.v1', questionType: 'choice', fallback: 'no_change', rolloutCapability: 'CLAIM_ASSESSMENT', provisional: false },
  citation_support: { questionVersion: 'citation_support.v1', questionType: 'choice', fallback: 'no_change', rolloutCapability: 'EVIDENCE_ACCURACY', provisional: true },
  passage_relevance: { questionVersion: 'passage_relevance.v1', questionType: 'score', fallback: 'no_change', rolloutCapability: 'PASSAGE_SELECTION', provisional: false },
  conflict_detection: { questionVersion: 'conflict_detection.v1', questionType: 'choice', fallback: 'no_change', rolloutCapability: 'CLAIM_ASSESSMENT', provisional: true },
  status_selection: { questionVersion: 'status_selection.v1', questionType: 'choice', fallback: 'no_change', rolloutCapability: 'STATUS_PROVENANCE', provisional: true },
};