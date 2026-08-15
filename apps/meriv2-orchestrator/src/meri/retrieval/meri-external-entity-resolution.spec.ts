import {
  buildMeriExternalEntityResolution,
  normalizeMeriEntityName,
} from './meri-external-entity-resolution.js';

describe('Meri external entity resolution', () => {
  test('normalizes legal suffixes and domain-style misspellings', () => {
    expect(normalizeMeriEntityName('https://www.kindeticindustries.inc/')).toBe(
      'kindeticindustries',
    );
    expect(normalizeMeriEntityName('Kinetic Industries, Inc.')).toBe('kinetic industries');
  });

  test('resolves a domain/company from corroborating public and registry signals', () => {
    const result = buildMeriExternalEntityResolution('kineticindustries.com', [
      {
        tool: 'search_public_web',
        result: {
          results: [
            {
              id: 'web-1',
              title: 'Kinetic Industries Inc.',
              url: 'https://kineticindustries.com',
              snippet: 'Official company site.',
            },
          ],
        },
      },
      {
        tool: 'search_federal_awards',
        result: {
          results: [
            {
              id: 'award-1',
              companyName: 'KINETIC INDUSTRIES INC',
              uei: 'UEI123',
              cageCode: '1ABC2',
              description: 'Federal award recipient.',
            },
          ],
        },
      },
    ]);

    expect(result.resolutionStatus).toBe('resolved');
    expect(result.resolvedEntity).toEqual(
      expect.objectContaining({
        canonicalName: 'Kinetic Industries Inc.',
        domains: ['kineticindustries.com'],
        identifiers: expect.objectContaining({ uei: 'UEI123', cage: '1ABC2' }),
      }),
    );
    expect(result.resolvedEntity?.sourceTools).toEqual(
      expect.arrayContaining(['search_public_web', 'search_federal_awards']),
    );
  });

  test('normalizes lookup_client_registry named identity slots', () => {
    const result = buildMeriExternalEntityResolution('Victory Six Advisors', [
      {
        tool: 'lookup_client_registry',
        result: {
          existingClient: {
            id: 'client-v6',
            name: 'Victory Six Advisors',
            description: 'Existing authorized Capiro client.',
          },
          ldaExactMatch: {
            ldaClientId: 'lda-v6',
            name: 'Victory Six Advisors',
            description: 'Lobbying disclosure registry match.',
          },
          ldaCandidates: [],
        },
      },
    ]);

    expect(result.resolutionStatus).toBe('resolved');
    expect(result.resolvedEntity).toEqual(
      expect.objectContaining({
        canonicalName: 'Victory Six Advisors',
        clientId: 'client-v6',
        identifiers: expect.objectContaining({ ldaClientId: 'lda-v6' }),
      }),
    );
    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'client-v6', sourceTool: 'lookup_client_registry' }),
        expect.objectContaining({ id: 'lda-v6', sourceTool: 'lookup_client_registry' }),
      ]),
    );
  });

  test('does not merge same-named companies with conflicting domains', () => {
    const result = buildMeriExternalEntityResolution('Acme', [
      {
        tool: 'search_public_web',
        result: {
          results: [
            { title: 'Acme Inc.', url: 'https://acme-defense.com' },
            { title: 'ACME, INC.', url: 'https://acme-health.com' },
          ],
        },
      },
    ]);

    expect(result.resolutionStatus).toBe('ambiguous');
    expect(result.resolvedEntity).toBeNull();
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((candidate) => candidate.domains[0])).toEqual(
      expect.arrayContaining(['acme-defense.com', 'acme-health.com']),
    );
  });

  test('does not resolve one uncorroborated web result by title alone', () => {
    const result = buildMeriExternalEntityResolution('Anduril', [
      {
        tool: 'search_public_web',
        result: {
          results: [
            {
              title: 'Anduril',
              url: 'https://example-news.test/anduril-profile',
              snippet: 'A news profile that mentions the company.',
            },
          ],
        },
      },
    ]);

    expect(result.resolutionStatus).toBe('ambiguous');
    expect(result.resolvedEntity).toBeNull();
    expect(result.candidates).toHaveLength(1);
  });

  test('never promotes a congressional member result into a company identity', () => {
    const result = buildMeriExternalEntityResolution('Acme', [
      {
        tool: 'resolve_entity',
        result: {
          results: [
            {
              id: 'A000001',
              entityType: 'member',
              name: 'Acme Member',
              title: 'Representative',
            },
          ],
        },
      },
    ]);

    expect(result.resolutionStatus).toBe('not_found');
    expect(result.candidates).toEqual([]);
    expect(result.results).toEqual([]);
  });

  test('fails closed when the best two candidates remain too close', () => {
    const result = buildMeriExternalEntityResolution('Kinetic', [
      {
        tool: 'search_public_web',
        result: {
          results: [
            { title: 'Kinetic Industries', url: 'https://kinetic-industries.com' },
            { title: 'Kinetic Systems', url: 'https://kinetic-systems.com' },
          ],
        },
      },
    ]);

    expect(result.resolutionStatus).toBe('ambiguous');
    expect(result.resolvedEntity).toBeNull();
  });
});
