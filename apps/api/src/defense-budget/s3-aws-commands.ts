/**
 * Real @aws-sdk/client-s3 wiring for the RawArchiveService S3Like/S3CommandFactory
 * interfaces. Kept in its own module so the service stays unit-testable with a fake and
 * only the CLI/runtime pulls in the AWS SDK.
 */
import { S3Client, HeadObjectCommand, PutObjectCommand, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import type { S3Like, S3CommandFactory } from './raw-archive.service.js';
import type { CorpusS3 } from './corpus-source.js';

export function makeS3(region: string): S3Like {
  const client = new S3Client({ region });
  return {
    async send(command: unknown) {
      // The AWS SDK command union is wide; the service only sends Head/Put commands.
      return (await client.send(command as never)) as unknown as Record<string, unknown>;
    },
  };
}

/** Real CorpusS3 backed by the AWS SDK — paginated list + object download. */
export function makeCorpusS3(region: string): CorpusS3 {
  const client = new S3Client({ region });
  return {
    async listKeys(bucket, prefix) {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const out = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
        );
        for (const o of out.Contents ?? []) if (o.Key) keys.push(o.Key);
        token = out.IsTruncated ? out.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },
    async getObject(bucket, key) {
      const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const body = out.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
      if (!body?.transformToByteArray) throw new Error(`Empty body for s3://${bucket}/${key}`);
      return body.transformToByteArray();
    },
  };
}

export const awsS3Commands: S3CommandFactory = {
  head: (input) => new HeadObjectCommand(input),
  put: (input) =>
    new PutObjectCommand({
      Bucket: input.Bucket,
      Key: input.Key,
      Body: input.Body,
      ContentType: input.ContentType,
      ChecksumSHA256: input.ChecksumSHA256,
      IfNoneMatch: input.IfNoneMatch,
      ServerSideEncryption: input.ServerSideEncryption as 'aws:kms',
      SSEKMSKeyId: input.SSEKMSKeyId,
      ObjectLockMode: input.ObjectLockMode as 'GOVERNANCE' | undefined,
      ObjectLockRetainUntilDate: input.ObjectLockRetainUntilDate,
    }),
};
