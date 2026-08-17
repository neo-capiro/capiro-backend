import { isAbsolute, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { BudgetVerificationV1Service } from '../verification/services/budget-verification-v1.service.js';
import { wireProductionProofBoundary } from '../verification/trusted-proof/production-proof-wiring.js';
import { SdkS3ProofClient } from '../verification/trusted-proof/s3-proof-adapters.js';
import {
  CompositeByteLocatorReader,
  FilesystemByteLocatorReader,
  S3ByteLocatorReader,
} from '../verification/trusted-proof/trusted-byte-locator-reader.js';
import {
  FilesystemParserArtifactStore,
  type ParserArtifactStoreV1,
} from './parser-artifact-store.js';
import { MethodRoutingParserArtifactStore } from './method-routing-parser-artifact-store.js';
import { PrismaParserRunRecorder } from './prisma-parser-run-recorder.js';
import { ProofBoundParserRunRecorder } from './proof-bound-parser-run-recorder.js';
import { createS3ParserArtifactStore } from './s3-parser-artifact-store.js';

export interface ProductionParserVerificationContextV1 {
  verificationService: BudgetVerificationV1Service;
  artifactStore: ParserArtifactStoreV1;
  parserRunRecorder: ProofBoundParserRunRecorder;
  dispose(): Promise<void>;
}

/**
 * One persistence context for Phase 3 parser output and Phase 2 verification.
 * Local output uses an explicitly shared absolute filesystem root; paid
 * normalized output uses immutable versioned S3. The same Prisma and proof
 * clients record and later verify the complete parser chain.
 */
export async function createProductionParserVerificationContext(input: {
  parserArtifactRoot: string;
  allowPaidParse: boolean;
}): Promise<ProductionParserVerificationContextV1> {
  const trimmedRoot = input.parserArtifactRoot.trim();
  if (!trimmedRoot) {
    throw new Error('production parser verification requires a shared parser artifact root');
  }
  if (!isAbsolute(trimmedRoot)) {
    throw new Error('BUDGET_VERIFICATION_PARSER_ARTIFACT_ROOT must be an absolute shared path');
  }
  const parserArtifactRoot = resolve(trimmedRoot);
  const llamaOutputBucket = process.env.BUDGET_VERIFICATION_LLAMAPARSE_OUTPUT_BUCKET?.trim() ?? '';
  if (input.allowPaidParse && !llamaOutputBucket) {
    throw new Error('persisted paid parsing requires BUDGET_VERIFICATION_LLAMAPARSE_OUTPUT_BUCKET');
  }

  const prisma = new PrismaClient();
  const s3ProofClient = new SdkS3ProofClient();
  let wired: Awaited<ReturnType<typeof wireProductionProofBoundary>> | undefined;
  let parserStoreDispose: (() => void) | undefined;

  try {
    wired = await wireProductionProofBoundary({
      prisma,
      s3ProofClient,
      approvedFilesystemPrefixes: [parserArtifactRoot],
      parserArtifactStoreRootDir: parserArtifactRoot,
      ...(llamaOutputBucket ? { llamaParseOutputBucket: llamaOutputBucket } : {}),
    });

    const localStore = new FilesystemParserArtifactStore(parserArtifactRoot);
    let artifactStore: ParserArtifactStoreV1 = localStore;
    if (input.allowPaidParse) {
      const endpoint = process.env.BUDGET_VERIFICATION_S3_ENDPOINT?.trim();
      const s3 = createS3ParserArtifactStore({
        bucket: llamaOutputBucket,
        keyPrefix:
          process.env.BUDGET_PARSER_ARTIFACT_S3_PREFIX?.trim() ??
          'derived/public/dod-budget/parser_runs',
        clientConfig: {
          region: process.env.AWS_REGION ?? 'us-east-1',
          ...(endpoint ? { endpoint, forcePathStyle: true } : {}),
        },
        requireVersionId: true,
      });
      parserStoreDispose = s3.dispose;
      artifactStore = new MethodRoutingParserArtifactStore(localStore, {
        llamaparse: s3.store,
      });
    }

    const outputReader = new CompositeByteLocatorReader(
      new FilesystemByteLocatorReader([parserArtifactRoot]),
      new S3ByteLocatorReader(s3ProofClient),
    );
    const parserRunRecorder = new ProofBoundParserRunRecorder(
      new PrismaParserRunRecorder(prisma),
      outputReader,
    );
    let disposed = false;

    return {
      verificationService: new BudgetVerificationV1Service(wired.proofResolver, wired.repository),
      artifactStore,
      parserRunRecorder,
      async dispose() {
        if (disposed) return;
        disposed = true;
        parserStoreDispose?.();
        await wired!.dispose();
        await s3ProofClient.destroy();
        await prisma.$disconnect();
      },
    };
  } catch (error) {
    parserStoreDispose?.();
    if (wired) await wired.dispose().catch(() => undefined);
    await s3ProofClient.destroy().catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
    throw error;
  }
}
