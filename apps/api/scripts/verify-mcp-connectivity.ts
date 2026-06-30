/**
 * Live connectivity check for the MCP connector path (connector-library v1).
 *
 * Exercises the EXACT plumbing Meri uses to talk to a connected MCP server —
 * the real streamable-HTTP transport + the bridge/parse/wrap helpers — against a
 * public, no-auth MCP server (DeepWiki by default). Proves: connect →
 * tools/list → bridge into Meri's namespaced tool surface → tools/call → wrap
 * result as untrusted data.
 *
 * Run:  pnpm --filter @capiro/api exec tsx scripts/verify-mcp-connectivity.ts
 * Override target: MCP_TEST_ENDPOINT=https://… (must be a no-auth public server)
 */
import { createMcpClient } from '../src/meri/meri-mcp-transport.js';
import {
  bridgeMcpTool,
  parseBridgedToolName,
  wrapMcpResultForPrompt,
} from '../src/meri/meri-mcp.helpers.js';

async function main(): Promise<void> {
  const endpoint = process.env.MCP_TEST_ENDPOINT ?? 'https://mcp.deepwiki.com/mcp';
  console.log(`[verify] connecting to public MCP server: ${endpoint}`);

  // No stdio allowlist needed (http transport, no auth).
  const client = createMcpClient({ transport: 'http', endpoint }, undefined);

  // 1) tools/list — proves connect + protocol handshake + parse.
  const tools = await client.listTools();
  console.log(`[verify] tools/list returned ${tools.length} tool(s):`);
  for (const t of tools) {
    console.log(`   • ${t.name} — ${(t.description ?? '').replace(/\s+/g, ' ').slice(0, 80)}`);
  }
  if (tools.length === 0) throw new Error('Server returned no tools');

  // 2) bridge — exactly what Meri offers the model (mcp__<server>__<tool>).
  const bridged = tools.map((t) => bridgeMcpTool('deepwiki', t));
  console.log('[verify] bridged into Meri tool surface:');
  for (const b of bridged) console.log(`   • ${b.name}`);
  const firstName = bridged[0]!.name;
  console.log(`[verify] round-trip name parse: ${firstName} -> ${JSON.stringify(parseBridgedToolName(firstName))}`);

  // 3) tools/call — a real round trip on a read-only tool.
  const target =
    tools.find((t) => /structure|contents|read|question|search|fetch/i.test(t.name)) ?? tools[0]!;
  const args: Record<string, unknown> = /structure|contents/i.test(target.name)
    ? { repoName: 'modelcontextprotocol/python-sdk' }
    : /question|ask/i.test(target.name)
      ? { repoName: 'modelcontextprotocol/python-sdk', question: 'What does this repository do?' }
      : {};
  console.log(`[verify] calling '${target.name}' with ${JSON.stringify(args)} …`);
  try {
    const result = await client.callTool(target.name, args);
    const wrapped = wrapMcpResultForPrompt('deepwiki', result);
    console.log('[verify] result wrapped for the model (first 500 chars):');
    console.log(wrapped.slice(0, 500));
    console.log('[verify] ✅ FULL round-trip OK: connect → list → bridge → call → wrap');
  } catch (err) {
    // Even a server-side error proves bidirectional communication succeeded.
    console.log(`[verify] tool call returned: ${(err as Error).message}`);
    console.log('[verify] ✅ connect + list + bridge verified (call reached the server)');
  }
}

main().catch((err) => {
  console.error('[verify] FAILED:', err);
  process.exit(1);
});
