/**
 * OAuth callback endpoint for Meri MCP connectors (connector-library v1).
 *
 * Deliberately a SEPARATE controller with NO RolesGuard: the provider redirects
 * the browser straight here with ?code&state and no tenant header, exactly like
 * the Microsoft Graph callback. The request is authenticated by the HMAC-signed
 * `state` (verified in MeriMcpOAuthService.handleCallback), which carries the
 * tenant + server + nonce + expiry. We exchange the code, store tokens, then
 * bounce the browser back to the settings page with a status query param.
 */
import { Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { MeriMcpOAuthService } from './meri-mcp-oauth.service.js';
import { MeriMcpService } from './meri-mcp.service.js';

@Controller('clio/mcp-oauth')
export class MeriMcpOAuthController {
  constructor(
    private readonly oauth: MeriMcpOAuthService,
    private readonly mcp: MeriMcpService,
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
      // New tokens → rebuild the affected registries on the next turn.
      this.mcp.invalidate(result.tenantId);
      res.redirect(302, `${base}?provider=mcp&mcp_connected=${encodeURIComponent(result.name)}`);
    } catch (err) {
      fail(err instanceof Error ? err.message : 'Authorization failed');
    }
  }
}
