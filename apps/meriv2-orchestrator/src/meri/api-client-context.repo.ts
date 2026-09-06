import { Injectable } from '@nestjs/common';
import type {
  ClientContextRepo,
  ClientContextResult,
  MeriContext,
  ToolExecutionControl,
} from '@capiro/meriv2-core';
import { ApiToolExecutorRepo } from './api-tool-executor.repo.js';

/**
 * Native tool bridge to the canonical API get_client_context handler. Reuse
 * the delegated executor so bearer identity, tenant impersonation, service
 * authentication and timeouts stay identical to other governed tool reads.
 */
@Injectable()
export class ApiClientContextRepo implements ClientContextRepo {
  constructor(private readonly executor: ApiToolExecutorRepo) {}

  async loadClientContext(
    ctx: MeriContext,
    clientId: string,
    options: Parameters<ClientContextRepo['loadClientContext']>[2] = {},
    control?: ToolExecutionControl,
  ): Promise<ClientContextResult> {
    const result = await this.executor.execute(
      ctx,
      'get_client_context',
      { ...options, clientId },
      control,
    );
    const payload = result as { context?: ClientContextResult } & Record<string, unknown>;
    if (!payload?.context?.client?.id) {
      throw new Error('Canonical client-context response is missing its client context');
    }
    // Preserve the native tool's established top-level engagement fields while
    // adding the canonical profile/coverage. Avoid sending the same engagement
    // records twice to the model in both flat and nested form.
    const { context, ...richFields } = payload;
    return { ...richFields, ...context } as ClientContextResult;
  }
}
