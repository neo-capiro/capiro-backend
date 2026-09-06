import { describe, expect, it, jest } from '@jest/globals';
import { completeMeriSummary } from './meri-summary-completion.js';

const credential = {
  apiKey: 'test-only',
  model: 'tenant-model',
  usedTenantKey: true,
  modelOverridden: true,
};

describe('rolling summary provider continuity', () => {
  it('summarizes for an OpenAI-only V3 tenant and preserves its explicit model override', async () => {
    const completeLegacy = jest.fn(async () => {
      throw new Error('Anthropic not configured');
    });
    const fetchImpl = jest.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            status: 'completed',
            output: [
              {
                type: 'message',
                content: [
                  {
                    type: 'output_text',
                    text: 'Keep the enacted-funding constraint.',
                  },
                ],
              },
            ],
          }),
        ),
    );
    const result = await completeMeriSummary({
      runtime: 'meriv3',
      system: 'summary rules',
      user: 'earlier constraint',
      resolveOpenAi: async () => credential,
      completeLegacy,
      fetchImpl,
    });
    expect(result).toBe('Keep the enacted-funding constraint.');
    expect(completeLegacy).not.toHaveBeenCalled();
    const sent = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(sent).toMatchObject({
      model: 'tenant-model',
      store: false,
      instructions: 'summary rules',
    });
  });

  it('does not silently switch providers or accept incomplete output', async () => {
    const completeLegacy = jest.fn(async () => 'legacy');
    await expect(
      completeMeriSummary({
        runtime: 'meriv3',
        system: '',
        user: '',
        resolveOpenAi: async () => credential,
        completeLegacy,
        fetchImpl: async () =>
          new Response(JSON.stringify({ status: 'incomplete', output_text: 'partial' })),
      }),
    ).rejects.toThrow('incomplete');
    expect(completeLegacy).not.toHaveBeenCalled();
  });

  it('reports missing OpenAI credentials and leaves the legacy completion untouched', async () => {
    const completeLegacy = jest.fn(async () => 'legacy');
    await expect(
      completeMeriSummary({
        runtime: 'meriv3',
        system: '',
        user: '',
        resolveOpenAi: async () => null,
        completeLegacy,
      }),
    ).rejects.toThrow('OpenAI credential missing');
    expect(completeLegacy).not.toHaveBeenCalled();
  });

  it('retains the existing completion path for legacy conversations', async () => {
    const resolveOpenAi = jest.fn(async () => null);
    expect(
      await completeMeriSummary({
        runtime: 'legacy',
        system: '',
        user: '',
        resolveOpenAi,
        completeLegacy: async () => 'Existing summary',
      }),
    ).toBe('Existing summary');
    expect(resolveOpenAi).not.toHaveBeenCalled();
  });
});
