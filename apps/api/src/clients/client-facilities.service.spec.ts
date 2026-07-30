import 'reflect-metadata';
import { describe, expect, jest, test } from '@jest/globals';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ClientFacilitiesService } from './client-facilities.service.js';
import { CreateFacilityDto, UpdateFacilityDto } from './client-facilities.controller.js';

const kbStub = { indexFacilityFireAndForget: () => {}, purgeFireAndForget: () => {} };

const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const TENANT_B = '00000000-0000-0000-0000-00000000000b';

const ctx = (tenantId: string) => ({ tenantId, userId: 'user-1' }) as never;

interface Row {
  [k: string]: unknown;
}

/**
 * In-memory Prisma double that models RLS the way Postgres does: every
 * `clientFacility`/`client` read is scoped to the tenant GUC set by
 * `withTenant`. Rows belonging to another tenant are invisible inside the
 * transaction even if the query `where` forgot to filter on tenantId — which
 * is exactly the isolation guarantee the tenant-A-cannot-see-tenant-B test
 * relies on. Mirrors the makePrisma pattern in acquisition-personnel-read.spec.
 */
function makePrisma(seed: { clients?: Row[]; facilities?: Row[] }) {
  const store = {
    clients: [...(seed.clients ?? [])],
    facilities: [...(seed.facilities ?? [])],
  };
  let facilitySeq = 0;

  // The "GUC" — set by withTenant for the duration of fn().
  let currentTenant: string | null = null;

  const scopedClients = () => store.clients.filter((c) => c.tenantId === currentTenant);
  const scopedFacilities = () => store.facilities.filter((f) => f.tenantId === currentTenant);

  const matchWhere = (row: Row, where: Row | undefined): boolean => {
    if (!where) return true;
    for (const [key, cond] of Object.entries(where)) {
      if (cond && typeof cond === 'object' && 'not' in (cond as Row)) {
        if (row[key] === (cond as Row).not) return false;
        continue;
      }
      if (row[key] !== cond) return false;
    }
    return true;
  };

  const tx = {
    client: {
      findFirst: async ({ where }: { where: Row }) =>
        scopedClients().find((c) => matchWhere(c, where)) ?? null,
    },
    clientFacility: {
      findMany: async ({ where }: { where: Row }) =>
        scopedFacilities().filter((f) => matchWhere(f, where)),
      findFirst: async ({ where }: { where: Row }) =>
        scopedFacilities().find((f) => matchWhere(f, where)) ?? null,
      // District Impact Engine (Phase 1 M1.2) — the create/update paths fire a
      // best-effort, non-blocking geocode that reads the row back by id. The
      // fake resolves `null` here (never `undefined`/throw) so that
      // fire-and-forget path short-circuits cleanly instead of making a real
      // network call to the Census Geocoder from a unit test, or logging a
      // harmless-but-noisy "findUnique is not a function" warning.
      findUnique: async (_args: { where: { id: string } }) => null,
      create: async ({ data }: { data: Row }) => {
        const row = { id: `facility-${++facilitySeq}`, createdAt: new Date(), ...data };
        store.facilities.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Row }) => {
        // Scope to the current tenant (as RLS does): a cross-tenant id is invisible here, so
        // the mock fails loudly if the service ever drops its tenant-scoped findFirst guard.
        const row = scopedFacilities().find((f) => f.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        // Scope to the current tenant (as RLS does): splice only a row visible under the
        // current tenant GUC, so a cross-tenant delete regression cannot silently succeed.
        const idx = store.facilities.findIndex(
          (f) => f.id === where.id && f.tenantId === currentTenant,
        );
        const [removed] = idx >= 0 ? store.facilities.splice(idx, 1) : [undefined];
        return removed;
      },
    },
  };

  const prisma = {
    __store: store,
    withTenant: async <T>(tenantId: string, fn: (t: typeof tx) => Promise<T>): Promise<T> => {
      currentTenant = tenantId;
      try {
        return await fn(tx);
      } finally {
        currentTenant = null;
      }
    },
  };

  return prisma;
}

function seedClient(tenantId: string, id = 'client-1'): Row {
  return { id, tenantId, status: 'active' };
}

describe('ClientFacilitiesService — CRUD', () => {
  test('listFacilities returns the client facilities ordered by createdAt', async () => {
    const prisma = makePrisma({
      clients: [seedClient(TENANT_A)],
      facilities: [
        { id: 'f1', tenantId: TENANT_A, clientId: 'client-1', name: 'HQ' },
        { id: 'f2', tenantId: TENANT_A, clientId: 'client-1', name: 'Plant 2' },
      ],
    });
    const svc = new ClientFacilitiesService(prisma as never, kbStub as never);

    const result = await svc.listFacilities(ctx(TENANT_A), 'client-1');

    expect(result.map((f) => (f as Row).name)).toEqual(['HQ', 'Plant 2']);
  });

  test('listFacilities throws NotFound when the client is missing', async () => {
    const prisma = makePrisma({ clients: [], facilities: [] });
    const svc = new ClientFacilitiesService(prisma as never, kbStub as never);

    await expect(svc.listFacilities(ctx(TENANT_A), 'client-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  test('createFacility persists tenant + client scope and defaults districtSource to "user"', async () => {
    const prisma = makePrisma({ clients: [seedClient(TENANT_A)] });
    const svc = new ClientFacilitiesService(prisma as never, kbStub as never);

    const created = (await svc.createFacility(ctx(TENANT_A), 'client-1', {
      name: 'Huntsville',
      state: 'AL',
      congressionalDistrict: '5',
    })) as Row;

    expect(created.tenantId).toBe(TENANT_A);
    expect(created.clientId).toBe('client-1');
    expect(created.name).toBe('Huntsville');
    expect(created.state).toBe('AL');
    // CHANGED: '5' in, '05' stored. Facility style is 2-char zero-padded, and this
    // assertion used to pin the UNPADDED value — the defect that made a facility key
    // as AL-5 while every award for the same seat keyed as AL-05, so the facility
    // vanished from District Nexus entirely. See normalizeDistrictForStorage.
    expect(created.congressionalDistrict).toBe('05');
    // districtSource defaults to 'user' when omitted on create.
    expect(created.districtSource).toBe('user');
    expect(prisma.__store.facilities).toHaveLength(1);
  });

  test('createFacility honors an explicit districtSource of "geocoded"', async () => {
    const prisma = makePrisma({ clients: [seedClient(TENANT_A)] });
    const svc = new ClientFacilitiesService(prisma as never, kbStub as never);

    const created = (await svc.createFacility(ctx(TENANT_A), 'client-1', {
      name: 'Geo HQ',
      districtSource: 'geocoded',
    })) as Row;

    expect(created.districtSource).toBe('geocoded');
  });

  test('createFacility throws NotFound for an unknown client', async () => {
    const prisma = makePrisma({ clients: [] });
    const svc = new ClientFacilitiesService(prisma as never, kbStub as never);

    await expect(
      svc.createFacility(ctx(TENANT_A), 'client-1', { name: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  test('updateFacility applies only the provided fields', async () => {
    const prisma = makePrisma({
      clients: [seedClient(TENANT_A)],
      facilities: [
        {
          id: 'f1',
          tenantId: TENANT_A,
          clientId: 'client-1',
          name: 'HQ',
          state: 'TX',
          employeeCount: 10,
        },
      ],
    });
    const svc = new ClientFacilitiesService(prisma as never, kbStub as never);

    const updated = (await svc.updateFacility(ctx(TENANT_A), 'client-1', 'f1', {
      employeeCount: 42,
    })) as Row;

    expect(updated.employeeCount).toBe(42);
    expect(updated.name).toBe('HQ'); // untouched
    expect(updated.state).toBe('TX'); // untouched
  });

  test('updateFacility throws NotFound when the facility does not exist', async () => {
    const prisma = makePrisma({ clients: [seedClient(TENANT_A)], facilities: [] });
    const svc = new ClientFacilitiesService(prisma as never, kbStub as never);

    await expect(
      svc.updateFacility(ctx(TENANT_A), 'client-1', 'nope', { name: 'Y' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  test('deleteFacility removes the row and returns { deleted: true }', async () => {
    const prisma = makePrisma({
      clients: [seedClient(TENANT_A)],
      facilities: [{ id: 'f1', tenantId: TENANT_A, clientId: 'client-1', name: 'HQ' }],
    });
    const svc = new ClientFacilitiesService(prisma as never, kbStub as never);

    const result = await svc.deleteFacility(ctx(TENANT_A), 'client-1', 'f1');

    expect(result).toEqual({ deleted: true });
    expect(prisma.__store.facilities).toHaveLength(0);
  });
});

describe('ClientFacilitiesService — RLS isolation', () => {
  test('tenant A cannot read tenant B facilities (cross-tenant list is empty)', async () => {
    // Same clientId string used in both tenants; only the tenant GUC differs.
    const prisma = makePrisma({
      clients: [seedClient(TENANT_A), seedClient(TENANT_B)],
      facilities: [
        { id: 'fa', tenantId: TENANT_A, clientId: 'client-1', name: 'A-HQ' },
        { id: 'fb', tenantId: TENANT_B, clientId: 'client-1', name: 'B-HQ' },
      ],
    });
    const svc = new ClientFacilitiesService(prisma as never, kbStub as never);

    const tenantAView = (await svc.listFacilities(ctx(TENANT_A), 'client-1')) as Row[];
    expect(tenantAView.map((f) => f.name)).toEqual(['A-HQ']);
    // Tenant B's facility is never visible under tenant A's GUC.
    expect(tenantAView.find((f) => f.name === 'B-HQ')).toBeUndefined();
  });

  test('tenant A cannot update or delete a tenant B facility', async () => {
    const prisma = makePrisma({
      clients: [seedClient(TENANT_A), seedClient(TENANT_B)],
      facilities: [{ id: 'fb', tenantId: TENANT_B, clientId: 'client-1', name: 'B-HQ' }],
    });
    const svc = new ClientFacilitiesService(prisma as never, kbStub as never);

    // Tenant B's facility id is invisible under tenant A → the existence check
    // fails and the service refuses with NotFound (RLS, not a 200 silent no-op).
    await expect(
      svc.updateFacility(ctx(TENANT_A), 'client-1', 'fb', { name: 'hijack' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.deleteFacility(ctx(TENANT_A), 'client-1', 'fb')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // Tenant B's row survives untouched.
    expect((prisma.__store.facilities[0] as Row).name).toBe('B-HQ');
  });
});

describe('ClientFacilitiesService — single-field PATCH cross-validates against the stored row', () => {
  // The DTO-level cross-field check only sees fields present in the PATCH
  // body; these tests pin the service-level re-check of the merged
  // (stored + input) state/district pair.
  function svcWith(facility: Row) {
    const prisma = makePrisma({
      clients: [seedClient(TENANT_A)],
      facilities: [{ id: 'f1', tenantId: TENANT_A, clientId: 'client-1', ...facility }],
    });
    return { svc: new ClientFacilitiesService(prisma as never, kbStub as never), prisma };
  }

  test('district-only PATCH is rejected when it is invalid for the STORED state', async () => {
    const { svc, prisma } = svcWith({ name: 'HQ', state: 'WY', congressionalDistrict: '00' });

    await expect(
      svc.updateFacility(ctx(TENANT_A), 'client-1', 'f1', { congressionalDistrict: '52' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Row untouched.
    expect((prisma.__store.facilities[0] as Row).congressionalDistrict).toBe('00');
  });

  test('state-only PATCH is rejected when the STORED district is invalid for it', async () => {
    const { svc, prisma } = svcWith({ name: 'HQ', state: 'CA', congressionalDistrict: '52' });

    await expect(
      svc.updateFacility(ctx(TENANT_A), 'client-1', 'f1', { state: 'WY' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect((prisma.__store.facilities[0] as Row).state).toBe('CA');
  });

  test('district-only PATCH succeeds when valid for the stored state', async () => {
    const { svc } = svcWith({ name: 'HQ', state: 'CA', congressionalDistrict: '12' });

    const updated = (await svc.updateFacility(ctx(TENANT_A), 'client-1', 'f1', {
      congressionalDistrict: '52',
    })) as Row;

    expect(updated.congressionalDistrict).toBe('52');
    expect(updated.state).toBe('CA');
  });

  test('clearing the state while a district remains stays accepted (orphan district unchanged)', async () => {
    // Pre-existing behavior the cross-check must NOT tighten: a district with
    // no state is inert downstream but allowed (UI state Select has allowClear).
    // At runtime an explicit-clear arrives as `state: null` on the DTO
    // instance; `undefined` here exercises the same `'state' in input` path.
    const { svc } = svcWith({ name: 'HQ', state: 'CA', congressionalDistrict: '12' });

    const updated = (await svc.updateFacility(ctx(TENANT_A), 'client-1', 'f1', {
      state: undefined,
    })) as Row;

    expect(updated.state).toBeNull();
    expect(updated.congressionalDistrict).toBe('12');
  });

  test('a legacy row with an invalid STORED pair still accepts unrelated PATCHes', async () => {
    // Rows written before validation existed (e.g. CA/99) must stay editable:
    // the cross-check only fires when the PATCH touches state or district.
    const { svc } = svcWith({ name: 'HQ', state: 'CA', congressionalDistrict: '99' });

    const updated = (await svc.updateFacility(ctx(TENANT_A), 'client-1', 'f1', {
      name: 'Renamed',
      employeeCount: 7,
    })) as Row;

    expect(updated.name).toBe('Renamed');
    expect(updated.employeeCount).toBe(7);
  });

  test('a legacy invalid pair can be repaired by PATCHing the district to a valid one', async () => {
    const { svc } = svcWith({ name: 'HQ', state: 'CA', congressionalDistrict: '99' });

    const updated = (await svc.updateFacility(ctx(TENANT_A), 'client-1', 'f1', {
      congressionalDistrict: '12',
    })) as Row;

    expect(updated.congressionalDistrict).toBe('12');
  });
});

describe('ClientFacilitiesService — districtSource provenance on PATCH', () => {
  function svcWith(facility: Row) {
    const prisma = makePrisma({
      clients: [seedClient(TENANT_A)],
      facilities: [{ id: 'f1', tenantId: TENANT_A, clientId: 'client-1', ...facility }],
    });
    return { svc: new ClientFacilitiesService(prisma as never, kbStub as never), prisma };
  }

  test('a district PATCH without districtSource flips a geocoded row to "user"', async () => {
    // The stored value no longer reflects a geocode once hand-edited.
    const { svc } = svcWith({
      name: 'HQ',
      state: 'CA',
      congressionalDistrict: '12',
      districtSource: 'geocoded',
    });

    const updated = (await svc.updateFacility(ctx(TENANT_A), 'client-1', 'f1', {
      congressionalDistrict: '52',
    })) as Row;

    expect(updated.congressionalDistrict).toBe('52');
    expect(updated.districtSource).toBe('user');
  });

  test('an explicit districtSource in the PATCH wins over the implicit "user" stamp', async () => {
    // The geocoder PATCHes district + source together; it must stay 'geocoded'.
    const { svc } = svcWith({
      name: 'HQ',
      state: 'CA',
      congressionalDistrict: '12',
      districtSource: 'user',
    });

    const updated = (await svc.updateFacility(ctx(TENANT_A), 'client-1', 'f1', {
      congressionalDistrict: '52',
      districtSource: 'geocoded',
    })) as Row;

    expect(updated.districtSource).toBe('geocoded');
  });

  test('a PATCH that does not touch the district leaves districtSource alone', async () => {
    const { svc } = svcWith({
      name: 'HQ',
      state: 'CA',
      congressionalDistrict: '12',
      districtSource: 'geocoded',
    });

    const updated = (await svc.updateFacility(ctx(TENANT_A), 'client-1', 'f1', {
      employeeCount: 7,
    })) as Row;

    expect(updated.districtSource).toBe('geocoded');
  });
});

describe('ClientFacility DTO validation — districtSource + congressionalDistrict', () => {
  async function errorsFor(cls: typeof CreateFacilityDto | typeof UpdateFacilityDto, payload: Row) {
    const dto = plainToInstance(cls, payload);
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    return errors;
  }

  const props = (errors: Awaited<ReturnType<typeof validate>>) => errors.map((e) => e.property);

  test('accepts a bare 1-2 digit congressionalDistrict', async () => {
    expect(
      props(await errorsFor(CreateFacilityDto, { name: 'HQ', congressionalDistrict: '12' })),
    ).not.toContain('congressionalDistrict');
    expect(
      props(await errorsFor(CreateFacilityDto, { name: 'HQ', congressionalDistrict: '5' })),
    ).not.toContain('congressionalDistrict');
  });

  test('accepts the at-large sentinel "00" for congressionalDistrict', async () => {
    expect(
      props(await errorsFor(CreateFacilityDto, { name: 'HQ', congressionalDistrict: '00' })),
    ).not.toContain('congressionalDistrict');
  });

  test('rejects a non-numeric or "TX-12" style congressionalDistrict', async () => {
    expect(
      props(await errorsFor(CreateFacilityDto, { name: 'HQ', congressionalDistrict: 'TX-12' })),
    ).toContain('congressionalDistrict');
    expect(
      props(await errorsFor(CreateFacilityDto, { name: 'HQ', congressionalDistrict: '123' })),
    ).toContain('congressionalDistrict');
  });

  test('accepts districtSource of "user" and "geocoded"', async () => {
    expect(
      props(await errorsFor(CreateFacilityDto, { name: 'HQ', districtSource: 'user' })),
    ).not.toContain('districtSource');
    expect(
      props(await errorsFor(CreateFacilityDto, { name: 'HQ', districtSource: 'geocoded' })),
    ).not.toContain('districtSource');
  });

  test('rejects an out-of-enum districtSource', async () => {
    expect(
      props(await errorsFor(CreateFacilityDto, { name: 'HQ', districtSource: 'manual' })),
    ).toContain('districtSource');
  });

  test('UpdateFacilityDto applies the same district validation (no required name)', async () => {
    // Partial update with only a bad district → name is NOT flagged, district IS.
    const errs = props(await errorsFor(UpdateFacilityDto, { congressionalDistrict: 'abc' }));
    expect(errs).toContain('congressionalDistrict');
    expect(errs).not.toContain('name');
  });

  // The manual-entry fallback exists for facilities the geocoder can't
  // resolve — but the old `/^[A-Za-z0-9-]{1,8}$/` rejected named districts
  // outright, so in MA/NH/VT there was no way to enter the district by hand
  // either. These are real Census BASENAMEs, live-verified 2026-07-30.
  test.each([
    ['12', 'plain number'],
    ['3A', 'alpha-suffixed'],
    ['8th Bristol', 'MA lower'],
    ['First Bristol and Plymouth', 'MA upper'],
    ['Merrimack 18', 'NH lower'],
    ['Washington-4', 'VT lower'],
    ['Berkshire, Hampden, Franklin and Hampshire', 'MA longest'],
  ])('accepts the state legislative district %p (%s)', async (district) => {
    for (const field of ['stateHouseDistrict', 'stateSenateDistrict']) {
      const errs = props(await errorsFor(CreateFacilityDto, { name: 'HQ', [field]: district }));
      expect(errs).not.toContain(field);
    }
  });

  test('still rejects an empty or over-long state legislative district', async () => {
    expect(
      props(await errorsFor(CreateFacilityDto, { name: 'HQ', stateHouseDistrict: '' })),
    ).toContain('stateHouseDistrict');
    // 65 chars — one past the column width.
    expect(
      props(await errorsFor(CreateFacilityDto, { name: 'HQ', stateHouseDistrict: 'A'.repeat(65) })),
    ).toContain('stateHouseDistrict');
  });
});

// ── District storage form ───────────────────────────────────────────────────

/**
 * Facility style is 2-char zero-padded. Nothing enforced it on write until now, and
 * the consequence was not cosmetic: `districtKeyFor` builds its key from the code
 * AS STORED, so a facility saved as "7" keys as `WA-7` while every award for that
 * seat keys as `WA-07` (USAspending's `congressional_code` is stored verbatim and is
 * padded). The facility became its own district bucket with no awards, the real
 * district showed no facilities, and since the detail route builds `WA-07` the
 * facility was unreachable — it vanished from District Nexus.
 *
 * Seven of 151 production facilities were in that state on 2026-07-30, all written
 * by the Meri `web_import` path whose LLM payload varied between "7" and "07".
 *
 * INPUT stays lenient (a user may type "7"); only storage is normalized.
 */
describe('congressional district is normalized to storage form on write', () => {
  test.each([
    ['1', '01'],
    ['5', '05'],
    ['7', '07'],
    ['9', '09'],
  ])('create pads "%s" to "%s"', async (input, stored) => {
    const prisma = makePrisma({ clients: [seedClient(TENANT_A)] });
    const svc = new ClientFacilitiesService(prisma as never, kbStub as never);
    const created = (await svc.createFacility(ctx(TENANT_A), 'client-1', {
      name: 'Plant',
      state: 'WA',
      congressionalDistrict: input,
    })) as Row;
    expect(created.congressionalDistrict).toBe(stored);
  });

  test('create leaves an already-padded district alone', async () => {
    const prisma = makePrisma({ clients: [seedClient(TENANT_A)] });
    const svc = new ClientFacilitiesService(prisma as never, kbStub as never);
    const created = (await svc.createFacility(ctx(TENANT_A), 'client-1', {
      name: 'Plant',
      state: 'TX',
      congressionalDistrict: '16',
    })) as Row;
    expect(created.congressionalDistrict).toBe('16');
  });

  test('a single-seat jurisdiction stores 00, not 01', async () => {
    // At-largeness is derived from apportionment, never read off the value — some
    // sources report a sole House seat as "1", and it must key as '00' to join
    // against a geocoded at-large facility.
    const prisma = makePrisma({ clients: [seedClient(TENANT_A)] });
    const svc = new ClientFacilitiesService(prisma as never, kbStub as never);
    for (const [state, input] of [['WY', '1'], ['VT', '01'], ['DE', '1']] as const) {
      const created = (await svc.createFacility(ctx(TENANT_A), 'client-1', {
        name: `${state} site`,
        state,
        congressionalDistrict: input,
      })) as Row;
      expect(created.congressionalDistrict).toBe('00');
    }
  });

  test('an at-large facility already stored as 00 is unchanged', async () => {
    const prisma = makePrisma({ clients: [seedClient(TENANT_A)] });
    const svc = new ClientFacilitiesService(prisma as never, kbStub as never);
    const created = (await svc.createFacility(ctx(TENANT_A), 'client-1', {
      name: 'Cheyenne',
      state: 'WY',
      congressionalDistrict: '00',
    })) as Row;
    expect(created.congressionalDistrict).toBe('00');
  });

  test('a null or absent district stays null', async () => {
    const prisma = makePrisma({ clients: [seedClient(TENANT_A)] });
    const svc = new ClientFacilitiesService(prisma as never, kbStub as never);
    const noField = (await svc.createFacility(ctx(TENANT_A), 'client-1', { name: 'A' })) as Row;
    expect(noField.congressionalDistrict).toBeNull();
    const explicitNull = (await svc.createFacility(ctx(TENANT_A), 'client-1', {
      name: 'B',
      congressionalDistrict: undefined,
    })) as Row;
    expect(explicitNull.congressionalDistrict).toBeNull();
  });

  test('update pads too, using the STORED state when the PATCH omits it', async () => {
    // A district-only PATCH still has to know whether this is a single-seat
    // jurisdiction, which it can only learn from the row.
    const prisma = makePrisma({
      clients: [seedClient(TENANT_A)],
      facilities: [
        { id: 'f1', tenantId: TENANT_A, clientId: 'client-1', name: 'Plant', state: 'WA', congressionalDistrict: '01' },
        { id: 'f2', tenantId: TENANT_A, clientId: 'client-1', name: 'AtLarge', state: 'WY', congressionalDistrict: '00' },
      ],
    });
    const svc = new ClientFacilitiesService(prisma as never, kbStub as never);

    const padded = (await svc.updateFacility(ctx(TENANT_A), 'client-1', 'f1', {
      congressionalDistrict: '7',
    })) as Row;
    expect(padded.congressionalDistrict).toBe('07');

    const atLarge = (await svc.updateFacility(ctx(TENANT_A), 'client-1', 'f2', {
      congressionalDistrict: '1',
    })) as Row;
    expect(atLarge.congressionalDistrict).toBe('00');
  });

  test('update uses the INCOMING state when the PATCH changes both', async () => {
    const prisma = makePrisma({
      clients: [seedClient(TENANT_A)],
      facilities: [
        { id: 'f1', tenantId: TENANT_A, clientId: 'client-1', name: 'Plant', state: 'TX', congressionalDistrict: '16' },
      ],
    });
    const svc = new ClientFacilitiesService(prisma as never, kbStub as never);
    const moved = (await svc.updateFacility(ctx(TENANT_A), 'client-1', 'f1', {
      state: 'WY',
      congressionalDistrict: '1',
    })) as Row;
    // Moved to a single-seat state in the same PATCH → at-large, not '01'.
    expect(moved.congressionalDistrict).toBe('00');
  });

  test('clearing the district on update still clears it', async () => {
    const seed = () => ({
      clients: [seedClient(TENANT_A)],
      facilities: [
        { id: 'f1', tenantId: TENANT_A, clientId: 'client-1', name: 'Plant', state: 'WA', congressionalDistrict: '07' },
      ],
    });

    // The type-legal spelling: the KEY is present with `undefined`, which is what
    // `'congressionalDistrict' in input` detects. UpdateFacilityInput types the
    // field `string | undefined`, so this is how a caller expresses "clear it".
    const a = makePrisma(seed());
    const clearedByUndefined = (await new ClientFacilitiesService(
      a as never,
      kbStub as never,
    ).updateFacility(ctx(TENANT_A), 'client-1', 'f1', {
      congressionalDistrict: undefined,
    })) as Row;
    expect(clearedByUndefined.congressionalDistrict).toBeNull();

    // …and a literal JSON `null`, which the controller CAN deliver at runtime even
    // though the TS type does not admit it (the DTO is `@IsOptional()`), must clear
    // rather than crash or store the string "null". Cast, because the point is the
    // runtime path the type does not describe.
    const b = makePrisma(seed());
    const clearedByNull = (await new ClientFacilitiesService(
      b as never,
      kbStub as never,
    ).updateFacility(ctx(TENANT_A), 'client-1', 'f1', {
      congressionalDistrict: null as unknown as string | undefined,
    })) as Row;
    expect(clearedByNull.congressionalDistrict).toBeNull();
  });

  test('the geocoder’s non-voting-delegate sentinel survives verbatim', async () => {
    // '98' is a two-digit NUMBER, so a shape-based guard would pass it to the
    // at-large collapse and invent a seat. Observed on a real geocoded row.
    const prisma = makePrisma({ clients: [seedClient(TENANT_A)] });
    const svc = new ClientFacilitiesService(prisma as never, kbStub as never);
    for (const sentinel of ['90', '98', 'ZZ']) {
      const created = (await svc.createFacility(ctx(TENANT_A), 'client-1', {
        name: `sentinel ${sentinel}`,
        state: 'DC',
        congressionalDistrict: sentinel,
        districtSource: 'geocoded',
      })) as Row;
      expect(created.congressionalDistrict).toBe(sentinel);
    }
  });
});
