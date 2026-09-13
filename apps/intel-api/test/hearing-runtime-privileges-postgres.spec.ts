import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service.js';

if (
  process.env.LEGIWATCH_RECORDING_TEST_DATABASE !== 'disposable' ||
  !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname)
)
  throw Error('Local disposable PostgreSQL required');

describe('hearing runtime role under inherited owner grants', () => {
  const p = new PrismaService({ transactionOptions: { maxWait: 10000, timeout: 10000 } });
  const tenant = randomUUID(),
    permission = randomUUID();
  beforeAll(async () => {
    await p.$executeRaw`INSERT INTO intel_hearing_media_permission(id,tenant_id,source_url,mode,operations,evidence,reviewed_by,expires_at,retention_days)
      VALUES(${permission},${tenant},'https://owned.example/role-fixture','browser',ARRAY['capture','transcription','retention'],'Owned synthetic permission fixture','fixture-operator',now()+interval '1 day',1)`;
  });
  afterAll(() => p.$disconnect());
  const asApp = <T>(run: (tx: any) => Promise<T>) =>
    p.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
      await tx.$executeRaw`SELECT set_config('app.current_tenant',${tenant},true),set_config('app.bypass_rls','off',true)`;
      return run(tx);
    });
  it('keeps permission row locks usable under the real application role', async () => {
    const rows = await asApp(
      (tx) =>
        tx.$queryRaw`SELECT id FROM intel_hearing_media_permission WHERE id=${permission} FOR SHARE`,
    );
    expect(rows).toEqual([{ id: permission }]);
  });
  it('prevents application-created or expanded source permission', async () => {
    await expect(
      asApp(
        (
          tx,
        ) => tx.$executeRaw`INSERT INTO intel_hearing_media_permission(id,tenant_id,source_url,mode,operations,evidence,reviewed_by,expires_at,retention_days)
      VALUES(${randomUUID()},${tenant},'https://owned.example/forged','server',ARRAY['capture'],'unreviewed','application',now()+interval '1 day',1)`,
      ),
    ).rejects.toMatchObject({ meta: { code: '42501' } });
    await expect(
      asApp(
        (tx) =>
          tx.$executeRaw`UPDATE intel_hearing_media_permission SET operations=ARRAY['capture','distribution'] WHERE id=${permission}`,
      ),
    ).rejects.toMatchObject({ meta: { code: '42501' } });
    await expect(
      asApp(
        (tx) =>
          tx.$executeRaw`UPDATE intel_hearing_media_permission SET id=${randomUUID()} WHERE id=${permission}`,
      ),
    ).rejects.toThrow('identity is immutable');
  });
  it('does not inherit deletion or truncation of immutable version and consent history', async () => {
    const rows = await p.$queryRaw<
      Array<{ table_name: string; can_delete: boolean; can_truncate: boolean }>
    >`
      SELECT n AS table_name,has_table_privilege('capiro_app',n,'DELETE') AS can_delete,
        has_table_privilege('capiro_app',n,'TRUNCATE') AS can_truncate
      FROM unnest(ARRAY['intel_hearing_media_permission','intel_hearing_publication','intel_hearing_sms_consent']) n`;
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => !row.can_delete && !row.can_truncate)).toBe(true);
    await expect(
      asApp((tx) => tx.$executeRaw`DELETE FROM intel_hearing_publication WHERE id=${randomUUID()}`),
    ).rejects.toMatchObject({ meta: { code: '42501' } });
  });
  it('retains current tenant isolation while the operator can withdraw a grant', async () => {
    const rows = await asApp(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant',${randomUUID()},true)`;
      return tx.$queryRaw`SELECT id FROM intel_hearing_media_permission WHERE id=${permission}`;
    });
    expect(rows).toEqual([]);
    await p.$executeRaw`UPDATE intel_hearing_media_permission SET revoked_at=now() WHERE id=${permission}`;
    const revoked = await asApp(
      (tx) =>
        tx.$queryRaw`SELECT (revoked_at IS NOT NULL) AS revoked FROM intel_hearing_media_permission WHERE id=${permission} FOR SHARE`,
    );
    expect(revoked).toEqual([{ revoked: true }]);
  });
});
