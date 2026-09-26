/**
 * Narrow Package 3 seam for legacy, structured congressional artifacts.
 *
 * This deliberately does not parse PDF pages or claim production eligibility.
 * Callers must supply a governed row artifact, its reviewed stage profile,
 * exact extraction context, and persisted Phase 3 parser proofs. The legacy
 * adapter is only safe here for an RDTE-only profile with no reprinted request
 * values; newer mixed-family congressional tables belong to the stage
 * composers, where request baselines remain non-owning facts.
 */
import type {
  BudgetFamilyV1,
  DefenseBudgetExtractionArtifactV1,
} from '../contracts/extraction-artifact-v1.js';
import { defenseBudgetExtractionArtifactV1Schema } from '../contracts/extraction-artifact-v1.js';
import {
  adaptCommitteeArtifactToArtifactV1,
  COMMITTEE_MODE_AUTHORITY,
  type CommitteeAdapterMode,
  type CommitteeArtifactV1Input,
} from '../contracts/adapters/committee-artifact-v1.adapter.js';
import type { ExtractionAdapterContextV1 } from '../contracts/adapters/adapter-context.js';
import {
  computeArtifactContentSha256,
  validateDefenseBudgetExtractionArtifactV1,
} from '../contracts/extraction-artifact-v1.semantic.js';
import {
  assertPhase5ArtifactProofBound,
  type Phase5ParserResultProofV1,
} from '../non-rdte/non-rdte-proof-bound-artifact-v1.js';
import {
  parseStageSourceProfileV1,
  type DefenseBudgetStageSourceProfileV1,
} from './stage-source-profile-v1.js';
import type { StageV1 } from './stage-vocabulary-v1.js';
import { parseParserRuntimeResultV1 } from '../parser-router/parser-runtime-contract-v1.js';
import { parserRunIdV1 } from '../parser-router/parser-run-identity-v1.js';

/** Exhaustive stage mapping; unsupported stages are explicit nulls. */
export const CONGRESSIONAL_STAGE_ADAPTER_MODE_V1: Record<StageV1, CommitteeAdapterMode | null> = {
  hasc: 'HASC',
  sasc: 'SASC',
  ndaa_conference: 'NDAA_CONFERENCE',
  hac_d: 'HAC-D',
  sac_d: 'SAC-D',
  appropriations_conference: 'APPROPRIATIONS_CONFERENCE',
  // Publication needs the separate statutory/incorporation proof, which the
  // legacy committee adapter contract does not accept.
  public_law: null,
  continuing_resolution: null,
  reprogramming: null,
  execution: null,
};

export class CongressionalSemanticFactoryErrorV1 extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'CongressionalSemanticFactoryErrorV1';
  }
}

export interface CongressionalSemanticFactoryContextV1 {
  profile: DefenseBudgetStageSourceProfileV1;
  context: ExtractionAdapterContextV1;
}

export type CongressionalSemanticArtifactFactoryV1 = (
  input: CommitteeArtifactV1Input,
  parserResultProofs: readonly Phase5ParserResultProofV1[],
) => DefenseBudgetExtractionArtifactV1;

function fail(message: string, code: string): never {
  throw new CongressionalSemanticFactoryErrorV1(message, code);
}

/**
 * The committee adapter predates Phase 3's parser-run identity contract and
 * creates `prun_*` IDs. Rebind its exact run ledger and evidence references to
 * IDs recomputed from the supplied persisted results before Phase 5 proof
 * validation; no parser data or page coverage is synthesized here.
 */
function bindParserRunsToPersistedProofsV1(
  artifact: DefenseBudgetExtractionArtifactV1,
  proofs: readonly Phase5ParserResultProofV1[],
): DefenseBudgetExtractionArtifactV1 {
  const parsedProofs = proofs.map((proof) => {
    let result;
    try {
      result = parseParserRuntimeResultV1(proof.result);
    } catch (cause) {
      return fail(
        `invalid persisted parser result: ${(cause as Error).message}`,
        'parser_result_invalid',
      );
    }
    const expectedId = parserRunIdV1({
      sourceSha256: result.inputSourceSha256,
      method: result.engine,
      parserVersion: result.parserVersion,
      parserConfigSha256: result.parserConfigSha256,
      requestedPages: result.requestedPages,
    });
    if (proof.parserRunId !== expectedId) {
      return fail(
        `persisted parser-result proof ID ${proof.parserRunId} does not match ${expectedId}`,
        'parser_result_id_mismatch',
      );
    }
    return { proof, result, expectedId };
  });
  const oldToNew = new Map<string, string>();
  const parserRuns = artifact.parserRuns.map((run) => {
    const candidates = parsedProofs.filter(
      ({ result }) =>
        result.inputSourceSha256 === run.inputSourceSha256 &&
        result.engine === run.method &&
        result.parserVersion === run.parserVersion &&
        result.parserConfigSha256 === run.parserConfigSha256 &&
        result.contentSha256 === run.outputArtifactSha256,
    );
    if (candidates.length !== 1) {
      return fail(
        `committee parser run ${run.parserRunId} has ${candidates.length} matching persisted results`,
        candidates.length === 0 ? 'parser_result_proof_missing' : 'parser_result_proof_ambiguous',
      );
    }
    const nextId = candidates[0]!.expectedId;
    const result = candidates[0]!.result;
    oldToNew.set(run.parserRunId, nextId);
    return {
      ...run,
      parserRunId: nextId,
      requestedPages: result.requestedPages,
      succeededPages: result.succeededPages,
      failedPages: result.failedPages.map(({ page, code, message }) => ({ page, code, message })),
    };
  });
  const rebound = {
    ...artifact,
    parserRuns,
    evidence: artifact.evidence.map((evidence) => ({
      ...evidence,
      parserRunId: oldToNew.get(evidence.parserRunId) ?? evidence.parserRunId,
    })),
  };
  const contentSha256 = computeArtifactContentSha256(rebound);
  return defenseBudgetExtractionArtifactV1Schema.parse({
    ...rebound,
    contentSha256,
    artifactId: `dbx1_${contentSha256}`,
  });
}

function validateFactoryContext(input: CongressionalSemanticFactoryContextV1): {
  profile: DefenseBudgetStageSourceProfileV1;
  mode: CommitteeAdapterMode;
} {
  let profile: DefenseBudgetStageSourceProfileV1;
  try {
    profile = parseStageSourceProfileV1(input.profile);
  } catch (cause) {
    return fail(
      `invalid congressional stage profile: ${(cause as Error).message}`,
      'stage_profile_invalid',
    );
  }
  const mode = CONGRESSIONAL_STAGE_ADAPTER_MODE_V1[profile.stage];
  if (mode == null) {
    return fail(`stage ${profile.stage} has no legacy committee adapter mode`, 'stage_unsupported');
  }
  // The existing adapter produces only RDT&E PE semantics. Do not let its
  // output stand in for the mixed-family coverage required by live profiles.
  if (profile.requiredLineFamilies.length !== 1 || profile.requiredLineFamilies[0] !== 'rdte_pe') {
    return fail(
      'legacy committee adapter is limited to RDTE-only stage profiles',
      'line_family_unsupported',
    );
  }
  const context = input.context;
  if (!profile.sourceDocumentKeys.includes(context.manifestDocumentKey)) {
    return fail(
      'adapter context document is outside the reviewed stage profile',
      'source_document_mismatch',
    );
  }
  if (context.fiscalYear !== profile.fiscalYear) {
    return fail(
      'adapter context fiscal year differs from the reviewed stage profile',
      'fiscal_year_mismatch',
    );
  }
  if (context.authority !== COMMITTEE_MODE_AUTHORITY[mode]) {
    return fail(
      `stage ${profile.stage} requires adapter authority ${COMMITTEE_MODE_AUTHORITY[mode]}`,
      'authority_mismatch',
    );
  }
  const publicLaw = mode === 'PUBLIC_LAW';
  if (context.family !== (publicLaw ? 'public_law' : 'committee')) {
    return fail(
      `stage ${profile.stage} requires family ${publicLaw ? 'public_law' : 'committee'}`,
      'family_mismatch',
    );
  }
  const expectedExhibit = publicLaw
    ? 'public_law'
    : mode === 'NDAA_CONFERENCE' || mode === 'APPROPRIATIONS_CONFERENCE'
      ? 'conference_report'
      : 'committee_report';
  if (context.exhibit !== expectedExhibit) {
    return fail(`stage ${profile.stage} requires exhibit ${expectedExhibit}`, 'exhibit_mismatch');
  }
  return { profile, mode };
}

/**
 * Create a scoped factory only for the bounded legacy-compatible profile.
 * Unrelated budget families resolve to `undefined`; committee/public-law
 * inputs that do not meet every gate throw a typed error.
 */
export function resolveCongressionalSemanticArtifactFactoryV1(
  budgetFamily: BudgetFamilyV1 | string,
  factoryContext: CongressionalSemanticFactoryContextV1,
): CongressionalSemanticArtifactFactoryV1 | undefined {
  if (budgetFamily !== 'committee' && budgetFamily !== 'public_law') return undefined;
  const { profile, mode } = validateFactoryContext(factoryContext);
  if ((mode === 'PUBLIC_LAW') !== (budgetFamily === 'public_law')) {
    return fail(
      'budget family does not match the reviewed congressional stage',
      'family_stage_mismatch',
    );
  }

  return (input, parserResultProofs) => {
    if (input.rows.length === 0) {
      return fail('congressional semantic input contains no structured rows', 'rows_missing');
    }
    if (input.rows.some((row) => row.request != null)) {
      return fail(
        'legacy committee adapter request assertions are incompatible with non-owning congressional request baselines',
        'request_baseline_unsupported',
      );
    }
    if (input.rows.some((row) => row.mark == null)) {
      return fail(
        'every legacy congressional row must carry its stage-owned mark value',
        'stage_mark_missing',
      );
    }
    const declaredUnits = new Set(profile.declaredUnits);
    for (const [index, row] of input.rows.entries()) {
      if (row.markUnit != null && !declaredUnits.has(row.markUnit)) {
        return fail(
          `row ${index} declares mark unit ${row.markUnit}, which the stage profile does not permit`,
          'undeclared_unit',
        );
      }
    }
    const adaptedArtifact = adaptCommitteeArtifactToArtifactV1(input, factoryContext.context, {
      mode,
      defaultFiscalYear: profile.fiscalYear,
      // Units must be carried by each governed row; the profile's allowed-unit
      // set does not establish the unit of a particular legacy amount.
    });
    const artifact = bindParserRunsToPersistedProofsV1(adaptedArtifact, parserResultProofs);
    assertPhase5ArtifactProofBound({
      artifact,
      parserResultProofs,
      requireResultByteSha256: true,
    });
    const errors = validateDefenseBudgetExtractionArtifactV1(artifact).filter(
      (finding) => finding.severity === 'error',
    );
    if (errors.length > 0) {
      return fail(
        `adapted congressional artifact failed semantic validation: ${errors.map((e) => e.code).join(', ')}`,
        'artifact_invalid',
      );
    }
    return artifact;
  };
}
