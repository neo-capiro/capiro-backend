import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type ContextPacketPersistenceError,
  isContextPacketPersistenceError,
} from '@capiro/meriv2-core';

interface ContextPersistenceBoundaryState {
  failure: ContextPacketPersistenceError | null;
}

/**
 * Request/job-local record of a required Context Packet persistence failure.
 *
 * Some legacy generators intentionally fail soft around optional context. Phase 8
 * keeps that compatibility for ordinary failures, but a required persistence
 * error must survive those catches and block the result before release or job
 * completion.
 */
@Injectable()
export class ContextPersistenceBoundaryService {
  private readonly storage = new AsyncLocalStorage<ContextPersistenceBoundaryState>();

  run<T>(operation: () => T): T {
    return this.storage.run({ failure: null }, operation);
  }

  record(error: unknown): void {
    if (!isContextPacketPersistenceError(error)) return;
    const state = this.storage.getStore();
    if (state && !state.failure) state.failure = error;
  }

  async guard<T>(operation: () => T | Promise<T>): Promise<T> {
    return this.run(async () => {
      const result = await operation();
      const failure = this.failure();
      if (failure) throw failure;
      return result;
    });
  }

  failure(): ContextPacketPersistenceError | null {
    return this.storage.getStore()?.failure ?? null;
  }
}
