import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import { MeriController, parseInvokeScope } from './meri.controller';
import type { MeriRegistryService } from './meri-registry.service';
import type { MeriContextResolver } from './meri-context.resolver';
import type { OrchestratorTenantContext } from '../auth/tenant-context';

/**
 * The generic tool-invoke route used to call `resolve(tc)` with no client and no
 * surface, so no directly-invoked tool could ever receive client steering —
 * which is how the post-hearing brief stayed client-blind while promising
 * client-specific risks. These pin that the optional scope is threaded through
 * verbatim, and that its absence is exactly the previous call.
 */
const CLIENT_ID = '3f2b9c4e-8d1a-4b6f-9e2c-1a2b3c4d5e6f';

const tc = { tenantId: 't1', clerkUserId: 'cu1', role: 'standard_user' } as OrchestratorTenantContext;
const req = { headers: {} } as unknown as Request;

function makeController() {
  const invoke = jest.fn().mockResolvedValue({ ok: true });
  const resolve = jest.fn().mockResolvedValue({ tenantId: 't1', userId: 'u1' });
  const registryService = { registry: { invoke } } as unknown as MeriRegistryService;
  const resolver = { resolve } as unknown as MeriContextResolver;
  return { controller: new MeriController(registryService, resolver), invoke, resolve };
}

describe('parseInvokeScope', () => {
  it('returns an empty scope for a body with no scope fields', () => {
    expect(parseInvokeScope({ input: { a: 1 } })).toEqual({});
    expect(parseInvokeScope(undefined)).toEqual({});
    expect(parseInvokeScope({ clientId: null, surface: null })).toEqual({});
  });

  it('accepts a UUID clientId and a known surface', () => {
    expect(parseInvokeScope({ clientId: CLIENT_ID, surface: 'memo' })).toEqual({
      clientId: CLIENT_ID,
      surface: 'memo',
    });
  });

  it('rejects a non-UUID clientId and an unknown surface as 400s, never a silent default', () => {
    expect(() => parseInvokeScope({ clientId: 'anduril' })).toThrow(BadRequestException);
    expect(() => parseInvokeScope({ clientId: 42 })).toThrow(BadRequestException);
    expect(() => parseInvokeScope({ surface: 'hearing-recap' })).toThrow(BadRequestException);
    expect(() => parseInvokeScope({ surface: 7 })).toThrow(BadRequestException);
  });
});

describe('MeriController.invoke — context scope pass-through', () => {
  it('without scope fields resolves exactly as before (no client, default surface)', async () => {
    const { controller, invoke, resolve } = makeController();
    await controller.invoke('some_tool', { input: { a: 1 } }, tc, req);
    expect(resolve).toHaveBeenCalledWith(tc, undefined, undefined);
    expect(invoke).toHaveBeenCalledWith('some_tool', { a: 1 }, { tenantId: 't1', userId: 'u1' });
  });

  it('threads clientId + surface into resolve so client steering is compiled for the tool', async () => {
    const { controller, invoke, resolve } = makeController();
    const out = await controller.invoke(
      'generate_post_hearing_summary',
      { input: { sessionId: 's1' }, clientId: CLIENT_ID, surface: 'memo' },
      tc,
      req,
    );
    expect(resolve).toHaveBeenCalledWith(tc, CLIENT_ID, 'memo');
    // Scope fields are transport, not tool input — the tool sees only `input`.
    expect(invoke).toHaveBeenCalledWith(
      'generate_post_hearing_summary',
      { sessionId: 's1' },
      { tenantId: 't1', userId: 'u1' },
    );
    expect(out).toEqual({ tool: 'generate_post_hearing_summary', result: { ok: true } });
  });

  it('a malformed scope is rejected before any context is resolved', async () => {
    const { controller, invoke, resolve } = makeController();
    await expect(
      controller.invoke('some_tool', { input: {}, clientId: 'not-a-uuid' }, tc, req),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(resolve).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
