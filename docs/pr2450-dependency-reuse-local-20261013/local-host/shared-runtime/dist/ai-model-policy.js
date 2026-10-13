"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ANTHROPIC_TEXT_MODEL = exports.OPENAI_TEXT_MODEL = void 0;
exports.upgradeTextModel = upgradeTextModel;
exports.isGpt6 = isGpt6;
exports.prepareOpenAiResponsesRequest = prepareOpenAiResponsesRequest;
exports.prepareAnthropicRequest = prepareAnthropicRequest;
exports.anthropicResponseText = anthropicResponseText;
/** Application text-model policy, verified against provider docs on 2026-09-15. */
exports.OPENAI_TEXT_MODEL = 'gpt-6-astra';
exports.ANTHROPIC_TEXT_MODEL = 'claude-sonnet-5';
/** Upgrade previous application choices, including saved tenant overrides.
 * Keep Opus, custom deployments, embeddings, image and speech models unchanged.
 */
function upgradeTextModel(model) {
    const value = model.trim();
    if (/^(?:gpt-(?:4(?:\.1|o)(?:-(?:mini|nano))?|5(?:\.\d+)?(?:-(?:mini|nano|pro|sol|terra|luna))?)|o3|o4-mini)(?:-\d{4}-\d{2}-\d{2})?$/i.test(value)) {
        return exports.OPENAI_TEXT_MODEL;
    }
    if (/^claude-(?:(?:3(?:-[57])?)-(?:sonnet|haiku)|(?:sonnet|haiku)-4(?:-\d+)?)(?:-\d{8})?$/i.test(value)) {
        return exports.ANTHROPIC_TEXT_MODEL;
    }
    return value;
}
function isGpt6(model) {
    return /^gpt-6-astra(?:-\d{4}-\d{2}-\d{2})?$/.test(model) || model === 'gpt-6.1-sol';
}
/** Exact Sol model id for Responses normalization; do not infer dated snapshots. */
function isGpt61Sol(model) {
    return model === 'gpt-6.1-sol';
}
function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {};
}
/** Final wire guard for raw Responses callers and saved model selections. */
function prepareOpenAiResponsesRequest(input, options = {}) {
    const body = { ...input, model: upgradeTextModel(String(input.model ?? '')) };
    const gpt6 = isGpt6(body.model);
    const gpt61Sol = isGpt61Sol(body.model);
    if (!gpt6)
        return body;
    const out = body;
    for (const key of ['temperature', 'top_p', 'top_logprobs', 'logprobs'])
        delete out[key];
    const reasoning = record(out.reasoning);
    if (out.reasoning !== undefined || options.defaultReasoning !== false) {
        const effort = String(reasoning.effort ?? '');
        const normalizedEffort = gpt61Sol
            ? !effort || !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)
                ? effort === 'none' || effort === 'minimal'
                    ? 'low'
                    : 'medium'
                : effort
            : !effort || ['none', 'minimal'].includes(effort)
                ? 'low'
                : reasoning.effort;
        out.reasoning = { ...reasoning, effort: normalizedEffort };
    }
    // Astra requires this floor. Sol's caller limit is a bounded capture and
    // budget reservation; never silently raise it here.
    if (gpt6 && !gpt61Sol && typeof out.max_output_tokens === 'number') {
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
function prepareAnthropicRequest(input) {
    const body = {
        ...input,
        model: upgradeTextModel(String(input.model ?? '')),
    };
    // Opaque OpenAI continuation state belongs only on OpenAI requests; visible
    // text and tool blocks remain available during a configured provider failover.
    if (Array.isArray(body.messages)) {
        body.messages = body.messages.map((message) => ({
            ...message,
            ...(Array.isArray(message.content)
                ? {
                    content: message.content.filter((block) => block.type !== 'openai_response_state'),
                }
                : {}),
        }));
    }
    if (body.model !== exports.ANTHROPIC_TEXT_MODEL)
        return body;
    for (const key of ['temperature', 'top_p', 'top_k'])
        delete body[key];
    const thinking = record(body.thinking);
    const choice = record(body.tool_choice);
    if (choice.type === 'tool' || choice.type === 'any' || thinking.type === 'disabled') {
        body.thinking = { type: 'disabled' };
    }
    else {
        const { budget_tokens: _budget, ...adaptive } = thinking;
        body.thinking = { ...adaptive, type: 'adaptive' };
        body.output_config = { effort: 'high', ...record(body.output_config) };
        body.max_tokens = Math.max(typeof body.max_tokens === 'number' ? body.max_tokens : 0, 16_384);
    }
    return body;
}
/** Extract text by block type: Sonnet 5 may return thinking before text. */
function anthropicResponseText(response) {
    return (Array.isArray(response.content) ? response.content : [])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('');
}
//# sourceMappingURL=ai-model-policy.js.map