// Per-turn provider cost estimate from the stream's usage event, using the
// shared public base rates (packages/shared AI_PRICING). Usage aggregates every
// model call in the turn, so Sol's long-context surcharge (requests above 272K
// input tokens) is applied whenever the turn total exceeds it: an upper bound.
const RATES = { 'gpt-6.1-sol': [2, 10], 'gpt-6-astra': [10, 50] };
export function turnCostMicros(model, usage) {
  const [input, output] = RATES[model] ?? RATES['gpt-6-astra'];
  const long = model === 'gpt-6.1-sol' && (usage?.inputTokens ?? 0) > 272_000;
  return Math.round((usage?.inputTokens ?? 0) * input * (long ? 2 : 1) + (usage?.outputTokens ?? 0) * output * (long ? 1.5 : 1));
}
