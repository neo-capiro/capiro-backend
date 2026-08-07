import { AI_PRICING } from '@capiro/shared';

/**
 * Estimated public list prices, USD per 1M tokens, verified against OpenAI's
 * model pages on 2026-08-07. The shared recorder intentionally labels cost as
 * an estimate; cached-token discounts are reported separately in usage and the
 * existing shared cost function prices all input tokens at the base input rate.
 *
 * Kept local to the V3 runtime so adopting GPT-5.6 does not require a broad
 * shared-package refactor during the canary. The exported AI_PRICING object is
 * the one recordAiUsageEvent consults at write time.
 */
Object.assign(AI_PRICING, {
  'gpt-5.6': { inputPerM: 5.0, outputPerM: 30.0 },
  'gpt-5.6-sol': { inputPerM: 5.0, outputPerM: 30.0 },
  'gpt-5.6-terra': { inputPerM: 2.5, outputPerM: 15.0 },
  'gpt-5.6-luna': { inputPerM: 1.0, outputPerM: 6.0 },
});
