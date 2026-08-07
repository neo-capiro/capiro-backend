import './meriv3-pricing.js';
import {
  MERIV3_REASONING_MODES,
  type MeriV3ReasoningEffort,
  type MeriV3ReasoningMode,
  type MeriV3ReasoningProfile,
} from './meriv3.types.js';

const INT_RE = /^\d+$/;

function positiveInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw || !INT_RE.test(raw.trim())) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Math.min(Math.max(parsed, min), max);
}

function effort(
  raw: string | undefined,
  fallback: MeriV3ReasoningEffort,
): MeriV3ReasoningEffort {
  return raw === 'low' ||
    raw === 'medium' ||
    raw === 'high' ||
    raw === 'xhigh' ||
    raw === 'max'
    ? raw
    : fallback;
}

export function normalizeMeriV3ReasoningMode(value: unknown): MeriV3ReasoningMode {
  return typeof value === 'string' && (MERIV3_REASONING_MODES as readonly string[]).includes(value)
    ? (value as MeriV3ReasoningMode)
    : 'standard';
}

/**
 * Translate stable Capiro UX modes into the current OpenAI reasoning family,
 * effort, output ceiling and bounded tool-loop budget.
 *
 * - Fast defaults to GPT-5.6 Luna (cost-sensitive / high-volume tier).
 * - Standard defaults to GPT-5.6 Terra (balanced intelligence and cost).
 * - Deep and Max default to GPT-5.6 Sol (`gpt-5.6` alias).
 *
 * Model ids remain environment configuration rather than browser input. A
 * tenant's explicit BYOK model override is applied later by
 * OpenAiResponsesClient; this profile remains the Capiro default and the
 * observability expectation.
 */
export function resolveMeriV3ReasoningProfile(
  modeInput: unknown,
  env: NodeJS.ProcessEnv = process.env,
): MeriV3ReasoningProfile {
  const mode = normalizeMeriV3ReasoningMode(modeInput);
  const fastModel = env.MERIV3_FAST_MODEL?.trim() || 'gpt-5.6-luna';
  const standardModel = env.MERIV3_MODEL?.trim() || 'gpt-5.6-terra';
  const deepModel = env.MERIV3_DEEP_MODEL?.trim() || 'gpt-5.6';
  const maxModel = env.MERIV3_MAX_MODEL?.trim() || deepModel;

  switch (mode) {
    case 'fast':
      return {
        mode,
        label: 'Fast',
        description: 'Quick answers and straightforward lookups.',
        model: fastModel,
        effort: effort(env.MERIV3_FAST_REASONING_EFFORT, 'low'),
        maxOutputTokens: positiveInt(env.MERIV3_FAST_MAX_OUTPUT_TOKENS, 8_192, 1_024, 32_768),
        maxToolRounds: positiveInt(env.MERIV3_FAST_MAX_TOOL_ROUNDS, 6, 1, 20),
        turnBudgetMs: positiveInt(env.MERIV3_FAST_TURN_BUDGET_MS, 90_000, 15_000, 600_000),
      };
    case 'deep':
      return {
        mode,
        label: 'Deep',
        description: 'More investigation for strategic or ambiguous questions.',
        model: deepModel,
        effort: effort(env.MERIV3_DEEP_REASONING_EFFORT, 'high'),
        maxOutputTokens: positiveInt(env.MERIV3_DEEP_MAX_OUTPUT_TOKENS, 24_576, 2_048, 65_536),
        maxToolRounds: positiveInt(env.MERIV3_DEEP_MAX_TOOL_ROUNDS, 14, 1, 30),
        turnBudgetMs: positiveInt(env.MERIV3_DEEP_TURN_BUDGET_MS, 300_000, 30_000, 900_000),
      };
    case 'max':
      return {
        mode,
        label: 'Max',
        description: 'Highest configured reasoning tier for the hardest work.',
        model: maxModel,
        effort: effort(env.MERIV3_MAX_REASONING_EFFORT, 'max'),
        maxOutputTokens: positiveInt(env.MERIV3_MAX_MAX_OUTPUT_TOKENS, 32_768, 4_096, 65_536),
        maxToolRounds: positiveInt(env.MERIV3_MAX_MAX_TOOL_ROUNDS, 18, 1, 36),
        turnBudgetMs: positiveInt(env.MERIV3_MAX_TURN_BUDGET_MS, 480_000, 60_000, 1_200_000),
      };
    case 'standard':
    default:
      return {
        mode: 'standard',
        label: 'Standard',
        description: 'Balanced reasoning for everyday government-affairs work.',
        model: standardModel,
        effort: effort(env.MERIV3_STANDARD_REASONING_EFFORT, 'medium'),
        maxOutputTokens: positiveInt(
          env.MERIV3_STANDARD_MAX_OUTPUT_TOKENS,
          16_384,
          2_048,
          49_152,
        ),
        maxToolRounds: positiveInt(env.MERIV3_STANDARD_MAX_TOOL_ROUNDS, 10, 1, 24),
        turnBudgetMs: positiveInt(env.MERIV3_STANDARD_TURN_BUDGET_MS, 180_000, 30_000, 720_000),
      };
  }
}

export function listMeriV3ReasoningProfiles(
  env: NodeJS.ProcessEnv = process.env,
): MeriV3ReasoningProfile[] {
  return MERIV3_REASONING_MODES.map((mode) => resolveMeriV3ReasoningProfile(mode, env));
}
