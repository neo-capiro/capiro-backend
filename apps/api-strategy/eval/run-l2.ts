/**
 * Stage B — Step B3: Layer 2 LLM-judge eval. Manual/scheduled, NOT CI (unlike
 * L1) — this makes real network calls: a live draft-from-goal round-trip
 * against the orchestrator (global key, dogfood tenant) for every golden,
 * then a live Claude judge call scoring the result. Both cost real inference
 * spend and require live infrastructure. run-l2.spec.ts imports and tests only
 * the network-free exports below (loadConfig/toVerifierNodes/renderMarkdown);
 * the network-calling functions (requestDraft/judgeDraft/runOne/main) are
 * never invoked by any test and this file is not otherwise wired into CI.
 *
 * WHY it calls the orchestrator directly (not api-strategy's /strategies/draft
 * endpoint): api-strategy's MeriService.draft() computes fiscal/reference
 * grounding from the tenant's LIVE calendars before forwarding to the
 * orchestrator — there is no way to ask it to use a golden's SYNTHETIC
 * clientContextFixture instead. The orchestrator's /meri-api/strategy-draft
 * endpoint has no such opinion: it uses whatever fiscal/reference fields are
 * in the request body, whoever computed them. So this script sends the
 * golden's own fixture as that grounding, while still resolving a REAL
 * client's profile/docs/etc. via the delegated-tool pack compiler for
 * `EVAL_CLIENT_ID` — a genuine "goal+fixture against a live dogfood client"
 * run, exactly as Step B3 describes, not a synthetic short-circuit.
 *
 * Required env (fails closed with a setup message if any are missing — never
 * makes a network call with partial config):
 *   MERIV2_ORCHESTRATOR_URL   e.g. http://localhost:4300 (no trailing slash)
 *   EVAL_BEARER_TOKEN         a real Clerk-authenticated JWT for the dogfood
 *                             tenant (TenantGuard verifies it) — copy one from
 *                             an authenticated browser session; there is no
 *                             service-to-service bypass for this endpoint
 *   EVAL_CLIENT_ID            a real client id in that tenant (any client —
 *                             the golden's own clientContextFixture supplies
 *                             the fiscal/reference grounding regardless)
 *   ANTHROPIC_API_KEY         global key for the judge call (same env var
 *                             name the orchestrator itself uses)
 *
 * No x-capiro-ai-provider header is sent on the draft call, so the
 * orchestrator resolves its own global default key for generation — "global
 * key" per the plan, not a tenant BYOK credential.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { VerifierNode } from '@capiro/strategy-verifier';
import { verifyPlan } from '@capiro/strategy-verifier';
import { loadGoldens, checkShape, type GoldenFile } from './run-l1.js';

export interface L2Config {
  orchestratorUrl: string;
  bearerToken: string;
  clientId: string;
  anthropicApiKey: string;
}

export function loadConfig(): L2Config | { missing: string[] } {
  const missing: string[] = [];
  const orchestratorUrl = (process.env.MERIV2_ORCHESTRATOR_URL ?? '').replace(/\/+$/, '');
  const bearerToken = process.env.EVAL_BEARER_TOKEN ?? '';
  const clientId = process.env.EVAL_CLIENT_ID ?? '';
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY ?? '';
  if (!orchestratorUrl) missing.push('MERIV2_ORCHESTRATOR_URL');
  if (!bearerToken) missing.push('EVAL_BEARER_TOKEN');
  if (!clientId) missing.push('EVAL_CLIENT_ID');
  if (!anthropicApiKey) missing.push('ANTHROPIC_API_KEY');
  if (missing.length) return { missing };
  return { orchestratorUrl, bearerToken, clientId, anthropicApiKey };
}

// ---- draft call (orchestrator) ----------------------------------------------

interface RawDraftNode {
  kind?: string;
  subject?: string;
  title?: string;
  startsOn?: string;
  endsOn?: string | null;
  dependsOn?: number[];
  sources?: Array<{ section: string; ref?: string }>;
}

interface DraftResponse {
  summary: string;
  nodes: RawDraftNode[];
  provenance?: unknown;
  violations?: Array<{ code: string; severity: string; message: string }>;
  groundingHealth?: { status: string; missingRequired: string[]; omittedOptional: string[] };
}

export async function requestDraft(gf: GoldenFile, config: L2Config): Promise<DraftResponse> {
  const { golden, strategyType } = gf;
  const body = {
    clientId: config.clientId,
    type: strategyType,
    goal: golden.goal,
    meriContext: null,
    targetDate: null,
    attachmentIds: [],
    attachments: [],
    fiscal: golden.clientContextFixture.fiscal,
    firmPhases: [],
    reference: {
      congress: golden.clientContextFixture.congress ?? [],
      ppbeLanes: [],
      ppbeCurrentPhases: golden.clientContextFixture.ppbeCurrentPhases ?? [],
    },
  };
  const res = await fetch(`${config.orchestratorUrl}/meri-api/strategy-draft`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.bearerToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`orchestrator strategy-draft failed: ${res.status} ${res.statusText} ${text.slice(0, 300)}`);
  }
  return (await res.json()) as DraftResponse;
}

/** Index-based `dependsOn` -> synthetic string ids, mirroring
 *  strategy-assistant.service.ts's own draftVerifierInput (same minimal
 *  approach production code uses to feed the raw draft into verifyPlan). */
export function toVerifierNodes(nodes: RawDraftNode[]): VerifierNode[] {
  return nodes.map((n, idx) => ({
    id: String(idx),
    kind: String(n.kind ?? ''),
    subject: String(n.subject ?? ''),
    title: String(n.title ?? ''),
    startsOn: String(n.startsOn ?? ''),
    endsOn: n.endsOn ? String(n.endsOn) : null,
    dependsOnIds: Array.isArray(n.dependsOn)
      ? n.dependsOn
          .filter((d): d is number => Number.isInteger(d) && d >= 0 && d < nodes.length && d !== idx)
          .map((d) => String(d))
      : [],
  }));
}

// ---- judge call (Anthropic, forced single tool) -----------------------------

const JUDGE_TOOL = {
  name: 'emit_plan_score',
  description: 'Score a generated government-affairs strategy plan against the stated goal and client context.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      realism: { type: 'integer', minimum: 1, maximum: 5, description: 'Does this sequence of steps reflect how this kind of engagement actually unfolds?' },
      grounding: { type: 'integer', minimum: 1, maximum: 5, description: 'Do the per-node "sources" citations plausibly connect each step to the client context, without inventing facts?' },
      actionability: { type: 'integer', minimum: 1, maximum: 5, description: 'Could a real government-affairs professional execute this plan as written, without needing to fill in major gaps?' },
      calendarFit: { type: 'integer', minimum: 1, maximum: 5, description: 'Are the dates plausible for the fiscal/legislative calendar described?' },
      rationale: { type: 'string', description: '2-4 sentences justifying the four scores.' },
    },
    required: ['realism', 'grounding', 'actionability', 'calendarFit', 'rationale'],
  },
} as const;

export interface JudgeScore {
  realism: number;
  grounding: number;
  actionability: number;
  calendarFit: number;
  rationale: string;
}

export async function judgeDraft(gf: GoldenFile, draft: DraftResponse, config: L2Config): Promise<JudgeScore> {
  const system = [
    'You are grading a government-affairs strategy plan generated by another AI system.',
    'Score honestly on a 1-5 scale for each dimension — 5 is not the default.',
    `Client context this plan should be grounded in: ${gf.golden.clientContextFixture.profileSummary}`,
  ].join('\n');
  const userText = [
    `Goal: ${gf.golden.goal}`,
    `Plan summary: ${draft.summary}`,
    'Plan steps:',
    ...draft.nodes.map(
      (n, i) =>
        `${i}. [${n.kind}/${n.subject}] ${n.title} (${n.startsOn} - ${n.endsOn ?? 'point event'})` +
        (n.sources?.length ? ` grounded in: ${n.sources.map((s) => s.section).join(', ')}` : ' — NO sources cited'),
    ),
  ].join('\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': config.anthropicApiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      system,
      tools: [JUDGE_TOOL],
      tool_choice: { type: 'tool', name: JUDGE_TOOL.name },
      messages: [{ role: 'user', content: userText }],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`judge call failed: ${res.status} ${res.statusText} ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as { content?: Array<{ type: string; input?: unknown }> };
  const toolUse = data.content?.find((b) => b.type === 'tool_use');
  if (!toolUse?.input) throw new Error('judge did not return a tool_use block');
  return toolUse.input as JudgeScore;
}

// ---- orchestration + scorecard -----------------------------------------------

export interface L2Result {
  strategyType: string;
  slug: string;
  goal: string;
  draftSummary: string;
  nodeCount: number;
  groundingHealth?: DraftResponse['groundingHealth'];
  shapeOk: boolean;
  shapeFailures: string[];
  verifierErrorCount: number;
  verifierWarningCount: number;
  judge: JudgeScore;
  needsHumanReview: boolean;
  error?: string;
}

export async function runOne(gf: GoldenFile, config: L2Config, index: number): Promise<L2Result> {
  const needsHumanReview = index % 5 === 0; // ~20% Neo spot-review sample (plan §B3)
  try {
    const draft = await requestDraft(gf, config);
    const vNodes = toVerifierNodes(draft.nodes);
    const check = verifyPlan({
      strategyType: gf.strategyType,
      nodes: vNodes,
      fiscal: gf.golden.clientContextFixture.fiscal,
      congress: gf.golden.clientContextFixture.congress ?? [],
      ppbeCurrentPhases: gf.golden.clientContextFixture.ppbeCurrentPhases ?? [],
    });
    const shape = checkShape(vNodes, gf.golden.expectedPlanShape);
    const judge = await judgeDraft(gf, draft, config);
    return {
      strategyType: gf.strategyType,
      slug: gf.slug,
      goal: gf.golden.goal,
      draftSummary: draft.summary,
      nodeCount: draft.nodes.length,
      groundingHealth: draft.groundingHealth,
      shapeOk: shape.ok,
      shapeFailures: shape.failures,
      verifierErrorCount: check.errorCount,
      verifierWarningCount: check.warningCount,
      judge,
      needsHumanReview,
    };
  } catch (err) {
    return {
      strategyType: gf.strategyType,
      slug: gf.slug,
      goal: gf.golden.goal,
      draftSummary: '',
      nodeCount: 0,
      shapeOk: false,
      shapeFailures: [],
      verifierErrorCount: 0,
      verifierWarningCount: 0,
      judge: { realism: 0, grounding: 0, actionability: 0, calendarFit: 0, rationale: '' },
      needsHumanReview,
      error: (err as Error).message,
    };
  }
}

function average(nums: number[]): number {
  return nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100 : 0;
}

export function renderMarkdown(results: L2Result[], dateStamp: string): string {
  const ok = results.filter((r) => !r.error);
  const lines = [
    `# Stage B L2 scorecard — ${dateStamp}`,
    '',
    `${ok.length}/${results.length} goldens produced a scored draft.`,
    '',
    `| Metric | Average |`,
    `|---|---|`,
    `| Realism | ${average(ok.map((r) => r.judge.realism))} |`,
    `| Grounding | ${average(ok.map((r) => r.judge.grounding))} |`,
    `| Actionability | ${average(ok.map((r) => r.judge.actionability))} |`,
    `| Calendar fit | ${average(ok.map((r) => r.judge.calendarFit))} |`,
    `| verifyPlan error count | ${average(ok.map((r) => r.verifierErrorCount))} |`,
    `| Shape-pass rate | ${ok.length ? Math.round((ok.filter((r) => r.shapeOk).length / ok.length) * 100) : 0}% |`,
    '',
    '| Golden | Realism | Grounding | Action. | Cal.fit | Verify errs | Shape | Review? |',
    '|---|---|---|---|---|---|---|---|',
    ...results.map((r) =>
      r.error
        ? `| ${r.strategyType}/${r.slug} | ERROR: ${r.error.slice(0, 60)} | | | | | | |`
        : `| ${r.strategyType}/${r.slug} | ${r.judge.realism} | ${r.judge.grounding} | ${r.judge.actionability} | ${r.judge.calendarFit} | ${r.verifierErrorCount} | ${r.shapeOk ? 'OK' : 'FAIL'} | ${r.needsHumanReview ? 'YES' : ''} |`,
    ),
    '',
    '## Rationales',
    '',
    ...results
      .filter((r) => !r.error)
      .map((r) => `**${r.strategyType}/${r.slug}**: ${r.judge.rationale}`),
  ];
  return lines.join('\n');
}

async function main(): Promise<void> {
  const config = loadConfig();
  if ('missing' in config) {
    console.error('eval:l2 is not configured — missing env var(s): ' + config.missing.join(', '));
    console.error('');
    console.error('Required (no network call is made without all four):');
    console.error('  MERIV2_ORCHESTRATOR_URL  e.g. http://localhost:4300');
    console.error('  EVAL_BEARER_TOKEN        a real Clerk JWT for the dogfood tenant (from an authenticated session)');
    console.error('  EVAL_CLIENT_ID           a real client id in that tenant');
    console.error('  ANTHROPIC_API_KEY        global key for the judge call');
    console.error('');
    console.error('This makes REAL live Claude calls (one draft + one judge call per golden) and will spend real inference credits.');
    process.exit(1);
  }

  const goldens = loadGoldens();
  console.log(`Running L2 against ${goldens.length} goldens (live draft + live judge per golden)...`);
  const results: L2Result[] = [];
  for (const [i, gf] of goldens.entries()) {
    process.stdout.write(`  ${gf.strategyType}/${gf.slug}... `);
    const r = await runOne(gf, config, i);
    results.push(r);
    console.log(r.error ? `ERROR (${r.error})` : `realism=${r.judge.realism} grounding=${r.judge.grounding} actionability=${r.judge.actionability} calendarFit=${r.judge.calendarFit}`);
  }

  const dateStamp = new Date().toISOString().slice(0, 10);
  const reportsDir = join(__dirname, 'reports');
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(join(reportsDir, `${dateStamp}.json`), JSON.stringify({ dateStamp, results }, null, 2) + '\n', 'utf8');
  writeFileSync(join(reportsDir, `${dateStamp}.md`), renderMarkdown(results, dateStamp) + '\n', 'utf8');
  console.log(`\nWrote eval/reports/${dateStamp}.json and eval/reports/${dateStamp}.md`);
  console.log(`${results.filter((r) => r.needsHumanReview).length} golden(s) flagged for Neo spot-review (~20% sample).`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
