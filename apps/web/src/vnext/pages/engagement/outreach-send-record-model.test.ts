import { describe, expect, it } from 'vitest';
import type { OutreachV3SendIntentView } from './engagement-api.js';
import {
  isGenerationTerminal,
  isSendTerminal,
  sendProgress,
  statusTone,
} from './outreach-send-record-model.js';

/**
 * These statuses are the backend's, not this module's: see
 * `OutreachV3FullGenerationWorkerService.finalizeJob()`. A status the backend
 * can produce that this module does not call terminal shows up as a progress
 * bar that never finishes, with no error anywhere — which is how the missing
 * `partial` shipped twice.
 *
 * The predecessor of this file also compared these against a SECOND copy of the
 * same lists in `outreach-v3-phase1-shared.tsx`. That copy is gone with the
 * phase-1 workspaces, so the comparison is now against the backend's list
 * directly, which is the thing that was actually worth pinning.
 */
const BACKEND_GENERATION_TERMINAL = ['complete', 'failed', 'canceled', 'cancelled', 'partial'];
const BACKEND_GENERATION_RUNNING = ['queued', 'running'];
const BACKEND_SEND_TERMINAL = [
  'sent',
  'failed',
  'complete',
  'canceled',
  'cancelled',
  'delivery_unknown',
  'partial',
];
const BACKEND_SEND_RUNNING = ['queued', 'sending', 'accepted'];

describe('terminal statuses', () => {
  it('recognizes every terminal generation status the backend can produce', () => {
    for (const status of BACKEND_GENERATION_TERMINAL) {
      expect(isGenerationTerminal(status)).toBe(true);
    }
    for (const status of BACKEND_GENERATION_RUNNING) {
      expect(isGenerationTerminal(status)).toBe(false);
    }
  });

  it('recognizes every terminal send status the backend can produce', () => {
    for (const status of BACKEND_SEND_TERMINAL) {
      expect(isSendTerminal(status)).toBe(true);
    }
    for (const status of BACKEND_SEND_RUNNING) {
      expect(isSendTerminal(status)).toBe(false);
    }
  });

  it('treats an absent status as not terminal, and is case-insensitive', () => {
    expect(isSendTerminal(null)).toBe(false);
    expect(isSendTerminal(undefined)).toBe(false);
    expect(isSendTerminal('')).toBe(false);
    expect(isSendTerminal('SENT')).toBe(true);
    expect(isGenerationTerminal('Partial')).toBe(true);
  });

  it('keeps delivery_unknown terminal — automation must not wait on it forever', () => {
    // Unknown is a real provider outcome, not a pending one. Treating it as
    // in-flight is what leaves a send record spinning with nothing to retry.
    expect(isSendTerminal('delivery_unknown')).toBe(true);
  });
});

describe('statusTone', () => {
  it('maps failure, attention and success vocabularies to their tones', () => {
    for (const status of ['failed', 'blocked', 'rejected', 'error']) {
      expect(statusTone(status)).toBe('red');
    }
    for (const status of ['held', 'review', 'stale', 'unknown', 'pending', 'action']) {
      expect(statusTone(status)).toBe('amber');
    }
    for (const status of ['approved', 'sent', 'complete', 'eligible']) {
      expect(statusTone(status)).toBe('navy');
    }
    expect(statusTone(null)).toBe('neutral');
    expect(statusTone('queued')).toBe('neutral');
  });

  it('reads delivery_unknown as attention, not as success', () => {
    expect(statusTone('delivery_unknown')).toBe('amber');
  });
});

function intent(totals: Record<string, number>, deliveries = 0): OutreachV3SendIntentView {
  return {
    totals,
    deliveries: Array.from({ length: deliveries }, (_, index) => ({ id: `d${index}` })),
  } as unknown as OutreachV3SendIntentView;
}

describe('sendProgress', () => {
  it('counts every terminal outcome as progress, not just the successful ones', () => {
    const progress = sendProgress(intent({ sent: 2, failed: 1, unknown: 1, total: 4 }));
    expect(progress.complete).toBe(4);
    expect(progress.total).toBe(4);
    expect(progress.percent).toBe(100);
  });

  it('takes the largest defensible total so the bar cannot exceed 100%', () => {
    // The server sends `totals` and `deliveries` separately; a total smaller
    // than the delivery rows already on screen would render as over-complete.
    const progress = sendProgress(intent({ sent: 3, total: 1 }, 3));
    expect(progress.total).toBe(3);
    expect(progress.percent).toBeLessThanOrEqual(100);
  });

  it('reports nothing rather than dividing by zero on an empty intent', () => {
    const progress = sendProgress(intent({}));
    expect(progress.total).toBe(0);
    expect(progress.complete).toBe(0);
    expect(Number.isFinite(progress.percent)).toBe(true);
  });
});
