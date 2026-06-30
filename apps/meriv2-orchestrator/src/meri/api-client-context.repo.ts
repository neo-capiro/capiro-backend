import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ClientContextRepo, ClientContextResult, MeriContext } from '@capiro/meriv2-core';
import { RequestCredentialsStore } from '../request/request-credentials.store.js';

/**
 * Phase-0 `ClientContextRepo`: delegates to apps/api's existing authenticated
 * `GET /api/engagement/context/:clientId`, forwarding the caller's verified
 * Bearer token. This reuses the ONE authoritative, tenant+user-scoped query
 * (engagement.clientContext) — no SQL duplicated, no scoping drift — so MeriV2
 * returns exactly what current Meri returns for the same caller (SC0.7 by
 * construction). The api re-derives the full TenantContext from the same JWT.
 *
 * Later phases may move the query into meriv2-core; the port keeps that swap
 * invisible to callers.
 */
@Injectable()
export class ApiClientContextRepo implements ClientContextRepo {
  private readonly logger = new Logger(ApiClientContextRepo.name);
  private readonly apiBaseUrl: string;

  constructor(config: ConfigService) {
    this.apiBaseUrl = (config.get<string>('MERIV2_API_BASE_URL') ?? 'http://localhost:3000').replace(
      /\/+$/,
      '',
    );
  }

  async loadClientContext(_ctx: MeriContext, clientId: string): Promise<ClientContextResult> {
    const creds = RequestCredentialsStore.get();
    if (!creds?.bearerToken) {
      throw new Error('No forwarded credential available for the delegated client-context call');
    }
    const url = `${this.apiBaseUrl}/api/engagement/context/${encodeURIComponent(clientId)}`;
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${creds.bearerToken}`, accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      this.logger.warn(`Delegated client-context call ${res.status} for client ${clientId}`);
      throw new Error(`Delegated client-context call failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
    }
    return (await res.json()) as ClientContextResult;
  }
}
