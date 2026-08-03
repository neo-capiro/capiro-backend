/**
 * defense_budget_parser_artifact_store_v1 — content-addressed parser artifact store.
 *
 * Stores and retrieves parser runtime results with exact SHA verification.
 * Before reuse: read actual bytes, recompute byte SHA, parse strict result
 * schema, recompute result content SHA, compare source/method/version/config
 * SHA, compare requested pages, reject mismatch.
 *
 * A missing recorded SHA makes the artifact unprovable and non-reusable.
 * A corrupted, missing, or unprovable cached output is never reused.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  type ParserRuntimeResultV1,
  type ParserArtifactDescriptorV1,
  type ParserRunIdentityV1,
  computeParserRunCacheKey,
  computeParserRunId,
  pageRangeKey,
  parseParserRuntimeResultV1,
  parseParserArtifactDescriptorV1,
  verifyResultContentSha256,
  DEFENSE_BUDGET_PARSER_JOB_SCHEMA_VERSION,
} from './parser-runtime-contract-v1.js';
import type { ExtractionMethodV1 } from '../contracts/extraction-artifact-v1.js';
import { sha256Hex, sha256CanonicalJson } from '../contracts/canonical-json.js';

/* ------------------------------------------------------------------ */
/* D1. Artifact store interface                                       */
/* ------------------------------------------------------------------ */

export interface ParserArtifactStoreV1 {
  /** Find an existing artifact by identity. Returns null if not found. */
  findExact(identity: ParserRunIdentityV1): Promise<ParserArtifactDescriptorV1 | null>;

  /** Read and fully verify an artifact. Throws on any verification failure. */
  readVerified(descriptor: ParserArtifactDescriptorV1): Promise<ParserRuntimeResultV1>;

  /** Store a verified result and return its descriptor. */
  putVerified(input: {
    identity: ParserRunIdentityV1;
    result: ParserRuntimeResultV1;
    resultJson: string;
  }): Promise<ParserArtifactDescriptorV1>;
}

/* ------------------------------------------------------------------ */
/* D2. Filesystem artifact store                                      */
/* ------------------------------------------------------------------ */

export class FilesystemParserArtifactStore implements ParserArtifactStoreV1 {
  constructor(private readonly rootDir: string) {}

  async findExact(identity: ParserRunIdentityV1): Promise<ParserArtifactDescriptorV1 | null> {
    const cacheKey = computeParserRunCacheKey(identity);
    const descriptorPath = this.descriptorPath(identity);
    if (!existsSync(descriptorPath)) return null;

    try {
      const descriptorRaw = JSON.parse(readFileSync(descriptorPath, 'utf8'));
      const descriptor = parseParserArtifactDescriptorV1(descriptorRaw);

      // Verify the descriptor's cache key matches
      if (descriptor.cacheKey !== cacheKey) return null;

      // Verify the result file exists
      if (!existsSync(descriptor.resultLocator)) return null;

      return descriptor;
    } catch {
      return null;
    }
  }

  async readVerified(descriptor: ParserArtifactDescriptorV1): Promise<ParserRuntimeResultV1> {
    // 1. Read actual bytes
    if (!existsSync(descriptor.resultLocator)) {
      throw new Error(`artifact result file not found: ${descriptor.resultLocator}`);
    }
    const bytes = readFileSync(descriptor.resultLocator, 'utf8');

    // 2. Recompute byte SHA
    const byteSha = sha256Hex(bytes);
    if (byteSha !== descriptor.byteSha256) {
      throw new Error(
        `artifact byte SHA mismatch: expected ${descriptor.byteSha256}, got ${byteSha}`,
      );
    }

    // 3. Parse strict result schema
    const result = parseParserRuntimeResultV1(JSON.parse(bytes));

    // 4. Recompute result content SHA
    if (!verifyResultContentSha256(result)) {
      throw new Error(
        `artifact content SHA mismatch: recorded ${result.contentSha256} does not match recomputed`,
      );
    }

    // 5. Compare source SHA
    if (result.inputSourceSha256 !== descriptor.sourceSha256) {
      throw new Error(
        `artifact source SHA mismatch: descriptor ${descriptor.sourceSha256}, result ${result.inputSourceSha256}`,
      );
    }

    // 6. Compare method/version/config SHA
    if (result.engine !== descriptor.method) {
      throw new Error(
        `artifact method mismatch: descriptor ${descriptor.method}, result ${result.engine}`,
      );
    }
    if (result.parserVersion !== descriptor.parserVersion) {
      throw new Error(
        `artifact parser version mismatch: descriptor ${descriptor.parserVersion}, result ${result.parserVersion}`,
      );
    }
    if (result.parserConfigSha256 !== descriptor.parserConfigSha256) {
      throw new Error(
        `artifact config SHA mismatch: descriptor ${descriptor.parserConfigSha256}, result ${result.parserConfigSha256}`,
      );
    }

    // 7. Compare requested pages
    const descPages = [...descriptor.requestedPages].sort((a, b) => a - b);
    const resultPages = [...result.requestedPages].sort((a, b) => a - b);
    if (
      descPages.length !== resultPages.length ||
      descPages.every((v, i) => v === resultPages[i]) === false
    ) {
      throw new Error(
        `artifact requested pages mismatch: descriptor ${descPages}, result ${resultPages}`,
      );
    }

    return result;
  }

  async putVerified(input: {
    identity: ParserRunIdentityV1;
    result: ParserRuntimeResultV1;
    resultJson: string;
  }): Promise<ParserArtifactDescriptorV1> {
    const cacheKey = computeParserRunCacheKey(input.identity);
    const parserRunId = computeParserRunId(input.identity);
    const dir = this.artifactDir(input.identity);
    mkdirSync(dir, { recursive: true });

    const resultPath = join(dir, 'result.json');
    const descriptorPath = join(dir, 'metadata.json');

    // Write result
    writeFileSync(resultPath, input.resultJson, 'utf8');

    // Compute byte SHA
    const byteSha = sha256Hex(input.resultJson);

    const descriptor: ParserArtifactDescriptorV1 = {
      descriptorVersion: 'parser_artifact_descriptor_v1',
      cacheKey,
      parserRunId,
      sourceSha256: input.identity.sourceSha256,
      method: input.identity.method,
      parserVersion: input.identity.parserVersion,
      parserConfigSha256: input.identity.parserConfigSha256,
      requestedPages: [...input.identity.pages].sort((a, b) => a - b),
      runtimeContractVersion: input.identity.runtimeContractVersion,
      contentSha256: input.result.contentSha256,
      byteSha256: byteSha,
      resultLocator: resultPath,
      createdAt: new Date().toISOString(),
    };

    // Validate descriptor
    parseParserArtifactDescriptorV1(descriptor);

    // Write descriptor
    writeFileSync(descriptorPath, JSON.stringify(descriptor, null, 2), 'utf8');

    return descriptor;
  }

  private artifactDir(identity: ParserRunIdentityV1): string {
    const rangeKey = pageRangeKey([...identity.pages]);
    return join(
      this.rootDir,
      `source_sha256=${identity.sourceSha256}`,
      `method=${identity.method}`,
      `config_sha256=${identity.parserConfigSha256}`,
      `pages=${rangeKey}`,
    );
  }

  private descriptorPath(identity: ParserRunIdentityV1): string {
    return join(this.artifactDir(identity), 'metadata.json');
  }
}

/* ------------------------------------------------------------------ */
/* D3. S3 artifact store (interface only — implementation in later phase) */
/* ------------------------------------------------------------------ */

/**
 * S3-backed artifact store. Uses existing S3 wrappers from s3-aws-commands.ts.
 * Implementation deferred to the production integration phase.
 */
export class S3ParserArtifactStore implements ParserArtifactStoreV1 {
  constructor(
    private readonly bucket: string,
    private readonly keyPrefix: string,
  ) {}

  async findExact(_identity: ParserRunIdentityV1): Promise<ParserArtifactDescriptorV1 | null> {
    throw new Error('S3ParserArtifactStore not implemented in Phase 3 Session 1');
  }

  async readVerified(_descriptor: ParserArtifactDescriptorV1): Promise<ParserRuntimeResultV1> {
    throw new Error('S3ParserArtifactStore not implemented in Phase 3 Session 1');
  }

  async putVerified(_input: {
    identity: ParserRunIdentityV1;
    result: ParserRuntimeResultV1;
    resultJson: string;
  }): Promise<ParserArtifactDescriptorV1> {
    throw new Error('S3ParserArtifactStore not implemented in Phase 3 Session 1');
  }
}

/* ------------------------------------------------------------------ */
/* D4. Parser-run recorder interface                                   */
/* ------------------------------------------------------------------ */

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
  }): Promise<{ parseJobId: string }>;
}

/* ------------------------------------------------------------------ */
/* D5. No-op parser-run recorder (for inspect/local mode)             */
/* ------------------------------------------------------------------ */

export class NoOpParserRunRecorder implements ParserRunRecorderV1 {
  async record(input: {
    method: ExtractionMethodV1;
    inputSha256: string;
    outputLocator: string;
    outputByteSha256: string;
    outputContentSha256: string;
    parserVersion: string;
    parserConfigSha256: string;
    status: string;
  }): Promise<{ parseJobId: string }> {
    return { parseJobId: `noop-${sha256Hex(JSON.stringify(input)).slice(0, 16)}` };
  }
}

/* ------------------------------------------------------------------ */
/* D6. Idempotency helper                                             */
/* ------------------------------------------------------------------ */

/**
 * Check if an artifact already exists and is valid. If so, return it.
 * If not, return null (and the caller should produce and store a new one).
 *
 * A corrupted or unprovable cached output is never reused.
 */
export async function reuseOrCreate(
  store: ParserArtifactStoreV1,
  identity: ParserRunIdentityV1,
  produce: () => Promise<{ result: ParserRuntimeResultV1; resultJson: string }>,
): Promise<{
  result: ParserRuntimeResultV1;
  descriptor: ParserArtifactDescriptorV1;
  reusedArtifact: boolean;
}> {
  // Try to find existing
  const existing = await store.findExact(identity);

  if (existing) {
    try {
      // Fully verify before reuse
      const result = await store.readVerified(existing);
      return { result, descriptor: existing, reusedArtifact: true };
    } catch {
      // Corrupted or unprovable — do not reuse, fall through to produce
    }
  }

  // Produce new
  const { result, resultJson } = await produce();
  const descriptor = await store.putVerified({ identity, result, resultJson });
  return { result, descriptor, reusedArtifact: false };
}
