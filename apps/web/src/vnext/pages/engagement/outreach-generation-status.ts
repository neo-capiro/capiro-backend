/**
 * What the Drafts step needs to know about the generation job behind it.
 *
 * The builder's Drafts step used to fetch the draft list and nothing else, so a
 * generation job that was still running looked exactly like one that had never
 * been started, and one that had FAILED looked the same again. All three
 * rendered "No drafts yet. Accept the packet on the review step…" — which tells
 * the user to redo the thing they just did, and hides a hard failure behind
 * advice that cannot help. This module turns the job row into the three states
 * that actually differ.
 *
 * Observed live on 2026-08-29: a campaign accepted cleanly (`blockers: []`),
 * the worker claimed the job four seconds later, and both items failed with
 * `PLAN_GENERATION_FAILED` — the upstream model provider had no credits. The
 * UI showed the "accept the packet" empty state for the next half hour.
 */

import type { OutreachV3GenerationJob, OutreachV3GenerationJobItem } from './engagement-api.js';
import { isGenerationTerminal } from './outreach-send-record-model.js';

export interface OutreachGenerationProgress {
  /** Items that have reached any terminal state, successful or not. */
  done: number;
  total: number;
  failed: number;
  /** Distinct machine error codes across failed items, in first-seen order. */
  codes: string[];
}

export type OutreachGenerationState =
  /** No job has ever been created for this session. */
  | { kind: 'none' }
  | { kind: 'running'; progress: OutreachGenerationProgress; eta: OutreachGenerationEta }
  /** Terminal, and produced no drafts at all. */
  | { kind: 'failed'; progress: OutreachGenerationProgress }
  /** Terminal, produced some drafts but not for every recipient. */
  | { kind: 'partial'; progress: OutreachGenerationProgress }
  /** Terminal and complete — the reader shows drafts, no banner needed. */
  | { kind: 'ready' };

export interface OutreachGenerationEta {
  /**
   * Extrapolated from the job's own elapsed time and completion count so far
   * (elapsed ÷ done × remaining) rather than a fixed per-draft constant. Each
   * recipient's draft is two sequential model calls at the pinned reasoning
   * effort, so a hardcoded seconds-per-draft figure would drift stale against
   * whatever concurrency/model-latency conditions are actually happening;
   * this self-corrects against them instead.
   *
   * Null until at least one item has finished — before that there is nothing
   * real to extrapolate from, so the caller should show an "estimating…"
   * state rather than a number.
   */
  estimatedSecondsRemaining: number | null;
}

const ITEM_TERMINAL = new Set(['done', 'failed', 'skipped', 'sent']);

/**
 * The wire type declares `error` as `{ code?, message? }`, but the server's
 * `safeError()` returns a plain truncated STRING. Read both rather than
 * trusting either: a mistyped field is exactly how an error code becomes
 * `[object Object]` on screen.
 */
export function outreachGenerationItemCode(item: OutreachV3GenerationJobItem): string | null {
  const raw: unknown = item.error;
  if (typeof raw === 'string') return raw.trim() || null;
  if (raw && typeof raw === 'object') {
    const code = (raw as { code?: unknown }).code;
    const message = (raw as { message?: unknown }).message;
    if (typeof code === 'string' && code.trim()) return code.trim();
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return null;
}

const LIVE_PREVIEW_SNIPPET_CHARS = 140;

/**
 * A short snippet of whichever in-flight item currently has a live preview,
 * or null when nothing is streaming (streaming off, no in-flight item has
 * caught up to the server's throttle window yet, or generation isn't
 * running). Concurrency means several items can be streaming at once — this
 * picks the first one found with text rather than trying to show all of
 * them, since one representative "it's actively writing" signal is the point,
 * not a per-recipient breakdown the rail doesn't have room for anyway.
 */
export function outreachGenerationLivePreviewSnippet(
  job: OutreachV3GenerationJob | null | undefined,
): string | null {
  const items = job?.items ?? [];
  for (const item of items) {
    const text = item.livePreview?.trim();
    if (text) {
      return text.length > LIVE_PREVIEW_SNIPPET_CHARS
        ? `${text.slice(0, LIVE_PREVIEW_SNIPPET_CHARS)}…`
        : text;
    }
  }
  return null;
}

export function outreachGenerationProgress(
  job: OutreachV3GenerationJob,
): OutreachGenerationProgress {
  const items = job.items ?? [];
  const failedItems = items.filter((item) => item.status === 'failed');
  const codes: string[] = [];
  for (const item of failedItems) {
    const code = outreachGenerationItemCode(item);
    if (code && !codes.includes(code)) codes.push(code);
  }
  return {
    done: items.filter((item) => ITEM_TERMINAL.has(item.status)).length,
    total: items.length,
    failed: failedItems.length,
    codes,
  };
}

/**
 * `draftCount` is the authority on success, not the job status: a job can be
 * `partial` and still have produced every draft the user cares about, and a
 * `complete` job with zero drafts is a failure however it labels itself.
 *
 * `nowMs` defaults to the real clock; tests pass a fixed value so the ETA
 * extrapolation is deterministic.
 */
export function outreachGenerationState(
  job: OutreachV3GenerationJob | null | undefined,
  draftCount: number,
  nowMs: number = Date.now(),
): OutreachGenerationState {
  if (!job) return { kind: 'none' };
  const progress = outreachGenerationProgress(job);
  if (!isGenerationTerminal(job.status)) {
    return { kind: 'running', progress, eta: outreachGenerationEta(job, progress, nowMs) };
  }
  if (draftCount === 0) return { kind: 'failed', progress };
  if (progress.failed > 0) return { kind: 'partial', progress };
  return { kind: 'ready' };
}

export function outreachGenerationEta(
  job: OutreachV3GenerationJob,
  progress: OutreachGenerationProgress,
  nowMs: number,
): OutreachGenerationEta {
  const remaining = progress.total - progress.done;
  if (remaining <= 0) return { estimatedSecondsRemaining: 0 };
  if (progress.done <= 0) return { estimatedSecondsRemaining: null };
  const anchor = job.startedAt ?? job.createdAt;
  const startedMs = anchor ? new Date(anchor).getTime() : NaN;
  if (!Number.isFinite(startedMs)) return { estimatedSecondsRemaining: null };
  const elapsedSeconds = Math.max(0, (nowMs - startedMs) / 1000);
  const secondsPerCompletedItem = elapsedSeconds / progress.done;
  return { estimatedSecondsRemaining: Math.round(secondsPerCompletedItem * remaining) };
}

/**
 * A plain-English ETA note. Deliberately vague rather than false precision —
 * "about 12 min", never "11 min 47 sec" — since this is an extrapolation from
 * a handful of completed items, not a measurement.
 */
export function formatOutreachGenerationEta(estimatedSecondsRemaining: number | null): string {
  if (estimatedSecondsRemaining === null) return 'Estimating time remaining…';
  if (estimatedSecondsRemaining <= 30) return 'Finishing up…';
  if (estimatedSecondsRemaining < 60) return 'Under a minute remaining.';
  const totalMinutes = Math.round(estimatedSecondsRemaining / 60);
  if (totalMinutes < 60) return `About ${totalMinutes} min remaining.`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `About ${hours} hr ${minutes} min remaining.` : `About ${hours} hr remaining.`;
}

/** Poll while a job is in flight; stop the moment it is terminal. */
export function outreachGenerationPollMs(state: OutreachGenerationState): number | false {
  return state.kind === 'running' ? 4000 : false;
}

/**
 * The retry suffix for a failed job, or null when there is nothing to retry.
 *
 * `submit()` is idempotent on `requestKey` and returns the EXISTING job for a
 * known key whatever its status — so re-pressing Accept on an unchanged spec
 * hands back the same failed job forever and no retry is possible. Deriving
 * the suffix from the failed job's own id keeps both properties at once:
 * pressing retry twice on one failed job yields the same key (no duplicate
 * job), while each new failure unlocks a new key.
 *
 * Truncated to 12 characters because the server caps `requestKey` at 128 and
 * `<uuid>:<sha256>` already spends 101 of them.
 */
export function outreachGenerationRetryOf(
  job: OutreachV3GenerationJob | null | undefined,
  /**
   * Omit to judge from the job's own items. Callers that already hold the
   * draft list should pass its length — a draft can outlive the job that made
   * it — but no caller should fetch the list just to ask this question.
   */
  draftCount?: number,
): string | null {
  if (!job) return null;
  const resolved =
    draftCount ?? (job.items ?? []).filter((item) => item.status === 'done').length;
  const state = outreachGenerationState(job, resolved);
  if (state.kind !== 'failed' && state.kind !== 'partial') return null;
  return job.id ? job.id.slice(0, 12) : null;
}
