import { describe, expect, it, jest } from '@jest/globals';
import type { EvidenceEnvelope, EvidenceQuestion } from './decision-contract';
import type { JevClient } from './jev-client';
import { createClientFitProvider } from './client-fit-provider';

const envelope: EvidenceEnvelope = {
  envelopeVersion: 'meri-evidence-envelope-v1',
  claimId: 'finding-1',
  claimText: 'A finding.',
  claimKind: 'recommendation',
  claimCategory: 'client_fit',
  tenantId: 'tenant-1',
  clientId: 'client-1',
  scopeQualifiers: [],
  asOf: null,
  sources: [],
};
const question: EvidenceQuestion = { state: {}, questions: {} };

describe('createClientFitProvider', () => {
  it('maps both category and score answers without claim-support coercion', async () => {
    const systemOne = jest.fn(async () => ({
      response: {
        model: 'jev-1.13.0',
        answers: {
          client_fit: {
            type: 'choice' as const,
            choice: 'capability_class_alignment',
            confidence: 0.82,
            probabilities: {
              explicit_linkage: 0.05,
              conditional_linkage: 0.08,
              capability_class_alignment: 0.82,
              adjacency: 0.04,
              insufficient_evidence: 0.01,
            },
          },
          client_fit_alignment: {
            type: 'score' as const,
            level: 'same_class',
            confidence: 0.76,
            probabilities: {
              no_overlap: 0.02,
              related_domain: 0.12,
              same_class: 0.76,
              directly_comparable: 0.1,
            },
          },
        },
        usage: { input_tokens: 30, output_tokens: 8 },
      },
      latencyMs: 12,
      attempts: 1,
    }));
    const provider = createClientFitProvider({
      client: { systemOne } as JevClient,
      model: 'jev-1.13.0',
      scope: { tenantId: 'tenant-1', surface: 'chat' },
    });

    await expect(provider.assess(envelope, question)).resolves.toEqual(
      expect.objectContaining({
        kind: 'outcome',
        category: expect.objectContaining({
          value: 'capability_class_alignment',
          confidence: 0.82,
        }),
        alignment: expect.objectContaining({ level: 'same_class', confidence: 0.76 }),
        provider: { name: 'jev-client-fit', model: 'jev-1.13.0', questionVersion: 'client_fit.v1' },
        latencyMs: 12,
      }),
    );
  });

  it('fails closed when either task-specific answer is missing', async () => {
    const provider = createClientFitProvider({
      client: {
        systemOne: async () => ({
          response: {
            model: 'jev-1.13.0',
            answers: {},
            usage: { input_tokens: 0, output_tokens: 0 },
          },
          latencyMs: 1,
          attempts: 1,
        }),
      } as JevClient,
      model: 'jev-1.13.0',
      scope: { tenantId: 'tenant-1', surface: 'chat' },
    });
    await expect(provider.assess(envelope, question)).resolves.toMatchObject({
      kind: 'failure',
      state: 'malformed_response',
    });
  });
});
