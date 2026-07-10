import { describe, expect, it } from '@jest/globals';
import { parseProviderUsage } from '@capiro/shared';

describe('parseProviderUsage (lifted into @capiro/shared, Phase 1 M5.0)', () => {
  it('parses OpenAI responses-API usage', () => {
    const raw = {
      id: 'resp_123',
      usage: { input_tokens: 1500, output_tokens: 800, total_tokens: 2300 },
    };
    expect(parseProviderUsage(raw)).toEqual({ inputTokens: 1500, outputTokens: 800 });
  });

  it('parses Anthropic messages usage', () => {
    const raw = {
      id: 'msg_123',
      usage: { input_tokens: 1200, output_tokens: 600 },
    };
    expect(parseProviderUsage(raw)).toEqual({ inputTokens: 1200, outputTokens: 600 });
  });

  it('returns zeros when usage is absent', () => {
    expect(parseProviderUsage({})).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('returns zeros for null / non-object raw payloads', () => {
    expect(parseProviderUsage(null)).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(parseProviderUsage('oops')).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('coerces numeric strings and clamps junk to zero', () => {
    expect(parseProviderUsage({ usage: { input_tokens: '42', output_tokens: 'NaN' } })).toEqual({
      inputTokens: 42,
      outputTokens: 0,
    });
    expect(parseProviderUsage({ usage: { input_tokens: -5, output_tokens: 3.7 } })).toEqual({
      inputTokens: 0,
      outputTokens: 3,
    });
  });
});
