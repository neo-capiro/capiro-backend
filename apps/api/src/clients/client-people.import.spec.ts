import { ClientPeopleService } from './client-people.service.js';
import type { TenantContext } from '@capiro/shared';

/**
 * upsertPersonForImport — the merge that makes re-running enrichment safe.
 *
 * The tool contract for update_client_profile was "each person in people[] is
 * APPENDED (new rows), never used to delete existing ones", and client_people
 * has no unique constraint on email. So every re-run duplicated every contact:
 * enrich a client twice and the same person is on the People tab twice.
 *
 * The rule this pins: an automated import FILLS BLANKS and never overwrites a
 * value a human curated — except lastContact, which advances, because a newer
 * verified contact date is strictly better information.
 */

const CTX = {
  tenantId: 'a8dce0a5-af14-46fd-bb7e-f7f754556d3e',
  userId: 'cc01a549-5381-4ebd-b714-ec8c597392f6',
} as unknown as TenantContext;

const CLIENT = 'b7c9e1a2-0000-4000-8000-00000000abcd';

function makeService(existing: Record<string, unknown> | null) {
  const findFirstPerson = jest.fn().mockResolvedValue(existing);
  const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'p-new',
    ...data,
  }));
  const update = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    ...(existing ?? {}),
    ...data,
  }));
  const service = Object.create(ClientPeopleService.prototype) as ClientPeopleService;
  (service as unknown as { prisma: unknown }).prisma = {
    withTenant: (_t: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        client: { findFirst: jest.fn().mockResolvedValue({ id: CLIENT }) },
        clientPerson: { findFirst: findFirstPerson, create, update },
      }),
  };
  (service as unknown as { clientKb: unknown }).clientKb = {
    indexPersonFireAndForget: jest.fn(),
  };
  return { service, findFirstPerson, create, update };
}

describe('upsertPersonForImport', () => {
  it('creates when the person is new', async () => {
    const { service, create } = makeService(null);
    const res = await service.upsertPersonForImport(CTX, CLIENT, {
      name: 'Jason Hay',
      email: 'jason@brycetech.com',
    });
    expect(res.created).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('matches on email and does NOT create a second row (the duplicate bug)', async () => {
    const { service, create, update, findFirstPerson } = makeService({
      id: 'p-1',
      name: 'Jason Hay',
      email: 'jason@brycetech.com',
      title: null,
      phone: null,
      role: null,
      notes: null,
      lastContact: null,
    });
    const res = await service.upsertPersonForImport(CTX, CLIENT, {
      name: 'Jason Hay',
      email: 'jason@brycetech.com',
      title: 'VP, Space Programs',
    });
    expect(res.created).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledTimes(1);
    expect(findFirstPerson.mock.calls[0]?.[0]?.where).toMatchObject({
      clientId: CLIENT,
      email: 'jason@brycetech.com',
    });
  });

  it('fills blanks but never overwrites curated values', async () => {
    const { service, update } = makeService({
      id: 'p-1',
      name: 'Jason Hay',
      email: 'jason@brycetech.com',
      title: 'Chief Scientist', // curated by a human
      phone: null,
      role: null,
      notes: null,
      lastContact: null,
    });
    await service.upsertPersonForImport(CTX, CLIENT, {
      name: 'Jason Hay',
      email: 'jason@brycetech.com',
      title: 'VP, Space Programs', // scraped — must lose
      phone: '202-555-0100', // blank today — must fill
    });
    const data = update.mock.calls[0]?.[0]?.data as Record<string, unknown>;
    expect(data.title).toBeUndefined();
    expect(data.phone).toBe('202-555-0100');
  });

  it('advances lastContact but never moves it backwards', async () => {
    const { service, update } = makeService({
      id: 'p-1',
      name: 'Jason Hay',
      email: 'jason@brycetech.com',
      title: null,
      phone: null,
      role: null,
      notes: null,
      lastContact: new Date('2026-07-20T00:00:00Z'),
    });
    await service.upsertPersonForImport(CTX, CLIENT, {
      name: 'Jason Hay',
      email: 'jason@brycetech.com',
      lastContact: '2026-07-28T00:00:00Z',
    });
    expect((update.mock.calls[0]?.[0]?.data as Record<string, unknown>).lastContact).toEqual(
      new Date('2026-07-28T00:00:00Z'),
    );

    const stale = makeService({
      id: 'p-1',
      name: 'Jason Hay',
      email: 'jason@brycetech.com',
      title: null,
      phone: null,
      role: null,
      notes: null,
      lastContact: new Date('2026-07-28T00:00:00Z'),
    });
    await stale.service.upsertPersonForImport(CTX, CLIENT, {
      name: 'Jason Hay',
      email: 'jason@brycetech.com',
      lastContact: '2026-07-20T00:00:00Z',
    });
    expect(
      (stale.update.mock.calls[0]?.[0]?.data as Record<string, unknown>).lastContact,
    ).toBeUndefined();
  });

  it('falls back to an exact name match when no email is known', async () => {
    // Meri routinely harvests a first name off a meeting invite with no address.
    const { service, findFirstPerson } = makeService(null);
    await service.upsertPersonForImport(CTX, CLIENT, { name: 'Derek' });
    expect(findFirstPerson.mock.calls[0]?.[0]?.where).toMatchObject({
      clientId: CLIENT,
      name: { equals: 'Derek', mode: 'insensitive' },
    });
  });
});
