import { AsyncLocalStorage } from 'node:async_hooks';
import type { StrategyGovernedTurnContext } from './strategy-governed-context.types.js';

const runtime = new AsyncLocalStorage<StrategyGovernedTurnContext>();

export function currentStrategyGovernedContext(): StrategyGovernedTurnContext | null {
  return runtime.getStore() ?? null;
}

export function runWithStrategyGovernedContext<T>(
  context: StrategyGovernedTurnContext,
  fn: () => Promise<T>,
): Promise<T> {
  return runtime.run(context, fn);
}
