import { NotFoundException } from '@nestjs/common';
import { MeriToolsService } from './meri-tools.service.js';
import type { TenantContext } from '@capiro/shared';

/**
 * ensureClientVisible — the single choke point every client-scoped Meri tool
 * passes its clientId through.
 *
 * It carries two fixes for the same user-visible symptom ("Action approved but
 * failed to run"):
 *   - a non-UUID must never reach the Postgres cast (raw P2023), and
 *   - an exact display NAME must resolve to its id, because in an UNFOCUSED
 *     conversation there is no conversation client to fall back on and the
 *     model has nothing but the name. That resolution is the follow-up commit
 *     1be58d95 explicitly deferred ("optionally resolve an exact client NAME ->
 *     id for unfocused conversations").
 *
 * Exactness is the safety property: these run on the approve-replay path, where
 * the user has ALREADY said yes, so a fuzzy match would write one client's data
 * onto another with no further confirmation.
 */

const CTX = {
  tenantId: 'a8dce0a5-af14-46fd-bb7e-f7f754556d3e',
  userId: 'cc01a549-5381-4ebd-b714-ec8c597392f6',
} as unknown as TenantContext;

const UUID = 'b7c9e1a2-0000-4000-8000-00000000abcd';

function makeService(opts: { byId?: unknown | null; byName?: unknown[] }) {
  const findFirst = jest.fn().mockResolvedValue(opts.byId ?? null);
  const findMany = jest.fn().mockResolvedValue(opts.byName ?? []);
  const service = Object.create(MeriToolsService.prototype) as MeriToolsService;
  (service as unknown as { prisma: unknown }).prisma = {
    withTenant: (_t: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn({ client: { findFirst, findMany } }),
  };
  const resolve = (service as unknown as Record<string, unknown>).ensureClientVisible as (
    ctx: TenantContext,
    clientId: string,
  ) => Promise<string>;
  return { resolve: resolve.bind(service), findFirst, findMany };
}

describe('ensureClientVisible', () => {
  it('returns a valid, visible UUID unchanged', async () => {
    const { resolve, findMany } = makeService({ byId: { id: UUID } });
    await expect(resolve(CTX, UUID)).resolves.toBe(UUID);
    expect(findMany).not.toHaveBeenCalled(); // no name lookup for a real id
  });

  it('404s on a UUID that is not visible in this tenant', async () => {
    const { resolve } = makeService({ byId: null });
    await expect(resolve(CTX, UUID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('resolves an exact display name to its id (the unfocused-conversation case)', async () => {
    const { resolve, findMany } = makeService({ byName: [{ id: UUID, name: 'Ballard Partners' }] });
    await expect(resolve(CTX, 'Ballard Partners')).resolves.toBe(UUID);
    expect(findMany).toHaveBeenCalledTimes(1);
    // Exact + case-insensitive, never `contains`.
    const where = findMany.mock.calls[0]?.[0]?.where as { name?: unknown };
    expect(where.name).toEqual({ equals: 'Ballard Partners', mode: 'insensitive' });
  });

  it('matches case-insensitively and tolerates surrounding whitespace', async () => {
    const { resolve } = makeService({ byName: [{ id: UUID, name: 'Ballard Partners' }] });
    await expect(resolve(CTX, '  ballard partners ')).resolves.toBe(UUID);
  });

  it('refuses an ambiguous name rather than guessing which client to write to', async () => {
    const { resolve } = makeService({
      byName: [
        { id: UUID, name: 'Acme' },
        { id: 'c1d2e3f4-0000-4000-8000-00000000beef', name: 'ACME' },
      ],
    });
    await expect(resolve(CTX, 'Acme')).rejects.toThrow(/matches 2 clients/i);
  });

  it('tells the model to create the client when the name is unknown', async () => {
    const { resolve } = makeService({ byName: [] });
    // This is the BryceTech case: profile fill proposed for a client whose
    // create_client was never approved, so the row does not exist.
    await expect(resolve(CTX, 'BryceTech')).rejects.toThrow(
      /lookup_client_registry \+ create_client/,
    );
  });

  it('rejects an empty reference with the scope-selection hint', async () => {
    const { resolve } = makeService({});
    await expect(resolve(CTX, '   ')).rejects.toThrow(/No client is scoped to this conversation/);
  });
});
