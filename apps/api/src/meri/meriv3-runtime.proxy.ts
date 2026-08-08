import type { TenantContext } from '@capiro/shared';
import { MeriService } from './meri.service.js';
import { MeriV3ProxyService } from './meriv3-proxy.service.js';
import { MeriV3VisualAnalysisService } from './meri-v3-visual-analysis.service.js';

export const RAW_MERI_SERVICE = Symbol('RAW_MERI_SERVICE');

/**
 * Route only the full-chat stream through MeriV3 when the authenticated tenant
 * passes the server-side canary gate. Every other MeriService method remains
 * bound to the existing implementation, except analysis-chart image reads:
 * those delegate to the new tenant + user scoped artifact reader for BOTH V2
 * and V3. That closes the legacy endpoint's tenant-only lookup without changing
 * its public URL or requiring a duplicate controller.
 *
 * Rollback is instant: when the V3 gate resolves false, the exact original
 * streamMessage method is invoked. There is no silent mid-turn fallback after a
 * V3 turn has started, because that could duplicate writes or mix providers.
 */
export function createMeriRuntimeService(
  raw: MeriService,
  meriv3: MeriV3ProxyService,
  visualAnalysis: MeriV3VisualAnalysisService,
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
      if (property === 'getArtifactImage') {
        return (...args: Parameters<MeriService['getArtifactImage']>) =>
          visualAnalysis.getArtifactImage(...args);
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
