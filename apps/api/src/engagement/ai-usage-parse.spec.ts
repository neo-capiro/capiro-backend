import { describe, expect, it } from '@jest/globals';
import { parseProviderUsage } from './ai-usage-parse.js';

describe('parseProviderUsage', () => {
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

  it('parses Anthropic prompt-cache counters (W3.3)', () => {
    const raw = {
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 200,
      },
    };
    expect(parseProviderUsage(raw)).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 900,
      cacheCreationTokens: 200,
    });
  });

  it('parses OpenAI cached prompt tokens from input_tokens_details', () => {
    const raw = {
      usage: {
        input_tokens: 1500,
        output_tokens: 800,
        input_tokens_details: { cached_tokens: 1024 },
      },
    };
    expect(parseProviderUsage(raw)).toEqual({
      inputTokens: 1500,
      outputTokens: 800,
      cacheReadTokens: 1024,
    });
  });

  it('omits cache fields when there is no cache activity', () => {
    const parsed = parseProviderUsage({ usage: { input_tokens: 10, output_tokens: 5 } });
    expect(parsed).not.toHaveProperty('cacheReadTokens');
    expect(parsed).not.toHaveProperty('cacheCreationTokens');
  });
});
