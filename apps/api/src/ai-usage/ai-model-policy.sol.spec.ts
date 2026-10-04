import { describe, expect, test } from '@jest/globals';
import {
  OPENAI_TEXT_MODEL,
  isGpt6,
  prepareOpenAiResponsesRequest,
} from '@capiro/shared/ai-model-policy';
import { computeAiCostUsd } from '@capiro/shared';

describe('gpt-6.1-sol Responses request normalization', () => {
  test('routes exact Sol through the existing Responses transport and strips unsupported includes', () => {
    expect(isGpt6('gpt-6.1-sol')).toBe(true);
    expect(isGpt6('gpt-6.1-sol-2026-10-03')).toBe(false);
    const input = {
      model: 'gpt-6.1-sol',
      include: ['reasoning.encrypted_content', 'message.output_text.logprobs'],
      prompt_cache_retention: '24h',
    };
    const request = prepareOpenAiResponsesRequest(input);
    expect(request.include).toEqual(['reasoning.encrypted_content']);
    expect(request).not.toHaveProperty('prompt_cache_retention');
    expect(request.prompt_cache_options).toEqual({ ttl: '30m' });
    expect(input.include).toHaveLength(2);
  });

  test('prices Sol without the unknown-model zero and applies long-context rates only above 272K', () => {
    expect(computeAiCostUsd('gpt-6.1-sol', 1_000, 1_000)).toBeCloseTo(0.012);
    expect(computeAiCostUsd('gpt-6.1-sol', 272_000, 1_000)).toBeCloseTo(0.554);
    expect(computeAiCostUsd('gpt-6.1-sol', 272_001, 1_000)).toBeCloseTo(1.103004);
    expect(computeAiCostUsd('gpt-6-astra', 272_001, 1_000)).toBeCloseTo(2.77001);
    expect(computeAiCostUsd('custom-deployment', 1_000, 1_000)).toBe(0);
  });
  test('normalizes only the exact Sol model and preserves its bounded output limit', () => {
    const request = prepareOpenAiResponsesRequest({
      model: 'gpt-6.1-sol',
      reasoning: { effort: 'minimal', summary: 'auto' },
      temperature: 0.2,
      top_p: 0.5,
      top_logprobs: 3,
      logprobs: true,
      max_output_tokens: 2048,
    });

    expect(request).toMatchObject({
      model: 'gpt-6.1-sol',
      reasoning: { effort: 'low', summary: 'auto' },
      max_output_tokens: 2048,
    });
    expect(request).not.toHaveProperty('temperature');
    expect(request).not.toHaveProperty('top_p');
    expect(request).not.toHaveProperty('top_logprobs');
    expect(request).not.toHaveProperty('logprobs');
  });

  test.each(['low', 'medium', 'high', 'xhigh', 'max'])(
    'preserves supported effort %s',
    (effort) => {
      expect(
        prepareOpenAiResponsesRequest({ model: 'gpt-6.1-sol', reasoning: { effort } }).reasoning,
      ).toEqual({ effort });
    },
  );

  test('defaults absent or unknown effort to medium, but honors omitted default reasoning', () => {
    expect(prepareOpenAiResponsesRequest({ model: 'gpt-6.1-sol' }).reasoning).toEqual({
      effort: 'medium',
    });
    expect(
      prepareOpenAiResponsesRequest({ model: 'gpt-6.1-sol' }, { defaultReasoning: false }),
    ).not.toHaveProperty('reasoning');
    expect(
      prepareOpenAiResponsesRequest({ model: 'gpt-6.1-sol', reasoning: { effort: 'invalid' } })
        .reasoning,
    ).toEqual({ effort: 'medium' });
  });

  test('does not broaden to dated Sol names and leaves other models unchanged', () => {
    const datedSol = {
      model: 'gpt-6.1-sol-20261003',
      reasoning: { effort: 'minimal' },
      temperature: 0.2,
      max_output_tokens: 2048,
    };
    expect(prepareOpenAiResponsesRequest(datedSol)).toEqual(datedSol);

    const astra = prepareOpenAiResponsesRequest({
      model: OPENAI_TEXT_MODEL,
      reasoning: { effort: 'none' },
      max_output_tokens: 2048,
    });
    expect(astra).toMatchObject({
      model: OPENAI_TEXT_MODEL,
      reasoning: { effort: 'low' },
      max_output_tokens: 8192,
    });
  });
});
