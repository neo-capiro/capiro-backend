/** @cleanup-smoke noArgsExit=2 helpExit=0 */
/**
 * Smoke test: verify the Meri chat brain performs Anthropic-native tool use
 * over the streaming endpoint. It POSTs a tool-forcing prompt to
 * /api/clio/conversations/:id/stream, parses the SSE stream, and asserts that
 * at least one `tool_call` event fires before `done` (i.e. the model actually
 * invoked a Capiro tool rather than answering from prompt context alone).
 *
 *   CLIO_SMOKE_BASE_URL=https://<env-host> \
 *   CLIO_SMOKE_TOKEN=<clerk-jwt> \
 *   CLIO_SMOKE_CONVERSATION_ID=<uuid> \
 *   pnpm --filter @capiro/api exec tsx scripts/smoke-clio-tooluse.ts
 *
 * Optional:
 *   CLIO_SMOKE_PROMPT  - override the prompt (default forces a federal-data tool)
 *   CLIO_SMOKE_TIMEOUT_MS - overall timeout (default 120000)
 *
 * Requires a running API, a valid auth token, and an existing Meri conversation
 * owned by that token's user. The endpoint requires the trace flag (#trace) to
 * emit tool_call events, so the default prompt appends it.
 *
 * Exit code 0 = a tool_call was observed; non-zero = failure (with reason).
 */

interface SseEvent {
  type: string;
  tool?: string;
  message?: string;
  [k: string]: unknown;
}

const usage = 'Usage: smoke-clio-tooluse [--help] (requires CLIO_SMOKE_BASE_URL, CLIO_SMOKE_TOKEN, and CLIO_SMOKE_CONVERSATION_ID)';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log(usage);
  process.exit(0);
}
if (args.length > 0) {
  console.error(usage);
  process.exit(2);
}
if (!process.env.CLIO_SMOKE_BASE_URL || !process.env.CLIO_SMOKE_TOKEN || !process.env.CLIO_SMOKE_CONVERSATION_ID) {
  console.error(usage);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[smoke-clio-tooluse] Missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  const baseUrl = requireEnv('CLIO_SMOKE_BASE_URL').replace(/\/$/, '');
  const token = requireEnv('CLIO_SMOKE_TOKEN');
  const conversationId = requireEnv('CLIO_SMOKE_CONVERSATION_ID');
  const timeoutMs = Number(process.env.CLIO_SMOKE_TIMEOUT_MS || 120_000);
  // #trace makes the backend emit tool_call events; the prompt steers the model
  // toward a concrete federal-data lookup that should require a tool.
  const prompt =
    process.env.CLIO_SMOKE_PROMPT ||
    'Search the Capiro database for recent congressional bills about artificial intelligence and list two with their bill numbers and sponsors. #trace';

  const url = `${baseUrl}/api/clio/conversations/${encodeURIComponent(conversationId)}/stream`;
  console.log(`[smoke-clio-tooluse] POST ${url}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ body: prompt }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    console.error(`[smoke-clio-tooluse] FAIL: request error: ${(err as Error).message}`);
    process.exit(1);
  }

  if (!res.ok || !res.body) {
    clearTimeout(timer);
    const text = await res.text().catch(() => '');
    console.error(`[smoke-clio-tooluse] FAIL: HTTP ${res.status} ${text.slice(0, 300)}`);
    process.exit(1);
  }

  const events: SseEvent[] = [];
  let sawToolCall = false;
  let sawDone = false;
  let sawError: string | null = null;
  let textChars = 0;

  const decoder = new TextDecoder();
  const reader = (res.body as unknown as ReadableStream<Uint8Array>).getReader();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (!payload) continue;
        let evt: SseEvent;
        try {
          evt = JSON.parse(payload) as SseEvent;
        } catch {
          continue;
        }
        events.push(evt);
        if (evt.type === 'tool_call') {
          sawToolCall = true;
          console.log(`[smoke-clio-tooluse] tool_call -> ${evt.tool}`);
        } else if (evt.type === 'text' && typeof evt.text === 'string') {
          textChars += evt.text.length;
        } else if (evt.type === 'error') {
          sawError = String(evt.message ?? 'unknown error');
        } else if (evt.type === 'done') {
          sawDone = true;
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }

  const eventTypes = Array.from(new Set(events.map((e) => e.type))).join(', ');
  console.log(`[smoke-clio-tooluse] event types seen: ${eventTypes}`);
  console.log(`[smoke-clio-tooluse] text chars streamed: ${textChars}`);

  if (sawError) {
    console.error(`[smoke-clio-tooluse] FAIL: stream emitted error: ${sawError}`);
    process.exit(1);
  }
  if (!sawDone) {
    console.error('[smoke-clio-tooluse] FAIL: stream ended without a `done` event');
    process.exit(1);
  }
  if (!sawToolCall) {
    console.error(
      '[smoke-clio-tooluse] FAIL: no `tool_call` event observed. The model answered without invoking a Capiro tool. ' +
        'Check that tool schemas are wired into streamMessage and that #trace was honored.',
    );
    process.exit(1);
  }

  console.log('[smoke-clio-tooluse] PASS: tool_call observed and stream completed.');
  process.exit(0);
}

main().catch((err) => {
  console.error(`[smoke-clio-tooluse] FAIL: unexpected error: ${(err as Error).message}`);
  process.exit(1);
});
