/** Application text-model policy, verified against provider docs on 2026-09-15. */
export declare const OPENAI_TEXT_MODEL = "gpt-6-astra";
export declare const ANTHROPIC_TEXT_MODEL = "claude-sonnet-5";
/** Upgrade previous application choices, including saved tenant overrides.
 * Keep Opus, custom deployments, embeddings, image and speech models unchanged.
 */
export declare function upgradeTextModel(model: string): string;
export declare function isGpt6(model: string): boolean;
/** Final wire guard for raw Responses callers and saved model selections. */
export declare function prepareOpenAiResponsesRequest(input: Record<string, unknown>, options?: {
    defaultReasoning?: boolean;
}): Record<string, unknown>;
/** Sonnet 5 rejects sampling controls and manual thinking. Keep forced schema
 * calls deterministic in shape by explicitly disabling thinking; other calls
 * get adaptive thinking and enough output headroom for both thought and text.
 */
export declare function prepareAnthropicRequest(input: Record<string, unknown>): Record<string, unknown>;
/** Extract text by block type: Sonnet 5 may return thinking before text. */
export declare function anthropicResponseText(response: Record<string, unknown>): string;
//# sourceMappingURL=ai-model-policy.d.ts.map