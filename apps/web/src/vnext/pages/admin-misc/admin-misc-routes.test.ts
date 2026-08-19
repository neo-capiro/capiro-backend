import { describe, expect, it } from 'vitest';
import { isVNextAdminMiscPath } from './admin-misc-routes.js';

describe('isVNextAdminMiscPath', () => {
  it('claims exactly the six admin+misc paths', () => {
    expect(isVNextAdminMiscPath('/admin/analyst-console')).toBe(true);
    expect(isVNextAdminMiscPath('/admin/program-element/reconciliation')).toBe(true);
    expect(isVNextAdminMiscPath('/admin/program-element/match-queue')).toBe(true);
    expect(isVNextAdminMiscPath('/actions')).toBe(true);
    expect(isVNextAdminMiscPath('/reviews')).toBe(true);
    expect(isVNextAdminMiscPath('/help')).toBe(true);
  });

  it('tolerates a single trailing slash (Route-style matching)', () => {
    expect(isVNextAdminMiscPath('/actions/')).toBe(true);
    expect(isVNextAdminMiscPath('/admin/analyst-console/')).toBe(true);
  });

  it('does NOT claim the canonical /admin, /admin/* and /capiro-admin redirects', () => {
    // These are canonical <Navigate>s into /settings — claiming them would
    // break the back-compat redirects for every other admin URL.
    expect(isVNextAdminMiscPath('/admin')).toBe(false);
    expect(isVNextAdminMiscPath('/admin/')).toBe(false);
    expect(isVNextAdminMiscPath('/admin/team')).toBe(false);
    expect(isVNextAdminMiscPath('/admin/program-element')).toBe(false);
    expect(isVNextAdminMiscPath('/admin/program-element/other')).toBe(false);
    expect(isVNextAdminMiscPath('/capiro-admin')).toBe(false);
    expect(isVNextAdminMiscPath('/portal/anything')).toBe(false);
  });

  it('does not prefix-match deeper or partial paths', () => {
    expect(isVNextAdminMiscPath('/actions/123')).toBe(false);
    expect(isVNextAdminMiscPath('/reviews/abc')).toBe(false);
    expect(isVNextAdminMiscPath('/helpdesk')).toBe(false);
    expect(isVNextAdminMiscPath('/nonexistent-path-xyz')).toBe(false);
  });
});
