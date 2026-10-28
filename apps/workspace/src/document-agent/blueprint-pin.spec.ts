import { describe, it, expect, jest } from '@jest/globals';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { DocumentAgentService } from './document-agent.service.js';
import { createInitialAgentState, readAgentState } from './document-agent-state.js';

jest.mock('../generation/generation.service.js', () => ({ GenerationService: class {} }));

const tenant = 'current-tenant',
  draftId = 'draft',
  actor = 'member';
const pin = {
  blueprintId: '11111111-1111-4111-8111-111111111111',
  versionId: '22222222-2222-4222-8222-222222222222',
  version: 1,
  definitionHash: 'a'.repeat(64),
};

function fixture(parentTenant: string | null = tenant, role = 'owner') {
  let config: Record<string, unknown> = {};
  const version = {
    id: pin.versionId,
    blueprintId: pin.blueprintId,
    version: 1,
    definitionHash: pin.definitionHash,
    status: 'published',
    publishedAt: new Date(),
    definition: { sections: [] },
  };
  const db = {
    wsDraft: {
      findFirst: jest.fn(async ({ where }: { where: { id: string; tenantId: string } }) =>
        where.id === draftId && where.tenantId === tenant
          ? {
              id: draftId,
              tenantId: tenant,
              ownerId: actor,
              config: structuredClone(config),
              updatedAt: new Date(),
            }
          : null,
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { config: { equals: unknown } };
          data: { config: Record<string, unknown> };
        }) => {
          if (JSON.stringify(where.config.equals) !== JSON.stringify(config)) return { count: 0 };
          config = structuredClone(data.config);
          return { count: 1 };
        },
      ),
    },
    wsBlueprintVersion: {
      findFirst: jest.fn(
        async ({
          where,
        }: {
          where: {
            id: string;
            blueprintId: string;
            blueprint?: { OR: Array<{ tenantId: string | null }> };
          };
        }) =>
          where.id === version.id &&
          where.blueprintId === version.blueprintId &&
          (!where.blueprint || where.blueprint.OR.some((x) => x.tenantId === parentTenant))
            ? { ...version }
            : null,
      ),
    },
  };
  const collaborators = {
    assertCan: jest.fn(
      async (
        _tenant: string,
        _draft: string,
        _actor: string,
        predicate: (role: string) => boolean,
      ) => {
        if (!predicate(role)) throw new ForbiddenException();
      },
    ),
  };
  const reasoning = { generateOutline: jest.fn(async () => ({ sections: [] })) };
  // The approved greenfield native conversation owner: a plain recorder port (no
  // network, model, SDK or database is touched) plus the EXISTING proposal-owner
  // seam the bridge hands a pending outline proposal to.
  const requests: Array<Record<string, unknown>> = [];
  const turn = jest.fn(async (request: Record<string, unknown>) => {
    requests.push(request);
    return {
      status: 'complete',
      runId: 'run-outline',
      result: {
        outline: [
          {
            id: 's1',
            title: 'Ask',
            purpose: 'state the ask',
            instructions: 'be precise',
            required: true,
            locked: false,
            targetWords: { min: 50, max: 120 },
            evidenceItemIds: [],
          },
        ],
      },
    };
  });
  const readTurn = jest.fn(async () => null);
  const cancel = jest.fn(async () => undefined);
  const proposals = { createProposal: jest.fn(async () => ({ proposalId: 'prop-outline' })) };
  return {
    db,
    version,
    collaborators,
    reasoning,
    requests,
    turn,
    readTurn,
    service: new DocumentAgentService(
      db as never,
      collaborators as never,
      reasoning as never,
      {} as never,
      proposals as never,
      { turn, readTurn, cancel } as never,
    ),
    saved: () => readAgentState(config),
    seed: () => {
      const state = createInitialAgentState();
      state.revision = 1;
      state.blueprintPin = { ...pin };
      config = { documentAgent: state };
    },
  };
}

describe('agent pin adoption and use', () => {
  it('initializes a global published pin and reads back the exact saved tuple', async () => {
    const h = fixture(null);
    await h.service.initializeAgent(tenant, draftId, actor, { blueprintPin: pin });
    expect((await h.service.getAgentState(tenant, draftId, actor)).state.blueprintPin).toEqual(pin);
    expect(h.saved().revision).toBe(1);
    expect(h.db.wsDraft.updateMany).toHaveBeenCalledTimes(1);
  });

  it.each(['draft', 'retired'])(
    'refuses initialization from %s before saving agent state',
    async (status) => {
      const h = fixture();
      h.version.status = status;
      await expect(
        h.service.initializeAgent(tenant, draftId, actor, { blueprintPin: pin }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(h.db.wsDraft.updateMany).not.toHaveBeenCalled();
      expect(h.reasoning.generateOutline).not.toHaveBeenCalled();
    },
  );

  it('preserves draft access admission before a pin lookup', async () => {
    const h = fixture(null, 'viewer');
    await expect(
      h.service.initializeAgent(tenant, draftId, actor, { blueprintPin: pin }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      h.service.patchAgentState(tenant, draftId, actor, 0, { blueprintPin: pin }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.db.wsBlueprintVersion.findFirst).not.toHaveBeenCalled();
    expect(h.db.wsDraft.updateMany).not.toHaveBeenCalled();
  });

  it('refuses an internally consistent foreign-tenant pin', async () => {
    const h = fixture('other-tenant');
    await expect(
      h.service.initializeAgent(tenant, draftId, actor, { blueprintPin: pin }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.db.wsDraft.updateMany).not.toHaveBeenCalled();
  });

  it('validates an explicit replacement through the existing revision owner', async () => {
    const h = fixture();
    h.seed();
    await h.service.patchAgentState(tenant, draftId, actor, 1, { blueprintPin: pin });
    expect(h.saved().blueprintPin).toEqual(pin);
    expect(h.saved().revision).toBe(2);
    await expect(
      h.service.patchAgentState(tenant, draftId, actor, 1, { blueprintPin: pin }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.db.wsDraft.updateMany).toHaveBeenCalledTimes(1);
  });

  it('refuses a changed hash without replacing the stored pin', async () => {
    const h = fixture();
    h.seed();
    await expect(
      h.service.patchAgentState(tenant, draftId, actor, 1, {
        blueprintPin: { ...pin, definitionHash: 'b'.repeat(64) },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.saved().blueprintPin).toEqual(pin);
    expect(h.db.wsDraft.updateMany).not.toHaveBeenCalled();
  });

  it.each(['published', 'retired'])(
    'uses the exact retained global %s version for outline generation',
    async (status) => {
      const h = fixture(null);
      h.seed();
      h.version.status = status;

      await h.service.generateOutline(tenant, draftId, actor, 1, true, 'session-credential');

      // The paid outline turn is issued exactly once, scoped to the EXACT
      // retained pin version that resolved above.
      expect(h.turn).toHaveBeenCalledTimes(1);
      expect(h.requests[0]!.phase).toBe('outline');
      expect(h.requests[0]!.paidGeneration).toBe(true);
      expect(h.requests[0]!.sources).toEqual(
        expect.arrayContaining([{ id: pin.versionId, kind: 'blueprint-version' }]),
      );
      // The retired legacy reasoning gateway is never consulted for a supported phase.
      expect(h.reasoning.generateOutline).not.toHaveBeenCalled();
      // The stored pin is untouched: the change stays a pending proposal.
      expect(h.saved().blueprintPin).toEqual(pin);
    },
  );

  it('refuses a stale stored pin before any paid turn, reasoning or persistence', async () => {
    const h = fixture();
    h.seed();
    h.version.definitionHash = 'b'.repeat(64);
    await expect(
      h.service.generateOutline(tenant, draftId, actor, 1, true, 'session-credential'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(h.turn).not.toHaveBeenCalled();
    expect(h.reasoning.generateOutline).not.toHaveBeenCalled();
    expect(h.db.wsDraft.updateMany).not.toHaveBeenCalled();
  });

  it('does not retarget an already initialized document when initialization is repeated', async () => {
    const h = fixture();
    h.seed();
    const result = await h.service.initializeAgent(tenant, draftId, actor, {
      blueprintPin: { ...pin, version: 99 },
    });
    expect(result.state.blueprintPin).toEqual(pin);
    expect(h.db.wsBlueprintVersion.findFirst).not.toHaveBeenCalled();
    expect(h.db.wsDraft.updateMany).not.toHaveBeenCalled();
  });
});
