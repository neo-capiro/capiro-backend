import {
  planGovernmentAffairsEvidence,
  resolveGovernmentAffairsOperatingFrame,
} from '@capiro/meriv2-core';
import {
  appendClaimTiedCoverageDisclosure,
  buildCoverageRequirements,
  compareCoverage,
  planFollowUp,
} from './meri-evidence-requirements';
import { observeMeriTurnToolCoverage } from '../meriv3/meriv3-turn-coverage';

/** The same planning, coverage comparison, and disclosure functions used by
 * MeriV3 finalization, with the observed no-tool smoke turn as input. */
function finalizeWithoutReads(request: string, reply: string): string {
  const frame = resolveGovernmentAffairsOperatingFrame({
    request,
    asOf: '2026-10-02T00:00:00Z',
  });
  const plan = planGovernmentAffairsEvidence({ request, frame, surface: 'chat' });
  const requirements = buildCoverageRequirements({ request, frame, plan, clientId: null });
  const gaps = compareCoverage({
    requirements,
    toolsUsed: [],
    receipts: [],
    ledgerEntries: [],
    citations: [],
  });
  return appendClaimTiedCoverageDisclosure(reply, gaps, requirements);
}

describe('response formatting through Meri evidence finalization', () => {
  it('does not append a dataset warning to a read-only capabilities answer', () => {
    const request =
      'Read-only QA: list three things you can help me with besides email. Keep this under 60 words. Do not search, save memories, or change any records.';
    const reply = 'Research legislation, analyze budget lines, and draft briefing materials.';
    expect(finalizeWithoutReads(request, reply)).toBe(reply);
  });

  it('does not probe legislative sources when a mailbox lookup fails', () => {
    const request = 'Search my mailbox once. If the search fails, report that it failed.';
    const reply = 'The mailbox lookup failed, so I cannot report a result count.';
    expect(finalizeWithoutReads(request, reply)).toBe(reply);
  });

  it('does not add a financial warning for a named outreach target', () => {
    const request = 'Should we contact Office Delta for Aster?';
    const reply =
      'The available approved guidance does not establish that outreach recommendation.';
    expect(finalizeWithoutReads(request, reply)).toBe(reply);
  });

  it('preserves missing evidence for an actual financial comparison', () => {
    expect(finalizeWithoutReads('What is the FY2026 funding delta?', 'Unknown.')).toContain(
      'Evidence limitation',
    );
  });

  it('preserves the exact arithmetic diagnostic without a coverage disclaimer', () => {
    const request =
      'Diagnostic check: reply with only 4 for 2 + 2. Do not search, use tools, create tasks, save or propose memories, or send any messages.';
    expect(finalizeWithoutReads(request, '4')).toBe('4');
  });

  it('does not reinterpret a successful mail-tool acknowledgement as an exhaustive claim', () => {
    const request =
      'Post-correction diagnostic: search my own mailbox once for the exact nonsense string CAPIRO_MERI_DIAGNOSTIC_20261002_1409_NO_MATCH. Report only whether search_emails completed successfully or returned an error. Do not disclose email contents, run other tools, save memories, create tasks, or send messages.';
    const frame = resolveGovernmentAffairsOperatingFrame({
      request,
      asOf: '2026-10-02T00:00:00Z',
    });
    const plan = planGovernmentAffairsEvidence({ request, frame, surface: 'chat' });
    const requirements = buildCoverageRequirements({ request, frame, plan, clientId: null });
    const gaps = compareCoverage({
      requirements,
      toolsUsed: ['search_emails'],
      receipts: [],
      ledgerEntries: [
        { tool: 'search_emails', serialized: '{"results":[]}', result: { results: [] } },
      ],
      citations: [],
    });
    const reply = 'search_emails completed successfully.';
    expect(appendClaimTiedCoverageDisclosure(reply, gaps, requirements)).toBe(reply);
  });

  it('preserves the exact synthetic acknowledgement without a coverage disclaimer', () => {
    const request =
      'This is a synthetic interface smoke check. Reply only: Meri smoke check complete. Do not call tools, retrieve records, remember anything, create tasks, modify business records, or send messages.';
    expect(finalizeWithoutReads(request, 'Meri smoke check complete.')).toBe(
      'Meri smoke check complete.',
    );
  });

  it.each([
    ['Report only whether all awards are expired.', 'All awards are expired.'],
    ['Report only: No awards exist.', 'No awards exist.'],
    ['Reply with only 4 awards.', 'Only four awards exist.'],
    ['Reply with only 4 for 2 + 2. Every award expired.', 'Every award expired.'],
    ['List all awards, reply only in JSON.', 'No awards exist.'],
    ['Reply only: No awards exist.', 'No awards exist.'],
    ['Reply only whether all contracts expired.', 'All contracts expired.'],
  ])('retains a disclosure for an unsupported factual request: %s', (request, reply) => {
    expect(finalizeWithoutReads(request, reply)).toBe(
      `${reply}\n\n> **Evidence limitation:** No/none/only/all/every claims require explicit, non-truncated source coverage; an empty or failed query is not proof of absence; that part of the answer remains limited because the source was never called.`,
    );
  });
});

const hypotheticalRequests = [
  'Quality check using hypothetical facts only: Aster has a Thursday demo. Maya owns the slides, due Tuesday. Lee owns the technical review, due Wednesday; it depends on Maya finishing the slides. The rehearsal has no owner or scheduled time. Write exactly three concise bullets: the critical path, the main delivery risk, and the next action. Use only these facts. Do not search, use tools, save memories, create tasks, or send messages.',
  'Update to the hypothetical example: the slides will now be ready Wednesday afternoon. Keep the other facts unchanged. In exactly two sentences, explain what this changes and what I should confirm next. Do not assume the demo has been delayed. Do not use tools, save memories, create tasks, or send messages.',
  'Based only on the hypothetical facts in this conversation, what exact time is the rehearsal, and has Lee approved the slides? If either is unknown, say so clearly. Do not infer that a scheduled review means approval happened. Do not search, use tools, save memories, create tasks, or send messages.',
  "Using only these fictional notes, prepare two bullets: Maya's slides are due Tuesday; Lee's review is now due Wednesday and depends on the slides; there is no rehearsal owner. Explain the risk and next action. Do not use tools.",
  "In this hypothetical scenario, Aster demos Thursday. Maya's slides are now due Wednesday afternoon, and Lee owns the review due Wednesday. No rehearsal time is supplied. Use only the facts supplied here. Explain the critical path and uncertainty in two sentences. Do not search or use tools.",
];

describe('closed hypothetical facts through the real coverage planner', () => {
  it.each(hypotheticalRequests)('does not probe or qualify supplied context: %s', (request) => {
    const frame = resolveGovernmentAffairsOperatingFrame({ request });
    const plan = planGovernmentAffairsEvidence({ request, frame, surface: 'chat' });
    const requirements = buildCoverageRequirements({ request, frame, plan, clientId: null });
    const gaps = compareCoverage({
      requirements,
      toolsUsed: [],
      receipts: [],
      ledgerEntries: [],
      citations: [],
    });
    expect(
      planFollowUp({
        gaps,
        requirements,
        request,
        frame,
        toolSchemas: [
          {
            name: 'list_members',
            readOnly: true,
            input_schema: { type: 'object', properties: {} },
          },
        ],
      }),
    ).toBeNull();
    expect(
      appendClaimTiedCoverageDisclosure(
        'The rehearsal time is unknown from the supplied facts.',
        gaps,
        requirements,
      ),
    ).toBe('The rehearsal time is unknown from the supplied facts.');
  });
  it('still schedules a real current-role lookup and discloses a missing source', () => {
    const request = 'Who is the current committee chair?';
    const frame = resolveGovernmentAffairsOperatingFrame({ request });
    const plan = planGovernmentAffairsEvidence({ request, frame, surface: 'chat' });
    const requirements = buildCoverageRequirements({ request, frame, plan, clientId: null });
    const gaps = compareCoverage({
      requirements,
      toolsUsed: [],
      receipts: [],
      ledgerEntries: [],
      citations: [],
    });
    expect(
      planFollowUp({
        gaps,
        requirements,
        request,
        frame,
        toolSchemas: [
          {
            name: 'list_members',
            readOnly: true,
            input_schema: { type: 'object', properties: {} },
          },
        ],
      })?.calls[0]?.name,
    ).toBe('list_members');
    expect(appendClaimTiedCoverageDisclosure('Unknown.', gaps, requirements)).toContain(
      'Evidence limitation',
    );
  });
});

describe('observed operational reads through evidence finalization', () => {
  const taskRequest =
    'Read-only task check: look at the open tasks assigned to me and report how many are overdue as of October 2, 2026. Return only the count and any limits on what you checked; do not show task titles, client names, or personal details. Use the task system, not email. Do not create or change tasks, send messages, or save memories. If you cannot determine a reliable count, say so.';
  const mailRequest =
    'For this read-only reliability check, search my connected mailbox once for the exact unique phrase CAPIRO_MERI_DIAGNOSTIC_20261002_1616_NO_MATCH. Report whether the search completed and how many matches were returned; do not display any message contents or personal details. Do not retry the search, send anything, create tasks, or save memories. If the search fails, say that it failed rather than treating it as no matches.';
  const emptyTasks = {
    tool: 'query_tasks',
    total: 0,
    returned: 0,
    tasks: [],
    scope: {
      kind: 'authorized_tasks',
      tenantId: 'tenant-1',
      actorUserId: 'user-1',
      ownerUserId: 'user-1',
      status: 'open',
      dueBefore: '2026-10-02T00:00:00.000Z',
      offset: 0,
      limit: 50,
      cursorApplied: false,
    },
    coverage: {
      sourceStatus: 'healthy',
      complete: true,
      partial: false,
      paginationComplete: true,
      hasMore: false,
      nextCursor: null,
      totalIsExactForScope: true,
      absenceSupported: true,
    },
  };

  function finalize(request: string, tool: string, result: unknown, reply: string) {
    const frame = resolveGovernmentAffairsOperatingFrame({ request });
    const plan = planGovernmentAffairsEvidence({ request, frame, surface: 'chat' });
    const requirements = buildCoverageRequirements({ request, frame, plan, clientId: null });
    const ledgerEntries = [{ tool, result, serialized: JSON.stringify(result) }];
    const gaps = compareCoverage({
      requirements,
      toolsUsed: [tool],
      receipts: observeMeriTurnToolCoverage(tool, result),
      ledgerEntries,
      citations: [],
    });
    return {
      requirements,
      gap: gaps.find((item) => item.requirementId === 'negative-claim.coverage'),
      reply: appendClaimTiedCoverageDisclosure(reply, gaps, requirements),
      followUp: planFollowUp({
        gaps,
        requirements,
        request,
        frame,
        ledgerEntries,
        toolSchemas: [
          { name: 'query_tasks', readOnly: true, input_schema: { properties: {} } },
          { name: 'search_emails', readOnly: true, input_schema: { properties: {} } },
          {
            name: 'get_bill_status',
            readOnly: true,
            input_schema: { properties: { billId: { type: 'string' } }, required: ['billId'] },
          },
          { name: 'search_floor_votes', readOnly: true, input_schema: { properties: {} } },
        ],
      }),
    };
  }

  it('keeps the real mailbox failure without a legislative follow-up or footer', () => {
    const request =
      'C1 verification, read only: Search my own connected mailbox exactly once for the literal text "c1zero20261002xqv9173". Return only the matching-message count and any actual search or coverage limitation; omit message contents, addresses, and subjects. Do not retry, broaden the query, or change anything. A failed search is unknown, not zero.';
    const reply =
      'Matching-message count: unknown. Mail search failed with 503 Service Unavailable, so coverage could not be verified.';
    const result = finalize(
      request,
      'search_emails',
      { error: 'Mail search is temporarily busy. Please retry.', statusCode: 503 },
      reply,
    );
    expect(result.requirements.some((item) => item.requirementId.startsWith('bill-status.'))).toBe(
      false,
    );
    expect(result.followUp).toBeNull();
    expect(result.gap?.status).toBe('extraction_failed');
    expect(result.reply.startsWith(reply)).toBe(true);
    expect(result.reply).not.toMatch(/bill or rule status|fiscal year/);
  });

  it('accepts explicit complete empty canonical task coverage and keeps the count unchanged', () => {
    const result = finalize(
      taskRequest,
      'query_tasks',
      emptyTasks,
      '0 overdue tasks in the checked scope.',
    );
    expect(result.gap?.status).toBe('satisfied');
    expect(result.reply).toBe('0 overdue tasks in the checked scope.');
    expect(result.followUp).toBeNull();
    expect(
      result.requirements.find((item) => item.requirementId === 'negative-claim.coverage'),
    ).toMatchObject({
      toolFamilies: ['domain_specific_tools'],
      coverageToolGroups: [['query_tasks']],
    });
  });

  it.each([
    [
      'partial',
      {
        ...emptyTasks.coverage,
        complete: false,
        partial: true,
        hasMore: true,
        paginationComplete: false,
      },
      'truncated',
    ],
    ['unknown', {}, 'truncated'],
  ])('retains the limitation for %s task coverage', (_name, coverage, status) => {
    const result = finalize(
      taskRequest,
      'query_tasks',
      { ...emptyTasks, coverage },
      'The count is not established.',
    );
    expect(result.gap?.status).toBe(status);
    expect(result.reply).toContain('Evidence limitation');
    expect(result.reply).not.toContain('never called');
    expect(result.followUp).toBeNull();
  });

  it('reports the observed mailbox failure without calling it an uncalled source', () => {
    const result = finalize(
      mailRequest,
      'search_emails',
      { error: 'HTTP 503: unavailable' },
      'The mailbox search failed.',
    );
    expect(result.gap?.status).toBe('extraction_failed');
    expect(result.reply).toContain('Evidence limitation');
    expect(result.reply).toContain('extraction failed');
    expect(result.reply).not.toContain('never called');
    expect(result.followUp).toBeNull();
    expect(
      result.requirements.find((item) => item.requirementId === 'negative-claim.coverage'),
    ).toMatchObject({ coverageToolGroups: [['search_emails', 'list_emails']] });
  });

  it.each([
    [0, 1, 'satisfied'],
    [10, 11, 'truncated'],
    [0, 11, 'truncated'],
  ])(
    'requires full query coverage for observed mail offset %s of %s matches',
    (offset, totalMatches, status) => {
      const payload = {
        returned: 1,
        totalMatches,
        offset,
        hasMore: false,
        results: [{ id: 'mail-11' }],
        queryScope: {
          query: 'CAPIRO_MERI_DIAGNOSTIC_20261002_1616_NO_MATCH',
          from: null,
          participant: null,
          clientId: null,
          folder: null,
          withinDays: null,
          asOf: '2026-10-02T00:00:00.000Z',
        },
        searchedMailboxes: [
          { provider: 'synthetic', status: 'connected', mailCoverage: { sourceStatus: 'healthy' } },
        ],
      };
      // The actual observer marks a healthy terminal page complete even when
      // earlier offsets were not observed. Finalization must retain that gap.
      expect(observeMeriTurnToolCoverage('search_emails', payload)[0]).toMatchObject({
        status: 'complete',
        paginationComplete: true,
        recordsReturned: 1,
        recordsMatched: totalMatches,
      });
      const result = finalize(
        mailRequest,
        'search_emails',
        payload,
        'The search returned one match.',
      );
      expect(result.gap?.status).toBe(status);
      if (status === 'satisfied') expect(result.reply).toBe('The search returned one match.');
      else expect(result.reply).toContain('Evidence limitation');
      expect(result.followUp).toBeNull();
    },
  );

  it.each([
    { offset: 10, cursorApplied: false },
    { offset: 0, cursorApplied: true },
  ])('does not treat an observed task continuation as whole-scope coverage: %j', (scope) => {
    const payload = { ...emptyTasks, scope: { ...emptyTasks.scope, ...scope } };
    expect(observeMeriTurnToolCoverage('query_tasks', payload)[0]).toMatchObject({
      status: 'complete',
      paginationComplete: true,
    });
    const result = finalize(taskRequest, 'query_tasks', payload, '0 overdue tasks.');
    expect(result.gap?.status).toBe('truncated');
    expect(result.reply).toContain('Evidence limitation');
    expect(result.followUp).toBeNull();
  });

  it('does not let a complete unrelated task read satisfy a mailbox claim', () => {
    const result = finalize(mailRequest, 'query_tasks', emptyTasks, 'No matches.');
    expect(result.gap?.status).toBe('never_called');
    expect(result.reply).toContain('Evidence limitation');
  });

  it('requires both sources for an exhaustive task and mailbox request', () => {
    const result = finalize(
      'List all open tasks and emails in my mailbox.',
      'query_tasks',
      emptyTasks,
      'No tasks or emails.',
    );
    expect(result.gap?.status).toBe('called_no_usable_content');
    expect(result.reply).toContain('Evidence limitation');
  });
});
