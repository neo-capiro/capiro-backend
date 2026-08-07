import type { TenantContext } from '@capiro/shared';
import { MeriService } from './meri.service.js';
import { MeriV3ProxyService } from './meriv3-proxy.service.js';

export const RAW_MERI_SERVICE = Symbol('RAW_MERI_SERVICE');

/**
 * Route only the chat stream method through MeriV3 when the authenticated
 * tenant passes the server-side canary gate. Every other MeriService method is
 * bound to the existing implementation, so conversations, alerts, memory,
 * research, attachments and artifacts retain their current ownership.
 *
 * Rollback is instant: when the V3 gate resolves false, the exact original
 * streamMessage method is invoked. There is no silent mid-turn fallback after a
 * V3 turn has started, because that could duplicate writes or mix providers.
 */
export function createMeriRuntimeService(
  raw: MeriService,
  meriv3: MeriV3ProxyService,
): MeriService {
  return new Proxy(raw, {
    get(target, property, receiver) {
      if (property === 'streamMessage') {
        return async (...args: Parameters<MeriService['streamMessage']>) => {
          const ctx = args[0] as TenantContext;
          return (await meriv3.shouldHandle(ctx))
            ? meriv3.streamMessage(...args)
            : target.streamMessage(...args);
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
