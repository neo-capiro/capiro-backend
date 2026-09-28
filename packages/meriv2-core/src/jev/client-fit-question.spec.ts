import { describe, expect, it } from '@jest/globals';
import type { EvidenceEnvelope } from './decision-contract';
import { JevRequestError } from './jev-client';
import {
  buildClientFitQuestion,
  CLIENT_FIT_ALIGNMENT_QUESTION_ID,
  CLIENT_FIT_QUESTION_ID,
  CLIENT_FIT_QUESTION_VERSION,
} from './client-fit-question';

const envelope: EvidenceEnvelope = {
  envelopeVersion: 'meri-evidence-envelope-v1',
  claimId: 'finding-1',
  claimText: 'Direct match: secure sustainment [1].',
  claimKind: 'recommendation',
  claimCategory: 'client_fit',
  tenantId: 'tenant-1',
  clientId: 'client-1',
  scopeQualifiers: [],
  asOf: null,
  sources: [
    {
      evidenceId: 'e1',
      sourceType: 'search_procurement_forecasts',
      sourceId: 'forecast-1',
      documentId: null,
      version: null,
      locator: null,
      passage: 'Requires secure software sustainment.',
      sourceDate: null,
      publishedAt: null,
      effectiveAt: null,
      retrievedAt: null,
      provenance: { evidenceClass: 'official_government_data', primary: true, authoritative: true },
    },
  ],
};

const context = {
  client: { capability: 'secure software sustainment' },
  opportunity: { requirement: 'secure software sustainment' },
  finding: { text: 'Pursue this opportunity.' },
};

describe('buildClientFitQuestion', () => {
  it('asks the category and ordered alignment questions together with provenance', () => {
    const result = buildClientFitQuestion(envelope, context);
    expect(CLIENT_FIT_QUESTION_VERSION).toBe('client_fit.v1');
    expect(result.state).toEqual({
      ...context,
      sources: [
        expect.objectContaining({
          evidenceId: 'e1',
          provenance: envelope.sources[0]!.provenance,
        }),
      ],
    });
    expect(result.questions[CLIENT_FIT_QUESTION_ID]).toMatchObject({
      type: 'choice',
      criteria: {
        explicit_linkage: expect.objectContaining({
          definition: expect.any(String),
          boundaryCase: expect.any(String),
        }),
        conditional_linkage: expect.any(Object),
        capability_class_alignment: expect.any(Object),
        adjacency: expect.any(Object),
        insufficient_evidence: expect.any(Object),
      },
    });
    expect(
      Object.keys(
        (result.questions[CLIENT_FIT_ALIGNMENT_QUESTION_ID] as { levels: object }).levels,
      ),
    ).toEqual(['no_overlap', 'related_domain', 'same_class', 'directly_comparable']);
    expect(result.questions).not.toHaveProperty('strategic_relevance');
  });

  it('rejects state above the 32k estimated-token pre-flight limit', () => {
    expect(() =>
      buildClientFitQuestion(envelope, { ...context, finding: 'x'.repeat(130_000) }),
    ).toThrow(JevRequestError);
  });
});
