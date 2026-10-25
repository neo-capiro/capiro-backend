import { BadRequestException, ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Request } from 'express';
import { ToolServiceSecretGuard } from '../meri/tool-service-secret.guard.js';
import { MERI_EVIDENCE_MODE_READS } from '../meri/meri-funding-read-observation.js';
import { ApplicationReadModeObservationService, parseApplicationReadModeObservationRequest } from './application-read-mode-observation.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const ctx = { tenantId, userId: actorId, role: 'standard_user' } as TenantContext;
const input = { operation: { id: 'search_federal_grants', version: '0.2.0' }, requestSha256: 'a'.repeat(64) };
const SECRET = 'mode-observation-service-test';
const control = { deadlineMs: Number.MAX_SAFE_INTEGER, assertActive: jest.fn() };
function request(secret: unknown = SECRET) {
  const req = { headers: { 'x-internal-service-secret': secret } } as unknown as Request;
  new ToolServiceSecretGuard({ get: (key: string) => key === 'INTERNAL_SERVICE_SECRET' ? SECRET : key === 'NODE_ENV' ? 'development' : false } as never)
    .canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext);
  return req;
}
function fixture() {
  const member = { read: jest.fn(async () => ({ tenantId, actorId, status: 'active' })) };
  return { member, service: new ApplicationReadModeObservationService(member as never) };
}

describe('closed native mode observation', () => {
  const originalEnv = process.env;
  beforeEach(() => { process.env = { ...originalEnv, MERI_EVIDENCE_ACCURACY_TENANTS: tenantId, MERI_EVIDENCE_ACCURACY_SURFACES: 'chat' }; control.assertActive.mockReset(); });
  afterEach(() => { process.env = originalEnv; });

  it.each(MERI_EVIDENCE_MODE_READS)('observes all three actual modes for %s without leaking membership facts', async id => {
    for (const mode of ['off', 'shadow', 'enforce']) {
      process.env.MERI_EVIDENCE_ACCURACY_MODE = mode;
      const { service, member } = fixture();
      const operation = { id, version: '0.2.0' };
      expect(await service.read(request(), ctx, { ...input, operation }, control)).toEqual({ operation, requestSha256: input.requestSha256,
        principal: { tenantId, actorId }, surface: 'chat', evidenceAccuracyMode: mode });
      expect(member.read).toHaveBeenCalledTimes(1);
    }
  });

  it('uses canonical tenant and literal chat enrollment rather than configured mode alone', async () => {
    process.env.MERI_EVIDENCE_ACCURACY_MODE = 'enforce';
    process.env.MERI_EVIDENCE_ACCURACY_SURFACES = 'in-editor';
    const { service } = fixture();
    expect(await service.read(request(), ctx, input, control)).toHaveProperty('evidenceAccuracyMode', 'off');
    process.env.MERI_EVIDENCE_ACCURACY_SURFACES = 'chat';
    process.env.MERI_EVIDENCE_ACCURACY_TENANTS = actorId;
    expect(await service.read(request(), ctx, input, control)).toHaveProperty('evidenceAccuracyMode', 'off');
  });

  it.each([null, [], {}, { ...input, tenantId }, { ...input, evidenceAccuracyMode: 'off' },
    { ...input, requestSha256: 'A'.repeat(64) }, { ...input, requestSha256: 'a'.repeat(64) + '\n' }, { ...input, operation: { ...input.operation, surface: 'chat' } },
    { ...input, operation: { id: 'search_sam_opportunities_suffix', version: '0.2.0' } },
    { ...input, operation: { id: 'search_client_knowledge', version: '0.2.0' } },
    { ...input, operation: { id: 'search_federal_grants', version: '0.1.0' } },
  ])('refuses malformed/foreign input before membership I/O: %p', async raw => {
    const { service, member } = fixture();
    await expect(service.read(request(), ctx, raw, control)).rejects.toBeInstanceOf(BadRequestException);
    expect(member.read).not.toHaveBeenCalled();
  });

  it('rejects proxy/accessor/prototype/symbol bodies without invoking getters', () => {
    const read = jest.fn();
    for (const raw of [new Proxy(input, {}), Object.assign(Object.create({ extra: true }), input),
      { ...input, [Symbol('private')]: true }, Object.defineProperty({ operation: input.operation }, 'requestSha256', { enumerable: true, get: read })]) {
      expect(() => parseApplicationReadModeObservationRequest(raw)).toThrow(BadRequestException);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it.each([undefined, 'wrong', ['wrong']])('requires matched service identity before membership I/O: %p', async secret => {
    const { service, member } = fixture();
    // Explicit undefined must remain absent; the helper default is only for valid requests.
    const req = secret === undefined ? request('wrong') : request(secret);
    await expect(service.read(req, ctx, input, control)).rejects.toBeInstanceOf(ForbiddenException);
    expect(member.read).not.toHaveBeenCalled();
  });

  it('refuses current-owner failure, wrong principal and cancellation without returning an observation', async () => {
    const { service, member } = fixture();
    member.read.mockRejectedValueOnce(new ForbiddenException('Current membership changed'));
    await expect(service.read(request(), ctx, input, control)).rejects.toThrow('Current membership changed');
    member.read.mockResolvedValueOnce({ tenantId: actorId, actorId, status: 'active' });
    await expect(service.read(request(), ctx, input, control)).rejects.toThrow('principal unavailable');
    control.assertActive.mockImplementation(() => { throw new Error('cancelled'); });
    member.read.mockClear();
    await expect(service.read(request(), ctx, input, control)).rejects.toThrow('cancelled');
    expect(member.read).not.toHaveBeenCalled();
  });
});
