import { describe, expect, test } from 'vitest';
import { persistedMeriTurnScope, messageMeriTurnScope, meriTurnScopeLabel, meriPacketScopeLabel, readMeriTurnScope } from './meri-turn-scope.js';

describe('Meri historical scope hydration', () => {
  test('parses and labels a valid prospect receipt', () => {
    const scope = readMeriTurnScope({
      kind: 'prospect',
      clientId: null,
      clientName: null,
      targetHint: null,
      prospectId: '11111111-1111-4111-8111-111111111111',
      prospectName: 'Acme LLC',
      canonicalOrganizationId: null,
      linkedClientId: '22222222-2222-4222-8222-222222222222',
      scopeVersion: 'a'.repeat(64),
    });
    expect(scope?.kind).toBe('prospect');
    expect(scope?.linkedClientId).toBe('22222222-2222-4222-8222-222222222222');
    expect(meriTurnScopeLabel(scope)).toBe('Prospect · Acme LLC');
  });

  test.each([
    ['bad prospect id', { prospectId: 'not-a-uuid' }],
    ['empty name', { prospectName: ' ' }],
    ['oversized name', { prospectName: 'x'.repeat(201) }],
    ['bad scope version', { scopeVersion: 'a'.repeat(63) }],
    ['bad canonical id', { canonicalOrganizationId: 'wrong' }],
    ['bad linked client id', { linkedClientId: 'wrong' }],
  ])('rejects malformed prospect receipt: %s', (_label, override) => {
    expect(readMeriTurnScope({
      kind: 'prospect',
      prospectId: '11111111-1111-4111-8111-111111111111',
      prospectName: 'Acme LLC',
      canonicalOrganizationId: null,
      linkedClientId: null,
      scopeVersion: 'a'.repeat(64),
      ...override,
    })).toBeUndefined();
  });

  test('restores a named server scope receipt, ignoring changed message/client metadata', () => {
    const turnScope = { kind: 'client', clientId: 'l3', clientName: 'L3 Harris', targetHint: null };
    const restored = persistedMeriTurnScope(JSON.parse(JSON.stringify({ clientId: 'anduril', metadata: { turnScope } })));
    expect(restored).toEqual(turnScope);
    expect(meriTurnScopeLabel(restored, [{ id: 'l3', name: 'Renamed later' }])).toBe('L3 Harris');
  });
  test('uses legacy packet identity and never a target hint as a client identity', () => {
    const restored = persistedMeriTurnScope({ clientId: 'l3', metadata: {
      retrieval: { plan: { subjectScope: 'client', targetHint: 'L3 Harris' } }, contextPacket: { clientId: 'anduril' },
    } });
    expect(restored).toMatchObject({ kind: 'client', clientId: 'anduril', clientName: null });
    expect(meriTurnScopeLabel(restored, [{ id: 'l3', name: 'L3 Harris' }, { id: 'anduril', name: 'Anduril' }])).toBe('Anduril');
  });
  test('restores portfolio, general and explicit external turns independently of selected-client metadata', () => {
    for (const [kind, label] of [['portfolio', 'Portfolio — all clients'], ['general', 'General'], ['external_entity', 'External subject · Anduril']]) {
      const restored = persistedMeriTurnScope({ clientId: 'l3', metadata: {
        retrieval: { plan: { subjectScope: kind, targetHint: 'Anduril' } }, contextPacket: { clientId: 'l3' },
      } });
      expect(meriTurnScopeLabel(restored)).toBe(label);
    }
  });
  test('leaves legacy absent/malformed scope unknown, including client retrieval without a durable identity', () => {
    for (const message of [{}, { clientId: 'l3' }, { metadata: { retrieval: { plan: { subjectScope: 'client' } } } },
      { clientId: 'l3', metadata: { retrieval: { plan: { subjectScope: 'client' } }, contextPacket: { clientId: null } } }]) {
      expect(meriTurnScopeLabel(persistedMeriTurnScope(message))).toBe('Scope not recorded');
    }
    expect(readMeriTurnScope({ kind: 'client', clientName: 'L3 Harris' })).toBeUndefined();
    expect(meriTurnScopeLabel(messageMeriTurnScope({}))).toBe('Scope not recorded');
  });
  test('does not call an unscoped context packet portfolio or substitute an unrelated client', () => {
    expect(meriPacketScopeLabel({ clientId: 'anduril', items: [] }, [{ id: 'l3', name: 'L3 Harris' }])).toBe('Client · anduril');
    expect(meriPacketScopeLabel({ clientId: null })).toBe('Firm / personal context');
    expect(meriPacketScopeLabel({})).toBe('Scope not recorded');
  });
});
