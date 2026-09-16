import {
  isGpt6,
  prepareOpenAiResponsesRequest,
  upgradeTextModel,
} from '@capiro/shared/ai-model-policy';

/** Preserve the shared client's Chat-shaped contract while GPT-6 tool calls
 * use Responses. Other/custom deployments retain their existing endpoint.
 */
export async function fetchOpenAiCompletion(
  fetchImpl: typeof fetch,
  options: RequestInit,
): Promise<Response> {
  const chat = JSON.parse(String(options.body)) as Record<string, unknown>;
  const model = upgradeTextModel(String(chat.model));
  if (!isGpt6(model)) return fetchImpl('https://api.openai.com/v1/chat/completions', options);
  const response = await fetchImpl('https://api.openai.com/v1/responses', {
    ...options,
    body: JSON.stringify(toResponsesBody({ ...chat, model })),
  });
  if (!response.ok) return response;
  const raw = (await response.json()) as Record<string, unknown>;
  return new Response(JSON.stringify(toChatResponse(raw)), {
    status: response.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function toResponsesBody(chat: Record<string, unknown>): Record<string, unknown> {
  const input: Array<Record<string, unknown>> = [];
  for (const message of (chat.messages ?? []) as Array<Record<string, unknown>>) {
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: message.content ?? '',
      });
      continue;
    }
    if (message.content) input.push({ role: message.role, content: message.content });
    for (const call of (message.tool_calls ?? []) as Array<{
      id: string;
      function: { name: string; arguments: string };
    }>) {
      input.push({
        type: 'function_call',
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      });
    }
  }
  const tools = (chat.tools ?? []) as Array<{ function: Record<string, unknown> }>;
  const choice = chat.tool_choice;
  const format = chat.response_format;
  return prepareOpenAiResponsesRequest({
    model: chat.model,
    store: false,
    input,
    max_output_tokens: chat.max_tokens ?? 8192,
    ...(chat.reasoning_effort ? { reasoning: { effort: chat.reasoning_effort } } : {}),
    ...(tools.length
      ? { tools: tools.map((tool) => ({ type: 'function', ...tool.function, strict: false })) }
      : {}),
    ...(choice
      ? {
          tool_choice:
            typeof choice === 'object'
              ? { type: 'function', name: (choice as { function: { name: string } }).function.name }
              : choice,
        }
      : {}),
    ...(format ? { text: { format } } : {}),
  });
}

export function toChatResponse(raw: Record<string, unknown>): Record<string, unknown> {
  const output = (raw.output ?? []) as Array<Record<string, unknown>>;
  const text = output
    .filter((item) => item.type === 'message')
    .flatMap((item) => (item.content ?? []) as Array<{ type: string; text?: string }>)
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text ?? '')
    .join('');
  const calls = output
    .filter((item) => item.type === 'function_call')
    .map((item) => ({
      id: item.call_id,
      type: 'function',
      function: { name: item.name, arguments: item.arguments },
    }));
  const usage = (raw.usage ?? {}) as Record<string, unknown>;
  const incomplete = raw.status === 'incomplete';
  if (raw.status === 'failed' || raw.error) throw new Error('OpenAI Responses completion failed');
  return {
    model: raw.model,
    choices: [
      {
        message: { content: text, ...(calls.length ? { tool_calls: calls } : {}) },
        finish_reason: incomplete ? 'length' : calls.length ? 'tool_calls' : 'stop',
      },
    ],
    usage: { prompt_tokens: usage.input_tokens ?? 0, completion_tokens: usage.output_tokens ?? 0 },
  };
}
