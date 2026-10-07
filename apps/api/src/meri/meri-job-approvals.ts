/**
 * Release D (program plan §5.4): approval steps inside jobs.
 *
 * A job's approval step is never executed by the research run. When the run
 * has gathered its evidence and the report is about to be saved, each final
 * approval step whose reads completed gets one bounded drafting call for the
 * action's input, and the existing proposal card is posted in the thread. The
 * owner approves or dismisses it in the Approvals tab; the step is settled
 * from the proposal's own outcome (meri-research-coordinator.ts). Nothing is
 * sent or written before approval.
 */
import {
  approvalStepProposalId,
  readDurableResearchCoordinator,
  type DurableResearchCoordinatorStepV1,
} from './meri-research-coordinator.js';

/** The report text a drafting call may see. */
export const JOB_APPROVAL_REPORT_CHARS = 24_000;

/** Current-revision approval steps that wait, have no posted card, and whose reads completed. */
export function pendingJobApprovalSteps(metadata: unknown): DurableResearchCoordinatorStepV1[] {
  const coordinator = readDurableResearchCoordinator(metadata);
  if (!coordinator) return [];
  const current = coordinator.steps.filter(
    (step) => step.goalRevision === coordinator.goalRevision,
  );
  const completed = new Set(
    current.filter((step) => step.outcome === 'completed').map((step) => step.id),
  );
  return current.filter(
    (step) =>
      step.effect === 'approval_required' &&
      step.outcome === 'waiting_for_approval' &&
      approvalStepProposalId(step) === null &&
      step.dependsOn.every((dependency) => completed.has(dependency)),
  );
}

/** The one approval-gated capability a step proposes, or null when it names none or several. */
export function jobApprovalTool(
  step: Pick<DurableResearchCoordinatorStepV1, 'allowedCapabilities'>,
  isSideEffecting: (name: string) => boolean,
): string | null {
  const effects = [...new Set(step.allowedCapabilities.filter((name) => isSideEffecting(name)))];
  return effects.length === 1 ? effects[0]! : null;
}

export function buildJobApprovalDraftPrompt(input: {
  objective: string;
  tool: string;
  inputSchema: Record<string, unknown>;
  report: string;
}): { system: string; user: string } {
  const report =
    input.report.length > JOB_APPROVAL_REPORT_CHARS
      ? `${input.report.slice(0, JOB_APPROVAL_REPORT_CHARS)}\n[report truncated]`
      : input.report;
  return {
    system: [
      'You prepare the input for ONE business action that a person will review and approve before anything happens.',
      `The action is the tool "${input.tool}". Return ONLY one JSON object that matches its input schema. No prose, no markdown fences.`,
      'Use only facts stated in the report. Never invent recipients, addresses, dates, amounts or names; if the report does not give a required value, use the value the objective states, and otherwise leave optional fields out.',
      `Input schema: ${JSON.stringify(input.inputSchema)}`,
    ].join('\n'),
    user: [`Objective: ${input.objective}`, '', 'Report:', report].join('\n'),
  };
}

export class JobApprovalDraftError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'JobApprovalDraftError';
  }
}

/** One JSON object; a single surrounding markdown fence is tolerated, nothing else. */
export function parseJobApprovalDraft(raw: string): Record<string, unknown> {
  let text = raw.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text);
  if (fenced) text = fenced[1]!.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new JobApprovalDraftError('job_approval_draft_not_json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new JobApprovalDraftError('job_approval_draft_not_object');
  return parsed as Record<string, unknown>;
}
