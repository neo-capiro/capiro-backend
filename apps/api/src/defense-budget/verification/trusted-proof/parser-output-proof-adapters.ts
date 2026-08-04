/**
 * R8.2 Workstream C — narrow adapters over existing Phase 3 parser
 * infrastructure. Phase 2 only READS immutable parser output and run
 * metadata through these adapters; it never initiates parsing or
 * escalation.
 *
 *   - `FilesystemParserOutputProofAdapter` reuses the content-addressed
 *     `FilesystemParserArtifactStore` (findExact + readVerified) to load and
 *     independently verify persisted local parser output;
 *   - `LlamaParseParserOutputProofAdapter` loads the exact persisted parse
 *     job and then fetches + hashes the persisted output object through the
 *     trusted byte locator reader — a row with an output key is not itself
 *     output proof;
 *   - `CompositeParserOutputProofSource` routes by method.
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
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      collectDescriptorPaths(full, out);
    } else if (entry === 'metadata.json') {
      out.push(full);
    }
  }
  return out;
}

/**
 * Loads independently persisted local parser output from the Phase 3
 * content-addressed filesystem artifact store.
 *
 * Step 1 (load the persisted parser-run record): scan the store for the
 * descriptor whose `parserRunId` matches, verify its recorded cache key
 * re-derives from its own identity fields (tampered records are rejected).
 * Step 2 (load and verify the content-addressed output bytes): delegate to
 * `FilesystemParserArtifactStore.readVerified` — byte SHA, strict contract
 * parse, content SHA, source/method/version/config/page agreement.
 *
 * Returns `null` when no persisted output exists (legacy). Throws when a
 * persisted output fails independent verification — the resolver converts
 * that into `mismatch`.
 */
export class FilesystemParserOutputProofAdapter implements ParserOutputProofSource {
  private readonly store: FilesystemParserArtifactStore;

  constructor(private readonly storeRootDir: string) {
    this.store = new FilesystemParserArtifactStore(storeRootDir);
  }

  async resolveParserOutput(
    input: ParserOutputProofRequestV1,
  ): Promise<ResolvedParserOutputProof | null> {
    const descriptor = this.findPersistedRunRecord(input);
    if (!descriptor) return null;

    // Independent byte-level verification (byte SHA, strict contract parse,
    // content SHA, source/method/version/config/page agreement). Throws on
    // any mismatch — the resolver converts that into `mismatch`.
    const result = await this.store.readVerified(descriptor);

    // Load the raw output bytes for the proof record.
    const outputBytes = readFileSync(descriptor.resultLocator);

    return {
      persistedRunId: descriptor.parserRunId,
      outputLocator: descriptor.resultLocator,
      outputBytes,
      inputSourceSha256: result.inputSourceSha256,
      parserVersion: result.parserVersion,
      parserConfigSha256: result.parserConfigSha256,
      status: 'succeeded',
      outputContentSha256: result.contentSha256,
      outputByteSha256: sha256Bytes(outputBytes),
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
      // Cheap pre-filter before strict parsing.
      const pre = raw as { parserRunId?: unknown };
      if (pre.parserRunId !== input.parserRunId) continue;

      let descriptor: ParserArtifactDescriptorV1;
      try {
        // Strict schema validation — unknown or tampered fields fail closed.
        descriptor = parseParserArtifactDescriptorV1(raw);
      } catch {
        continue;
      }
      if (descriptor.method !== input.method) {
        // A descriptor claiming the same run ID for a different method is a
        // tampering indicator — fail closed.
        throw new Error(
          `persisted parser-run record ${input.parserRunId} method mismatch: record says ${descriptor.method}, request says ${input.method}`,
        );
      }

      // Verify the record's cache key re-derives from its own identity
      // fields — a tampered record (edited identity without re-hashing) is
      // rejected as missing rather than trusted.
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
  /** Client over the persisted document_parse_job rows. */
  parseJobClient: ParseJobClient;
  /** Reader for the persisted output locator (S3 or filesystem). */
  byteLocatorReader: TrustedByteLocatorReader;
  /** Bucket holding the persisted LlamaParse output objects. */
  outputBucket: string;
}

/**
 * Loads the persisted LlamaParse output object bytes for a parse job.
 * A database row containing an output key is not itself output proof — this
 * adapter fetches and hashes the actual object.
 */
export class LlamaParseParserOutputProofAdapter implements ParserOutputProofSource {
  constructor(private readonly options: LlamaParseParserOutputProofAdapterOptions) {}

  async resolveParserOutput(
    input: ParserOutputProofRequestV1,
  ): Promise<ResolvedParserOutputProof | null> {
    // Load the exact persisted parse job.
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
    if (!job) return null;

    // Require terminal success before treating the output as proof.
    if (job.status !== 'succeeded') {
      return null;
    }

    const outputKey = job.outputJsonS3Key ?? job.outputMarkdownS3Key;
    if (!outputKey) return null;

    // Resolve the persisted locator. Support both full s3:// locators and
    // bare keys inside the configured output bucket.
    const locator = outputKey.includes('://')
      ? outputKey
      : `s3://${this.options.outputBucket}/${outputKey}`;

    const located = await this.options.byteLocatorReader.read(locator);

    // Version metadata recorded on the job (when present).
    const metadata =
      typeof job.metadata === 'object' && job.metadata !== null
        ? ((job as unknown as { metadata: Record<string, unknown> }).metadata ?? {})
        : {};

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
      outputByteSha256: sha256Bytes(located.bytes),
      succeededPages:
        job.pageStart !== null && job.pageEnd !== null
          ? Array.from(
              { length: job.pageEnd - job.pageStart + 1 },
              (_, i) => (job.pageStart as number) + i,
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

/**
 * Routes parser-output proof requests by extraction method. `manual` runs
 * never load output bytes (they carry a mandatory review trigger instead).
 */
export class CompositeParserOutputProofSource implements ParserOutputProofSource {
  constructor(private readonly options: CompositeParserOutputProofSourceOptions) {}

  async resolveParserOutput(
    input: ParserOutputProofRequestV1,
  ): Promise<ResolvedParserOutputProof | null> {
    if (input.method === 'llamaparse') {
      if (!this.options.llamaParseSource) return null;
      return this.options.llamaParseSource.resolveParserOutput(input);
    }
    if (input.method === 'manual') {
      return null;
    }
    if (!this.options.localSource) return null;
    return this.options.localSource.resolveParserOutput(input);
  }
}
