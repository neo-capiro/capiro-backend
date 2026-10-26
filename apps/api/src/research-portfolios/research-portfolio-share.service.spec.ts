import {
  ResearchPortfolioShareService,
  SHARE_LINK_LIFETIME_MS,
  SHARE_PIN_MAX_FAILURES,
  hashPin,
  validateLayout,
  verifyPin,
} from './research-portfolio-share.service.js';

const ctx: any = {
  tenantId: 'ed202609-2800-4000-8000-000000009000',
  userId: 'ed202609-2800-4000-8000-000000009001',
  role: 'standard_user',
};
const portfolioId = 'ed202609-2800-4000-8000-000000009010';
const clientId = 'ed202609-2800-4000-8000-000000009002';
const snapshotId = 'ed202609-2800-4000-8000-000000009020';
const designId = 'ed202609-2800-4000-8000-000000009030';
const layout = {
  columns: 12,
  widgets: [
    { id: 'header', kind: 'header', x: 0, y: 0, w: 12, h: 2, settings: {} },
    { id: 'totals', kind: 'key_totals', x: 0, y: 2, w: 6, h: 3, settings: {} },
  ],
  phoneOrder: ['header', 'totals'],
};

function harness(
  options: { role?: 'owner' | 'editor' | 'viewer'; enabled?: boolean; pin?: string } = {},
) {
  const pinHash = options.pin ? hashPin(options.pin) : null;
  const state: any = {
    setting:
      options.enabled === undefined
        ? null
        : {
            tenantId: ctx.tenantId,
            portfolioId,
            enabled: options.enabled,
            pinHash,
            pinUpdatedAt: new Date(),
            updatedAt: new Date(),
          },
    links: [] as any[],
    designs: [
      {
        id: designId,
        tenantId: ctx.tenantId,
        portfolioId,
        name: 'Client view',
        version: 3,
        layout,
        createdByUserId: ctx.userId,
        updatedByUserId: ctx.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    events: [] as any[],
  };
  const withClient = (row: any) => (row ? { ...row, client: { name: 'Client One' } } : row);
  const tx: any = {
    researchPortfolio: {
      findFirst: jest.fn().mockResolvedValue({
        id: portfolioId,
        tenantId: ctx.tenantId,
        name: 'Portfolio',
        purpose: 'Why',
        revision: 4,
        lifecycle: 'active',
        grants: [{ role: options.role ?? 'owner' }],
        clientLinks: [{ clientId }],
      }),
    },
    researchPortfolioShareSetting: {
      findUnique: jest.fn(async () => state.setting),
      upsert: jest.fn(async ({ create, update }: any) => {
        state.setting = state.setting
          ? { ...state.setting, ...update }
          : { ...create, updatedAt: new Date() };
        return state.setting;
      }),
      update: jest.fn(async ({ data }: any) => {
        state.setting = { ...state.setting, ...data };
        return state.setting;
      }),
    },
    researchPortfolioDashboardDesign: {
      findMany: jest.fn(async () => state.designs),
      findFirst: jest.fn(
        async ({ where }: any) => state.designs.find((d: any) => d.id === where.id) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: 'ed202609-2800-4000-8000-000000009031',
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        state.designs.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = state.designs.find((d: any) => d.id === where.id);
        Object.assign(row, data, { version: row.version + 1, updatedAt: new Date() });
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = state.designs.find(
          (d: any) => d.id === where.id && d.version === where.version,
        );
        if (!row) return { count: 0 };
        Object.assign(row, data, { version: row.version + 1, updatedAt: new Date() });
        return { count: 1 };
      }),
      findFirstOrThrow: jest.fn(async ({ where }: any) => {
        const row = state.designs.find((d: any) => d.id === where.id);
        if (!row) throw new Error('missing design');
        return row;
      }),
    },
    researchPortfolioShareLink: {
      findUnique: jest.fn(async ({ where }: any) =>
        withClient(
          state.links.find(
            (l: any) =>
              (where.tokenHash && l.tokenHash === where.tokenHash) ||
              (where.tenantId_operationKey &&
                l.operationKey === where.tenantId_operationKey.operationKey),
          ) ?? null,
        ),
      ),
      findFirst: jest.fn(async ({ where }: any) =>
        withClient(state.links.find((l: any) => l.id === where.id) ?? null),
      ),
      findMany: jest.fn(async () => state.links.map(withClient)),
      count: jest.fn(
        async () => state.links.filter((l: any) => !l.revokedAt && l.expiresAt > new Date()).length,
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = {
          id: `ed202609-2800-4000-8000-00000000a${String(state.links.length).padStart(3, '0')}`,
          revokedAt: null,
          openCount: 0,
          lastOpenedAt: null,
          failedPinAttempts: 0,
          lockedUntil: null,
          ...data,
        };
        state.links.push(row);
        return withClient(row);
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = state.links.find((l: any) => l.id === where.id);
        for (const [k, v] of Object.entries(data))
          row[k] =
            v && typeof v === 'object' && 'increment' in (v as any)
              ? row[k] + (v as any).increment
              : v;
        return withClient(row);
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const l of state.links)
          if (!l.revokedAt || where.revokedAt !== null) {
            Object.assign(l, data);
            count += 1;
          }
        return { count };
      }),
    },
    researchPortfolioEvent: {
      create: jest.fn(async ({ data }: any) => {
        state.events.push(data);
        return { id: 'event', ...data, occurredAt: new Date() };
      }),
    },
    client: { findFirst: jest.fn().mockResolvedValue({ name: 'Client One' }) },
    tenant: {
      findUnique: jest.fn().mockResolvedValue({ name: 'Firm', logoS3Key: 'tenants/x/logo.png' }),
    },
    tenantMembership: { findFirst: jest.fn().mockResolvedValue({ status: 'active' }) },
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ allowed: true }]),
  };
  let pendingLock = Promise.resolve();
  const transaction = async (fn: any) => {
    let release: (() => void) | undefined;
    const scoped = {
      ...tx,
      $queryRaw: jest.fn(async () => {
        const previous = pendingLock;
        pendingLock = new Promise<void>((resolve) => {
          release = resolve;
        });
        await previous;
        return [{ id: portfolioId }];
      }),
    };
    try {
      return await fn(scoped);
    } finally {
      release?.();
    }
  };
  const prisma: any = {
    withTenant: jest.fn(async (_tenantId: string, fn: any) => transaction(fn)),
    withTenantUser: jest.fn(async (_t: string, _u: string, fn: any) => transaction(fn)),
    withSystem: jest.fn(async (fn: any) => transaction(fn)),
  };
  const analytics: any = {
    snapshot: jest.fn().mockResolvedValue({
      id: snapshotId,
      name: 'Q4',
      capturedAt: '2026-10-20T00:00:00.000Z',
      portfolioRevision: 4,
      calculationVersion: 'research-portfolio-analytics-v2',
      membership: [
        {
          id: 'm1',
          targetKind: 'program',
          targetId: 'P1',
          label: 'Program one',
          disposition: 'included',
        },
      ],
      projection: {
        totals: [
          {
            basis: { fundingFiscalYear: 2027, stage: 'request' },
            value: '12.5',
            contributionCount: 1,
          },
        ],
        contributions: [],
        coverage: {
          eligibleMembers: 1,
          supportedMembers: 1,
          includedContributions: 1,
          excludedContributions: 0,
          overlapContributions: 0,
          unavailableMembers: 0,
        },
      },
      versions: { sources: [{ id: 'src-1' }] },
      limitations: [],
    }),
  };
  const changes: any = {
    listChanges: jest.fn().mockResolvedValue({
      items: [
        { id: 'e1', eventKind: 'member_added', occurredAt: '2026-10-19T00:00:00.000Z' },
        { id: 'e2', eventKind: 'client_linked', occurredAt: '2026-10-19T00:00:00.000Z' },
        { id: 'e3', eventKind: 'grant_upserted', occurredAt: '2026-10-19T00:00:00.000Z' },
      ],
      nextCursor: null,
    }),
  };
  const phase11: any = {
    getFit: jest.fn().mockResolvedValue({
      portfolioId,
      clientFits: [
        {
          clientId,
          clientName: 'Client One',
          fitScore: 62,
          availability: 'available',
          basis: null,
          refreshedAt: '2026-10-20T00:00:00.000Z',
        },
      ],
      calculatedAt: '2026-10-20T00:00:00.000Z',
    }),
  };
  const service = new ResearchPortfolioShareService(prisma, analytics, changes, phase11);
  return { service, tx, state, prisma };
}

describe('PIN hashing', () => {
  it('stores a salted scrypt hash and verifies only the same PIN', () => {
    const stored = hashPin('123456');
    expect(stored.startsWith('scrypt$')).toBe(true);
    expect(stored).not.toContain('123456');
    expect(verifyPin('123456', stored)).toBe(true);
    expect(verifyPin('123457', stored)).toBe(false);
    expect(hashPin('123456')).not.toEqual(stored);
  });
});

describe('dashboard layouts', () => {
  it('accepts a 12-column layout and fills the phone order', () => {
    const result = validateLayout({ columns: 12, widgets: layout.widgets, phoneOrder: ['totals'] });
    expect(result.phoneOrder).toEqual(['totals', 'header']);
  });
  it.each([
    [{ columns: 10, widgets: [], phoneOrder: [] }, /12 columns/],
    [
      {
        columns: 12,
        widgets: [{ id: 'a', kind: 'header', x: 10, y: 0, w: 4, h: 1, settings: {} }],
        phoneOrder: [],
      },
      /fit the 12-column grid/,
    ],
    [
      {
        columns: 12,
        widgets: [
          { id: 'a', kind: 'header', x: 0, y: 0, w: 4, h: 2, settings: {} },
          { id: 'b', kind: 'subjects', x: 2, y: 1, w: 4, h: 2, settings: {} },
        ],
        phoneOrder: [],
      },
      /overlap/,
    ],
    [
      {
        columns: 12,
        widgets: [{ id: 'a', kind: 'wizard', x: 0, y: 0, w: 4, h: 2, settings: {} }],
        phoneOrder: [],
      },
      /Unknown widget kind/,
    ],
  ])('refuses invalid layouts', (input, message) => {
    expect(() => validateLayout(input)).toThrow(message);
  });
});

describe('sharing settings', () => {
  it('requires a 6 to 12 digit PIN to turn sharing on, and only an Owner may do it', async () => {
    const owner = harness();
    await expect(owner.service.enableSharing(ctx, portfolioId, { pin: '12' })).rejects.toThrow(
      /6 to 12 digits/,
    );
    const result = await owner.service.enableSharing(ctx, portfolioId, { pin: '123456' });
    expect(result).toMatchObject({ enabled: true, pinSet: true, activeLinkCount: 0 });
    expect(owner.state.setting.pinHash).not.toContain('123456');
    expect(owner.state.events.map((e: any) => e.eventKind)).toEqual(['share_enabled']);
    const editor = harness({ role: 'editor' });
    await expect(editor.service.enableSharing(ctx, portfolioId, { pin: '123456' })).rejects.toThrow(
      /owner access required/,
    );
  });
  it('turning sharing off revokes every live link at once', async () => {
    const h = harness({ enabled: true, pin: '123456' });
    h.state.links.push({
      id: 'ed202609-2800-4000-8000-00000000a900',
      tenantId: ctx.tenantId,
      portfolioId,
      clientId,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 1000),
      tokenHash: 'a'.repeat(64),
      operationKey: 'k1',
      snapshotId,
      snapshotName: 'Q4',
      designId,
      designVersion: 3,
      branding: false,
      publishedByUserId: ctx.userId,
      publishedAt: new Date(),
      openCount: 0,
      lastOpenedAt: null,
      failedPinAttempts: 0,
      lockedUntil: null,
    });
    const result = await h.service.disableSharing(ctx, portfolioId);
    expect(result).toMatchObject({ enabled: false, pinSet: false, activeLinkCount: 0 });
    expect(h.state.links[0].revokedAt).toBeInstanceOf(Date);
    expect(h.state.links[0].revokeReason).toBe('sharing_disabled');
  });
});

describe('publishing', () => {
  const input = { operationKey: 'op-1', snapshotId, designId, clientId, branding: true };
  it('refuses to publish before sharing is on', async () => {
    const h = harness({ role: 'editor' });
    await expect(h.service.publishLink(ctx, portfolioId, input)).rejects.toThrow(/Turn sharing on/);
  });
  it('freezes the payload, returns the token once, expires in exactly one week and replays idempotently', async () => {
    const h = harness({ role: 'editor', enabled: true, pin: '123456' });
    const first = await h.service.publishLink(ctx, portfolioId, input);
    expect(first.replayed).toBe(false);
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);
    expect(first.link).toMatchObject({
      status: 'active',
      clientName: 'Client One',
      branding: true,
      designVersion: 3,
      snapshotName: 'Q4',
    });
    expect(
      new Date(first.link.expiresAt).getTime() - new Date(first.link.publishedAt).getTime(),
    ).toBe(SHARE_LINK_LIFETIME_MS);
    const row = h.state.links[0];
    expect(row.tokenHash).not.toEqual(first.token);
    expect(row.payload.branding).toEqual({ firmName: 'Firm', logoAvailable: true });
    expect(row.payload.preparedFor).toEqual({ clientName: 'Client One' });
    expect(row.payload.data.clientFit).toMatchObject({ fitScore: 62 });
    // Grants, client links and sharing events never reach a recipient.
    expect(row.payload.data.changes.map((c: any) => c.eventKind)).toEqual(['member_added']);
    const again = await h.service.publishLink(ctx, portfolioId, input);
    expect(again).toMatchObject({ replayed: true, token: null });
    expect(h.state.links).toHaveLength(1);
    await expect(
      h.service.publishLink(ctx, portfolioId, {
        ...input,
        clientId: 'ed202609-2800-4000-8000-000000009099',
      }),
    ).rejects.toThrow(/different link/);
  });
  it('refuses a client fit widget when no fit exists for that client', async () => {
    const h = harness({ role: 'editor', enabled: true, pin: '123456' });
    h.state.designs[0].layout = {
      columns: 12,
      widgets: [{ id: 'fit', kind: 'client_fit', x: 0, y: 0, w: 6, h: 3, settings: {} }],
      phoneOrder: ['fit'],
    };
    (h.service['phase11'] as any).getFit.mockResolvedValue({
      portfolioId,
      clientFits: [],
      calculatedAt: '2026-10-20T00:00:00.000Z',
    });
    await expect(h.service.publishLink(ctx, portfolioId, input)).rejects.toThrow(/client fit/);
  });
});

describe('recipient access', () => {
  async function published(role: 'owner' | 'editor' = 'editor') {
    const h = harness({ role, enabled: true, pin: '123456' });
    const { token } = await h.service.publishLink(ctx, portfolioId, {
      operationKey: 'op-2',
      snapshotId,
      designId,
      clientId,
      branding: false,
    });
    return { h, token: token! };
  }
  it('shows availability, then the dashboard only after the PIN, and nothing for a wrong, revoked or expired link', async () => {
    const { h, token } = await published();
    expect(await h.service.availability(token)).toEqual({ available: true });
    expect(await h.service.availability('f'.repeat(64))).toEqual({ available: false });
    await expect(h.service.dashboard(token, 'nope')).rejects.toThrow(/not available/);
    await expect(h.service.verifyPin(token, '000000', '203.0.113.9')).rejects.toThrow(
      /not available/,
    );
    const session = await h.service.verifyPin(token, '123456', '203.0.113.9');
    const dashboard = await h.service.dashboard(token, session.viewToken);
    expect(dashboard.portfolioName).toBe('Portfolio');
    expect(h.state.links[0].openCount).toBe(1);
    await h.service.revokeLink(ctx, portfolioId, h.state.links[0].id);
    await expect(h.service.dashboard(token, session.viewToken)).rejects.toThrow(/not available/);
    expect(await h.service.availability(token)).toEqual({ available: false });
  });
  it('locks the link after too many wrong PINs and a PIN change ends every session', async () => {
    const { h, token } = await published('owner');
    for (let i = 0; i < SHARE_PIN_MAX_FAILURES; i += 1)
      await expect(h.service.verifyPin(token, '999999', '203.0.113.9')).rejects.toThrow(
        /not available/,
      );
    expect(h.state.links[0].lockedUntil).toBeInstanceOf(Date);
    expect(await h.service.availability(token)).toEqual({ available: false });
    h.state.links[0].lockedUntil = null;
    const session = await h.service.verifyPin(token, '123456', '203.0.113.9');
    await h.service.changePin(ctx, portfolioId, { pin: '654321' });
    await expect(h.service.dashboard(token, session.viewToken)).rejects.toThrow(/not available/);
    const next = await h.service.verifyPin(token, '654321', '203.0.113.9');
    expect((await h.service.dashboard(token, next.viewToken)).snapshot.name).toBe('Q4');
  });
  it('counts concurrent wrong PINs under the same lock and commits failures before refusal', async () => {
    const { h, token } = await published();
    const outcomes = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) => h.service.verifyPin(token, '999999', `synthetic-${i}`)),
    );
    expect(outcomes.every((r) => r.status === 'rejected')).toBe(true);
    expect(h.state.links[0].failedPinAttempts).toBe(5);
    expect(h.state.links[0].lockedUntil).toBeInstanceOf(Date);
    await expect(h.service.verifyPin(token, '123456', 'synthetic-valid')).rejects.toThrow(
      /not available/,
    );
    expect(h.state.links[0].openCount).toBe(0);
  });
  it.each(['revoke', 'disable', 'pin'] as const)(
    'rechecks a public lookup queued behind %s',
    async (change) => {
      const { h, token } = await published('owner');
      const session = await h.service.verifyPin(token, '123456', 'synthetic');
      const entered = deferred(),
        resume = deferred();
      h.tx.researchPortfolio.findFirst.mockImplementationOnce(async () => {
        entered.resolve();
        await resume.promise;
        return {
          id: portfolioId,
          revision: 4,
          grants: [{ role: 'owner' }],
          clientLinks: [{ clientId }],
        };
      });
      const mutation =
        change === 'revoke'
          ? h.service.revokeLink(ctx, portfolioId, h.state.links[0].id)
          : change === 'disable'
            ? h.service.disableSharing(ctx, portfolioId)
            : h.service.changePin(ctx, portfolioId, { pin: '654321' });
      await entered.promise;
      const read = h.service.dashboard(token, session.viewToken);
      const verify = h.service.verifyPin(token, '123456', 'synthetic-next');
      const readResult = expect(read).rejects.toThrow(/not available/);
      const verifyResult = expect(verify).rejects.toThrow(/not available/);
      resume.resolve();
      await mutation;
      await Promise.all([readResult, verifyResult]);
    },
  );
  it('does not expose availability while sharing is disabled', async () => {
    const { h, token } = await published();
    h.state.setting.enabled = false;
    expect(await h.service.availability(token)).toEqual({ available: false });
  });
  it('starts a new failure window after the timed lock has expired', async () => {
    const { h, token } = await published();
    Object.assign(h.state.links[0], {
      failedPinAttempts: 5,
      lockedUntil: new Date(Date.now() - 1),
    });
    await expect(h.service.verifyPin(token, '000000', 'synthetic')).rejects.toThrow(
      /not available/,
    );
    expect(h.state.links[0].failedPinAttempts).toBe(1);
    expect(h.state.links[0].lockedUntil).toBeNull();
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('concurrent sharing mutations', () => {
  const input = { operationKey: 'same-operation', snapshotId, designId, clientId, branding: true };
  it('serializes publish with disable so reenable cannot revive an escaped link', async () => {
    const h = harness({ enabled: true, pin: '123456' });
    const entered = deferred(),
      resume = deferred();
    h.tx.client.findFirst.mockImplementationOnce(async () => {
      entered.resolve();
      await resume.promise;
      return { name: 'Client One' };
    });
    const publishing = h.service.publishLink(ctx, portfolioId, input);
    await entered.promise;
    const disabling = h.service.disableSharing(ctx, portfolioId);
    resume.resolve();
    const first = await publishing;
    await disabling;
    await h.service.enableSharing(ctx, portfolioId, { pin: '654321' });
    expect(await h.service.availability(first.token!)).toEqual({ available: false });
    expect(h.state.links[0].revokedAt).toBeInstanceOf(Date);
  });
  it('serializes same-key publication and refuses changed design or branding', async () => {
    const h = harness({ enabled: true, pin: '123456' });
    const links = await Promise.all([
      h.service.publishLink(ctx, portfolioId, input),
      h.service.publishLink(ctx, portfolioId, input),
    ]);
    expect(h.state.links).toHaveLength(1);
    expect(links.map((link) => link.replayed).sort()).toEqual([false, true]);
    await expect(
      h.service.publishLink(ctx, portfolioId, { ...input, branding: false }),
    ).rejects.toThrow(/different link/);
    await expect(
      h.service.publishLink(ctx, portfolioId, { ...input, designId: 'other-design' }),
    ).rejects.toThrow(/different link/);
  });
  it('lets only one editor save an expected design version and refuses missing versions', async () => {
    const h = harness({ enabled: true, pin: '123456' });
    const results = await Promise.allSettled(
      ['A', 'B'].map((name) =>
        h.service.saveDesign(ctx, portfolioId, designId, {
          name,
          layout: layout as any,
          expectedVersion: 3,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(h.state.designs[0].version).toBe(4);
    await expect(
      h.service.saveDesign(ctx, portfolioId, designId, { name: 'C', layout: layout as any }),
    ).rejects.toThrow(/expectedVersion/);
  });
  it('refuses an atomic design update that loses its version predicate', async () => {
    const h = harness();
    h.tx.researchPortfolioDashboardDesign.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      h.service.saveDesign(ctx, portfolioId, designId, {
        name: 'A',
        layout: layout as any,
        expectedVersion: 3,
      }),
    ).rejects.toThrow(/saved this design first/);
    expect(h.state.events).toHaveLength(0);
  });
  it('rejects malformed widgets and does not repeat a phone widget', () => {
    expect(() => validateLayout({ columns: 12, widgets: [null] })).toThrow(/must be an object/);
    expect(validateLayout({ ...layout, phoneOrder: ['header', 'header'] }).phoneOrder).toEqual([
      'header',
      'totals',
    ]);
  });
});
