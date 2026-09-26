import { ForbiddenException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants.js';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { TenantContext, TenantRole } from '@capiro/shared';
import { ROLES_KEY } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { BusinessDevelopmentController } from './business-development.controller.js';
import { BusinessDevelopmentFlagGuard } from './business-development-flag.guard.js';
import { BusinessDevelopmentDossierFlagGuard } from './bizdev-dossier.flag.guard.js';
import { BusinessDevelopmentBriefFlagGuard } from './bizdev-brief.flag.guard.js';
import { BusinessDevelopmentClaimValidationFlagGuard } from './bizdev-claim-validation.flag.guard.js';

/**
 * Role authorization contract: route metadata (which routes demand what) plus
 * the REAL RolesGuard deciding allow/deny from that metadata. standard_user
 * can read/work prospects; only user_admin / capiro_admin may write conflict
 * state or firm preferences; unknown/missing roles fail closed.
 */

const reqWithRole = (role: TenantRole | undefined): Request & { tenantContext?: TenantContext } => {
  const ctx =
    role === undefined ? undefined : ({ tenantId: 't1', userId: 'u1', role } as TenantContext);
  return { tenantContext: ctx } as Request & { tenantContext?: TenantContext };
};

const handlerFor = (name: string) => {
  const c = BusinessDevelopmentController.prototype as unknown as Record<string, unknown>;
  const fn = c[name];
  expect(typeof fn).toBe('function');
  return fn as () => unknown;
};

/** Resolve the effective @Roles requirement for a handler (handler overrides class). */
const requiredRolesFor = (name: string): TenantRole[] | undefined => {
  const reflector = new Reflector();
  const handler = handlerFor(name);
  const own = Reflect.getMetadata(ROLES_KEY, handler) as TenantRole[] | undefined;
  if (own) return own;
  return Reflect.getMetadata(ROLES_KEY, BusinessDevelopmentController) as TenantRole[] | undefined;
};

const guardAllows = (handlerName: string, role: TenantRole | undefined): boolean => {
  const guard = new RolesGuard(new Reflector());
  // Minimal ExecutionContext stub: getAllAndOverride reads metadata from
  // handler + class, and the request carries the tenant context.
  const context = {
    switchToHttp: () => ({ getRequest: () => reqWithRole(role) }),
    getHandler: () => handlerFor(handlerName),
    getClass: () => BusinessDevelopmentController,
  } as never;
  return guard.canActivate(context);
};

describe('route role metadata', () => {
  test('controller path composes once with the application /api global prefix', () => {
    expect(Reflect.getMetadata(PATH_METADATA, BusinessDevelopmentController)).toBe(
      'business-development',
    );
  });

  test('controller-level floor is standard_user and above', () => {
    expect(requiredRolesFor('list')).toEqual(['standard_user', 'user_admin', 'capiro_admin']);
  });

  test('member routes inherit the standard_user floor', () => {
    for (const route of [
      'list',
      'get',
      'create',
      'previewDuplicateHints',
      'update',
      'addNote',
      'history',
      'dismiss',
      'restore',
      'convert',
      'resolveIdentity',
      'duplicateHints',
      'getPreferences',
      'memberOptions',
      'searchCanonical',
      'searchClients',
    ]) {
      expect(requiredRolesFor(route)).toEqual(['standard_user', 'user_admin', 'capiro_admin']);
    }
  });

  test('conflict write is admin-only', () => {
    expect(requiredRolesFor('updateConflict')).toEqual(['user_admin', 'capiro_admin']);
  });

  test('preferences write is admin-only', () => {
    expect(requiredRolesFor('savePreferences')).toEqual(['user_admin', 'capiro_admin']);
  });
});

describe('real RolesGuard decisions', () => {
  test('standard_user: reads + ordinary workflow allowed', () => {
    for (const route of [
      'list',
      'get',
      'create',
      'previewDuplicateHints',
      'update',
      'addNote',
      'history',
      'dismiss',
      'restore',
      'convert',
      'resolveIdentity',
    ]) {
      expect(guardAllows(route, 'standard_user')).toBe(true);
    }
  });

  test('standard_user: admin-only writes denied', () => {
    for (const route of ['updateConflict', 'savePreferences']) {
      let denied = false;
      try {
        guardAllows(route, 'standard_user');
      } catch {
        denied = true;
      }
      expect(denied).toBe(true);
    }
  });

  test('user_admin passes admin-only routes', () => {
    expect(guardAllows('updateConflict', 'user_admin')).toBe(true);
    expect(guardAllows('savePreferences', 'user_admin')).toBe(true);
  });

  test('capiro_admin (rank above user_admin) passes admin-only routes', () => {
    expect(guardAllows('updateConflict', 'capiro_admin')).toBe(true);
  });

  test('unrecognized role fails closed', () => {
    expect(() => guardAllows('list', 'client_portal_user')).toThrow(ForbiddenException);
    expect(() => guardAllows('updateConflict', 'client_portal_user')).toThrow(ForbiddenException);
  });

  test('missing tenant context fails closed', () => {
    expect(() => guardAllows('list', undefined)).toThrow(ForbiddenException);
  });

  test('denials are ForbiddenException with actionable messages', () => {
    let thrown: unknown;
    try {
      guardAllows('updateConflict', 'standard_user');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ForbiddenException);
    expect((thrown as ForbiddenException).message).toContain('standard_user');
  });
});

// ── Phase 2 — dossier surface routes ───────────────────────────────────────

describe('Phase 2 dossier route contract', () => {
  /** Resolve the effective guard list for a handler: Nest composes
   * [...global, ...class, ...method] (ContextCreator.createContext), so a
   * method-level @UseGuards ADDS to the class-level guards. */
  const guardsFor = (name: string): Array<unknown> => {
    const handler = handlerFor(name);
    const classGuards = (Reflect.getMetadata(GUARDS_METADATA, BusinessDevelopmentController) ??
      []) as Array<unknown>;
    const methodGuards = (Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as Array<unknown>;
    return [...classGuards, ...methodGuards];
  };

  const PHASE2_ROUTES = ['searchCandidates', 'companyDossier', 'prospectDossier'] as const;

  test('all three new routes exist and inherit the standard_user role floor', () => {
    for (const route of PHASE2_ROUTES) {
      expect(requiredRolesFor(route)).toEqual(['standard_user', 'user_admin', 'capiro_admin']);
    }
  });

  test('each dossier route carries RolesGuard + Phase 1 flag guard + dossier guard', () => {
    for (const route of PHASE2_ROUTES) {
      const guards = guardsFor(route);
      expect(guards).toContain(RolesGuard);
      expect(guards).toContain(BusinessDevelopmentFlagGuard);
      expect(guards).toContain(BusinessDevelopmentDossierFlagGuard);
    }
  });

  test('standard_user passes the role floor on the dossier routes (guard metadata + real RolesGuard)', () => {
    for (const route of PHASE2_ROUTES) {
      expect(guardAllows(route, 'standard_user')).toBe(true);
    }
  });

  test('Phase 1 routes do NOT carry the extra dossier guard', () => {
    for (const route of ['list', 'get', 'create', 'update', 'convert', 'resolveIdentity']) {
      expect(guardsFor(route)).not.toContain(BusinessDevelopmentDossierFlagGuard);
    }
  });

  test('Phase 1 route set is intact (no regressions or renames)', () => {
    for (const route of [
      'list',
      'get',
      'create',
      'previewDuplicateHints',
      'duplicateHints',
      'update',
      'addNote',
      'history',
      'updateConflict',
      'dismiss',
      'restore',
      'convert',
      'resolveIdentity',
      'getPreferences',
      'savePreferences',
      'memberOptions',
      'searchCanonical',
      'searchClients',
    ]) {
      expect(typeof handlerFor(route)).toBe('function');
    }
    expect(requiredRolesFor('updateConflict')).toEqual(['user_admin', 'capiro_admin']);
    expect(requiredRolesFor('savePreferences')).toEqual(['user_admin', 'capiro_admin']);
  });
});

describe('Phase 4 brief route contract', () => {
  const guardsFor = (name: string): Array<unknown> => {
    const handler = handlerFor(name);
    const classGuards = (Reflect.getMetadata(GUARDS_METADATA, BusinessDevelopmentController) ??
      []) as Array<unknown>;
    const methodGuards = (Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as Array<unknown>;
    return [...classGuards, ...methodGuards];
  };

  const PHASE4_ROUTES = [
    'getCurrentBrief',
    'createBriefVersion',
    'saveBriefVersion',
    'buildRefreshProposal',
    'acceptRefreshProposal',
    'listBriefVersions',
    'getBriefVersion',
    'resolveBriefCitation',
    'checkBriefClaim',
  ] as const;

  test('all brief routes inherit the member role floor', () => {
    for (const route of PHASE4_ROUTES) {
      expect(requiredRolesFor(route)).toEqual(['standard_user', 'user_admin', 'capiro_admin']);
      expect(guardAllows(route, 'standard_user')).toBe(true);
    }
  });

  test('all brief routes compose role, Phase 1, and brief feature guards', () => {
    for (const route of PHASE4_ROUTES) {
      const guards = guardsFor(route);
      expect(guards).toContain(RolesGuard);
      expect(guards).toContain(BusinessDevelopmentFlagGuard);
      expect(guards).toContain(BusinessDevelopmentBriefFlagGuard);
    }
  });

  test('only claim checking additionally requires the independent claim-validation flag', () => {
    expect(guardsFor('checkBriefClaim')).toContain(BusinessDevelopmentClaimValidationFlagGuard);
    for (const route of PHASE4_ROUTES.filter((route) => route !== 'checkBriefClaim')) {
      expect(guardsFor(route)).not.toContain(BusinessDevelopmentClaimValidationFlagGuard);
    }
  });

  test('older Phase 1 and Phase 2 routes do not acquire the brief guard', () => {
    for (const route of ['list', 'get', 'create', 'prospectDossier']) {
      expect(guardsFor(route)).not.toContain(BusinessDevelopmentBriefFlagGuard);
    }
  });
});
