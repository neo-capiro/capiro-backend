/** Content-addressed local and S3 parser artifact stores. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFENSE_BUDGET_PARSER_JOB_SCHEMA_VERSION,
  computeParserRunCacheKey,
  computeParserRunId,
  pageRangeKey,
  parseParserArtifactDescriptorV1,
  parseParserRuntimeResultV1,
  verifyResultContentSha256,
  type ParserArtifactDescriptorV1,
  type ParserRunIdentityV1,
  type ParserRuntimeResultV1,
} from './parser-runtime-contract-v1.js';
import type { ExtractionMethodV1 } from '../contracts/extraction-artifact-v1.js';
import { sha256Hex } from '../contracts/canonical-json.js';

export interface ParserArtifactStoreV1 {
  findExact(identity: ParserRunIdentityV1): Promise<ParserArtifactDescriptorV1 | null>;
  readVerified(descriptor: ParserArtifactDescriptorV1): Promise<ParserRuntimeResultV1>;
  putVerified(input: {
    identity: ParserRunIdentityV1;
    result: ParserRuntimeResultV1;
    resultJson: string;
    providerJobId?: string;
  }): Promise<ParserArtifactDescriptorV1>;
}

function samePages(left: readonly number[], right: readonly number[]): boolean {
  const a = [...left].sort((x, y) => x - y);
  const b = [...right].sort((x, y) => x - y);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function verifyResultAgainstDescriptor(
  descriptor: ParserArtifactDescriptorV1,
  resultBytes: string,
): ParserRuntimeResultV1 {
  const byteSha256 = sha256Hex(resultBytes);
  if (byteSha256 !== descriptor.byteSha256) {
    throw new Error(
      `artifact byte SHA mismatch: expected ${descriptor.byteSha256}, got ${byteSha256}`,
    );
  }
  const result = parseParserRuntimeResultV1(JSON.parse(resultBytes));
  if (!verifyResultContentSha256(result))
    throw new Error('artifact content SHA does not recompute');
  if (result.contentSha256 !== descriptor.contentSha256)
    throw new Error('descriptor content SHA mismatch');
  if (result.inputSourceSha256 !== descriptor.sourceSha256)
    throw new Error('artifact source SHA mismatch');
  if (result.engine !== descriptor.method) throw new Error('artifact method mismatch');
  if (result.parserVersion !== descriptor.parserVersion)
    throw new Error('artifact parser version mismatch');
  if (result.parserConfigSha256 !== descriptor.parserConfigSha256) {
    throw new Error('artifact parser config SHA mismatch');
  }
  if (!samePages(descriptor.requestedPages, result.requestedPages)) {
    throw new Error('artifact requested pages mismatch');
  }
  return result;
}

function buildDescriptor(
  identity: ParserRunIdentityV1,
  result: ParserRuntimeResultV1,
  resultJson: string,
  resultLocator: string,
): ParserArtifactDescriptorV1 {
  return parseParserArtifactDescriptorV1({
    descriptorVersion: 'parser_artifact_descriptor_v1',
    cacheKey: computeParserRunCacheKey(identity),
    parserRunId: computeParserRunId(identity),
    sourceSha256: identity.sourceSha256,
    method: identity.method,
    parserVersion: identity.parserVersion,
    parserConfigSha256: identity.parserConfigSha256,
    requestedPages: [...identity.pages].sort((a, b) => a - b),
    runtimeContractVersion: identity.runtimeContractVersion,
    contentSha256: result.contentSha256,
    byteSha256: sha256Hex(resultJson),
    resultLocator,
    createdAt: new Date().toISOString(),
  });
}

export class FilesystemParserArtifactStore implements ParserArtifactStoreV1 {
  constructor(private readonly rootDir: string) {}

  async findExact(identity: ParserRunIdentityV1): Promise<ParserArtifactDescriptorV1 | null> {
    const descriptorPath = this.descriptorPath(identity);
    if (!existsSync(descriptorPath)) return null;
    try {
      const descriptor = parseParserArtifactDescriptorV1(
        JSON.parse(readFileSync(descriptorPath, 'utf8')),
      );
      if (descriptor.cacheKey !== computeParserRunCacheKey(identity)) return null;
      if (!existsSync(descriptor.resultLocator)) return null;
      return descriptor;
    } catch {
      return null;
    }
  }

  async readVerified(descriptor: ParserArtifactDescriptorV1): Promise<ParserRuntimeResultV1> {
    if (!existsSync(descriptor.resultLocator)) {
      throw new Error(`artifact result file not found: ${descriptor.resultLocator}`);
    }
    return verifyResultAgainstDescriptor(
      descriptor,
      readFileSync(descriptor.resultLocator, 'utf8'),
    );
  }

  async putVerified(input: {
    identity: ParserRunIdentityV1;
    result: ParserRuntimeResultV1;
    resultJson: string;
    providerJobId?: string;
  }): Promise<ParserArtifactDescriptorV1> {
    const directory = this.artifactDir(input.identity);
    mkdirSync(directory, { recursive: true });
    const resultPath = join(directory, 'result.json');
    const descriptorPath = join(directory, 'metadata.json');
    writeFileSync(resultPath, input.resultJson, 'utf8');
    const descriptor = buildDescriptor(input.identity, input.result, input.resultJson, resultPath);
    verifyResultAgainstDescriptor(descriptor, input.resultJson);
    writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');
    return descriptor;
  }

  private artifactDir(identity: ParserRunIdentityV1): string {
    return join(
      this.rootDir,
      `source_sha256=${identity.sourceSha256}`,
      `method=${identity.method}`,
      `config_sha256=${identity.parserConfigSha256}`,
      `pages=${pageRangeKey(identity.pages)}`,
    );
  }

  private descriptorPath(identity: ParserRunIdentityV1): string {
    return join(this.artifactDir(identity), 'metadata.json');
  }
}

export interface ParserArtifactObjectStoreV1 {
  getObject(input: {
    bucket: string;
    key: string;
    versionId?: string;
  }): Promise<{ bytes: Uint8Array; versionId?: string } | null>;
  putObject(input: {
    bucket: string;
    key: string;
    bytes: Uint8Array;
    contentType: string;
  }): Promise<{ versionId?: string }>;
}

function parseS3Locator(locator: string): { bucket: string; key: string; versionId?: string } {
  const parsed = new URL(locator);
  if (parsed.protocol !== 's3:' || !parsed.hostname || parsed.pathname.length < 2) {
    throw new Error(`invalid S3 parser artifact locator: ${locator}`);
  }
  const versionId = parsed.searchParams.get('versionId');
  return {
    bucket: parsed.hostname,
    key: parsed.pathname.slice(1),
    ...(versionId ? { versionId } : {}),
  };
}

export function providerJobIdFromArtifactLocator(locator: string): string | undefined {
  if (!locator.startsWith('s3://')) return undefined;
  const value = new URL(locator).searchParams.get('providerJobId');
  return value || undefined;
}

export class S3ParserArtifactStore implements ParserArtifactStoreV1 {
  constructor(
    private readonly bucket: string,
    private readonly keyPrefix: string,
    private readonly objectStore: ParserArtifactObjectStoreV1,
    private readonly requireVersionId = true,
  ) {}

  async findExact(identity: ParserRunIdentityV1): Promise<ParserArtifactDescriptorV1 | null> {
    const object = await this.objectStore.getObject({
      bucket: this.bucket,
      key: this.metadataKey(identity),
    });
    if (!object) return null;
    try {
      const descriptor = parseParserArtifactDescriptorV1(
        JSON.parse(Buffer.from(object.bytes).toString('utf8')),
      );
      if (descriptor.cacheKey !== computeParserRunCacheKey(identity)) return null;
      const locator = parseS3Locator(descriptor.resultLocator);
      if (this.requireVersionId && !locator.versionId) return null;
      return descriptor;
    } catch {
      return null;
    }
  }

  async readVerified(descriptor: ParserArtifactDescriptorV1): Promise<ParserRuntimeResultV1> {
    const locator = parseS3Locator(descriptor.resultLocator);
    if (locator.bucket !== this.bucket) throw new Error('parser artifact bucket mismatch');
    if (this.requireVersionId && !locator.versionId) {
      throw new Error('parser artifact locator is missing immutable S3 VersionId');
    }
    const object = await this.objectStore.getObject(locator);
    if (!object) throw new Error(`parser artifact missing: ${descriptor.resultLocator}`);
    if (locator.versionId && object.versionId && locator.versionId !== object.versionId) {
      throw new Error('parser artifact VersionId mismatch');
    }
    return verifyResultAgainstDescriptor(descriptor, Buffer.from(object.bytes).toString('utf8'));
  }

  async putVerified(input: {
    identity: ParserRunIdentityV1;
    result: ParserRuntimeResultV1;
    resultJson: string;
    providerJobId?: string;
  }): Promise<ParserArtifactDescriptorV1> {
    const resultKey = this.resultKey(input.identity);
    const write = await this.objectStore.putObject({
      bucket: this.bucket,
      key: resultKey,
      bytes: Buffer.from(input.resultJson, 'utf8'),
      contentType: 'application/json',
    });
    if (this.requireVersionId && !write.versionId) {
      throw new Error(
        'S3 parser artifact write did not return VersionId; bucket versioning is required',
      );
    }
    const query = new URLSearchParams();
    if (write.versionId) query.set('versionId', write.versionId);
    if (input.providerJobId) query.set('providerJobId', input.providerJobId);
    const resultLocator = `s3://${this.bucket}/${resultKey}${
      query.size > 0 ? `?${query.toString()}` : ''
    }`;
    const descriptor = buildDescriptor(
      input.identity,
      input.result,
      input.resultJson,
      resultLocator,
    );
    verifyResultAgainstDescriptor(descriptor, input.resultJson);
    await this.objectStore.putObject({
      bucket: this.bucket,
      key: this.metadataKey(input.identity),
      bytes: Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`, 'utf8'),
      contentType: 'application/json',
    });
    return descriptor;
  }

  private baseKey(identity: ParserRunIdentityV1): string {
    return [
      this.keyPrefix.replace(/^\/+|\/+$/g, ''),
      `source_sha256=${identity.sourceSha256}`,
      `method=${identity.method}`,
      `config_sha256=${identity.parserConfigSha256}`,
      `pages=${pageRangeKey(identity.pages)}`,
    ]
      .filter(Boolean)
      .join('/');
  }

  private resultKey(identity: ParserRunIdentityV1): string {
    return `${this.baseKey(identity)}/result.json`;
  }

  private metadataKey(identity: ParserRunIdentityV1): string {
    return `${this.baseKey(identity)}/metadata.json`;
  }
}

export interface ParserRunRecorderV1 {
  record(input: {
    sourceDocumentId?: string;
    method: ExtractionMethodV1;
    providerJobId?: string;
    mode?: string;
    pageStart?: number;
    pageEnd?: number;
    exactPageList?: number[];
    inputSha256: string;
    outputLocator: string;
    outputByteSha256: string;
    outputContentSha256: string;
    parserVersion: string;
    parserConfigSha256: string;
    status: 'running' | 'completed' | 'failed';
    error?: string;
    metrics?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): Promise<{ parseJobId: string }>;
}

export class NoOpParserRunRecorder implements ParserRunRecorderV1 {
  async record(input: Parameters<ParserRunRecorderV1['record']>[0]) {
    return { parseJobId: `noop-${sha256Hex(JSON.stringify(input)).slice(0, 16)}` };
  }
}

export async function reuseOrCreate(
  store: ParserArtifactStoreV1,
  identity: ParserRunIdentityV1,
  produce: () => Promise<{
    result: ParserRuntimeResultV1;
    resultJson: string;
    providerJobId?: string;
  }>,
): Promise<{
  result: ParserRuntimeResultV1;
  descriptor: ParserArtifactDescriptorV1;
  reusedArtifact: boolean;
}> {
  const existing = await store.findExact(identity);
  if (existing) {
    try {
      return {
        result: await store.readVerified(existing),
        descriptor: existing,
        reusedArtifact: true,
      };
    } catch {
      // Corrupt or unprovable cache is never reused.
    }
  }
  const produced = await produce();
  const descriptor = await store.putVerified({ identity, ...produced });
  return { result: produced.result, descriptor, reusedArtifact: false };
}

export { DEFENSE_BUDGET_PARSER_JOB_SCHEMA_VERSION };
