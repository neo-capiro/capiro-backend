import type { TenantContext } from '@capiro/shared';
import { KrispNotetakerService } from './krisp-notetaker.service.js';

jest.mock('../../meri/meri-managed-mcp.service.js', () => ({ MeriManagedMcpService: class {} }));
jest.mock('../../meeting-capture/meeting-capture-persistence.service.js', () => ({
  MeetingCapturePersistenceService: class {},
}));

const ctx = {
  tenantId: 'tenant',
  userId: 'user',
  tenantSlug: 'capiro-internal',
  clerkUserId: 'clerk',
  role: 'standard_user',
} as TenantContext;
const doc = 'a'.repeat(32);
const now = new Date();
const preference = {
  id: 'pref',
  ...ctx,
  serverId: 'server',
  revision: 1,
  enabled: true,
  enabledAt: new Date(0),
  folderId: null,
};

function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([key, value]: [string, any]) => {
    if (key === 'OR') return value.some((part: any) => matches(row, part));
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('in' in value) return value.in.includes(row[key]);
      if ('lt' in value) return row[key] < value.lt;
      if ('gt' in value) return row[key] > value.gt;
    }
    return row[key] === value;
  });
}

function fixture() {
  let item: any = {
    id: 'import',
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    documentId: doc,
    meetingId: 'meeting',
    status: 'pending',
    attempts: 0,
    leaseToken: null,
    leaseUntil: null,
  };
  const tenant = {
    slug: ctx.tenantSlug,
    status: 'active',
    settings: { clioFeatureFlags: { 'notetaker.krisp.enabled': true } },
  };
  const notes: any[] = [];
  const debriefs: any[] = [];
  const tx: any = {
    $queryRaw: jest.fn(async () => []),
    tenant: { findUnique: jest.fn(async () => tenant) },
    tenantMembership: { findFirst: jest.fn(async () => ({ status: 'active' })) },
    krispNotetakerPreference: { findFirst: jest.fn(async () => preference) },
    clioMcpServer: {
      findFirst: jest.fn(async () => ({ id: 'server', connectionStatus: 'connected' })),
    },
    meeting: {
      findFirst: jest.fn(async () => ({ id: 'meeting', clientId: 'client', updatedAt: now })),
    },
    krispMeetingImport: {
      findFirst: jest.fn(async ({ where }: any) => (matches(item, where) ? { ...item } : null)),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (!matches(item, where)) return { count: 0 };
        for (const [key, value] of Object.entries(data) as Array<[string, any]>) {
          item[key] = value?.increment
            ? item[key] + value.increment
            : value?.decrement
              ? item[key] - value.decrement
              : value;
        }
        return { count: 1 };
      }),
      update: jest.fn(async ({ data }: any) => {
        Object.assign(item, data);
        return item;
      }),
    },
    meetingNote: {
      create: jest.fn(async ({ data }: any) => {
        notes.push(data);
        return { id: 'note' };
      }),
    },
    meetingDebrief: {
      create: jest.fn(async ({ data }: any) => {
        debriefs.push(data);
        return { id: 'debrief' };
      }),
    },
  };
  const prisma = {
    withTenant: jest.fn(async (_tenant: string, fn: any) => fn(tx)),
    withTenantUser: jest.fn(async (_tenant: string, _user: string, fn: any) => {
      const before = { ...item };
      const n = notes.length;
      const d = debriefs.length;
      try {
        return await fn(tx);
      } catch (error) {
        item = before;
        notes.length = n;
        debriefs.length = d;
        throw error;
      }
    }),
  };
  const managed = {
    schemasForMeriV3: jest.fn(async () => [
      {
        appId: 'krisp',
        name: 'mcp__meriv3_krisp__get_multiple_documents',
        input_schema: {
          properties: { document_ids: { type: 'array' }, include_transcript: { type: 'boolean' } },
        },
      },
    ]),
    executeRead: jest.fn(async () => ({
      structuredResult: {
        structuredContent: { documents: [{ id: doc, transcript: 'Alice: Follow up tomorrow.' }] },
      },
    })),
  };
  const persistence = {
    generateMeetingDebriefDraft: jest.fn(async () => ({
      recap: 'Discussed plan',
      actionItems: ['Follow up'],
      notes: 'Agreed next steps',
    })),
  };
  const crypto = {
    encrypt: jest.fn(() => ({
      bodyCiphertext: 'ciphertext',
      iv: 'iv',
      authTag: 'tag',
      keyVersion: 'v1',
    })),
  };
  const runtime = { assertBackgroundOwner: jest.fn(), assertExternalAction: jest.fn() };
  const service = new KrispNotetakerService(
    prisma as never,
    managed as never,
    persistence as never,
    crypto as never,
    runtime as never,
  );
  const run = () => (service as any).process(ctx, preference, 'import');
  return {
    service,
    run,
    tx,
    tenant,
    prisma,
    managed,
    persistence,
    crypto,
    runtime,
    notes,
    debriefs,
    item: () => item,
  };
}

describe('automatic Krisp notes and debriefs', () => {
  test('a completed import saves encrypted approved artifacts together and never repeats', async () => {
    const f = fixture();
    await f.run();
    await f.run();
    expect(f.persistence.generateMeetingDebriefDraft).toHaveBeenCalledTimes(1);
    expect(f.persistence.generateMeetingDebriefDraft).toHaveBeenCalledWith(ctx, 'meeting', {
      method: 'upload',
      sourceText: 'Alice: Follow up tomorrow.',
    });
    expect(f.notes).toHaveLength(1);
    expect(f.debriefs).toHaveLength(1);
    expect(f.notes[0]).toMatchObject({
      status: 'approved',
      bodyCiphertext: 'ciphertext',
      accessLevel: 'tenant_admins_and_author',
    });
    expect(f.notes[0]).not.toHaveProperty('sharedAt');
    expect(f.item()).toMatchObject({
      status: 'done',
      noteId: 'note',
      debriefId: 'debrief',
      leaseToken: null,
    });
    expect(JSON.stringify(f.item())).not.toContain('Follow up tomorrow');
  });
  test('a failed debrief save rolls back the note; a retry produces exactly one pair', async () => {
    const f = fixture();
    f.tx.meetingDebrief.create.mockRejectedValueOnce(new Error('write failed'));
    await f.run();
    expect(f.notes).toHaveLength(0);
    expect(f.item().status).toBe('failed');
    await f.run();
    expect(f.notes).toHaveLength(1);
    expect(f.debriefs).toHaveLength(1);
    expect(f.item().status).toBe('done');
  });
  test('not-ready transcripts retry without using the error budget or calling the model', async () => {
    const f = fixture();
    f.managed.executeRead.mockResolvedValue({
      structuredResult: { structuredContent: { documents: [{ id: doc, transcript: '' }] } },
    });
    await f.run();
    expect(f.item()).toMatchObject({ status: 'pending', attempts: 0 });
    expect(f.persistence.generateMeetingDebriefDraft).not.toHaveBeenCalled();
  });
  test.each(['tenant', 'preference', 'membership', 'connection'])(
    'revoking %s during generation prevents any artifact save',
    async (boundary) => {
      const f = fixture();
      f.persistence.generateMeetingDebriefDraft.mockImplementation(async () => {
        if (boundary === 'tenant')
          f.tenant.settings.clioFeatureFlags['notetaker.krisp.enabled'] = false;
        if (boundary === 'preference')
          f.tx.krispNotetakerPreference.findFirst.mockResolvedValue(null);
        if (boundary === 'membership') f.tx.tenantMembership.findFirst.mockResolvedValue(null);
        if (boundary === 'connection') f.tx.clioMcpServer.findFirst.mockResolvedValue(null);
        return { recap: 'recap', actionItems: [], notes: 'notes' };
      });
      await f.run();
      expect(f.notes).toHaveLength(0);
      expect(f.debriefs).toHaveLength(0);
    },
  );
  test('another worker holding the lease cannot be displaced', async () => {
    const f = fixture();
    Object.assign(f.item(), {
      status: 'processing',
      leaseToken: 'other',
      leaseUntil: new Date(Date.now() + 60_000),
    });
    await f.run();
    expect(f.managed.executeRead).not.toHaveBeenCalled();
  });
  test('meeting ownership is checked before reading private transcripts', async () => {
    const f = fixture();
    f.tx.meeting.findFirst.mockResolvedValue(null);
    await f.run();
    expect(f.managed.executeRead).not.toHaveBeenCalled();
    expect(f.notes).toHaveLength(0);
  });
  test('out-of-cohort tenant gets no status or provider access even with the flag set', async () => {
    const f = fixture();
    f.tenant.slug = 'another-firm';
    await expect(f.service.status(ctx)).rejects.toThrow('not enabled');
    await f.run();
    expect(f.managed.executeRead).not.toHaveBeenCalled();
  });
});
