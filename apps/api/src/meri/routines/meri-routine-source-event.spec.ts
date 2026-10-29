import { ConflictException } from '@nestjs/common';
import { parseRoutineSourceEventRequest, readRoutineSourceEvent, SOURCE_EVENT_RECEIPT_WINDOW_MS } from './meri-routine-source-event.js';
import { sourceEventFactHash, sourceEventFacts } from '../../business-development/bizdev-watch-source-event.js';
import { meriExecutionDbNow } from '../execution-capability/meri-execution-authority.js';

const ALERT = '1f2e3d4c-5b6a-4798-8899-aabbccddeeff';
const WATCH = '2a3b4c5d-6e7f-4808-9911-bbccddeeff00';
const PROSPECT = '3b4c5d6e-7f80-4918-8a22-ccddeeff0011';
const SCHEDULE = '4c5d6e7f-8091-4a28-9b33-ddeeff001122';
const OWNER = '5d6e7f80-91a2-4b38-8c44-eeff00112233';
const CONSENT = '6e7f8091-a2b3-4c48-9d55-ff0011223344';
const FP = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';
const NOW = Date.parse('2026-10-15T12:00:01.000Z');
/** Core tenants are UUIDs: a non-uuid tenant claim is refused at the boundary. */
const TENANT = '0a1b2c3d-4e5f-4061-8273-8495a6b7c8d9';

const row = (tenantId: string) => ({
  id: ALERT, watchId: WATCH, prospectId: PROSPECT, dedupeKey: `federal_award:rec-1:${FP}`, fingerprint: FP,
  sourceFamily: 'federal_award', recordId: 'rec-1', sourceRevision: 'rev-7', tenantId,
});
const watchRow = (over: Record<string, unknown> = {}) => ({
  id: WATCH, status: 'active', ownerUserId: OWNER,
  prospect: { id: PROSPECT, linkedClientId: 'client-a', dismissedAt: null }, ...over,
});
const consentRow = (over: Record<string, unknown> = {}) => ({
  consentId: CONSENT, issuedAt: new Date(NOW - 5000), expiresAt: new Date(NOW + 86_400_000), ...over,
});
const memberRow = (over: Record<string, unknown> = {}) => ({ id: 'm1', role: 'standard_user', status: 'active', tenant: { status: 'active', slug: 'a' }, ...over });

function scriptedTx(state: Record<string, any> = {}) {
  const calls: string[] = [];
  const tx = {
    $queryRaw: async () => { calls.push('db_now'); return [{ db_now: new Date(NOW) }]; },
    businessDevelopmentAlert: { findFirst: async (args: any) => { calls.push('alert'); expect(args.where.id).toBe(ALERT); return state.alert === null ? null : (state.alert ?? row(args.where.tenantId)); } },
    businessDevelopmentWatch: { findFirst: async () => { calls.push('watch'); return state.watch === null ? null : (state.watch ?? watchRow()); } },
    businessDevelopmentWatchSourceState: { findFirst: async () => { calls.push('sourceState'); return state.sourceState === null ? null : { id: 's1' }; } },
    clioMeriRoutineConsent: { findFirst: async (args: any) => { calls.push('consent'); expect(args.where.scheduleId).toBe(SCHEDULE); return state.consent === null ? null : (state.consent ?? consentRow()); } },
    clioMeriRoutineConsentRevocation: { findFirst: async () => { calls.push('revocation'); return state.revocation ?? null; } },
    // The real query filters on `status` in SQL, so the scripted owner must too: an inactive
    // membership is never handed back to a caller that asked for an ACTIVE one.
    tenantMembership: { findFirst: async (args: any) => {
      calls.push('member');
      const found = state.member === null ? null : (state.member ?? memberRow());
      return found && found.status === args.where.status ? found : null;
    } },
    user: { findUnique: async () => { calls.push('user'); return state.user === null ? null : (state.user ?? { clerkUserId: 'clerk-1' }); } },
  };
  return { tx: tx as never, calls };
}

const request = (over: Record<string, unknown> = {}) => parseRoutineSourceEventRequest({
  schemaVersion: 1, producer: 'bizdev.watch.alert.v1', tenantId: TENANT, eventId: ALERT,
  eventHash: FP, scheduleId: SCHEDULE, generation: 3, ...over,
});

const wall = jest.fn(async () => [{ id: 'client-a' }]);
jest.mock('../../memory/memory-wall.helpers.js', () => ({
  fetchAccessibleClientRevisionsForClerkActor: (...args: unknown[]) => wall(...(args as [])),
}));

describe('routine source-event request', () => {
  it('is closed to unknown keys, other producers and malformed identifiers', () => {
    expect(request().eventId).toBe(ALERT);
    expect(() => request({ prompt: 'do more' })).toThrow(ConflictException);
    expect(() => request({ producer: 'mailbox.v1' })).toThrow(ConflictException);
    expect(() => request({ tenantId: 'not-a-uuid' })).toThrow(ConflictException);
    expect(() => request({ generation: 0 })).toThrow(ConflictException);
    expect(() => request({ eventHash: 'zz' })).toThrow(ConflictException);
  });
});

describe('routine source-event custody read', () => {
  it('answers with Core\'s OWN canonical facts and digest, never the caller\'s claim', async () => {
    const { tx, calls } = scriptedTx();
    const claimed = request({ eventHash: 'f'.repeat(64) });
    const receipt = await readRoutineSourceEvent(tx, claimed);
    const facts = sourceEventFacts({
      tenantId: TENANT,
      alert: { alertId: ALERT, watchId: WATCH, prospectId: PROSPECT, dedupeKey: `federal_award:rec-1:${FP}`, fingerprint: FP },
      source: { sourceFamily: 'federal_award', recordId: 'rec-1', sourceRevision: 'rev-7' },
    });
    expect(receipt.eventHash).toBe(sourceEventFactHash(facts));
    expect(receipt.eventHash).not.toBe(claimed.eventHash);
    expect(receipt.eventId).toBe(ALERT);
    expect(receipt.alert).toEqual({ alertId: ALERT, watchId: WATCH, prospectId: PROSPECT,
      dedupeKey: `federal_award:rec-1:${FP}`, fingerprint: FP, sourceFamily: 'federal_award', recordId: 'rec-1', sourceRevision: 'rev-7' });
    expect(receipt.checkedAtMs).toBe(NOW);
    expect(Number.isSafeInteger(receipt.expiresAtMs)).toBe(true);
    expect(receipt.expiresAtMs).toBeGreaterThan(receipt.checkedAtMs);
    expect(receipt.expiresAtMs).toBeLessThanOrEqual(receipt.checkedAtMs + SOURCE_EVENT_RECEIPT_WINDOW_MS);
    expect(calls).toEqual(['alert', 'watch', 'sourceState', 'member', 'user', 'db_now', 'consent', 'revocation']);
  });

  it('reports the current owner membership and client wall from actual custody', async () => {
    const active = await readRoutineSourceEvent(scriptedTx().tx, request());
    expect(active.watch).toEqual({ ownerActorId: OWNER, status: 'active', membership: 'active', clientId: 'client-a', sourceState: 'current' });
    // A client the owner can no longer see is not an active member wall for this routine.
    wall.mockResolvedValueOnce([]);
    expect((await readRoutineSourceEvent(scriptedTx().tx, request())).watch.membership).toBe('inactive');
    // A dialled-down membership, a non-active tenant or a departed clerk identity is inactive.
    for (const member of [null, memberRow({ status: 'suspended' }), memberRow({ tenant: { status: 'suspended' } }),
      memberRow({ role: 'client_portal_user' }), memberRow({ role: 'viewer' })])
      expect((await readRoutineSourceEvent(scriptedTx({ member }).tx, request())).watch.membership).toBe('inactive');
    expect((await readRoutineSourceEvent(scriptedTx({ user: null }).tx, request())).watch.membership).toBe('inactive');
  });

  it('derives only source states custody can establish: current, revoked or superseded', async () => {
    expect((await readRoutineSourceEvent(scriptedTx().tx, request())).watch.sourceState).toBe('current');
    expect((await readRoutineSourceEvent(scriptedTx({ sourceState: null }).tx, request())).watch.sourceState).toBe('superseded');
    const dismissed = watchRow({ prospect: { id: PROSPECT, linkedClientId: 'client-a', dismissedAt: new Date(NOW) } });
    const receipt = await readRoutineSourceEvent(scriptedTx({ watch: dismissed }).tx, request());
    expect(receipt.watch.sourceState).toBe('revoked');
    expect(receipt.watch.clientId).toBeNull();
  });

  it('carries the exact saved consent, including its revoked and expired states', async () => {
    const active = await readRoutineSourceEvent(scriptedTx().tx, request());
    expect(active.consent.state).toBe('active');
    expect(active.consent.consentId).toBe(CONSENT);
    expect(active.expiresAtMs).toBeLessThanOrEqual(active.consent.expiresAtMs);
    const revoked = await readRoutineSourceEvent(scriptedTx({ revocation: { id: 'r1' } }).tx, request());
    expect(revoked.consent).toEqual({ consentId: CONSENT, state: 'revoked', expiresAtMs: NOW + 86_400_000 });
    const expired = await readRoutineSourceEvent(scriptedTx({ consent: consentRow({ expiresAt: new Date(NOW - 1) }) }).tx, request());
    expect(expired.consent).toEqual({ consentId: CONSENT, state: 'expired', expiresAtMs: NOW - 1 });
    const absent = await readRoutineSourceEvent(scriptedTx({ consent: null }).tx, request());
    expect(absent.consent).toEqual({ consentId: null, state: 'expired', expiresAtMs: 0 });
    expect(absent.expiresAtMs).toBeGreaterThan(absent.checkedAtMs);
  });

  it('refuses a claim Core custody cannot corroborate', async () => {
    await expect(readRoutineSourceEvent(scriptedTx({ alert: null }).tx, request())).rejects.toThrow(ConflictException);
    await expect(readRoutineSourceEvent(scriptedTx({ watch: null }).tx, request())).rejects.toThrow(ConflictException);
    await expect(readRoutineSourceEvent(scriptedTx({ watch: watchRow({ status: 'weird' }) }).tx, request())).rejects.toThrow(ConflictException);
    await expect(readRoutineSourceEvent(scriptedTx({ watch: watchRow({ ownerUserId: null }) }).tx, request())).rejects.toThrow(ConflictException);
    await expect(readRoutineSourceEvent(scriptedTx({ alert: { ...row(TENANT), sourceFamily: 'unknown_family' } }).tx, request())).rejects.toThrow(ConflictException);
  });

  it('uses the database clock for its window and never a caller instant', async () => {
    const { tx } = scriptedTx();
    const receipt = await readRoutineSourceEvent(tx, request());
    expect(receipt.checkedAtMs).toBe(await meriExecutionDbNow(tx));
  });
});
