import type { S3Client } from '@aws-sdk/client-s3';
import { AwsParserArtifactObjectStore } from './s3-parser-artifact-store.js';

describe('AwsParserArtifactObjectStore', () => {
  it('treats NoSuchKey as a normal cache miss', async () => {
    const client = {
      send: jest.fn().mockRejectedValue({ name: 'NoSuchKey' }),
    } as unknown as S3Client;
    const store = new AwsParserArtifactObjectStore(client);
    await expect(store.getObject({ bucket: 'bucket', key: 'missing.json' })).resolves.toBeNull();
  });

  it('does not hide authorization or service failures as cache misses', async () => {
    const failure = Object.assign(new Error('access denied'), {
      name: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    });
    const client = {
      send: jest.fn().mockRejectedValue(failure),
    } as unknown as S3Client;
    const store = new AwsParserArtifactObjectStore(client);
    await expect(store.getObject({ bucket: 'bucket', key: 'result.json' })).rejects.toBe(failure);
  });

  it('passes an exact VersionId to GetObject', async () => {
    const send = jest.fn().mockResolvedValue({
      Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
      VersionId: 'v1',
    });
    const client = { send } as unknown as S3Client;
    const store = new AwsParserArtifactObjectStore(client);
    await expect(
      store.getObject({ bucket: 'bucket', key: 'result.json', versionId: 'v1' }),
    ).resolves.toMatchObject({ versionId: 'v1' });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Bucket: 'bucket',
          Key: 'result.json',
          VersionId: 'v1',
        }),
      }),
    );
  });
});
