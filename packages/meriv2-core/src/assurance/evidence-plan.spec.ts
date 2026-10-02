import { describe, expect, it } from '@jest/globals';
import { inferClaimCategories, planGovernmentAffairsEvidence } from './evidence-plan';
import { resolveGovernmentAffairsOperatingFrame } from './operating-frame';

const smokePrompt =
  'This is a synthetic interface smoke check. Reply only: Meri smoke check complete. Do not call tools, retrieve records, remember anything, create tasks, modify business records, or send messages.';

const formattingRequests = [
  smokePrompt,
  'Reply only: Meri smoke check complete.',
  'Reply only.',
  'REPLY ONLY: Test',
  'Please reply only with JSON.',
  'Reply only in JSON.',
  'Respond only with plain text.',
  'Answer in bullets only.',
  'Answer with bullet points only.',
  'Respond with YAML only.',
  'Only respond with JSON.',
  'Please only answer in markdown.',
  'Write a background paragraph. Reply only with JSON.',
];

const factualRequests = [
  'Only one award was granted.',
  'All contracts expired.',
  'Every relevant bill failed.',
  'There are no other awards.',
  'None of the contracts are valid.',
  'No evidence exists.',
  'The award does not exist.',
  'The agency never funded this program.',
  'Nothing was awarded.',
  'Nobody received an award.',
  'Reply only whether all contracts expired.',
  'Reply only: No awards exist.',
  'Reply only: Only one award was granted.',
  'Reply only: Every contract expired.',
  'Reply only with JSON: {"result":"No awards exist"}',
  'List all awards, reply only in JSON.',
  'List all awards. Reply only with JSON.',
  'Please reply only in JSON. None of the awards were renewed.',
  'Answer in bullets only: every contract expired.',
  'Answer with bullet points only and include all awards.',
  'Only respond with JSON: no awards exist.',
  'All contractors reply only with JSON.',
  'The agencies reply only with JSON.',
  'Reply only about awards.',
  'Reply only if an award exists.',
];

function plan(request: string) {
  return planGovernmentAffairsEvidence({
    request,
    frame: resolveGovernmentAffairsOperatingFrame({ request, asOf: '2026-10-02T00:00:00Z' }),
    surface: 'chat',
  });
}

describe('response formatting and factual coverage requirements', () => {
  it.each(formattingRequests)(
    'does not turn a response-format constraint into a claim: %s',
    (request) => {
      expect(inferClaimCategories(request)).not.toContain('negative_or_exhaustive');
      expect(plan(request).requiredRequirementIds).not.toContain('negative-claim.coverage');
    },
  );

  it.each(factualRequests)(
    'preserves factual or ambiguous coverage requirements: %s',
    (request) => {
      expect(inferClaimCategories(request)).toContain('negative_or_exhaustive');
      expect(plan(request).requiredRequirementIds).toContain('negative-claim.coverage');
    },
  );

  it('does not change the other factual categories or their required evidence', () => {
    const factual = 'Did every bill pass, and how did the member vote?';
    expect(plan(`${factual} Reply only with JSON.`).requiredRequirementIds).toEqual(
      plan(factual).requiredRequirementIds,
    );
    expect(inferClaimCategories(`${factual} Reply only with JSON.`)).toEqual(
      inferClaimCategories(factual),
    );
  });
});
