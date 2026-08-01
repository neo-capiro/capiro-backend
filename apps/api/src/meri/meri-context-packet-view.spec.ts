import { describe, expect, it } from '@jest/globals';
import { contextPacketView } from './meri-context-packet-view.js';

/**
 * The Context Inspector API contract (apps/web/src/components/trust/
 * ContextInspector.tsx).
 *
 * Two properties matter most here:
 *   1. **Withheld-item privacy.** A withholding the caller is not cleared to know
 *      about must be COUNTED and never listed — not by id, not by type, and
 *      certainly not with any excerpt of its content.
 *   2. **v1 output does not change.** Everything v2 adds is derived from fields
 *      only a v2 item/row carries, so a v1 packet renders exactly as it does today.
 */
const CREATED = new Date('2026-07-29T12:00:00.000Z');

const V1_ROW = {
  id: 'packet-1',
  surface: 'chat',
  clientId: null,
  createdAt: CREATED,
  items: [
    { layer: 'firm-identity', id: 'mi-1', type: 'firm-soul', slug: 'firm', rationale: 'Firm soul' },
    { layer: 'user-voice', id: 'mi-2', type: 'user-voice', slug: 'me', rationale: 'Voice' },
  ] as unknown as never,
  exclusions: [
    { layer: 'firm-identity', id: 'mi-3', type: 'firm-compass', slug: 'firm', reason: 'revoked' },
  ] as unknown as never,
};

describe('contextPacketView — v1 output is unchanged', () => {
  it('projects items, scopes and exclusions exactly as before', () => {
    const view = contextPacketView(V1_ROW);
    expect(view).toEqual({
      packetId: 'packet-1',
      persisted: true,
      persistenceErrorCode: null,
      compiledAt: '2026-07-29T12:00:00.000Z',
      surface: 'chat',
      clientId: null,
      items: [
        {
          id: 'mi-1',
          label: 'firm-soul',
          type: 'firm-soul',
          scope: 'firm',
          authority: 'human-authored',
          userScoped: false,
          rationale: 'Firm soul',
          selection: 'automatic',
        },
        {
          id: 'mi-2',
          label: 'user-voice',
          type: 'user-voice',
          scope: 'personal',
          authority: 'human-authored',
          userScoped: true,
          rationale: 'Voice',
          selection: 'automatic',
        },
      ],
      exclusions: [
        { id: 'mi-3', label: 'firm-compass', type: 'firm-compass', reason: 'revoked' },
      ],
      unauthorizedCount: 0,
      degraded: false,
    });
  });

  it('never claims degradation for a v1 row even when the v2 columns are absent', () => {
    expect(contextPacketView(V1_ROW).degraded).toBe(false);
    // packet_version 1 with a health blob (impossible in practice) still reports v1.
    expect(
      contextPacketView({ ...V1_ROW, packetVersion: 1, health: { status: 'degraded' } as never })
        .degraded,
    ).toBe(false);
  });
});

describe('contextPacketView — withheld-item privacy', () => {
  const withheldRow = {
    ...V1_ROW,
    packetVersion: 2,
    health: { status: 'healthy', reasons: [] } as never,
    exclusions: [
      // Identity-stripped by the compiler: no id, no type, no slug.
      { layer: 'firm-identity', reason: 'unauthorized' },
      { layer: 'client-steering', reason: 'wrong-client' },
      { layer: 'firm-identity', reason: 'sensitivity-denied' },
      // A lifecycle exclusion the caller may legitimately see.
      { layer: 'firm-identity', id: 'mi-9', type: 'firm-compass', reason: 'revoked' },
    ] as unknown as never,
  };

  it('counts ALL THREE identity-withheld reasons, not just "unauthorized"', () => {
    expect(contextPacketView(withheldRow).unauthorizedCount).toBe(3);
  });

  it('lists only the lifecycle exclusion, never a withheld one', () => {
    const view = contextPacketView(withheldRow);
    expect(view.exclusions).toEqual([
      { id: 'mi-9', label: 'firm-compass', type: 'firm-compass', reason: 'revoked' },
    ]);
    const serialized = JSON.stringify(view.exclusions);
    for (const reason of ['unauthorized', 'wrong-client', 'sensitivity-denied']) {
      expect(serialized).not.toContain(reason);
    }
  });

  it('leaks no confidential content even if a body somehow reached the stored exclusion', () => {
    const view = contextPacketView({
      ...withheldRow,
      exclusions: [
        {
          layer: 'client-steering',
          id: 'mi-secret',
          type: 'client-compass',
          reason: 'sensitivity-denied',
          safeDetail: 'Merger with Acme closes in Q4',
        },
      ] as unknown as never,
    });
    expect(view.exclusions).toEqual([]);
    expect(view.unauthorizedCount).toBe(1);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('mi-secret');
    expect(serialized).not.toContain('client-compass');
    expect(serialized).not.toContain('Merger with Acme');
  });
});

describe('contextPacketView — v2 evidence is real, not fabricated', () => {
  const v2Row = {
    id: 'packet-2',
    surface: 'in-editor',
    clientId: 'client-1',
    createdAt: CREATED,
    packetVersion: 2,
    health: {
      status: 'degraded',
      missingRequiredLayers: ['client-people'],
      conflictCount: 0,
      sourceFailureCount: 1,
      reasons: ['Missing required layers: client-people', '1 source failure(s)'],
    } as never,
    items: [
      {
        layer: 'firm-identity',
        id: 'mi-1',
        type: 'firm-soul',
        slug: 'firm',
        title: 'Firm Soul',
        scope: 'firm',
        authority: 'model_inferred',
        status: 'stale',
        legacyStatus: 'active',
        selectionTier: 'episodic_inferred',
        inclusionReason: 'Scored 0.41',
        asOf: '2026-07-01T00:00:00.000Z',
        lastConfirmedAt: '2026-07-02T00:00:00.000Z',
      },
      {
        layer: 'client-steering',
        id: 'mi-2',
        type: 'client-compass',
        slug: 'acme',
        title: 'Acme Compass',
        scope: 'client',
        authority: 'client_approved',
        status: 'active',
        legacyStatus: 'active',
        selectionTier: 'explicit',
        inclusionReason: 'Selected by user',
      },
    ] as unknown as never,
    exclusions: [] as unknown as never,
  };

  it('reports the item\'s real authority instead of asserting "human-authored"', () => {
    const view = contextPacketView(v2Row, 'Acme Corp');
    expect(view.items[0]).toEqual(
      expect.objectContaining({
        label: 'Firm Soul',
        authority: 'model_inferred',
        status: 'stale',
        selection: 'automatic',
        rationale: 'Scored 0.41',
        asOf: '2026-07-01T00:00:00.000Z',
        lastConfirmedAt: '2026-07-02T00:00:00.000Z',
      }),
    );
  });

  it('reports user-selected items as "explicit" and resolves the client name', () => {
    const view = contextPacketView(v2Row, 'Acme Corp');
    expect(view.items[1]).toEqual(
      expect.objectContaining({
        scope: 'client',
        clientName: 'Acme Corp',
        authority: 'client_approved',
        status: 'active',
        selection: 'explicit',
      }),
    );
  });

  it('derives degraded + the reason from the packet health, not a hardcoded false', () => {
    const view = contextPacketView(v2Row);
    expect(view.degraded).toBe(true);
    expect(view.degradedReason).toBe(
      'Missing required layers: client-people; 1 source failure(s)',
    );
  });

  it('reports an unrecognised authority as "unknown" rather than echoing the slug', () => {
    const view = contextPacketView({
      ...v2Row,
      items: [
        { layer: 'firm-identity', id: 'mi-1', type: 'firm-soul', authority: 'wat_is_this' },
      ] as unknown as never,
    });
    expect(view.items[0]!.authority).toBe('unknown');
  });

  it('is healthy-quiet: a healthy v2 packet is not degraded', () => {
    const view = contextPacketView({
      ...v2Row,
      health: { status: 'healthy', reasons: [] } as never,
    });
    expect(view.degraded).toBe(false);
    expect(view.degradedReason).toBeUndefined();
  });
});
