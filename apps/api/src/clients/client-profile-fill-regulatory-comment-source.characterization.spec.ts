import {
  base,
  apiKey,
  now,
  fetchMock,
  detail,
  response,
  harness,
  installCharacterizationHooks,
} from '../../test/fixtures/client-profile-fill-regulatory-comments.js';

// Preserve the BEFORE test cases while retaining the service facade entry points.
describe('Regulatory comment discovery and detail-cache characterization', () => {
  installCharacterizationHooks();

  test('cached detail returns the global projection without tenant, HTTP or cache writes', async () => {
    const h = harness();
    expect(await h.cache()).toEqual(detail('comment/one'));
    expect(h.prisma.regulatoryComment.findUnique).toHaveBeenCalledWith({
      where: { commentId: 'comment/one' },
    });
    expect(h.prisma.withTenant).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.prisma.regulatoryComment.upsert).not.toHaveBeenCalled();
  });
  test('fresh detail encodes the requested ID and preserves distinct create, update and response projections', async () => {
    const h = harness();
    h.prisma.regulatoryComment.findUnique.mockResolvedValue(null as never);
    const attrs = {
      docketId: 'DOD-2026-2',
      agencyId: 'DOD',
      title: 'Official title',
      comment: 'Fresh text',
      firstName: 'Amy',
      lastName: 'Jones',
      organization: 'Other org',
      city: 'Boston',
      stateProvinceRegion: 'MA',
      country: 'USA',
      postedDate: '2026-02-03',
    };
    fetchMock.mockResolvedValueOnce(
      response({ data: { id: 'different-response-id', attributes: attrs } }),
    );
    const actual = await h.cache();
    const sourceUrl = `${base}/comment%2Fone`;
    expect(fetchMock.mock.calls[0]![0]).toBe(`${sourceUrl}?api_key=${apiKey}`);
    expect(h.prisma.regulatoryComment.upsert).toHaveBeenCalledWith({
      where: { commentId: 'comment/one' },
      create: {
        commentId: 'comment/one',
        docketId: attrs.docketId,
        agencyId: attrs.agencyId,
        title: attrs.title,
        commentText: attrs.comment,
        firstName: attrs.firstName,
        lastName: attrs.lastName,
        organization: attrs.organization,
        city: attrs.city,
        stateProvince: 'MA',
        country: attrs.country,
        postedDate: new Date('2026-02-03'),
        sourceUrl,
      },
      update: {
        title: attrs.title,
        commentText: attrs.comment,
        organization: attrs.organization,
        syncedAt: now,
      },
    });
    expect(actual).toEqual({
      commentId: 'comment/one',
      docketId: attrs.docketId,
      agencyId: attrs.agencyId,
      commentText: attrs.comment,
      firstName: attrs.firstName,
      lastName: attrs.lastName,
      organization: attrs.organization,
      city: attrs.city,
      stateProvince: 'MA',
      country: attrs.country,
      postedDate: new Date('2026-02-03'),
      sourceUrl,
    });
    expect(h.prisma.withTenant).not.toHaveBeenCalled();
  });
  test('empty detail attributes produce the existing title fallback and nullable fields', async () => {
    const h = harness();
    h.prisma.regulatoryComment.findUnique.mockResolvedValue(null as never);
    fetchMock.mockResolvedValueOnce(response({ data: { attributes: {} } }));
    expect(await h.cache()).toEqual({
      commentId: 'comment/one',
      docketId: null,
      agencyId: null,
      commentText: null,
      firstName: null,
      lastName: null,
      organization: null,
      city: null,
      stateProvince: null,
      country: null,
      postedDate: null,
      sourceUrl: `${base}/comment%2Fone`,
    });
    expect(h.prisma.regulatoryComment.upsert.mock.calls[0]![0]).toMatchObject({
      create: { title: 'Comment comment/one' },
      update: {
        title: 'Comment comment/one',
        commentText: null,
        organization: null,
        syncedAt: now,
      },
    });
  });
  test.each([404, 503, 'missing-attributes', 'fetch-error', 'json-error', 'upsert-error'])(
    'unavailable detail (%s) returns null and preserves cache-write behavior',
    async (failure) => {
      const h = harness();
      h.prisma.regulatoryComment.findUnique.mockResolvedValue(null as never);
      if (typeof failure === 'number') fetchMock.mockResolvedValueOnce(response({}, failure));
      else if (failure === 'fetch-error')
        fetchMock.mockRejectedValueOnce(new Error('fetch unavailable'));
      else if (failure === 'json-error')
        fetchMock.mockResolvedValueOnce({
          ok: true,
          json: jest.fn().mockRejectedValue(new Error('bad JSON')),
        });
      else {
        fetchMock.mockResolvedValueOnce(
          response({ data: failure === 'missing-attributes' ? {} : { attributes: {} } }),
        );
        if (failure === 'upsert-error')
          h.prisma.regulatoryComment.upsert.mockRejectedValueOnce(
            new Error('cache write unavailable'),
          );
      }
      expect(await h.cache()).toBeNull();
      expect(h.prisma.regulatoryComment.upsert).toHaveBeenCalledTimes(
        failure === 'upsert-error' ? 1 : 0,
      );
    },
  );
  test('cache-read failures propagate outside the fetch catch without HTTP work', async () => {
    const h = harness();
    h.prisma.regulatoryComment.findUnique.mockRejectedValueOnce(
      new Error('cache read unavailable'),
    );
    await expect(h.cache()).rejects.toThrow('cache read unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.warning).not.toHaveBeenCalled();
  });
});
