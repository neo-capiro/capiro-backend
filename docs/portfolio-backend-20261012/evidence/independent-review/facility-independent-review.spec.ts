import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { persistFacilityGeocodeSnapshot } from '../src/clients/facility-geocode-candidate-revision.js';

function harness() {
  const row = { id: 'facility', tenantId: 'tenant', clientId: 'client', addressLine: 'Address', city: 'Austin', state: 'TX', zip: '78701', geocodeCandidates: [{ matchedAddress: 'Choice' }], geocodeStatus: 'ambiguous', geocodeAttemptCount: 1, geocodeInputHash: 'prior', congressionalDistrict: null, congressionalDistrictCongress: null, districtSource: null, stateHouseDistrict: null, stateSenateDistrict: null, latitude: null, longitude: null };
  const client = {
    $disconnect: jest.fn().mockResolvedValue(undefined),
    $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
    $queryRawUnsafe: jest.fn().mockResolvedValue([row]),
    clientFacility: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    $transaction: jest.fn(),
  };
  client.$transaction.mockImplementation(async (fn) => fn(client));
  const PrismaClient = jest.fn().mockImplementation(() => client);
  const run = jest.fn().mockImplementation(async (_client, _name, fn) => fn());
  const compute = jest.fn().mockResolvedValue({ status: 'matched', update: { geocodeStatus: 'matched' }, matchedAddress: 'Current address' });
  const delay = jest.fn((callback) => { callback(); return 0; });
  const modules: Record<string, unknown> = {
    dotenv: { config: jest.fn() },
    '@prisma/client': { PrismaClient, Prisma: { JsonNull: null } },
    '../src/ingestion/sync-run.helper.js': { runWithSyncRun: run },
    '../src/clients/facility-geocode.util.js': { computeFacilityGeocode: compute, facilityAddressHash: () => 'current-hash' },
    '../src/clients/geocode-retry.js': { hasGeocodableAddress: () => true, nextGeocodeAttempt: () => ({ status: 'matched', nextAttemptAt: null }) },
    '../src/clients/facility-geocode-candidate-revision.js': { persistFacilityGeocodeSnapshot },
  };
  const module = { exports: {} as { __reviewMain: () => Promise<unknown> } };
  const requireFake = Object.assign((name: string) => { if (!(name in modules)) throw new Error('Unexpected import '+name); return modules[name]; }, { main: {} });
  const source = readFileSync(join(__dirname, 'geocode-facilities.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  // Export only in this VM harness so we can await the existing source entry point.
  // Real imports, Prisma and remote calls are unavailable in this context.
  runInNewContext(code + '\nmodule.exports.__reviewMain=main;', { module, exports: module.exports, require: requireFake, process: { env: { DATABASE_URL: 'synthetic-only', GEOCODE_DELAY_MS: '17' }, exit: jest.fn() }, console: { log: jest.fn(), error: jest.fn() }, setTimeout: delay });
  return { row, client, PrismaClient, run, compute, delay, main: module.exports.__reviewMain };
}

describe('independent facility CLI lifecycle and original snapshot', () => {
  it('importing the module does not allocate or dispatch', () => {
    const h = harness();
    expect(h.PrismaClient).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
    expect(h.compute).not.toHaveBeenCalled();
    expect(h.delay).not.toHaveBeenCalled();
  });
  it('disconnects its owned client when sync initialization fails', async () => {
    const h = harness();
    h.run.mockRejectedValue(new Error('synthetic initialization failure'));
    await expect(h.main()).rejects.toThrow('synthetic initialization failure');
    expect(h.PrismaClient).toHaveBeenCalledTimes(1);
    expect(h.client.$disconnect).toHaveBeenCalledTimes(1);
    expect(h.compute).not.toHaveBeenCalled();
  });
  it('passes original snapshot through CAS, counts stale skip and retains delay/disconnect', async () => {
    const h = harness();
    await h.main();
    const result = await h.run.mock.results[0].value;
    expect(result).toMatchObject({ inserted: 0, updated: 0, skipped: 1, errors: 0 });
    expect(h.client.clientFacility.updateMany).toHaveBeenCalledWith({ where: { ...h.row, geocodeCandidates: { equals: h.row.geocodeCandidates } }, data: expect.objectContaining({ geocodeStatus: 'matched', geocodeAttemptCount: 2, geocodeInputHash: 'current-hash' }) });
    expect(h.delay).toHaveBeenCalledWith(expect.any(Function), 17);
    expect(h.client.$disconnect).toHaveBeenCalledTimes(1);
  });
  it('retains per-row failure accounting, delay and disconnect', async () => {
    const h = harness();
    h.compute.mockRejectedValue(new Error('synthetic resolver failure'));
    await h.main();
    const result = await h.run.mock.results[0].value;
    expect(result).toMatchObject({ inserted: 0, updated: 0, skipped: 0, errors: 1, errorMessage: 'facility facility: synthetic resolver failure' });
    expect(h.client.clientFacility.updateMany).not.toHaveBeenCalled();
    expect(h.delay).toHaveBeenCalledWith(expect.any(Function), 17);
    expect(h.client.$disconnect).toHaveBeenCalledTimes(1);
  });
});
