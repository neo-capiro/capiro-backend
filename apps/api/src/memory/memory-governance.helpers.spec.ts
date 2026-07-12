import {
  selectForPurge,
  selectForClientPurge,
  selectForUserPurge,
  selectForLegalHold,
  selectForExport,
  redactSections,
  toManifestRow,
} from './memory-governance.helpers.js';
import type { MemoryItem } from './memory.types.js';
import { MEMORY_SCHEMA_VERSION, defaultMemoryGovernanceFields } from './memory.types.js';

const TENANT = '11111111-1111-1111-1111-111111111111';

function item(over: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: 'i', tenantId: TENANT, clientId: 'acme', ownerUserId: null,
    type: 'thread', visibility: 'tenant', entityId: null, slug: 's', title: 't',
    aliases: [], tags: [], source: 'graph-email', sourceRef: 'r',
    provenance: `ingest@${MEMORY_SCHEMA_VERSION}`,
    sections: [
      { key: 'summary', heading: 'Summary', owner: 'engine', body: 'sensitive' },
      { key: 'analyst-notes', heading: 'Analyst notes', owner: 'human', body: 'keep' },
    ],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    schemaVersion: MEMORY_SCHEMA_VERSION,
    ...defaultMemoryGovernanceFields(), ...over,
  };
}

describe('memory governance (Phase 4)', () => {
  const now = new Date('2026-06-25T00:00:00.000Z');

  it('selects nothing when policy keeps forever', () => {
    expect(selectForPurge([item()], { maxAgeDays: null, types: [] }, now)).toEqual([]);
  });

  it('selects items older than maxAgeDays', () => {
    const old = item({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z' });
    const fresh = item({ id: 'fresh', createdAt: '2026-06-20T00:00:00.000Z' });
    const out = selectForPurge([old, fresh], { maxAgeDays: 30, types: [] }, now);
    expect(out.map((i) => i.id)).toEqual(['old']);
  });

  it('respects type filter in retention policy', () => {
    const t = item({ id: 'thr', type: 'thread', createdAt: '2025-01-01T00:00:00.000Z' });
    const m = item({ id: 'meri', type: 'meri-session', createdAt: '2025-01-01T00:00:00.000Z' });
    const out = selectForPurge([t, m], { maxAgeDays: 30, types: ['meri-session'] }, now);
    expect(out.map((i) => i.id)).toEqual(['meri']);
  });

  it('client offboarding purges all items scoped to that client', () => {
    const a = item({ id: 'a', clientId: 'acme' });
    const b = item({ id: 'b', clientId: 'beta' });
    expect(selectForClientPurge([a, b], 'acme').map((i) => i.id)).toEqual(['a']);
  });

  it('user offboarding purges only the user PRIVATE items (not firm-shared)', () => {
    const priv = item({ id: 'p', visibility: 'user', ownerUserId: 'u1', clientId: null });
    const shared = item({ id: 's', visibility: 'tenant', ownerUserId: null });
    const otherUser = item({ id: 'o', visibility: 'user', ownerUserId: 'u2', clientId: null });
    expect(selectForUserPurge([priv, shared, otherUser], 'u1').map((i) => i.id)).toEqual(['p']);
  });

  it('legal hold selects every item touching the client (preserve, not delete)', () => {
    const a = item({ id: 'a', clientId: 'acme' });
    const b = item({ id: 'b', clientId: 'acme', type: 'meeting' });
    const c = item({ id: 'c', clientId: 'beta' });
    expect(selectForLegalHold([a, b, c], 'acme').map((i) => i.id).sort()).toEqual(['a', 'b']);
  });

  it('redacts only the named section bodies', () => {
    const r = redactSections(item(), ['summary']);
    expect(r.sections.find((s) => s.key === 'summary')?.body).toBe('[redacted]');
    expect(r.sections.find((s) => s.key === 'analyst-notes')?.body).toBe('keep');
  });

  it('manifest row carries provenance for e-discovery', () => {
    const row = toManifestRow(item({ id: 'x', sourceRef: 'thr-9' }));
    expect(row.id).toBe('x');
    expect(row.sourceRef).toBe('thr-9');
    expect(row.provenance).toContain('ingest@');
  });

  // ── Phase 1 (1A): legal hold always wins, across every purge selector ──────
  describe('legal hold overrides every purge selector', () => {
    it('selectForPurge never selects a held item, however old', () => {
      const held = item({ id: 'held', legalHold: true, createdAt: '2020-01-01T00:00:00.000Z' });
      const notHeld = item({ id: 'free', legalHold: false, createdAt: '2020-01-01T00:00:00.000Z' });
      const out = selectForPurge([held, notHeld], { maxAgeDays: 30, types: [] }, now);
      expect(out.map((i) => i.id)).toEqual(['free']);
    });

    it('selectForClientPurge never selects a held item for that client', () => {
      const held = item({ id: 'held', clientId: 'acme', legalHold: true });
      const notHeld = item({ id: 'free', clientId: 'acme', legalHold: false });
      expect(selectForClientPurge([held, notHeld], 'acme').map((i) => i.id)).toEqual(['free']);
    });

    it('selectForUserPurge never selects a held private item for that user', () => {
      const held = item({ id: 'held', visibility: 'user', ownerUserId: 'u1', clientId: null, legalHold: true });
      const notHeld = item({ id: 'free', visibility: 'user', ownerUserId: 'u1', clientId: null, legalHold: false });
      expect(selectForUserPurge([held, notHeld], 'u1').map((i) => i.id)).toEqual(['free']);
    });
  });

  it('selectForExport excludes items explicitly marked non-exportable', () => {
    const yes = item({ id: 'yes', exportable: true });
    const no = item({ id: 'no', exportable: false });
    expect(selectForExport([yes, no]).map((i) => i.id)).toEqual(['yes']);
  });
});
