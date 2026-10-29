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

function completionHtml(title: string, message: string): string {
  // Both strings are controlled application copy, never provider query text.
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8" />' +
    '<meta name="viewport" content="width=device-width,initial-scale=1" />' +
    '<title>' +
    title +
    ' — Capiro</title></head>' +
    '<body style="font:16px system-ui;padding:32px;color:#344054">' +
    '<main><h1>' +
    title +
    '</h1><p>' +
    message +
    '</p>' +
    '<p>You can close this window and return to Meri.</p></main></body></html>'
  );
}

/** Outcome parameters this controller owns on the success destination. */
const CONNECTOR_OUTCOME_KEYS = ['provider', 'mcp_connected', 'mcp_error'];

function queryParamName(pair: string): string {
  const name = pair.split('=')[0] ?? '';
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/**
 * Merge the connector outcome into the configured success destination.
 *
 * The destination is configuration, not a URL this controller built: it may be
 * relative or absolute and may already carry a query string and a fragment. The
 * earlier `base + '?provider=mcp...'` form turned an existing query into part of
 * the first value (`page=connected-services?provider=mcp`), so the outcome is
 * merged into that query instead: the configured path, its other parameters and
 * its fragment survive verbatim, and only the three outcome keys are (re)written
 * with controlled encoding.
 */
function withConnectorOutcome(base: string, outcome: Record<string, string>): string {
  const hashAt = base.indexOf('#');
  const hash = hashAt === -1 ? '' : base.slice(hashAt);
  const withoutHash = hashAt === -1 ? base : base.slice(0, hashAt);
  const queryAt = withoutHash.indexOf('?');
  const path = queryAt === -1 ? withoutHash : withoutHash.slice(0, queryAt);
  const kept = (queryAt === -1 ? '' : withoutHash.slice(queryAt + 1))
    .split('&')
    .filter((pair) => pair.length > 0 && !CONNECTOR_OUTCOME_KEYS.includes(queryParamName(pair)));
  const added = Object.entries(outcome).map(
    ([key, value]) => `${key}=${encodeURIComponent(value)}`,
  );
  return `${path}?${[...kept, ...added].join('&')}${hash}`;
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
    @Query('iss') issuer?: string,
  ): Promise<void> {
    const base = this.oauth.getSuccessRedirect();
    const failure = () =>
      res
        .status(400)
        .type('html')
        .send(
          completionHtml('Sign-in did not complete', 'Return to Meri and try connecting again.'),
        );
    if (!state) {
      failure();
      return;
    }
    if (error || !code) {
      try {
        const result = await this.oauth.handleFailure(state, error === 'access_denied', issuer);
        this.mcp.invalidate(result.tenantId);
        const app = await this.managedMcp.appForServer(result.tenantId, result.serverId);
        if (app) {
          res
            .status(200)
            .type('html')
            .send(
              completionHtml(
                error === 'access_denied' ? 'Sign-in cancelled' : 'Sign-in did not complete',
                'Your conversation is saved. You can try connecting again in Meri.',
              ),
            );
          return;
        }
        res.redirect(
          302,
          withConnectorOutcome(base, {
            provider: 'mcp',
            mcp_error: 'Sign-in did not complete',
          }),
        );
      } catch {
        failure();
      }
      return;
    }
    try {
      const result = await this.oauth.handleCallback({ code, state, issuer });
      const app = await this.managedMcp.appForServer(result.tenantId, result.serverId);
      const count = await this.mcp.discoverTools(result.tenantId, result.serverId);
      if (app) {
        if (!count) {
          failure();
          return;
        }
        await this.managedMcp.finalizeConnection(result.tenantId, result.serverId);
        res
          .status(200)
          .type('html')
          .send(
            completionHtml(
              app.name + ' connected',
              'Meri can now search and read the information you have authorized.',
            ),
          );
        return;
      }
      res.redirect(
        302,
        withConnectorOutcome(base, { provider: 'mcp', mcp_connected: result.name }),
      );
    } catch {
      failure();
    }
  }
}
