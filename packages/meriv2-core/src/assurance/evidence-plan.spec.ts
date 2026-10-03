import { describe, expect, it } from '@jest/globals';
import { inferClaimCategories, planGovernmentAffairsEvidence } from './evidence-plan';
import { resolveGovernmentAffairsOperatingFrame } from './operating-frame';

const smokePrompt =
  'This is a synthetic interface smoke check. Reply only: Meri smoke check complete. Do not call tools, retrieve records, remember anything, create tasks, modify business records, or send messages.';

const formattingRequests = [
  smokePrompt,
  'Read-only QA: list three things you can help me with besides email. Keep this under 60 words. Do not search, save memories, or change any records.',
  'Use read only access to explain your capabilities.',
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
  'Read-only check: list all awards.',
  'Using read-only access, verify that no awards exist.',
  'Read only one award and explain why it is the only match.',
  'Read only the awards from this year.',
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

describe('operational status is not legislative status', () => {
  it.each([
    'Search my mailbox once. If the search fails, say that it failed rather than treating it as no matches.',
    'What is the status of my upload?',
    'The database query failed. Explain the error.',
    'Read-only: did the API request work? Report whether the connection failed.',
    'A failed search is unknown, not zero.',
    'Report the failed mailbox lookup.',
    'Explain the failed API request.',
    'Report the failed query’s status.',
    'C1 verification, read only: Search my own connected mailbox exactly once for the literal text "c1zero20261002xqv9173". Return only the matching-message count and any actual search or coverage limitation; omit message contents, addresses, and subjects. Do not retry, broaden the query, or change anything. A failed search is unknown, not zero.',
  ])('does not schedule legislative evidence for %s', (request) => {
    expect(inferClaimCategories(request)).not.toContain('bill_status');
    expect(plan(request).requiredRequirementIds).not.toContain('bill-status.official-status');
  });

  it.each([
    'Did it pass?',
    'What is its status?',
    'Did H.R. 123 pass?',
    'The search failed. Verify whether the bill passed.',
    'What is the status of SB123? The lookup failed.',
    'The server failed, but is the measure still alive?',
    'After the failed search, verify whether H.R. 123 passed.',
    'The failed mailbox lookup does not tell us the bill status.',
  ])('retains actual or unresolved legislative evidence for %s', (request) => {
    expect(inferClaimCategories(request)).toContain('bill_status');
  });
});

describe('budget deltas require financial context', () => {
  it.each([
    'Should we contact Office Delta for Aster?',
    'Draft an outreach question for Office Delta about what changed from the prior version and how it compares with our current priorities.',
    'Explain the increase in response rates and the difference between the two outreach approaches.',
    'Compare the changes from the first software release versus the second.',
    'We need to cut the ribbon after the renovation. What time should we invite the team?',
    'Describe the actual cuts in the final film.',
    'Send Office Delta the budget.',
    'Discuss the funding request with Project Delta.',
    'Compare the formats of these budget documents.',
  ])('does not require budget-comparison evidence for nonfinancial requests: %s', (request) => {
    expect(inferClaimCategories(request)).not.toContain('budget_delta');
    expect(plan(request).requiredRequirementIds).not.toContain('budget-delta.comparable-positions');
  });

  it.each([
    'What was the delta in the budget between the two proposals?',
    'How did funding increase from FY2025 to FY2026?',
    'Compare the dollar decrease for Program Element PE0601234 across fiscal years.',
    "Compare the President's request versus the congressional mark for this program.",
    'What actual cuts and plus-ups were made to the program element?',
    'What is the increase for PE0602712F?',
    'What is the increase for 0602712F?',
    'What is the increase in federal spending?',
    'What is the difference between appropriated and obligated amounts?',
    'What is the difference in outlays between the two years?',
    'What is the difference between the request and the Senate mark?',
    'What changed from FY-2025 to FY-2026?',
    'FY2025 versus FY2026.',
    'What is the budget delta for Office Delta?',
    'How much were appropriations decreased?',
  ])('requires comparable financial positions for %s', (request) => {
    expect(inferClaimCategories(request)).toContain('budget_delta');
    expect(plan(request).requiredRequirementIds).toContain('budget-delta.comparable-positions');
  });

  it('does not add a generic budget delta to a routed chamber-position comparison', () => {
    const result = plan('Compare House vs Senate positions on PE 0603851F.');
    expect(result.requestCategories).not.toContain('budget_delta');
    expect(result.requiredRequirementIds).not.toContain('budget-delta.comparable-positions');
  });
});

const hypotheticalRequests = [
  'Quality check using hypothetical facts only: Aster has a Thursday demo. Maya owns the slides, due Tuesday. Lee owns the technical review, due Wednesday; it depends on Maya finishing the slides. The rehearsal has no owner or scheduled time. Write exactly three concise bullets: the critical path, the main delivery risk, and the next action. Use only these facts. Do not search, use tools, save memories, create tasks, or send messages.',
  'Update to the hypothetical example: the slides will now be ready Wednesday afternoon. Keep the other facts unchanged. In exactly two sentences, explain what this changes and what I should confirm next. Do not assume the demo has been delayed. Do not use tools, save memories, create tasks, or send messages.',
  'Based only on the hypothetical facts in this conversation, what exact time is the rehearsal, and has Lee approved the slides? If either is unknown, say so clearly. Do not infer that a scheduled review means approval happened. Do not search, use tools, save memories, create tasks, or send messages.',
  "Using only these fictional notes, prepare two bullets: Maya's slides are due Tuesday; Lee's review is now due Wednesday and depends on the slides; there is no rehearsal owner. Explain the risk and next action. Do not use tools.",
  "In this hypothetical scenario, Aster demos Thursday. Maya's slides are now due Wednesday afternoon, and Lee owns the review due Wednesday. No rehearsal time is supplied. Use only the facts supplied here. Explain the critical path and uncertainty in two sentences. Do not search or use tools.",
];

describe('explicit closed hypothetical facts', () => {
  it.each(hypotheticalRequests)('does not require external proof for %s', (request) => {
    expect(plan(request).requiredRequirementIds).toEqual([]);
  });
  it.each([
    'Using provided notes only: the review is now due Wednesday; no owner is named. Summarize the uncertainty.',
    'Based only on these supplied facts: no rehearsal time is specified. Explain what remains unknown.',
    'Revision to this fictional scenario: the slides are now due Wednesday. Leave the remaining details unchanged. Explain the impact.',
    'Use only the information given above. Now explain why no deadline can be inferred.',
  ])('recognizes the exclusive premise boundary across wording: %s', (request) => {
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
    'Using only these fictional notes, explain the risk. Also verify the current committee chair. Do not use tools.',
    'In this hypothetical scenario, no rehearsal is scheduled. Use only the facts supplied here. Also list all awards for Aster.',
    'Using provided notes only, summarize the example and compare it to the actual current roster.',
    'Use only the information given above, but verify that no real grants exist.',
  ])('retains external coverage for real or mixed requests: %s', (request) => {
    expect(plan(request).requiredRequirementIds.length).toBeGreaterThan(0);
  });
});
