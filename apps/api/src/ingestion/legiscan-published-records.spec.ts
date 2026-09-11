import { publishedRecords, reportSourceFacts } from './legiscan-published-records.js';
import type { LegiscanBill } from '../external/legiscan/legiscan.client.js';

const raw = {
  history: [
    { date: '2026-06-01', action: 'Introduced', chamber: 'H' },
    { date: '2026-06-01', action: 'Referred', chamber: 'H' },
  ],
  amendments: [
    { amendment_id: 10, title: 'Amendment A', adopted: 0, date: '0000-00-00' },
    { amendment_id: 11, title: 'Amendment B', adopted: 0, date: '2026-06-01' },
  ],
  state_link: 'https://example.gov/bill',
} as LegiscanBill;
describe('published-record ingestion', () => {
  it('retains two same-day actions and two amendments; replay is stable and reorder preserves identity', () => {
    const records = publishedRecords(raw);
    expect(records).toHaveLength(4);
    expect(new Set(records.map((r) => r.sourceIdentity)).size).toBe(4);
    expect(publishedRecords(raw)).toEqual(records);
    expect(
      publishedRecords({ ...raw, history: [...raw.history!].reverse() })
        .map((r) => r.sourceIdentity)
        .sort(),
    ).toEqual(records.map((r) => r.sourceIdentity).sort());
  });
  it('attributes amendment revisions and keeps missing dates unknown', () => {
    const original = publishedRecords(raw)[2]!;
    const changed = publishedRecords({
      ...raw,
      amendments: [{ ...raw.amendments![0]!, adopted: 1 }],
    })[2]!;
    expect(changed.sourceIdentity).toBe(original.sourceIdentity);
    expect(changed.revisionHash).not.toBe(original.revisionHash);
    expect(original.eventDate).toBeNull();
  });
  it('distinguishes unavailable optional arrays from a successfully checked empty list', () => {
    expect(reportSourceFacts(raw).coverage.committees).toBe(false);
    expect(reportSourceFacts({ ...raw, referrals: [], sasts: [] }).coverage).toEqual({
      actions: true,
      amendments: true,
      committees: true,
      relations: true,
    });
  });
});
