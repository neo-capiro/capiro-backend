import { describe, expect, jest, test } from '@jest/globals';
import 'reflect-metadata';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { TenantContext, TenantRole } from '@capiro/shared';
import { RolesGuard } from '../auth/roles.guard.js';
import { DistrictNexusFlagGuard } from './district-nexus-flag.guard.js';
import { DistrictNexusRelationshipsController } from './district-nexus-relationships.controller.js';

/**
 * Authorization contract for the reviewed-grant-relationship surface.
 *
 * These rows carry federal award dollars into a client's district nexus and
 * into external-use materials, so the read/write split is a security boundary,
 * not a UI preference: a standard user may READ the evidence but must not
 * create, edit, verify, approve, reject, or delete it.
 *
 * The test drives the REAL RolesGuard against the REAL decorator metadata
 * rather than snapshotting the metadata alone. A metadata assertion would still
 * pass if `getAllAndOverride`'s handler-over-class precedence ever changed, and
 * that precedence is the only thing making the method-level `@Roles('user_admin')`
 * win over the controller-level `@Roles('standard_user')`. If it inverted, every
 * mutation would silently fall back to standard_user.
 */

const BASE_CTX: TenantContext = {
  tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  tenantSlug: 'alpha',
  userId: 'user-1',
  clerkUserId: 'clerk-1',
  role: 'standard_user',
};

type Handler = (...args: never[]) => unknown;

function executionContext(handler: Handler, role: TenantRole): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => DistrictNexusRelationshipsController,
    switchToHttp: () => ({
      getRequest: () => ({ tenantContext: { ...BASE_CTX, role } }),
    }),
  } as unknown as ExecutionContext;
}

function allows(handler: Handler, role: TenantRole): boolean {
  const guard = new RolesGuard(new Reflector());
  try {
    return guard.canActivate(executionContext(handler, role));
  } catch (error) {
    if (error instanceof ForbiddenException) return false;
    throw error;
  }
}

const proto = DistrictNexusRelationshipsController.prototype;

const READS: Array<[string, Handler]> = [
  ['list', proto.list as Handler],
  ['searchAwards', proto.searchAwards as Handler],
];

const MUTATIONS: Array<[string, Handler]> = [
  ['create', proto.create as Handler],
  ['update', proto.update as Handler],
  ['reject', proto.reject as Handler],
];

describe('DistrictNexusRelationshipsController authorization', () => {
  test.each(READS)('%s is readable by a standard user', (_name, handler) => {
    expect(allows(handler, 'standard_user')).toBe(true);
    expect(allows(handler, 'user_admin')).toBe(true);
    expect(allows(handler, 'capiro_admin')).toBe(true);
  });

  test.each(READS)('%s is NOT readable by a client-portal user', (_name, handler) => {
    expect(allows(handler, 'client_portal_user')).toBe(false);
  });

  test.each(MUTATIONS)(
    '%s is refused to a standard user — reads do not imply writes',
    (_name, handler) => {
      expect(allows(handler, 'standard_user')).toBe(false);
      expect(allows(handler, 'client_portal_user')).toBe(false);
    },
  );

  test.each(MUTATIONS)('%s is allowed for user_admin and capiro_admin', (_name, handler) => {
    expect(allows(handler, 'user_admin')).toBe(true);
    expect(allows(handler, 'capiro_admin')).toBe(true);
  });

  test('an unrecognised role is refused everywhere, including reads', () => {
    for (const [, handler] of [...READS, ...MUTATIONS]) {
      expect(allows(handler, 'not_a_real_role' as TenantRole)).toBe(false);
    }
  });

  test('the feature gate is mounted alongside the role gate', () => {
    // Without DistrictNexusFlagGuard a disabled tenant would reach the service
    // and get real data; without RolesGuard the @Roles metadata is inert.
    const guards = Reflect.getMetadata(
      '__guards__',
      DistrictNexusRelationshipsController,
    ) as unknown[];
    expect(guards).toContain(RolesGuard);
    expect(guards).toContain(DistrictNexusFlagGuard);
  });
});

describe('DistrictNexusRelationshipsController tenant/actor propagation', () => {
  function makeController() {
    const relationships = {
      list: jest.fn(async () => ({ relationships: [], facilities: [] })),
      searchAwards: jest.fn(async () => []),
      // Argument types declared so `mock.calls[n][i]` is indexable — a
      // zero-arg jest.fn() infers `never[]` call tuples.
      create: jest.fn(
        async (
          _tenantId: string,
          _clientId: string,
          _actor: { userId: string; role: TenantRole },
          _input: unknown,
        ) => ({ id: 'rel-1' }),
      ),
      update: jest.fn(async () => ({ id: 'rel-1' })),
      reject: jest.fn(async () => ({ id: 'rel-1', verificationStatus: 'rejected' as const })),
    };
    const controller = new DistrictNexusRelationshipsController(relationships as never);
    return { controller, relationships };
  }

  const ADMIN_CTX: TenantContext = { ...BASE_CTX, role: 'user_admin' };

  test('every handler passes the caller tenant from context, never a body or param value', async () => {
    const { controller, relationships } = makeController();

    await controller.list(ADMIN_CTX, 'client-9');
    expect(relationships.list).toHaveBeenCalledWith(ADMIN_CTX.tenantId, 'client-9');

    await controller.create(ADMIN_CTX, 'client-9', {
      assistanceAwardId: 'award-1',
      relationshipType: 'subrecipient',
    });
    expect(relationships.create).toHaveBeenCalledWith(
      ADMIN_CTX.tenantId,
      'client-9',
      { userId: ADMIN_CTX.userId, role: 'user_admin' },
      expect.objectContaining({ assistanceAwardId: 'award-1' }),
    );

    await controller.update(ADMIN_CTX, 'client-9', 'rel-1', { verificationStatus: 'verified' });
    expect(relationships.update).toHaveBeenCalledWith(
      ADMIN_CTX.tenantId,
      'client-9',
      'rel-1',
      { userId: ADMIN_CTX.userId, role: 'user_admin' },
      expect.objectContaining({ verificationStatus: 'verified' }),
    );

    await controller.reject(ADMIN_CTX, 'client-9', 'rel-1');
    expect(relationships.reject).toHaveBeenCalledWith(ADMIN_CTX.tenantId, 'client-9', 'rel-1', {
      userId: ADMIN_CTX.userId,
      role: 'user_admin',
    });
  });

  test('the audited actor is the CALLER, not anything client-supplied', async () => {
    const { controller, relationships } = makeController();
    await controller.create({ ...ADMIN_CTX, userId: 'real-user' }, 'client-9', {
      assistanceAwardId: 'award-1',
      relationshipType: 'beneficiary',
      // A hostile body cannot smuggle an actor — the DTO has no such field and
      // the controller reads identity only from TenantContext.
    } as never);
    const actor = relationships.create.mock.calls[0]![2];
    expect(actor).toEqual({ userId: 'real-user', role: 'user_admin' });
  });
});
