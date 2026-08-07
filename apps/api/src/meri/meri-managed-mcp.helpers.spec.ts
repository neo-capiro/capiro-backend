import {
  AIRTABLE_READ_ONLY_TOOLS,
  MERIV3_AIRTABLE_CATALOG_ID,
  MERIV3_HUBSPOT_CATALOG_ID,
  filterManagedReadOnlyTools,
  isManagedReadOnlyTool,
  managedAppIdFromCatalogId,
  managedCatalogId,
} from './meri-managed-mcp.helpers.js';

describe('MeriV3 managed MCP read-only boundary', () => {
  test('maps only isolated managed connector ids, never legacy catalog rows', () => {
    expect(managedCatalogId('hubspot')).toBe(MERIV3_HUBSPOT_CATALOG_ID);
    expect(managedCatalogId('airtable')).toBe(MERIV3_AIRTABLE_CATALOG_ID);
    expect(managedAppIdFromCatalogId(MERIV3_HUBSPOT_CATALOG_ID)).toBe('hubspot');
    expect(managedAppIdFromCatalogId(MERIV3_AIRTABLE_CATALOG_ID)).toBe('airtable');
    expect(managedAppIdFromCatalogId('hubspot')).toBeNull();
    expect(managedAppIdFromCatalogId('sharepoint')).toBeNull();
  });

  test('Airtable is explicit allowlist only', () => {
    expect(AIRTABLE_READ_ONLY_TOOLS.has('search_records')).toBe(true);
    expect(isManagedReadOnlyTool('airtable', 'search_records')).toBe(true);
    expect(isManagedReadOnlyTool('airtable', 'list_bases')).toBe(true);
    expect(isManagedReadOnlyTool('airtable', 'create_record')).toBe(false);
    expect(isManagedReadOnlyTool('airtable', 'update_record')).toBe(false);
    expect(isManagedReadOnlyTool('airtable', 'mystery_read')).toBe(false);
  });

  test('HubSpot permits conservative read shapes and blocks mutation shapes', () => {
    for (const name of [
      'get_user_details',
      'get_deal',
      'list_contacts',
      'search_companies',
      'read_note',
      'fetch_campaign',
      'query_crm',
      'lookup_contact',
      'describe_object',
    ]) {
      expect(isManagedReadOnlyTool('hubspot', name)).toBe(true);
    }
    for (const name of [
      'create_contact',
      'update_deal',
      'delete_note',
      'archive_contact',
      'publish_email',
      'send_email',
      'associate_records',
      'set_property',
      'execute_workflow',
      'unknown_tool',
    ]) {
      expect(isManagedReadOnlyTool('hubspot', name)).toBe(false);
    }
  });

  test('filter dedupes and never carries a write through', () => {
    expect(
      filterManagedReadOnlyTools('hubspot', [
        'get_user_details',
        'get_user_details',
        'search_contacts',
        'create_contact',
      ]),
    ).toEqual(['get_user_details', 'search_contacts']);
  });
});
