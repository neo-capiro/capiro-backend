/** Durable persistence wrappers for the bounded Package 3 congressional seams. */
import type { BudgetFamilyV1 } from '../contracts/extraction-artifact-v1.js';
import { sha256Bytes } from '../contracts/canonical-json.js';
import type { Phase5ParserResultProofV1 } from '../non-rdte/non-rdte-proof-bound-artifact-v1.js';
import { assertPhase5ArtifactProofBound } from '../non-rdte/non-rdte-proof-bound-artifact-v1.js';
import {
  resolveCongressionalSemanticArtifactFactoryV1,
  type CongressionalSemanticFactoryContextV1,
} from '../stages/congressional-semantic-artifact-factory-v1.js';
import type { ExtractionArtifactBridgeOutput } from './extraction-artifact-bridge.js';
import type { ExtractionArtifactStoreV1 } from './extraction-artifact-store.js';
import type { CommitteeArtifactV1Input } from '../contracts/adapters/committee-artifact-v1.adapter.js';
import { composeHascStageV1 } from '../stages/authorization/hasc-composer-v1.js';
import type { CongressionalTableV1 } from '../stages/congressional-table-v1.js';
import type { LineReferenceResolutionContext } from '../stages/line-reference-resolver.js';
import { sourceFromContext } from '../contracts/adapters/adapter-context.js';
import type { ParserRunV1 } from '../contracts/extraction-artifact-v1.js';
import { parseParserRuntimeResultV1 } from './parser-runtime-contract-v1.js';

/**
 * Persist one legacy structured artifact after profile and persisted
 * parser-proof checks. Native mixed-family stage packets use the separate
 * HASC composer below and never enter this RDTE-only adapter.
 */
export async function persistProofBoundCongressionalArtifactV1(input: {
  budgetFamily: BudgetFamilyV1 | string;
  factoryContext: CongressionalSemanticFactoryContextV1;
  input: CommitteeArtifactV1Input;
  parserResultProofs: readonly Phase5ParserResultProofV1[];
  store: ExtractionArtifactStoreV1;
}): Promise<ExtractionArtifactBridgeOutput> {
  const factory = resolveCongressionalSemanticArtifactFactoryV1(
    input.budgetFamily,
    input.factoryContext,
  );
  if (factory == null) {
    throw new Error(
      `no congressional semantic factory is defined for budget family ${input.budgetFamily}`,
    );
  }
  const artifact = factory(input.input, input.parserResultProofs);
  const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  const expectedByteSha256 = sha256Bytes(bytes);
  const persisted = await input.store.putImmutable({ bytes });
  if (persisted.byteSha256 !== expectedByteSha256) {
    throw new Error(
      `congressional semantic artifact byte SHA changed across durable persistence: ` +
        `expected ${expectedByteSha256}, store computed ${persisted.byteSha256}`,
    );
  }

  return {
    artifact,
    artifactId: artifact.artifactId,
    artifactContentSha256: artifact.contentSha256,
    artifactByteSha256: persisted.byteSha256,
    artifactLocator: persisted.locator,
    parserRuns: artifact.parserRuns,
    sourceFactCount: artifact.sourceFacts.length,
    assertionCount: artifact.assertions.length,
    evidenceCount: artifact.evidence.length,
    warningCount: artifact.warnings.length,
  };
}

/**
 * Persist one native HASC stage composition after the packet provider has
 * bound its tables and native identity index to the exact source and parser
 * proof. This is intentionally a separate seam from the legacy committee
 * adapter: mixed-family rows must never be routed through the RDTE-only
 * adapter or manufacture request ownership.
 */
export async function persistProofBoundHascStageArtifactV1(input: {
  budgetFamily: BudgetFamilyV1 | string;
  factoryContext: CongressionalSemanticFactoryContextV1;
  tables: readonly CongressionalTableV1[];
  resolutionContext: LineReferenceResolutionContext;
  parserResultProofs: readonly Phase5ParserResultProofV1[];
  store: ExtractionArtifactStoreV1;
}): Promise<ExtractionArtifactBridgeOutput> {
  if (input.budgetFamily !== 'committee')
    throw new Error('native HASC stage packets require budget family committee');
  const { profile, context } = input.factoryContext;
  if (profile.stage !== 'hasc' || profile.authority !== 'hasc_authorization')
    throw new Error('native HASC stage packets require a HASC authorization profile');
  if (context.family !== 'committee' || context.authority !== 'hasc')
    throw new Error('native HASC stage packets require HASC committee source context');
  if (input.resolutionContext.profileId !== profile.profileId)
    throw new Error('native HASC resolution context profile mismatch');
  if (input.resolutionContext.fiscalYear !== profile.fiscalYear)
    throw new Error('native HASC resolution context fiscal-year mismatch');
  if (input.parserResultProofs.length !== 1)
    throw new Error('native HASC stage packet requires exactly one persisted parser proof');

  const proof = input.parserResultProofs[0]!;
  const result = parseParserRuntimeResultV1(proof.result);
  const selectedPages = [...new Set(input.tables.map((table) => table.page))].sort((a, b) => a - b);
  if (selectedPages.some((page) => !result.succeededPages.includes(page)))
    throw new Error('native HASC table page is not covered by a successful parser proof page');
  const parserRun: ParserRunV1 = {
    parserRunId: proof.parserRunId,
    method: result.engine,
    parserVersion: result.parserVersion,
    parserConfigSha256: result.parserConfigSha256,
    inputSourceSha256: result.inputSourceSha256,
    outputArtifactSha256: result.contentSha256,
    pageRanges: selectedPages.map((page) => ({ startPage: page, endPage: page })),
    requestedPages: result.requestedPages,
    succeededPages: result.succeededPages,
    failedPages: result.failedPages,
  };
  const composed = composeHascStageV1({
    profile,
    source: sourceFromContext(context),
    parserRuns: [parserRun],
    tables: input.tables,
    resolutionContext: input.resolutionContext,
  });
  assertPhase5ArtifactProofBound({
    artifact: composed.artifact,
    parserResultProofs: input.parserResultProofs,
    requireResultByteSha256: true,
  });
  const bytes = Buffer.from(`${JSON.stringify(composed.artifact, null, 2)}\n`, 'utf8');
  const expectedByteSha256 = sha256Bytes(bytes);
  const persisted = await input.store.putImmutable({ bytes });
  if (persisted.byteSha256 !== expectedByteSha256) {
    throw new Error(
      `HASC stage artifact byte SHA changed across durable persistence: ` +
        `expected ${expectedByteSha256}, store computed ${persisted.byteSha256}`,
    );
  }
  const artifact = composed.artifact;
  return {
    artifact,
    artifactId: artifact.artifactId,
    artifactContentSha256: artifact.contentSha256,
    artifactByteSha256: persisted.byteSha256,
    artifactLocator: persisted.locator,
    parserRuns: artifact.parserRuns,
    sourceFactCount: artifact.sourceFacts.length,
    assertionCount: artifact.assertions.length,
    evidenceCount: artifact.evidence.length,
    warningCount: artifact.warnings.length,
  };
}
