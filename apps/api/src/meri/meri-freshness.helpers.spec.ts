import {
  STALE_AFTER_DAYS,
  buildMarkupFreshnessNotes,
} from './meri-freshness.helpers.js';

describe('buildMarkupFreshnessNotes', () => {
  const now = new Date('2026-06-28T00:00:00Z');

  it('emits a note for a null markup field (the SASC case)', () => {
    const notes = buildMarkupFreshnessNotes(
      '0207179F',
      [
        { label: 'HASC mark', value: 51_500_000 },
        { label: 'SASC mark', value: null },
      ],
      '2026-06-25T00:00:00Z',
      now,
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]?.field).toBe('SASC mark');
    expect(notes[0]?.message).toContain('0207179F');
    expect(notes[0]?.message).toContain('not recorded in Capiro');
    expect(notes[0]?.message).toContain('2026-06-25');
  });

  it('emits no notes when all markup fields are present', () => {
    const notes = buildMarkupFreshnessNotes(
      '0207179F',
      [
        { label: 'HASC mark', value: 51_500_000 },
        { label: 'SASC mark', value: 49_000_000 },
      ],
      '2026-06-25T00:00:00Z',
      now,
    );
    expect(notes).toHaveLength(0);
  });

  it('adds a stale warning when last sync is older than the threshold', () => {
    const old = new Date(now.getTime() - (STALE_AFTER_DAYS + 5) * 86_400_000);
    const notes = buildMarkupFreshnessNotes(
      '0207179F',
      [{ label: 'SASC mark', value: null }],
      old,
      now,
    );
    expect(notes[0]?.message.toLowerCase()).toContain('stale');
  });

  it('does NOT add a stale warning when sync is recent', () => {
    const notes = buildMarkupFreshnessNotes(
      '0207179F',
      [{ label: 'SASC mark', value: null }],
      '2026-06-25T00:00:00Z',
      now,
    );
    expect(notes[0]?.message.toLowerCase()).not.toContain('stale');
  });

  it('handles an unknown last-sync date (treats as stale, unknown as-of)', () => {
    const notes = buildMarkupFreshnessNotes(
      '0207179F',
      [{ label: 'SASC mark', value: undefined }],
      null,
      now,
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]?.message).toContain('an unknown date');
    expect(notes[0]?.message.toLowerCase()).toContain('stale');
  });
});
