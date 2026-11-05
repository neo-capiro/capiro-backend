import { fetchFederalMetadata } from './federal-bill-metadata';

describe('federal metadata subject pagination', () => {
  const bill = {
    congress: 119,
    type: 'S',
    number: '2296',
    updateDate: '2026-02-01T00:00:00Z',
  };
  const policyArea = { name: 'Armed Forces and National Security' };
  const subject = (name: string) => ({ name });
  const continuation = (offset: number) =>
    `https://api.congress.gov/v3/bill/119/s/2296/subjects?offset=${offset}&limit=250&format=json`;
  function fetchPages(subjectPages: unknown[], lastBill = bill) {
    const fetch = jest.fn().mockResolvedValueOnce({ bill });
    for (const page of subjectPages) fetch.mockResolvedValueOnce(page);
    return fetch
      .mockResolvedValueOnce({
        cosponsors: [],
        pagination: { count: 0, countIncludingWithdrawnCosponsors: 0 },
      })
      .mockResolvedValueOnce({ bill: lastBill });
  }

  it('accepts the HR10046 policy-only envelope without storing a policy area as a subject', async () => {
    const houseBill = { ...bill, type: 'HR', number: '10046' };
    const fetch = jest
      .fn()
      .mockResolvedValueOnce({ bill: houseBill })
      .mockResolvedValueOnce({
        subjects: { legislativeSubjects: [], policyArea },
        pagination: { count: 1 },
      })
      .mockResolvedValueOnce({ cosponsors: [], pagination: { count: 0 } })
      .mockResolvedValueOnce({ bill: houseBill });
    expect(await fetchFederalMetadata('119-hr-10046', 'synthetic-key', fetch)).toMatchObject({
      subjects: [],
      cosponsors: [],
      metadataUpdatedAt: houseBill.updateDate,
    });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('follows S2296 offset250 after249 legislative subjects plus the policy area', async () => {
    const first = Array.from({ length: 249 }, (_, index) => subject(`Subject ${index}`));
    const last = Array.from({ length: 14 }, (_, index) => subject(`Remaining ${index}`));
    const fetch = fetchPages([
      {
        subjects: { legislativeSubjects: first, policyArea },
        pagination: { count: 264, next: continuation(250) },
      },
      { subjects: { legislativeSubjects: last }, pagination: { count: 264 } },
    ]);
    const result = await fetchFederalMetadata('119-s-2296', 'synthetic-key', fetch);
    expect(result.subjects).toEqual([...first, ...last].map((item) => item.name).sort());
    expect(result.subjects).not.toContain(policyArea.name);
    expect(new URL(fetch.mock.calls[2]![0]).searchParams.get('offset')).toBe('250');
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('retains the authoritative empty-list and unpaginated response contracts', async () => {
    for (const subjects of [{ legislativeSubjects: [] }, { legislativeSubjects: [], policyArea }]) {
      expect(
        await fetchFederalMetadata('119-s-2296', 'synthetic-key', fetchPages([{ subjects }])),
      ).toMatchObject({ subjects: [] });
    }
  });

  it('keeps cosponsor pagination based on the inclusive withdrawn-episode count', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce({ bill })
      .mockResolvedValueOnce({
        subjects: { legislativeSubjects: [], policyArea },
        pagination: { count: 1 },
      })
      .mockResolvedValueOnce({
        cosponsors: [{ bioguideId: 'A000001', fullName: 'First Member' }],
        pagination: {
          count: 1,
          countIncludingWithdrawnCosponsors: 2,
          next: 'https://api.congress.gov/v3/bill/119/s/2296/cosponsors?offset=1&limit=250',
        },
      })
      .mockResolvedValueOnce({
        cosponsors: [
          {
            bioguideId: 'B000002',
            fullName: 'Former Member',
            sponsorshipWithdrawnDate: '2026-01-01',
          },
        ],
        pagination: { count: 1, countIncludingWithdrawnCosponsors: 2 },
      })
      .mockResolvedValueOnce({ bill });
    const result = await fetchFederalMetadata('119-s-2296', 'synthetic-key', fetch);
    expect(result.cosponsorEpisodes).toHaveLength(2);
    expect(result.cosponsors.map((member) => member.bioguideId)).toEqual(['A000001', 'B000002']);
    expect(new URL(fetch.mock.calls[3]![0]).searchParams.get('offset')).toBe('1');
  });

  it.each([{}, [], 'invalid', { name: '' }, { name: 1 }])(
    'rejects a malformed policy area instead of using it to satisfy the count: %j',
    async (malformed) => {
      const fetch = fetchPages([
        { subjects: { legislativeSubjects: [], policyArea: malformed }, pagination: { count: 1 } },
      ]);
      await expect(fetchFederalMetadata('119-s-2296', 'synthetic-key', fetch)).rejects.toThrow(
        'FEDERAL_METADATA_SUBJECTS_INCOMPLETE',
      );
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it.each([undefined, null, [{ name: '' }]])(
    'rejects malformed legislative subjects: %j',
    async (items) => {
      const fetch = fetchPages([
        { subjects: { legislativeSubjects: items, policyArea }, pagination: { count: 1 } },
      ]);
      await expect(fetchFederalMetadata('119-s-2296', 'synthetic-key', fetch)).rejects.toThrow(
        'FEDERAL_METADATA_SUBJECTS_INCOMPLETE',
      );
    },
  );

  it('rejects a truncated list even when its policy area is valid', async () => {
    const fetch = fetchPages([
      { subjects: { legislativeSubjects: [], policyArea }, pagination: { count: 2 } },
    ]);
    await expect(fetchFederalMetadata('119-s-2296', 'synthetic-key', fetch)).rejects.toThrow(
      'FEDERAL_METADATA_TRUNCATED',
    );
  });

  it('rejects changing totals between pages', async () => {
    const fetch = fetchPages([
      {
        subjects: { legislativeSubjects: [], policyArea },
        pagination: { count: 2, next: continuation(1) },
      },
      { subjects: { legislativeSubjects: [subject('A')] }, pagination: { count: 3 } },
    ]);
    await expect(fetchFederalMetadata('119-s-2296', 'synthetic-key', fetch)).rejects.toThrow(
      'FEDERAL_METADATA_COUNT_INVALID',
    );
  });

  it.each([-1, 1.5, '1'])('rejects a malformed provider total: %j', async (count) => {
    const fetch = fetchPages([
      { subjects: { legislativeSubjects: [], policyArea }, pagination: { count } },
    ]);
    await expect(fetchFederalMetadata('119-s-2296', 'synthetic-key', fetch)).rejects.toThrow(
      'FEDERAL_METADATA_COUNT_INVALID',
    );
  });

  it.each([0, '', false])('rejects a malformed continuation: %j', async (next) => {
    const fetch = fetchPages([
      { subjects: { legislativeSubjects: [], policyArea }, pagination: { count: 1, next } },
    ]);
    await expect(fetchFederalMetadata('119-s-2296', 'synthetic-key', fetch)).rejects.toThrow(
      'FEDERAL_METADATA_TRUNCATED',
    );
  });

  it.each([continuation(0), continuation(2), continuation(1).replace('/2296/', '/2297/')])(
    'rejects a repeated, skipped, or foreign-bill continuation before fetching it',
    async (next) => {
      const fetch = fetchPages([
        { subjects: { legislativeSubjects: [], policyArea }, pagination: { count: 2, next } },
      ]);
      await expect(fetchFederalMetadata('119-s-2296', 'synthetic-key', fetch)).rejects.toThrow(
        'FEDERAL_METADATA_PAGINATION_SCOPE_INVALID',
      );
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it('still rejects metadata that changes during the complete subresource fetch', async () => {
    const fetch = fetchPages(
      [{ subjects: { legislativeSubjects: [], policyArea }, pagination: { count: 1 } }],
      { ...bill, updateDate: '2026-02-02T00:00:00Z' },
    );
    await expect(fetchFederalMetadata('119-s-2296', 'synthetic-key', fetch)).rejects.toThrow(
      'FEDERAL_METADATA_CHANGED_DURING_FETCH',
    );
  });
});
