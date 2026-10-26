import { randomUUID } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { OutreachV3StateController } from '../api/outreach-v3-state.controller.js';
import { OutreachSessionService } from './outreach-session.service.js';
import {
  createBlankCampaignSpecV1,
  hashCampaignSpecV1,
} from '../state/outreach-campaign-spec.v1.js';

const ctx = { tenantId: randomUUID(), userId: randomUUID() } as TenantContext;
function fixture() {
  const tx = {};
  const spec = createBlankCampaignSpecV1();
  const repository = {
    listOwnedSessions: jest.fn(async () => []),
    lockOwnedSession: jest.fn(async () => ({ id: 'synthetic-session', currentStateVersion: 3 })),
    loadStateVersion: jest.fn(async () => ({
      version: 3,
      specJsonb: spec,
      specHash: hashCampaignSpecV1(spec),
    })),
  };
  const prisma = { withTenantUser: jest.fn(async (_tenant, _user, fn) => fn(tx)) };
  return {
    tx,
    spec,
    repository,
    prisma,
    service: new OutreachSessionService(prisma as never, repository as never, {} as never),
  };
}

describe('WS20 bounded session search', () => {
  it('accepts a bounded query and rejects overlong/non-string input through HTTP and direct service', async () => {
    const dto = Reflect.getMetadata(
      'design:paramtypes',
      OutreachV3StateController.prototype,
      'listSessions',
    )[1];
    expect(
      await validate(plainToInstance(dto, { search: 'x'.repeat(160), limit: '25', offset: '100' })),
    ).toHaveLength(0);
    for (const search of ['x'.repeat(161), 42, ['text']]) {
      expect(await validate(plainToInstance(dto, { search }))).not.toHaveLength(0);
      const h = fixture();
      await expect(h.service.listSessions(ctx, { search: search as string })).rejects.toMatchObject(
        { code: 'OUTREACH_COMMAND_INVALID' },
      );
      expect(h.prisma.withTenantUser).not.toHaveBeenCalled();
    }
  });

  it.each([undefined, '', '   '])('preserves no-search paging defaults for %s', async (search) => {
    const h = fixture();
    await h.service.listSessions(ctx, { search });
    expect(h.repository.listOwnedSessions).toHaveBeenCalledWith(h.tx, ctx, {
      search: null,
      limit: 25,
      offset: 0,
      includeArchived: false,
    });
  });

  it('passes the trimmed literal search to the repository before page selection', async () => {
    const h = fixture();
    await h.service.listSessions(ctx, {
      search: '  %_ Topic  ',
      limit: 25,
      offset: 100,
      includeArchived: true,
    });
    expect(h.repository.listOwnedSessions).toHaveBeenCalledWith(h.tx, ctx, {
      search: '%_ Topic',
      limit: 25,
      offset: 100,
      includeArchived: true,
    });
  });
});

describe('WS20 current session receipt read', () => {
  it('locks ownership before loading the current version and verifies its canonical hash', async () => {
    const h = fixture();
    await expect(
      h.service.loadCurrentSpecWithinTx(h.tx as never, ctx, 'synthetic-session'),
    ).resolves.toEqual(h.spec);
    expect(h.repository.loadStateVersion).toHaveBeenCalledWith(h.tx, ctx, 'synthetic-session', 3);
    expect(h.repository.lockOwnedSession.mock.invocationCallOrder[0]).toBeLessThan(
      h.repository.loadStateVersion.mock.invocationCallOrder[0]!,
    );
    h.repository.loadStateVersion.mockResolvedValue({
      version: 3,
      specJsonb: h.spec,
      specHash: 'corrupt',
    });
    await expect(
      h.service.loadCurrentSpecWithinTx(h.tx as never, ctx, 'synthetic-session'),
    ).rejects.toMatchObject({ code: 'OUTREACH_STATE_CORRUPT' });
  });
});
