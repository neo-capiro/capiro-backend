import { AsyncLocalStorage } from 'node:async_hooks';
import type { MeriGovernedTurnContext } from '@capiro/meriv2-core';

const runtime = new AsyncLocalStorage<MeriGovernedTurnContext>();

export function currentGovernedMeriContext(): MeriGovernedTurnContext | null {
  return runtime.getStore() ?? null;
}

export async function runWithGovernedMeriContext<T>(
  context: MeriGovernedTurnContext,
  fn: () => Promise<T>,
): Promise<T> {
  return runtime.run(context, fn);
}

export function withGovernedPrompt(
  existing: string | undefined,
  governed: MeriGovernedTurnContext,
): string {
  return [existing?.trim(), governed.prompt.trim()].filter(Boolean).join('\n\n');
}
