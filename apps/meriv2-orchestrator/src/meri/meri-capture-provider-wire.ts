import { currentServerReadonlyCapturePolicy } from '../request/trusted-current-turn-scope.js';

/** The authenticated capture scope, never an ordinary model/config override. */
export function captureProviderWireActive(): boolean {
  return (
    currentServerReadonlyCapturePolicy()?.expectedCaptureWrites[3] === 'provider_budget_ledger'
  );
}
const fail = (): never => {
  throw new Error('meri_capture_provider_wire_unqualified');
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string): void {
  const names = new Set(allowed.split(' '));
  if (Object.keys(value).some((key) => !names.has(key))) fail();
}
function textParts(value: unknown, types: string[]): void {
  if (!Array.isArray(value)) return fail();
  for (const raw of value) {
    const part = record(raw);
    keys(part, 'type text annotations logprobs refusal');
    if (
      !types.includes(String(part.type)) ||
      (part.type === 'refusal' ? typeof part.refusal !== 'string' : typeof part.text !== 'string')
    )
      fail();
  }
}
function inputItem(raw: unknown): void {
  const item = record(raw);
  if (item.type === undefined || item.type === 'message') {
    keys(item, 'type id role content status');
    if (!['user', 'assistant', 'system', 'developer'].includes(String(item.role))) fail();
    if (typeof item.content !== 'string')
      textParts(item.content, ['input_text', 'output_text', 'refusal']);
  } else if (item.type === 'function_call') {
    keys(item, 'type id call_id name arguments status');
    if (
      typeof item.call_id !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.arguments !== 'string'
    )
      fail();
  } else if (item.type === 'function_call_output') {
    keys(item, 'type id call_id output status');
    if (typeof item.call_id !== 'string' || typeof item.output !== 'string') fail();
  } else if (item.type === 'reasoning') {
    keys(item, 'type id summary content encrypted_content status');
    if (item.summary !== undefined) textParts(item.summary, ['summary_text']);
    if (item.content !== undefined) textParts(item.content, ['reasoning_text']);
    if (item.encrypted_content !== undefined && typeof item.encrypted_content !== 'string') fail();
  } else fail();
}

/** Validate priced units and select Standard/default before hashing or reserving bytes. */
export function prepareCaptureOpenAiBody(body: Record<string, unknown>): Record<string, unknown> {
  if (!captureProviderWireActive()) return body;
  keys(
    body,
    'model instructions input tools tool_choice parallel_tool_calls reasoning max_output_tokens store safety_identifier include text service_tier',
  );
  if (body.service_tier !== undefined && body.service_tier !== 'default') fail();
  if (
    body.store !== false ||
    typeof body.model !== 'string' ||
    !Number.isSafeInteger(body.max_output_tokens) ||
    Number(body.max_output_tokens) <= 0
  )
    fail();
  if (body.instructions !== undefined && typeof body.instructions !== 'string') fail();
  if (typeof body.input !== 'string') {
    if (!Array.isArray(body.input)) return fail();
    body.input.forEach(inputItem);
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) return fail();
    for (const raw of body.tools) {
      const tool = record(raw);
      keys(tool, 'type name description parameters strict');
      if (tool.type !== 'function' || typeof tool.name !== 'string') fail();
    }
  }
  if (body.tool_choice !== undefined) {
    if (typeof body.tool_choice === 'string') {
      if (!['auto', 'none', 'required'].includes(body.tool_choice)) fail();
    } else {
      const choice = record(body.tool_choice);
      keys(choice, 'type name');
      if (choice.type !== 'function' || typeof choice.name !== 'string') fail();
    }
  }
  if (
    body.include !== undefined &&
    (!Array.isArray(body.include) || body.include.some((x) => x !== 'reasoning.encrypted_content'))
  )
    fail();
  return { ...body, service_tier: 'default' };
}

/** Only existing accounted provider transports are eligible; no URL substring admission. */
export function prepareCaptureProviderFetch(
  args: Parameters<typeof fetch>,
): Parameters<typeof fetch> {
  if (!captureProviderWireActive()) return args;
  const [request, init] = args;
  if (
    !(typeof request === 'string' || request instanceof URL) ||
    init?.method !== 'POST' ||
    typeof init.body !== 'string'
  )
    return fail();
  const url = String(request);
  if (
    ![
      'https://api.openai.com/v1/responses',
      'https://api.anthropic.com/v1/messages',
      'https://api.typesafe.ai/v1/systemone',
    ].includes(url)
  )
    return fail();
  let body: Record<string, unknown>;
  try {
    body = record(JSON.parse(init.body));
  } catch {
    return fail();
  }
  return [
    request,
    {
      ...init,
      redirect: 'error',
      body:
        url === 'https://api.openai.com/v1/responses'
          ? JSON.stringify(prepareCaptureOpenAiBody(body))
          : init.body,
    },
  ];
}
