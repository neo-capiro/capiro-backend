import { describe, expect, it } from '@jest/globals';
import { inferClaimCategories, planGovernmentAffairsEvidence } from './evidence-plan';
import { resolveGovernmentAffairsOperatingFrame } from './operating-frame';

const smokePrompt =
  'This is a synthetic interface smoke check. Reply only: Meri smoke check complete. Do not call tools, retrieve records, remember anything, create tasks, modify business records, or send messages.';

const formattingRequests = [
  smokePrompt,
  'Diagnostic check: reply with only 4 for 2 + 2. Do not search, use tools, create tasks, save or propose memories, or send any messages.',
  'Post-correction diagnostic: search my own mailbox once for the exact nonsense string CAPIRO_MERI_DIAGNOSTIC_20261002_1409_NO_MATCH. Report only whether search_emails completed successfully or returned an error. Do not disclose email contents, run other tools, save memories, create tasks, or send messages.',
  'Please respond with only -1.5 for 2.5 - 4.',
  'Answer with only 6 for 2 * 3.',
  'Reply with only 2 for 6 / 3.',
  'Report only whether search_emails completed successfully.',
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
  'Report only whether all awards are expired.',
  'Report only: No awards exist.',
  'Report only whether only four awards are active.',
  'Reply with only 4 awards.',
  'Reply with only 4 for 2 + 2 awards.',
  'Reply with only 4 for 2 + 2.5 awards.',
  'Reply with only 4 for 2 + 2. Every award expired.',
  'Reply with only 4 for 2 + 2, and list all awards.',
  'The agencies report only whether awards exist.',
  'Report only about awards.',
  'Report only if an award exists.',
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
