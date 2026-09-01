/**
 * In-memory, per-process live preview of a draft's body text while it is
 * still streaming, keyed by generationKey.
 *
 * Deliberately NOT persisted. This is cosmetic — a "watching it get written"
 * preview for the Drafts step while the real generation call (1.5-11 minutes
 * at the pinned reasoning effort) is in flight — never the source of truth:
 * the actual draft version, written once generation succeeds, is what
 * everything downstream (approval, send, audit) reads. A caller should only
 * ever read this for an item whose job status is still non-terminal; once an
 * item settles, the real draft is the answer, not this.
 *
 * Correct only when engagement-api runs as a single instance — a second
 * process would never see updates written on the first. That matches today's
 * deployment (capiro-dev-engagement-api is desiredCount=1); if that changes,
 * this needs to move to a shared store (Redis, or a throttled DB column)
 * before it would show correct previews across instances.
 */
import { Injectable } from '@nestjs/common';

interface PreviewEntry {
  text: string;
  updatedAt: number;
}

@Injectable()
export class OutreachV3LivePreviewService {
  private readonly entries = new Map<string, PreviewEntry>();
  private readonly lastWriteAt = new Map<string, number>();

  /** Bounded so a long-lived process cannot grow this without limit. */
  private static readonly MAX_ENTRIES = 500;
  /**
   * Well past any single draft's own generation timeout ceiling
   * (LLM_LONG_GENERATION_TIMEOUT_MS = 15 min) — an entry this old belongs to
   * a slot that crashed or was abandoned mid-stream, not one still running.
   */
  private static readonly TTL_MS = 30 * 60_000;
  /**
   * A structured-output model can emit dozens of deltas per second; writing
   * every one would be pure churn for a UI that shows the SAME text either
   * way one throttle window later. Any delta short of the throttle window is
   * simply dropped — see the class doc: the next write (or the real draft,
   * once the item settles) supersedes it, so nothing is lost that matters.
   */
  private static readonly THROTTLE_MS = 400;

  update(generationKey: string, text: string): void {
    const now = Date.now();
    const last = this.lastWriteAt.get(generationKey) ?? 0;
    if (now - last < OutreachV3LivePreviewService.THROTTLE_MS) return;
    this.lastWriteAt.set(generationKey, now);
    this.entries.set(generationKey, { text, updatedAt: now });
    if (this.entries.size > OutreachV3LivePreviewService.MAX_ENTRIES) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
        this.lastWriteAt.delete(oldestKey);
      }
    }
  }

  get(generationKey: string): string | null {
    const entry = this.entries.get(generationKey);
    if (!entry) return null;
    if (Date.now() - entry.updatedAt > OutreachV3LivePreviewService.TTL_MS) {
      this.entries.delete(generationKey);
      this.lastWriteAt.delete(generationKey);
      return null;
    }
    return entry.text;
  }
}
