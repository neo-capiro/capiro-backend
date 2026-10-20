import 'reflect-metadata';
import { Global, Module } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Request } from 'express';
import request from 'supertest';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TenantContextMiddleware } from '../../tenant/tenant-context.middleware.js';
import { ObjectiveWorkModule } from '../../clients/objectives/work/objective-work.module.js';
import { ObjectiveWorkloadAdmissionModule } from './objective-workload-admission.module.js';
import { OBJECTIVE_ADMISSION_RUNTIME, ObjectiveWorkloadAdmissionController, objectiveAdmissionHttpRequest } from './objective-workload-admission.controller.js';
import type { ObjectiveAdmissionRuntime } from './objective-workload-admission-runtime.js';
import { OBJECTIVE_WORKLOAD_PROOF_PATH } from './objective-workload-proof.js';

const io = jest.fn(() => { throw Error('Unexpected external I/O'); });
@Global()
@Module({
  providers: [{ provide: PrismaService, useValue: { withTenant: io, withSystem: io } },
    { provide: TenantContextMiddleware, useValue: { readApplicationAuthority: io } }],
  exports: [PrismaService, TenantContextMiddleware],
})
class LocalDependencies {}

const raw = () => ({ method: 'POST', originalUrl: OBJECTIVE_WORKLOAD_PROOF_PATH,
  rawHeaders: ['Authorization', 'Bearer test'], headers: { authorization: 'Bearer test' },
  rawBody: Buffer.from('{ "exact": "entity bytes" }') } as unknown as Request);

describe('Objective admission exact HTTP adapter', () => {
  it('passes original URL, captured entity bytes and single original Authorization without serialization', () => {
    const req = raw(), observed = objectiveAdmissionHttpRequest(req);
    expect(observed.rawBody).toBe((req as any).rawBody);
    expect(observed.originalUrl).toBe(OBJECTIVE_WORKLOAD_PROOF_PATH);
    expect(observed.authorization).toBe('Bearer test');
  });
  it.each(['same', 'different'])('rejects %s duplicate Authorization even if Node normalized it', kind => {
    const req = raw(); req.rawHeaders.push('aUtHoRiZaTiOn', kind === 'same' ? 'Bearer test' : 'Bearer other');
    expect(() => objectiveAdmissionHttpRequest(req)).toThrow('Objective workload admission unavailable');
  });
  it('rejects inconsistent normalized header and absent original header', () => {
    const req = raw(); req.headers.authorization = 'Bearer other';
    expect(() => objectiveAdmissionHttpRequest(req)).toThrow();
    req.rawHeaders.splice(0);
    expect(() => objectiveAdmissionHttpRequest(req)).toThrow();
  });
  it.each([{}, Buffer.from('{}')])('never promotes parsed body to captured signed bytes', body => {
    const req = raw() as any; delete req.rawBody; req.body = body;
    expect(() => objectiveAdmissionHttpRequest(req)).toThrow();
  });
  it('does not invoke a rawBody getter', () => {
    const req = raw(), getter = jest.fn(() => Buffer.from('{}'));
    Object.defineProperty(req, 'rawBody', { get: getter });
    expect(() => objectiveAdmissionHttpRequest(req)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it('preserves query and method for ingress rejection rather than normalizing them into the fixed route', () => {
    const req = raw(); req.originalUrl += '?alias=1'; req.method = 'GET';
    const observed = objectiveAdmissionHttpRequest(req);
    expect(observed.originalUrl).toBe(`${OBJECTIVE_WORKLOAD_PROOF_PATH}?alias=1`);
    expect(observed.method).toBe('GET');
  });
});

describe('production Objective admission module composition', () => {
  let module: TestingModule | undefined;
  afterEach(async () => { await module?.close(); module = undefined; io.mockClear(); });

  it('is imported through the actual ObjectiveWorkModule and remains unavailable without external I/O', async () => {
    module = await Test.createTestingModule({ imports: [LocalDependencies, ObjectiveWorkModule] }).compile();
    expect(module.get(ObjectiveWorkloadAdmissionController)).toBeInstanceOf(ObjectiveWorkloadAdmissionController);
    await expect(module.get<ObjectiveAdmissionRuntime>(OBJECTIVE_ADMISSION_RUNTIME)({} as any))
      .rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(module.get(ObjectiveWorkloadAdmissionController).decide(raw()))
      .rejects.toMatchObject({ status: 503, response: { message: 'Objective workload admission unavailable' } });
    expect(io).not.toHaveBeenCalled();
  });
  it('maps runtime faults to the same closed response without exposing private errors or tokens', async () => {
    module = await Test.createTestingModule({ imports: [ObjectiveWorkloadAdmissionModule] })
      .overrideProvider(OBJECTIVE_ADMISSION_RUNTIME).useValue(async () => { throw Error('private signer/database detail'); }).compile();
    await expect(module.get(ObjectiveWorkloadAdmissionController).decide(raw()))
      .rejects.toMatchObject({ response: { message: 'Objective workload admission unavailable' }, status: 503 });
  });
  it('serves the actual fixed HTTP route default-off with no-store and no positive response', async () => {
    module = await Test.createTestingModule({ imports: [ObjectiveWorkloadAdmissionModule] }).compile();
    const app = module.createNestApplication(); app.setGlobalPrefix('api');
    try {
      await app.init();
      const response = await request(app.getHttpServer()).post(OBJECTIVE_WORKLOAD_PROOF_PATH)
        .set('Authorization', 'Bearer test').send({ schemaVersion: 1 });
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ message: 'Objective workload admission unavailable', error: 'Service Unavailable', statusCode: 503 });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers.pragma).toBe('no-cache');
    } finally { await app.close(); }
  });
});
