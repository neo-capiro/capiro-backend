#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=0 */
import assert from 'node:assert/strict';
import test from 'node:test';

console.error('Usage: node scripts/test-phase8-session6-federal-funding-domain.mjs (no arguments run the domain gate)');
if (process.argv.length > 2) process.exit(2);

const {
  assertAuthoritativeFederalFundingAllocation,
  canContributeToKnownFederalFundingTotal,
  selectFederalFundingMappingCandidate,
} = await import('../packages/defense-domain/dist/federal-funding/index.js');

const SHA = 'a'.repeat(64);
function allocation(extra = {}) {
  return {
    targetType: 'appropriation_account',
    targetNativeKey: 'Operation and Maintenance, Defense-Wide',
    targetId: null,
    stage: 'statutory',
    maturity: 'account_level',
    reviewState: 'verified',
    authoritativeAmountUsd: '4400000000.00',
    inferredRelevance: false,
    confidence: 1,
    baseRequestStatus: 'not_included',
    potentialDoubleCount: false,
    fundingPosture: 'one_time',
    evidenceSourceDocumentId: '11111111-1111-4111-8111-111111111111',
    evidenceSha256: SHA,
    obligationReference: null,
    ...extra,
  };
}

test('verified account-level allocation can carry authoritative dollars', () => {
  assert.equal(assertAuthoritativeFederalFundingAllocation(allocation()).authoritativeAmountUsd, '4400000000.00');
  assert.equal(canContributeToKnownFederalFundingTotal(allocation()), true);
});

test('capability inference can identify relevance but cannot carry authoritative dollars', () => {
  assert.throws(() => assertAuthoritativeFederalFundingAllocation(allocation({
    targetType: 'capability',
    targetNativeKey: 'small-uas',
    maturity: 'capability_inference',
    inferredRelevance: true,
    authoritativeAmountUsd: '1400000000.00',
  })), /authoritative dollars|capability relevance/i);
  const candidate = allocation({
    targetType: 'capability',
    targetNativeKey: 'small-uas',
    maturity: 'capability_inference',
    reviewState: 'candidate',
    inferredRelevance: true,
    authoritativeAmountUsd: null,
    potentialDoubleCount: true,
  });
  assert.doesNotThrow(() => assertAuthoritativeFederalFundingAllocation(candidate));
  assert.equal(canContributeToKnownFederalFundingTotal(candidate), false);
});

test('unverified mapping cannot carry authoritative dollars', () => {
  assert.throws(() => assertAuthoritativeFederalFundingAllocation(allocation({ reviewState: 'candidate' })), /verified mapping state/i);
});

test('unmapped candidate carries neither identity nor dollars', () => {
  assert.throws(() => assertAuthoritativeFederalFundingAllocation(allocation({
    targetType: 'federal_program', maturity: 'unmapped', reviewState: 'candidate', authoritativeAmountUsd: null,
  })), /unmapped allocations cannot carry target identity/i);
  assert.doesNotThrow(() => assertAuthoritativeFederalFundingAllocation(allocation({
    targetType: 'federal_program', targetNativeKey: null, targetId: null, maturity: 'unmapped',
    reviewState: 'candidate', authoritativeAmountUsd: null, potentialDoubleCount: true,
  })));
});

test('obligation fact requires an obligation reference', () => {
  assert.throws(() => assertAuthoritativeFederalFundingAllocation(allocation({ stage: 'obligated' })), /obligation reference/i);
  assert.doesNotThrow(() => assertAuthoritativeFederalFundingAllocation(allocation({ stage: 'obligated', obligationReference: 'USAspending:award-123' })));
});

test('known total excludes base-request-included and double-count-risk allocations', () => {
  assert.equal(canContributeToKnownFederalFundingTotal(allocation({ baseRequestStatus: 'included' })), false);
  assert.equal(canContributeToKnownFederalFundingTotal(allocation({ potentialDoubleCount: true })), false);
});

test('mapping precedence chooses PE before every weaker candidate', () => {
  assert.deepEqual(selectFederalFundingMappingCandidate({
    peCode: '0605053A', projectIdentifier: 'P001', procurementLine: '1234', accountTas: '021-2040', capabilitySlug: 'autonomy',
  }), {
    targetType: 'program_element', targetNativeKey: '0605053A', maturity: 'exact_identifier', inferredRelevance: false,
  });
});

test('mapping precedence uses exact project, procurement line, account, MILCON, unique program, then capability', () => {
  assert.equal(selectFederalFundingMappingCandidate({ projectIdentifier: 'P001', procurementLine: '1234' }).targetType, 'program_element_project');
  assert.equal(selectFederalFundingMappingCandidate({ procurementLine: '1234', accountTas: '021-2040' }).targetType, 'procurement_line');
  assert.equal(selectFederalFundingMappingCandidate({ accountTas: '021-2040', milconIdentifier: 'PN123' }).targetType, 'appropriation_account');
  assert.equal(selectFederalFundingMappingCandidate({ milconIdentifier: 'PN123', uniqueProgramId: 'program-1' }).targetType, 'milcon_project');
  assert.equal(selectFederalFundingMappingCandidate({ uniqueProgramId: 'program-1', capabilitySlug: 'autonomy' }).targetType, 'federal_program');
  assert.deepEqual(selectFederalFundingMappingCandidate({ capabilitySlug: 'autonomy' }), {
    targetType: 'capability', targetNativeKey: 'autonomy', maturity: 'capability_inference', inferredRelevance: true,
  });
});

test('mapping with no evidence remains explicitly unmapped', () => {
  assert.deepEqual(selectFederalFundingMappingCandidate({}), {
    targetType: 'federal_program', targetNativeKey: null, maturity: 'unmapped', inferredRelevance: false,
  });
});
