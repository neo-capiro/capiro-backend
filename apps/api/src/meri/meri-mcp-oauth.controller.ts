/**
 * OAuth callback endpoint for Meri MCP connectors (connector-library v1).
 *
 * Deliberately a SEPARATE controller with NO RolesGuard: the provider redirects
 * the browser straight here with ?code&state and no tenant header, exactly like
 * the Microsoft Graph callback. The request is authenticated by the HMAC-signed
 * `state` (verified in MeriMcpOAuthService.handleCallback), which carries the
 * tenant + server + nonce + expiry. We exchange the code, store tokens, then
 * either show a minimal managed-app completion page or bounce the browser back
 * to the existing connector settings success page.
 */
import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { MeriManagedMcpService } from './meri-managed-mcp.service.js';
import { MeriMcpOAuthService } from './meri-mcp-oauth.service.js';
import { MeriMcpService } from './meri-mcp.service.js';

function managedSuccessHtml(appName: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${appName} connected — Capiro</title>
</head>
<body style="margin:0;background:#f5f6f8;color:#131a24;font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh">
  <main style="width:min(360px,calc(100vw - 40px));background:#fff;border:1px solid #dfe2e8;border-radius:14px;padding:28px;text-align:center;box-shadow:0 14px 40px rgba(19,26,36,.10)">
    <div style="width:38px;height:38px;border-radius:999px;background:#e8f5ee;color:#247c53;display:grid;place-items:center;margin:0 auto 14px;font-size:20px">✓</div>
    <h1 style="font-size:18px;margin:0 0 7px">${appName} connected</h1>
    <p style="color:#667085;margin:0">You can return to Meri. This sign-in window will close from the Capiro workspace.</p>
  </main>
</body>
</html>`;
}

@Controller('clio/mcp-oauth')
export class MeriMcpOAuthController {
  constructor(
    private readonly oauth: MeriMcpOAuthService,
    private readonly mcp: MeriMcpService,
    private readonly managedMcp: MeriManagedMcpService,
  ) {}

  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Query('error_description') errorDescription: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const base = this.oauth.getSuccessRedirect();
    const fail = (msg: string) =>
      res.redirect(302, `${base}?provider=mcp&mcp_error=${encodeURIComponent(msg)}`);

    if (error) return fail(errorDescription || error);
    if (!code || !state) return fail('Missing authorization code or state');

    try {
      const result = await this.oauth.handleCallback({ code, state });
      // Tokens are stored now → discover the server's real tools. Managed
      // MeriV3 apps are then immediately narrowed back to their reviewed
      // read-only context surface BEFORE the browser can return to chat.
      await this.mcp.discoverTools(result.tenantId, result.serverId).catch(() => {});
      const managedApp = await this.managedMcp.appForServer(result.tenantId, result.serverId);
      if (managedApp) {
        await this.managedMcp.finalizeConnection(result.tenantId, result.serverId);
        res.status(200).type('html').send(managedSuccessHtml(managedApp.name));
        return;
      }
      res.redirect(302, `${base}?provider=mcp&mcp_connected=${encodeURIComponent(result.name)}`);
    } catch (err) {
      fail(err instanceof Error ? err.message : 'Authorization failed');
    }
  }
}
