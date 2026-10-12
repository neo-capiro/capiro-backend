/** @cleanup-smoke noArgsExit=2 helpExit=0 */
/**
 * Smoke test: verify Meri Deep Research actually produces a REPORT, not just a
 * list of the sources it searched.
 *
 * Regression guard for the "it only tells me what it searched" bug, where the
 * agentic loop exhausted all tool rounds and never emitted the report prose.
 * This drives the full research flow over the real HTTP endpoints:
 *   1. POST /api/clio/research                      -> create a session
 *   2. POST /api/clio/research/:id/plan/stream      -> plan + clarifying questions (SSE)
 *   3. POST /api/clio/research/:id/clarify          -> submit answers (skip = {})
 *   4. POST /api/clio/research/:id/stream           -> agentic research + report (SSE)
 *
 * On the research stream it asserts that meaningful report text streamed (via
 * `text` events) OR a final `report` event with a non-trivial body arrived,
 * before `done`, with no `error`. The forced-synthesis fallback in
 * MeriResearchService guarantees this even if the model spends every round on
 * tools — so a failure here means that guarantee regressed.
 *
 * Lives in apps/api/scripts/ in the Capiro repo. Run:
 *   CLIO_SMOKE_BASE_URL=https://<env-host> \
 *   CLIO_SMOKE_TOKEN=<clerk-jwt> \
 *   pnpm --filter @capiro/api exec tsx scripts/smoke-clio-research.ts
 *
 * Optional env:
 *   CLIO_SMOKE_TOPIC    (override the research topic)
 *   CLIO_SMOKE_CLIENT_ID (associate the session with a client UUID)
 *   CLIO_SMOKE_TIMEOUT_MS (default 240000 — research is slower than chat)
 *   CLIO_SMOKE_MIN_REPORT_CHARS (default 400 — minimum prose to count as a report)
 *
 * Requires a running API and a valid token. Exit 0 = a real report was produced.
 */

interface SseEvent {
  type: string;
  phase?: string;
  questions?: string[];
  text?: string;
  body?: string;
  message?: string;
  [k: string]: unknown;
}

const usage = 'Usage: smoke-clio-research [--help] (requires CLIO_SMOKE_BASE_URL and CLIO_SMOKE_TOKEN)';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log(usage);
  process.exit(0);
}
if (args.length > 0) {
  console.error(usage);
  process.exit(2);
}
if (!process.env.CLIO_SMOKE_BASE_URL || !process.env.CLIO_SMOKE_TOKEN) {
  console.error(usage);
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[smoke-clio-research] Missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

const BASE = requireEnv('CLIO_SMOKE_BASE_URL').replace(/\/$/, '');
const TOKEN = requireEnv('CLIO_SMOKE_TOKEN');
const TIMEOUT_MS = Number(process.env.CLIO_SMOKE_TIMEOUT_MS || 240_000);
const MIN_REPORT_CHARS = Number(process.env.CLIO_SMOKE_MIN_REPORT_CHARS || 400);

function authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'text/event-stream',
  };
}

/** POST an SSE endpoint and dispatch each parsed event to `onEvent`. */
async function streamSse(
  url: string,
  body: Record<string, unknown> | undefined,
  onEvent: (e: SseEvent) => void,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: authHeaders(),
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    const decoder = new TextDecoder();
    const reader = (res.body as unknown as ReadableStream<Uint8Array>).getReader();
    let buffer = '';
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
        onEvent(evt);
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const topic =
    process.env.CLIO_SMOKE_TOPIC ||
    'Recent congressional activity on artificial intelligence policy: key bills, sponsors, and what a lobbying client should watch over the next 60 days.';
  const clientId = process.env.CLIO_SMOKE_CLIENT_ID || undefined;

  // 1) Create session
  console.log('[smoke-clio-research] creating session…');
  const createRes = await fetch(`${BASE}/api/clio/research`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ topic, clientId }),
  });
  if (!createRes.ok) {
    const t = await createRes.text().catch(() => '');
    console.error(`[smoke-clio-research] FAIL: create HTTP ${createRes.status} ${t.slice(0, 300)}`);
    process.exit(1);
  }
  const { id } = (await createRes.json()) as { id: string };
  console.log(`[smoke-clio-research] session ${id}`);

  // 2) Plan stream — expect plan + clarifying questions, ending in `done`.
  let planQuestions = 0;
  let planDone = false;
  let planError: string | null = null;
  await streamSse(`${BASE}/api/clio/research/${id}/plan/stream`, undefined, (e) => {
    if (e.type === 'clarify' && Array.isArray(e.questions)) planQuestions = e.questions.length;
    else if (e.type === 'error') planError = String(e.message ?? 'unknown');
    else if (e.type === 'done') planDone = true;
  });
  if (planError) {
    console.error(`[smoke-clio-research] FAIL: plan stream error: ${planError}`);
    process.exit(1);
  }
  if (!planDone) {
    console.error('[smoke-clio-research] FAIL: plan stream ended without `done`');
    process.exit(1);
  }
  console.log(`[smoke-clio-research] plan ok (${planQuestions} clarifying questions)`);

  // 3) Clarify — skip (empty answers) so Meri uses its own judgment.
  const clarifyRes = await fetch(`${BASE}/api/clio/research/${id}/clarify`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ answers: {} }),
  });
  if (!clarifyRes.ok) {
    const t = await clarifyRes.text().catch(() => '');
    console.error(`[smoke-clio-research] FAIL: clarify HTTP ${clarifyRes.status} ${t.slice(0, 300)}`);
    process.exit(1);
  }

  // 4) Research stream — THE ASSERTION: real report text must arrive before done.
  console.log('[smoke-clio-research] running research (this is slow)…');
  let textChars = 0;
  let reportBodyChars = 0;
  let sawStep = false;
  let sawDone = false;
  let runError: string | null = null;
  const phases = new Set<string>();
  await streamSse(`${BASE}/api/clio/research/${id}/stream`, undefined, (e) => {
    if (e.type === 'phase' && typeof e.phase === 'string') phases.add(e.phase);
    else if (e.type === 'step') sawStep = true;
    else if (e.type === 'text' && typeof e.text === 'string') textChars += e.text.length;
    else if (e.type === 'report' && typeof e.body === 'string') reportBodyChars = e.body.length;
    else if (e.type === 'error') runError = String(e.message ?? 'unknown');
    else if (e.type === 'done') sawDone = true;
  });

  console.log(`[smoke-clio-research] phases: ${Array.from(phases).join(', ') || '(none)'}`);
  console.log(`[smoke-clio-research] steps seen: ${sawStep}; text chars: ${textChars}; report body chars: ${reportBodyChars}`);

  if (runError) {
    console.error(`[smoke-clio-research] FAIL: research stream error: ${runError}`);
    process.exit(1);
  }
  if (!sawDone) {
    console.error('[smoke-clio-research] FAIL: research stream ended without `done`');
    process.exit(1);
  }

  // The core regression assertion: a real report (streamed text or a final
  // report body) above the minimum length. Sources-only (steps but no prose)
  // is exactly the bug this guards against.
  const producedReport = Math.max(textChars, reportBodyChars);
  if (producedReport < MIN_REPORT_CHARS) {
    console.error(
      `[smoke-clio-research] FAIL: only ${producedReport} chars of report produced ` +
        `(min ${MIN_REPORT_CHARS}). The run searched but did not write a report — ` +
        'the forced-synthesis fallback in MeriResearchService may have regressed.',
    );
    process.exit(1);
  }

  console.log(
    `[smoke-clio-research] PASS: research produced a ${producedReport}-char report and completed.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(`[smoke-clio-research] FAIL: unexpected error: ${(err as Error).message}`);
  process.exit(1);
});
