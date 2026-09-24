import { CLAIM_SUPPORT_QUESTION_ID, CLAIM_SUPPORT_QUESTION_VERSION } from '../claim-support-question';
import { EVIDENCE_OUTCOMES, hashEvidenceEnvelope, type DecisionProvider, type EvidenceOutcome } from '../decision-contract';
import { hashEvidenceContent } from '../../grounding/evidence';
import { JEV_TASK_REGISTRY_VERSION } from '../task-registry';
import { RecordedDecisionStore } from './recorded-decision-store';

export function createReplayDecisionProvider(options: {
  store: RecordedDecisionStore;
  model: string;
  provider?: string;
}): DecisionProvider {
  const provider = options.provider ?? 'jev';
  return {
    name: `replay:${provider}`,
    available: () => true,
    async assess(envelope, question) {
      const recording = options.store.get({
        task: 'claim_support',
        registryVersion: JEV_TASK_REGISTRY_VERSION,
        questionHash: hashEvidenceContent(question),
        envelopeHash: hashEvidenceEnvelope(envelope),
        questionVersion: CLAIM_SUPPORT_QUESTION_VERSION,
        model: options.model,
        provider,
      });
      if (!recording) {
        return {
          kind: 'failure', state: 'not_checked', reasonCodes: ['no_recording'],
          provider: { name: provider, model: options.model, questionVersion: CLAIM_SUPPORT_QUESTION_VERSION }, latencyMs: 0,
        };
      }
      const raw = recording.response as { model?: string; answers?: Record<string, { choice?: string; probabilities?: Record<string, number>; confidence?: number }> };
      const answer = raw.answers?.[CLAIM_SUPPORT_QUESTION_ID];
      if (!answer || !EVIDENCE_OUTCOMES.includes(answer.choice as EvidenceOutcome)) {
        return {
          kind: 'failure', state: 'malformed_response', reasonCodes: ['malformed_recording'],
          provider: { name: provider, model: options.model, questionVersion: CLAIM_SUPPORT_QUESTION_VERSION }, latencyMs: recording.latencyMs,
        };
      }
      return {
        kind: 'outcome', outcome: answer.choice as EvidenceOutcome,
        probabilities: Object.fromEntries(EVIDENCE_OUTCOMES.map((outcome) => [outcome, answer.probabilities?.[outcome] ?? 0])) as Record<EvidenceOutcome, number>,
        confidence: answer.confidence ?? 0, reasonCodes: [], evidenceIds: envelope.sources.map((source) => source.evidenceId),
        provider: { name: provider, model: raw.model ?? options.model, questionVersion: CLAIM_SUPPORT_QUESTION_VERSION },
        latencyMs: recording.latencyMs, usage: recording.usage,
      };
    },
  };
}
