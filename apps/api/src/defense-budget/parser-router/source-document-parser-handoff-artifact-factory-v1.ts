import type { BudgetComponentV1, BudgetFamilyV1 } from '../contracts/extraction-artifact-v1.js';
import {
  persistProofBoundCongressionalArtifactV1,
  persistProofBoundHascStageArtifactV1,
} from './congressional-durable-semantic-artifact-factory-v1.js';
import { loadCongressionalFactoryInputsV1 } from './congressional-manifest-packet-provider-v1.js';
import type { ArtifactFactoryV1 } from './rdte-durable-semantic-artifact-factory-v1.js';
import { parseParserRuntimeResultV1 } from './parser-runtime-contract-v1.js';

export type CongressionalFactoryInputsV1 = Awaited<
  ReturnType<typeof loadCongressionalFactoryInputsV1>
>;

/** Selects the validated congressional bundle only for its exact source identity. */
export function resolveSourceDocumentArtifactFactoryV1(input: {
  budgetFamily: BudgetFamilyV1;
  sourceDocumentId: string;
  sourceKey: string;
  sourceSha256: string;
  sourceLocator: string;
  fiscalYear: number;
  component?: BudgetComponentV1;
  congressionalFactoryInputs?: CongressionalFactoryInputsV1;
}): ArtifactFactoryV1 | undefined {
  const bundle = input.congressionalFactoryInputs;
  if (input.budgetFamily !== 'committee') {
    if (bundle)
      throw new Error('congressional factory inputs are only valid for committee documents');
    return undefined;
  }
  if (!bundle)
    throw new Error('committee documents require validated congressional factory inputs');
  const { context } = bundle.factoryContext;
  if (
    context.manifestDocumentKey !== input.sourceKey ||
    context.sourceDocumentId !== input.sourceDocumentId ||
    context.sourcePdfSha256 !== input.sourceSha256 ||
    context.sourceLocator !== input.sourceLocator ||
    context.fiscalYear !== input.fiscalYear ||
    context.component !== (input.component ?? 'UNKNOWN') ||
    bundle.factoryContext.profile.fiscalYear !== input.fiscalYear ||
    !bundle.factoryContext.profile.sourceDocumentKeys.includes(input.sourceKey) ||
    (bundle.packetKind === 'legacy' &&
      (bundle.input == null || bundle.input.fy !== input.fiscalYear)) ||
    (bundle.packetKind === 'stage_composer' &&
      (bundle.factoryContext.profile.stage !== 'hasc' ||
        bundle.factoryContext.profile.authority !== 'hasc_authorization' ||
        bundle.tables == null ||
        bundle.resolutionContext == null)) ||
    bundle.parserResultProofs.length === 0 ||
    bundle.parserResultProofs.some(
      (proof) => parseParserRuntimeResultV1(proof.result).inputSourceSha256 !== input.sourceSha256,
    )
  ) {
    throw new Error('validated congressional factory inputs do not match handoff source identity');
  }
  if (bundle.packetKind === 'stage_composer') {
    return async (_bridgeInput, store) =>
      persistProofBoundHascStageArtifactV1({
        budgetFamily: input.budgetFamily,
        factoryContext: bundle.factoryContext,
        tables: bundle.tables!,
        resolutionContext: bundle.resolutionContext!,
        parserResultProofs: bundle.parserResultProofs,
        store,
      });
  }
  return async (_bridgeInput, store) =>
    persistProofBoundCongressionalArtifactV1({
      budgetFamily: input.budgetFamily,
      factoryContext: bundle.factoryContext,
      input: bundle.input!,
      parserResultProofs: bundle.parserResultProofs,
      store,
    });
}
