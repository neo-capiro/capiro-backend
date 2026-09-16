/** Application text-model policy, verified against provider docs on 2026-09-15. */
export const OPENAI_TEXT_MODEL = 'gpt-6-astra';
export const ANTHROPIC_TEXT_MODEL = 'claude-sonnet-5';

/** Upgrade previous application choices, including saved tenant overrides.
 * Keep Opus, custom deployments, embeddings, image and speech models unchanged.
 */
export function upgradeTextModel(model: string): string {
  const value = model.trim();
  if (
    /^gpt-(?:4(?:\.1|o)(?:-(?:mini|nano))?|5(?:\.\d+)?(?:-(?:mini|nano|pro|sol|terra|luna))?)(?:-\d{4}-\d{2}-\d{2})?$/i.test(
      value,
    )
  ) {
    return OPENAI_TEXT_MODEL;
  }
  if (
    /^claude-(?:(?:3(?:-[57])?)-(?:sonnet|haiku)|(?:sonnet|haiku)-4(?:-\d+)?)(?:-\d{8})?$/i.test(
      value,
    )
  ) {
    return ANTHROPIC_TEXT_MODEL;
  }
  return value;
}

export function isGpt6(model: string): boolean {
  return /^gpt-6-astra(?:-\d{4}-\d{2}-\d{2})?$/.test(model);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Final wire guard for raw Responses callers and saved model selections. */
export function prepareOpenAiResponsesRequest(
  input: Record<string, unknown>,
  options: { defaultReasoning?: boolean } = {},
): Record<string, unknown> {
  const body = { ...input, model: upgradeTextModel(String(input.model ?? '')) };
  if (!isGpt6(body.model)) return body;
  const out: Record<string, unknown> = body;
  for (const key of ['temperature', 'top_p', 'top_logprobs', 'logprobs']) delete out[key];
  const reasoning = record(out.reasoning);
  if (out.reasoning !== undefined || options.defaultReasoning !== false) {
    out.reasoning = {
      ...reasoning,
      effort:
        !reasoning.effort || ['none', 'minimal'].includes(String(reasoning.effort))
          ? 'low'
          : reasoning.effort,
    };
  }
  if (typeof out.max_output_tokens === 'number') {
    out.max_output_tokens = Math.max(out.max_output_tokens, 8192);
  }
  if (out.prompt_cache_retention !== undefined) {
    delete out.prompt_cache_retention;
    out.prompt_cache_options = { ...record(out.prompt_cache_options), ttl: '30m' };
  }
  if (Array.isArray(out.include)) {
    out.include = out.include.filter((item) => item !== 'message.output_text.logprobs');
  }
  return out;
}

/** Sonnet 5 rejects sampling controls and manual thinking. Keep forced schema
 * calls deterministic in shape by explicitly disabling thinking; other calls
 * get adaptive thinking and enough output headroom for both thought and text.
 */
export function prepareAnthropicRequest(input: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...input,
    model: upgradeTextModel(String(input.model ?? '')),
  };
  if (body.model !== ANTHROPIC_TEXT_MODEL) return body;
  for (const key of ['temperature', 'top_p', 'top_k']) delete body[key];
  const thinking = record(body.thinking);
  const choice = record(body.tool_choice);
  if (choice.type === 'tool' || choice.type === 'any' || thinking.type === 'disabled') {
    body.thinking = { type: 'disabled' };
  } else {
    const { budget_tokens: _budget, ...adaptive } = thinking;
    body.thinking = { ...adaptive, type: 'adaptive' };
    body.output_config = { effort: 'high', ...record(body.output_config) };
    body.max_tokens = Math.max(typeof body.max_tokens === 'number' ? body.max_tokens : 0, 16_384);
  }
  return body;
}

/** Extract text by block type: Sonnet 5 may return thinking before text. */
export function anthropicResponseText(response: Record<string, unknown>): string {
  return (Array.isArray(response.content) ? response.content : [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}
