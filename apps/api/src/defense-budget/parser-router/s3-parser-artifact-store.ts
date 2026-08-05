/** AWS SDK adapter for the Phase 3 S3 parser artifact store. */
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import {
  S3ParserArtifactStore,
  type ParserArtifactObjectStoreV1,
} from './parser-artifact-store.js';

function isMissingObject(error: unknown): boolean {
  const candidate = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate.name === 'NoSuchKey' ||
    candidate.name === 'NotFound' ||
    candidate.name === 'NoSuchBucket' ||
    candidate.$metadata?.httpStatusCode === 404
  );
}

export class AwsParserArtifactObjectStore implements ParserArtifactObjectStoreV1 {
  constructor(private readonly client: S3Client) {}

  async getObject(input: { bucket: string; key: string; versionId?: string }) {
    try {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: input.bucket,
          Key: input.key,
          ...(input.versionId ? { VersionId: input.versionId } : {}),
        }),
      );
      if (!result.Body?.transformToByteArray) return null;
      return {
        bytes: await result.Body.transformToByteArray(),
        ...(result.VersionId ? { versionId: result.VersionId } : {}),
      };
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw error;
    }
  }

  async putObject(input: {
    bucket: string;
    key: string;
    bytes: Uint8Array;
    contentType: string;
  }) {
    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        Body: input.bytes,
        ContentType: input.contentType,
      }),
    );
    return result.VersionId ? { versionId: result.VersionId } : {};
  }
}

export function createS3ParserArtifactStore(input: {
  bucket: string;
  keyPrefix: string;
  clientConfig?: S3ClientConfig;
  requireVersionId?: boolean;
}): { store: S3ParserArtifactStore; dispose: () => void } {
  const client = new S3Client(input.clientConfig ?? {});
  return {
    store: new S3ParserArtifactStore(
      input.bucket,
      input.keyPrefix,
      new AwsParserArtifactObjectStore(client),
      input.requireVersionId ?? true,
    ),
    dispose: () => client.destroy(),
  };
}

export { S3ParserArtifactStore } from './parser-artifact-store.js';
