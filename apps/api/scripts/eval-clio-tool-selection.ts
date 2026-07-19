/**
 * Tool-selection eval.
 * `pnpm --filter @capiro/api eval:clio:tool-selection`
 *
 * Presents the full Meri tool catalog (names + descriptions from the shared
 * MERI_TOOL_MANIFEST — the same descriptions the production schemas carry) to a
 * live model with `tool_choice: auto`, one fixture per turn, and checks the
 * FIRST tool the model reaches for against the fixture's expectation. Selection
 * keys almost entirely on the tool name + description, so manifest-derived
 * schemas exercise the real decision without bootstrapping Nest/DI for the full
 * input_schema (which governs argument generation, not which tool is chosen).
 *
 * Scoring per fixture:
 *   - expectedTool = null  -> correct iff the model calls NO tool.
 *   - expectedTool = "x"   -> correct iff the first tool_use is "x" and no
 *                             forbiddenTool was chosen.
 *
 * Gate (exit non-zero when unmet): accuracy >= TOOL_SELECT_GATE (default 0.9).
 *
 * Requires ANTHROPIC_API_KEY. Live API, manual/nightly gate — not the PR gate.
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MERI_TOOL_MANIFEST } from '@capiro/shared';
import { TOOL_SELECTION_FIXTURES } from '../src/meri/evals/tool-selection-fixtures.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLIO_MODEL ?? 'claude-sonnet-4-6';
const GATE = Number.parseFloat(process.env.TOOL_SELECT_GATE ?? '0.9');

const SYSTEM = [
  'You are Meri, an elite AI chief of staff for government-affairs professionals.',
  'Use the single most appropriate tool for the request. Prefer the direct,',
  'purpose-built tool over a broader search tool. If the message needs no tool',
  '(a greeting, thanks, or pure acknowledgement), just reply without calling one.',
].join('\n');

const TOOLS = Object.entries(MERI_TOOL_MANIFEST).map(([name, description]) => ({
  name,
  description,
  input_schema: { type: 'object', properties: {}, additionalProperties: true },
}));

interface AnthropicBlock {
  type: string;
  name?: string;
}
interface AnthropicResponse {
  content?: AnthropicBlock[];
}

async function firstToolChosen(userPrompt: string): Promise<string | null> {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': KEY as string,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      system: SYSTEM,
      tools: TOOLS,
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as AnthropicResponse;
  const toolUse = (data.content ?? []).find((b) => b.type === 'tool_use');
  return toolUse?.name ?? null;
}

async function main(): Promise<void> {
  if (!KEY) {
    console.error('ANTHROPIC_API_KEY is required (set it in apps/api/.env or the environment).');
    process.exit(2);
  }
  console.log(
    `Tool-selection eval: ${TOOL_SELECTION_FIXTURES.length} fixtures on ${MODEL} ` +
      `(gate: accuracy >= ${GATE})\n`,
  );

  let correct = 0;
  const rows: Array<{ id: string; expected: string | null; got: string | null; ok: boolean }> = [];
  for (const f of TOOL_SELECTION_FIXTURES) {
    try {
      const got = await firstToolChosen(f.userPrompt);
      const forbidden = (f.forbiddenTools ?? []).includes(got ?? '');
      const ok = f.expectedTool === null ? got === null : got === f.expectedTool && !forbidden;
      if (ok) correct += 1;
      rows.push({ id: f.id, expected: f.expectedTool, got, ok });
      console.log(
        `${ok ? 'OK  ' : 'MISS'} ${f.id}  expected=${f.expectedTool ?? '(none)'} got=${got ?? '(none)'}`,
      );
    } catch (err) {
      rows.push({ id: f.id, expected: f.expectedTool, got: null, ok: false });
      console.log(`ERR  ${f.id} — ${err instanceof Error ? err.message : err}`);
    }
  }

  const accuracy = correct / TOOL_SELECTION_FIXTURES.length;
  const reportUrl = new URL('../test/evals/clio/tool-selection-last-report.json', import.meta.url);
  mkdirSync(dirname(fileURLToPath(reportUrl)), { recursive: true });
  writeFileSync(reportUrl, JSON.stringify({ model: MODEL, accuracy, gate: GATE, rows }, null, 2));

  console.log(`\n=== tool-selection summary ===`);
  console.log(
    `accuracy: ${correct}/${TOOL_SELECTION_FIXTURES.length} = ${accuracy.toFixed(2)} (gate: ${GATE})`,
  );
  console.log(accuracy >= GATE ? '\nGATE: PASS' : '\nGATE: FAIL');
  process.exit(accuracy >= GATE ? 0 : 1);
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
