import {
  buildContextCompareSystemPrompt,
  sanitizeContextCompareResult,
  validateContextCompareInput,
  type StrategyContextCompareInput,
} from './context-compare-prompt.js';

const INPUT: StrategyContextCompareInput = {
  clientId: 'client-1',
  incomingFacts: [
    {
      id: 'new-doc:0',
      fact: 'The client deadline is October 1.',
      documentTitle: 'Blueprint',
    },
    {
      id: 'new-doc:1',
      fact: 'The client deadline is October 15.',
      documentTitle: 'Meeting notes',
    },
  ],
  existingFacts: [
    {
      id: 'old-fact',
      fact: 'The client deadline is September 30.',
      authority: 'working_draft',
    },
  ],
};

describe('save-time context conflict comparison', () => {
  it('compares original reviewed statements without rewriting them', () => {
    expect(validateContextCompareInput(INPUT)).toEqual(INPUT);
    const result = {
      conflicts: [
        {
          incomingFactId: 'new-doc:0',
          otherFactId: 'new-doc:1',
          material: true,
        },
        {
          incomingFactId: 'new-doc:0',
          otherFactId: 'old-fact',
          material: true,
        },
      ],
      warnings: [],
    };
    expect(sanitizeContextCompareResult(result, INPUT)).toEqual(result);
    expect(INPUT.incomingFacts[0]?.fact).toBe('The client deadline is October 1.');
  });

  it('allows a fully formed empty comparison result', () => {
    expect(sanitizeContextCompareResult({ conflicts: [], warnings: [] }, INPUT)).toEqual({
      conflicts: [],
      warnings: [],
    });
  });

  it('accepts long previously imported source sections without truncation', () => {
    const existingFacts = [
      {
        id: 'old-long',
        fact: 'a'.repeat(12_000),
        authority: null,
        documentTitle: null,
        asOf: null,
      },
    ];
    expect(
      validateContextCompareInput({ ...INPUT, existingFacts }).existingFacts[0]?.fact,
    ).toHaveLength(12_000);
  });

  it('rejects overlapping or duplicate IDs and no incoming statements', () => {
    expect(() =>
      validateContextCompareInput({
        ...INPUT,
        existingFacts: INPUT.incomingFacts,
      }),
    ).toThrow('distinct');
    expect(() => validateContextCompareInput({ ...INPUT, incomingFacts: [] })).toThrow(
      'at least one',
    );
  });

  it('rejects an oversized comparison without changing source text', () => {
    const incomingFacts = Array.from({ length: 7 }, (_, index) => ({
      id: `new:${index}`,
      fact: 'a'.repeat(10_000),
    }));
    expect(() => validateContextCompareInput({ ...INPUT, incomingFacts })).toThrow('64,000');
  });

  it.each([
    {
      incomingFactId: 'new-doc:0',
      otherFactId: 'fabricated-fact',
      material: true,
    },
    { incomingFactId: 'old-fact', otherFactId: 'new-doc:0', material: true },
    { incomingFactId: 'new-doc:0', otherFactId: 'new-doc:0', material: true },
    { incomingFactId: 'new-doc:0', otherFactId: 'old-fact', material: 'true' },
  ])('rejects an unsupported or self-referential conflict %#', (conflict) => {
    expect(() =>
      sanitizeContextCompareResult({ conflicts: [conflict], warnings: [] }, INPUT),
    ).toThrow();
  });

  it('rejects a reverse duplicate pair', () => {
    expect(() =>
      sanitizeContextCompareResult(
        {
          conflicts: [
            {
              incomingFactId: 'new-doc:0',
              otherFactId: 'new-doc:1',
              material: true,
            },
            {
              incomingFactId: 'new-doc:1',
              otherFactId: 'new-doc:0',
              material: true,
            },
          ],
          warnings: [],
        },
        INPUT,
      ),
    ).toThrow('repeated');
  });

  it('rejects missing terminal fields and proposed replacement content', () => {
    expect(() => sanitizeContextCompareResult({ conflicts: [] }, INPUT)).toThrow('incomplete');
    expect(() =>
      sanitizeContextCompareResult({ conflicts: [], warnings: [], replacement: 'changed' }, INPUT),
    ).toThrow('unsupported');
  });

  it('states that incoming-to-incoming comparisons, differing stages, and source-instruction boundaries matter', () => {
    const prompt = buildContextCompareSystemPrompt();
    expect(prompt).toContain('AND the other incoming facts');
    expect(prompt).toContain('untrusted DATA');
    expect(prompt).toContain('different stages are not automatically contradictory');
    expect(prompt).toContain('Do not rewrite the human-reviewed');
  });
});
