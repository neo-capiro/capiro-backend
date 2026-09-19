import {
  floridaWatchCandidate,
  backfillFloridaWatchCandidates,
} from './florida-calendar-discovery.js';

function prismaMock(rows: any[], recordImpl?: { existing?: any; onCreate?: (data: any) => void; onUpdate?: (data: any) => void }) {
  const created: any[] = [];
  const updated: any[] = [];
  const prisma = {
    committeeHearing: {
      findMany: jest.fn(async ({ where, take }: any) => {
        const gt = where?.id?.gt;
        const filtered = gt ? rows.filter((r) => r.id > gt) : rows;
        return filtered.slice(0, take);
      }),
    },
    hearingStreamCandidate: {
      findFirst: jest.fn(async () => recordImpl?.existing ?? null),
      create: jest.fn(async ({ data }: any) => {
        created.push(data);
        recordImpl?.onCreate?.(data);
        return data;
      }),
      update: jest.fn(async ({ data }: any) => {
        updated.push(data);
        recordImpl?.onUpdate?.(data);
        return data;
      }),
      count: jest.fn(async () => created.length),
    },
  } as any;
  return { prisma, created, updated };
}

describe('Florida official watch-page stream candidate', () => {
  it('advertises the official chamber player as a browser-only first-party page', () => {
    expect(
      floridaWatchCandidate('senate', 'https://www.flsenate.gov/media/VideoPlayer/6382'),
    ).toEqual({
      provider: 'florida-senate',
      officialPageUrl: 'https://www.flsenate.gov/media/VideoPlayer/6382',
      mediaUrl: null,
      capturePolicy: 'BROWSER_CAPTURE_ONLY',
      priority: 10,
    });
    expect(
      floridaWatchCandidate('house', 'https://www.flhouse.gov/VideoPlayer.aspx?event=1'),
    ).toMatchObject({ provider: 'florida-house', capturePolicy: 'BROWSER_CAPTURE_ONLY' });
  });

  it('backfills existing FL rows from top-level snapshot.watchUrl, idempotently', async () => {
    const rows = [
      {
        id: 'fl-a',
        chamber: 'Senate',
        calendarSnapshot: { watchUrl: 'https://www.flsenate.gov/media/VideoPlayer/6382' },
      },
      {
        id: 'fl-b',
        chamber: 'House',
        calendarSnapshot: { fields: { watchUrl: 'https://www.flhouse.gov/VideoPlayer.aspx?e=9' } },
      },
      { id: 'fl-c', chamber: 'Senate', calendarSnapshot: { watchUrl: null } },
    ];
    const { prisma, created } = prismaMock(rows);
    const res = await backfillFloridaWatchCandidates(prisma, { limit: 500 });
    expect(res.scanned).toBe(3);
    expect(res.created).toBe(2);
    expect(res.nextCursor).toBeNull();
    expect(created.map((c) => c.hearingId)).toEqual(['fl-a', 'fl-b']);
    expect(created[0]).toMatchObject({
      provider: 'florida-senate',
      officialPageUrl: 'https://www.flsenate.gov/media/VideoPlayer/6382',
      mediaUrl: null,
      capturePolicy: 'BROWSER_CAPTURE_ONLY',
      resolutionState: 'NOT_CHECKED',
    });
    expect(created[1]).toMatchObject({ provider: 'florida-house' });
  });

  it('derives the provider from the watch URL host, not the chamber column', async () => {
    // A Joint sitting carrying a Senate player must be labeled florida-senate.
    const rows = [
      {
        id: 'fl-joint',
        chamber: 'Joint',
        calendarSnapshot: { watchUrl: 'https://www.flsenate.gov/media/VideoPlayer/6382' },
      },
    ];
    const { prisma, created } = prismaMock(rows);
    const res = await backfillFloridaWatchCandidates(prisma, {});
    expect(res.created).toBe(1);
    expect(created[0]).toMatchObject({ provider: 'florida-senate' });
  });

  it('does not duplicate or downgrade an existing candidate on re-run', async () => {
    const rows = [
      {
        id: 'fl-a',
        chamber: 'Senate',
        calendarSnapshot: { watchUrl: 'https://www.flsenate.gov/media/VideoPlayer/6382' },
      },
    ];
    const { prisma, updated } = prismaMock(rows, { existing: { id: 'cand-1' } });
    const res = await backfillFloridaWatchCandidates(prisma, {});
    expect(res.created).toBe(0);
    expect(res.refreshed).toBe(1);
    expect(prisma.hearingStreamCandidate.create).not.toHaveBeenCalled();
    // refresh only touches page/mediaType; resolution_state is never rewritten.
    expect(updated[0]).not.toHaveProperty('resolutionState');
  });

  it('returns one bounded page and a resumable nextCursor when more rows exist', async () => {
    const rows = [
      { id: 'fl-001', chamber: 'Senate', calendarSnapshot: { watchUrl: 'https://www.flsenate.gov/media/VideoPlayer/1' } },
      { id: 'fl-002', chamber: 'Senate', calendarSnapshot: { watchUrl: 'https://www.flsenate.gov/media/VideoPlayer/2' } },
      { id: 'fl-003', chamber: 'Senate', calendarSnapshot: { watchUrl: 'https://www.flsenate.gov/media/VideoPlayer/3' } },
    ];
    const { prisma, created } = prismaMock(rows);
    const res = await backfillFloridaWatchCandidates(prisma, { limit: 2 });
    expect(res.scanned).toBe(2);
    expect(res.created).toBe(2);
    expect(res.nextCursor).toBe('fl-002');
    expect(created.map((c) => c.hearingId)).toEqual(['fl-001', 'fl-002']);
    // Resume from the cursor: only the remaining row is scanned.
    const { prisma: prisma2, created: created2 } = prismaMock(rows);
    const res2 = await backfillFloridaWatchCandidates(prisma2, { limit: 2, cursor: res.nextCursor! });
    expect(res2.scanned).toBe(1);
    expect(res2.created).toBe(1);
    expect(res2.nextCursor).toBeNull();
    expect(created2.map((c) => c.hearingId)).toEqual(['fl-003']);
  });

  it('accepts an exact-boundary page with no nextCursor', async () => {
    const rows = [
      { id: 'fl-001', chamber: 'Senate', calendarSnapshot: { watchUrl: 'https://www.flsenate.gov/media/VideoPlayer/1' } },
      { id: 'fl-002', chamber: 'Senate', calendarSnapshot: { watchUrl: 'https://www.flsenate.gov/media/VideoPlayer/2' } },
    ];
    const { prisma } = prismaMock(rows);
    const res = await backfillFloridaWatchCandidates(prisma, { limit: 2 });
    expect(res.scanned).toBe(2);
    expect(res.nextCursor).toBeNull();
  });

  it('validates limit is a finite integer in 1..5000', async () => {
    const { prisma } = prismaMock([]);
    await expect(backfillFloridaWatchCandidates(prisma, { limit: 0 })).rejects.toThrow(
      /integer in 1\.\.5000/,
    );
    await expect(backfillFloridaWatchCandidates(prisma, { limit: 5001 })).rejects.toThrow(
      /integer in 1\.\.5000/,
    );
    await expect(backfillFloridaWatchCandidates(prisma, { limit: 1.5 })).rejects.toThrow(
      /integer in 1\.\.5000/,
    );
    await expect(backfillFloridaWatchCandidates(prisma, { limit: Number.NaN })).rejects.toThrow(
      /integer in 1\.\.5000/,
    );
    await expect(backfillFloridaWatchCandidates(prisma, { limit: Number.POSITIVE_INFINITY })).rejects.toThrow(
      /integer in 1\.\.5000/,
    );
  });

  it('matches only exact or dot-suffix official hosts; hostile suffix/prefix is skipped', async () => {
    const rows = [
      // Hostile SUFFIX: evilflsenate.gov is NOT flsenate.gov.
      { id: 'fl-evil', chamber: 'House', calendarSnapshot: { watchUrl: 'https://evilflsenate.gov/media/VideoPlayer/6382' } },
      // Hostile PREFIX: flsenate.gov.evil.example only ENDS in the official host string.
      { id: 'fl-prefix', chamber: 'Senate', calendarSnapshot: { watchUrl: 'https://flsenate.gov.evil.example/media/VideoPlayer/6382' } },
      // Real dot-subdomain of the official host — accepted, provider from URL host.
      { id: 'fl-sub', chamber: 'House', calendarSnapshot: { watchUrl: 'https://www.flsenate.gov/media/VideoPlayer/6382' } },
      // Exact official house host — accepted.
      { id: 'fl-house', chamber: 'Senate', calendarSnapshot: { watchUrl: 'https://www.flhouse.gov/VideoPlayer.aspx?eventID=1' } },
    ];
    const { prisma, created } = prismaMock(rows);
    const res = await backfillFloridaWatchCandidates(prisma, {});
    expect(res.scanned).toBe(4);
    expect(res.created).toBe(2);
    expect(created.map((c) => c.hearingId)).toEqual(['fl-sub', 'fl-house']);
    expect(created[0]).toMatchObject({ provider: 'florida-senate' });
    expect(created[1]).toMatchObject({ provider: 'florida-house' });
  });

  it('rejects non-http(s), credential-bearing, and malformed watch URLs — no candidate recorded', async () => {
    const rows = [
      { id: 'fl-ftp', chamber: 'Senate', calendarSnapshot: { watchUrl: 'ftp://flsenate.gov/media/VideoPlayer/6382' } },
      { id: 'fl-cred', chamber: 'Senate', calendarSnapshot: { watchUrl: 'https://user:pass@flsenate.gov/media/VideoPlayer/6382' } },
      { id: 'fl-js', chamber: 'House', calendarSnapshot: { watchUrl: 'javascript:alert(1)' } },
      { id: 'fl-bad', chamber: 'House', calendarSnapshot: { watchUrl: 'not a url' } },
    ];
    const { prisma, created } = prismaMock(rows);
    const res = await backfillFloridaWatchCandidates(prisma, {});
    expect(res.scanned).toBe(4);
    expect(res.created).toBe(0);
    expect(prisma.hearingStreamCandidate.create).not.toHaveBeenCalled();
    expect(created).toEqual([]);
  });
});
