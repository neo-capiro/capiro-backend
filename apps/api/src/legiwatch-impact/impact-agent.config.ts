import type { PortfolioAgentRequest } from '../clients/portfolio-agent.service.js';

/** Deployment-owned settings shared by the tracker and selected-version impact route. */
export function impactAgentConfig(
  env: NodeJS.ProcessEnv = process.env,
): Pick<PortfolioAgentRequest, 'runtime' | 'timeoutMs' | 'maxTurns' | 'maxBudgetUsd'> {
  const provider = env.LEGIWATCH_AGENT_PROVIDER?.trim() || 'bedrock';
  if (provider !== 'bedrock' && provider !== 'anthropic')
    throw new Error('Impact configuration unavailable');
  const model =
    env.LEGIWATCH_AGENT_MODEL?.trim() ||
    (provider === 'bedrock' ? env.PORTFOLIO_AGENT_MODEL?.trim() : undefined);
  if (!model) throw new Error('Impact configuration unavailable');
  const number = (key: string, fallback: number, min: number, max: number, integer = true) => {
    const raw = env[key];
    const value = raw === undefined ? fallback : Number(raw);
    if (
      (raw !== undefined && !/^\d+(?:\.\d+)?$/.test(raw)) ||
      !Number.isFinite(value) ||
      value < min ||
      value > max ||
      (integer && !Number.isInteger(value))
    )
      throw new Error('Impact configuration unavailable');
    return value;
  };
  return {
    runtime: { provider, model },
    timeoutMs: number('LEGIWATCH_AGENT_TIMEOUT_MS', 90_000, 1_000, 120_000),
    maxTurns: number('LEGIWATCH_AGENT_MAX_TURNS', 4, 1, 8),
    maxBudgetUsd: number('LEGIWATCH_AGENT_MAX_BUDGET_USD', 0.5, 0.03, 2, false),
  };
}
