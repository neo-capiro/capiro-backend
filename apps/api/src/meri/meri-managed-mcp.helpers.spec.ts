import {
  MANAGED_MCP_APPS,
  MERIV3_MANAGED_APP_IDS,
  filterManagedReadOnlyTools,
  isManagedReadOnlyTool,
  managedAppConfigured,
  managedAppAvailable,
  managedAppIdFromCatalogId,
  managedCatalogId,
} from './meri-managed-mcp.helpers.js';

describe('managed MCP read-only boundary', () => {
  test.each(MERIV3_MANAGED_APP_IDS)('%s is isolated from legacy catalog connections', (id) => {
    expect(managedAppIdFromCatalogId(managedCatalogId(id))).toBe(id);
    expect(managedAppIdFromCatalogId(id)).toBeNull();
    for (const tool of [
      'execute',
      'execute_api',
      'all_monday_api',
      'create_record',
      'update_deal',
      'get_arbitrary_api',
      'unknown_read_tool',
    ]) {
      expect(isManagedReadOnlyTool(id, tool)).toBe(false);
    }
  });

  test.each([
    ['hubspot', 'get_user_details'],
    ['airtable', 'list_bases'],
    ['monday', 'get_board_items_page'],
    ['google-drive', 'read_file_content'],
  ] as const)('%s permits reviewed reads only', (id, tool) => {
    expect(filterManagedReadOnlyTools(id, [tool, tool, 'execute_api', ' ' + tool])).toEqual([tool]);
  });

  test('HubSpot no longer trusts a tool because its name starts with a read verb', () => {
    for (const tool of [
      'query_crm',
      'read_note',
      'fetch_campaign',
      'lookup_contact',
      'describe_object',
    ]) {
      expect(isManagedReadOnlyTool('hubspot', tool)).toBe(false);
    }
  });

  test('explicit read-only scopes and Google offline authorization are server owned', () => {
    expect(MANAGED_MCP_APPS.airtable.oauthScopes).toEqual([
      'data.records:read',
      'schema.bases:read',
      'data.recordComments:read',
      'workspacesAndBases:read',
    ]);
    expect(MANAGED_MCP_APPS['google-drive'].oauthScopes).toEqual([
      'https://www.googleapis.com/auth/drive.readonly',
    ]);
    expect(MANAGED_MCP_APPS['google-drive'].offlineAccess).toBe(true);
    expect(MANAGED_MCP_APPS.hubspot.oauthScopes).toBeUndefined();
  });

  test('new providers require operator enablement and confidential clients require both credentials', () => {
    expect(managedAppConfigured('airtable', {})).toBe(true);
    expect(managedAppConfigured('monday', {})).toBe(false);
    expect(managedAppConfigured('monday', { MERI_MCP_MONDAY_ENABLED: 'true' })).toBe(true);
    expect(managedAppConfigured('hubspot', { MERI_MCP_HUBSPOT_CLIENT_ID: 'id' })).toBe(false);
    expect(
      managedAppConfigured('google-drive', {
        MERI_MCP_GOOGLE_DRIVE_ENABLED: 'true',
        MERI_MCP_GOOGLE_DRIVE_CLIENT_ID: 'id',
        MERI_MCP_GOOGLE_DRIVE_CLIENT_SECRET: 'secret',
      }),
    ).toBe(true);
  });
});

describe('Google Drive internal preview identities', () => {
  const env = {
    MERI_MCP_GOOGLE_DRIVE_ENABLED: 'true',
    MERI_MCP_GOOGLE_DRIVE_CLIENT_ID: 'id',
    MERI_MCP_GOOGLE_DRIVE_CLIENT_SECRET: 'secret',
    MERI_MCP_GOOGLE_DRIVE_ALLOWED_USER_IDS: ' owner , another-owner ',
    MERI_MCP_GOOGLE_DRIVE_ALLOWED_TENANT_IDS: ' internal ',
  };
  test('requires both an exact approved owner and an internal tenant', () => {
    expect(
      managedAppAvailable('google-drive', { userId: 'owner', tenantId: 'internal' }, env),
    ).toBe(true);
    for (const principal of [
      {},
      { userId: 'owner' },
      { tenantId: 'internal' },
      { userId: 'owner', tenantId: 'customer' },
      { userId: 'customer', tenantId: 'internal' },
      { userId: 'own', tenantId: 'internal' },
    ])
      expect(managedAppAvailable('google-drive', principal, env)).toBe(false);
  });
  test('missing lists, wildcard entries, and the global kill switch fail closed', () => {
    const principal = { userId: 'owner', tenantId: 'internal' };
    for (const override of [
      { MERI_MCP_GOOGLE_DRIVE_ALLOWED_USER_IDS: undefined },
      { MERI_MCP_GOOGLE_DRIVE_ALLOWED_TENANT_IDS: '' },
      { MERI_MCP_GOOGLE_DRIVE_ALLOWED_USER_IDS: '*' },
      { MERI_MCP_GOOGLE_DRIVE_ENABLED: 'false' },
      { MERI_MCP_GOOGLE_DRIVE_CLIENT_SECRET: '' },
    ])
      expect(managedAppAvailable('google-drive', principal, { ...env, ...override })).toBe(false);
    expect(managedAppAvailable('airtable', {}, {})).toBe(true);
  });
});
