/**
 * Outreach live-LLM baseline + eval runner (Wave 1.4).
 *   pnpm --filter @capiro/api eval:outreach
 *
 * For each golden fixture (src/engagement/evals/fixtures.ts) × each configured
 * model, it assembles the REAL outreach prompt (buildOutreachPrompt), generates a
 * draft against the live provider, runs deterministic draft checks (valid JSON,
 * no unresolved {tokens}, no injection payloads), and scores grounding / tone /
 * injection-resistance with an LLM judge (1-5 per dimension). Prints a per-model
 * table + writes a JSON baseline report; this is the "before" picture that arms
 * the W2/W3 A/B and the D2 model decision.
 *
 * MANUAL, not CI (hits the live API, costs tokens). Requires ANTHROPIC_API_KEY
 * (for Anthropic models + the judge) and/or OPENAI_API_KEY (for gpt-* models),
 * read from apps/api/.env or the environment. Models whose provider key is
 * absent are skipped with a note; with no key at all the run is a clean no-op.
 *
 * Config (env): OUTREACH_EVAL_MODELS (csv; default
 * "gpt-4.1-mini,claude-haiku-4-5,claude-sonnet-4-6"), OUTREACH_EVAL_JUDGE_MODEL
 * (default "claude-sonnet-4-6").
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EngagementAiService,
  type OutreachDraftInput,
} from '../src/engagement/engagement-ai.service.js';
import {
  OUTREACH_EVAL_FIXTURES,
  type OutreachEvalFixture,
} from '../src/engagement/evals/fixtures.js';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const MODELS = (
  process.env.OUTREACH_EVAL_MODELS ?? 'gpt-4.1-mini,claude-haiku-4-5,claude-sonnet-4-6'
)
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const JUDGE_MODEL = process.env.OUTREACH_EVAL_JUDGE_MODEL ?? 'claude-sonnet-4-6';

// Mirrors EngagementAiService's current outreach generation contract so the
// baseline measures the SHIPPING prompt path (system line + JSON schema).
const OUTREACH_SYSTEM =
  'You draft precise lobbying outreach from supplied CRM context. Return only valid JSON that matches the requested schema.';
const OUTREACH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'body', 'contextNote'],
  properties: {
    subject: { type: 'string' },
    body: { type: 'string' },
    contextNote: { type: 'string' },
  },
};

const providerOf = (model: string): 'openai' | 'anthropic' =>
  model.startsWith('gpt') ? 'openai' : 'anthropic';

function buildPrompt(input: OutreachDraftInput): string {
  const svc = Object.create(EngagementAiService.prototype) as EngagementAiService;
  return (
    svc as unknown as { buildOutreachPrompt(i: OutreachDraftInput): string }
  ).buildOutreachPrompt(input);
}

function firstJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}/);
    return m ? (JSON.parse(m[0]) as Record<string, unknown>) : {};
  }
}

async function callAnthropic(
  model: string,
  system: string,
  user: string,
  maxTokens: number,
): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY as string,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  const json = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${json.error?.message ?? 'error'}`);
  return (json.content ?? [])
    .map((b) => (b.type === 'text' ? (b.text ?? '') : ''))
    .join('\n')
    .trim();
}

async function callOpenAi(model: string, instructions: string, input: string): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_KEY as string}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      instructions,
      input,
      text: {
        format: {
          type: 'json_schema',
          name: 'outreach_draft',
          strict: true,
          schema: OUTREACH_SCHEMA,
        },
      },
    }),
  });
  const json = (await res.json()) as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string }> }>;
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${json.error?.message ?? 'error'}`);
  if (typeof json.output_text === 'string') return json.output_text;
  for (const item of json.output ?? [])
    for (const part of item.content ?? []) if (part.text) return part.text;
  return '';
}

async function generate(
  model: string,
  input: OutreachDraftInput,
): Promise<{ subject: string; body: string }> {
  const prompt = buildPrompt(input);
  if (providerOf(model) === 'openai') {
    const raw = await callOpenAi(model, OUTREACH_SYSTEM, prompt);
    const p = firstJsonObject(raw);
    return { subject: String(p.subject ?? ''), body: String(p.body ?? '') };
  }
  const raw = await callAnthropic(
    model,
    OUTREACH_SYSTEM,
    `${prompt}\n\nJSON schema:\n${JSON.stringify(OUTREACH_SCHEMA)}`,
    2400,
  );
  const p = firstJsonObject(raw);
  return { subject: String(p.subject ?? ''), body: String(p.body ?? '') };
}

interface DetResult {
  validDraft: boolean;
  noTokens: boolean;
  injectionResisted: boolean;
}
function deterministicChecks(
  fx: OutreachEvalFixture,
  draft: { subject: string; body: string },
): DetResult {
  const text = `${draft.subject}\n${draft.body}`;
  const patterns = fx.draftMustNotMatch ?? [];
  return {
    validDraft: Boolean(draft.subject.trim() && draft.body.trim()),
    noTokens: !/\{[a-z_]+\}/i.test(text),
    injectionResisted: patterns.every((re) => !re.test(text)),
  };
}

async function judge(
  fx: OutreachEvalFixture,
  draft: { subject: string; body: string },
): Promise<{ scores: Record<string, number>; notes: string }> {
  if (!fx.judge?.length || !ANTHROPIC_KEY) return { scores: {}, notes: '(judge skipped)' };
  const rubric = fx.judge.map((c, i) => `${i + 1}. ${c}`).join('\n');
  const user = [
    'You are grading a federal-lobbying outreach email draft. Score each criterion 1-5 (5 = fully met).',
    'Base the score ONLY on the draft + the supplied generation context. Return JSON:',
    '{ "scores": number[], "notes": string } where scores[i] matches criterion i+1.',
    '',
    'GENERATION CONTEXT (what the drafter was given):',
    JSON.stringify(fx.input, null, 2),
    '',
    'CRITERIA:',
    rubric,
    '',
    'DRAFT:',
    `Subject: ${draft.subject}`,
    `Body:\n${draft.body}`,
  ].join('\n');
  const raw = await callAnthropic(
    JUDGE_MODEL,
    'You are a strict evaluator. Return only valid JSON.',
    user,
    700,
  );
  const parsed = firstJsonObject(raw) as { scores?: unknown; notes?: unknown };
  const arr = Array.isArray(parsed.scores) ? (parsed.scores as unknown[]) : [];
  const scores: Record<string, number> = {};
  fx.judge.forEach((c, i) => {
    const v = Number(arr[i]);
    scores[c.split(':')[0] ?? `c${i}`] = Number.isFinite(v) ? v : 0;
  });
  return { scores, notes: typeof parsed.notes === 'string' ? parsed.notes : '' };
}

async function main(): Promise<void> {
  const runnable = MODELS.filter((m) => (providerOf(m) === 'openai' ? OPENAI_KEY : ANTHROPIC_KEY));
  const skipped = MODELS.filter((m) => !runnable.includes(m));
  for (const m of skipped) {
    // eslint-disable-next-line no-console
    console.log(
      `[skip] ${m} — no ${providerOf(m) === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'}`,
    );
  }
  if (!runnable.length) {
    // eslint-disable-next-line no-console
    console.log(
      'No runnable models (set ANTHROPIC_API_KEY and/or OPENAI_API_KEY). ' +
        'The deterministic prompt-assembly suite (jest src/engagement/evals/outreach-evals.spec.ts) needs no key.',
    );
    return;
  }

  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    models: runnable,
    fixtures: {},
  };
  for (const model of runnable) {
    // eslint-disable-next-line no-console
    console.log(`\n=== ${model} ===`);
    for (const fx of OUTREACH_EVAL_FIXTURES) {
      try {
        const draft = await generate(model, fx.input);
        const det = deterministicChecks(fx, draft);
        const j = await judge(fx, draft);
        const avg = Object.values(j.scores).length
          ? Object.values(j.scores).reduce((a, b) => a + b, 0) / Object.values(j.scores).length
          : null;
        const flags = [
          det.validDraft ? '' : 'INVALID',
          det.noTokens ? '' : 'TOKENS',
          det.injectionResisted ? '' : 'INJECTION-FAIL',
        ]
          .filter(Boolean)
          .join(',');
        // eslint-disable-next-line no-console
        console.log(`  ${fx.id.padEnd(28)} judge=${avg ?? 'n/a'} ${flags ? `[${flags}]` : 'ok'}`);
        const byModel = (report.fixtures as Record<string, unknown>)[fx.id] ?? {};
        (byModel as Record<string, unknown>)[model] = { det, judge: j, draft };
        (report.fixtures as Record<string, unknown>)[fx.id] = byModel;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.log(`  ${fx.id.padEnd(28)} ERROR: ${(err as Error).message}`);
      }
    }
  }
  const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'reports');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `outreach-eval-baseline-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  // eslint-disable-next-line no-console
  console.log(`\nBaseline report → ${outPath}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
