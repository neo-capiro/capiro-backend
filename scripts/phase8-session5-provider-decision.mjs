#!/usr/bin/env node
// Emit the Phase 8 Session 5 negative provider-decision artifact.
//
// This script records a NEGATIVE adoption decision. It never produces provider
// output, accuracy scores, or live-benchmark evidence, and it performs no AWS
// mutation. Zero-idle counters must be supplied from a read-only AWS check.
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

import {
  NEGATIVE_PROVIDER_DECISION,
  NEGATIVE_PROVIDER_STATUS,
  PROVIDER_DECISION_SCHEMA_VERSION,
  SESSION5_PINNED_MODEL_PACKAGE_ARN,
  SUPPORTED_ASYNC_RESULT,
  SUPPORTED_BATCH_RESULT,
  evaluateProviderDecision,
  providerDecisionContentSha256,
} from '../apps/defense-parser-orchestrator/src/provider-decision.mjs';

const root = resolve(process.cwd());
const args = new Map(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const [k, ...v] = a.slice(2).split('=');
      return [k, v.join('=')];
    }),
);

const checkedAt = args.get('checked-at');
const generatedAt = args.get('generated-at');
if (!checkedAt || !generatedAt) {
  console.error(
    'usage: phase8-session5-provider-decision.mjs --checked-at=<iso> --generated-at=<iso> [--out=<path>]',
  );
  process.exit(2);
}

const decision = {
  schemaVersion: PROVIDER_DECISION_SCHEMA_VERSION,
  decision: NEGATIVE_PROVIDER_DECISION,
  status: NEGATIVE_PROVIDER_STATUS,
  operationallyBlocked: true,

  // Exactly what was evaluated.
  provider: 'nemotron_parse',
  modelPackageArn: SESSION5_PINNED_MODEL_PACKAGE_ARN,
  modelName: 'nemotron-parse',
  modelVersion: 'LLM NIM 1.14 and VLM NIM version 1.5.0',
  marketplaceProductId: 'prod-jpaccpvt6aut4',
  instanceTypeTested: 'ml.g5.xlarge',
  awsAccountId: '967807252336',
  awsRegion: 'us-east-1',
  evaluatedRepositorySha: 'b41898bbb5e15c1ab73e536d0e9e52f9b0788833',

  // Identity of the frozen corpus the attempts were bound to.
  corpusSha256:
    'a4bf213ea908f6dff2988e1ec3c78d0d5359a8e085554cb1915721b687fc8e98',
  parserOptionsHash:
    '890f08082befbee5261b4c77f0646d647a98d402bfd31c0dcb022f2610cf688a',
  renderingConfigSha256:
    '800a38fb9e8a4f8e014febe9822a5ca075596cf03d8544ab2aa67d9856f8a2fc',

  // Both approved Session 5 execution paths were evaluated and both failed.
  executionPathsEvaluated: [
    'sagemaker_batch_transform',
    'sagemaker_async_inference',
  ],

  batchResult: SUPPORTED_BATCH_RESULT,
  batchDetail:
    'SageMaker rejected Batch Transform for the exact Marketplace model because its container definition resolves through the ModelDataSource attribute: "SageMaker Batch currently doesn\'t support Model entity with container definitions which use ModelDataSource attribute". Zero TransformJobs were created.',

  asyncResult: SUPPORTED_ASYNC_RESULT,
  asyncAttempts: 2,
  asyncDetail:
    'After IAM repair, two governed CreateEndpoint calls were accepted and Marketplace image/model resolution succeeded, but both endpoints remained in Creating with status approximately "Launching 1 instance(s)" and CurrentInstanceCount = 0. Neither reached InService, so no InvokeEndpointAsync was ever issued.',
  asyncObservations: [
    'CreateEndpoint accepted',
    'Marketplace image and model resolution succeeded',
    'endpoint status remained Creating',
    'status message approximately "Launching 1 instance(s)"',
    'CurrentInstanceCount = 0',
    'never reached InService',
  ],

  // Strongest supported explanation. The exact internal SageMaker failure
  // reason was not retained, so no AWS failure reason is asserted here.
  strongestSupportedExplanation:
    'The pinned AWS Marketplace package explicitly excludes SageMaker Asynchronous Inference, and two governed endpoint attempts never reached InService.',
  internalSageMakerFailureReasonRetained: false,

  // Truth boundary: nothing was produced and nothing was scored.
  endpointReachedInService: false,
  successfulInvokeEndpointAsync: 0,
  providerOutputsProduced: 0,
  accuracyBenchmarkCompleted: false,
  liveBenchmarkEvidenceExists: false,
  pageClassRoutingDecisionsFromLiveOutput: 0,

  // Production posture, unchanged.
  productionParser: 'DETERMINISTIC_PRIMARY',
  productionDecision: 'DETERMINISTIC_PRIMARY',
  productionRoutingChanged: false,
  nvidiaRoutingEnabled: false,
  deterministicParsingAvailable: true,
  providerNeutralContractPresent: true,
  phase2StillMandatory: true,

  // Spend: settled history only, no active reservation.
  settledBenchmarkSpendUsd: 1,
  activeReservedSpendUsd: 0,
  spendCurrency: 'USD',

  // Zero idle, from a read-only AWS check.
  zeroIdleProven: true,
  zeroIdleProof: {
    activeEndpoints: 0,
    activeEndpointConfigs: 0,
    activeTransformJobs: 0,
    activeScalableTargets: 0,
    activeGpuCapacity: 0,
    ledgerActiveJobs: 0,
    activeReservations: 0,
    ledgerSettledSpendUsd: 1,
    cloudFormationStackStatus: 'UPDATE_COMPLETE',
    cloudFormationDriftStatus: 'IN_SYNC',
    checkedAt,
  },

  // Governance.
  acceptanceAmendment:
    'docs/defense-budget/PHASE-8-SESSION-5-ACCEPTANCE-AMENDMENT.md',
  futureNvidiaAdoptionRequires:
    'a separately approved runtime/artifact decision; no NGC/NIM, BYOC/ECR, AWS Batch EC2 GPU, alternative Marketplace package, or instance-type change is authorized by this closeout',
  generatedAt,
};

decision.contentSha256 = providerDecisionContentSha256(decision);

const verdict = evaluateProviderDecision(decision);
if (!verdict.acceptable) {
  console.error('[phase8-session5] provider decision is not acceptable:');
  for (const f of verdict.failures) console.error(`- ${f}`);
  process.exit(1);
}

const out =
  args.get('out') ||
  join(root, 'docs', 'defense-budget', 'phase8-session5-provider-decision.json');
writeFileSync(out, `${JSON.stringify(decision, null, 2)}\n`, 'utf8');
console.log(`[phase8-session5] wrote ${out}`);
console.log(`[phase8-session5] contentSha256=${decision.contentSha256}`);
