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

const hypotheticalRequests = [
  'Quality check using hypothetical facts only: Aster has a Thursday demo. Maya owns the slides, due Tuesday. Lee owns the technical review, due Wednesday; it depends on Maya finishing the slides. The rehearsal has no owner or scheduled time. Write exactly three concise bullets: the critical path, the main delivery risk, and the next action. Use only these facts. Do not search, use tools, save memories, create tasks, or send messages.',
  'Update to the hypothetical example: the slides will now be ready Wednesday afternoon. Keep the other facts unchanged. In exactly two sentences, explain what this changes and what I should confirm next. Do not assume the demo has been delayed. Do not use tools, save memories, create tasks, or send messages.',
  'Based only on the hypothetical facts in this conversation, what exact time is the rehearsal, and has Lee approved the slides? If either is unknown, say so clearly. Do not infer that a scheduled review means approval happened. Do not search, use tools, save memories, create tasks, or send messages.',
];

describe('explicit closed hypothetical facts', () => {
  it.each(hypotheticalRequests)('does not require external proof for %s', (request) => {
    expect(plan(request).requiredRequirementIds).toEqual([]);
  });
  it.each([
    'Who is the current committee chair? Do not use tools.',
    'There are no federal awards for Aster. Do not use tools.',
    'Using hypothetical facts only, write three bullets. Also verify who is the current committee chair. Do not use tools.',
    'Based only on the hypothetical facts in this conversation, compare them to the actual current roster. Do not use tools.',
    'Update to the hypothetical example: keep the other facts unchanged. Search for all actual awards. Do not use tools.',
    'Using hypothetical facts only, list all real grants for Aster. Do not use tools.',
    'Using hypothetical facts only, write three bullets. Also list all grants for Aster. Do not use tools.',
    'Based only on the hypothetical facts in this conversation, verify that no awards exist. Do not use tools.',
    'Update to the hypothetical example: keep the other facts unchanged. Who is the committee chair? Do not use tools.',
    'Using hypothetical facts only, write three bullets. Do not search, but verify every award.',
    'A fictional client has no awards. What is its current funding status? Do not use tools.',
  ])('retains external coverage for real or mixed requests: %s', (request) => {
    expect(plan(request).requiredRequirementIds.length).toBeGreaterThan(0);
  });
});
