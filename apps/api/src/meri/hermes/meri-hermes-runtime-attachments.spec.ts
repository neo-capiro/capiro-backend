import { MeriHermesRuntimeAdapter } from './meri-hermes-runtime.adapter.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const ctx = { tenantId: TENANT, userId: USER } as never;

function adapterWith(rows: any[] = []) {
  const messages = rows.length ? [
    { id: 'turn-2', createdAt: new Date('2026-02-01') },
    { id: 'turn-1', createdAt: new Date('2026-01-01') },
  ] : [];
  const tx = {
    clioMessage: { findMany: jest.fn(async () => messages) },
    clioAttachment: { findMany: jest.fn(async () => rows) },
  };
  const prisma = { withTenant: jest.fn(async (_tenant: string, callback: (value: unknown) => unknown) => callback(tx)) };
  const adapter = new MeriHermesRuntimeAdapter(prisma as never, {} as never, {} as never,
    {} as never, {} as never, {} as never);
  return { adapter, prisma };
}

const enforcedEnv = {
  MERI_EVIDENCE_ACCURACY_MODE: 'enforce',
  MERI_EVIDENCE_ACCURACY_TENANTS: TENANT,
  MERI_EVIDENCE_ACCURACY_SURFACES: 'chat',
} as NodeJS.ProcessEnv;

describe('Hermes prior-turn attachment input', () => {
  test('off mode is byte-identical and performs no manifest query', async () => {
    const { adapter, prisma } = adapterWith();
    adapter.env = {};
    const actual = await (adapter as any).composeInput(ctx, 'conversation', 'current', 'hello', [{
      id: 'current', filename: 'now.pdf', kind: 'pdf', status: 'parsed',
    }], ['Earlier answer']);
    expect(actual).toBe('Earlier answer\n\nhello\n\n[Meri attachments for this turn — read them with the meri_fetch_attachment tool, which writes the file into your workspace and returns its path:]\n- attachment_id=current filename="now.pdf" kind=pdf status=parsed');
    expect(prisma.withTenant).not.toHaveBeenCalled();
  });

  test('enforce lists prior metadata newest-first without replaying text and annotates duplicate names', async () => {
    const rows = [
      { id: 'new', filename: 'Budget.pdf', status: 'failed', textContent: null, reason: 'encrypted', kind: 'pdf', pages: 1, createdAt: new Date('2026-02-01'), messageId: 'turn-2' },
      { id: 'old', filename: 'Budget.pdf', status: 'parsed', textContent: 'SECRET FULL TEXT', reason: null, kind: 'pdf', pages: 1, createdAt: new Date('2026-01-01'), messageId: 'turn-1' },
    ];
    const { adapter } = adapterWith(rows);
    adapter.env = enforcedEnv;
    const actual = await (adapter as any).composeInput(ctx, 'conversation', 'current', 'compare them', [], []);
    expect(actual).toContain('Previous attachments in this conversation:');
    expect(actual).toContain('attachment_id=new filename="Budget.pdf" turn=2 state=failed chars=0 (duplicate name — distinguish by turn/date)');
    expect(actual).toContain('attachment_id=old filename="Budget.pdf" turn=1 state=ready chars=16 (duplicate name — distinguish by turn/date)');
    expect(actual.indexOf('attachment_id=new')).toBeLessThan(actual.indexOf('attachment_id=old'));
    expect(actual).not.toContain('SECRET FULL TEXT');
    expect(actual).toContain('do not ask the user to re-upload a listed document');
  });
});
