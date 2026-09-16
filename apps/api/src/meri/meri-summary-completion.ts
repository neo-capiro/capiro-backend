import { prepareOpenAiResponsesRequest } from '@capiro/shared/ai-model-policy';
interface SummaryCredential {
  apiKey: string;
  model: string;
  usedTenantKey: boolean;
  modelOverridden: boolean;
}

/** A single provider completion for the existing rolling summary, with no tools. */
export async function completeMeriSummary(args: {
  runtime: 'meriv3' | 'legacy';
  system: string;
  user: string;
  resolveOpenAi: () => Promise<SummaryCredential | null>;
  completeLegacy: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  if (args.runtime === 'legacy') return args.completeLegacy();
  const credential = await args.resolveOpenAi();
  if (!credential) throw new Error('MeriV3 summary unavailable: OpenAI credential missing');
  const model =
    credential.usedTenantKey && credential.modelOverridden
      ? credential.model
      : process.env.MERIV3_FAST_MODEL?.trim() || 'gpt-6-astra';
  const response = await (args.fetchImpl ?? fetch)('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credential.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(prepareOpenAiResponsesRequest({
      model,
      store: false,
      instructions: args.system,
      input: [{ role: 'user', content: args.user }],
      max_output_tokens: 4096,
    })),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`MeriV3 summary unavailable: OpenAI HTTP ${response.status}`);
  const result = (await response.json()) as {
    status?: string;
    output_text?: string;
    output?: Array<{
      type?: string;
      content?: Array<{ type?: string; text?: string }>;
    }>;
  };
  if (result.status && result.status !== 'completed') {
    throw new Error(`MeriV3 summary unavailable: OpenAI response ${result.status}`);
  }
  const text =
    result.output_text ??
    (result.output ?? [])
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === 'output_text')
      .map((part) => part.text ?? '')
      .join('');
  if (!text.trim()) throw new Error('MeriV3 summary unavailable: empty provider output');
  return text.trim();
}
