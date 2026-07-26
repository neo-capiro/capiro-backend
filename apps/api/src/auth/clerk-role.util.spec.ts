import { isClerkOrgAdminRole } from '@capiro/shared';
import { CAPIRO_INTERNAL_SLUG, mapClerkRoleToCapiro } from './clerk-role.util.js';

/**
 * Regression guard for the substring-elevation bug.
 *
 * mapClerkRoleToCapiro previously tested `normalizedRole.includes('admin')`,
 * so ANY Clerk role containing that substring was elevated — to `user_admin`
 * for a customer tenant, and to cross-tenant `capiro_admin` inside the
 * reserved capiro-internal staff org. This function is the single mapper for
 * BOTH mirroring paths (the Clerk webhook and the tenant-context middleware
 * self-heal), so these cases cover both.
 */
describe('isClerkOrgAdminRole', () => {
  it.each(['org:admin', 'admin', 'ORG:ADMIN', 'Org:Admin', '  org:admin  ', 'administrator'])(
    'accepts the exact admin role %p',
    (role) => {
      expect(isClerkOrgAdminRole(role)).toBe(true);
    },
  );

  it.each([
    'org:member',
    'member',
    'org:admin_readonly',
    'org:admin-assistant',
    'org:not-admin',
    'org:viewer_admin',
    'org:billing-admin',
    'administrator_readonly',
    'superadmin',
    'org:superadmin',
  ])('rejects the substring-poison / non-admin role %p', (role) => {
    expect(isClerkOrgAdminRole(role)).toBe(false);
  });

  it.each([['' as string], [null], [undefined]])('fails closed on %p', (role) => {
    expect(isClerkOrgAdminRole(role as string | null | undefined)).toBe(false);
  });

  it('does NOT accept Capiro TenantRole strings (wrong vocabulary)', () => {
    // The old substring test returned true for both of these. Every call site
    // was audited to confirm it passes a raw CLERK role, not a TenantRole.
    expect(isClerkOrgAdminRole('user_admin')).toBe(false);
    expect(isClerkOrgAdminRole('capiro_admin')).toBe(false);
  });
});

describe('mapClerkRoleToCapiro', () => {
  describe('customer tenant', () => {
    it('maps the exact admin role to user_admin', () => {
      expect(mapClerkRoleToCapiro('acmelobby', 'org:admin')).toBe('user_admin');
      expect(mapClerkRoleToCapiro('acmelobby', 'admin')).toBe('user_admin');
      expect(mapClerkRoleToCapiro('acmelobby', 'ORG:ADMIN')).toBe('user_admin');
    });

    it('maps member to standard_user', () => {
      expect(mapClerkRoleToCapiro('acmelobby', 'org:member')).toBe('standard_user');
    });

    it.each([
      'org:admin_readonly',
      'org:admin-assistant',
      'org:not-admin',
      'org:viewer_admin',
      'org:billing-admin',
      '',
    ])('does NOT elevate the substring-poison role %p', (role) => {
      expect(mapClerkRoleToCapiro('acmelobby', role)).toBe('standard_user');
    });
  });

  describe('capiro-internal staff org', () => {
    it('maps the exact admin role to cross-tenant capiro_admin', () => {
      expect(mapClerkRoleToCapiro(CAPIRO_INTERNAL_SLUG, 'org:admin')).toBe('capiro_admin');
    });

    it('leaves ordinary staff members as standard_user', () => {
      expect(mapClerkRoleToCapiro(CAPIRO_INTERNAL_SLUG, 'org:member')).toBe('standard_user');
    });

    it.each(['org:admin_readonly', 'org:not-admin', 'org:billing-admin', ''])(
      'does NOT grant capiro_admin for the substring-poison role %p',
      (role) => {
        expect(mapClerkRoleToCapiro(CAPIRO_INTERNAL_SLUG, role)).toBe('standard_user');
      },
    );
  });

  it('anchors the capiro_admin grant on the ORG, not the role', () => {
    // A tenant that merely *contains* the internal slug must not be treated as
    // the staff org.
    expect(mapClerkRoleToCapiro('capiro-internal-clone', 'org:admin')).toBe('user_admin');
    expect(mapClerkRoleToCapiro('not-capiro-internal', 'org:admin')).toBe('user_admin');
  });
});
