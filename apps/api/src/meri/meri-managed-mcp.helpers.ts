export const MERIV3_MANAGED_APP_IDS = ['hubspot', 'airtable'] as const;
export type MeriV3ManagedAppId = (typeof MERIV3_MANAGED_APP_IDS)[number];

export const MERIV3_HUBSPOT_CATALOG_ID = 'meriv3-hubspot';
export const MERIV3_AIRTABLE_CATALOG_ID = 'meriv3-airtable';
export const MERIV3_HUBSPOT_ENDPOINT = 'https://mcp.hubspot.com';
export const MERIV3_AIRTABLE_ENDPOINT = 'https://mcp.airtable.com/mcp';

/**
 * Airtable's official remote MCP exposes both reads and writes. MeriV3's first
 * managed-app release is context-only, so this list deliberately contains
 * read/introspection tools only. Unknown tools fail closed until reviewed.
 */
export const AIRTABLE_READ_ONLY_TOOLS = new Set([
  'ping',
  'get_automation',
  'get_record_for_page',
  'get_table_schema',
  'list_automations',
  'list_bases',
  'list_external_accounts',
  'list_pages_for_base',
  'list_records_for_page',
  'list_views_for_table',
  'list_records_for_table',
  'list_tables_for_base',
  'list_workspaces',
  'search_records',
  'search_bases',
  'describe_page_element',
  'describe_page_type',
  'fetch_automation_input_data',
  'get_create_automation_instructions',
]);

const HUBSPOT_READ_PREFIX = /^(?:get|list|search|read|fetch|query|lookup|describe)_/i;
const MUTATING_PREFIX = /^(?:create|update|delete|archive|publish|send|associate|remove|add|set|execute|run|write|upsert)_/i;

export function managedCatalogId(appId: MeriV3ManagedAppId): string {
  return appId === 'hubspot' ? MERIV3_HUBSPOT_CATALOG_ID : MERIV3_AIRTABLE_CATALOG_ID;
}

export function managedAppIdFromCatalogId(
  catalogId: string | null | undefined,
): MeriV3ManagedAppId | null {
  if (catalogId === MERIV3_HUBSPOT_CATALOG_ID) return 'hubspot';
  if (catalogId === MERIV3_AIRTABLE_CATALOG_ID) return 'airtable';
  return null;
}

export function isManagedReadOnlyTool(appId: MeriV3ManagedAppId, toolName: string): boolean {
  const name = toolName.trim();
  if (!name || MUTATING_PREFIX.test(name)) return false;
  if (appId === 'airtable') return AIRTABLE_READ_ONLY_TOOLS.has(name);
  if (name === 'get_user_details') return true;
  return HUBSPOT_READ_PREFIX.test(name);
}

export function filterManagedReadOnlyTools(
  appId: MeriV3ManagedAppId,
  toolNames: readonly string[],
): string[] {
  return Array.from(new Set(toolNames.filter((name) => isManagedReadOnlyTool(appId, name)))).slice(
    0,
    50,
  );
}
