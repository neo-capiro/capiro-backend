jest.mock('./profile-suggestion-sources.service.js', () => ({
  ProfileSuggestionSourcesService: class {},
}));
jest.mock('./profile-identity-web.service.js', () => ({ ProfileIdentityWebService: class {} }));
import { ProfileIdentitySourcesService } from './profile-identity-sources.service.js';
const ctx = {} as never;
const row = {
  uei: 'ABCDE1234567',
  cageCode: 'ABC12',
  legalBusinessName: 'Fixture Engineering',
  dbaName: 'Fixture Works',
  physicalAddress: { state: 'TX', city: 'Austin' },
};
function fixture() {
  const prisma = {
    ldaClient: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 12, name: row.legalBusinessName, state: 'TX', lastSyncedAt: new Date() },
        ]),
    },
    secFiling: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const sam = {
    lookupByUei: jest.fn().mockResolvedValue({ ok: true, entities: [row] }),
    lookupByCage: jest.fn().mockResolvedValue({ ok: true, entities: [row] }),
    lookupByName: jest.fn().mockResolvedValue({ ok: true, entities: [row] }),
  };
  const reader = {
    identityDocument: jest.fn().mockResolvedValue({
      id: 'identity-document',
      attachmentId: '10000000-0000-4000-8000-000000000007',
      source: 'document',
      text: 'Fixture Engineering designs sensors.',
      label: 'Not a company name.pdf',
      observedAt: new Date().toISOString(),
    }),
    website: jest.fn().mockResolvedValue({
      url: 'https://fixture.example/about',
      text: 'Fixture Engineering is a subsidiary of Parent Example.',
      observedAt: new Date().toISOString(),
    }),
  };
  const web = {
    fromDocument: jest.fn().mockResolvedValue({ candidates: [], sourceGaps: [] }),
    discover: jest
      .fn()
      .mockResolvedValue({ candidates: [], sourceGaps: ['State source unavailable'] }),
  };
  return {
    service: new ProfileIdentitySourcesService(
      prisma as never,
      sam as never,
      reader as never,
      web as never,
    ),
    prisma,
    sam,
    reader,
    web,
  };
}
describe('identity source acquisition and fresh confirmation reads', () => {
  it.each(['AbortError', 'TimeoutError'])(
    'starts no later registry or website work after document %s cancellation',
    async (name) => {
      const f = fixture();
      const controller = new AbortController();
      const reason = new DOMException('Preview ended', name);
      f.web.fromDocument.mockImplementation(async () => {
        controller.abort(reason);
        return { candidates: [], sourceGaps: ['Identity source evidence could not be extracted.'] };
      });
      await expect(
        f.service.discover(
          ctx,
          {
            name: '',
            website: 'https://fixture.example/',
            attachmentId: '10000000-0000-4000-8000-000000000007',
          },
          controller.signal,
        ),
      ).rejects.toBe(reason);
      expect(f.reader.identityDocument).toHaveBeenCalledTimes(1);
      expect(f.sam.lookupByName).not.toHaveBeenCalled();
      expect(f.prisma.ldaClient.findMany).not.toHaveBeenCalled();
      expect(f.prisma.secFiling.findMany).not.toHaveBeenCalled();
      expect(f.web.discover).not.toHaveBeenCalled();
    },
  );
  it('overlaps named website acquisition with document inference after verifying the same upload', async () => {
    const f = fixture();
    const attachmentId = '10000000-0000-4000-8000-000000000007';
    let finishDocument!: (result: { candidates: unknown[]; sourceGaps: string[] }) => void;
    f.web.fromDocument.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishDocument = resolve;
        }),
    );
    const documentCandidate = {
      sourceCandidate: {
        source: 'document',
        externalId: attachmentId,
        name: row.legalBusinessName,
      },
      sourceType: 'person_confirmed_document',
      identifiers: [],
      claims: [],
      evidence: [{ attachmentId, excerpt: 'Fixture Engineering designs sensors.' }],
    };
    const websiteCandidate = {
      ...documentCandidate,
      sourceCandidate: {
        source: 'website',
        externalId: 'https://fixture.example/about',
        name: row.legalBusinessName,
      },
      sourceType: 'person_confirmed_website',
      evidence: [],
    };
    f.web.discover.mockResolvedValue({ candidates: [websiteCandidate], sourceGaps: [] });
    const pending = f.service.discover(ctx, {
      name: row.legalBusinessName,
      website: 'https://fixture.example/',
      attachmentId,
    });
    await new Promise(setImmediate);
    expect(f.web.discover).toHaveBeenCalledTimes(1);
    expect(f.reader.identityDocument).toHaveBeenCalledTimes(1);
    finishDocument({ candidates: [documentCandidate], sourceGaps: [] });
    const result = await pending;
    expect(result.candidates).toContainEqual(documentCandidate);
    expect(result.candidates).toContainEqual(websiteCandidate);
    expect(f.web.discover).toHaveBeenCalledTimes(1);
    expect(f.reader.identityDocument).toHaveBeenCalledTimes(2);
    expect(f.reader.identityDocument.mock.calls).toEqual([
      [ctx, attachmentId, undefined],
      [ctx, attachmentId, undefined],
    ]);
  });
  it('keeps named website failure explicit after verifying the document', async () => {
    const f = fixture();
    const attachmentId = '10000000-0000-4000-8000-000000000007';
    f.web.discover.mockRejectedValue(new Error('website unavailable'));
    const result = await f.service.discover(ctx, { name: row.legalBusinessName, attachmentId });
    expect(result.sourceGaps).toContain('Company and state-record websites could not be checked.');
    expect(f.web.discover).toHaveBeenCalledTimes(1);
    expect(f.reader.identityDocument).toHaveBeenCalledTimes(2);
  });
  it('starts no inference or public reads after the document reader observes cancellation', async () => {
    const f = fixture();
    const controller = new AbortController();
    const reason = new DOMException('Client disconnected', 'AbortError');
    const source = await f.reader.identityDocument();
    f.reader.identityDocument.mockClear().mockImplementation(async () => {
      controller.abort(reason);
      return source;
    });
    await expect(
      f.service.discover(
        ctx,
        {
          name: row.legalBusinessName,
          attachmentId: source.attachmentId,
        },
        controller.signal,
      ),
    ).rejects.toBe(reason);
    expect(f.web.fromDocument).not.toHaveBeenCalled();
    expect(f.sam.lookupByName).not.toHaveBeenCalled();
  });
  it('discovers a website-only identity from its text and uses its supported name for registries', async () => {
    const f = fixture();
    const candidate = {
      sourceCandidate: {
        source: 'website',
        externalId: 'https://fixture.example/about',
        name: row.legalBusinessName,
        website: 'https://fixture.example/',
      },
      sourceType: 'person_confirmed_website',
      identifiers: [],
      claims: [],
      evidence: [],
    };
    f.web.discover.mockResolvedValue({ candidates: [candidate], sourceGaps: [] });
    const result = await f.service.discover(ctx, { name: '', website: 'https://fixture.example/' });
    expect(result.candidates).toContainEqual(candidate);
    expect(f.sam.lookupByName).toHaveBeenCalledWith(row.legalBusinessName);
    expect(f.reader.identityDocument).not.toHaveBeenCalled();
    expect(f.web.fromDocument).not.toHaveBeenCalled();
    expect(f.web.discover.mock.calls[0]).toEqual([
      ctx,
      { name: '', website: 'https://fixture.example/' },
      undefined,
    ]);
  });
  it('starts a nameless document flow with actual extracted company text, then public sources for that name', async () => {
    const f = fixture(),
      attachmentId = '10000000-0000-4000-8000-000000000007';
    f.web.fromDocument.mockResolvedValue({
      candidates: [
        {
          sourceCandidate: {
            source: 'document',
            externalId: attachmentId,
            name: row.legalBusinessName,
          },
          sourceType: 'person_confirmed_document',
          identifiers: [],
          claims: [],
          evidence: [],
        },
      ],
      sourceGaps: [],
    });
    const result = await f.service.discover(ctx, { name: '', attachmentId });
    expect(f.reader.identityDocument).toHaveBeenCalledTimes(2);
    expect(f.web.fromDocument).toHaveBeenCalledWith(
      ctx,
      '',
      expect.objectContaining({ text: 'Fixture Engineering designs sensors.' }),
      undefined,
    );
    expect(f.sam.lookupByName).toHaveBeenCalledWith(row.legalBusinessName);
    expect(f.sam.lookupByName).not.toHaveBeenCalledWith('Not a company name.pdf');
    expect(result.candidates[0]?.sourceCandidate.source).toBe('document');
  });
  it('does not guess a company or search the filename when the document has no supported identity', async () => {
    const f = fixture();
    const result = await f.service.discover(ctx, {
      name: '',
      attachmentId: '10000000-0000-4000-8000-000000000007',
    });
    expect(f.sam.lookupByName).not.toHaveBeenCalled();
    expect(result.candidates).toEqual([]);
    expect(result.sourceGaps.join(' ')).toContain('No source-supported company name');
  });
  it('never starts model or registry work for an unauthorized identity upload', async () => {
    const f = fixture();
    f.reader.identityDocument.mockRejectedValue(new Error('owner denied'));
    await expect(
      f.service.discover(ctx, { name: '', attachmentId: '10000000-0000-4000-8000-000000000007' }),
    ).rejects.toThrow('owner denied');
    expect(f.web.fromDocument).not.toHaveBeenCalled();
    expect(f.sam.lookupByName).not.toHaveBeenCalled();
  });
  it('acquires official name candidates and retains partial source availability', async () => {
    const f = fixture();
    const result = await f.service.discover(ctx, { name: row.legalBusinessName });
    expect(result.candidates.map((c) => c.sourceCandidate.source)).toEqual(['sam', 'lda']);
    expect(result.sourceGaps).toEqual(['State source unavailable']);
    expect(f.sam.lookupByName).toHaveBeenCalledWith(row.legalBusinessName);
  });
  it('uses exact UEI or CAGE lookup when provided', async () => {
    const f = fixture();
    await f.service.discover(ctx, {
      name: row.legalBusinessName,
      identifiers: [{ type: 'cage', value: row.cageCode }],
    });
    expect(f.sam.lookupByCage).toHaveBeenCalledWith(row.cageCode);
    expect(f.sam.lookupByName).not.toHaveBeenCalled();
  });
  it('rejects changed or missing official identity at confirmation', async () => {
    const f = fixture();
    f.sam.lookupByUei.mockResolvedValue({
      ok: true,
      entities: [{ ...row, legalBusinessName: 'Different company' }],
    });
    await expect(
      f.service.refresh(ctx, { source: 'sam', externalId: row.uei, name: row.legalBusinessName }),
    ).rejects.toThrow('identity changed');
  });
  it('keeps source outages explicit and does not turn them into registration', async () => {
    const f = fixture();
    f.sam.lookupByUei.mockResolvedValue({ ok: false, reason: 'disabled' });
    await expect(
      f.service.refresh(ctx, { source: 'sam', externalId: row.uei, name: row.legalBusinessName }),
    ).rejects.toThrow('cannot be rechecked');
  });
  it('validates current company relationship quotes without accepting unrelated company text', async () => {
    const f = fixture();
    const selected = await f.service.refresh(ctx, {
      source: 'sam',
      externalId: row.uei,
      name: row.legalBusinessName,
    });
    const claim = {
      kind: 'parent' as const,
      name: 'Parent Example',
      sourceUrl: 'https://fixture.example/about',
      quote: 'Fixture Engineering is a subsidiary of Parent Example.',
    };
    expect(await f.service.validateClaims(ctx, selected, [claim])).toEqual([claim]);
    await expect(
      f.service.validateClaims(ctx, selected, [{ ...claim, quote: 'Invented ownership claim' }]),
    ).rejects.toThrow('relationship quote changed');
  });
  it('keeps a state registry page from becoming the company domain', async () => {
    const f = fixture();
    f.reader.website.mockResolvedValue({
      url: 'https://state.example.gov/record/12',
      text: 'Fixture Engineering',
      observedAt: new Date().toISOString(),
    });
    expect(
      (
        await f.service.refresh(ctx, {
          source: 'website',
          externalId: 'https://state.example.gov/record/12',
          name: row.legalBusinessName,
          website: 'https://forged.example',
        })
      ).sourceCandidate.website,
    ).toBeUndefined();
  });

  it('rechecks third-party article evidence without promoting its hostname to a company domain', async () => {
    const f = fixture();
    f.reader.website.mockResolvedValue({
      url: 'https://news.example/story',
      text: 'Fixture Engineering designs sensors.',
      observedAt: new Date().toISOString(),
    });
    const result = await f.service.refresh(ctx, {
      source: 'website',
      externalId: 'https://news.example/story',
      name: row.legalBusinessName,
    });
    expect(result.sourceCandidate.website).toBeUndefined();
    expect(result.evidence[0]?.url).toBe('https://news.example/story');
  });
});
