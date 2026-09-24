import { createHash } from 'node:crypto';
import type { S3Client } from '@aws-sdk/client-s3';

import { S3SourceDocumentArchiveReadAdapter } from './s3-source-document-archive-read.adapter.js';

describe('S3SourceDocumentArchiveReadAdapter cancellation', () => {
  const locator = {
    bucket: 'package-e-test-archive',
    key: 'immutable/source.pdf',
    versionId: 'version-1',
  };

  it('passes the governed abort signal to the version-pinned GetObject request', async () => {
    const bytes = Buffer.from('%PDF-1.7\nPackage E');
    const send = jest.fn(async () => ({
      Body: { transformToByteArray: async () => bytes },
    }));
    const adapter = new S3SourceDocumentArchiveReadAdapter({
      client: { send } as unknown as S3Client,
    });
    const controller = new AbortController();

    await expect(adapter.readMaterializedBytes(locator, {
      abortSignal: controller.signal,
    })).resolves.toEqual({
      bytes,
      contentSha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { Bucket: locator.bucket, Key: locator.key, VersionId: locator.versionId },
      }),
      { abortSignal: controller.signal },
    );
  });

  it('refuses a pre-aborted read before issuing an S3 request', async () => {
    const send = jest.fn();
    const adapter = new S3SourceDocumentArchiveReadAdapter({
      client: { send } as unknown as S3Client,
    });
    const controller = new AbortController();
    controller.abort(new Error('Package E execution deadline exceeded'));

    await expect(adapter.readMaterializedBytes(locator, {
      abortSignal: controller.signal,
    })).rejects.toThrow('Package E execution deadline exceeded');
    expect(send).not.toHaveBeenCalled();
  });
});
