/** Strict, manifest-bound input loader for the congressional durable factory. */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { sha256Bytes } from '../contracts/canonical-json.js';
import { committeeArtifactV1InputSchema } from '../contracts/adapters/committee-artifact-v1.adapter.js';
import { extractionAdapterContextV1Schema } from '../contracts/adapters/adapter-context.js';
import type { Phase5ParserResultProofV1 } from '../non-rdte/non-rdte-proof-bound-artifact-v1.js';
import type { ParserArtifactStoreV1 } from './parser-artifact-store.js';
import {
  buildParserRunIdentityV1,
  PARSER_RUN_RUNTIME_CONTRACT_VERSION_V1,
} from './parser-run-identity-v1.js';
import {
  computeParserRunId,
  parseParserRuntimeResultV1,
  verifyResultContentSha256,
} from './parser-runtime-contract-v1.js';
import { defenseBudgetStageSourceProfileV1Schema } from '../stages/stage-source-profile-v1.js';
import type { CongressionalSemanticFactoryContextV1 } from '../stages/congressional-semantic-artifact-factory-v1.js';
import type { CommitteeArtifactV1Input } from '../contracts/adapters/committee-artifact-v1.adapter.js';
import { stageV1Schema, type StageV1 } from '../stages/stage-vocabulary-v1.js';
import type { SourceFamilyRouting } from './source-family-routing.js';

const sha = z.string().regex(/^[a-f0-9]{64}$/);
const parserBindingSchema = z
  .object({
    sourceSha256: sha,
    method: z.enum(['deterministic_pdfplumber', 'camelot', 'docling', 'paddleocr']),
    parserVersion: z.string().min(1),
    parserConfigSha256: sha,
    requestedPages: z.array(z.number().int().positive()).min(1),
    runtimeContractVersion: z.literal(PARSER_RUN_RUNTIME_CONTRACT_VERSION_V1),
  })
  .strict();
const documentSchema = z
  .object({
    documentKey: z.string().min(1),
    stage: stageV1Schema,
    fiscalYear: z.number().int(),
    declaredUnit: z.enum(['dollars', 'thousands', 'millions']),
    sourcePdfSha256: sha,
    sourceLocator: z.string().min(1),
    packetLocator: z.string().min(1),
    packetByteSha256: sha,
    profile: defenseBudgetStageSourceProfileV1Schema,
    context: extractionAdapterContextV1Schema,
    // The legacy committee adapter emits one parser-run ledger from one
    // adapter context. Multiple proof inputs would be misleading until a
    // native multi-run congressional composer owns that aggregation.
    parserRuns: z.array(parserBindingSchema).length(1),
  })
  .strict();
export const congressionalPacketManifestV1Schema = z
  .object({
    schemaVersion: z.literal('congressional_packet_manifest_v1'),
    documents: z.array(documentSchema).min(1),
  })
  .strict();
export type CongressionalPacketManifestV1 = z.infer<typeof congressionalPacketManifestV1Schema>;

export interface CongressionalPacketRequestV1 {
  documentKey: string;
  sourceDocumentId: string;
  profileId: string;
  stage: StageV1;
  fiscalYear: number;
  sourceSha256: string;
  sourceLocator: string;
  routing: Pick<
    SourceFamilyRouting,
    'family' | 'exhibit' | 'authority' | 'budgetCycle' | 'documentType'
  >;
}

/** Loads immutable packet bytes and exact persisted Phase 3 proofs for one manifest member. */
export async function loadCongressionalFactoryInputsV1(input: {
  manifest: unknown;
  request: CongressionalPacketRequestV1;
  parserArtifactStore: ParserArtifactStoreV1;
  readPacket?: (locator: string) => Promise<Buffer>;
}): Promise<{
  packetBytes: Buffer;
  factoryContext: CongressionalSemanticFactoryContextV1;
  input: CommitteeArtifactV1Input;
  parserResultProofs: readonly Phase5ParserResultProofV1[];
}> {
  const manifest = congressionalPacketManifestV1Schema.parse(input.manifest);
  const matches = manifest.documents.filter((doc) => doc.documentKey === input.request.documentKey);
  if (matches.length !== 1)
    throw new Error(`expected exactly one manifest document ${input.request.documentKey}`);
  const doc = matches[0]!;
  if (
    doc.profile.profileId !== input.request.profileId ||
    doc.stage !== input.request.stage ||
    doc.fiscalYear !== input.request.fiscalYear ||
    doc.profile.stage !== doc.stage
  )
    throw new Error(
      'requested congressional document/profile/stage identity does not match manifest',
    );
  if (doc.profile.fiscalYear !== doc.fiscalYear || doc.context.fiscalYear !== doc.fiscalYear)
    throw new Error('manifest profile/context fiscal year binding mismatch');
  if (
    doc.sourcePdfSha256 !== input.request.sourceSha256 ||
    doc.sourceLocator !== input.request.sourceLocator
  )
    throw new Error('requested congressional source identity does not match manifest');
  if (
    doc.context.family !== input.request.routing.family ||
    doc.context.exhibit !== input.request.routing.exhibit ||
    doc.context.authority !== input.request.routing.authority ||
    doc.context.budgetCycle !== input.request.routing.budgetCycle ||
    doc.context.documentType !== input.request.routing.documentType
  )
    throw new Error('manifest context does not match requested congressional lifecycle routing');
  if (!doc.profile.declaredUnits.includes(doc.declaredUnit))
    throw new Error('manifest unit is not declared by stage profile');
  if (
    !doc.profile.sourceDocumentKeys.includes(doc.documentKey) ||
    doc.context.manifestDocumentKey !== doc.documentKey ||
    (doc.context.sourceDocumentId != null &&
      doc.context.sourceDocumentId !== input.request.sourceDocumentId)
  )
    throw new Error('manifest document is outside its stage profile or context');
  if (
    doc.context.sourcePdfSha256 !== doc.sourcePdfSha256 ||
    doc.context.sourceLocator !== doc.sourceLocator
  )
    throw new Error('manifest source PDF binding mismatch');
  const packetBytes = await (input.readPacket ?? (async (locator) => readFile(locator)))(
    doc.packetLocator,
  );
  if (sha256Bytes(packetBytes) !== doc.packetByteSha256)
    throw new Error('congressional packet byte SHA mismatch');
  let packet: unknown;
  try {
    packet = JSON.parse(packetBytes.toString('utf8'));
  } catch {
    throw new Error('congressional packet is not valid JSON');
  }
  const packetEnvelope = z
    .object({
      schemaVersion: z.literal('congressional_structured_packet_v1'),
      documentKey: z.string().min(1),
      stage: stageV1Schema,
      fiscalYear: z.number().int(),
      declaredUnit: z.enum(['dollars', 'thousands', 'millions']),
      profileId: z.string().min(1),
      sourcePdfSha256: sha,
      artifact: committeeArtifactV1InputSchema,
    })
    .strict()
    .parse(packet);
  if (
    packetEnvelope.documentKey !== doc.documentKey ||
    packetEnvelope.stage !== doc.stage ||
    packetEnvelope.fiscalYear !== doc.fiscalYear ||
    packetEnvelope.declaredUnit !== doc.declaredUnit ||
    packetEnvelope.profileId !== doc.profile.profileId ||
    packetEnvelope.sourcePdfSha256 !== doc.sourcePdfSha256
  )
    throw new Error('congressional packet document/profile/source binding mismatch');
  const structured = packetEnvelope.artifact;
  if (
    structured.fy !== doc.fiscalYear ||
    structured.rows.some((row) => row.fy != null && Number(row.fy) !== doc.fiscalYear)
  )
    throw new Error('congressional packet fiscal year binding mismatch');
  if (structured.rows.some((row) => row.markUnit != null && row.markUnit !== doc.declaredUnit))
    throw new Error('congressional packet declared unit binding mismatch');
  if (
    structured.rows.some(
      (row) =>
        row.page != null &&
        !doc.parserRuns.some(
          (run) =>
            run.sourceSha256 === doc.sourcePdfSha256 && run.requestedPages.includes(row.page!),
        ),
    )
  )
    throw new Error('congressional packet row page is outside persisted parser proof pages');

  const proofs: Phase5ParserResultProofV1[] = [];
  for (const run of doc.parserRuns) {
    if (run.sourceSha256 !== doc.sourcePdfSha256)
      throw new Error('parser proof source SHA does not match manifest source PDF');
    const identity = buildParserRunIdentityV1({ ...run, requestedPages: run.requestedPages });
    const parserRunId = computeParserRunId(identity);
    const descriptor = await input.parserArtifactStore.findExact(identity);
    if (!descriptor || descriptor.parserRunId !== parserRunId)
      throw new Error(`persisted parser proof ${parserRunId} was not found`);
    if (
      descriptor.sourceSha256 !== doc.sourcePdfSha256 ||
      descriptor.method !== run.method ||
      descriptor.parserVersion !== run.parserVersion ||
      descriptor.parserConfigSha256 !== run.parserConfigSha256 ||
      descriptor.requestedPages.length !== run.requestedPages.length ||
      !run.requestedPages.every((page) => descriptor.requestedPages.includes(page))
    )
      throw new Error(
        `persisted parser proof descriptor ${parserRunId} does not match manifest identity`,
      );
    const result = parseParserRuntimeResultV1(
      await input.parserArtifactStore.readVerified(descriptor),
    );
    if (!verifyResultContentSha256(result))
      throw new Error(`persisted parser proof ${parserRunId} has an invalid content SHA`);
    if (
      result.inputSourceSha256 !== doc.sourcePdfSha256 ||
      result.engine !== run.method ||
      result.parserVersion !== run.parserVersion ||
      result.parserConfigSha256 !== run.parserConfigSha256
    )
      throw new Error(`persisted parser proof ${parserRunId} does not match manifest identity`);
    proofs.push({
      parserRunId,
      result,
      resultByteSha256: descriptor.byteSha256,
      resultLocator: descriptor.resultLocator,
    });
  }
  const first = proofs[0]!;
  const result = first.result as import('./parser-runtime-contract-v1.js').ParserRuntimeResultV1;
  const context = extractionAdapterContextV1Schema.parse({
    ...doc.context,
    // SourceDocument IDs are database identities assigned during archive
    // registration. A manifest may pre-pin one for replay, but first-time
    // ingestion binds the freshly registered ID after all immutable source
    // identity checks above have passed.
    sourceDocumentId: input.request.sourceDocumentId,
    parser: {
      method: result.engine,
      parserVersion: result.parserVersion,
      parserConfigSha256: result.parserConfigSha256,
      outputArtifactSha256: result.contentSha256,
      pageRanges: result.requestedPages.map((page) => ({ startPage: page, endPage: page })),
    },
  });
  return {
    packetBytes,
    factoryContext: { profile: doc.profile, context },
    input: structured,
    parserResultProofs: proofs,
  };
}
