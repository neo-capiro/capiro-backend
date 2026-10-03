import { AsyncLocalStorage } from 'node:async_hooks';
import type { MeriGovernedTurnContext, MeriPromptClockUse } from '@capiro/meriv2-core';

const runtime = new AsyncLocalStorage<{ context: MeriGovernedTurnContext; promptClockUse?: MeriPromptClockUse }>();

export function currentGovernedMeriContext(): MeriGovernedTurnContext | null {
  return runtime.getStore()?.context ?? null;
}

export async function runWithGovernedMeriContext<T>(
  context: MeriGovernedTurnContext,
  fn: () => Promise<T>,
): Promise<T> {
  return runtime.run({ context }, fn);
}

/** Recorded at prompt rendering, outside the immutable authenticated context. */
export function recordMeriPromptClockUse(observation: MeriPromptClockUse): void {
  const state = runtime.getStore();
  if (!state?.context.semanticClock) throw new Error('meri_prompt_clock_runtime_missing');
  state.promptClockUse = Object.freeze({ ...observation });
}

export function currentMeriPromptClockUse(): MeriPromptClockUse | undefined {
  const observation = runtime.getStore()?.promptClockUse;
  return observation ? { ...observation } : undefined;
}

export function withGovernedPrompt(
  existing: string | undefined,
  governed: MeriGovernedTurnContext,
): string {
  return [existing?.trim(), governed.prompt.trim()].filter(Boolean).join('\n\n');
}
