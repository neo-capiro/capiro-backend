import type { AxiosInstance } from 'axios';

/**
 * Client submission history — the real store behind "what this client asked
 * for and what happened" (`ClientSubmissionHistory`, wired in
 * `client-capabilities.service.ts`).
 *
 * Scope note, because the design asks for more than this table holds: a row
 * carries fiscal year, title, free-text meta, an outcome and its coarse type,
 * and notes. It has **no vehicle, no activity type, no evidence class and no
 * lifecycle steps** — so the design's advocacy lifecycle track and its
 * public-record/client-verified/inferred evidence taxonomy have nothing to
 * read here, and are not derived from these fields (see the ship notes for
 * wire-audit "4 New capability" rows 1 and 5).
 *
 * Rows hang off a capability: there is no client-wide HTTP read. The service
 * has `listClientHistory`, but it is not routed — only Meri's tool layer calls
 * it — so a client-wide view is composed here from the client's capabilities.
 */

export type SubmissionOutcomeType = 'success' | 'partial' | 'failed' | 'in_progress';

export interface SubmissionHistoryRow {
  id: string;
  clientId: string;
  capabilityId: string | null;
  fiscalYear: string;
  title: string;
  meta: string | null;
  outcome: string | null;
  outcomeType: SubmissionOutcomeType | string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSubmissionHistoryInput {
  fiscalYear: string;
  title: string;
  meta?: string;
  outcome?: string;
  outcomeType?: SubmissionOutcomeType;
  notes?: string;
}

export const submissionHistoryKeys = {
  forCapability: (clientId: string, capabilityId: string) =>
    ['client-submission-history', clientId, capabilityId] as const,
};

export async function listCapabilityHistory(
  api: AxiosInstance,
  clientId: string,
  capabilityId: string,
): Promise<SubmissionHistoryRow[]> {
  return (
    await api.get<SubmissionHistoryRow[]>(
      `/api/clients/${clientId}/capabilities/${capabilityId}/history`,
    )
  ).data;
}

export async function createCapabilityHistory(
  api: AxiosInstance,
  clientId: string,
  capabilityId: string,
  input: CreateSubmissionHistoryInput,
): Promise<SubmissionHistoryRow> {
  return (
    await api.post<SubmissionHistoryRow>(
      `/api/clients/${clientId}/capabilities/${capabilityId}/history`,
      input,
    )
  ).data;
}

/** Outcome type → the design's pill tone vocabulary. */
export const OUTCOME_TONE: Record<string, 'success' | 'warning' | 'error' | 'gray'> = {
  success: 'success',
  partial: 'warning',
  failed: 'error',
  in_progress: 'gray',
};

export const OUTCOME_TYPE_LABEL: Record<string, string> = {
  success: 'Succeeded',
  partial: 'Partial',
  failed: 'Not included',
  in_progress: 'In progress',
};

/** Newest fiscal year first, then most recently recorded. */
export function sortSubmissions(rows: SubmissionHistoryRow[]): SubmissionHistoryRow[] {
  return [...rows].sort(
    (a, b) =>
      b.fiscalYear.localeCompare(a.fiscalYear) || Date.parse(b.createdAt) - Date.parse(a.createdAt),
  );
}
