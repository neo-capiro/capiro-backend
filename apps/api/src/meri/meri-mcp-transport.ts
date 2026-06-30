/**
 * Live MCP transports for Meri (F6a) over the official MCP SDK.
 *
 * Implements the pure McpClient interface from meri-mcp.helpers.ts with two
 * transports:
 *  - streamable HTTP (tenant-configurable; bearer auth via header)
 *  - stdio (child process; OPS-MANAGED ONLY — a tenant-supplied command would
 *    be remote code execution on the API host, so stdio servers refuse to
 *    start unless the exact command is allowlisted via
 *    CLIO_MCP_STDIO_ALLOWED_COMMANDS, a platform-operator env var)
 *
 * Connections are per-operation (connect → call → close): simple, leak-proof,
 * and stateless across the 15-minute registry refresh cadence. Each operation
 * carries its own timeout.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { parseMcpToolsList, type McpClient, type McpToolDescriptor } from './meri-mcp.helpers.js';

export interface McpServerConnection {
  transport: 'http' | 'stdio';
  endpoint?: string | null;
  command?: string | null;
  args?: string[];
  env?: Record<string, string>;
  authToken?: string | null;
  /** OAuth 2.1 provider (auth_type='oauth'); the transport sends + refreshes
   *  tokens through it. Takes precedence over a static bearer `authToken`. */
  authProvider?: OAuthClientProvider;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** Allowlisted stdio commands (exact match) from the ops env var. */
export function stdioCommandAllowed(command: string, allowlistCsv: string | undefined): boolean {
  if (!allowlistCsv) return false;
  const allowed = allowlistCsv
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  return allowed.includes(command.trim());
}

async function withClient<T>(
  conn: McpServerConnection,
  stdioAllowlistCsv: string | undefined,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ name: 'capiro-clio', version: '1.0.0' });
  let transport: StreamableHTTPClientTransport | StdioClientTransport;
  if (conn.transport === 'http') {
    if (!conn.endpoint) throw new Error('MCP http server has no endpoint configured');
    transport = new StreamableHTTPClientTransport(new URL(conn.endpoint), {
      // OAuth provider wins when present (it manages + refreshes tokens). Fall
      // back to a static bearer header only when there is no provider.
      authProvider: conn.authProvider,
      requestInit:
        !conn.authProvider && conn.authToken
          ? { headers: { Authorization: `Bearer ${conn.authToken}` } }
          : undefined,
    });
  } else {
    if (!conn.command) throw new Error('MCP stdio server has no command configured');
    if (!stdioCommandAllowed(conn.command, stdioAllowlistCsv)) {
      throw new Error(
        'MCP stdio command is not allowlisted (set CLIO_MCP_STDIO_ALLOWED_COMMANDS — operator action)',
      );
    }
    transport = new StdioClientTransport({
      command: conn.command,
      args: conn.args ?? [],
      env: {
        ...(conn.env ?? {}),
        ...(conn.authToken ? { MCP_AUTH_TOKEN: conn.authToken } : {}),
      },
    });
  }
  const timeoutMs = conn.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`MCP operation timed out after ${timeoutMs}ms`)), timeoutMs),
  );
  try {
    await Promise.race([client.connect(transport), timeout]);
    return await Promise.race([fn(client), timeout]);
  } finally {
    await client.close().catch(() => {});
  }
}

/** A per-operation McpClient over the SDK transports. */
export function createMcpClient(
  conn: McpServerConnection,
  stdioAllowlistCsv: string | undefined,
): McpClient {
  return {
    async listTools(): Promise<McpToolDescriptor[]> {
      const result = await withClient(conn, stdioAllowlistCsv, (client) => client.listTools());
      return parseMcpToolsList(result);
    },
    async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
      return withClient(conn, stdioAllowlistCsv, (client) =>
        client.callTool({ name, arguments: args }),
      );
    },
  };
}
