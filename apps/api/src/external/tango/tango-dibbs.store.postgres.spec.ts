import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { realUpsertSolicitation } from '../../../scripts/sync-tango-dibbs.js';
import { FundingCatalogStore } from './funding-catalog.store.js';
import { ACTIVE_SOURCE_LANES, reconcileUnconfirmedActive } from './funding-active-sources.js';
import { mapDibbsRfp } from './tango-dibbs.mapper.js';

const url = process.env.TANGO_DIBBS_TEST_DATABASE_URL;
if (url) {
  const target = new URL(url);
  if (target.protocol !== 'postgresql:' || target.hostname !== '127.0.0.1' || target.pathname !== '/dibbs_uuid_f1') {
    throw new Error('Use the isolated loopback dibbs_uuid_f1 test database.');
  }
}
const db = url ? new PrismaClient({ datasources: { db: { url } } }) : undefined;
const suite = db ? describe : describe.skip;
const uuid = () => 'ab' + randomUUID().slice(2);
const raw = (id: string, number: string | null) => mapDibbsRfp({ uuid: id, is_open: true, solicitation: number })!;

suite('DIBBS provider UUID identity on PostgreSQL', () => {
  afterAll(async () => { await db?.$disconnect(); });
  const active = (id: string, number: string | null) => new FundingCatalogStore(db!).dibbsSolicitation(raw(id, number), true);
  const legacy = (id: string, number: string | null) => realUpsertSolicitation(db!)(raw(id, number));
  const rows = (id: string) => db!.tangoDibbsSolicitation.findMany({
    where: { tangoDibbsId: { equals: id, mode: 'insensitive' } },
    select: { id: true, tangoDibbsId: true, solicitation: true }, orderBy: { id: 'asc' },
  });

  test('a DIBBS detail confirms the differently cased provider UUID and updates the same public record', async () => {
    const providerId = uuid().toUpperCase();
    const store = new FundingCatalogStore(db!);
    await active(providerId, null);
    const [original] = await rows(providerId);
    const endpoint = ACTIVE_SOURCE_LANES.dibbs.endpoints.find(item => item.endpoint === 'rfp')!;
    const detail = jest.fn(async () => ({ uuid: providerId, is_open: false, solicitation: 'RFP-CLOSED' }));
    const markUnconfirmed = jest.fn();
    const result = await reconcileUnconfirmedActive(endpoint, new Date().toISOString(), {
      unseen: async () => [{ localId: original!.id, providerId: original!.tangoDibbsId }],
      detail, markUnconfirmed,
    }, { persist: async mapped => {
      if (!('tangoDibbsId' in mapped)) throw new Error('Expected a DIBBS row');
      await store.dibbsSolicitation(mapped, true);
    } });
    expect(detail).toHaveBeenCalledWith(original!.tangoDibbsId);
    expect(result).toEqual({ checked: 1, confirmed: 1, unconfirmed: 0, complete: true });
    expect(markUnconfirmed).not.toHaveBeenCalled();
    expect(await rows(providerId)).toEqual([{ ...original, solicitation: 'RFP-CLOSED' }]);
    expect((await db!.tangoDibbsSolicitation.findUniqueOrThrow({ where: { id: original!.id } })).isOpen).toBe(false);
  });

  test.each([['active', active], ['legacy', legacy]] as const)('%s preserves one row across the reviewer’s mixed-case sequence', async (_name, write) => {
    const id = uuid();
    await write(id, null);
    const [first] = await rows(id);
    await write(id.toUpperCase(), 'RFP-789');
    await write(id, null);
    expect(await rows(id)).toEqual([{ ...first, solicitation: 'RFP-789' }]);
  });

  test('keeps both the row ID and a pre-existing uppercase public key', async () => {
    const id = uuid();
    const first = await db!.tangoDibbsSolicitation.create({ data: raw(id.toUpperCase(), 'LEGACY') });
    await active(id, null);
    expect((await rows(id))[0]?.solicitation).toBe('LEGACY');
    await legacy(id, 'ASSIGNED');
    expect(await rows(id)).toEqual([{ id: first.id, tangoDibbsId: id.toUpperCase(), solicitation: 'ASSIGNED' }]);
  });

  test('both writers refuse an existing ambiguous UUID without altering either row', async () => {
    const id = uuid();
    await db!.tangoDibbsSolicitation.createMany({ data: [raw(id, 'FIRST'), raw(id.toUpperCase(), 'SECOND')] });
    const before = await rows(id);
    await expect(active(id.toUpperCase(), 'THIRD')).rejects.toThrow(/Ambiguous stored Tango DIBBS UUID/);
    await expect(legacy(id, null)).rejects.toThrow(/Ambiguous stored Tango DIBBS UUID/);
    expect(await rows(id)).toEqual(before);
  });

  test('concurrent first sightings from both writers converge and stale writes preserve the assignment', async () => {
    const id = uuid();
    await Promise.all([active(id, null), legacy(id.toUpperCase(), 'CONCURRENT'), active(id.toUpperCase(), null), legacy(id, null)]);
    expect(await rows(id)).toEqual([{ id: expect.any(String), tangoDibbsId: id, solicitation: 'CONCURRENT' }]);
  });

  test('opaque case-distinct numbered keys retain separate identities', async () => {
    const id = 'opaque-' + uuid();
    await active(id, 'LOWER');
    await legacy(id.toUpperCase(), 'UPPER');
    expect((await rows(id)).map(r => [r.tangoDibbsId, r.solicitation])).toEqual(expect.arrayContaining([
      [id, 'LOWER'], [id.toUpperCase(), 'UPPER'],
    ]));
    expect(await rows(id)).toHaveLength(2);
  });
});
