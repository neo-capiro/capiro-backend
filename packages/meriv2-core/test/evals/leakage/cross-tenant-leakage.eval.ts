import { z } from 'zod';
import { InMemoryToolRegistry, type MeriContext, type ToolDefinition } from '../../../src/index';
import type { EvalCase } from '../types';

/** Multi-tenant fixture; a correctly-scoped tool returns ONLY ctx.tenantId rows. */
const STORE: Record<string, string[]> = {
  'tenant-a': ['a-secret-1', 'a-secret-2'],
  'tenant-b': ['b-secret-1'],
};

type Empty = Record<string, never>;

function scopedTool(): ToolDefinition<Empty, { items: string[] }> {
  return {
    name: 'list_secrets',
    description: 'list tenant secrets (correctly scoped on ctx.tenantId)',
    readOnly: true,
    inputSchema: z.object({}),
    handler: async (_input, ctx) => ({ items: STORE[ctx.tenantId] ?? [] }),
  };
}

/**
 * A BUGGY tool that ignores scope and returns ALL tenants' rows. Registered
 * ONLY when MERIV2_EVAL_SEED_FAILURE=1, to prove the gate goes RED on a real
 * cross-client leak (SC0.6). Remove the env var → the gate goes green.
 */
function leakyTool(): ToolDefinition<Empty, { items: string[] }> {
  return {
    name: 'list_secrets',
    description: 'list tenant secrets (BUGGY: ignores scope)',
    readOnly: true,
    inputSchema: z.object({}),
    handler: async () => ({ items: Object.values(STORE).flat() }),
  };
}

const ctxA: MeriContext = {
  tenantId: 'tenant-a',
  userId: 'user-a',
  clerkUserId: 'clerk_a',
  role: 'standard_user',
};

export const crossTenantLeakageCase: EvalCase = {
  id: 'leakage.cross-tenant.list_secrets',
  category: 'leakage',
  description: 'a tool invoked as tenant-a must never return tenant-b rows',
  async run() {
    const registry = new InMemoryToolRegistry();
    const seedFailure = process.env.MERIV2_EVAL_SEED_FAILURE === '1';
    registry.register(seedFailure ? leakyTool() : scopedTool());

    const out = await registry.invoke<{ items: string[] }>('list_secrets', {}, ctxA);
    const allowed = STORE['tenant-a'] ?? [];
    const leaked = out.items.filter((row) => !allowed.includes(row));
    return {
      pass: leaked.length === 0,
      detail:
        leaked.length === 0
          ? `no cross-tenant rows returned (${out.items.length} own rows)`
          : `LEAK: returned foreign rows [${leaked.join(', ')}]`,
    };
  },
};
