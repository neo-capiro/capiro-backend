/**
 * Status vocabulary for a real send record.
 *
 * The terminal-status sets are pinned against what the backend can actually
 * produce (`OutreachV3FullGenerationWorkerService.finalizeJob()`). They have
 * drifted from a second copy twice in production — once with both places
 * missing `partial` at the same time, which showed up only as a progress bar
 * that never finished and no error anywhere. There is one copy now; keep it
 * that way, and keep `outreach-send-record-model.test.ts` asserting it against
 * the backend's list rather than against another copy in this repo.
 */
import type { OutreachV3SendIntentView } from './engagement-api.js';

const SEND_TERMINAL = new Set([
  'sent',
  'failed',
  'complete',
  'canceled',
  'cancelled',
  'delivery_unknown',
  'partial',
]);

const GENERATION_TERMINAL = new Set(['complete', 'failed', 'canceled', 'cancelled', 'partial']);

export function isSendTerminal(status?: string | null): boolean {
  return Boolean(status && SEND_TERMINAL.has(status.toLowerCase()));
}

export function isGenerationTerminal(status?: string | null): boolean {
  return Boolean(status && GENERATION_TERMINAL.has(status.toLowerCase()));
}

export function statusTone(
  value?: string | null,
): 'navy' | 'amber' | 'red' | 'neutral' {
  const status = (value ?? '').toLowerCase();
  if (
    status.includes('failed') ||
    status.includes('blocked') ||
    status.includes('rejected') ||
    status.includes('error')
  )
    return 'red';
  if (
    status.includes('held') ||
    status.includes('review') ||
    status.includes('stale') ||
    status.includes('unknown') ||
    status.includes('pending') ||
    status.includes('action')
  )
    return 'amber';
  if (
    status.includes('approved') ||
    status.includes('pass') ||
    status.includes('sent') ||
    status.includes('complete') ||
    status.includes('written') ||
    status.includes('eligible') ||
    status.includes('ready')
  )
    return 'navy';
  return 'neutral';
}

export function sendProgress(intent: OutreachV3SendIntentView): {
  complete: number;
  total: number;
  percent: number;
} {
  const totals = intent.totals ?? {};
  const total = Math.max(
    intent.deliveries.length,
    Number(totals.total ?? 0),
    Number(totals.sent ?? 0) +
      Number(totals.failed ?? 0) +
      Number(totals.unknown ?? 0) +
      Number(totals.skipped ?? 0) +
      Number(totals.held ?? 0),
  );
  const complete =
    Number(totals.sent ?? 0) +
    Number(totals.failed ?? 0) +
    Number(totals.unknown ?? 0) +
    Number(totals.skipped ?? 0) +
    Number(totals.held ?? 0);
  return {
    complete,
    total,
    percent: Math.min(100, Math.round((complete / Math.max(1, total)) * 100)),
  };
}
