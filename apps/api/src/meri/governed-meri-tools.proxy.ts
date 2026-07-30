import { HttpException } from '@nestjs/common';
import { MeriToolsService } from './meri-tools.service.js';

export const RAW_MERI_TOOLS_SERVICE = Symbol('RAW_MERI_TOOLS_SERVICE');

interface GovernedMemorySignal {
  code?: unknown;
  status?: unknown;
  message?: unknown;
  title?: unknown;
  candidateId?: unknown;
  memoryItemId?: unknown;
  activeItemUnchanged?: unknown;
}

/**
 * Preserve MeriToolsService's complete dependency graph while translating the two
 * governed-memory control-flow signals emitted below the legacy correct_memory
 * presenter. Without this adapter, an expected shared-memory review proposal is
 * surfaced as a failed tool call because MeriToolsService.execute() has no catch.
 */
export function createGovernedMeriToolsService(raw: MeriToolsService): MeriToolsService {
  const present = async <T>(run: () => Promise<T>): Promise<T | Record<string, unknown>> => {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      const rawResponse = error.getResponse();
      if (!rawResponse || typeof rawResponse !== 'object') throw error;
      const response = rawResponse as GovernedMemorySignal;

      if (response.code === 'memory_pending_review') {
        return {
          corrected: false,
          pendingReview: true,
          status: 'pending_review',
          title: typeof response.title === 'string' ? response.title : undefined,
          candidateId:
            typeof response.candidateId === 'string' ? response.candidateId : undefined,
          activeItemUnchanged: response.activeItemUnchanged === true,
          message:
            typeof response.message === 'string'
              ? response.message
              : 'The correction was submitted for independent review. Active memory is unchanged.',
        };
      }

      if (response.code === 'memory_duplicate') {
        return {
          corrected: false,
          duplicate: true,
          status: 'duplicate',
          title: typeof response.title === 'string' ? response.title : undefined,
          memoryItemId:
            typeof response.memoryItemId === 'string' ? response.memoryItemId : undefined,
          message:
            typeof response.message === 'string'
              ? response.message
              : 'No correction was needed because that content already controls this scope.',
        };
      }

      throw error;
    }
  };

  return new Proxy(raw, {
    get(target, property) {
      if (property === 'execute') {
        return (...args: Parameters<MeriToolsService['execute']>) =>
          present(() => target.execute(...args));
      }
      if (property === 'executeFromAuthenticatedUser') {
        return (...args: Parameters<MeriToolsService['executeFromAuthenticatedUser']>) =>
          present(() => Promise.resolve(target.executeFromAuthenticatedUser(...args)));
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
