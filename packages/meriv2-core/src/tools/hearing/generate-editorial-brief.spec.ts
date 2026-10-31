import { createGenerateEditorialBriefTool, editorialInput } from './generate-editorial-brief';

const input = {
  template: 'research_update' as const,
  cutoff: '2026-10-31T00:00:00Z',
  timezone: 'UTC',
  coverage: 'Selected research only.',
  sources: [
    {
      kind: 'research' as const,
      id: 'source-a',
      revision: 'revision-a',
      locator: 'section-a',
      text: 'Proposed legislative text.',
      authority: 'official',
    },
  ],
};

describe('retained editorial generation', () => {
  it.each(['news', 'budget', 'personnel'])(
    'does not accept retired %s source selections',
    (kind) => {
      expect(
        editorialInput.safeParse({ ...input, sources: [{ ...input.sources[0], kind }] }).success,
      ).toBe(false);
    },
  );
  it('generates only retained templates with research guidance and exact references', async () => {
    const completeWithSchema = jest.fn().mockResolvedValue({
      input: {
        claims: [
          {
            kind: 'fact',
            text: 'Proposed legislative text.',
            references: [{ id: 'source-a', revision: 'revision-a', locator: 'section-a' }],
          },
        ],
      },
    });
    const tool = createGenerateEditorialBriefTool({ completeWithSchema } as never);
    expect(editorialInput.safeParse({ ...input, template: 'morning_news_brief' }).success).toBe(
      false,
    );
    expect(await tool.handler(input, {} as never)).toMatchObject({
      promptVersion: 'capiro-editorial-v2',
    });
    const request = completeWithSchema.mock.calls[0]![0];
    expect(request.system).toContain('Distinguish proposed legislation');
    expect(request.system).not.toMatch(/Morning News Brief|Attribute news|Personnel announcements/);
    expect(tool.description).toContain('legislative research evidence');
  });
});
