import {
  admitDurableResearchCoordinator,
  recordDurableResearchApprovalProposal,
} from './meri-research-coordinator';
import type { ResearchPlanV1 } from './meri-research-plan';
import type { ResearchRunState } from './meri-research-run-state';
import {
  JOB_APPROVAL_REPORT_CHARS,
  JobApprovalDraftError,
  buildJobApprovalDraftPrompt,
  jobApprovalTool,
  parseJobApprovalDraft,
  pendingJobApprovalSteps,
} from './meri-job-approvals';

const run: ResearchRunState = {
  id: 'run-1',
  leaseEpoch: 1,
  eventSequence: 0,
  phase: 'research',
  status: 'running',
  stage: 'Gathering evidence',
  startedAt: '2099-09-28T00:00:00.000Z',
  heartbeatAt: '2099-09-28T00:00:00.000Z',
};

const plan: ResearchPlanV1 = {
  version: 1,
  title: 'Send the summary',
  scope: {
    sessionId: 'research-1',
    tenantId: 'tenant-1',
    actorId: 'actor-1',
    clientId: 'client-1',
    conversationId: 'conversation-1',
  },
  budget: { toolCalls: 2, tokens: 4_000 },
  steps: [
    {
      id: 'read-items',
      objective: 'Read today’s items',
      dependsOn: [],
      requiredEvidenceDomains: ['client_context'],
      allowedCapabilities: ['search_memory'],
      effect: 'read',
      completionCondition: 'Items read.',
      budget: { toolCalls: 1, tokens: 2_000 },
    },
    {
      id: 'propose-summary-email',
      objective: 'Email me the summary',
      dependsOn: ['read-items'],
      requiredEvidenceDomains: ['client_context'],
      allowedCapabilities: ['send_email'],
      effect: 'approval_required',
      completionCondition: 'A proposal exists; nothing is sent before approval.',
      budget: { toolCalls: 1, tokens: 2_000 },
    },
  ],
  clarifyingQuestions: [],
};

function admitted(readDone: boolean) {
  const first = admitDurableResearchCoordinator({
    metadata: { run },
    plan,
    objective: 'Send the summary',
    run,
  });
  const metadata = first.metadata as Record<string, any>;
  if (!readDone) return metadata;
  const coordinator = metadata.durableCoordinator;
  return {
    ...metadata,
    durableCoordinator: {
      ...coordinator,
      steps: coordinator.steps.map((step: any) =>
        step.id === 'read-items' ? { ...step, outcome: 'completed' } : step,
      ),
    },
  };
}

describe('job approval steps (Release D)', () => {
  it('offers a final approval step only once its reads completed and no card is posted', () => {
    expect(pendingJobApprovalSteps(admitted(false))).toEqual([]);
    const ready = admitted(true);
    expect(pendingJobApprovalSteps(ready).map((step) => step.id)).toEqual([
      'propose-summary-email',
    ]);
    const posted = recordDurableResearchApprovalProposal({
      metadata: ready,
      stepId: 'propose-summary-email',
      proposalId: 'proposal-1',
    }).metadata;
    expect(pendingJobApprovalSteps(posted)).toEqual([]);
    expect(pendingJobApprovalSteps({})).toEqual([]);
  });

  it('proposes exactly one approval-gated tool', () => {
    const sideEffecting = (name: string) => ['send_email', 'create_task'].includes(name);
    expect(jobApprovalTool({ allowedCapabilities: ['send_email', 'search_memory'] }, sideEffecting)).toBe(
      'send_email',
    );
    expect(jobApprovalTool({ allowedCapabilities: ['send_email', 'create_task'] }, sideEffecting)).toBeNull();
    expect(jobApprovalTool({ allowedCapabilities: ['search_memory'] }, sideEffecting)).toBeNull();
  });

  it('drafts from the report only, bounded, with the tool schema', () => {
    const prompt = buildJobApprovalDraftPrompt({
      objective: 'Email me the summary',
      tool: 'send_email',
      inputSchema: { type: 'object', required: ['to'] },
      report: 'x'.repeat(JOB_APPROVAL_REPORT_CHARS + 50),
    });
    expect(prompt.system).toContain('"send_email"');
    expect(prompt.system).toContain('{"type":"object","required":["to"]}');
    expect(prompt.system).toContain('Never invent recipients');
    expect(prompt.user).toContain('Objective: Email me the summary');
    expect(prompt.user).toContain('[report truncated]');
    expect(prompt.user.length).toBeLessThan(JOB_APPROVAL_REPORT_CHARS + 200);
  });

  it('accepts one JSON object, optionally fenced, and nothing else', () => {
    expect(parseJobApprovalDraft('{"to":"me@example.com"}')).toEqual({ to: 'me@example.com' });
    expect(parseJobApprovalDraft('```json\n{"to":"me@example.com"}\n```')).toEqual({
      to: 'me@example.com',
    });
    expect(() => parseJobApprovalDraft('Here it is: {"to":"x"}')).toThrow(JobApprovalDraftError);
    expect(() => parseJobApprovalDraft('[1,2]')).toThrow('job_approval_draft_not_object');
  });
});
