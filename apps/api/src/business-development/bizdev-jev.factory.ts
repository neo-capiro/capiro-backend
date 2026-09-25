import {
  createJevClient,
  createJevChoiceTaskProvider,
  JEV_TASK_REGISTRY,
  resolveJevConfig,
  resolveJevProviderMode,
  resolveJevTaskRollout,
  type JevChoiceTaskProvider,
  type JevClient,
} from '@capiro/meriv2-core';
import { Injectable, Logger } from '@nestjs/common';
import type { CapabilityRolloutEnvironment } from '@capiro/meriv2-core';
import type { BdJevTask } from './bizdev-jev-mode.js';
import type { BizDevJevFactory } from './bizdev-jev.service.js';

/**
 * API-side BD Jev provider factory — the apps/api mirror of the orchestrator's
 * jev-provider.factory.ts. Reuses the shared @capiro/meriv2-core config /
 * client / registry / envelope-bound Choice provider exactly; no second
 * client exists. The injected environment is used CONSISTENTLY for config,
 * the API key, and the shared provider rollout/enrollment controls.
 *
 * A provider is returned only when ALL of these hold:
 *   - shared JevConfig is available (key present, pinned model valid);
 *   - the shared provider rollout resolves a non-off mode for this tenant on
 *     the `research` surface (MERI_JEV_PROVIDER_MODE + tenant allowlist +
 *     surface enrollment);
 *   - the task is present in MERI_JEV_TASKS;
 *   - the task registry ceiling (resolveJevTaskRollout) yields a non-off mode
 *     (lifecycle/model checks; a shadow-only task is capped at shadow, which
 *     is fine for our shadow/canary evaluation semantics).
 * Absent task or provider enrollment → no provider (null) — the shadow
 * consumer then records `not_checked`.
 */

export function createBizDevJevFactory(
  env: CapabilityRolloutEnvironment,
  fetchImpl?: typeof globalThis.fetch,
  now?: () => number,
): BizDevJevFactory {
  const config = resolveJevConfig(env);
  const clients = new Map<string, JevClient>();
  const logger = new Logger('BizDevJevProviderFactory');
  if (!config.available) {
    logger.log(`bizdev jev provider config unavailable: ${config.reasons.join(',')}`);
  }
  return {
    createProvider(task: BdJevTask, tenantId: string): JevChoiceTaskProvider | null {
      if (!config.available) return null;
      const registration = JEV_TASK_REGISTRY[task];
      if (!registration || registration.lifecycle === 'inactive') return null;
      if (!config.tasks.includes(task)) return null;
      const providerMode = resolveJevProviderMode(env, tenantId, 'research');
      if (providerMode === 'off') return null;
      const taskMode = resolveJevTaskRollout(task, config, providerMode);
      if (taskMode === 'off') return null;
      const apiKey = env.TYPESAFE_API_KEY ?? '';
      if (!apiKey.trim()) return null;
      const cacheKey = `${task}:${tenantId}`;
      let client = clients.get(cacheKey);
      if (!client) {
        client = createJevClient({
          apiKey,
          baseUrl: config.baseUrl,
          model: config.model,
          timeoutMs: config.timeoutMs,
          maxAttempts: config.maxAttempts,
          ...(fetchImpl ? { fetchImpl } : {}),
          ...(now ? { now } : {}),
        });
        clients.set(cacheKey, client);
      }
      return createJevChoiceTaskProvider({
        task,
        client,
        model: config.model,
        scope: { tenantId, surface: 'research' },
      });
    },
  };
}

/** Zero-arg Nest wrapper so DI never sees optional plain-object dependencies. */
@Injectable()
export class BizDevJevProviderFactory implements BizDevJevFactory {
  private readonly impl: BizDevJevFactory;

  constructor() {
    this.impl = createBizDevJevFactory(process.env);
  }

  createProvider(task: BdJevTask, tenantId: string): JevChoiceTaskProvider | null {
    return this.impl.createProvider(task, tenantId);
  }
}