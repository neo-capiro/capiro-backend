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
  it('preserves the exact synthetic acknowledgement without a coverage disclaimer', () => {
    const request =
      'This is a synthetic interface smoke check. Reply only: Meri smoke check complete. Do not call tools, retrieve records, remember anything, create tasks, modify business records, or send messages.';
    expect(finalizeWithoutReads(request, 'Meri smoke check complete.')).toBe(
      'Meri smoke check complete.',
    );
  });

  it.each([
    ['List all awards, reply only in JSON.', 'No awards exist.'],
    ['Reply only: No awards exist.', 'No awards exist.'],
    ['Reply only whether all contracts expired.', 'All contracts expired.'],
  ])('retains a disclosure for an unsupported factual request: %s', (request, reply) => {
    expect(finalizeWithoutReads(request, reply)).toBe(
      `${reply}\n\n> **Evidence limitation:** No/none/only/all/every claims require explicit, non-truncated source coverage; an empty or failed query is not proof of absence; that part of the answer remains limited because the source was never called.`,
    );
  });
});
