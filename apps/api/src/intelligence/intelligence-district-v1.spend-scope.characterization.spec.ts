import {
  clientId,
  contractorId,
  deferred,
  harness,
  installHooks,
  linkedSpend,
  mapping,
  ownUei,
  tenantId,
} from '../../test/fixtures/intelligence-district.js';

installHooks();

describe('District spend tenant identity inputs', () => {
  test('loads reviewed mapping and own UEI concurrently in the same tenant transaction', async () => {
    const mappings = deferred<unknown[]>();
    const client = deferred<unknown>();
    const contractors = deferred<unknown[]>();
    const h = harness({
      rows: {
        mappings: mappings.promise,
        client: client.promise,
        contractors: contractors.promise,
      },
    });
    const pending = h.service.getDistrictNexusSpend(clientId, tenantId);
    await h.started('client');
    expect(h.callsOf('mappings')[0]).toMatchObject({
      scope: 'tenant',
      tenantId,
      transaction: 1,
      args: [
        {
          where: {
            clientId,
            source: 'contracting',
            confirmed: true,
            reviewStatus: 'confirmed',
            rollUpAwards: true,
          },
          select: { externalId: true, externalName: true, matchBasis: true, matchTier: true },
        },
      ],
    });
    expect(h.callsOf('client')[0]).toMatchObject({
      scope: 'tenant',
      tenantId,
      transaction: 1,
      args: [{ where: { id: clientId }, select: { uei: true } }],
    });
    expect(h.callsOf('contractors')).toEqual([]);
    mappings.resolve([mapping()]);
    expect(h.transactions[0]!.outcome).toBe('');
    client.resolve({ uei: ownUei });
    await h.started('contractors');
    expect(h.events).toEqual([
      'withTenant',
      'tenant:begin',
      'mappings',
      'client',
      'tenant:commit',
      'contractors',
    ]);
    contractors.resolve([{ id: contractorId, uei: ownUei }]);
    expect((await pending).linked).toBe(true);
  });
});

describe('District spend tenant identity inputs', () => {
  test('filters malformed contractor IDs and deduplicates UUIDs in first-seen order', async () => {
    const second = '00000000-0000-0000-0000-000000000021';
    const h = harness({
      rows: {
        mappings: [
          mapping(),
          mapping({ externalId: 'bad' }),
          mapping(),
          mapping({ externalId: second }),
          mapping({ externalId: null }),
        ],
      },
    });
    await linkedSpend(h);
    expect(h.callsOf('contractors')[0]).toEqual({
      operation: 'contractors',
      scope: 'global',
      args: [{ where: { id: { in: [contractorId, second] } }, select: { id: true, uei: true } }],
    });
    expect(h.events.indexOf('tenant:commit')).toBeLessThan(h.events.indexOf('contractors'));
  });
  test('keeps case-sensitive first-seen contractor names independently of accepted identity basis', async () => {
    const h = harness({
      rows: {
        client: { uei: ownUei },
        mappings: [
          mapping({ externalId: null, externalName: ' Acme ' }),
          mapping({ externalId: null, externalName: 'Acme' }),
          mapping({ externalId: null, externalName: 'acme', matchBasis: 'fuzzy_name' }),
          mapping({ externalId: null, externalName: ' ' }),
        ],
      },
    });
    expect((await linkedSpend(h)).contractorNames).toEqual(['Acme', 'acme']);
    expect(h.callsOf('contractors')).toEqual([]);
  });
});

describe('District spend linkage envelope', () => {
  test('returns the full unlinked refusal when neither mappings nor own UEI identify awards', async () => {
    const h = harness();
    expect(await h.service.getDistrictNexusSpend(clientId, tenantId)).toEqual({
      linked: false,
      reason: 'no_confirmed_contracting_mapping',
      contractorNames: [],
      totalAwards: 0,
      totalAmount: 0,
      districts: [],
      unmappedAmount: 0,
      disclaimer:
        'Spend is matched to this client via confirmed USAspending contractor mappings. Confirm a contracting source mapping in Manage Sources to populate district spend.',
    });
    expect(h.calls.map((call) => call.operation)).toEqual(['withTenant', 'mappings', 'client']);
  });
  test('links an own UEI without mappings and returns a linked empty-award envelope', async () => {
    const h = harness({ rows: { client: { uei: ownUei } } });
    expect(await linkedSpend(h)).toEqual({
      linked: true,
      contractorNames: [],
      totalAwards: 0,
      totalAmount: 0,
      districtCount: 0,
      unmappedAmount: 0,
      districts: [],
      disclaimer:
        'Imported federal contract spend (USAspending; current ingestion covers Department of Defense contracts) matched by UEI or reviewed exact names on awards missing UEIs, grouped by place-of-performance congressional district. Awards without a resolved district are shown as unmapped. Public data; for intelligence, not legal or compliance advice.',
    });
    expect(h.callsOf('spend')[0]!.query!.values).toEqual([[ownUei]]);
    expect(h.callsOf('census')).toEqual([]);
    expect(h.callsOf('members')).toEqual([]);
  });
  test('allows a missing tenant client to retain reviewed mapping-only linkage', async () => {
    const h = harness({ rows: { client: null, mappings: [mapping({ externalId: null })] } });
    expect((await linkedSpend(h)).contractorNames).toEqual(['Acme Research']);
    expect(h.callsOf('spend')[0]!.query!.values).toEqual([['acme research']]);
  });
});

describe('District spend canonical award predicate', () => {
  test('normalizes own and resolved UEIs, preserves UEI order, and keeps reviewed names missing-UEI-only', async () => {
    const h = harness({
      rows: {
        client: { uei: ` ${ownUei.toLowerCase()} ` },
        mappings: [
          mapping({ externalName: ' Acme Research ' }),
          mapping({ externalId: null, externalName: 'Subsidiary', matchBasis: 'manual_pin' }),
        ],
        contractors: [{ id: contractorId, uei: ' zyxwvu654321 ' }],
      },
    });
    await linkedSpend(h);
    const query = h.callsOf('spend')[0]!.query!;
    expect(query.kind).toBe('prisma');
    expect(query.values).toEqual([
      [ownUei, 'ZYXWVU654321'],
      ['acme research', 'subsidiary'],
    ]);
    expect(query.sql.replace(/\s+/g, ' ').trim()).toBe(
      "SELECT pop_state, pop_congressional_district AS pop_district, COUNT(*)::bigint AS award_count, COALESCE(SUM(amount), 0)::float8 AS total_amount FROM federal_award WHERE (recipient_uei = ANY(?::text[]) OR (NULLIF(BTRIM(recipient_uei), '') IS NULL AND lower(contractor_name) = ANY(?::text[]))) GROUP BY pop_state, pop_congressional_district",
    );
  });
  test('deduplicates identical own and resolved UEIs without interpreting a mapping UUID as a UEI', async () => {
    const h = harness({
      rows: {
        client: { uei: ownUei },
        mappings: [mapping({ matchBasis: null })],
        contractors: [{ id: contractorId, uei: ownUei }],
      },
    });
    await linkedSpend(h);
    expect(h.callsOf('spend')[0]!.query!.values).toEqual([[ownUei]]);
    expect(h.callsOf('spend')[0]!.query!.sql).not.toContain('contractor_name');
  });
  test('never treats a UEI-looking external ID as a resolved contractor UEI', async () => {
    const h = harness({
      rows: { mappings: [mapping({ externalId: ownUei, matchBasis: 'fuzzy_name' })] },
    });
    expect((await h.service.getDistrictNexusSpend(clientId, tenantId)).linked).toBe(false);
    expect(h.callsOf('contractors')).toEqual([]);
    expect(h.callsOf('spend')).toEqual([]);
  });
});

describe('District spend verified and invalid UEIs', () => {
  test('retains a resolved contractor UEI despite a fuzzy name basis and excludes that name fallback', async () => {
    const h = harness({
      rows: {
        mappings: [mapping({ matchBasis: 'fuzzy_name', matchTier: 4 })],
        contractors: [{ id: contractorId, uei: ownUei }],
      },
    });
    expect((await linkedSpend(h)).contractorNames).toEqual(['Acme Research']);
    expect(h.callsOf('spend')[0]!.query!.values).toEqual([[ownUei]]);
    expect(h.callsOf('spend')[0]!.query!.sql).not.toContain('contractor_name');
  });
  test.each(['bad', 'ABC-DEF12345', ''])(
    'refuses invalid own UEI %p without catalog scope',
    async (uei) => {
      const h = harness({ rows: { client: { uei } } });
      expect((await h.service.getDistrictNexusSpend(clientId, tenantId)).linked).toBe(false);
      expect(h.callsOf('spend')).toEqual([]);
    },
  );
});

describe('District spend reviewed-name eligibility', () => {
  test.each([
    'exact_uei',
    'exact_cage',
    'exact_legal_name',
    'exact_legal_name_corroborated',
    'manual_pin',
  ])('permits the recorded %s basis on awards missing UEIs', async (matchBasis) => {
    const h = harness({ rows: { mappings: [mapping({ externalId: null, matchBasis })] } });
    await linkedSpend(h);
    const query = h.callsOf('spend')[0]!.query!;
    expect(query.values).toEqual([['acme research']]);
    expect(query.sql).toContain(
      "NULLIF(BTRIM(recipient_uei), '') IS NULL AND lower(contractor_name)",
    );
  });
  test.each([
    { name: 'unrecorded basis', matchBasis: null, matchTier: 1 },
    { name: 'empty basis', matchBasis: '', matchTier: 1 },
    { name: 'legacy basis', matchBasis: 'legacy_unrecorded', matchTier: 1 },
    { name: 'fuzzy basis', matchBasis: 'fuzzy_name', matchTier: 1 },
    { name: 'fuzzy tier on an exact basis', matchBasis: 'exact_legal_name', matchTier: 4 },
    { name: 'unrecognized name basis', matchBasis: 'custom_basis', matchTier: 1 },
  ])('refuses $name without verified UEI', async ({ matchBasis, matchTier }) => {
    const h = harness({
      rows: { mappings: [mapping({ externalId: null, matchBasis, matchTier })] },
    });
    const value = await h.service.getDistrictNexusSpend(clientId, tenantId);
    expect(value).toMatchObject({ linked: false, contractorNames: [], totalAmount: 0 });
    expect(h.callsOf('spend')).toEqual([]);
  });
});

describe('District spend failed identity inputs', () => {
  test.each(['mappings', 'client', 'contractors', 'spend'])(
    'propagates %s failures and stops later reads',
    async (operation) => {
      const error = new Error(`${operation} failed`);
      const h = harness({
        rows: { client: { uei: ownUei }, mappings: [mapping()] },
        errors: { [operation]: error },
      });
      await expect(h.service.getDistrictNexusSpend(clientId, tenantId)).rejects.toBe(error);
      expect(h.callsOf('census')).toEqual([]);
      expect(h.callsOf('members')).toEqual([]);
      expect(h.transactions[0]!.outcome).toBe(
        ['mappings', 'client'].includes(operation) ? 'rollback' : 'commit',
      );
    },
  );
  test('keeps malformed mapping names fatal before contractor lookup', async () => {
    const h = harness({
      rows: { client: { uei: ownUei }, mappings: [mapping({ externalName: null })] },
    });
    await expect(h.service.getDistrictNexusSpend(clientId, tenantId)).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(h.callsOf('contractors')).toEqual([]);
    expect(h.callsOf('spend')).toEqual([]);
  });
});
