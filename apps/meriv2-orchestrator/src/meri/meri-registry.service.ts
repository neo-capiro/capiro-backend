import { Injectable } from '@nestjs/common';
import {
  InMemoryToolRegistry,
  createGetClientContextTool,
  type ToolRegistry,
} from '@capiro/meriv2-core';
import { ApiClientContextRepo } from './api-client-context.repo.js';

/**
 * Owns the single MeriV2 tool registry the orchestrator hosts. Phase 0
 * registers the migration-template tool (`get_client_context`). Every later
 * capability registers here; nothing executes a tool except through
 * `registry.invoke`, which enforces input validation + scoping + the write
 * approval gate.
 */
@Injectable()
export class MeriRegistryService {
  readonly registry: ToolRegistry;

  constructor(clientContextRepo: ApiClientContextRepo) {
    const registry = new InMemoryToolRegistry();
    registry.register(createGetClientContextTool(clientContextRepo));
    this.registry = registry;
  }
}
