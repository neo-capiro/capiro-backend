import { MemoryFkLoader } from './memory-fk-loader.service.js';

/**
 * Phase 5 — office edges in the FK graph loader.
 *
 * office:<officeKey> nodes come from the tenant-scoped, client-linked outreach
 * report targets (engagement_report_target_offices), NOT the global DoD
 * program_office reference data (which has no tenant scope and would flood every
 * tenant's graph). These guards lock both behaviours in.
 */
describe('MemoryFkLoader — office edges (Phase 5)', () => {
  function loaderWith(queryImpl: (sql: string) => unknown[]) {
    const captured: string[] = [];
    const tx = {
      $queryRaw: (strings: TemplateStringsArray, ..._v: unknown[]) => {
        const sql = strings.join(' ? ');
        captured.push(sql);
        return Promise.resolve(queryImpl(sql));
      },
    };
    const prisma = {
      withTenant: (_id: string, fn: (t: typeof tx) => unknown) => fn(tx),
    } as unknown as ConstructorParameters<typeof MemoryFkLoader>[0];
    const tenantCtx = {
      require: () => ({ tenantId: 't1', userId: 'u1' }),
    } as unknown as ConstructorParameters<typeof MemoryFkLoader>[1];
    return { loader: new MemoryFkLoader(prisma, tenantCtx), captured };
  }

  it('emits a tenant-scoped client->office edge from engagement_report_target_offices', async () => {
    const { loader } = loaderWith((sql) =>
      sql.includes('engagement_report_target_offices')
        ? [
            {
              client_id: 'c1',
              client_name: 'Aperture',
              office_key: 'sen-smith',
              member_principal: 'Sen. Smith',
              committee: 'SASC',
              building: 'Hart',
            },
          ]
        : [],
    );
    const rels = await loader.loadForCurrentTenant();
    const office = rels.find((r) => r.dstType === 'office');
    expect(office).toBeDefined();
    expect(office!.srcType).toBe('client');
    expect(office!.srcSlug).toBe('c1');
    expect(office!.dstSlug).toBe('sen-smith');
    expect(office!.dstLabel).toBe('Sen. Smith');
    expect(office!.relation).toBe('targets');
    expect(office!.dstAttrs).toMatchObject({ committee: 'SASC', building: 'Hart' });
  });

  it('sources offices only from tenant-scoped data, never the global program_office reference', async () => {
    const { loader, captured } = loaderWith(() => []);
    await loader.loadForCurrentTenant();
    const all = captured.join('\n');
    expect(all).toContain('engagement_report_target_offices');
    expect(all).not.toContain('program_office');
  });
});
