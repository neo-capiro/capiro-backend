/**
 * Regression: confirmed contracting external_ids that are NOT federal_contractor
 * uuids (e.g. ops pins like `award-name:L3HARRIS…`) must not 500 client-profile.
 *
 * fetchContractorById used to cast every id with `${id}::uuid`. Postgres throws
 * 22P02 on synthetic ids and Nest surfaces that as HTTP 500 — blanking the
 * Federal footprint card on Overview.
 *
 * These tests exercise the pure helpers + the branching contract without
 * constructing the full Nest IntelligenceService graph.
 */
import { describe, expect, it } from '@jest/globals';

/** Mirror of IntelligenceService.isUuid — keep in sync. */
function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    id.trim(),
  );
}

/** Mirror of the name-key derivation in fetchContractorById. */
function contractorLookupKey(rawId: string): { mode: 'uuid' | 'name' | 'empty'; key: string | null } {
  const raw = (rawId ?? '').trim();
  if (!raw) return { mode: 'empty', key: null };
  if (isUuid(raw)) return { mode: 'uuid', key: raw };
  if (raw.startsWith('award-name:')) {
    return { mode: 'name', key: raw.slice('award-name:'.length).trim() };
  }
  return { mode: 'name', key: raw };
}

describe('contractor external_id lookup contract (federal footprint 500 guard)', () => {
  it('treats standard uuids as catalog ids', () => {
    expect(isUuid('0e042626-ecde-44b3-88f1-9c2aed31d910')).toBe(true);
    expect(contractorLookupKey('0e042626-ecde-44b3-88f1-9c2aed31d910')).toEqual({
      mode: 'uuid',
      key: '0e042626-ecde-44b3-88f1-9c2aed31d910',
    });
  });

  it('strips award-name: synthetic ids to an exact contractor name (no uuid cast)', () => {
    expect(isUuid('award-name:L3HARRIS TECHNOLOGIES, INC.')).toBe(false);
    expect(contractorLookupKey('award-name:L3HARRIS TECHNOLOGIES, INC.')).toEqual({
      mode: 'name',
      key: 'L3HARRIS TECHNOLOGIES, INC.',
    });
  });

  it('never routes a synthetic id down the uuid path', () => {
    const samples = [
      'award-name:HARRIS CORPORATION',
      'award-name:L3HARRIS TECHNOLOGIES INTEGRATED SYSTEMS L.P.',
      'not-a-uuid',
      '',
    ];
    for (const s of samples) {
      const k = contractorLookupKey(s);
      expect(k.mode).not.toBe('uuid');
    }
  });
});
