import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { ServiceUnavailableException } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { TenantContext } from '@capiro/shared';
import { ReadDelegationController } from '../../auth/read-delegation/read-delegation.controller.js';
import { ReadDelegationService } from '../../auth/read-delegation/read-delegation.service.js';
import { TenantContextMiddleware } from '../../tenant/tenant-context.middleware.js';
import { MeriController } from '../meri.controller.js';
import { MeriModule } from '../meri.module.js';
import { MeriMemoryHelperController } from './meri-memory-helper.controller.js';
import * as gate from '../../auth/read-delegation/signed-memory-http-gate.js';
import * as serviceIdentity from '../../auth/tool-service-secret.guard.js';
import * as delegationRequest from '../../auth/read-delegation/read-delegation-request.js';
import * as signerConfig from '../../auth/core-ed25519-kms-config.js';
import * as keyConfig from '../../auth/core-ed25519-key-config.js';
import * as helperSource from './meri-memory-helper-source.js';
import * as helperReceiver from './meri-memory-helper-receiver.js';
import * as signedPage from './meri-memory-signed-page-source.js';
import * as proofIssuer from './meri-memory-proof-issuer.js';
import * as requestControl from '../meri-tool-request-control.js';
import * as toolAllowlist from '../meri-tool-allowlist.js';

const delegationId = '99999999-9999-4999-8999-999999999999';
const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const sha = 'a'.repeat(64);
const pagePath = '/api/clio/tools/search_memory';
const proposalPath = '/api/clio/tools/memory.list_own_proposals';
const helperPath = '/api/clio/tools/search_memory_eligibility';

function req(path: string, authorization = 'CapiroMeriRead a.b.c'): Request {
  return { method: 'POST', path, originalUrl: path, url: path, headers: { authorization } } as Request;
}

function toolTokenBody(id: 'search_memory' | 'memory.list_own_proposals') {
  return { schemaVersion: 1, kind: 'tool', callKey: 'call_1', method: 'POST',
    path: `/api/clio/tools/${id}`, bodySha256: sha,
    operation: { id, version: '0.2.0' }, argumentsSha256: sha,
    toolRequestSha256: null, referenceSha256: null, correlationSha256: sha, retryOf: null };
}

function bareMeriController(): MeriController {
  const controller = Object.create(MeriController.prototype) as MeriController;
  (controller as unknown as { tools: unknown; readDelegationPrisma: unknown }).tools = {};
  (controller as unknown as { readDelegationPrisma: unknown }).readDelegationPrisma = {};
  return controller;
}

const ctx = { tenantId, userId: actorId } as TenantContext;

afterEach(() => { jest.restoreAllMocks(); });

describe('signed passive memory HTTP composition remains closed in source', () => {
  it('registers the fixed helper controller ahead of the dynamic tools route', () => {
    const controllers = Reflect.getMetadata('controllers', MeriModule) as Function[];
    expect(controllers.indexOf(MeriMemoryHelperController)).toBeGreaterThanOrEqual(0);
    expect(controllers.indexOf(MeriMemoryHelperController)).toBeLessThan(controllers.indexOf(MeriController));
    expect(Reflect.getMetadata('path', MeriMemoryHelperController)).toBe('clio/tools');
    expect(Reflect.getMetadata('path', MeriMemoryHelperController.prototype.eligibility)).toBe('search_memory_eligibility');
    expect(Reflect.getMetadata('path', MeriController.prototype.executeTool)).toBe('tools/:name');
  });
  it('refuses an ordinary tool-token mint before opening a Prisma transaction', async () => {
    const withSystem = jest.fn();
    const service = Object.create(ReadDelegationService.prototype) as ReadDelegationService;
    Object.assign(service, { signer: {}, prisma: { withSystem } });
    jest.spyOn(serviceIdentity, 'hasVerifiedToolServiceIdentity').mockReturnValue(true);
    for (const id of ['search_memory', 'memory.list_own_proposals'] as const) {
      await expect(service.issueToken(req(`/api/clio/application-authority/read-delegations/${delegationId}/tokens`, ''),
        delegationId, toolTokenBody(id))).rejects.toBeInstanceOf(ServiceUnavailableException);
    }
    expect(withSystem).not.toHaveBeenCalled();
    expect(gate.signedMemoryPageEnabled()).toBe(false);
    expect(gate.signedMemoryProposalEnabled()).toBe(false);
  });

  it('refuses exact signed page, proposal and helper targets before ordinary token consumption', async () => {
    const middleware = Object.create(TenantContextMiddleware.prototype) as TenantContextMiddleware;
    const admit = jest.fn();
    Object.assign(middleware, { useMeriReadDelegation: admit });
    const response = { setHeader: jest.fn() } as unknown as Response;
    const next = jest.fn();
    for (const path of [pagePath, proposalPath, helperPath]) {
      await expect(middleware.use(req(path), response, next)).rejects.toBeInstanceOf(ServiceUnavailableException);
    }
    expect(admit).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('keeps helper issuance and the fixed callback at 503 before touching their owners', () => {
    const delegations = { issueToken: jest.fn() };
    const prisma = {};
    const issue = jest.spyOn(helperSource, 'issueMemoryHelperToken');
    const consume = jest.spyOn(helperReceiver, 'consumeTaskBoundMemoryHelper');
    const tokens = new ReadDelegationController(delegations as never, prisma as never, {} as never);
    const helper = new MeriMemoryHelperController(prisma as never);
    expect(() => tokens.tokens(req(`/api/clio/application-authority/read-delegations/${delegationId}/tokens`, ''),
      delegationId, { kind: 'memory_eligibility' })).toThrow(ServiceUnavailableException);
    expect(() => helper.eligibility(req(helperPath))).toThrow(ServiceUnavailableException);
    expect(issue).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(delegations.issueToken).not.toHaveBeenCalled();
  });

  it('keeps the exact signed search_memory branch at 503 before page SQL or signing', async () => {
    const controller = bareMeriController();
    const read = jest.spyOn(signedPage, 'readTaskBoundPassiveMemoryPage');
    const sign = jest.spyOn(proofIssuer, 'issueMemoryPageProof');
    await expect(controller.executeTool(ctx, 'search_memory', {}, req(pagePath)))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(read).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  });

  it('keeps a normal Bearer search_memory request on the existing tool route', async () => {
    const controller = bareMeriController();
    const marker = new Error('ordinary tool allowlist reached');
    const allowed = jest.spyOn(toolAllowlist, 'assertMeriToolAllowed').mockImplementation(() => { throw marker; });
    const read = jest.spyOn(signedPage, 'readTaskBoundPassiveMemoryPage');
    await expect(controller.executeTool(ctx, 'search_memory', {}, req(pagePath, 'Bearer clerk-session')))
      .rejects.toBe(marker);
    expect(allowed).toHaveBeenCalledWith('search_memory');
    expect(read).not.toHaveBeenCalled();
  });

  it('would emit only the unchanged result and opaque proof header when separately activated', async () => {
    // This tests composition, not activation: the production gate still
    // returns false, and no request or environment variable can enable it.
    jest.spyOn(gate, 'signedMemoryPageEnabled').mockReturnValue(true);
    jest.spyOn(serviceIdentity, 'hasVerifiedToolServiceIdentity').mockReturnValue(true);
    const grant = { kind: 'tool', operation: { id: 'search_memory', version: '0.2.0' } };
    jest.spyOn(delegationRequest, 'meriReadDelegationOf').mockReturnValue(grant as never);
    jest.spyOn(delegationRequest, 'meriRetainedCorrelationOf').mockReturnValue({ binding: 'test' });
    // The KMS module re-exports this as a nonconfigurable getter; spy on its
    // original owner so both the controller and provider see the same mock.
    jest.spyOn(keyConfig, 'readCoreEd25519KeyConfig').mockReturnValue({} as never);
    jest.spyOn(signerConfig, 'createCoreKmsSigner').mockReturnValue({} as never);
    jest.spyOn(requestControl, 'withMeriToolRequestControl').mockImplementation(async (_request, run) => run());
    const result = { schemaVersion: '0.2', memories: [] };
    const page = { result, deadlineMs: 12345 };
    const read = jest.spyOn(signedPage, 'readTaskBoundPassiveMemoryPage').mockResolvedValue(page as never);
    const sign = jest.spyOn(proofIssuer, 'issueMemoryPageProof').mockResolvedValue({
      result, pageProof: 'opaque.signed.proof',
    } as never);
    const response = { setHeader: jest.fn() } as unknown as Response;
    const controller = bareMeriController();
    await expect(controller.executeTool(ctx, 'search_memory', {}, req(pagePath), response)).resolves.toBe(result);
    expect(response.setHeader).toHaveBeenCalledWith('x-meri-memory-page-proof', 'opaque.signed.proof');
    expect(read).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(gate.signedMemoryPageEnabled()).toBe(true);
  });
});
