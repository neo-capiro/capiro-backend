import { describe, expect, jest, test } from '@jest/globals';
import {
  classifyObject,
  gcClientLogos,
  isDeleteVerdict,
  parseArgs,
  type BucketObject,
  type GcPrisma,
  type GcS3,
} from './gc-client-logos.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const OTHER_CLIENT = '33333333-3333-4333-8333-333333333333';

function key(clientId = CLIENT, uploadId = '44444444-4444-4444-8444-444444444444', ext = 'png') {
  return `tenants/${TENANT}/clients/${clientId}/logos/${uploadId}.${ext}`;
}

function obj(over: Partial<BucketObject> = {}): BucketObject {
  return { key: key(), lastModified: new Date('2026-01-01T00:00:00Z'), ...over };
}

describe('parseArgs', () => {
  test('dry run with default margins is the default', () => {
    expect(parseArgs(['node', 'script'])).toEqual({
      commit: false,
      minAgeDays: 30,
      maxDeletes: 1000,
    });
  });

  test('--commit, --min-age-days and --max-deletes are read in both spellings', () => {
    expect(
      parseArgs(['node', 'script', '--commit', '--min-age-days', '60', '--max-deletes', '5']),
    ).toEqual({ commit: true, minAgeDays: 60, maxDeletes: 5 });
    expect(parseArgs(['node', 'script', '--min-age-days=7', '--max-deletes=200'])).toEqual({
      commit: false,
      minAgeDays: 7,
      maxDeletes: 200,
    });
  });

  test('a garbage numeric value falls back to the default rather than NaN/negative', () => {
    expect(parseArgs(['node', 'script', '--min-age-days=not-a-number'])).toEqual({
      commit: false,
      minAgeDays: 30,
      maxDeletes: 1000,
    });
    expect(parseArgs(['node', 'script', '--max-deletes=-5'])).toEqual({
      commit: false,
      minAgeDays: 30,
      maxDeletes: 1000,
    });
  });
});

describe('classifyObject', () => {
  const now = new Date('2026-02-01T00:00:00Z'); // 31 days after obj()'s lastModified

  test('an object matching a currently-referenced key is kept', () => {
    const referenced = new Set([key()]);
    const result = classifyObject(obj(), referenced, now, 30);
    expect(result).toEqual({
      key: key(),
      verdict: 'keep_referenced',
      tenantId: TENANT,
      clientId: CLIENT,
    });
    expect(isDeleteVerdict(result.verdict)).toBe(false);
  });

  test('an unreferenced object past the age margin is deleted', () => {
    const result = classifyObject(obj(), new Set(), now, 30);
    expect(result.verdict).toBe('delete_orphaned');
    expect(isDeleteVerdict(result.verdict)).toBe(true);
  });

  test('an unreferenced object younger than the age margin is kept', () => {
    // 31 days old against a 45-day margin.
    const result = classifyObject(obj(), new Set(), now, 45);
    expect(result.verdict).toBe('keep_too_young');
  });

  test('exactly at the age margin boundary is eligible (>=), not kept', () => {
    const exactlyThirty = new Date('2026-01-01T00:00:00Z');
    const nowPlus30 = new Date(exactlyThirty.getTime() + 30 * 24 * 60 * 60 * 1000);
    const result = classifyObject(
      { key: key(), lastModified: exactlyThirty },
      new Set(),
      nowPlus30,
      30,
    );
    expect(result.verdict).toBe('delete_orphaned');
  });

  test('a key outside the confirmed-logo shape is skipped regardless of age or reference', () => {
    const stagingKey = `tenants/client-logo-uploads/${TENANT}/${CLIENT}/x.png`;
    const result = classifyObject({ key: stagingKey, lastModified: new Date(0) }, new Set(), now, 30);
    expect(result).toEqual({
      key: stagingKey,
      verdict: 'skip_out_of_scope',
      tenantId: null,
      clientId: null,
    });
  });

  test('a tenant branding logo key is skipped, never treated as a client logo', () => {
    const brandingKey = `tenants/${TENANT}/branding/logo.png`;
    const result = classifyObject({ key: brandingKey, lastModified: new Date(0) }, new Set(), now, 30);
    expect(result.verdict).toBe('skip_out_of_scope');
  });

  test('a missing LastModified fails closed rather than being treated as old enough', () => {
    const result = classifyObject({ key: key(), lastModified: null }, new Set(), now, 30);
    expect(result.verdict).toBe('skip_unknown_age');
  });

  test('reference matching is exact-key, not just same client', () => {
    // A different upload id under the same client is not the referenced one.
    const referenced = new Set([key(CLIENT, '99999999-9999-4999-8999-999999999999')]);
    const result = classifyObject(obj(), referenced, now, 30);
    expect(result.verdict).toBe('delete_orphaned');
  });

  test('an orphan under a different client than any referenced key is still delete_orphaned', () => {
    const referenced = new Set([key(OTHER_CLIENT)]);
    const result = classifyObject(obj(), referenced, now, 30);
    expect(result.verdict).toBe('delete_orphaned');
    expect(result.clientId).toBe(CLIENT);
  });
});

// ── gcClientLogos orchestration ──────────────────────────────────────────────

function fakePrisma(referencedKeys: string[]) {
  const queryRaw = jest.fn(async () => referencedKeys.map((logoS3Key) => ({ logoS3Key })));
  const executeRawUnsafe = jest.fn(async () => 0);
  const prisma: GcPrisma = {
    $transaction: async (fn) => fn(prisma),
    $executeRawUnsafe: executeRawUnsafe,
    $queryRaw: queryRaw as unknown as GcPrisma['$queryRaw'],
  };
  return { prisma, queryRaw, executeRawUnsafe };
}

function fakeS3(pages: BucketObject[][]) {
  const deleteObject = jest.fn(async (_key: string) => {});
  let call = 0;
  const s3: GcS3 = {
    listPage: async (_token) => {
      const objects = pages[call] ?? [];
      call += 1;
      const hasMore = call < pages.length;
      return { objects, nextToken: hasMore ? `token-${call}` : undefined };
    },
    deleteObject,
  };
  return { s3, deleteObject };
}

describe('gcClientLogos', () => {
  const now = new Date('2026-02-01T00:00:00Z');
  const orphanA = key(CLIENT, '44444444-4444-4444-8444-444444444444');
  const orphanB = key(CLIENT, '55555555-5555-4555-8555-555555555555');
  const live = key(OTHER_CLIENT, '66666666-6666-4666-8666-666666666666');

  test('a dry run deletes nothing but reports exactly what it would delete', async () => {
    const { prisma } = fakePrisma([live]);
    const { s3, deleteObject } = fakeS3([
      [
        { key: orphanA, lastModified: new Date('2026-01-01T00:00:00Z') },
        { key: live, lastModified: new Date('2026-01-01T00:00:00Z') },
      ],
    ]);

    const result = await gcClientLogos(prisma, s3, {
      commit: false,
      minAgeDays: 30,
      maxDeletes: 1000,
      now,
    });

    expect(deleteObject).not.toHaveBeenCalled();
    expect(result.scanned).toBe(2);
    expect(result.inScope).toBe(1);
    expect(result.deleted).toBe(1);
    expect(result.kept).toBe(1);
    expect(result.deletedKeys).toEqual([orphanA]);
    expect(result.byVerdict.delete_orphaned).toBe(1);
    expect(result.byVerdict.keep_referenced).toBe(1);
  });

  test('--commit deletes only the orphaned keys, one at a time', async () => {
    const { prisma } = fakePrisma([live]);
    const { s3, deleteObject } = fakeS3([
      [
        { key: orphanA, lastModified: new Date('2026-01-01T00:00:00Z') },
        { key: live, lastModified: new Date('2026-01-01T00:00:00Z') },
      ],
    ]);

    const result = await gcClientLogos(prisma, s3, {
      commit: true,
      minAgeDays: 30,
      maxDeletes: 1000,
      now,
    });

    expect(deleteObject).toHaveBeenCalledTimes(1);
    expect(deleteObject).toHaveBeenCalledWith(orphanA);
    expect(result.deleted).toBe(1);
  });

  test('pagination is followed across multiple listPage calls', async () => {
    const { prisma } = fakePrisma([]);
    const { s3, deleteObject } = fakeS3([
      [{ key: orphanA, lastModified: new Date('2026-01-01T00:00:00Z') }],
      [{ key: orphanB, lastModified: new Date('2026-01-01T00:00:00Z') }],
    ]);

    const result = await gcClientLogos(prisma, s3, {
      commit: true,
      minAgeDays: 30,
      maxDeletes: 1000,
      now,
    });

    expect(result.scanned).toBe(2);
    expect(result.deleted).toBe(2);
    expect(deleteObject).toHaveBeenCalledTimes(2);
  });

  test('max-deletes caps how many are acted on, and discloses the cap', async () => {
    const { prisma } = fakePrisma([]);
    const { s3, deleteObject } = fakeS3([
      [
        { key: orphanA, lastModified: new Date('2026-01-01T00:00:00Z') },
        { key: orphanB, lastModified: new Date('2026-01-01T00:00:00Z') },
      ],
    ]);

    const result = await gcClientLogos(prisma, s3, {
      commit: true,
      minAgeDays: 30,
      maxDeletes: 1,
      now,
    });

    expect(deleteObject).toHaveBeenCalledTimes(1);
    expect(result.deleted).toBe(1);
    expect(result.inScope).toBe(2); // both orphans were found and counted
    expect(result.cappedByMaxDeletes).toBe(true);
  });

  test('a failed delete is counted as an error and does not abort the rest', async () => {
    const { prisma } = fakePrisma([]);
    const { s3, deleteObject } = fakeS3([
      [
        { key: orphanA, lastModified: new Date('2026-01-01T00:00:00Z') },
        { key: orphanB, lastModified: new Date('2026-01-01T00:00:00Z') },
      ],
    ]);
    deleteObject.mockImplementationOnce(async () => {
      throw new Error('S3 throttled');
    });

    const result = await gcClientLogos(prisma, s3, {
      commit: true,
      minAgeDays: 30,
      maxDeletes: 1000,
      now,
    });

    expect(result.errors).toBe(1);
    expect(result.deleted).toBe(1);
    expect(deleteObject).toHaveBeenCalledTimes(2);
  });

  test('is idempotent: a second run over the post-GC set deletes nothing', async () => {
    const { prisma } = fakePrisma([live]);
    const { s3, deleteObject } = fakeS3([
      [{ key: live, lastModified: new Date('2026-01-01T00:00:00Z') }],
    ]);

    const result = await gcClientLogos(prisma, s3, {
      commit: true,
      minAgeDays: 30,
      maxDeletes: 1000,
      now,
    });

    expect(deleteObject).not.toHaveBeenCalled();
    expect(result.deleted).toBe(0);
    expect(result.kept).toBe(1);
  });

  test('the referenced-key query always sets the RLS bypass', async () => {
    const { prisma, queryRaw, executeRawUnsafe } = fakePrisma([]);
    const { s3 } = fakeS3([[]]);
    await gcClientLogos(prisma, s3, { commit: false, minAgeDays: 30, maxDeletes: 1000, now });
    expect(queryRaw).toHaveBeenCalled();
    expect(executeRawUnsafe).toHaveBeenCalledWith(
      "SELECT set_config('app.bypass_rls', 'on', true)",
    );
  });
});
