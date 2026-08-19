import { describe, expect, it } from 'vitest';
import { isVNextSettingsPath } from './settings-route.js';

describe('isVNextSettingsPath', () => {
  it('claims the /settings index and every sub-path', () => {
    expect(isVNextSettingsPath('/settings')).toBe(true);
    expect(isVNextSettingsPath('/settings/personal')).toBe(true);
    expect(isVNextSettingsPath('/settings/contact')).toBe(true);
    expect(isVNextSettingsPath('/settings/memory')).toBe(true);
    expect(isVNextSettingsPath('/settings/team')).toBe(true);
    expect(isVNextSettingsPath('/settings/branding')).toBe(true);
    expect(isVNextSettingsPath('/settings/clients')).toBe(true);
    expect(isVNextSettingsPath('/settings/integrations')).toBe(true);
    expect(isVNextSettingsPath('/settings/billing')).toBe(true);
    expect(isVNextSettingsPath('/settings/customers')).toBe(true);
    expect(isVNextSettingsPath('/settings/ai-usage')).toBe(true);
    expect(isVNextSettingsPath('/settings/intelligence-mappings')).toBe(true);
    expect(isVNextSettingsPath('/settings/skills')).toBe(true);
    expect(isVNextSettingsPath('/settings/tenants')).toBe(true);
    // Unknown sub-paths are still claimed (the module renders the canonical
    // 404 copy for them, matching the canonical tree's resolution).
    expect(isVNextSettingsPath('/settings/does-not-exist')).toBe(true);
  });

  it('does NOT claim non-settings paths — /admin and /capiro-admin stay canonical redirects', () => {
    expect(isVNextSettingsPath('/')).toBe(false);
    expect(isVNextSettingsPath('/settingsx')).toBe(false);
    // These are canonical <Navigate>s in App.tsx that land on /settings/... —
    // the redirect itself must fall through to canonical.
    expect(isVNextSettingsPath('/admin')).toBe(false);
    expect(isVNextSettingsPath('/admin/analyst-console')).toBe(false);
    expect(isVNextSettingsPath('/capiro-admin')).toBe(false);
    expect(isVNextSettingsPath('/engagement/meetings')).toBe(false);
  });
});
