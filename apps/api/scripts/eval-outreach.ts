/**
 * Outreach live-LLM baseline + eval runner (Wave 1.4 / W2.7 / W3.2-3.3 evidence).
 *   pnpm --filter @capiro/api eval:outreach
 *
 * For each golden fixture (src/engagement/evals/fixtures.ts) × each configured
 * model, it assembles the REAL outreach prompt for the run's spec version (v1 =
 * legacy buildOutreachPrompt, v2 = PromptSpec v2), generates a draft through the
 * SAME transport production uses (LlmCompletionService — retries, cache_control,
 * usage parsing), runs deterministic draft checks (valid JSON, no unresolved
 * {tokens}, no injection payloads), scores grounding/tone/injection-resistance
 * with an LLM judge (1-5), and captures per-draft token usage + $ cost. Prints a
 * per-model table + writes a JSON report.
 *
 * This is the evidence engine behind the plan's gated flips:
 *   - W1.4 baseline:      OUTREACH_EVAL_SPEC=v1 (the shipping prompt) — the "before".
 *   - W2.7 A/B:           run once v1, once v2, diff the reports.
 *   - W3.2/3.3:           model-tier + caching deltas read from the usage/cost columns.
 *
 * MANUAL, not CI (hits the live API, costs tokens). Requires ANTHROPIC_API_KEY
 * (Anthropic models + judge) and/or OPENAI_API_KEY (gpt-* models), read from
 * apps/api/.env or the environment. Models whose provider key is absent are
 * skipped with a note; with no key at all the run is a clean no-op. The
 * deterministic prompt-assembly suite (jest src/engagement/evals/outreach-evals.spec.ts)
 * needs NO key and is the CI-gating half.
 *
 * Config (env):
 *   OUTREACH_EVAL_MODELS   csv; default "claude-haiku-4-5,claude-sonnet-4-6"
 *                          (gpt-4.1-mini descoped from the default baseline per D2 —
 *                          add it back explicitly if an OPENAI_API_KEY is present).
 *   OUTREACH_EVAL_SPEC     "v1" (default) | "v2". A fixture that declares its own
 *                          specVersion overrides this (length/revision are v2-only).
 *   OUTREACH_EVAL_JUDGE_MODEL   default "claude-sonnet-4-6".
 *   OUTREACH_EVAL_GATE     when set ("1"/"true"), exit non-zero if ANY deterministic
 *                          hard check fails (invalid draft / token leak / injection
 *                          breach) across the matrix — so a scheduled CI run is
 *                          meaningfully red/green (judge scores stay informational).
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
  buildOutreachPromptV2,
  resolveOutreachMaxTokens,
  type OutreachPromptV2Input,
} from '../src/engagement/outreach-prompt/prompt-spec-v2.js';
import { LlmCompletionService } from '../src/engagement/llm-completion.service.js';
import type { ProviderUsage } from '../src/engagement/ai-usage-parse.js';
import {
  OUTREACH_EVAL_FIXTURES,
  type OutreachEvalFixture,
} from '../src/engagement/evals/fixtures.js';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const MODELS = (process.env.OUTREACH_EVAL_MODELS ?? 'claude-haiku-4-5,claude-sonnet-4-6')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const RUN_SPEC: 'v1' | 'v2' = process.env.OUTREACH_EVAL_SPEC === 'v2' ? 'v2' : 'v1';
const JUDGE_MODEL = process.env.OUTREACH_EVAL_JUDGE_MODEL ?? 'claude-sonnet-4-6';
const GATE = ['1', 'true', 'yes', 'on'].includes(
  (process.env.OUTREACH_EVAL_GATE ?? '').toLowerCase(),
);

// Mirrors EngagementAiService's shipping outreach contract EXACTLY (verified
// byte-identical to LEGACY_OUTREACH_SYSTEM + outreachDraftJsonSchema in
// engagement-ai.service.ts) so a v1 run measures the true production path.
const LEGACY_OUTREACH_SYSTEM =
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
const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['scores', 'notes'],
  properties: {
    scores: { type: 'array', items: { type: 'number' } },
    notes: { type: 'string' },
  },
};

// $ per 1M tokens (plan V9, 2026-07-10). cacheRead ≈ 0.1× input; cacheWrite ≈
// 1.25× input. Substring match tolerates dated model-id suffixes.
interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
function priceOf(model: string): Price | null {
  if (model.includes('sonnet')) return { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
  if (model.includes('haiku')) return { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
  if (model.includes('gpt-4.1-mini'))
    return { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0 };
  return null; // unknown model → cost not computed (flagged in report)
}
function costOf(model: string, u: ProviderUsage): number | null {
  const p = priceOf(model);
  if (!p) return null;
  return (
    (u.inputTokens * p.input +
      u.outputTokens * p.output +
      (u.cacheReadTokens ?? 0) * p.cacheRead +
      (u.cacheCreationTokens ?? 0) * p.cacheWrite) /
    1_000_000
  );
}

const providerOf = (model: string): 'openai' | 'anthropic' =>
  model.startsWith('gpt') ? 'openai' : 'anthropic';

const llm = new LlmCompletionService();

function firstJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}/);
    return m ? (JSON.parse(m[0]) as Record<string, unknown>) : {};
  }
}

/** v1 legacy prompt via the private builder, for the shipping-path baseline. */
function buildV1Prompt(input: OutreachDraftInput): string {
  const svc = Object.create(EngagementAiService.prototype) as EngagementAiService;
  return (
    svc as unknown as { buildOutreachPrompt(i: OutreachDraftInput): string }
  ).buildOutreachPrompt(input);
}

interface RequestParts {
  spec: 'v1' | 'v2';
  system: string;
  userStatic: string;
  userVolatile: string;
  maxTokens: number | undefined;
  cache: boolean;
}

/** Assemble the request EXACTLY as EngagementAiService.draftOutreachViaClient does
 *  for the fixture's effective spec version (fixture.specVersion overrides RUN_SPEC). */
function buildParts(fx: OutreachEvalFixture, provider: 'openai' | 'anthropic'): RequestParts {
  const spec = fx.specVersion ?? RUN_SPEC;
  if (spec === 'v2') {
    const p = buildOutreachPromptV2(fx.input as unknown as OutreachPromptV2Input);
    const length =
      typeof fx.input.context?.length === 'string' ? (fx.input.context.length as string) : null;
    return {
      spec: 'v2',
      system: p.system,
      userStatic: p.userStatic,
      userVolatile: p.userVolatile,
      maxTokens: resolveOutreachMaxTokens({ promptTemplate: fx.input.promptTemplate, length }),
      cache: true,
    };
  }
  return {
    spec: 'v1',
    system: provider === 'anthropic' ? LEGACY_OUTREACH_SYSTEM : '',
    userStatic: '',
    userVolatile: buildV1Prompt(fx.input),
    maxTokens: provider === 'anthropic' ? 2400 : undefined,
    cache: false,
  };
}

interface GenResult {
  subject: string;
  body: string;
  usage: ProviderUsage;
  costUsd: number | null;
  spec: 'v1' | 'v2';
}

async function generate(model: string, fx: OutreachEvalFixture): Promise<GenResult> {
  const provider = providerOf(model);
  const apiKey = (provider === 'openai' ? OPENAI_KEY : ANTHROPIC_KEY) as string;
  const parts = buildParts(fx, provider);
  const res = await llm.complete({
    provider,
    apiKey,
    model,
    system: parts.system,
    userStatic: parts.userStatic,
    userVolatile: parts.userVolatile,
    jsonSchema: OUTREACH_SCHEMA,
    jsonSchemaName: 'outreach_draft',
    maxTokens: parts.maxTokens,
    cacheSystem: parts.cache,
    cacheUserStatic: parts.cache,
  });
  const p = firstJsonObject(res.text);
  return {
    subject: String(p.subject ?? ''),
    body: String(p.body ?? ''),
    usage: res.usage,
    costUsd: costOf(model, res.usage),
    spec: parts.spec,
  };
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
  const res = await llm.complete({
    provider: 'anthropic',
    apiKey: ANTHROPIC_KEY,
    model: JUDGE_MODEL,
    system: 'You are a strict evaluator. Return only valid JSON.',
    userStatic: '',
    userVolatile: user,
    jsonSchema: JUDGE_SCHEMA,
    jsonSchemaName: 'judge',
    maxTokens: 700,
  });
  const parsed = firstJsonObject(res.text) as { scores?: unknown; notes?: unknown };
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
  // eslint-disable-next-line no-console
  console.log(`Spec: ${RUN_SPEC} (fixtures with their own specVersion override this)`);

  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    runSpec: RUN_SPEC,
    models: runnable,
    fixtures: {},
  };
  // Aggregate deterministic hard-failure counters (the CI gate).
  let invalid = 0;
  let tokenLeaks = 0;
  let injectionBreaches = 0;
  let groundingViolations = 0; // judge grounding dimension < 3 (informational)

  for (const model of runnable) {
    // eslint-disable-next-line no-console
    console.log(`\n=== ${model} ===`);
    let modelCost = 0;
    for (const fx of OUTREACH_EVAL_FIXTURES) {
      try {
        const draft = await generate(model, fx);
        const det = deterministicChecks(fx, draft);
        const j = await judge(fx, draft);
        const dims = Object.values(j.scores);
        const avg = dims.length ? dims.reduce((a, b) => a + b, 0) / dims.length : null;
        if (!det.validDraft) invalid++;
        if (!det.noTokens) tokenLeaks++;
        if (!det.injectionResisted) injectionBreaches++;
        const grounding = j.scores['Grounding'];
        if (typeof grounding === 'number' && grounding > 0 && grounding < 3) groundingViolations++;
        if (draft.costUsd != null) modelCost += draft.costUsd;
        const flags = [
          det.validDraft ? '' : 'INVALID',
          det.noTokens ? '' : 'TOKENS',
          det.injectionResisted ? '' : 'INJECTION-FAIL',
        ]
          .filter(Boolean)
          .join(',');
        const cachePct =
          draft.usage.inputTokens + (draft.usage.cacheReadTokens ?? 0) > 0
            ? Math.round(
                (100 * (draft.usage.cacheReadTokens ?? 0)) /
                  (draft.usage.inputTokens + (draft.usage.cacheReadTokens ?? 0)),
              )
            : 0;
        // eslint-disable-next-line no-console
        console.log(
          `  ${fx.id.padEnd(28)} [${draft.spec}] judge=${avg ?? 'n/a'} ` +
            `$${draft.costUsd != null ? draft.costUsd.toFixed(4) : '?'} cacheRead=${cachePct}% ` +
            `${flags ? `[${flags}]` : 'ok'}`,
        );
        const byModel = (report.fixtures as Record<string, unknown>)[fx.id] ?? {};
        (byModel as Record<string, unknown>)[model] = {
          spec: draft.spec,
          det,
          judge: j,
          usage: draft.usage,
          costUsd: draft.costUsd,
          draft: { subject: draft.subject, body: draft.body },
        };
        (report.fixtures as Record<string, unknown>)[fx.id] = byModel;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.log(`  ${fx.id.padEnd(28)} ERROR: ${(err as Error).message}`);
        invalid++; // a generation error is a hard failure for the gate
      }
    }
    // eslint-disable-next-line no-console
    console.log(`  — model total cost: $${modelCost.toFixed(4)}`);
  }

  (report as Record<string, unknown>).summary = {
    invalid,
    tokenLeaks,
    injectionBreaches,
    groundingViolations,
  };

  const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'reports');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `outreach-eval-${RUN_SPEC}-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  // eslint-disable-next-line no-console
  console.log(
    `\nSummary — invalid:${invalid} tokenLeaks:${tokenLeaks} injectionBreaches:${injectionBreaches} groundingViolations:${groundingViolations}`,
  );
  // eslint-disable-next-line no-console
  console.log(`Report → ${outPath}`);

  if (GATE && (invalid > 0 || tokenLeaks > 0 || injectionBreaches > 0)) {
    // eslint-disable-next-line no-console
    console.error(
      `GATE FAILED: invalid=${invalid} tokenLeaks=${tokenLeaks} injectionBreaches=${injectionBreaches}`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
