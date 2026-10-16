/** The resolved tenant AI credential forwarded to the current chat runtime. */
export interface ResolvedAiForChatHeader {
  provider: 'anthropic' | 'openai';
  apiKey: string;
  model: string;
  usedTenantKey: boolean;
  modelOverridden: boolean;
}
