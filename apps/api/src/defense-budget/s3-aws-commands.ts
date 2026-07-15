/**
 * Real @aws-sdk/client-s3 wiring for the RawArchiveService S3Like/S3CommandFactory
 * interfaces. Kept in its own module so the service stays unit-testable with a fake and
 * only the CLI/runtime pulls in the AWS SDK.
 */
import { S3Client, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { S3Like, S3CommandFactory } from './raw-archive.service.js';

export function makeS3(region: string): S3Like {
  const client = new S3Client({ region });
  return {
    async send(command: unknown) {
      // The AWS SDK command union is wide; the service only sends Head/Put commands.
      return (await client.send(command as never)) as unknown as Record<string, unknown>;
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
