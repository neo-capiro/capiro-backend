import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './controlled-read-authority.test.mjs';
import {
  createControlledBudgetDefinition,
  CONTROLLED_BUDGET_CASES,
} from '../fixture-provisioning/controlled-budget-definitions.mjs';
import { assertControlledReadReceiptJoins } from '../controlled-read-receipt-joins.mjs';
import { inspectControlledBudgetSavedEvidence } from '../controlled-budget-predicates.mjs';
import { inspectControlledReadScope } from '../controlled-read-live-capture.mjs';
import { sha256Bytes, sha256Stable } from '../artifact-collector.mjs';
const obs = (value) => ({ status: 'OBSERVED', value, reason: null });
const answers = {
  21: 'FY26 enacted $37M. FY27 President’s Budget request $42M. An increase of $5M.',
  22: 'House report recommends $48M. Senate committee report recommends $45M. The difference is $3M.',
  23: 'FY27 enactment is not established. These are request and report sources, not an enacted appropriation.',
  24: 'No, that is incorrect. FY26 enacted $37M. FY27 President’s Budget request $42M.',
  26: 'The distinct cost categories $6.178M and $2.811M total $8.989M.',
  27: 'There is no PE 0999999Z match in the complete FY27 Navy book.',
};
function refresh(j) {
  j.doneEnvelope = structuredClone(j.envelope);
  j.authority.envelopeSha256 = sha256Stable(j.envelope);
  j.authority.answerSha256 = sha256Bytes(j.answer);
}
export function budgetFixture(caseId) {
  const { joins: j } = fixture('20');
  const d = createControlledBudgetDefinition({
    caseId,
    tenantId: j.expected.tenantId,
    clientId: j.expected.clientId,
    captureRunId: j.expected.captureRunId,
  });
  const r = j.envelope.receipt;
  for (const v of [j.expected, j.policy, j.admission, j.authority, r]) {
    v.caseId = caseId;
    v.physicalMapSha256 = d.physicalMapSha256;
  }
  const canonical = {
    ...j.authority.fixture,
    physicalMapSha256: d.physicalMapSha256,
    coverage: structuredClone(d.coverage),
    sources: d.reads.map((read) => ({
      logicalId: read.logicalId,
      physicalId: read.physicalId,
      tenantId: j.expected.tenantId,
      clientId: null,
      sourceVersion: read.version,
      kind: read.kind,
      contentSha256: read.contentSha256,
      sourceStorage: 'immutable_source_owned_controlled_adapter',
    })),
  };
  j.admission.fixture = canonical;
  j.authority.fixture = structuredClone(canonical);
  r.fixture.physicalMapSha256 = obs(d.physicalMapSha256);
  for (const v of [j.admission.providerBudget, j.authority.providerBudget])
    v.coverage = `case${caseId}_controlled_read_turn`;
  r.providerBudget.boundary = `case${caseId}_controlled_read_turn`;
  const tool = caseId === '27' ? 'search_program_elements' : 'get_pe_budget_timeline';
  const sources = d.reads.map((read) => ({
    sourceId: read.physicalId,
    logicalSourceId: read.logicalId,
    sourceVersion: read.version,
    sourceTenantId: j.expected.tenantId,
    sourceClientId: null,
    contentSha256: read.contentSha256,
    fullRead: true,
    passageSha256: read.contentSha256,
  }));
  const attempt = {
    ...r.controlledReadAttempts[0],
    ...sources[0],
    caseId,
    tool,
    sourceReads: sources,
    coverage: structuredClone(d.coverage),
  };
  r.controlledReadAttempts = [attempt];
  r.toolCalls = [{ ...r.toolCalls[0], name: tool, sourceIds: sources.map((s) => s.sourceId) }];
  r.sources = d.reads.map((read) => ({
    ...r.sources[0],
    sourceId: read.physicalId,
    passageSha256: obs(read.contentSha256),
    byteSha256: obs(read.contentSha256),
    locator: obs(read.facts.page ? `page ${read.facts.page}` : read.logicalId),
  }));
  j.sourceReadback = d.reads.map((read) => ({
    ...j.sourceReadback,
    recordId: read.physicalId,
    text: read.content,
    section: read.facts.page ? `page ${read.facts.page}` : read.logicalId,
  }));
  j.citations = d.reads.map((read) => ({
    ...j.citations[0],
    id: read.physicalId,
    tool,
    snippet: read.content,
    source: {
      ...j.citations[0].source,
      recordId: read.physicalId,
      section: read.facts.page ? `page ${read.facts.page}` : read.logicalId,
    },
  }));
  r.blockers = d.reads.map((read) => `source_client_authority_unproved:${read.physicalId}`);
  j.answer = answers[caseId];
  refresh(j);
  return j;
}
for (const caseId of CONTROLLED_BUDGET_CASES)
  test(`budget${caseId} one HTTP invocation joins every real source independently`, () => {
    const j = budgetFixture(caseId),
      result = assertControlledReadReceiptJoins(j);
    assert.equal(result.controlledReadAttempts.length, 1);
    assert.equal(result.sources.length, j.citations.length);
    assert.deepEqual(inspectControlledBudgetSavedEvidence(j).defects, []);
  });
for (const [name, mutate] of [
  ['missing second passage', (j) => j.envelope.receipt.controlledReadAttempts[0].sourceReads.pop()],
  [
    'duplicate passage',
    (j) =>
      (j.envelope.receipt.controlledReadAttempts[0].sourceReads[1] =
        j.envelope.receipt.controlledReadAttempts[0].sourceReads[0]),
  ],
  [
    'swapped hash',
    (j) =>
      (j.envelope.receipt.controlledReadAttempts[0].sourceReads[1].passageSha256 = 'a'.repeat(64)),
  ],
  [
    'invented second call',
    (j) =>
      j.envelope.receipt.toolCalls.push({ ...j.envelope.receipt.toolCalls[0], callId: 'extra' }),
  ],
  ['source never cited', (j) => j.citations.pop()],
  ['source never opened', (j) => j.sourceReadback.pop()],
  ['cross-run', (j) => (j.envelope.receipt.controlledReadAttempts[0].captureRunId = 'old')],
  ['foreign source', (j) => (j.authority.fixture.sources[1].tenantId = 'other')],
  [
    'unproved null client',
    (j) => j.envelope.receipt.blockers.push('source_client_authority_unproved:foreign'),
  ],
  [
    'unaccounted cost',
    (j) => j.envelope.receipt.providerBudget.unaccountedBoundaries.push('unknown'),
  ],
])
  test(`budget multi-source rejects ${name}`, () => {
    const j = budgetFixture('21');
    mutate(j);
    refresh(j);
    assert.throws(() => assertControlledReadReceiptJoins(j));
  });
for (const caseId of ['23', '27'])
  test(`budget${caseId} rejects missing/partial/wrong negative coverage`, () => {
    for (const mutate of [
      (j) => (j.envelope.receipt.controlledReadAttempts[0].coverage = null),
      (j) => (j.envelope.receipt.controlledReadAttempts[0].coverage.complete = false),
      (j) => {
        j.authority.fixture.coverage.sourceIds = [];
        j.admission.fixture = structuredClone(j.authority.fixture);
      },
    ]) {
      const j = budgetFixture(caseId);
      mutate(j);
      refresh(j);
      assert.throws(() => assertControlledReadReceiptJoins(j));
    }
  });
test('all six live transport scopes remain closed while data-only grading is available', () => {
  for (const caseId of CONTROLLED_BUDGET_CASES) {
    const h = fixture('20');
    h.config.caseId = caseId;
    assert.throws(() =>
      inspectControlledReadScope(h.config, { MERI_LIVE_BEARER_TOKEN: 'synthetic-test-bearer' }),
    );
  }
});
test('wrong arithmetic and unknown-as-zero cannot pass saved predicates', () => {
  for (const [id, bad] of [
    ['21', answers[21].replace('$5M', '$6M')],
    ['22', answers[22].replace('$45M', '$48M')],
    ['26', answers[26].replace('$8.989M', '$6.178M')],
    ['23', answers[23] + ' $0M was enacted.'],
    ['27', 'A Navy program was found.'],
  ]) {
    const j = budgetFixture(id);
    j.answer = bad;
    refresh(j);
    assert.ok(inspectControlledBudgetSavedEvidence(j).defects.length > 0);
  }
});
