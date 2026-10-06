export const MERIV3_MANAGED_APP_IDS = ['hubspot', 'airtable', 'monday', 'google-drive', 'krisp'] as const;
export type MeriV3ManagedAppId = (typeof MERIV3_MANAGED_APP_IDS)[number];

export const MERIV3_HUBSPOT_CATALOG_ID = 'meriv3-hubspot';
export const MERIV3_AIRTABLE_CATALOG_ID = 'meriv3-airtable';
export const MERIV3_MONDAY_CATALOG_ID = 'meriv3-monday';
export const MERIV3_GOOGLE_DRIVE_CATALOG_ID = 'meriv3-google-drive';
export const MERIV3_HUBSPOT_ENDPOINT = 'https://mcp.hubspot.com';
export const MERIV3_AIRTABLE_ENDPOINT = 'https://mcp.airtable.com/mcp';
export const MERIV3_MONDAY_ENDPOINT = 'https://mcp.monday.com/mcp';
export const MERIV3_GOOGLE_DRIVE_ENDPOINT = 'https://drivemcp.googleapis.com/mcp/v1';

// Exact names only: a new provider tool never inherits read permission from its prefix.
// Core CRM reads exposed by the remote HubSpot MCP server. Legacy search/fetch
// remain read-only for existing installations; unknown future tools stay blocked.
export const HUBSPOT_READ_ONLY_TOOLS = new Set([
  'get_user_details',
  'search_crm_objects',
  'get_crm_objects',
  'search_properties',
  'get_properties',
  'search',
  'fetch',
]);

export const AIRTABLE_READ_ONLY_TOOLS = new Set([
  'ping',
  'get_record_for_page',
  'get_table_schema',
  'list_bases',
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
]);

// Reviewed against monday's Platform MCP tools reference. In particular,
// get_asset_upload_url and all_monday_api are NOT reads despite their names.
export const MONDAY_READ_ONLY_TOOLS = new Set([
  'search',
  'get_user_context',
  'list_workspaces',
  'workspace_info',
  'get_board_info',
  'get_board_items_page',
  'get_board_activity',
  'board_insights',
  'get_column_type_info',
  'read_docs',
  'get_updates',
  'get_assets',
  'list_users_and_teams',
]);

export const GOOGLE_DRIVE_READ_ONLY_TOOLS = new Set([
  'search_files',
  'list_recent_files',
  'get_file_metadata',
  'get_file_permissions',
  'read_file_content',
  'download_file_content',
]);

export interface ManagedMcpDefinition {
  id: MeriV3ManagedAppId;
  catalogId: string;
  name: string;
  description: string;
  endpoint: string;
  readOnlyTools: ReadonlySet<string>;
  oauthScopes?: readonly string[];
  clientIdEnv?: string;
  clientSecretEnv?: string;
  enabledEnv: string;
  enabledByDefault: boolean;
  offlineAccess?: boolean;
}

export const MANAGED_MCP_APPS: Record<MeriV3ManagedAppId, ManagedMcpDefinition> = {
  krisp: {
    id: 'krisp', catalogId: 'meriv3-krisp', name: 'Krisp',
    description: 'Import your Krisp meetings into Meeting Notes and Debrief.',
    endpoint: 'https://mcp.krisp.ai/mcp',
    oauthScopes: ['user::me::read', 'user::meetings:metadata::read', 'user::meetings:notes::read', 'user::meetings:transcripts::read', 'user::meetings::list'],
    readOnlyTools: new Set(['search_meetings', 'get_multiple_documents', 'list_folders']),
    enabledEnv: 'MERI_MCP_KRISP_ENABLED', enabledByDefault: true,
  },
  hubspot: {
    id: 'hubspot',
    catalogId: MERIV3_HUBSPOT_CATALOG_ID,
    name: 'HubSpot',
    description: 'Search and read contacts, companies, deals, and CRM context you can access.',
    endpoint: MERIV3_HUBSPOT_ENDPOINT,
    readOnlyTools: HUBSPOT_READ_ONLY_TOOLS,
    clientIdEnv: 'MERI_MCP_HUBSPOT_CLIENT_ID',
    clientSecretEnv: 'MERI_MCP_HUBSPOT_CLIENT_SECRET',
    enabledEnv: 'MERI_MCP_HUBSPOT_ENABLED',
    enabledByDefault: true,
  },
  airtable: {
    id: 'airtable',
    catalogId: MERIV3_AIRTABLE_CATALOG_ID,
    name: 'Airtable',
    description: 'Search and read records in the bases and interfaces you choose.',
    endpoint: MERIV3_AIRTABLE_ENDPOINT,
    readOnlyTools: AIRTABLE_READ_ONLY_TOOLS,
    oauthScopes: [
      'data.records:read',
      'schema.bases:read',
      'data.recordComments:read',
      'workspacesAndBases:read',
    ],
    enabledEnv: 'MERI_MCP_AIRTABLE_ENABLED',
    enabledByDefault: true,
  },
  monday: {
    id: 'monday',
    catalogId: MERIV3_MONDAY_CATALOG_ID,
    name: 'monday.com',
    description: 'Search and read your workspaces, boards, items, and documents.',
    endpoint: MERIV3_MONDAY_ENDPOINT,
    readOnlyTools: MONDAY_READ_ONLY_TOOLS,
    enabledEnv: 'MERI_MCP_MONDAY_ENABLED',
    // Operators enable after the public integration registration and live checks.
    enabledByDefault: false,
  },
  'google-drive': {
    id: 'google-drive',
    catalogId: MERIV3_GOOGLE_DRIVE_CATALOG_ID,
    name: 'Google Drive',
    description: 'Find and read documents, spreadsheets, and files you can access.',
    endpoint: MERIV3_GOOGLE_DRIVE_ENDPOINT,
    readOnlyTools: GOOGLE_DRIVE_READ_ONLY_TOOLS,
    oauthScopes: ['https://www.googleapis.com/auth/drive.readonly'],
    clientIdEnv: 'MERI_MCP_GOOGLE_DRIVE_CLIENT_ID',
    clientSecretEnv: 'MERI_MCP_GOOGLE_DRIVE_CLIENT_SECRET',
    enabledEnv: 'MERI_MCP_GOOGLE_DRIVE_ENABLED',
    // Google currently requires Workspace Developer Preview access.
    enabledByDefault: false,
    offlineAccess: true,
  },
};

export function managedCatalogId(appId: MeriV3ManagedAppId): string {
  return MANAGED_MCP_APPS[appId].catalogId;
}

export function managedAppIdFromCatalogId(
  catalogId: string | null | undefined,
): MeriV3ManagedAppId | null {
  return MERIV3_MANAGED_APP_IDS.find((id) => MANAGED_MCP_APPS[id].catalogId === catalogId) ?? null;
}

export function managedAppDefinition(
  catalogId: string | null | undefined,
): ManagedMcpDefinition | undefined {
  const id = managedAppIdFromCatalogId(catalogId);
  return id ? MANAGED_MCP_APPS[id] : undefined;
}

export function managedAppConfigured(
  appId: MeriV3ManagedAppId,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const app = MANAGED_MCP_APPS[appId];
  const value = env[app.enabledEnv]?.trim().toLowerCase();
  const enabled =
    value === undefined ? app.enabledByDefault : ['true', '1', 'yes', 'on'].includes(value);
  return Boolean(
    enabled &&
    (!app.clientIdEnv || env[app.clientIdEnv]?.trim()) &&
    (!app.clientSecretEnv || env[app.clientSecretEnv]?.trim()),
  );
}

export function isManagedReadOnlyTool(appId: MeriV3ManagedAppId, toolName: string): boolean {
  return MANAGED_MCP_APPS[appId].readOnlyTools.has(toolName);
}

export interface ManagedMcpPrincipal {
  tenantId?: string | null;
  userId?: string | null;
}

/** Google preview access is limited to operator-approved internal identities.
 * Both identifiers come from authenticated context or the owned database row.
 * Missing allowlists deny access, including after a configuration rollback.
 */
export function managedAppAvailable(
  appId: MeriV3ManagedAppId,
  principal: ManagedMcpPrincipal,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!managedAppConfigured(appId, env)) return false;
  const mondayCanary =
    appId === 'monday' &&
    (env.MERI_MCP_MONDAY_ALLOWED_USER_IDS !== undefined ||
      env.MERI_MCP_MONDAY_ALLOWED_TENANT_IDS !== undefined);
  if (appId !== 'google-drive' && !mondayCanary) return true;
  const prefix = mondayCanary ? 'MERI_MCP_MONDAY' : 'MERI_MCP_GOOGLE_DRIVE';
  const includes = (value: string | undefined, id: string | null | undefined) =>
    Boolean(
      id &&
      value
        ?.split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .includes(id),
    );
  return (
    includes(env[`${prefix}_ALLOWED_USER_IDS`], principal.userId) &&
    includes(env[`${prefix}_ALLOWED_TENANT_IDS`], principal.tenantId)
  );
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
