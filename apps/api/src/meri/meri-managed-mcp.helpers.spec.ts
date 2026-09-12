import {
  MANAGED_MCP_APPS, MERIV3_MANAGED_APP_IDS,
  filterManagedReadOnlyTools, isManagedReadOnlyTool,
  managedAppConfigured, managedAppIdFromCatalogId, managedCatalogId,
} from './meri-managed-mcp.helpers.js';

describe('managed MCP read-only boundary', () => {
  test.each(MERIV3_MANAGED_APP_IDS)('%s is isolated from legacy catalog connections', (id) => {
    expect(managedAppIdFromCatalogId(managedCatalogId(id))).toBe(id);
    expect(managedAppIdFromCatalogId(id)).toBeNull();
    for (const tool of ['execute', 'execute_api', 'all_monday_api', 'create_record', 'update_deal', 'get_arbitrary_api', 'unknown_read_tool']) {
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
    for (const tool of ['query_crm', 'read_note', 'fetch_campaign', 'lookup_contact', 'describe_object']) {
      expect(isManagedReadOnlyTool('hubspot', tool)).toBe(false);
    }
  });

  test('explicit read-only scopes and Google offline authorization are server owned', () => {
    expect(MANAGED_MCP_APPS.airtable.oauthScopes).toEqual([
      'data.records:read', 'schema.bases:read', 'data.recordComments:read', 'workspacesAndBases:read',
    ]);
    expect(MANAGED_MCP_APPS['google-drive'].oauthScopes).toEqual(['https://www.googleapis.com/auth/drive.readonly']);
    expect(MANAGED_MCP_APPS['google-drive'].offlineAccess).toBe(true);
    expect(MANAGED_MCP_APPS.hubspot.oauthScopes).toBeUndefined();
  });

  test('new providers require operator enablement and confidential clients require both credentials', () => {
    expect(managedAppConfigured('airtable', {})).toBe(true);
    expect(managedAppConfigured('monday', {})).toBe(false);
    expect(managedAppConfigured('monday', { MERI_MCP_MONDAY_ENABLED: 'true' })).toBe(true);
    expect(managedAppConfigured('hubspot', { MERI_MCP_HUBSPOT_CLIENT_ID: 'id' })).toBe(false);
    expect(managedAppConfigured('google-drive', {
      MERI_MCP_GOOGLE_DRIVE_ENABLED: 'true',
      MERI_MCP_GOOGLE_DRIVE_CLIENT_ID: 'id',
      MERI_MCP_GOOGLE_DRIVE_CLIENT_SECRET: 'secret',
    })).toBe(true);
  });
});
