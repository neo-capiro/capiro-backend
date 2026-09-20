/**
 * Real-wire integration proof for MeriHermesArtifactStorageService.
 *
 * This suite provisions the same disposable MinIO shape used by the
 * phase10b35c rehearsal scripts. It uses the real AWS SDK client and skips
 * cleanly when Docker or the MinIO image is unavailable.
 */
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { get } from 'node:http';
import { MeriHermesArtifactStorageService } from './meri-hermes-artifact-storage.service.js';

// The phase10b35 harness originally used minio/minio; that Docker Hub name is
// no longer anonymously pullable, so use MinIO's upstream Quay mirror.
const MINIO_IMAGE = 'quay.io/minio/minio:latest';
const MINIO_USER = 'meri-hermes-artifact-test';
const MINIO_PASSWORD = 'meri-hermes-artifact-test-password';
const BUCKET = 'meri-hermes-artifact-storage-test';

function commandSucceeds(command: string, args: string[], timeout = 120_000): boolean {
  return spawnSync(command, args, { stdio: 'ignore', timeout }).status === 0;
}

const dockerAvailable = commandSucceeds('docker', ['info'], 10_000);
const minioAvailable =
  dockerAvailable &&
  (commandSucceeds('docker', ['image', 'inspect', MINIO_IMAGE], 10_000) ||
    commandSucceeds('docker', ['pull', MINIO_IMAGE]));
const describeMinio = minioAvailable ? describe : describe.skip;

function docker(args: string[]): string {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 120_000 });
  if (result.status !== 0) {
    throw new Error(`docker ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout.trim();
}

async function waitForMinio(endpoint: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const healthy = await new Promise<boolean>((resolve) => {
      const request = get(`${endpoint}/minio/health/live`, (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      });
      request.on('error', () => resolve(false));
      request.setTimeout(1_000, () => {
        request.destroy();
        resolve(false);
      });
    });
    if (healthy) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Disposable MinIO never became ready');
}

describeMinio('MeriHermesArtifactStorageService — real disposable MinIO', () => {
  jest.setTimeout(2 * 60 * 1000);

  const containerName = `capiro-meri-hermes-artifacts-${randomUUID()}`;
  const originalAwsEnv = {
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
    AWS_PROFILE: process.env.AWS_PROFILE,
    AWS_EC2_METADATA_DISABLED: process.env.AWS_EC2_METADATA_DISABLED,
  };
  let endpoint: string;
  let setupClient: S3Client;
  let storage: MeriHermesArtifactStorageService;

  beforeAll(async () => {
    try {
      docker([
        'run',
        '-d',
        '--name',
        containerName,
        '-e',
        `MINIO_ROOT_USER=${MINIO_USER}`,
        '-e',
        `MINIO_ROOT_PASSWORD=${MINIO_PASSWORD}`,
        '-p',
        '0:9000',
        MINIO_IMAGE,
        'server',
        '/data',
      ]);
      const portOutput = docker(['port', containerName, '9000/tcp']);
      const port = portOutput.split(/\r?\n/, 1)[0]?.match(/:(\d+)$/)?.[1];
      if (!port) throw new Error(`Could not determine disposable MinIO port from: ${portOutput}`);
      endpoint = `http://127.0.0.1:${port}`;
      await waitForMinio(endpoint);

      process.env.AWS_ACCESS_KEY_ID = MINIO_USER;
      process.env.AWS_SECRET_ACCESS_KEY = MINIO_PASSWORD;
      delete process.env.AWS_SESSION_TOKEN;
      delete process.env.AWS_PROFILE;
      process.env.AWS_EC2_METADATA_DISABLED = 'true';

      setupClient = new S3Client({
        endpoint,
        region: 'not-a-valid-aws-region',
        forcePathStyle: true,
        credentials: { accessKeyId: MINIO_USER, secretAccessKey: MINIO_PASSWORD },
      });
      await setupClient.send(new CreateBucketCommand({ Bucket: BUCKET }));

      const values: Record<string, string> = {
        ASSETS_BUCKET: BUCKET,
        AWS_REGION_DEFAULT: 'not-a-valid-aws-region',
        MERI_HERMES_ARTIFACT_S3_ENDPOINT: endpoint,
      };
      storage = new MeriHermesArtifactStorageService({
        get: (key: string) => values[key],
      } as never);
    } catch (error) {
      commandSucceeds('docker', ['rm', '-f', containerName], 30_000);
      throw error;
    }
  });

  afterAll(() => {
    setupClient?.destroy();
    (storage as unknown as { s3?: S3Client }).s3?.destroy();
    commandSucceeds('docker', ['rm', '-f', containerName], 30_000);
    for (const [key, value] of Object.entries(originalAwsEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('putBytes then getBytes returns byte-identical binary content', async () => {
    const bytes = Buffer.from([0x00, 0xff, 0x80, 0x41, 0x00, 0x42, 0xc3, 0x28]);
    const key = `round-trip/${randomUUID()}/artifact.bin`;

    await storage.putBytes(key, bytes, 'application/octet-stream');
    const downloaded = await storage.getBytes(key);

    expect(Buffer.isBuffer(downloaded)).toBe(true);
    expect(downloaded.equals(bytes)).toBe(true);
  });

  test('getBytes rejects when the object does not exist', async () => {
    await expect(storage.getBytes(`missing/${randomUUID()}`)).rejects.toMatchObject({
      name: 'NoSuchKey',
    });
  });
});
