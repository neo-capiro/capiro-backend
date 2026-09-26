import { z } from 'zod';
import { JEV_TASKS } from './jev-config';
import { JEV_TASK_REGISTRY, JEV_TASK_REGISTRY_VERSION } from './task-registry';

const observedSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('outcome'), outcome: z.string().min(1), confidence: z.number().min(0).max(1),
    action: z.enum(['propose', 'abstain']), latencyMs: z.number().nonnegative(),
    usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }) }),
  z.object({ kind: z.literal('failure'), state: z.enum(['not_checked', 'retrieval_failed', 'document_unavailable',
    'judge_unavailable', 'repair_budget_exhausted', 'timeout', 'cancelled', 'malformed_response', 'scope_refused']),
    latencyMs: z.number().nonnegative() }),
]);

export const jevTaskEvaluationFixtureSchema = z.object({
  version: z.literal('jev_task_evaluation_fixture_v1'),
  model: z.string().regex(/^jev-\d+\.\d+\.\d+$/),
  // Evaluation fixtures are immutable evidence artifacts. Keep the immediately
  // preceding registry version readable after adding the BD tasks; new traces
  // and reports still emit JEV_TASK_REGISTRY_VERSION through the registry,
  // cache and recording paths.
  registryVersion: z.enum(['jev-task-registry.v4', JEV_TASK_REGISTRY_VERSION]),
  cases: z.array(z.object({
    id: z.string().min(1),
    task: z.enum(JEV_TASKS),
    category: z.string().min(1),
    input: z.record(z.unknown()),
    expected: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('outcome'), outcome: z.string().min(1) }),
      z.object({ kind: z.literal('failure'), state: z.enum(['not_checked', 'retrieval_failed', 'document_unavailable',
        'judge_unavailable', 'repair_budget_exhausted', 'timeout', 'cancelled', 'malformed_response', 'scope_refused']) }),
    ]),
    humanReview: z.object({ status: z.enum(['proposed', 'approved']) }),
    replay: z.object({ jev: observedSchema, baseline: observedSchema }),
  })).min(5),
}).superRefine((fixture, context) => {
  fixture.cases.forEach((item, index) => {
    const registration = JEV_TASK_REGISTRY[item.task];
    const candidateIds = Array.isArray(item.input.candidateIds)
      ? item.input.candidateIds.filter((value): value is string => typeof value === 'string') : [];
    const outcomeAllowed = (outcome: string) => registration.allowedOutcomes.includes(outcome)
      || (registration.allowedOutcomes.includes('candidate_id') && candidateIds.includes(outcome));
    if (item.expected.kind === 'outcome' && registration.allowedOutcomes.includes('candidate_id')) {
      const reserved = registration.allowedOutcomes.filter((outcome) => outcome !== 'candidate_id');
      if (!reserved.includes(item.expected.outcome)
        && item.input.selectedCandidateId !== item.expected.outcome) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['cases', index, 'input', 'selectedCandidateId'],
          message: 'candidate outcome requires the matching selectedCandidateId' });
      }
    } else if (item.expected.kind === 'outcome' && !registration.allowedOutcomes.includes(item.expected.outcome)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ['cases', index, 'expected', 'outcome'],
        message: `outcome is not registered for ${item.task}` });
    }
    (['jev', 'baseline'] as const).forEach((provider) => {
      const observed = item.replay[provider];
      if (observed.kind === 'outcome' && !outcomeAllowed(observed.outcome)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ['cases', index, 'replay', provider, 'outcome'],
          message: `observed outcome is not registered or a supplied candidate for ${item.task}` });
      }
    });
  });
});

export type JevTaskEvaluationFixture = z.infer<typeof jevTaskEvaluationFixtureSchema>;
