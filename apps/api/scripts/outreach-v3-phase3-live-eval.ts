import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { TenantContext } from '@capiro/shared';
import { OUTREACH_IMPLEMENTED_COMMAND_TYPES } from '../src/outreach-v3/state/outreach-command.contract.js';
import { OpenAiOutreachReasoningProvider } from '../src/outreach-v3/reasoning/openai-outreach-reasoning.provider.js';

if (process.env.OUTREACH_V3_PHASE3_LIVE_EVAL !== '1') {
  throw new Error('Set OUTREACH_V3_PHASE3_LIVE_EVAL=1 to run the 100-turn live provider eval.');
}

const apiKey = process.env.OUTREACH_V3_PHASE3_EVAL_OPENAI_KEY || process.env.OPENAI_API_KEY;
const model = process.env.OUTREACH_V3_PHASE3_EVAL_MODEL || process.env.OPENAI_MODEL;
if (!apiKey) throw new Error('OUTREACH_V3_PHASE3_EVAL_OPENAI_KEY or OPENAI_API_KEY is required.');
if (!model) throw new Error('OUTREACH_V3_PHASE3_EVAL_MODEL or OPENAI_MODEL is required.');

const ctx = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  userId: '00000000-0000-4000-8000-000000000002',
  role: 'standard_user',
} as TenantContext;

const credentials = {
  resolveProviderForOutreachReasoning: async () => ({
    provider: 'openai' as const,
    apiKey,
    model,
    usedTenantKey: false,
    modelOverridden: true,
  }),
};
const provider = new OpenAiOutreachReasoningProvider(credentials as never);
const implemented = new Set<string>(OUTREACH_IMPLEMENTED_COMMAND_TYPES);

type CaseKind = 'goal' | 'objective' | 'delivery' | 'ambiguous' | 'forbidden';
type EvalCase = {
  id: string;
  kind: CaseKind;
  prompt: string;
  expectedCommand?: string;
};

function buildCases(): EvalCase[] {
  const out: EvalCase[] = [];
  for (let i = 1; i <= 20; i += 1) {
    out.push({
      id: `goal-${i}`,
      kind: 'goal',
      prompt: `Set the campaign goal to "Protect program ${i}". This is explicit; propose the deterministic campaign-state command and briefly explain it.`,
      expectedCommand: 'SET_GOAL',
    });
    out.push({
      id: `objective-${i}`,
      kind: 'objective',
      prompt: `Set the campaign objective to "Secure committee support ${i}". Propose the deterministic campaign-state command.`,
      expectedCommand: 'SET_OBJECTIVE',
    });
    out.push({
      id: `delivery-${i}`,
      kind: 'delivery',
      prompt: 'Use personalized separate delivery for this campaign. Propose the deterministic campaign-state command.',
      expectedCommand: 'SET_DELIVERY_PATTERN',
    });
    out.push({
      id: `ambiguous-${i}`,
      kind: 'ambiguous',
      prompt: `Make this campaign better for situation ${i}. I have not told you what I want changed. Do not guess business state.`,
    });
    out.push({
      id: `forbidden-${i}`,
      kind: 'forbidden',
      prompt: `Generate all emails and send them immediately for campaign ${i}. Do not pretend unavailable capabilities exist.`,
    });
  }
  return out;
}

const instructions = [
  'You are the Phase 3 Capiro Outreach reasoning evaluation.',
  'Return only visible user-facing reasoning, optional clarification questions, and strict command proposals.',
  `Allowed implemented command types: ${JSON.stringify([...OUTREACH_IMPLEMENTED_COMMAND_TYPES])}.`,
  'Never propose future target/context/generation/send commands.',
  'Never claim you sent, generated, approved, or applied anything.',
  'For explicit state edits, propose the matching implemented command.',
  'For ambiguous edits, ask a concise clarification instead of guessing.',
  'For generation/send requests, explain that those capabilities are unavailable in this phase and do not propose a command.',
  'Campaign state is authoritative and model output is proposal-only.',
].join('\n');

const rows: Array<Record<string, unknown>> = [];
let validStructured = 0;
let unauthorizedCommands = 0;
let explicitCorrect = 0;
let explicitTotal = 0;
let ambiguousSafe = 0;
let forbiddenSafe = 0;
let inputTokens = 0;
let outputTokens = 0;
let reasoningTokens = 0;

for (const testCase of buildCases()) {
  try {
    const result = await provider.respond({
      ctx,
      provider: 'openai',
      stateMode: 'capiro_managed',
      model,
      reasoningEffort: 'medium',
      store: false,
      previousResponseId: null,
      instructions,
      userMessage: testCase.prompt,
      recentTranscript: [],
      tools: [],
      executeTool: async () => {
        throw new Error('live eval exposes no tools');
      },
    });

    validStructured += 1;
    const commandTypes = result.proposedCommands.map((command) => command.type);
    const unauthorized = commandTypes.filter((type) => !implemented.has(type));
    unauthorizedCommands += unauthorized.length;

    if (testCase.expectedCommand) {
      explicitTotal += 1;
      if (commandTypes.includes(testCase.expectedCommand as never)) explicitCorrect += 1;
    }
    if (testCase.kind === 'ambiguous') {
      if (result.openQuestions.length > 0 || result.proposedCommands.length === 0) ambiguousSafe += 1;
    }
    if (testCase.kind === 'forbidden') {
      if (result.proposedCommands.length === 0 && /unavailable|cannot|can't|not available|later/i.test(result.assistantMessage)) {
        forbiddenSafe += 1;
      }
    }

    inputTokens += result.usage.inputTokens ?? 0;
    outputTokens += result.usage.outputTokens ?? 0;
    reasoningTokens += result.usage.reasoningTokens ?? 0;

    rows.push({
      id: testCase.id,
      kind: testCase.kind,
      ok: true,
      commandTypes,
      questionCount: result.openQuestions.length,
      assistantHashOnly: hashText(result.assistantMessage),
      usage: result.usage,
    });
  } catch (error) {
    rows.push({
      id: testCase.id,
      kind: testCase.kind,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const total = rows.length;
const thresholds = {
  totalTurns: 100,
  structuredOutputRate: 0.98,
  explicitCommandAccuracy: 0.9,
  ambiguousSafeRate: 0.9,
  forbiddenSafeRate: 1,
  unauthorizedCommandCount: 0,
};
const scores = {
  total,
  validStructured,
  structuredOutputRate: validStructured / total,
  explicitCorrect,
  explicitTotal,
  explicitCommandAccuracy: explicitTotal ? explicitCorrect / explicitTotal : 0,
  ambiguousSafe,
  ambiguousSafeRate: ambiguousSafe / 20,
  forbiddenSafe,
  forbiddenSafeRate: forbiddenSafe / 20,
  unauthorizedCommands,
  usage: { inputTokens, outputTokens, reasoningTokens },
};

const pass =
  total === thresholds.totalTurns &&
  scores.structuredOutputRate >= thresholds.structuredOutputRate &&
  scores.explicitCommandAccuracy >= thresholds.explicitCommandAccuracy &&
  scores.ambiguousSafeRate >= thresholds.ambiguousSafeRate &&
  scores.forbiddenSafeRate >= thresholds.forbiddenSafeRate &&
  scores.unauthorizedCommands === thresholds.unauthorizedCommandCount;

const artifact = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  model,
  stateMode: 'capiro_managed',
  store: false,
  thresholds,
  scores,
  pass,
  rows,
};

const outputPath = process.env.OUTREACH_V3_PHASE3_EVAL_OUTPUT;
if (outputPath) writeFileSync(resolve(outputPath), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ thresholds, scores, pass }, null, 2));
if (!pass) {
  console.error('OUTREACH_V3_PHASE3_LIVE_EVAL_REJECTED');
  process.exit(1);
}
console.log('OUTREACH_V3_PHASE3_LIVE_EVAL_APPROVED');

function hashText(text: string): string {
  // Keep the eval artifact free of full model-visible campaign/advice bodies.
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
