jest.mock('./profile-suggestion-sources.service.js', () => ({
  ProfileSuggestionSourcesService: class {},
}));
import {
  ProfileIdentityWebService,
  verifiedWebsiteIdentities,
} from './profile-identity-web.service.js';
import type { ProfileSuggestionSource } from './profile-suggestion-sources.service.js';
import { PortfolioAgentError } from './portfolio-agent.service.js';
const source: ProfileSuggestionSource = {
  id: 'document',
  attachmentId: '10000000-0000-4000-8000-000000000001',
  label: 'A misleading filename.pdf',
  source: 'document',
  text: 'Fixture Engineering designs sensors. Fixture Engineering is a subsidiary of Parent Example.',
  observedAt: '2026-11-04T00:00:00Z',
};
const candidate = {
  name: 'Fixture Engineering',
  sourceId: 'document',
  quote: 'Fixture Engineering designs sensors.',
  state: 'Invented state',
  city: null,
  claims: [
    {
      kind: 'parent' as const,
      name: 'Parent Example',
      sourceId: 'document',
      quote: 'Fixture Engineering is a subsidiary of Parent Example.',
    },
  ],
};
describe('source-bound identity extraction', () => {
  it('derives a legal name from a supplied website without an entered name or document', async () => {
    const website = jest.fn(async (url: string) => ({
      ...source,
      attachmentId: undefined,
      source: 'website',
      url,
    }));
    const previewPublicSources = jest.fn();
    const extract = jest.fn().mockResolvedValue({
      data: { candidates: [{ ...candidate, sourceId: 'identity_page_0', claims: [] }] },
      audit: {},
    });
    const service = new ProfileIdentityWebService(
      {} as never,
      { previewPublicSources } as never,
      { website } as never,
      { extract } as never,
    );
    const result = await service.discover({} as never, {
      name: '',
      website: 'https://fixture.example/',
    });
    expect(result.candidates[0]).toMatchObject({
      sourceCandidate: {
        source: 'website',
        name: 'Fixture Engineering',
        website: 'https://fixture.example/',
      },
      evidence: [{ url: 'https://fixture.example/', excerpt: candidate.quote }],
    });
    expect(result.candidates[0]?.sourceCandidate.externalId).toBe('https://fixture.example/');
    expect(previewPublicSources).not.toHaveBeenCalled();
    expect(website).toHaveBeenCalledTimes(3);
    expect(extract).toHaveBeenCalledTimes(1);
    expect(extract.mock.calls[0]![0].prompt).not.toContain('Requested company:');
  });
  it.each(['AbortError', 'TimeoutError'])(
    'preserves parent %s cancellation instead of returning an evidence gap',
    async (name) => {
      const controller = new AbortController();
      const reason = new DOMException('Preview ended', name);
      const extract = jest.fn().mockImplementation(async () => {
        controller.abort(reason);
        throw new PortfolioAgentError('cancelled', {} as never);
      });
      const service = new ProfileIdentityWebService(
        {} as never,
        {} as never,
        {} as never,
        { extract } as never,
      );
      await expect(service.fromDocument({} as never, '', source, controller.signal)).rejects.toBe(
        reason,
      );
      expect(extract).toHaveBeenCalledTimes(1);
    },
  );
  it('keeps a genuine provider failure as an explicit source gap', async () => {
    const extract = jest
      .fn()
      .mockRejectedValue(new PortfolioAgentError('source_unavailable', {} as never));
    const service = new ProfileIdentityWebService(
      {} as never,
      {} as never,
      {} as never,
      { extract } as never,
    );
    await expect(
      service.fromDocument({} as never, '', source, new AbortController().signal),
    ).resolves.toEqual({
      candidates: [],
      sourceGaps: ['Identity source evidence could not be extracted.'],
    });
  });
  it('discards a late inference result when its provider ignored cancellation', async () => {
    const controller = new AbortController();
    const reason = new DOMException('Preview deadline', 'TimeoutError');
    let finish!: (value: unknown) => void;
    const extract = jest.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const service = new ProfileIdentityWebService(
      {} as never,
      {} as never,
      {} as never,
      { extract } as never,
    );
    const pending = service.fromDocument({} as never, '', source, controller.signal);
    controller.abort(reason);
    const rejected = expect(pending).rejects.toBe(reason);
    finish({ data: { candidates: [candidate] }, audit: {} });
    await rejected;
  });
  it('does not start page or model reads when cancellation occurs during public search', async () => {
    const controller = new AbortController();
    const reason = new DOMException('Client disconnected', 'AbortError');
    const previewPublicSources = jest.fn().mockImplementation(async () => {
      controller.abort(reason);
      return { sourceStatus: 'complete', candidates: [] };
    });
    const website = jest.fn();
    const extract = jest.fn();
    const service = new ProfileIdentityWebService(
      {} as never,
      { previewPublicSources } as never,
      { website } as never,
      { extract } as never,
    );
    await expect(
      service.discover(
        {} as never,
        {
          name: 'Fixture Engineering',
          website: 'https://fixture.example/',
        },
        controller.signal,
      ),
    ).rejects.toBe(reason);
    expect(website).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
  });
  it('rejects an already cancelled preview before public search, page reads or inference', async () => {
    const previewPublicSources = jest.fn();
    const website = jest.fn();
    const extract = jest.fn();
    const service = new ProfileIdentityWebService(
      {} as never,
      { previewPublicSources } as never,
      { website } as never,
      { extract } as never,
    );
    const signal = AbortSignal.abort(new DOMException('Client disconnected', 'AbortError'));
    await expect(
      service.discover(
        {} as never,
        {
          name: 'Fixture Engineering',
          website: 'https://fixture.example/',
        },
        signal,
      ),
    ).rejects.toBe(signal.reason);
    await expect(service.fromDocument({} as never, '', source, signal)).rejects.toBe(signal.reason);
    expect(previewPublicSources).not.toHaveBeenCalled();
    expect(website).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
  });
  it('derives names and relationships from actual document text and never its filename', async () => {
    const extract = jest.fn().mockResolvedValue({ data: { candidates: [candidate] }, audit: {} });
    const service = new ProfileIdentityWebService(
      {} as never,
      {} as never,
      {} as never,
      { extract } as never,
    );
    const result = await service.fromDocument({} as never, '', source);
    expect(result.candidates[0]).toMatchObject({
      sourceCandidate: {
        source: 'document',
        externalId: source.attachmentId,
        name: candidate.name,
      },
      sourceType: 'person_confirmed_document',
      claims: [{ attachmentId: source.attachmentId, name: 'Parent Example' }],
      evidence: [{ attachmentId: source.attachmentId, excerpt: candidate.quote }],
    });
    expect(result.candidates[0]?.state).toBeUndefined();
    expect(extract).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'identity_candidates',
        sources: [source],
        maxTurns: 4,
        maxBudgetUsd: 0.5,
      }),
    );
    expect(extract.mock.calls[0]![0].prompt).not.toContain(source.label);
  });
  it.each([
    { ...candidate, name: 'Fabricated name' },
    { ...candidate, quote: 'Not present in the provided source' },
    { ...candidate, sourceId: 'arbitrary' },
  ])('drops unsupported candidate names/quotes/source IDs', (item) => {
    expect(verifiedWebsiteIdentities([item], [source])).toEqual([]);
  });
  it('drops an inferred relationship whose name or quote is absent from the source', () => {
    expect(
      verifiedWebsiteIdentities(
        [
          {
            ...candidate,
            claims: [{ ...candidate.claims[0]!, quote: 'Fixture is owned by a made-up parent' }],
          },
        ],
        [source],
      )[0]?.claims,
    ).toEqual([]);
  });

  it('keeps third-party search pages as evidence without claiming their hosts as company domains', () => {
    const thirdParty = {
      ...source,
      attachmentId: undefined,
      url: 'https://news.example/story',
      source: 'website' as const,
    };
    const found = verifiedWebsiteIdentities([candidate], [thirdParty])[0]!;
    expect(found.sourceCandidate).toMatchObject({
      source: 'website',
      externalId: thirdParty.url,
      name: candidate.name,
    });
    expect(found.sourceCandidate.website).toBeUndefined();
    expect(
      verifiedWebsiteIdentities(
        [candidate],
        [{ ...thirdParty, companyWebsite: 'https://news.example/' }],
      )[0]?.sourceCandidate.website,
    ).toBe('https://news.example/');
  });
  it('reads provided About and Contact URLs through the same guarded reader and preserves source gaps', async () => {
    const reader = { website: jest.fn().mockRejectedValue(new Error('fixture unavailable')) };
    const extract = jest.fn();
    const service = new ProfileIdentityWebService(
      {} as never,
      {
        previewPublicSources: jest
          .fn()
          .mockResolvedValue({ sourceStatus: 'unavailable', candidates: [] }),
      } as never,
      reader as never,
      { extract } as never,
    );
    const result = await service.discover({} as never, {
      name: 'Fixture',
      website: 'https://fixture.example/',
    });
    expect(reader.website.mock.calls.map((call) => call[0])).toEqual([
      'https://fixture.example/',
      'https://fixture.example/about',
      'https://fixture.example/contact',
    ]);
    expect(result.sourceGaps.length).toBeGreaterThan(0);
    expect(extract).not.toHaveBeenCalled();
  });
});
