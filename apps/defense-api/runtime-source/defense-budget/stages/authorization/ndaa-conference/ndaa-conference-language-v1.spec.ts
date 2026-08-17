import { ndaaConferenceLanguageExtractionResultV1Schema } from './ndaa-conference-language-v1.js';

describe('NDAA conference language V1', () => {
  it('preserves explicit chamber disposition and remains authorization-only', () => {
    const value = ndaaConferenceLanguageExtractionResultV1Schema.parse({
      schemaVersion: 'ndaa_conference_language_extraction_result_v1',
      stage: 'ndaa_conference',
      profileId: 'fy2027-ndaa-conference-authorization',
      sourceDocumentId: 'source',
      sourceSha256: 'a'.repeat(64),
      provisions: [
        {
          schemaVersion: 'ndaa_conference_language_v1',
          provisionId: 'provision-1',
          track: 'authorization',
          stage: 'ndaa_conference',
          authority: 'ndaa_conference_authorization',
          fiscalYear: 2027,
          profileId: 'fy2027-ndaa-conference-authorization',
          sourceDocumentId: 'source',
          sourceSha256: 'a'.repeat(64),
          heading: 'Ground Robotics',
          fullText: 'The conference agreement adopts the House provision. The Senate recedes.',
          startPage: 1,
          endPage: 1,
          actionType: 'narrative',
          references: [{ referenceKind: 'pe_code', peCode: '0605053A' }],
          scope: 'line_specific',
          chamberDispositions: [
            { chamber: 'house', disposition: 'adopted', rawText: 'adopts the House provision' },
            { chamber: 'senate', disposition: 'receded', rawText: 'The Senate recedes' },
          ],
          evidenceIds: ['ev-1'],
        },
      ],
      evidence: [
        {
          evidenceId: 'ev-1',
          sourceSha256: 'a'.repeat(64),
          page: 1,
          blockIndex: 1,
          granularity: 'text_span',
          excerpt: 'The conference agreement adopts the House provision. The Senate recedes.',
        },
      ],
      warnings: [],
      omittedPages: [],
    });
    expect(value.provisions[0]!.chamberDispositions).toHaveLength(2);
    expect(value.provisions[0]!.stage).toBe('ndaa_conference');
  });
});
