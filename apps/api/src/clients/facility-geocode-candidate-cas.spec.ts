import 'reflect-metadata';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ClientKbService } from '../embeddings/client-kb.service.js';
import type { TenantContext } from '@capiro/shared';
import { ClientFacilitiesService } from './client-facilities.service.js';
import {
  ClientFacilitiesController,
  ReviewedChooseGeocodeCandidateDto,
} from './client-facilities.controller.js';
import {
  facilityGeocodeCandidateRevision,
  persistFacilityGeocodeSnapshot,
  type FacilityCandidateSnapshot,
} from './facility-geocode-candidate-revision.js';
import { facilityAddressHash } from './facility-geocode.util.js';
import * as facilityGeocode from './facility-geocode.util.js';

jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock('../embeddings/client-kb.service.js', () => ({ ClientKbService: class {} }));
jest.mock('../auth/roles.guard.js', () => ({ RolesGuard: class {} }));
jest.mock('../external/census-geocoder/census-geocoder.client.js', () => ({
  geocodeAddress: jest.fn(() => {
    throw new Error('Provider calls are prohibited in this test');
  }),
}));

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const clientId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const otherId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const context = { tenantId, userId: 'synthetic-user' } as TenantContext;
const candidate = {
  matchedAddress: '2 MAIN ST, AUSTIN TX',
  addressLine: '2 Main St',
  city: 'Austin',
  state: 'TX',
  zip: '78701',
  latitude: 30,
  longitude: -97,
  congressionalDistrict: '7',
  congressionalDistrictCongress: 119,
  stateHouseDistrict: '12',
  stateSenateDistrict: '3',
};
const snapshot: FacilityCandidateSnapshot = {
  id,
  tenantId,
  clientId,
  addressLine: '1 Main St',
  city: 'Austin',
  state: 'TX',
  zip: '78701',
  geocodeCandidates: [candidate],
  geocodeStatus: 'ambiguous',
  geocodeAttemptCount: 1,
  geocodeInputHash: 'old-address-hash',
  congressionalDistrict: null,
  congressionalDistrictCongress: null,
  districtSource: null,
  stateHouseDistrict: null,
  stateSenateDistrict: null,
  latitude: null,
  longitude: null,
};

// A thin query adapter executes the actual service's CAS predicates in real Postgres/WASM.
// It is not Prisma-engine, RLS, multiple-connection or HTTP/auth acceptance.
const columns = new Map<string, string>(
  Object.entries({
    id: 'id',
    tenantId: 'tenant_id',
    clientId: 'client_id',
    addressLine: 'address_line',
    city: 'city',
    state: 'state',
    zip: 'zip',
    geocodeCandidates: 'geocode_candidates_jsonb',
    geocodeStatus: 'geocode_status',
    geocodeAttemptCount: 'geocode_attempt_count',
    geocodeInputHash: 'geocode_input_hash',
    congressionalDistrict: 'congressional_district',
    congressionalDistrictCongress: 'congressional_district_congress',
    districtSource: 'district_source',
    stateHouseDistrict: 'state_house_district',
    stateSenateDistrict: 'state_senate_district',
    latitude: 'latitude',
    longitude: 'longitude',
    geocodedAt: 'geocoded_at',
    geocodeMatchedAddress: 'geocode_matched_address',
    geocodeNextAttemptAt: 'geocode_next_attempt_at',
    geocodeLastError: 'geocode_last_error',
  }),
);
const selectedColumns = [...columns].map(([field, column]) => `${column} AS "${field}"`).join(',');
let db: PGlite;
let beforeUpdate: (() => Promise<void>) | null = null;
let updates = 0;
const index = jest.fn();
let service: ClientFacilitiesService;
let workerCommit: (
  original: FacilityCandidateSnapshot,
  data: Prisma.ClientFacilityUpdateManyMutationInput,
) => Promise<Prisma.BatchPayload>;

function predicates(where: object, values: unknown[]): string {
  return Object.entries(where)
    .map(([key, value]) => {
      const column = columns.get(key);
      if (!column) throw new Error(`Unexpected test filter ${key}`);
      if (key === 'geocodeCandidates') {
        if (!value || typeof value !== 'object' || !('equals' in value))
          throw new Error('JSON equality required');
        if (value.equals === Prisma.AnyNull)
          return `(${column} IS NULL OR ${column}='null'::jsonb)`;
        values.push(JSON.stringify(value.equals));
        return `${column} IS NOT DISTINCT FROM $${values.length}::jsonb`;
      }
      values.push(value);
      return `${column} IS NOT DISTINCT FROM $${values.length}`;
    })
    .join(' AND ');
}

async function current(): Promise<FacilityCandidateSnapshot> {
  const result = await db.query<FacilityCandidateSnapshot>(
    `SELECT ${selectedColumns} FROM client_facilities WHERE id=$1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Missing test fixture');
  return row;
}

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(`CREATE TABLE client_facilities (
    id uuid PRIMARY KEY, tenant_id uuid NOT NULL, client_id uuid NOT NULL,
    address_line text, city text, state text, zip text, geocode_candidates_jsonb jsonb,
    geocode_status text, geocode_attempt_count integer, geocode_input_hash text,
    congressional_district text, congressional_district_congress integer, district_source text,
    state_house_district text, state_senate_district text, latitude double precision, longitude double precision,
    geocoded_at timestamptz(6), geocode_matched_address text, geocode_next_attempt_at timestamptz(6), geocode_last_error text,
    updated_at timestamptz(6) NOT NULL DEFAULT '2026-10-11 00:00:00.123456+00');`);
});
afterAll(async () => {
  await db.close();
});
afterEach(() => {
  jest.restoreAllMocks();
});

beforeEach(async () => {
  await db.exec('DELETE FROM client_facilities');
  const fields = Object.entries(snapshot);
  await db.query(
    `INSERT INTO client_facilities (${fields.map(([key]) => columns.get(key)).join(',')})
    VALUES (${fields.map(([key], position) => `$${position + 1}${key === 'geocodeCandidates' ? '::jsonb' : ''}`).join(',')})`,
    fields.map(([key, value]) => (key === 'geocodeCandidates' ? JSON.stringify(value) : value)),
  );
  beforeUpdate = null;
  updates = 0;
  index.mockClear();
  const tx = {
    clientFacility: {
      findUnique: async ({ where }: { where: object }) => {
        const values: unknown[] = [];
        return (
          (
            await db.query<FacilityCandidateSnapshot>(
              `SELECT ${selectedColumns} FROM client_facilities WHERE ${predicates({ ...where, tenantId }, values)}`,
              values,
            )
          ).rows[0] ?? null
        );
      },
      findFirst: async ({ where }: { where: object }) => {
        const values: unknown[] = [];
        return (
          (
            await db.query<FacilityCandidateSnapshot>(
              `SELECT ${selectedColumns} FROM client_facilities WHERE ${predicates(where, values)}`,
              values,
            )
          ).rows[0] ?? null
        );
      },
      updateMany: async ({ where, data }: { where: object; data: object }) => {
        if (beforeUpdate) {
          const interleave = beforeUpdate;
          beforeUpdate = null;
          await interleave();
        }
        const values: unknown[] = [];
        const assignments = Object.entries(data).map(([key, value]) => {
          const column = columns.get(key);
          if (!column) throw new Error(`Unexpected test update ${key}`);
          values.push(
            key === 'geocodeCandidates'
              ? JSON.stringify(value === Prisma.JsonNull ? null : value)
              : value,
          );
          return `${column}=$${values.length}${key === 'geocodeCandidates' ? '::jsonb' : ''}`;
        });
        const result = await db.query(
          `UPDATE client_facilities SET ${assignments.join(',')}, updated_at=clock_timestamp()
        WHERE ${predicates(where, values)} RETURNING id`,
          values,
        );
        updates += result.rows.length;
        return { count: result.rows.length };
      },
    },
  };
  const prisma = {
    withTenant: async <T>(scope: string, fn: (transaction: typeof tx) => Promise<T>) => {
      expect(scope).toBe(context.tenantId);
      return fn(tx);
    },
  } as unknown as PrismaService;
  service = new ClientFacilitiesService(prisma, {
    indexFacilityFireAndForget: index,
  } as unknown as ClientKbService);
  workerCommit = (original, data) =>
    persistFacilityGeocodeSnapshot(
      tx as unknown as Pick<Prisma.TransactionClient, 'clientFacility'>,
      original,
      data,
    );
});

describe('reviewed facility candidate contract and CAS', () => {
  test('revision survives JSONB key reordering and ignores timestamp precision/unrelated fields', async () => {
    const stored = await current();
    expect(facilityGeocodeCandidateRevision(stored)).toBe(
      facilityGeocodeCandidateRevision(snapshot),
    );
    expect(facilityGeocodeCandidateRevision(snapshot)).toBe(
      'v1:bfb3a93592f58572f58fd8a237c66f9537b0c949f272545c74653e59047b930c',
    );
    const precision = await db.query<{ text: string }>(
      'SELECT updated_at::text AS text FROM client_facilities WHERE id=$1',
      [id],
    );
    expect(precision.rows[0]?.text).toContain('.123456');
    await db.query('UPDATE client_facilities SET updated_at=$1 WHERE id=$2', [
      '2026-10-11 00:00:00.123999+00',
      id,
    ]);
    expect(facilityGeocodeCandidateRevision(await current())).toBe(
      facilityGeocodeCandidateRevision(snapshot),
    );
  });

  test('chooses the reviewed point, stamps input hash, clears retries and indexes only once', async () => {
    const result = await service.chooseGeocodeCandidate(context, clientId, id, 0, {
      expectedRevision: facilityGeocodeCandidateRevision(snapshot),
    });
    expect(result).toMatchObject({
      addressLine: '2 Main St',
      latitude: 30,
      longitude: -97,
      congressionalDistrict: '07',
      congressionalDistrictCongress: 119,
      geocodeStatus: 'matched',
      geocodeCandidates: null,
      geocodeNextAttemptAt: null,
      geocodeLastError: null,
    });
    expect(result.geocodeInputHash).toBe(facilityAddressHash(candidate));
    expect(result.geocodeCandidateRevision).toBe(facilityGeocodeCandidateRevision(result));
    expect(updates).toBe(1);
    expect(index).toHaveBeenCalledTimes(1);
    await expect(
      service.chooseGeocodeCandidate(context, clientId, id, 0, {
        expectedRevision: facilityGeocodeCandidateRevision(snapshot),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(updates).toBe(1);
    expect(index).toHaveBeenCalledTimes(1);
  });

  test('stale displayed address is rejected before selecting a newer candidate at the same index', async () => {
    await db.query(
      'UPDATE client_facilities SET address_line=$1,geocode_candidates_jsonb=$2::jsonb WHERE id=$3',
      [
        'Changed address',
        JSON.stringify([{ ...candidate, matchedAddress: 'OTHER PLACE', latitude: 40 }]),
        id,
      ],
    );
    await expect(
      service.chooseGeocodeCandidate(context, clientId, id, 0, {
        expectedRevision: facilityGeocodeCandidateRevision(snapshot),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect((await current()).addressLine).toBe('Changed address');
    expect(updates).toBe(0);
    expect(index).not.toHaveBeenCalled();
  });

  for (const kind of [
    'address',
    'candidates',
    'attempt',
    'district',
    'point',
    'inputHash',
    'status',
    'deleted',
  ] as const) {
    test(`atomic CAS rejects a concurrent ${kind} replacement after the service read`, async () => {
      beforeUpdate = async () => {
        if (kind === 'address')
          await db.query('UPDATE client_facilities SET address_line=$1 WHERE id=$2', [
            'Concurrent address',
            id,
          ]);
        if (kind === 'candidates')
          await db.query(
            'UPDATE client_facilities SET geocode_candidates_jsonb=$1::jsonb WHERE id=$2',
            [JSON.stringify([{ ...candidate, latitude: 45 }]), id],
          );
        if (kind === 'attempt')
          await db.query('UPDATE client_facilities SET geocode_attempt_count=2 WHERE id=$1', [id]);
        if (kind === 'district')
          await db.query('UPDATE client_facilities SET district_source=$1 WHERE id=$2', [
            'user',
            id,
          ]);
        if (kind === 'point')
          await db.query('UPDATE client_facilities SET latitude=42 WHERE id=$1', [id]);
        if (kind === 'inputHash')
          await db.query('UPDATE client_facilities SET geocode_input_hash=$1 WHERE id=$2', [
            'new-hash',
            id,
          ]);
        if (kind === 'status')
          await db.query('UPDATE client_facilities SET geocode_status=$1 WHERE id=$2', [
            'pending',
            id,
          ]);
        if (kind === 'deleted') await db.query('DELETE FROM client_facilities WHERE id=$1', [id]);
      };
      await expect(
        service.chooseGeocodeCandidate(context, clientId, id, 0, {
          expectedRevision: facilityGeocodeCandidateRevision(snapshot),
        }),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'FACILITY_GEOCODE_CANDIDATES_CHANGED' },
      });
      expect(updates).toBe(0);
      expect(index).not.toHaveBeenCalled();
    });
  }

  test('two simultaneous reviewed selections have one persisted winner', async () => {
    const review = { expectedRevision: facilityGeocodeCandidateRevision(snapshot) };
    const results = await Promise.allSettled([
      service.chooseGeocodeCandidate(context, clientId, id, 0, review),
      service.chooseGeocodeCandidate(context, clientId, id, 0, review),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(updates).toBe(1);
    expect(index).toHaveBeenCalledTimes(1);
  });

  test('worker snapshot followed by reviewed selection rejects the stale worker commit', async () => {
    const old = await current();
    await service.chooseGeocodeCandidate(context, clientId, id, 0, {
      expectedRevision: facilityGeocodeCandidateRevision(old),
    });
    const result = await workerCommit(old, {
      geocodeStatus: 'ambiguous',
      geocodeCandidates: [{ ...candidate, latitude: 45 }],
      geocodeAttemptCount: 2,
    });
    expect(result.count).toBe(0);
    expect(await current()).toMatchObject({
      latitude: 30,
      geocodeStatus: 'matched',
      geocodeCandidates: null,
      geocodeAttemptCount: 1,
    });
  });

  test('current worker commit succeeds, preserves retry state and invalidates the old review', async () => {
    const retryAt = new Date('2026-10-12T00:00:00.000Z');
    expect(
      (
        await workerCommit(await current(), {
          geocodeStatus: 'ambiguous',
          geocodeCandidates: [candidate],
          geocodeAttemptCount: 2,
          geocodeNextAttemptAt: retryAt,
          geocodeLastError: null,
        })
      ).count,
    ).toBe(1);
    await expect(
      service.chooseGeocodeCandidate(context, clientId, id, 0, {
        expectedRevision: facilityGeocodeCandidateRevision(snapshot),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    const stored = await current();
    expect(stored).toMatchObject({
      geocodeStatus: 'ambiguous',
      geocodeAttemptCount: 2,
      geocodeNextAttemptAt: retryAt,
    });
  });

  test('same-address and same-district reviewed choice fences an in-flight inline resolver', async () => {
    await db.query(
      `UPDATE client_facilities SET address_line=$1,congressional_district='07',district_source='geocoded',
      state_house_district='12',state_senate_district='3',latitude=30,longitude=-97 WHERE id=$2`,
      ['2 Main St', id],
    );
    const original = await current();
    let resume!: () => void;
    let started!: () => void;
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    jest.spyOn(facilityGeocode, 'computeFacilityGeocode').mockImplementation(async () => {
      started();
      await paused;
      return {
        status: 'ambiguous',
        update: null,
        matchedAddress: null,
        candidates: [{ ...candidate, latitude: 45 }],
        discrepancy: null,
      };
    });
    // Private method boundary is exercised with provider I/O replaced by a controlled promise.
    const resolver = (
      service as unknown as { geocodeFacility(tenant: string, facility: string): Promise<void> }
    ).geocodeFacility(tenantId, id);
    try {
      await ready;
      await service.chooseGeocodeCandidate(context, clientId, id, 0, {
        expectedRevision: facilityGeocodeCandidateRevision(original),
      });
    } finally {
      resume();
    }
    await resolver;
    expect(await current()).toMatchObject({
      addressLine: '2 Main St',
      latitude: 30,
      geocodeStatus: 'matched',
      geocodeCandidates: null,
      geocodeAttemptCount: 1,
    });
    expect(updates).toBe(1);
    expect(index).toHaveBeenCalledTimes(1);
  });

  test('legacy caller remains compatible and gains atomic protection without claiming stale-review safety', async () => {
    expect((await service.chooseGeocodeCandidate(context, clientId, id, 0)).geocodeStatus).toBe(
      'matched',
    );
  });

  test('wrong tenant and wrong client remain not found without mutation', async () => {
    await db.query('UPDATE client_facilities SET tenant_id=$1 WHERE id=$2', [otherId, id]);
    await expect(service.chooseGeocodeCandidate(context, clientId, id, 0)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await db.query('UPDATE client_facilities SET tenant_id=$1 WHERE id=$2', [tenantId, id]);
    await expect(service.chooseGeocodeCandidate(context, otherId, id, 0)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(updates).toBe(0);
    expect(index).not.toHaveBeenCalled();
  });

  test('invalid index, malformed/missing review and unavailable candidate cannot dispatch', async () => {
    for (const indexValue of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
      await expect(
        service.chooseGeocodeCandidate(context, clientId, id, indexValue),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    for (const expectedRevision of ['', 'v2:' + 'a'.repeat(64), 'v1:' + 'A'.repeat(64)]) {
      await expect(
        service.chooseGeocodeCandidate(context, clientId, id, 0, { expectedRevision }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(service.chooseGeocodeCandidate(context, clientId, id, 3)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const controller = new ClientFacilitiesController(service);
    // Deliberately malformed body bypasses Nest validation: strict handler still cannot fall back to legacy.
    await expect(
      controller.chooseReviewedGeocodeCandidate(context, clientId, id, {
        candidateIndex: 0,
      } as ReviewedChooseGeocodeCandidateDto),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(updates).toBe(0);
  });

  test('reviewed DTO requires revision and controller retains existing role/route metadata', async () => {
    const valid = plainToInstance(ReviewedChooseGeocodeCandidateDto, {
      candidateIndex: 0,
      expectedRevision: facilityGeocodeCandidateRevision(snapshot),
    });
    expect(await validate(valid)).toHaveLength(0);
    for (const payload of [
      { candidateIndex: 0 },
      { candidateIndex: -1, expectedRevision: valid.expectedRevision },
      { candidateIndex: '0', expectedRevision: valid.expectedRevision },
      { candidateIndex: 0, expectedRevision: 'bad' },
    ]) {
      expect(
        (await validate(plainToInstance(ReviewedChooseGeocodeCandidateDto, payload))).length,
      ).toBeGreaterThan(0);
    }
    expect(Reflect.getMetadata('capiro:roles', ClientFacilitiesController)).toEqual([
      'standard_user',
    ]);
    expect(
      Reflect.getMetadata(
        'path',
        ClientFacilitiesController.prototype.chooseReviewedGeocodeCandidate,
      ),
    ).toBe(':id/geocode-candidate/reviewed');
    expect(
      Reflect.getMetadata('path', ClientFacilitiesController.prototype.chooseGeocodeCandidate),
    ).toBe(':id/geocode-candidate');
  });

  test('public list emits the server revision without requiring callers to reconstruct internal fields', async () => {
    const raw = await current();
    const prisma = {
      withTenant: async (_scope: string, fn: (tx: object) => Promise<unknown>) =>
        fn({
          client: { findFirst: async () => ({ id: clientId }) },
          clientFacility: { findMany: async () => [raw] },
        }),
    } as unknown as PrismaService;
    const listed = await new ClientFacilitiesService(prisma, {} as ClientKbService).listFacilities(
      context,
      clientId,
    );
    expect(listed[0]?.geocodeCandidateRevision).toBe(facilityGeocodeCandidateRevision(raw));
  });
});
