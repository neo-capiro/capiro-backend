import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Phase17RuntimeCoordinator,
  type Phase17Artifact,
  type Phase17RunInput,
  type Phase17RuntimePorts,
  type Phase17Stage,
} from './phase1-7-runtime.contract.js';

const digest = (character: string): string => character.repeat(64);
const input: Phase17RunInput = {
  runId: 'session4-replay-1',
  cycleId: 'fy27-real-cycle',
  fiscalYear: 2027,
  sourceDocumentId: 'source-document-1',
  sourceSha256: digest('a'),
  sourceFamily: 'R2',
  requestedBy: 'phase8-session4-test',
  parserProvider: 'deterministic',
  parserVersion: 'pinned-v1',
};

function artifact(stage: Phase17Stage, index: number): Phase17Artifact {
  return {
    stage,
    artifactId: `${stage}-${index}`,
    sha256: digest(String((index % 9) + 1)),
    schemaVersion: '1',
  };
}

function ports(calls: Phase17Stage[]): Phase17RuntimePorts {
  const next = async (stage: Phase17Stage, index: number): Promise<Phase17Artifact> => {
    calls.push(stage);
    return artifact(stage, index);
  };
  return {
    resolveSourceProfile: async () => next('source_profile', 1),
    parse: async () => next('parser_artifact', 2),
    extract: async () => next('semantic_extraction', 3),
    verify: async () => next('phase2_verification', 4),
    planProjection: async () => next('projection_plan', 5),
    certify: async () => next('phase6_certification', 6),
    evaluateEligibility: async () => next('phase7_eligibility', 7),
    inspectPromotion: async () => next('promotion_inspection', 8),
    readOutboxStatus: async () => next('outbox_status', 9),
  };
}

test('runs the trusted phases in order and remains inspect-only', async () => {
  const calls: Phase17Stage[] = [];
  const result = await new Phase17RuntimeCoordinator(ports(calls)).inspect(input);
  assert.deepEqual(calls, [
    'source_profile',
    'parser_artifact',
    'semantic_extraction',
    'phase2_verification',
    'projection_plan',
    'phase6_certification',
    'phase7_eligibility',
    'promotion_inspection',
    'outbox_status',
  ]);
  assert.equal(result.mode, 'inspect_only');
  assert.equal(result.canonicalMutationAttempted, false);
  assert.match(result.lineageSha256, /^[a-f0-9]{64}$/);
});

test('same inputs and artifacts produce the same lineage hash', async () => {
  const left = await new Phase17RuntimeCoordinator(ports([])).inspect(input);
  const right = await new Phase17RuntimeCoordinator(ports([])).inspect(input);
  assert.equal(left.lineageSha256, right.lineageSha256);
});

test('fails closed on a malformed source digest', async () => {
  await assert.rejects(
    new Phase17RuntimeCoordinator(ports([])).inspect({ ...input, sourceSha256: 'bad' }),
    /sourceSha256/,
  );
});

test('fails closed when a port returns the wrong stage', async () => {
  const broken = ports([]);
  broken.parse = async () => artifact('semantic_extraction', 2);
  await assert.rejects(new Phase17RuntimeCoordinator(broken).inspect(input), /Expected parser_artifact/);
});
