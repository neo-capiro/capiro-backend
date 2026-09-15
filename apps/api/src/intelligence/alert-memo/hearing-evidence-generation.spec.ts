import { createGeneratePostHearingSummaryTool } from '@capiro/meriv2-core';

describe('Meri hearing evidence contract', () => {
  const evidence = [
    {
      segmentId: 'final-a',
      text: 'We recommend inspections under HB 123.',
      startMs: 1000,
      endMs: 4000,
      speakerLabel: '0',
    },
  ];
  const input = {
    sessionId: 'owned',
    title: 'Owned testimony',
    quotes: [],
    mentions: [],
    actionItems: [],
    evidence,
    jurisdiction: 'FL',
    legislativeSession: '2026',
    publicationKind: 'hearing_recap' as const,
    folderContext: [
      {
        id: 'folder',
        name: 'Transportation',
        jurisdiction: 'FL',
        session: '2026',
        bills: [
          {
            id: 'FL:2026:HB123',
            number: 'HB123',
            position: 'support',
            importance: 'high',
            topPriority: true,
            externalComments: 'Inspection costs matter.',
          },
        ],
      },
    ],
  };
  it('preserves qualified context and returns an evidence-linked unofficial draft', async () => {
    const completeWithSchema = jest.fn(async () => ({
      input: {
        claims: [{ id: 'claim-1', kind: 'quote', evidenceIndexes: [0] }],
      },
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const result = await createGeneratePostHearingSummaryTool({
      completeWithSchema,
    } as any).handler(input, {} as any);
    expect(result).toMatchObject({
      promptVersion: 'hearing-evidence-v1',
      claims: [{ text: evidence[0]!.text, evidenceIds: ['final-a'] }],
      clientContext: 'none',
    });
    // The external claim carries the exact prior keys only — the internal
    // sourceIndex protocol never leaks into the public result.
    expect(Object.keys(result.claims![0]!).sort()).toEqual(['evidenceIds', 'id', 'kind', 'text']);
    const request = (
      completeWithSchema.mock.calls as unknown as [[{ system: string; prompt: string }]]
    )[0][0];
    expect(JSON.parse(request.prompt)).toMatchObject({
      jurisdiction: 'FL',
      legislativeSession: '2026',
      folderContext: input.folderContext,
    });
    expect(request.system).toContain('never verified identities');
    expect(request.system).toContain('cannot support an otherwise absent hearing fact');
  });
  it.each([
    {
      id: 'claim-1',
      kind: 'observation',
      text: 'An uncited assertion',
      // A selected index outside the supplied source range.
      evidenceIndexes: [7],
    },
    // A quote claim must never carry authored text.
    { id: 'claim-1', kind: 'quote', text: 'The bill passed.', evidenceIndexes: [0] },
    // An authored claim cites at least one supplied segment.
    { id: 'claim-1', kind: 'analysis', text: 'An unsupported recommendation', evidenceIndexes: [] },
  ])('rejects invalid evidence or an altered quote: $text', async (claim) => {
    const tool = createGeneratePostHearingSummaryTool({
      completeWithSchema: async () => ({
        input: { claims: [claim] },
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    } as any);
    await expect(tool.handler(input, {} as any)).rejects.toThrow();
  });
});
