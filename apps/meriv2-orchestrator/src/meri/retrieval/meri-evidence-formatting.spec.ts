import {
  planGovernmentAffairsEvidence,
  resolveGovernmentAffairsOperatingFrame,
} from '@capiro/meriv2-core';
import {
  appendClaimTiedCoverageDisclosure,
  buildCoverageRequirements,
  compareCoverage,
} from './meri-evidence-requirements';

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
