/**
 * Executable proof for the canonical-promotion artifact-replay path.
 *
 * Phase B's rule is that a preserved parse artifact may be reused ONLY when its
 * bytes are provably the ones that were parsed and recorded, and that a new vendor
 * parse requires explicit authorization. Both were previously verified only by
 * matching source text in the safety gate, which passes even if the comparison is
 * unreachable. These tests drive the real function with a fake Prisma delegate and a
 * fake object getter, so:
 *
 *   - replay reuses a checksummed artifact and makes ZERO vendor/credential calls,
 *   - a tampered artifact is refused even under vendor authorization,
 *   - an unprovable artifact fails closed without authorization and falls through
 *     to an authorized re-parse with it.
 *
 * Importing this module is safe because ingest-defense-budget-pdf.ts runs main()
 * only under `require.main === module`.
 */
import { createHash } from 'node:crypto';
import { describe, expect, jest, test } from '@jest/globals';
import { loadExistingParseArtifact, type ObjectGetter } from './ingest-defense-budget-pdf.js';
import type { PrismaClient } from '@prisma/client';

const SOURCE_DOCUMENT_ID = 'doc-1';
const INPUT_SHA = 'a'.repeat(64);
const BUCKET = 'capiro-defense-budget-raw';
const ARTIFACT_KEY = 'derived/rdte_army_fy2027/parsed.pages-all.json';
const ARTIFACT = { pages: [{ page: 1, md: '| PE | FY2027 |' }] };
const ARTIFACT_TEXT = JSON.stringify(ARTIFACT);
const ARTIFACT_SHA = createHash('sha256').update(Buffer.from(ARTIFACT_TEXT)).digest('hex');

/** Minimal stand-in for the one delegate loadExistingParseArtifact touches. */
function fakePrisma(job: Record<string, unknown> | null): {
  prisma: PrismaClient;
  findFirst: jest.Mock;
} {
  const findFirst = jest.fn(async () => job);
  return {
    prisma: { documentParseJob: { findFirst } } as unknown as PrismaClient,
    findFirst,
  };
}

function parseJob(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'job-1',
    providerJobId: 'provider-9',
    outputJsonS3Key: ARTIFACT_KEY,
    metadata: { outputJsonSha256: ARTIFACT_SHA, canonicalMoneyUnit: 'USD millions' },
    ...over,
  };
}

/**
 * Fails the test if it is ever called, standing in for the vendor client and the
 * credential loader: replay must reach neither.
 */
function forbiddenGetter(label: string): ObjectGetter {
  return () => {
    throw new Error(`must not be called: ${label}`);
  };
}

describe('artifact replay (no vendor call)', () => {
  test('reuses a checksummed artifact and performs zero vendor calls', async () => {
    const { prisma } = fakePrisma(parseJob());
    const getObject = jest.fn<ObjectGetter>(async () => Buffer.from(ARTIFACT_TEXT));

    const prepared = await loadExistingParseArtifact(
      prisma,
      SOURCE_DOCUMENT_ID,
      INPUT_SHA,
      BUCKET,
      'us-east-1',
      // Deliberately WITHOUT vendor authorization: a provable artifact must replay
      // on the default, unauthorized path.
      false,
      getObject,
    );

    expect(prepared).not.toBeNull();
    expect(prepared!.reusedArtifact).toBe(true);
    expect(prepared!.json).toEqual(ARTIFACT);
    expect(prepared!.parseJobId).toBe('job-1');
    expect(prepared!.outputJsonS3Key).toBe(ARTIFACT_KEY);
    expect(prepared!.outputJsonSha256).toBe(ARTIFACT_SHA);
    // Exactly one object read, from the archive bucket, and nothing else.
    expect(getObject).toHaveBeenCalledTimes(1);
    expect(getObject).toHaveBeenCalledWith(BUCKET, ARTIFACT_KEY);
    expect(process.env.LLAMA_CLOUD_API_KEY).toBeUndefined();
  });

  test('queries only for a succeeded, whole-document, same-SHA job', async () => {
    const { prisma, findFirst } = fakePrisma(parseJob());
    await loadExistingParseArtifact(
      prisma,
      SOURCE_DOCUMENT_ID,
      INPUT_SHA,
      BUCKET,
      'us-east-1',
      false,
      async () => Buffer.from(ARTIFACT_TEXT),
    );
    const where = (findFirst.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({
      sourceDocumentId: SOURCE_DOCUMENT_ID,
      inputSha256: INPUT_SHA,
      provider: 'llamaparse',
      status: 'succeeded',
      pageStart: null,
      pageEnd: null,
    });
  });

  test('returns null with no object read when no reusable job exists', async () => {
    const { prisma } = fakePrisma(null);
    await expect(
      loadExistingParseArtifact(
        prisma,
        SOURCE_DOCUMENT_ID,
        INPUT_SHA,
        BUCKET,
        'us-east-1',
        false,
        forbiddenGetter('S3 getObject for a nonexistent artifact'),
      ),
    ).resolves.toBeNull();
  });

  test('returns null with no object read when the job recorded no output key', async () => {
    const { prisma } = fakePrisma(parseJob({ outputJsonS3Key: null }));
    await expect(
      loadExistingParseArtifact(
        prisma,
        SOURCE_DOCUMENT_ID,
        INPUT_SHA,
        BUCKET,
        'us-east-1',
        false,
        forbiddenGetter('S3 getObject without an output key'),
      ),
    ).resolves.toBeNull();
  });
});

describe('artifact replay refuses unprovable bytes', () => {
  // This is the executable form of the checksum comparison. Without it, replaced
  // S3 bytes that still parse as JSON would be promoted as canonical.
  test('refuses an artifact whose bytes no longer match the recorded checksum', async () => {
    const tampered = JSON.stringify({ pages: [{ page: 1, md: '| PE | 13500 |' }] });
    const { prisma } = fakePrisma(parseJob());
    await expect(
      loadExistingParseArtifact(
        prisma,
        SOURCE_DOCUMENT_ID,
        INPUT_SHA,
        BUCKET,
        'us-east-1',
        false,
        async () => Buffer.from(tampered),
      ),
    ).rejects.toThrow('does not match its recorded checksum');
  });

  // A mismatch is positive evidence the stored object changed, so authorization to
  // spend a vendor call must not turn it into a silent fallback.
  test('refuses a mismatched artifact even with vendor authorization', async () => {
    const { prisma } = fakePrisma(parseJob());
    await expect(
      loadExistingParseArtifact(
        prisma,
        SOURCE_DOCUMENT_ID,
        INPUT_SHA,
        BUCKET,
        'us-east-1',
        true,
        async () => Buffer.from('{"pages":[]}'),
      ),
    ).rejects.toThrow('refusing to promote it');
  });

  test('refuses an artifact that is not valid JSON', async () => {
    const notJson = 'PK truncated';
    const { prisma } = fakePrisma(
      parseJob({
        metadata: {
          outputJsonSha256: createHash('sha256').update(Buffer.from(notJson)).digest('hex'),
        },
      }),
    );
    await expect(
      loadExistingParseArtifact(
        prisma,
        SOURCE_DOCUMENT_ID,
        INPUT_SHA,
        BUCKET,
        'us-east-1',
        false,
        async () => Buffer.from(notJson),
      ),
    ).rejects.toThrow('is not valid JSON');
  });

  test.each([
    ['absent metadata', {}],
    ['null metadata', null],
    ['empty checksum', { outputJsonSha256: '' }],
    ['non-string checksum', { outputJsonSha256: 42 }],
  ])(
    'fails closed on an artifact with no recorded checksum (%s) when no vendor parse is authorized',
    async (_label, metadata) => {
      const { prisma } = fakePrisma(parseJob({ metadata }));
      await expect(
        loadExistingParseArtifact(
          prisma,
          SOURCE_DOCUMENT_ID,
          INPUT_SHA,
          BUCKET,
          'us-east-1',
          false,
          async () => Buffer.from(ARTIFACT_TEXT),
        ),
      ).rejects.toThrow('has no recorded output checksum');
    },
  );

  // The error above names --allow-vendor-parse as the remedy. Before this fix the
  // throw preceded that flag's only branch, so the advertised remedy could not be
  // taken and the sole escape was hand-editing the parse-job row.
  test('declines the unprovable artifact instead of throwing once a vendor parse is authorized', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { prisma } = fakePrisma(parseJob({ metadata: {} }));
      await expect(
        loadExistingParseArtifact(
          prisma,
          SOURCE_DOCUMENT_ID,
          INPUT_SHA,
          BUCKET,
          'us-east-1',
          true,
          async () => Buffer.from(ARTIFACT_TEXT),
        ),
      ).resolves.toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('refusing to replay an unprovable artifact'),
      );
    } finally {
      warn.mockRestore();
    }
  });
});
