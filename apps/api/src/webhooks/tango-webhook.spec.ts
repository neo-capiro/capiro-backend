import { createHmac } from 'node:crypto';
import {
  BadRequestException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../prisma/prisma.service.js';
import { TangoWebhookController } from './tango-webhook.controller.js';
import {
  type TangoWebhookOutcome,
  TangoWebhookService,
  isWithinReplayWindow,
  payloadDigest,
  readEnvelope,
  verifyTangoSignature,
} from './tango-webhook.service.js';

/**
 * Funding Opportunities P46 — verified Tango webhook receiver.
 *
 * The delivery table is doubled in memory rather than mocked call-by-call,
 * matching `tango-store.service.spec.ts`: idempotency is a SEQUENCE property —
 * the second insert of a delivery id must behave differently from the first —
 * so the double has to remember what earlier calls did. Constraint-level proof
 * (the CHECKs, the unique index, RLS absence) belongs to the migration
 * rehearsal against real Postgres; this file proves the SERVICE's branching.
 *
 * No test here performs a network call, and no real secret appears anywhere.
 */

const SECRET = 'whsec_test_only_not_a_real_secret';

function sign(body: string | Buffer, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

// ── In-memory double of `tango_webhook_delivery` ──────────────────────────────

interface DeliveryRow {
  deliveryId: string;
  eventType: string;
  eventId: string | null;
  payloadSha256: string;
  payloadBytes: number;
  payload: unknown;
  status: string;
  providerEventAt: Date | null;
}

class PrismaDouble {
  readonly rows: DeliveryRow[] = [];
  /** When set, the next create throws this instead of inserting. */
  failNextCreateWith: unknown = null;
  createCalls = 0;

  tangoWebhookDelivery = {
    create: async ({ data }: { data: DeliveryRow }): Promise<DeliveryRow> => {
      this.createCalls += 1;
      if (this.failNextCreateWith !== null) {
        const err = this.failNextCreateWith;
        this.failNextCreateWith = null;
        throw err;
      }
      // The unique index on delivery_id, faithfully: the DATABASE decides
      // duplicates, so the double raises P2002 exactly as Postgres would.
      if (this.rows.some((r) => r.deliveryId === data.deliveryId)) {
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      }
      this.rows.push({ ...data });
      return { ...data };
    },
  };
}

function makeService(opts: { secret?: string; windowSeconds?: number; prisma?: PrismaDouble }): {
  service: TangoWebhookService;
  prisma: PrismaDouble;
} {
  const prisma = opts.prisma ?? new PrismaDouble();
  const config = {
    get: (key: string) => {
      if (key === 'TANGO_WEBHOOK_SIGNING_SECRET') return opts.secret;
      if (key === 'TANGO_WEBHOOK_REPLAY_WINDOW_SECONDS') return opts.windowSeconds ?? 300;
      return undefined;
    },
  } as unknown as ConfigService<never, true>;

  const service = new TangoWebhookService(config as never, prisma as unknown as PrismaService);
  return { service, prisma };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('verifyTangoSignature', () => {
  const body = Buffer.from('{"delivery_id":"d1","event_type":"opportunity.updated"}');

  it('accepts a correct signature over the exact bytes', () => {
    expect(verifyTangoSignature(body, sign(body), SECRET)).toEqual({ ok: true });
  });

  it('rejects a tampered body even though the signature is well-formed', () => {
    const signature = sign(body);
    const tampered = Buffer.from('{"delivery_id":"d1","event_type":"opportunity.deleted"}');
    expect(verifyTangoSignature(tampered, signature, SECRET)).toEqual({
      ok: false,
      rejection: 'invalid_signature',
    });
  });

  it('rejects a signature made with a different secret', () => {
    expect(verifyTangoSignature(body, sign(body, 'wrong-secret'), SECRET)).toEqual({
      ok: false,
      rejection: 'invalid_signature',
    });
  });

  it('rejects a single flipped byte in the body', () => {
    const signature = sign(body);
    const flipped = Buffer.from(body);
    const at = flipped.length - 2;
    flipped.writeUInt8(flipped.readUInt8(at) ^ 0x01, at);
    expect(verifyTangoSignature(flipped, signature, SECRET)).toEqual({
      ok: false,
      rejection: 'invalid_signature',
    });
  });

  it.each([
    ['missing header', undefined, 'missing_signature'],
    ['empty header', '   ', 'missing_signature'],
    ['no sha256= prefix', 'abc123', 'malformed_signature'],
    ['wrong algorithm prefix', 'sha1=abc123', 'malformed_signature'],
    ['non-hex digest', `sha256=${'z'.repeat(64)}`, 'malformed_signature'],
    ['digest too short', `sha256=${'a'.repeat(63)}`, 'malformed_signature'],
    ['digest too long', `sha256=${'a'.repeat(65)}`, 'malformed_signature'],
    ['prefix only', 'sha256=', 'malformed_signature'],
  ])('rejects %s', (_label, header, expected) => {
    expect(verifyTangoSignature(body, header as string | undefined, SECRET)).toEqual({
      ok: false,
      rejection: expected,
    });
  });

  it('accepts an upper-case hex digest (case is not a signal)', () => {
    const upper = sign(body).toUpperCase().replace('SHA256=', 'sha256=');
    expect(verifyTangoSignature(body, upper, SECRET)).toEqual({ ok: true });
  });

  it('reports not_configured when no secret is set, and never claims ok', () => {
    expect(verifyTangoSignature(body, sign(body), '')).toEqual({
      ok: false,
      rejection: 'not_configured',
    });
  });

  it('verifies over an empty body without throwing', () => {
    const empty = Buffer.alloc(0);
    expect(verifyTangoSignature(empty, sign(empty), SECRET)).toEqual({ ok: true });
  });
});

describe('isWithinReplayWindow', () => {
  const now = new Date('2026-08-08T12:00:00.000Z');

  it('treats an absent timestamp as acceptable, not stale', () => {
    expect(isWithinReplayWindow(undefined, 300, now)).toEqual({
      ok: true,
      providerEventAt: null,
    });
  });

  it('accepts an ISO timestamp inside the window', () => {
    const result = isWithinReplayWindow('2026-08-08T11:59:00.000Z', 300, now);
    expect(result.ok).toBe(true);
    expect((result as { providerEventAt: Date }).providerEventAt.toISOString()).toBe(
      '2026-08-08T11:59:00.000Z',
    );
  });

  it('accepts epoch seconds inside the window', () => {
    const epoch = String(Math.floor(now.getTime() / 1000) - 60);
    expect(isWithinReplayWindow(epoch, 300, now).ok).toBe(true);
  });

  it('rejects a timestamp older than the window', () => {
    expect(isWithinReplayWindow('2026-08-08T11:00:00.000Z', 300, now)).toEqual({
      ok: false,
      rejection: 'stale_timestamp',
    });
  });

  it('rejects a timestamp too far in the FUTURE, not only the past', () => {
    expect(isWithinReplayWindow('2026-08-08T13:00:00.000Z', 300, now)).toEqual({
      ok: false,
      rejection: 'stale_timestamp',
    });
  });

  it('tolerates modest forward clock skew inside the window', () => {
    expect(isWithinReplayWindow('2026-08-08T12:01:00.000Z', 300, now).ok).toBe(true);
  });

  it('treats an unparseable timestamp as absent rather than hostile', () => {
    expect(isWithinReplayWindow('not-a-date', 300, now)).toEqual({
      ok: true,
      providerEventAt: null,
    });
  });
});

describe('readEnvelope', () => {
  it('prefers the delivery header over a body id', () => {
    const result = readEnvelope(
      { delivery_id: 'from-body', event_type: 'opportunity.updated' },
      'from-header',
      null,
    );
    expect(result).toMatchObject({ ok: true });
    expect((result as { envelope: { deliveryId: string } }).envelope.deliveryId).toBe(
      'from-header',
    );
  });

  it('falls back to body fields when no header is present', () => {
    const result = readEnvelope(
      { deliveryId: 'body-delivery', eventType: 'forecast.published', eventId: 'evt-9' },
      undefined,
      null,
    );
    expect(result).toMatchObject({
      ok: true,
      envelope: { deliveryId: 'body-delivery', eventType: 'forecast.published', eventId: 'evt-9' },
    });
  });

  it('accepts an UNKNOWN event type — refusing it would lose the evidence', () => {
    const result = readEnvelope(
      { delivery_id: 'd1', event_type: 'something.capiro.has.never.seen' },
      undefined,
      null,
    );
    expect(result).toMatchObject({
      ok: true,
      envelope: { eventType: 'something.capiro.has.never.seen' },
    });
  });

  it('rejects a payload with no delivery id anywhere', () => {
    expect(readEnvelope({ event_type: 'x' }, undefined, null)).toEqual({
      ok: false,
      rejection: 'missing_delivery_id',
    });
  });

  it('rejects a payload with no event type', () => {
    expect(readEnvelope({ delivery_id: 'd1' }, undefined, null)).toEqual({
      ok: false,
      rejection: 'missing_event_type',
    });
  });

  it('rejects a non-object payload (array) that carries no header id', () => {
    expect(readEnvelope([1, 2, 3], undefined, null)).toEqual({
      ok: false,
      rejection: 'missing_delivery_id',
    });
  });

  it('leaves eventId null when the payload carries none', () => {
    const result = readEnvelope({ delivery_id: 'd1', event_type: 'e' }, undefined, null);
    expect((result as { envelope: { eventId: string | null } }).envelope.eventId).toBeNull();
  });
});

describe('TangoWebhookService.receive', () => {
  const payload = { delivery_id: 'dlv-1', event_type: 'opportunity.updated', event_id: 'evt-1' };
  const body = Buffer.from(JSON.stringify(payload));

  it('is DARK with no secret: rejects and records nothing', async () => {
    const { service, prisma } = makeService({ secret: undefined });
    const outcome = await service.receive(body, {
      signature: sign(body),
      timestamp: undefined,
      deliveryId: undefined,
    });
    expect(outcome).toEqual({ kind: 'rejected', rejection: 'not_configured' });
    expect(prisma.rows).toHaveLength(0);
    expect(prisma.createCalls).toBe(0);
  });

  it('records a verified delivery with the exact digest and byte count', async () => {
    const { service, prisma } = makeService({ secret: SECRET });
    const outcome = await service.receive(body, {
      signature: sign(body),
      timestamp: undefined,
      deliveryId: undefined,
    });

    expect(outcome).toEqual({ kind: 'recorded', deliveryId: 'dlv-1' });
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0]).toMatchObject({
      deliveryId: 'dlv-1',
      eventType: 'opportunity.updated',
      eventId: 'evt-1',
      payloadSha256: payloadDigest(body),
      payloadBytes: body.byteLength,
      status: 'received',
    });
  });

  it('only ever writes status=received — P46 makes no product decision', async () => {
    const { service, prisma } = makeService({ secret: SECRET });
    await service.receive(body, {
      signature: sign(body),
      timestamp: undefined,
      deliveryId: undefined,
    });
    expect(prisma.rows.every((r) => r.status === 'received')).toBe(true);
  });

  it('answers duplicate on exact replay and does NOT write a second row', async () => {
    const { service, prisma } = makeService({ secret: SECRET });
    const headers = { signature: sign(body), timestamp: undefined, deliveryId: undefined };

    const first = await service.receive(body, headers);
    const second = await service.receive(body, headers);

    expect(first).toEqual({ kind: 'recorded', deliveryId: 'dlv-1' });
    expect(second).toEqual({ kind: 'duplicate', deliveryId: 'dlv-1' });
    expect(prisma.rows).toHaveLength(1);
    // Proof the unique index arbitrated rather than a pre-read: create was
    // genuinely attempted both times.
    expect(prisma.createCalls).toBe(2);
  });

  it('rejects a tampered body and records nothing', async () => {
    const { service, prisma } = makeService({ secret: SECRET });
    const signature = sign(body);
    const tampered = Buffer.from(JSON.stringify({ ...payload, event_type: 'evil' }));

    const outcome = await service.receive(tampered, {
      signature,
      timestamp: undefined,
      deliveryId: undefined,
    });
    expect(outcome).toEqual({ kind: 'rejected', rejection: 'invalid_signature' });
    expect(prisma.rows).toHaveLength(0);
  });

  it('VERIFIES BEFORE PARSING: bad signature over malformed JSON reports the signature failure', async () => {
    // This is the ordering guarantee of §4.6 ("raw bytes verified before JSON
    // trust"). If the service parsed first, this would report malformed_json
    // and the JSON parser would be exposed to unauthenticated input.
    const { service, prisma } = makeService({ secret: SECRET });
    const garbage = Buffer.from('{ this is not json');

    const outcome = await service.receive(garbage, {
      signature: 'sha256=' + 'a'.repeat(64),
      timestamp: undefined,
      deliveryId: undefined,
    });
    expect(outcome).toEqual({ kind: 'rejected', rejection: 'invalid_signature' });
    expect(prisma.rows).toHaveLength(0);
  });

  it('rejects authenticated-but-malformed JSON', async () => {
    const { service, prisma } = makeService({ secret: SECRET });
    const garbage = Buffer.from('{ this is not json');

    const outcome = await service.receive(garbage, {
      signature: sign(garbage),
      timestamp: undefined,
      deliveryId: undefined,
    });
    expect(outcome).toEqual({ kind: 'rejected', rejection: 'malformed_json' });
    expect(prisma.rows).toHaveLength(0);
  });

  it('rejects a missing body without throwing', async () => {
    const { service } = makeService({ secret: SECRET });
    const outcome = await service.receive(undefined, {
      signature: sign(body),
      timestamp: undefined,
      deliveryId: undefined,
    });
    expect(outcome).toEqual({ kind: 'rejected', rejection: 'missing_body' });
  });

  it('rejects a delivery outside the replay window before touching the database', async () => {
    const { service, prisma } = makeService({ secret: SECRET, windowSeconds: 60 });
    const outcome = await service.receive(
      body,
      {
        signature: sign(body),
        timestamp: '2026-08-08T10:00:00.000Z',
        deliveryId: undefined,
      },
      new Date('2026-08-08T12:00:00.000Z'),
    );
    expect(outcome).toEqual({ kind: 'rejected', rejection: 'stale_timestamp' });
    expect(prisma.createCalls).toBe(0);
  });

  it('RETHROWS a real persistence failure so the caller can answer retryable', async () => {
    const { service, prisma } = makeService({ secret: SECRET });
    prisma.failNextCreateWith = Object.assign(new Error('connection terminated'), {
      code: 'P1017',
    });

    await expect(
      service.receive(body, {
        signature: sign(body),
        timestamp: undefined,
        deliveryId: undefined,
      }),
    ).rejects.toThrow('connection terminated');
    // Nothing recorded — so the provider MUST re-send.
    expect(prisma.rows).toHaveLength(0);
  });

  it('never writes the signing secret into a log line', async () => {
    const warn = jest.spyOn(require('@nestjs/common').Logger.prototype, 'warn');
    const error = jest.spyOn(require('@nestjs/common').Logger.prototype, 'error');
    const { service } = makeService({ secret: SECRET });

    await service.receive(body, {
      signature: 'sha256=' + 'b'.repeat(64),
      timestamp: undefined,
      deliveryId: undefined,
    });

    const emitted = [...warn.mock.calls, ...error.mock.calls].flat().join(' | ');
    expect(emitted).not.toContain(SECRET);
    // Nor the expected digest, which would be an offline-forgery oracle.
    expect(emitted).not.toContain(createHmac('sha256', SECRET).update(body).digest('hex'));

    warn.mockRestore();
    error.mockRestore();
  });

  it('stores an unknown event type rather than refusing it', async () => {
    const { service, prisma } = makeService({ secret: SECRET });
    const novel = Buffer.from(
      JSON.stringify({ delivery_id: 'dlv-novel', event_type: 'protest.filed.v2' }),
    );
    const outcome = await service.receive(novel, {
      signature: sign(novel),
      timestamp: undefined,
      deliveryId: undefined,
    });
    expect(outcome).toEqual({ kind: 'recorded', deliveryId: 'dlv-novel' });
    expect(prisma.rows[0]?.eventType).toBe('protest.filed.v2');
  });

  it('distinguishes same content under two delivery ids from a true replay', async () => {
    const { service, prisma } = makeService({ secret: SECRET });
    const a = Buffer.from(JSON.stringify({ delivery_id: 'a', event_type: 'e', n: 1 }));
    const b = Buffer.from(JSON.stringify({ delivery_id: 'b', event_type: 'e', n: 1 }));

    await service.receive(a, { signature: sign(a), timestamp: undefined, deliveryId: undefined });
    await service.receive(b, { signature: sign(b), timestamp: undefined, deliveryId: undefined });

    expect(prisma.rows).toHaveLength(2);
    // Different delivery ids, and — because the bodies differ by that id —
    // different digests. Both facts are recorded independently.
    expect(prisma.rows[0]?.payloadSha256).not.toBe(prisma.rows[1]?.payloadSha256);
    expect(prisma.rows[0]?.payloadSha256).toBeDefined();
  });
});

describe('TangoWebhookController status mapping', () => {
  function controllerFor(outcome: TangoWebhookOutcome | (() => never)) {
    const service = {
      receive: async () => {
        if (typeof outcome === 'function') outcome();
        return outcome;
      },
    } as unknown as TangoWebhookService;
    return new TangoWebhookController(service);
  }

  const req = { body: Buffer.from('{}') } as never;

  it('answers recorded', async () => {
    const controller = controllerFor({ kind: 'recorded', deliveryId: 'd1' });
    await expect(controller.receive(req, 'sig', undefined, undefined)).resolves.toEqual({
      status: 'recorded',
    });
  });

  it('answers duplicate — a 2xx, so the provider stops retrying', async () => {
    const controller = controllerFor({ kind: 'duplicate', deliveryId: 'd1' });
    await expect(controller.receive(req, 'sig', undefined, undefined)).resolves.toEqual({
      status: 'duplicate',
    });
  });

  it.each([
    ['missing_signature', UnauthorizedException],
    ['malformed_signature', UnauthorizedException],
    ['invalid_signature', UnauthorizedException],
    ['missing_body', BadRequestException],
    ['malformed_json', BadRequestException],
    ['missing_delivery_id', BadRequestException],
    ['missing_event_type', BadRequestException],
    ['stale_timestamp', BadRequestException],
  ] as const)('maps %s to a terminal 4xx', async (rejection, expected) => {
    const controller = controllerFor({ kind: 'rejected', rejection });
    await expect(controller.receive(req, 'sig', undefined, undefined)).rejects.toBeInstanceOf(
      expected,
    );
  });

  it('maps not_configured to a RETRYABLE 503, not a 4xx', async () => {
    const controller = controllerFor({ kind: 'rejected', rejection: 'not_configured' });
    await expect(controller.receive(req, 'sig', undefined, undefined)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('maps a thrown persistence failure to a RETRYABLE 503 — never acknowledges', async () => {
    const controller = controllerFor(() => {
      throw new Error('db down');
    });
    await expect(controller.receive(req, 'sig', undefined, undefined)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
