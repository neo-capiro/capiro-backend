import { createHash, randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Ticket lifetime.
 *
 * The browser mints a ticket and immediately opens the socket, so this only has
 * to cover one HTTP round-trip plus the upgrade. Short on purpose: the whole
 * point is that a leaked ticket is worthless almost immediately, in contrast to
 * the Clerk JWT it replaces, which was retained for up to four hours.
 */
const TICKET_TTL_MS = 60_000;

/**
 * Single-use WebSocket upgrade tickets.
 *
 * A browser cannot set an Authorization header on a WebSocket. The previous
 * design worked around that by putting the full Clerk JWT in the query string,
 * where it is captured by ALB access logs, proxies, browser history and error
 * reporting — and then RETAINED the raw token on the connection object for the
 * life of the socket (up to MAX_SESSION_MS, four hours) and relayed it to
 * MeriV2 on every transcript segment, long after the ~60s token had expired.
 *
 * A ticket is a random 256-bit value that authorizes exactly one upgrade of one
 * session, expires in 60 seconds, and is stored only as a SHA-256 hash.
 */
@Injectable()
export class HearingWsTicketService {
  private readonly logger = new Logger(HearingWsTicketService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Mint a ticket for an authenticated caller. The RAW ticket is returned to
   * the browser and never persisted or logged.
   */
  async mint(
    tenantId: string,
    clerkUserId: string,
    sessionId: string,
  ): Promise<{ ticket: string; expiresAt: Date }> {
    const ticket = randomBytes(32).toString('base64url');
    const ticketHash = sha256(ticket);
    const expiresAt = new Date(Date.now() + TICKET_TTL_MS);

    await this.prisma.withTenant(tenantId, (tx) =>
      tx.intelWsTicket.create({
        data: { tenantId, clerkUserId, sessionId, ticketHash, expiresAt },
      }),
    );

    return { ticket, expiresAt };
  }

  /**
   * Atomically consume a ticket. Returns the delegated identity, or null when
   * the ticket is unknown, already used, expired, or for a different session.
   *
   * ⚠️ Single-use is enforced by the CONDITIONAL UPDATE ... RETURNING below, not
   * by a read followed by a write. A read-then-write lets two concurrent
   * upgrades presenting the same ticket both succeed. Any refactor to
   * findFirst-then-update must be rejected in review.
   *
   * ⚠️ withSystem, not withTenant: at this point in handleConnection there is no
   * verified tenant yet — resolving it is what the ticket is for. intel_ws_ticket
   * has FORCE RLS, so without the bypass this matches zero rows silently and
   * every connection fails as "invalid ticket".
   */
  async consume(
    rawTicket: string,
    sessionId: string,
  ): Promise<{ tenantId: string; clerkUserId: string } | null> {
    const ticketHash = sha256(rawTicket);

    try {
      const rows = await this.prisma.withSystem(
        (tx) => tx.$queryRaw<Array<{ tenant_id: string; clerk_user_id: string }>>`
          UPDATE intel_ws_ticket
          SET consumed_at = now()
          WHERE ticket_hash = ${ticketHash}
            AND session_id = ${sessionId}
            AND consumed_at IS NULL
            AND expires_at > now()
          RETURNING tenant_id, clerk_user_id
        `,
      );
      const row = rows[0];
      if (!row) return null;
      return { tenantId: row.tenant_id, clerkUserId: row.clerk_user_id };
    } catch (err) {
      // Fail CLOSED. Never log the raw ticket.
      this.logger.error(`ws ticket consume failed: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Delete consumed/expired tickets. Cheap housekeeping; the table is tiny and
   * every row is dead within a minute of creation.
   */
  async purgeExpired(): Promise<number> {
    try {
      return await this.prisma.withSystem(
        (tx) => tx.$executeRaw`
          DELETE FROM intel_ws_ticket
          WHERE expires_at < now() - interval '1 hour'
        `,
      );
    } catch (err) {
      this.logger.warn(`ws ticket purge failed: ${(err as Error).message}`);
      return 0;
    }
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
