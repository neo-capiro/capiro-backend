/**
 * Lane A1 — managed catalog controller availability proof (provider-free).
 *
 * Proves the REAL guarded `MeriV3SettingsController.managedMcpSchemas` method
 * emits the additive `{ schemas, availability }` response and passes the
 * sanitized availability through verbatim. It does NOT re-implement request
 * identity: the existing V3 canary gate (`assertEnabled` -> 404) remains the
 * only enabled/identity boundary and is exercised here; request identity is
 * qualified separately by meri-v3-internal-service.guard.spec.ts.
 *
 * No alternate API, no fabricated auth success: the controller returns exactly
 * what the managed owner produced, and the failure states it emits are the
 * bounded owner codes.
 */
import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { MeriV3SettingsController } from './meriv3-settings.controller.js';
import type { MeriV3ManagedCatalogResult } from './meri-managed-mcp.service.js';

const ctx = {
  tenantId: 'tenant-1',
  tenantSlug: 'capiro-internal',
  userId: 'user-1',
  clerkUserId: 'clerk-1',
  role: 'standard_user',
} as TenantContext;

function make(ownerResult: MeriV3ManagedCatalogResult, options?: { enabled?: boolean }) {
  const prisma = { withTenant: jest.fn() };
  const flags = {
    isMeriV3ChatEnabled: jest.fn(async () => options?.enabled ?? true),
  };
  const managedMcp = {
    listApps: jest.fn(async () => []),
    connect: jest.fn(),
    disconnect: jest.fn(),
    schemasForMeriV3: jest.fn(async () => ownerResult.schemas),
    managedCatalogForMeriV3: jest.fn(async () => ownerResult),
    executeRead: jest.fn(),
  };
  const visualAnalysis = {
    isAvailable: jest.fn(async () => true),
    run: jest.fn(),
    discardUnreleasedArtifacts: jest.fn(),
  };
  return {
    controller: new MeriV3SettingsController(
      prisma as never,
      flags as never,
      managedMcp as never,
      visualAnalysis as never,
    ),
    flags,
    managedMcp,
  };
}

describe('MeriV3SettingsController managed catalog availability', () => {
  test('emits the owner result verbatim, with the V3 gate checked for this tenant', async () => {
    const ownerResult: MeriV3ManagedCatalogResult = {
      schemas: [
        {
          name: 'mcp__meriv3_airtable__list_bases',
          description: 'List bases',
          input_schema: { type: 'object', properties: {} },
          source: 'managed_mcp',
          appId: 'airtable',
          appName: 'Airtable',
          readOnly: true,
        },
      ],
      availability: {
        state: 'partial',
        complete: false,
        registryUnavailable: false,
        failures: [{ appId: 'google-drive', name: 'Google Drive', reason: 'unavailable' }],
      },
    };
    const { controller, flags, managedMcp } = make(ownerResult);

    await expect(controller.managedMcpSchemas(ctx)).resolves.toEqual(ownerResult);
    expect(managedMcp.managedCatalogForMeriV3).toHaveBeenCalledWith(ctx);
    expect(flags.isMeriV3ChatEnabled).toHaveBeenCalledWith(ctx.tenantId);
  });

  test('an outage availability is surfaced truthfully — never coerced to a successful empty', async () => {
    const ownerResult: MeriV3ManagedCatalogResult = {
      schemas: [],
      availability: {
        state: 'unavailable',
        complete: false,
        registryUnavailable: false,
        failures: [{ appId: 'airtable', name: 'Airtable', reason: 'needs_reauth' }],
      },
    };
    const { controller } = make(ownerResult);

    const response = await controller.managedMcpSchemas(ctx);
    expect(response.availability.state).toBe('unavailable');
    expect(response.availability.complete).toBe(false);
    expect(JSON.stringify(response)).not.toContain('ok');
  });

  test('the V3 canary gate fails closed before any managed catalog read', async () => {
    const ownerResult: MeriV3ManagedCatalogResult = {
      schemas: [],
      availability: {
        state: 'ok',
        complete: true,
        registryUnavailable: false,
        failures: [],
      },
    };
    const { controller, managedMcp } = make(ownerResult, { enabled: false });

    await expect(controller.managedMcpSchemas(ctx)).rejects.toBeInstanceOf(NotFoundException);
    expect(managedMcp.managedCatalogForMeriV3).not.toHaveBeenCalled();
  });
});
