// Async outreach job client (plan W4.4). Wraps the backend job pipeline
// (POST /outreach/jobs/generate, GET /outreach/jobs/:id, cancel, per-item retry)
// so the wizard can run large generations off the request path and poll for
// progress — instead of the synchronous generate-batch call that is bounded by
// the ~180s ALB idle ceiling.
//
// Used ONLY when GET /me reports features.outreachAsyncGen (env kill-switch AND
// the per-tenant canary flag). When off, the wizard keeps the sync path and none
// of this runs. The pure mappers below have no React/network dependency and are
// unit-tested; the hook wraps them with react-query polling.

import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { AxiosInstance } from 'axios';
import { markdownishToHtml, sanitizeHtml } from './richtext.js';
import type { GenSlot } from './generation.js';

/** Backend OutreachJobItem.status (prisma schema.prisma). */
export type JobItemStatus =
  | 'pending'
  | 'claimed'
  | 'generating'
  | 'done'
  | 'failed'
  | 'sending'
  | 'sent'
  | 'skipped'
  // Phase 0: the grounding auditor HELD this draft. Terminal — it needs a
  // reviewer or a new edited version, and it is never auto-retried.
  | 'held';

/** Backend OutreachJob.status. */
export type JobStatus = 'queued' | 'running' | 'partial' | 'complete' | 'failed' | 'canceled';

export interface JobItem {
  id: string;
  recipientKey: string;
  status: JobItemStatus;
  /**
   * Phase 0: a held item keeps its REAL subject/body plus the version metadata
   * the wizard needs to look the version up and link to its review. The server
   * allowlists these fields, so no auditor internals arrive here.
   */
  result: {
    subject?: string;
    body?: string;
    versionId?: string;
    artifactId?: string;
    version?: number;
    generationStatus?: string;
    auditStatus?: string;
    approvalStatus?: string;
    reviewRequestId?: string;
    contextNote?: string;
  } | null;
  error: string | null;
  attempt: number;
}

export interface OutreachJobResponse {
  job: { id: string; status: JobStatus };
  items: JobItem[];
}

/** A job is still worth polling while queued or running (else it is terminal:
 *  partial | complete | failed | canceled). */
export function isJobActive(status: JobStatus | undefined): boolean {
  return status === 'queued' || status === 'running';
}

/** Submit a bulk generation as an async job; mints its own idempotency requestKey
 *  (never reuse across a genuinely new generate — a repeat key returns the stale
 *  job). Returns the created/deduped jobId. */
export async function submitOutreachGenerateJob(
  api: AxiosInstance,
  body: Record<string, unknown>,
): Promise<{ jobId: string; deduped: boolean }> {
  const requestKey = crypto.randomUUID();
  const res = await api.post<{ jobId: string; deduped: boolean }>(
    '/api/engagement/outreach/jobs/generate',
    { ...body, requestKey },
  );
  return res.data;
}

export async function cancelOutreachJob(api: AxiosInstance, jobId: string): Promise<void> {
  await api.post(`/api/engagement/outreach/jobs/${jobId}/cancel`, {});
}

export async function retryOutreachJobItem(
  api: AxiosInstance,
  jobId: string,
  itemId: string,
): Promise<{ retried: boolean; reason?: string }> {
  const res = await api.post<{ retried: boolean; reason?: string }>(
    `/api/engagement/outreach/jobs/${jobId}/items/${itemId}/retry`,
    {},
  );
  return res.data;
}

/** resultId → [genKey] (one recipient can back several slots, e.g. a person in two
 *  lists). Mirrors the sync path's byId fan-out. */
export function buildResultIdToGenKeys(slots: GenSlot[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const s of slots) {
    const list = m.get(s.resultId) ?? [];
    list.push(s.genKey);
    m.set(s.resultId, list);
  }
  return m;
}

export interface JobProgress {
  total: number;
  done: number;
  failed: number;
  skipped: number;
  /** Held for review: terminal, but NOT a success and NOT a failure. */
  held: number;
  /** done + failed + skipped + held — items that reached a terminal state. */
  settled: number;
  active: boolean;
}

/** Live progress from the ITEM rows (NOT job.totals — the backend writes totals
 *  only once at finalize, so a poller that trusted them would show a frozen 0). */
export function jobItemsProgress(items: JobItem[], jobStatus: JobStatus | undefined): JobProgress {
  let done = 0;
  let failed = 0;
  let skipped = 0;
  let held = 0;
  for (const it of items) {
    if (it.status === 'done' || it.status === 'sent') done++;
    else if (it.status === 'failed') failed++;
    else if (it.status === 'skipped') skipped++;
    else if (it.status === 'held') held++;
  }
  return {
    total: items.length,
    done,
    failed,
    skipped,
    held,
    // 'held' is terminal: excluding it would leave the progress bar stuck short
    // of 100% forever on a job whose every draft was held.
    settled: done + failed + skipped + held,
    active: isJobActive(jobStatus),
  };
}

export interface DraftPatchEntry {
  genKey: string;
  subject: string;
  body: string;
  status: 'ready' | 'error' | 'held';
  // Phase 0 version metadata, present for done AND held items.
  versionId?: string;
  artifactId?: string;
  version?: number;
  generationStatus?: string;
  auditStatus?: string;
  approvalStatus?: string;
  reviewRequestId?: string;
  contextNote?: string;
}

/**
 * Turn TERMINAL job items into wizard draft entries, fanning one item out to every
 * genKey that shares its recipientKey. 'done' → a ready draft (markdown→sanitized
 * HTML, exactly like the sync onSuccess); 'failed' → an error placeholder; 'skipped'
 * and all non-terminal statuses → omitted (left for a later poll / the sync default).
 * Never writes a transient state into generatedEmails, so Send/Save/Improve — which
 * read that map — need no changes.
 */
export function mapJobItemsToDraftPatch(
  items: JobItem[],
  resultIdToGenKeys: Map<string, string[]>,
  placeholder: (genKey: string) => { subject: string; body: string },
): DraftPatchEntry[] {
  const out: DraftPatchEntry[] = [];
  for (const it of items) {
    const genKeys = resultIdToGenKeys.get(it.recipientKey);
    if (!genKeys) continue;

    // Version metadata rides along for both done and held items.
    const meta = {
      ...(it.result?.versionId ? { versionId: it.result.versionId } : {}),
      ...(it.result?.artifactId ? { artifactId: it.result.artifactId } : {}),
      ...(it.result?.version != null ? { version: it.result.version } : {}),
      ...(it.result?.generationStatus ? { generationStatus: it.result.generationStatus } : {}),
      ...(it.result?.auditStatus ? { auditStatus: it.result.auditStatus } : {}),
      ...(it.result?.approvalStatus ? { approvalStatus: it.result.approvalStatus } : {}),
      ...(it.result?.reviewRequestId ? { reviewRequestId: it.result.reviewRequestId } : {}),
      ...(it.result?.contextNote ? { contextNote: it.result.contextNote } : {}),
    };

    if (it.status === 'done') {
      const subject = it.result?.subject ?? '';
      const body = sanitizeHtml(markdownishToHtml(it.result?.body ?? ''));
      for (const genKey of genKeys) out.push({ genKey, subject, body, status: 'ready', ...meta });
    } else if (it.status === 'held') {
      // Phase 0 (§3.g2): PRESERVE the held content. Manufacturing a placeholder
      // here is what previously destroyed the text a reviewer had to read.
      const subject = it.result?.subject ?? '';
      const body = sanitizeHtml(markdownishToHtml(it.result?.body ?? ''));
      for (const genKey of genKeys) out.push({ genKey, subject, body, status: 'held', ...meta });
    } else if (it.status === 'failed') {
      for (const genKey of genKeys) {
        const ph = placeholder(genKey);
        out.push({ genKey, subject: ph.subject, body: ph.body, status: 'error' });
      }
    }
    // skipped / pending / claimed / generating → not terminal-for-draft; skip.
  }
  return out;
}

/** Transient (non-terminal) per-genKey status for the rail spinner/chips. */
export function transientStatusByGenKey(
  items: JobItem[],
  resultIdToGenKeys: Map<string, string[]>,
): Record<string, 'queued' | 'generating'> {
  const out: Record<string, 'queued' | 'generating'> = {};
  for (const it of items) {
    const label =
      it.status === 'generating' || it.status === 'claimed'
        ? 'generating'
        : it.status === 'pending'
          ? 'queued'
          : null;
    if (!label) continue;
    for (const genKey of resultIdToGenKeys.get(it.recipientKey) ?? []) out[genKey] = label;
  }
  return out;
}

/**
 * Poll a dynamic set of jobIds. Each job polls every 2s while queued/running, then
 * stops (refetchInterval false) once terminal — an actively-watched progress UI, so
 * a tighter interval than the 15-30s passive pollers elsewhere is intentional. Not
 * background-refetched (only while the wizard tab is focused).
 */
export function useOutreachJobs(
  api: AxiosInstance,
  jobIds: string[],
): { byJob: Record<string, OutreachJobResponse>; anyActive: boolean } {
  const results = useQueries({
    queries: jobIds.map((jobId) => ({
      queryKey: ['outreach-job', jobId] as const,
      queryFn: async () =>
        (await api.get<OutreachJobResponse>(`/api/engagement/outreach/jobs/${jobId}`)).data,
      refetchInterval: (query: { state: { data?: OutreachJobResponse } }) =>
        isJobActive(query.state.data?.job.status) ? 2000 : (false as const),
      refetchIntervalInBackground: false,
    })),
  });
  return useMemo(() => {
    const byJob: Record<string, OutreachJobResponse> = {};
    let anyActive = false;
    results.forEach((r, i) => {
      const data = r.data as OutreachJobResponse | undefined;
      if (data) {
        byJob[jobIds[i]!] = data;
        if (isJobActive(data.job.status)) anyActive = true;
      } else {
        anyActive = true; // not yet loaded → treat as active so polling continues
      }
    });
    return { byJob, anyActive };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    JSON.stringify(results.map((r) => (r.data as OutreachJobResponse | undefined)?.job)),
    jobIds.join(','),
  ]);
}
