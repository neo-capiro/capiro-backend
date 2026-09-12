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
    const completeJson = jest.fn(async () => ({
      claims: [{ id: 'claim-1', kind: 'quote', text: evidence[0]!.text, evidenceIds: ['final-a'] }],
    }));
    const result = await createGeneratePostHearingSummaryTool({ completeJson } as any).handler(
      input,
      {} as any,
    );
    expect(result).toMatchObject({
      promptVersion: 'hearing-evidence-v1',
      claims: [{ evidenceIds: ['final-a'] }],
      clientContext: 'none',
    });
    const request = (
      completeJson.mock.calls as unknown as [[{ system: string; prompt: string }]]
    )[0][0];
    expect(JSON.parse(request.prompt)).toMatchObject({
      jurisdiction: 'FL',
      legislativeSession: '2026',
      folderContext: input.folderContext,
    });
    expect(request.system).toContain('not verified identities');
    expect(request.system).toContain('cannot support an otherwise absent hearing fact');
  });
  it.each([
    {
      id: 'claim-1',
      kind: 'observation',
      text: 'An uncited assertion',
      evidenceIds: ['interim-or-other-session'],
    },
    { id: 'claim-1', kind: 'quote', text: 'The bill passed.', evidenceIds: ['final-a'] },
    { id: 'claim-1', kind: 'analysis', text: 'An unsupported recommendation', evidenceIds: [] },
  ])('rejects invalid evidence or an altered quote: $text', async (claim) => {
    const tool = createGeneratePostHearingSummaryTool({
      completeJson: async () => ({ claims: [claim] }),
    } as any);
    await expect(tool.handler(input, {} as any)).rejects.toThrow();
  });
});
