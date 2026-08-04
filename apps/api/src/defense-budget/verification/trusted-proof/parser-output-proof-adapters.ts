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

/* ------------------------------------------------------------------ */
/* Filesystem adapter — local parsers                                  */
/* ------------------------------------------------------------------ */

/** Recursively collect all metadata.json descriptor paths under a root. */
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
    if (stat.isDirectory()) {
      collectDescriptorPaths(full, out);
    } else if (entry === 'metadata.json') {
      out.push(full);
    }
  }
  return out;
}

export interface FilesystemParserOutputProofAdapterOptions {
  /**
   * Production trust boundary: require the parser-run declaration to name the
   * exact canonical content SHA of the independently loaded parser result.
   * Local compatibility tests may leave this false.
   */
  requireDeclarationBinding?: boolean;
}

/**
 * Loads independently persisted local parser output from the Phase 3
 * content-addressed filesystem artifact store.
 */
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

    // Independently verifies bytes, strict result contract, canonical content
    // SHA, source/method/version/config, and requested pages.
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

  /** Load the persisted parser-run record (descriptor) for a parser run ID. */
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
      if (computeParserRunCacheKey(identity) !== descriptor.cacheKey) {
        return null;
      }
      return descriptor;
    }
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* LlamaParse adapter — persisted parse job + persisted output object  */
/* ------------------------------------------------------------------ */

export interface LlamaParseParserOutputProofAdapterOptions {
  parseJobClient: ParseJobClient;
  byteLocatorReader: TrustedByteLocatorReader;
  outputBucket: string;
  /** Require exact declared normalized-result and raw-byte SHA bindings. */
  requireDeclarationBinding?: boolean;
}

/**
 * Loads the persisted LlamaParse output object bytes for a parse job. A row
 * containing an output key is not itself output proof.
 */
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

    const metadata =
      typeof job.metadata === 'object' && job.metadata !== null
        ? ((job as unknown as { metadata: Record<string, unknown> }).metadata ?? {})
        : {};
    const normalizedResultSha256 =
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

    if (this.options.requireDeclarationBinding) {
      if (!normalizedResultSha256) {
        throw new Error(
          `persisted LlamaParse parse job ${job.id} is missing normalizedResultSha256 metadata`,
        );
      }
      if (!recordedOutputByteSha256) {
        throw new Error(
          `persisted LlamaParse parse job ${job.id} is missing outputByteSha256 metadata`,
        );
      }
      if (input.declaredOutputSha256 !== normalizedResultSha256) {
        throw new Error(
          `parser-run declaration ${input.declaredOutputSha256} does not match ` +
            `persisted normalized result SHA ${normalizedResultSha256} ` +
            `(parserRunId=${input.parserRunId})`,
        );
      }
    }

    return {
      persistedRunId: job.id,
      outputLocator: locator,
      outputBytes: located.bytes,
      inputSourceSha256: job.inputSha256,
      parserVersion: typeof metadata.parserVersion === 'string' ? metadata.parserVersion : '',
      parserConfigSha256:
        typeof metadata.parserConfigSha256 === 'string' ? metadata.parserConfigSha256 : '',
      providerJobId: job.providerJobId ?? undefined,
      status: job.status,
      outputContentSha256: normalizedResultSha256,
      outputByteSha256: actualOutputByteSha256,
      succeededPages:
        job.pageStart !== null && job.pageEnd !== null
          ? Array.from(
              { length: job.pageEnd - job.pageStart + 1 },
              (_, index) => (job.pageStart as number) + index,
            )
          : undefined,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Composite source — routes by method                                 */
/* ------------------------------------------------------------------ */

export interface CompositeParserOutputProofSourceOptions {
  localSource?: ParserOutputProofSource | null;
  llamaParseSource?: ParserOutputProofSource | null;
}

/** Routes parser-output proof requests by extraction method. */
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
