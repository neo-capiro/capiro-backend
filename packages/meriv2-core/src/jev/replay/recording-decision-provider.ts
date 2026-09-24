import { CLAIM_SUPPORT_QUESTION_VERSION } from '../claim-support-question';
import { hashEvidenceEnvelope, type DecisionProvider } from '../decision-contract';
import { hashEvidenceContent } from '../../grounding/evidence';
import { JEV_TASK_REGISTRY_VERSION } from '../task-registry';
import type { JevTask } from '../jev-config';
import { RecordedDecisionStore } from './recorded-decision-store';

export function createRecordingDecisionProvider(options: {
  live: DecisionProvider;
  store: RecordedDecisionStore;
  model: string;
  provider?: string;
  task?: JevTask;
  questionVersion?: string;
  now?: () => string;
}): DecisionProvider {
  return {
    name: `recording:${options.live.name}`,
    available: () => options.live.available(),
    async assess(envelope, question, callOptions) {
      const decision = await options.live.assess(envelope, question, callOptions);
      options.store.append({
        task: options.task ?? 'claim_support',
        registryVersion: JEV_TASK_REGISTRY_VERSION,
        questionHash: hashEvidenceContent(question),
        envelopeHash: hashEvidenceEnvelope(envelope),
        questionVersion: options.questionVersion ?? CLAIM_SUPPORT_QUESTION_VERSION,
        model: options.model,
        provider: options.provider ?? options.live.name,
        recordedAt: options.now?.() ?? new Date().toISOString(),
        request: { state: question.state, questions: question.questions },
        response: decision,
        latencyMs: decision.latencyMs,
        ...(decision.kind === 'outcome' && decision.usage ? { usage: decision.usage } : {}),
      });
      return decision;
    },
  };
}
