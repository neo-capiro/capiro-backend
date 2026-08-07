import { computeAiCostUsd } from '@capiro/shared';
import './meriv3-pricing.js';

describe('MeriV3 GPT-5.6 pricing registration', () => {
  test.each([
    ['gpt-5.6-luna', 1.0, 6.0],
    ['gpt-5.6-terra', 2.5, 15.0],
    ['gpt-5.6', 5.0, 30.0],
    ['gpt-5.6-sol', 5.0, 30.0],
  ] as const)('%s registers the public input/output estimate', (model, input, output) => {
    expect(computeAiCostUsd(model, 1_000_000, 0)).toBe(input);
    expect(computeAiCostUsd(model, 0, 1_000_000)).toBe(output);
  });
});
