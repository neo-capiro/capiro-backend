import {
  KNOWN_VERBS,
  isKnownVerb,
  runVerb,
  verifySourcedata,
  type VerbDeps,
} from '../src/tasks/task-runner.js';

/**
 * Phase 1 (plan §4 S3): verb dispatch + the verify-sourcedata handler, with
 * injected fakes so no DB/Bedrock is touched. The live end-to-end proof is S6.
 */
function makeDeps(opts: { bill?: unknown; scores?: Array<{ sourceId: string; score: number }>; embedDim?: number } = {}): {
  d: VerbDeps;
  logs: string[];
} {
  const logs: string[] = [];
  const bill =
    'bill' in opts
      ? opts.bill
      : {
          id: '119-hr-1',
          title: 'Test Bill',
          policyArea: 'Energy',
          subjects: ['Electric power'],
          congress: 119,
          billType: 'hr',
          billNumber: '1',
          latestActionText: null,
          latestActionDate: null,
          peCodes: null,
          url: null,
        };
  const d: VerbDeps = {
    repo: {
      getBillById: async () => bill as never,
      semanticBillScores: async () => opts.scores ?? [{ sourceId: '119-hr-1', score: 1 }],
    },
    embed: async () => new Array(opts.embedDim ?? 1024).fill(0.01),
    log: (m: string) => logs.push(m),
  };
  return { d, logs };
}

describe('task-runner verb dispatch (Phase 1)', () => {
  it('isKnownVerb recognizes verify-sourcedata and rejects others', () => {
    expect(isKnownVerb('verify-sourcedata')).toBe(true);
    expect(isKnownVerb('bogus')).toBe(false);
    expect(KNOWN_VERBS).toContain('verify-sourcedata');
  });

  it('runVerb throws on an unknown verb (→ non-zero exit)', async () => {
    const { d } = makeDeps();
    await expect(runVerb('bogus', [], d)).rejects.toThrow(/Unknown task verb/);
  });

  it('runVerb routes verify-sourcedata to its handler', async () => {
    const { d, logs } = makeDeps();
    await runVerb('verify-sourcedata', ['119-hr-1'], d);
    expect(logs.some((l) => l.startsWith('BILL_OK id=119-hr-1'))).toBe(true);
  });

  it('verify-sourcedata emits BILL_OK, EMBED_OK dim=1024, and ranked SEMANTIC_TOP', async () => {
    const { d, logs } = makeDeps({
      scores: [
        { sourceId: '119-hr-1', score: 1 },
        { sourceId: '119-s-2', score: 0.82 },
      ],
    });
    await verifySourcedata('119-hr-1', d);
    expect(logs.some((l) => l.startsWith('BILL_OK id=119-hr-1'))).toBe(true);
    expect(logs.some((l) => l.includes('EMBED_OK dim=1024'))).toBe(true);
    expect(logs).toContain('SEMANTIC_TOP:');
    expect(logs.some((l) => l.includes('119-s-2') && l.includes('0.8200'))).toBe(true);
  });

  it('verify-sourcedata requires a billId argument', async () => {
    const { d } = makeDeps();
    await expect(verifySourcedata('', d)).rejects.toThrow(/requires a <billId>/);
  });

  it('verify-sourcedata throws BILL_NOT_FOUND when the bill is missing', async () => {
    const { d } = makeDeps({ bill: null });
    await expect(verifySourcedata('nope', d)).rejects.toThrow(/BILL_NOT_FOUND/);
  });

  it('verify-sourcedata throws SEMANTIC_EMPTY when no rows clear the floor', async () => {
    const { d } = makeDeps({ scores: [] });
    await expect(verifySourcedata('119-hr-1', d)).rejects.toThrow(/SEMANTIC_EMPTY/);
  });
});
