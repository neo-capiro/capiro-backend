import type { IncomingMessage } from 'node:http';

/**
 * Browser origins permitted to open the live audio WebSocket.
 *
 * NOT derived from WEB_ORIGIN. capiro-dev-intel-api ships WITHOUT that variable,
 * so main.ts falls back to ['http://localhost:5173'] — meaning localhost is
 * currently in the service's production HTTP CORS allowlist. Copying that logic
 * would carry the hole onto the WebSocket. The production set is hardcoded, with
 * WS_ALLOWED_ORIGINS available for staging/preview hosts.
 *
 * Note `*.app.capiro.ai` tenant vanity hosts are deliberately absent: no in-use
 * ACM certificate covers that two-label-deep wildcard, so they cannot be loaded
 * over HTTPS and are not real browser origins today.
 */
const WS_ALLOWED_ORIGINS = new Set(
  [
    'https://app.capiro.ai',
    'https://app-dev.capiro.ai',
    'https://capiro.ai',
    'https://www.capiro.ai',
    ...(process.env.WS_ALLOWED_ORIGINS?.split(',') ?? []),
  ]
    .map((o) => o.trim())
    .filter(Boolean),
);

/**
 * Origin allowlist enforced at the HANDSHAKE.
 *
 * `ws` honours verifyClient even on the noServer path the Nest adapter uses, and
 * the adapter forwards every non-`server`/`path` key of the @WebSocketGateway
 * options straight into the ws.Server constructor. Rejecting here returns HTTP
 * 401 BEFORE the 101 upgrade — strictly better than accepting the socket and
 * calling close() afterwards.
 *
 * Lives in its own module, not on the gateway class: verifyClient is evaluated
 * at class-decoration time and has NO access to Nest DI, so it can only read
 * module scope and process.env. Keeping it separate also lets it be unit-tested
 * without dragging the whole gateway (and @clerk/backend) into the test.
 *
 * A missing Origin header means a non-browser client; those are not allowlisted.
 */
export function verifyWsOrigin(info: { origin?: string; req: IncomingMessage }): boolean {
  const origin = info.origin ?? (info.req.headers.origin as string | undefined);
  if (!origin) return false;
  return WS_ALLOWED_ORIGINS.has(origin);
}
