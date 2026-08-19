/**
 * UI-free memory-file-editor helpers — extracted from MemoryFileEditor.tsx
 * (antd) so the vNext Settings module shares them (extraction pattern, purge
 * Phase 2). MemoryFileEditor re-exports; its public API is unchanged.
 */
import type {
  MemoryReviewSection,
  PendingMemoryReviewState,
} from './pending-memory-review-shared.js';

export interface MemorySectionDef {
  key: string;
  heading: string;
  prompt: string;
  example: string;
}

export interface MemoryFileDef {
  type: string;
  scope: 'firm' | 'client' | 'user';
  label: string;
  blurb: string;
  sections: MemorySectionDef[];
}

export interface MemoryItemSection extends MemoryReviewSection {
  prompt: string;
  example: string;
}

export interface MemoryItemSectionsResp {
  type: string;
  slug: string;
  title: string;
  visibility: string;
  clientId: string | null;
  updatedAt: string | null;
  exists: boolean;
  pendingReview: PendingMemoryReviewState | null;
  sections: MemoryItemSection[];
}

export interface MemorySaveSectionsResp {
  ok?: true;
  updatedAt?: string;
  status?: 'pending_review';
  candidateId?: string;
  activeItemUnchanged?: true;
}

export function settingsMemorySuccessMessage(result: MemorySaveSectionsResp): string {
  return result.status === 'pending_review' ? 'Submitted for approval' : 'Saved';
}

export function memorySaveErrorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const response = (error as { response?: { data?: { message?: unknown } } }).response;
    if (typeof response?.data?.message === 'string') return response.data.message;
    if (Array.isArray(response?.data?.message)) {
      return response.data.message
        .filter((value): value is string => typeof value === 'string')
        .join(' ');
    }
  }
  return error instanceof Error ? error.message : 'Save failed';
}

export function defaultMemoryFileType(scope: 'firm' | 'client' | 'user'): string {
  return scope === 'firm' ? 'firm-soul' : scope === 'user' ? 'user-profile' : 'client-soul';
}
