/**
 * Model-aware reasoning/thinking request shaping for the outreach generation
 * client.
 *
 * WHY THIS IS A CAPABILITY LOOKUP AND NOT A CONSTANT
 *
 * The last time a flat sampling constant was added to the shared completion
 * client it took down every outreach generation: the pinned planning model began
 * rejecting any non-default `temperature` with a 400, and because the parameter
 * was sent unconditionally EVERY draft failed at the plan step with
 * PLAN_GENERATION_FAILED (see the removed comment in message-plan.service.ts).
 * Reasoning parameters are a worse version of the same hazard, because the shape
 * that a model accepts changed twice:
 *
 *   - Anthropic `thinking: {type:'enabled', budget_tokens:N}` is the pre-4.6
 *     shape. It is DEPRECATED on Opus/Sonnet 4.6 and REJECTED WITH A 400 on
 *     Opus 4.7/4.8/5, Sonnet 5 and Fable 5. `thinking: {type:'adaptive'}` plus
 *     `output_config.effort` is the current shape, and `output_config.effort`
 *     ERRORS on Sonnet 4.5 / Haiku 4.5 — which is exactly what ANTHROPIC_MODEL
 *     still defaults to in this repo.
 *   - OpenAI `reasoning.effort` is accepted by o-series, GPT-5 and GPT-6.
 *     Legacy application selections are upgraded before this capability check.
 *
 * So the contract here is: send a reasoning parameter ONLY to a model this file
 * positively knows accepts that exact shape, and otherwise send nothing at all
 * and leave the request byte-identical to today's. A tenant BYOK model id is not
 * knowable in advance, which makes "unknown ⇒ send nothing" the only safe
 * default — an unrecognized model loses reasoning depth, it does not 400.
 */

/**
 * Capiro-internal effort ladder. Deliberately Anthropic's vocabulary, because it
 * is the strictly richer of the two; OpenAI's narrower set is derived from it in
 * `openAiReasoningEffort`.
 */
export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return (REASONING_EFFORTS as readonly string[]).includes(value);
}

/**
 * Anthropic families that accept `thinking:{type:'adaptive'}` +
 * `output_config.effort`.
 *
 * Everything absent from this list — notably `claude-haiku-4-5` and
 * `claude-sonnet-4-5`, and every `claude-3*` — gets NO thinking parameter. The
 * pre-4.6 `budget_tokens` shape is deliberately not implemented: it is already
 * deprecated where it still works and a 400 everywhere newer, so supporting it
 * would add the one failure mode this module exists to prevent.
 */
const ANTHROPIC_ADAPTIVE_THINKING_PATTERNS = [
  /^claude-opus-(4-6|4-7|4-8|5)/i,
  /^claude-sonnet-(4-6|5)/i,
  /^claude-(fable|mythos)-5/i,
];

/**
 * Models whose effort ladder has no `xhigh` rung.
 *
 * `xhigh` was introduced with Opus 4.7. The 4.6 generation supports
 * low/medium/high/max, so an `xhigh` request there is clamped DOWN to `high`
 * rather than up to `max` — silently spending more than asked is worse than
 * silently spending less.
 */
const NO_XHIGH_PATTERNS = [/^claude-opus-4-6/i, /^claude-sonnet-4-6/i];

/** OpenAI families that accept `reasoning.effort` on the Responses API. */
const OPENAI_REASONING_PATTERNS = [/^gpt-[56]/i, /^o[1-9]/i];

function matches(model: string, patterns: readonly RegExp[]): boolean {
  const trimmed = model.trim();
  if (!trimmed) return false;
  return patterns.some((pattern) => pattern.test(trimmed));
}

export function anthropicSupportsAdaptiveThinking(model: string): boolean {
  return matches(model, ANTHROPIC_ADAPTIVE_THINKING_PATTERNS);
}

export function openAiSupportsReasoningEffort(model: string): boolean {
  return matches(model, OPENAI_REASONING_PATTERNS);
}

/** True when `model` will accept SOME reasoning parameter from this module. */
export function supportsReasoning(provider: 'openai' | 'anthropic', model: string): boolean {
  return provider === 'openai'
    ? openAiSupportsReasoningEffort(model)
    : anthropicSupportsAdaptiveThinking(model);
}

/** The effort value to put in Anthropic's `output_config.effort`. */
export function anthropicEffort(model: string, effort: ReasoningEffort): ReasoningEffort {
  if (effort === 'xhigh' && matches(model, NO_XHIGH_PATTERNS)) return 'high';
  return effort;
}

/**
 * Collapse the Capiro ladder onto OpenAI's.
 *
 * GPT-6 supports the complete ladder. Older supported reasoning families retain
 * the existing high-effort ceiling when their capability set is narrower.
 */
export function openAiReasoningEffort(effort: ReasoningEffort, model?: string): ReasoningEffort {
  if (model && /^gpt-6-astra/.test(model)) return effort;
  return effort === 'low' ? 'low' : effort === 'medium' ? 'medium' : 'high';
}
