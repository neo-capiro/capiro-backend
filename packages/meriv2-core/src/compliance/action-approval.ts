import { createHash } from 'node:crypto';
import type { MeriContext } from '../registry/types';
import type { ApprovalStore } from './approval-gate';

/**
 * B3 — the pending-action approval mechanism.
 *
 * A WARN decision (from the compliance policy) means "this write needs explicit
 * human approval before it runs". The gate asks an `ApprovalStore` whether THIS
 * exact proposed action has already been approved. This module provides:
 *
 *   - `computeActionFingerprint` — a stable id for a proposed action, over
 *     (tenant, user, tool, canonicalized input). Same action → same
 *     fingerprint; a changed recipient / body / any field → a different one, so
 *     an approval can never be replayed against a mutated action.
 *   - `ApprovalRepo` — the persistence port (implemented by apps/api, B4).
 *   - `RepoBackedApprovalStore` — the `ApprovalStore` the gate uses: fingerprint
 *     the action, ask the repo.
 *   - `InMemoryApprovalRepo` — a deterministic in-memory repo for tests + the
 *     dormant default (approves nothing until a real repo is wired).
 *
 * Pure except for the sha256 (node:crypto — the orchestrator runtime, same as
 * the rest of the Node-hosted core). No DB here; that is the repo's job.
 *
 * POLICY, deliberately NOT decided here (needs Neo — B4 lifecycle): approval
 * TTL, WHO may approve (self vs a second person / four-eyes), and whether one
 * approval covers a re-run. Those are properties of the repo's stored rows /
 * the surface flow, not of this fingerprint mechanism.
 */

/** Deterministic JSON with object keys sorted at every level (stable fingerprints). */
export function canonicalize(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) return '[circular]';
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = walk((v as Record<string, unknown>)[k]);
    }
    return out;
  };
  return JSON.stringify(walk(value));
}

/**
 * Stable fingerprint for a proposed write action. Scoped to (tenant, user) so an
 * approval in one tenant/user context can never authorize another's action.
 */
export function computeActionFingerprint(
  toolName: string,
  input: unknown,
  ctx: Pick<MeriContext, 'tenantId' | 'userId'>,
): string {
  const payload = canonicalize({
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    tool: toolName,
    input: input ?? null,
  });
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Persistence port for approvals (implemented by apps/api in B4). Given a
 * fingerprint + caller, has a human approved this exact action? Kept minimal so
 * meriv2-core stays DB-free; the pending-action row lifecycle lives in apps/api.
 */
export interface ApprovalRepo {
  isApproved(fingerprint: string, ctx: MeriContext): boolean | Promise<boolean>;
}

/**
 * The `ApprovalStore` the registry gate uses: fingerprint the proposed action,
 * then consult the repo. A repo error propagates (fail-closed: the gate treats a
 * thrown store as "not approved" via ApprovalPendingError — it never executes).
 */
export class RepoBackedApprovalStore implements ApprovalStore {
  constructor(private readonly repo: ApprovalRepo) {}

  async isApproved(toolName: string, input: unknown, ctx: MeriContext): Promise<boolean> {
    const fingerprint = computeActionFingerprint(toolName, input, ctx);
    return this.repo.isApproved(fingerprint, ctx);
  }
}

/**
 * In-memory `ApprovalRepo` — the dormant default (approves nothing) and the test
 * double. Approvals are recorded by fingerprint; call `approve(...)` with the
 * same (tool, input, ctx) the gate will see.
 */
export class InMemoryApprovalRepo implements ApprovalRepo {
  private readonly approved = new Set<string>();

  approve(toolName: string, input: unknown, ctx: Pick<MeriContext, 'tenantId' | 'userId'>): void {
    this.approved.add(computeActionFingerprint(toolName, input, ctx));
  }

  approveFingerprint(fingerprint: string): void {
    this.approved.add(fingerprint);
  }

  isApproved(fingerprint: string): boolean {
    return this.approved.has(fingerprint);
  }
}
