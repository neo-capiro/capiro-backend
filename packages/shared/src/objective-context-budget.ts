/** Private, complete Objective context. Ordinary retrieval snippets and public
 * conversation submissions keep their separate, smaller bounds. The receiving
 * Objective SDK path must explicitly select the qualified 1M context window. */
export const OBJECTIVE_REQUIRED_CONTEXT_POLICY = 'objective-v2-required-lossless-bounded-1m';
export const OBJECTIVE_PROMPT_MAX_UTF8_BYTES = 768 * 1024;
export const OBJECTIVE_PROMPT_MAX_JSON_BYTES = 896 * 1024;
export const OBJECTIVE_PUBLICATION_MAX_BYTES = 1024 * 1024;
export class ObjectiveContextBudgetError extends Error {
  constructor() { super('Complete Objective context exceeds its approved capacity'); }
}

const utf8 = new TextEncoder();
/** Both limits matter: JSON escaping can exceed the transport allowance even
 * when the original UTF-8 text fits. No approximation from character counts. */
export function objectivePromptFitsBudget(prompt: string): boolean {
  return utf8.encode(prompt).byteLength <= OBJECTIVE_PROMPT_MAX_UTF8_BYTES &&
    utf8.encode(JSON.stringify(prompt)).byteLength <= OBJECTIVE_PROMPT_MAX_JSON_BYTES;
}
