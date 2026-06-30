/**
 * Curated MCP connector library (the "browse the library" experience).
 *
 * This is Capiro's editorial directory of vetted MCP servers — the analogue of
 * Claude's connector directory. The runtime plumbing (transport, allowlist,
 * circuit breaker, bridging, OAuth) is identical to a hand-added custom
 * connector; the catalog just pre-fills the fields and gives each entry an
 * icon, description, and a suggested tool set so a one-click "Connect" works.
 *
 * SCOPE NOTE (Ninja, 2026-06-29): government / legislative / regulatory data
 * connectors are deliberately EXCLUDED — Meri already has that data natively
 * (Congress, GovInfo, Federal Register, Regulations.gov, USAspending, LDA,
 * FARA, OpenStates...) via first-party tools, so a connector would duplicate
 * it. Mail + calendar connectors are likewise excluded because the Engagement
 * integrations (Microsoft 365 / Google Workspace) already sync that data into
 * the normalized engagement store. The library focuses on the firm's OTHER
 * external systems: documents, research, CRM, project tracking, comms, and the
 * local browser bridge.
 *
 * Endpoints are best-effort defaults curated by the platform team. Where a
 * stable hosted endpoint is not yet published, `requiresEndpointInput` asks the
 * admin to paste theirs on connect. Nothing here is a secret — secrets are
 * collected at connect time and encrypted at rest.
 */

export type McpAuthType = 'none' | 'token' | 'oauth';
export type McpCatalogCategory =
  | 'productivity'
  | 'research'
  | 'crm'
  | 'developer'
  | 'communication';
export type McpScope = 'tenant' | 'user';

export interface McpCatalogTool {
  /** Tool name as exposed by the server (seeds the allowlist). */
  name: string;
  description: string;
  /** Read-only tools skip the write-action audit serialization. */
  readOnly?: boolean;
}

export interface McpCatalogEntry {
  /** Stable catalog id (kebab-case). Persisted on the server row as catalogId. */
  id: string;
  /** Display name; also seeds the connector name (sanitized) on add. */
  name: string;
  category: McpCatalogCategory;
  /** One-line summary for the card. */
  description: string;
  /** Fuller paragraph shown in the connect drawer. */
  longDescription: string;
  transport: 'http' | 'stdio';
  /** Remote streamable-HTTP endpoint, or null when the admin must supply it. */
  endpoint: string | null;
  /** stdio command (ops-allowlisted) — only for transport: 'stdio'. */
  command?: string;
  args?: string[];
  authType: McpAuthType;
  /** Curated + reviewed by Capiro (shows the "Verified" badge). */
  verified: boolean;
  /** Whether this acts on behalf of a person (user) or the firm (tenant). */
  defaultScope: McpScope;
  /** Suggested tools — shown in the drawer and seeded into the allowlist. */
  suggestedTools: McpCatalogTool[];
  /** OAuth scopes hint passed to dynamic client registration / authorization. */
  oauthScopes?: string[];
  docsUrl?: string;
  /** The admin must paste the server URL (e.g. self-hosted) before connecting. */
  requiresEndpointInput?: boolean;
  /** Shown as a callout in the drawer (setup prerequisites, API-key location). */
  setupNote?: string;
  /** UI tile: brand-ish color + a glyph key the frontend maps to an icon. */
  brand: { color: string; glyph: string };
}

/**
 * The catalog. Order within a category is the display order. Keep entries
 * additive — removing one only hides it from the library; already-connected
 * servers keep working (they carry their own endpoint/auth).
 */
export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  // ─── Documents & Knowledge ──────────────────────────────────────────────
  {
    id: 'google-drive',
    name: 'Google Drive',
    category: 'productivity',
    description: 'Search, read, and reference files across your Drive.',
    longDescription:
      'Let Meri find and read documents, spreadsheets, and PDFs in Google Drive so research and drafting are grounded in your firm’s own files.',
    transport: 'http',
    endpoint: null,
    authType: 'oauth',
    verified: true,
    defaultScope: 'user',
    requiresEndpointInput: true,
    setupNote:
      'Requires platform setup: Google needs a pre-registered OAuth client (no automatic registration), so paste your configured Drive MCP URL (e.g. https://drivemcp.googleapis.com/mcp/v1) once your admin has set it up.',
    oauthScopes: ['https://www.googleapis.com/auth/drive.readonly'],
    suggestedTools: [
      { name: 'search_files', description: 'Search Drive by name or content', readOnly: true },
      { name: 'read_file', description: 'Read a document’s contents', readOnly: true },
      { name: 'list_folder', description: 'List items in a folder', readOnly: true },
    ],
    brand: { color: '#1a73e8', glyph: 'folder' },
  },
  {
    id: 'sharepoint',
    name: 'SharePoint & OneDrive',
    category: 'productivity',
    description: 'Search and read documents across SharePoint sites and OneDrive.',
    longDescription:
      'Reach the firm’s document libraries in Microsoft 365 — SharePoint sites and OneDrive folders — for grounding answers and drafts. Document access only; mailbox and calendar are handled by the Engagement integration.',
    transport: 'http',
    endpoint: null,
    authType: 'oauth',
    verified: true,
    defaultScope: 'user',
    requiresEndpointInput: true,
    setupNote:
      'Requires platform setup: Microsoft needs a pre-registered OAuth client, so paste your configured SharePoint/OneDrive MCP URL once your admin has set it up.',
    suggestedTools: [
      { name: 'search', description: 'Search SharePoint / OneDrive content', readOnly: true },
      { name: 'get_file', description: 'Read a file’s contents', readOnly: true },
      { name: 'list_sites', description: 'List accessible SharePoint sites', readOnly: true },
    ],
    brand: { color: '#038387', glyph: 'folder' },
  },
  {
    id: 'notion',
    name: 'Notion',
    category: 'productivity',
    description: 'Search pages and databases; read and append content.',
    longDescription:
      'Pull from and write to your Notion workspace — search pages, read database rows, and append meeting recaps or notes.',
    transport: 'http',
    endpoint: 'https://mcp.notion.com/mcp',
    authType: 'oauth',
    verified: true,
    defaultScope: 'user',
    docsUrl: 'https://developers.notion.com',
    suggestedTools: [
      { name: 'search', description: 'Search pages and databases', readOnly: true },
      { name: 'fetch', description: 'Read a page’s content', readOnly: true },
      { name: 'create-pages', description: 'Create or append to a page' },
    ],
    brand: { color: '#111111', glyph: 'note' },
  },
  {
    id: 'box',
    name: 'Box',
    category: 'productivity',
    description: 'Search and read files stored in Box.',
    longDescription: 'Ground Meri in documents managed in Box — search, read, and reference files.',
    transport: 'http',
    endpoint: 'https://mcp.box.com',
    authType: 'oauth',
    verified: true,
    defaultScope: 'user',
    suggestedTools: [
      { name: 'search_files', description: 'Search Box by name or content', readOnly: true },
      { name: 'read_file', description: 'Read a file’s contents', readOnly: true },
    ],
    brand: { color: '#0061d5', glyph: 'folder' },
  },
  {
    id: 'dropbox',
    name: 'Dropbox',
    category: 'productivity',
    description: 'Search and read files in Dropbox.',
    longDescription: 'Reference documents stored in Dropbox — search and read file contents.',
    transport: 'http',
    endpoint: 'https://mcp.dropbox.com/mcp',
    authType: 'oauth',
    verified: true,
    defaultScope: 'user',
    docsUrl: 'https://help.dropbox.com/integrations/connect-dropbox-mcp-server',
    suggestedTools: [
      { name: 'search', description: 'Search Dropbox', readOnly: true },
      { name: 'read_file', description: 'Read a file’s contents', readOnly: true },
    ],
    brand: { color: '#0061ff', glyph: 'folder' },
  },

  // ─── Research & Intelligence ────────────────────────────────────────────
  {
    id: 'tavily',
    name: 'Tavily',
    category: 'research',
    description: 'Agentic web search and extraction built for LLMs.',
    longDescription:
      'High-signal web search and page extraction tuned for AI agents — the best general "what’s happening out there" tool for research.',
    transport: 'http',
    endpoint: 'https://mcp.tavily.com/mcp/',
    authType: 'token',
    verified: true,
    defaultScope: 'tenant',
    docsUrl: 'https://docs.tavily.com',
    setupNote: 'Paste a Tavily API key (tavily.com → dashboard). Shared firm-wide by default.',
    suggestedTools: [
      { name: 'tavily_search', description: 'Search the web', readOnly: true },
      { name: 'tavily_extract', description: 'Extract clean content from a URL', readOnly: true },
    ],
    brand: { color: '#1f6feb', glyph: 'search' },
  },
  {
    id: 'exa',
    name: 'Exa',
    category: 'research',
    description: 'Neural web search with full-content retrieval.',
    longDescription:
      'Semantic web search that finds pages by meaning, with full-text retrieval — strong for niche policy and industry research.',
    transport: 'http',
    endpoint: 'https://mcp.exa.ai/mcp',
    authType: 'none',
    verified: true,
    defaultScope: 'tenant',
    docsUrl: 'https://exa.ai/docs/reference/exa-mcp',
    setupNote:
      'Keyless basic web search works out of the box. For higher rate limits, add Exa via "Add custom connector" with your API key.',
    suggestedTools: [
      { name: 'web_search_exa', description: 'Search the web', readOnly: true },
      { name: 'get_contents', description: 'Retrieve full page contents', readOnly: true },
    ],
    brand: { color: '#2d3748', glyph: 'search' },
  },
  {
    id: 'firecrawl',
    name: 'Firecrawl',
    category: 'research',
    description: 'Scrape and crawl web pages into clean markdown.',
    longDescription:
      'Turn agency pages, hearing schedules, and news into clean, structured text Meri can read — single-page scrape or whole-site crawl.',
    transport: 'http',
    endpoint: 'https://mcp.firecrawl.dev/v2/mcp',
    authType: 'none',
    verified: true,
    defaultScope: 'tenant',
    docsUrl: 'https://docs.firecrawl.dev/developer-guides/mcp-setup-guides/claude-ai',
    setupNote:
      'Keyless free tier (rate-limited). For higher limits, add a custom connector with the key-in-URL form https://mcp.firecrawl.dev/<API_KEY>/v2/mcp.',
    suggestedTools: [
      { name: 'firecrawl_scrape', description: 'Scrape one URL to markdown', readOnly: true },
      { name: 'firecrawl_search', description: 'Search and scrape results', readOnly: true },
    ],
    brand: { color: '#fb5a3a', glyph: 'search' },
  },
  {
    id: 'chrome',
    name: 'Google Chrome',
    category: 'research',
    description: 'Drive a local Chrome browser — navigate, read pages, screenshot.',
    longDescription:
      'Give Meri a real browser: navigate to pages behind logins, read rendered content, fill forms, and capture screenshots. Runs against a local Chrome via the Chrome DevTools MCP bridge — nothing leaves the machine it runs on.',
    transport: 'stdio',
    endpoint: null,
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@latest'],
    authType: 'none',
    verified: true,
    defaultScope: 'tenant',
    docsUrl: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
    setupNote:
      'Local browser bridge. Because it spawns a process on the host, a platform operator must allowlist the command (CLIO_MCP_STDIO_ALLOWED_COMMANDS) before it can run.',
    suggestedTools: [
      { name: 'navigate_page', description: 'Open a URL in the browser' },
      { name: 'take_snapshot', description: 'Read the rendered page content', readOnly: true },
      { name: 'take_screenshot', description: 'Capture a screenshot', readOnly: true },
      { name: 'click', description: 'Click an element on the page' },
      { name: 'fill', description: 'Fill a form field' },
    ],
    brand: { color: '#4285f4', glyph: 'browser' },
  },

  // ─── CRM, Sales & Ops ───────────────────────────────────────────────────
  {
    id: 'hubspot',
    name: 'HubSpot',
    category: 'crm',
    description: 'Contacts, companies, and deal pipeline.',
    longDescription:
      'Read CRM records so Meri can prep for meetings and keep engagement context in sync with your pipeline.',
    transport: 'http',
    endpoint: 'https://mcp.hubspot.com',
    authType: 'oauth',
    verified: true,
    defaultScope: 'tenant',
    docsUrl: 'https://developers.hubspot.com',
    suggestedTools: [
      { name: 'search_contacts', description: 'Find contacts and companies', readOnly: true },
      { name: 'get_deal', description: 'Deal detail and stage', readOnly: true },
    ],
    brand: { color: '#ff7a59', glyph: 'contacts' },
  },
  {
    id: 'salesforce',
    name: 'Salesforce',
    category: 'crm',
    description: 'Accounts, contacts, and opportunities (read-only SOQL).',
    longDescription:
      'Query Salesforce with read-only SOQL and read account, contact, and opportunity records.',
    transport: 'http',
    endpoint: null,
    authType: 'oauth',
    verified: false,
    defaultScope: 'tenant',
    requiresEndpointInput: true,
    setupNote:
      'Salesforce-hosted but org-specific: pick a server (e.g. https://api.salesforce.com/platform/mcp/v1/sobject-all) with a pre-registered External Client App, then paste that URL.',
    suggestedTools: [
      { name: 'soql_query', description: 'Run a read-only SOQL query', readOnly: true },
      { name: 'get_record', description: 'Retrieve a record by id', readOnly: true },
    ],
    brand: { color: '#00a1e0', glyph: 'database' },
  },
  {
    id: 'stripe',
    name: 'Stripe',
    category: 'crm',
    description: 'Customers, invoices, and subscriptions.',
    longDescription:
      'Read billing data — customers, invoices, and subscription status — for finance and ops questions.',
    transport: 'http',
    endpoint: 'https://mcp.stripe.com',
    authType: 'oauth',
    verified: true,
    defaultScope: 'tenant',
    docsUrl: 'https://docs.stripe.com/mcp',
    suggestedTools: [
      { name: 'list_customers', description: 'List or search customers', readOnly: true },
      { name: 'retrieve_invoice', description: 'Invoice detail', readOnly: true },
      { name: 'list_subscriptions', description: 'Active subscriptions', readOnly: true },
    ],
    brand: { color: '#635bff', glyph: 'card' },
  },
  {
    id: 'apollo',
    name: 'Apollo',
    category: 'crm',
    description: 'Prospecting and contact enrichment.',
    longDescription:
      'Look up and enrich contacts and companies from Apollo to support outreach and targeting.',
    transport: 'http',
    endpoint: 'https://mcp.apollo.io/mcp',
    authType: 'oauth',
    verified: true,
    defaultScope: 'tenant',
    docsUrl: 'https://docs.apollo.io/docs/apollo-mcp',
    setupNote: 'Connect with your Apollo account (OAuth). Available on any Apollo plan.',
    suggestedTools: [
      { name: 'people_search', description: 'Search people / contacts', readOnly: true },
      { name: 'enrich', description: 'Enrich a contact or company', readOnly: true },
    ],
    brand: { color: '#7c3aed', glyph: 'contacts' },
  },

  // ─── Project & Engineering ──────────────────────────────────────────────
  {
    id: 'atlassian',
    name: 'Atlassian (Jira & Confluence)',
    category: 'developer',
    description: 'Jira issues and Confluence pages.',
    longDescription:
      'Search and read Jira issues and Confluence spaces, and file or update issues — useful for keeping product and delivery context in one place.',
    transport: 'http',
    endpoint: 'https://mcp.atlassian.com/v1/mcp/authv2',
    authType: 'oauth',
    verified: true,
    defaultScope: 'user',
    docsUrl: 'https://www.atlassian.com/platform/remote-mcp-server',
    suggestedTools: [
      {
        name: 'searchJiraIssuesUsingJql',
        description: 'Search Jira issues with JQL',
        readOnly: true,
      },
      { name: 'getJiraIssue', description: 'Read an issue', readOnly: true },
      { name: 'searchConfluenceUsingCql', description: 'Search Confluence', readOnly: true },
      { name: 'createJiraIssue', description: 'File a new issue' },
    ],
    brand: { color: '#172b4d', glyph: 'task' },
  },
  {
    id: 'linear',
    name: 'Linear',
    category: 'developer',
    description: 'Issues, projects, and cycles for product teams.',
    longDescription:
      'Read and triage Linear issues, summarize cycles, and file new issues from conversations.',
    transport: 'http',
    endpoint: 'https://mcp.linear.app/mcp',
    authType: 'oauth',
    verified: true,
    defaultScope: 'user',
    docsUrl: 'https://linear.app/docs/mcp',
    suggestedTools: [
      { name: 'list_issues', description: 'Search issues', readOnly: true },
      { name: 'get_issue', description: 'Issue detail and comments', readOnly: true },
      { name: 'create_issue', description: 'File a new issue' },
    ],
    brand: { color: '#5e6ad2', glyph: 'task' },
  },
  {
    id: 'asana',
    name: 'Asana',
    category: 'developer',
    description: 'Projects, tasks, and assignments.',
    longDescription:
      'Read and update Asana projects so Meri can summarize status and create follow-up tasks from meetings.',
    transport: 'http',
    endpoint: 'https://mcp.asana.com/v2/mcp',
    authType: 'oauth',
    verified: true,
    defaultScope: 'user',
    docsUrl: 'https://developers.asana.com/docs/mcp-server',
    suggestedTools: [
      { name: 'asana_search_tasks', description: 'Search tasks across projects', readOnly: true },
      { name: 'asana_get_task', description: 'Task detail', readOnly: true },
      { name: 'asana_create_task', description: 'Create a task' },
    ],
    brand: { color: '#f06a6a', glyph: 'task' },
  },
  {
    id: 'github',
    name: 'GitHub',
    category: 'developer',
    description: 'Repositories, issues, and pull requests.',
    longDescription:
      'Read repositories, search code, and triage issues and pull requests across your organization.',
    transport: 'http',
    endpoint: 'https://api.githubcopilot.com/mcp/',
    authType: 'oauth',
    verified: true,
    defaultScope: 'user',
    docsUrl: 'https://github.com/github/github-mcp-server',
    suggestedTools: [
      { name: 'search_code', description: 'Search code across repos', readOnly: true },
      { name: 'get_issue', description: 'Issue or PR detail', readOnly: true },
      { name: 'list_pull_requests', description: 'List pull requests', readOnly: true },
      { name: 'create_issue', description: 'Open an issue' },
    ],
    brand: { color: '#24292f', glyph: 'code' },
  },
  {
    id: 'sentry',
    name: 'Sentry',
    category: 'developer',
    description: 'Error monitoring and issue triage.',
    longDescription:
      'Surface and summarize production errors, with stack traces and affected releases.',
    transport: 'http',
    endpoint: 'https://mcp.sentry.dev/mcp',
    authType: 'oauth',
    verified: true,
    defaultScope: 'tenant',
    docsUrl: 'https://docs.sentry.io/product/sentry-mcp',
    suggestedTools: [
      { name: 'find_issues', description: 'Recent issues by project', readOnly: true },
      { name: 'get_issue_details', description: 'Issue detail and events', readOnly: true },
    ],
    brand: { color: '#362d59', glyph: 'bug' },
  },

  // ─── Communication ──────────────────────────────────────────────────────
  {
    id: 'slack',
    name: 'Slack',
    category: 'communication',
    description: 'Search channels and post updates.',
    longDescription:
      'Search your workspace’s channels for context and post summaries or alerts to a channel.',
    transport: 'http',
    endpoint: 'https://mcp.slack.com/mcp',
    authType: 'oauth',
    verified: true,
    defaultScope: 'tenant',
    docsUrl: 'https://docs.slack.dev/ai/slack-mcp-server/',
    setupNote: 'Connect with your Slack workspace (OAuth). Acts within your Slack permissions.',
    suggestedTools: [
      { name: 'search_messages', description: 'Search across channels', readOnly: true },
      { name: 'get_channel_history', description: 'Recent messages in a channel', readOnly: true },
      { name: 'post_message', description: 'Post a message' },
    ],
    brand: { color: '#611f69', glyph: 'chat' },
  },
] as const;

const CATALOG_BY_ID: ReadonlyMap<string, McpCatalogEntry> = new Map(
  MCP_CATALOG.map((entry) => [entry.id, entry]),
);

export function getCatalogEntry(id: string): McpCatalogEntry | undefined {
  return CATALOG_BY_ID.get(id);
}
