import type {
  OutreachV3ApproachApproval,
  OutreachV3DraftArtifact,
  OutreachV3GenerationJob,
  OutreachV3GenerationPlan,
  OutreachV3SendIntentView,
} from './engagement-api.js';

export type OutreachPhase1View =
  | 'approach-start'
  | 'approach-review'
  | 'generating'
  | 'draft-review'
  | 'send'
  | 'sending'
  | 'results';

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

export function deriveOutreachPhase1View(input: {
  step: 'drafts' | 'send';
  plan: OutreachV3GenerationPlan | null;
  drafts: OutreachV3DraftArtifact[];
  approach: OutreachV3ApproachApproval | null;
  job: OutreachV3GenerationJob | null;
  intent: OutreachV3SendIntentView | null;
}): OutreachPhase1View {
  const { step, plan, drafts, approach, job, intent } = input;

  if (intent) return isSendTerminal(intent.status) ? 'results' : 'sending';
  if (step === 'send') return 'send';

  // The guided/template-first workflow's review-packet approval never writes
  // representative-sample drafts at all (it authorizes full generation for
  // every recipient directly) — so sampleCount is always 0 for that path.
  // Only fall back to the "write two samples" prompt when there is ALSO no
  // approval of any kind; an existing approach (of either gate version) means
  // generation was already authorized and should be tracked below instead.
  const sampleKeys = new Set(plan?.representativeSampleKeys ?? []);
  const sampleCount = drafts.filter((draft) => sampleKeys.has(draft.generationKey)).length;
  if (!sampleCount && !approach) return 'approach-start';
  if (!approach) return 'approach-review';

  const expected = plan?.slots.length ?? drafts.length;
  const generationActive = Boolean(job && !isGenerationTerminal(job.status));
  if (generationActive || drafts.length < expected) return 'generating';
  return 'draft-review';
}

export function draftNeedsJudgment(draft: OutreachV3DraftArtifact): boolean {
  const current = draft.current;
  if (!current) return true;
  const audit = current.auditStatus.toLowerCase();
  const generation = current.generationStatus.toLowerCase();
  return (
    current.approvalStatus !== 'approved' &&
    (audit.includes('held') ||
      audit.includes('unavailable') ||
      audit.includes('review') ||
      audit.includes('failed') ||
      generation.includes('failed') ||
      current.auditChecks.some((check) => check.severity !== 'info'))
  );
}

export function partitionDrafts(drafts: OutreachV3DraftArtifact[]): {
  judgment: OutreachV3DraftArtifact[];
  matching: OutreachV3DraftArtifact[];
} {
  const judgment = drafts.filter(draftNeedsJudgment);
  const judgmentIds = new Set(judgment.map((draft) => draft.id));
  return {
    judgment,
    matching: drafts.filter((draft) => !judgmentIds.has(draft.id)),
  };
}

export function approvalCount(drafts: OutreachV3DraftArtifact[]): number {
  return drafts.filter((draft) => draft.current?.approvalStatus === 'approved').length;
}

export function recipientLabel(draft: OutreachV3DraftArtifact): string {
  return draft.current?.recipientKey || draft.recipientKey || draft.generationKey;
}

export function statusLabel(draft: OutreachV3DraftArtifact): string {
  const current = draft.current;
  if (!current) return 'Needs review';
  if (current.approvalStatus === 'approved') return 'Approved';
  const audit = current.auditStatus.toLowerCase();
  const generation = current.generationStatus.toLowerCase();
  if (audit.includes('held')) return 'Action required';
  if (audit.includes('unavailable')) return 'Checks unavailable';
  if (audit.includes('review')) return 'Needs your read';
  if (generation.includes('failed')) return 'Generation failed';
  return 'Ready for review';
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

export function generationProgress(input: {
  plan: OutreachV3GenerationPlan | null;
  drafts: OutreachV3DraftArtifact[];
  job: OutreachV3GenerationJob | null;
}): { complete: number; total: number; percent: number } {
  const total = Number(
    input.job?.totals?.total ?? input.plan?.slots.length ?? input.drafts.length,
  );
  const finished = Number(
    input.job?.totals?.succeeded ??
      input.job?.totals?.complete ??
      input.drafts.length,
  );
  const safeTotal = Math.max(1, total);
  return {
    complete: Math.min(finished, total || finished),
    total,
    percent: Math.min(100, Math.round((finished / safeTotal) * 100)),
  };
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

export function initials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('') || '—';
}
