import { createRevisionGenerator } from './revision-generator';

const generationInput = {
  affectedText: 'TITAN is not in production.',
  claim: {
    id: 'c1',
    text: 'TITAN is not in production.',
    type: 'fact' as const,
    category: 'general_background',
    sourceIds: [],
    primarySourcePresent: false,
    confidence: 'unknown' as const,
  },
  dependentSentences: [],
  evidence: [
    {
      id: 'e1',
      sourceType: 'refresh_status',
      sourceId: 'titan',
      evidenceClass: 'official_government_data' as const,
      passage: 'TITAN entered production.',
      locator: '[2]',
      primary: true,
      authoritative: true,
      requirementIds: [],
    },
  ],
  allowedEvidenceIds: ['e1'],
};

describe('revision generator', () => {
  it('sends only affected text and listed evidence with remaining timeout and reports token usage', async () => {
    const completeWithSchema = jest.fn(async (_input: Record<string, unknown>) => ({
      input: { replacementText: 'TITAN entered production [2].', citedEvidenceIds: ['e1'] },
      usage: { inputTokens: 20, outputTokens: 8 },
    }));
    const generate = createRevisionGenerator({ completeWithSchema } as never, () => 2_500);
    await expect(generate(generationInput, {})).resolves.toEqual({
      replacementText: 'TITAN entered production [2].',
      citedEvidenceIds: ['e1'],
      usage: { inputTokens: 20, outputTokens: 8 },
    });
    expect(completeWithSchema).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 2_500 }));
    const prompt = JSON.parse(String(completeWithSchema.mock.calls[0]![0].prompt));
    expect(prompt.evidence).toEqual([expect.objectContaining({ id: 'e1', citationMarker: '[2]' })]);
  });

  it('omits usage when the provider does not report it', async () => {
    const completeWithSchema = jest.fn(async () => ({
      input: { replacementText: 'TITAN entered production [2].', citedEvidenceIds: ['e1'] },
    }));
    const generate = createRevisionGenerator({ completeWithSchema } as never, () => 2_500);
    await expect(generate(generationInput, {})).resolves.toEqual({
      replacementText: 'TITAN entered production [2].',
      citedEvidenceIds: ['e1'],
    });
  });

  it('wins an abort race against a late provider result', async () => {
    const controller = new AbortController();
    const completeWithSchema = jest.fn(() => new Promise(() => {}));
    const generate = createRevisionGenerator({ completeWithSchema } as never, () => 8_000);
    const pending = generate(generationInput, { signal: controller.signal });
    controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toThrow('cancelled');
  });
});
