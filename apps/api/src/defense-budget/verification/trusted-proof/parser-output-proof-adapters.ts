/**
 * R8.2/R8.3 — narrow adapters over existing Phase 3 parser infrastructure.
 *
 * Phase 2 only reads immutable parser output and run metadata through these
 * adapters; it never initiates parsing or escalation.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FilesystemParserArtifactStore } from '../../parser-router/parser-artifact-store.js';
import {
  computeParserRunCacheKey,
  parseParserArtifactDescriptorV1,
  parseParserRuntimeResultV1,
  verifyResultContentSha256,
  type ParserArtifactDescriptorV1,
  type ParserRunIdentityV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import { sha256Bytes } from './trusted-byte-locator-reader.js';
import type {
  ParserOutputProofSource,
  ParserOutputProofRequestV1,
  ResolvedParserOutputProof,
} from './parser-output-proof-source.js';
import type { ParseJobClient, ParseJobRow } from './parser-run-proof-resolver.js';
import type { TrustedByteLocatorReader } from './trusted-byte-locator-reader.js';

function collectDescriptorPaths(rootDir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(rootDir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(rootDir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) collectDescriptorPaths(full, out);
    else if (entry === 'metadata.json') out.push(full);
  }
  return out;
}

export interface FilesystemParserOutputProofAdapterOptions {
  requireDeclarationBinding?: boolean;
}

export class FilesystemParserOutputProofAdapter implements ParserOutputProofSource {
  private readonly store: FilesystemParserArtifactStore;

  constructor(
    private readonly storeRootDir: string,
    private readonly options: FilesystemParserOutputProofAdapterOptions = {},
  ) {
    this.store = new FilesystemParserArtifactStore(storeRootDir);
  }

  async resolveParserOutput(
    input: ParserOutputProofRequestV1,
  ): Promise<ResolvedParserOutputProof | null> {
    const descriptor = this.findPersistedRunRecord(input);
    if (!descriptor) return null;
    const result = await this.store.readVerified(descriptor);
    const outputBytes = readFileSync(descriptor.resultLocator);
    const outputByteSha256 = sha256Bytes(outputBytes);

    if (
      this.options.requireDeclarationBinding &&
      input.declaredOutputSha256 !== result.contentSha256
    ) {
      throw new Error(
        `parser-run declaration ${input.declaredOutputSha256} does not match ` +
          `persisted parser output content SHA ${result.contentSha256} ` +
          `(parserRunId=${input.parserRunId})`,
      );
    }

    return {
      persistedRunId: descriptor.parserRunId,
      outputLocator: descriptor.resultLocator,
      outputBytes,
      inputSourceSha256: result.inputSourceSha256,
      parserVersion: result.parserVersion,
      parserConfigSha256: result.parserConfigSha256,
      status: 'succeeded',
      outputContentSha256: result.contentSha256,
      outputByteSha256,
      succeededPages: result.succeededPages,
    };
  }

  private findPersistedRunRecord(
    input: ParserOutputProofRequestV1,
  ): ParserArtifactDescriptorV1 | null {
    for (const descriptorPath of collectDescriptorPaths(this.storeRootDir)) {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(descriptorPath, 'utf8'));
      } catch {
        continue;
      }
      const pre = raw as { parserRunId?: unknown };
      if (pre.parserRunId !== input.parserRunId) continue;

      let descriptor: ParserArtifactDescriptorV1;
      try {
        descriptor = parseParserArtifactDescriptorV1(raw);
      } catch {
        continue;
      }
      if (descriptor.method !== input.method) {
        throw new Error(
          `persisted parser-run record ${input.parserRunId} method mismatch: ` +
            `record says ${descriptor.method}, request says ${input.method}`,
        );
      }

      const identity: ParserRunIdentityV1 = {
        sourceSha256: descriptor.sourceSha256,
        method: descriptor.method,
        parserVersion: descriptor.parserVersion,
        parserConfigSha256: descriptor.parserConfigSha256,
        pages: descriptor.requestedPages,
        runtimeContractVersion: descriptor.runtimeContractVersion,
      };
      if (computeParserRunCacheKey(identity) !== descriptor.cacheKey) return null;
      return descriptor;
    }
    return null;
  }
}

export interface LlamaParseParserOutputProofAdapterOptions {
  parseJobClient: ParseJobClient;
  byteLocatorReader: TrustedByteLocatorReader;
  outputBucket: string;
  requireDeclarationBinding?: boolean;
}

export class LlamaParseParserOutputProofAdapter implements ParserOutputProofSource {
  constructor(private readonly options: LlamaParseParserOutputProofAdapterOptions) {}

  async resolveParserOutput(
    input: ParserOutputProofRequestV1,
  ): Promise<ResolvedParserOutputProof | null> {
    let job: ParseJobRow | null = null;
    if (input.providerJobId) {
      job = await this.options.parseJobClient.documentParseJob.findFirst({
        where: { providerJobId: input.providerJobId, provider: 'llamaparse' },
      });
    }
    if (!job && input.sourceDocumentId) {
      job = await this.options.parseJobClient.documentParseJob.findFirst({
        where: { sourceDocumentId: input.sourceDocumentId, provider: 'llamaparse' },
        orderBy: { startedAt: 'desc' },
      });
    }
    if (!job || job.status !== 'succeeded') return null;

    const outputKey = job.outputJsonS3Key ?? job.outputMarkdownS3Key;
    if (!outputKey) return null;
    const locator = outputKey.includes('://')
      ? outputKey
      : `s3://${this.options.outputBucket}/${outputKey}`;
    const located = await this.options.byteLocatorReader.read(locator);
    const actualOutputByteSha256 = sha256Bytes(located.bytes);

    let normalizedResult;
    try {
      normalizedResult = parseParserRuntimeResultV1(JSON.parse(located.bytes.toString('utf8')));
    } catch (error) {
      throw new Error(
        `persisted LlamaParse output is not a strict normalized parser result ` +
          `(parseJobId=${job.id}): ${(error as Error).message}`,
      );
    }
    if (!verifyResultContentSha256(normalizedResult)) {
      throw new Error(
        `persisted LlamaParse normalized result content SHA does not recompute ` +
          `(parseJobId=${job.id})`,
      );
    }
    if (normalizedResult.engine !== 'llamaparse') {
      throw new Error(
        `persisted LlamaParse normalized result is relabeled as ${normalizedResult.engine} ` +
          `(parseJobId=${job.id})`,
      );
    }

    const metadata =
      typeof job.metadata === 'object' && job.metadata !== null
        ? ((job as unknown as { metadata: Record<string, unknown> }).metadata ?? {})
        : {};
    const recordedNormalizedResultSha256 =
      typeof metadata.normalizedResultSha256 === 'string'
        ? metadata.normalizedResultSha256
        : undefined;
    const recordedOutputByteSha256 =
      typeof metadata.outputByteSha256 === 'string' ? metadata.outputByteSha256 : undefined;

    if (
      recordedOutputByteSha256 !== undefined &&
      recordedOutputByteSha256 !== actualOutputByteSha256
    ) {
      throw new Error(
        `persisted LlamaParse output byte SHA ${actualOutputByteSha256} does not match ` +
          `recorded byte SHA ${recordedOutputByteSha256} (parseJobId=${job.id})`,
      );
    }
    if (
      recordedNormalizedResultSha256 !== undefined &&
      recordedNormalizedResultSha256 !== normalizedResult.contentSha256
    ) {
      throw new Error(
        `persisted LlamaParse normalized result SHA ${normalizedResult.contentSha256} does not match ` +
          `recorded SHA ${recordedNormalizedResultSha256} (parseJobId=${job.id})`,
      );
    }

    if (this.options.requireDeclarationBinding) {
      if (!recordedNormalizedResultSha256) {
        throw new Error(
          `persisted LlamaParse parse job ${job.id} is missing normalizedResultSha256 metadata`,
        );
      }
      if (!recordedOutputByteSha256) {
        throw new Error(
          `persisted LlamaParse parse job ${job.id} is missing outputByteSha256 metadata`,
        );
      }
      if (input.declaredOutputSha256 !== normalizedResult.contentSha256) {
        throw new Error(
          `parser-run declaration ${input.declaredOutputSha256} does not match ` +
            `independently recomputed normalized result SHA ${normalizedResult.contentSha256} ` +
            `(parserRunId=${input.parserRunId})`,
        );
      }
    }

    return {
      persistedRunId: job.id,
      outputLocator: locator,
      outputBytes: located.bytes,
      inputSourceSha256: normalizedResult.inputSourceSha256,
      parserVersion: normalizedResult.parserVersion,
      parserConfigSha256: normalizedResult.parserConfigSha256,
      providerJobId: job.providerJobId ?? undefined,
      status: job.status,
      outputContentSha256: normalizedResult.contentSha256,
      outputByteSha256: actualOutputByteSha256,
      succeededPages: normalizedResult.succeededPages,
    };
  }
}

export interface CompositeParserOutputProofSourceOptions {
  localSource?: ParserOutputProofSource | null;
  llamaParseSource?: ParserOutputProofSource | null;
}

export class CompositeParserOutputProofSource implements ParserOutputProofSource {
  constructor(private readonly options: CompositeParserOutputProofSourceOptions) {}

  async resolveParserOutput(
    input: ParserOutputProofRequestV1,
  ): Promise<ResolvedParserOutputProof | null> {
    if (input.method === 'llamaparse') {
      if (!this.options.llamaParseSource) return null;
      return this.options.llamaParseSource.resolveParserOutput(input);
    }
    if (input.method === 'manual') return null;
    if (!this.options.localSource) return null;
    return this.options.localSource.resolveParserOutput(input);
  }
}
