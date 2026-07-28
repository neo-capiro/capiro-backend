import { createHash } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service.js';
import { HearingWsTicketService } from './hearing-ws-ticket.service.js';
import { verifyWsOrigin } from './ws-origin.js';

/**
 * WebSocket upgrade tickets.
 *
 * These replace putting the full Clerk JWT in the /intel-api/live query string
 * and retaining it on the connection for up to four hours. The gateway had ZERO
 * test coverage before this file.
 */

interface Recorded {
  created: Array<Record<string, unknown>>;
  rawQueries: string[];
  consumeResult: Array<{ tenant_id: string; clerk_user_id: string }>;
}

function makePrisma(rec: Recorded): PrismaService {
  const tx = {
    intelWsTicket: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        rec.created.push(data);
        return data;
      },
    },
    $queryRaw: async (strings: TemplateStringsArray) => {
      rec.rawQueries.push(Array.isArray(strings) ? strings.join('?') : String(strings));
      return rec.consumeResult;
    },
    $executeRaw: async () => 0,
  };
  return {
    withTenant: async <T>(_t: string, fn: (t: unknown) => Promise<T>) => fn(tx),
    withSystem: async <T>(fn: (t: unknown) => Promise<T>) => fn(tx),
  } as unknown as PrismaService;
}

function emptyRec(): Recorded {
  return { created: [], rawQueries: [], consumeResult: [] };
}

describe('HearingWsTicketService', () => {
  describe('mint', () => {
    it('returns a raw ticket and stores ONLY its sha256', async () => {
      const rec = emptyRec();
      const svc = new HearingWsTicketService(makePrisma(rec));

      const { ticket } = await svc.mint('tenant-1', 'user_1', 'sess-1');

      expect(ticket).toBeTruthy();
      const stored = rec.created[0] as { ticketHash: string };
      // The raw value must never be persisted.
      expect(JSON.stringify(rec.created)).not.toContain(ticket);
      expect(stored.ticketHash).toBe(createHash('sha256').update(ticket).digest('hex'));
    });

    it('issues a high-entropy, url-safe ticket', async () => {
      const rec = emptyRec();
      const svc = new HearingWsTicketService(makePrisma(rec));
      const { ticket } = await svc.mint('tenant-1', 'user_1', 'sess-1');
      // 32 random bytes as base64url.
      expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('issues distinct tickets on every call', async () => {
      const rec = emptyRec();
      const svc = new HearingWsTicketService(makePrisma(rec));
      const a = await svc.mint('tenant-1', 'user_1', 'sess-1');
      const b = await svc.mint('tenant-1', 'user_1', 'sess-1');
      expect(a.ticket).not.toBe(b.ticket);
    });

    it('expires the ticket in about 60 seconds', async () => {
      const rec = emptyRec();
      const svc = new HearingWsTicketService(makePrisma(rec));
      const before = Date.now();
      const { expiresAt } = await svc.mint('tenant-1', 'user_1', 'sess-1');
      const after = Date.now();

      // Bound the expiry against BOTH sides of the call. Comparing only to
      // `before` and requiring <=60,000ms was inherently flaky: mint computes
      // Date.now()+60s after `before`, so any millisecond boundary made the TTL
      // 60,001ms under CI load even though the implementation was correct.
      expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 59_000);
      expect(expiresAt.getTime()).toBeLessThanOrEqual(after + 60_000);
    });

    it('binds the ticket to a tenant, user and session', async () => {
      const rec = emptyRec();
      const svc = new HearingWsTicketService(makePrisma(rec));
      await svc.mint('tenant-1', 'user_1', 'sess-1');
      expect(rec.created[0]).toMatchObject({
        tenantId: 'tenant-1',
        clerkUserId: 'user_1',
        sessionId: 'sess-1',
      });
    });
  });

  describe('consume', () => {
    it('returns the delegated identity on first use', async () => {
      const rec = emptyRec();
      rec.consumeResult = [{ tenant_id: 'tenant-1', clerk_user_id: 'user_1' }];
      const svc = new HearingWsTicketService(makePrisma(rec));

      await expect(svc.consume('raw-ticket', 'sess-1')).resolves.toEqual({
        tenantId: 'tenant-1',
        clerkUserId: 'user_1',
      });
    });

    it('REJECTS a second use of the same ticket', async () => {
      const rec = emptyRec();
      // The conditional UPDATE matches nothing the second time round.
      rec.consumeResult = [];
      const svc = new HearingWsTicketService(makePrisma(rec));
      await expect(svc.consume('raw-ticket', 'sess-1')).resolves.toBeNull();
    });

    it('enforces single use with a conditional UPDATE, not read-then-write', async () => {
      const rec = emptyRec();
      rec.consumeResult = [{ tenant_id: 't', clerk_user_id: 'u' }];
      const svc = new HearingWsTicketService(makePrisma(rec));
      await svc.consume('raw-ticket', 'sess-1');

      const sql = rec.rawQueries[0] ?? '';
      expect(sql).toContain('UPDATE intel_ws_ticket');
      expect(sql).toContain('consumed_at = now()');
      expect(sql).toContain('consumed_at IS NULL');
      expect(sql).toContain('RETURNING');
    });

    it('scopes the claim by expiry and session id', async () => {
      const rec = emptyRec();
      rec.consumeResult = [{ tenant_id: 't', clerk_user_id: 'u' }];
      const svc = new HearingWsTicketService(makePrisma(rec));
      await svc.consume('raw-ticket', 'sess-1');

      const sql = rec.rawQueries[0] ?? '';
      expect(sql).toContain('expires_at > now()');
      expect(sql).toContain('session_id');
    });

    it('looks the ticket up by HASH, never by raw value', async () => {
      const rec = emptyRec();
      rec.consumeResult = [{ tenant_id: 't', clerk_user_id: 'u' }];
      const svc = new HearingWsTicketService(makePrisma(rec));
      await svc.consume('raw-ticket', 'sess-1');
      const sql = rec.rawQueries[0] ?? '';
      expect(sql).toContain('ticket_hash');
      expect(sql).not.toContain('raw-ticket');
    });

    it('fails CLOSED when the database errors', async () => {
      const prisma = {
        withSystem: async () => {
          throw new Error('connection reset');
        },
      } as unknown as PrismaService;
      const svc = new HearingWsTicketService(prisma);
      await expect(svc.consume('raw-ticket', 'sess-1')).resolves.toBeNull();
    });
  });
});

describe('verifyWsOrigin', () => {
  const reqWith = (origin?: string) =>
    ({ headers: origin ? { origin } : {} }) as unknown as Parameters<
      typeof verifyWsOrigin
    >[0]['req'];

  it.each([
    'https://app.capiro.ai',
    'https://app-dev.capiro.ai',
    'https://capiro.ai',
    'https://www.capiro.ai',
  ])('allows the production origin %p', (origin) => {
    expect(verifyWsOrigin({ origin, req: reqWith(origin) })).toBe(true);
  });

  it.each([
    'https://evil.example.com',
    'https://app.capiro.ai.evil.com',
    'http://app.capiro.ai',
    'https://acmelobby.app.capiro.ai',
  ])('rejects the non-allowlisted origin %p', (origin) => {
    expect(verifyWsOrigin({ origin, req: reqWith(origin) })).toBe(false);
  });

  // capiro-dev-intel-api ships with no WEB_ORIGIN, so main.ts falls back to
  // ['http://localhost:5173'] for HTTP CORS. The WS allowlist is deliberately
  // NOT derived from that variable, so the hole must not appear here.
  it('does NOT allow localhost in the default production set', () => {
    expect(verifyWsOrigin({ origin: 'http://localhost:5173', req: reqWith('http://localhost:5173') })).toBe(
      false,
    );
  });

  it('rejects a request with no Origin header (non-browser client)', () => {
    expect(verifyWsOrigin({ req: reqWith(undefined) })).toBe(false);
  });

  it('reads the Origin header when the adapter does not pass info.origin', () => {
    expect(verifyWsOrigin({ req: reqWith('https://app.capiro.ai') })).toBe(true);
  });
});
