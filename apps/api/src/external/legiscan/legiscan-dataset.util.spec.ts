import JSZip from 'jszip';
import { parseDatasetZip } from './legiscan-dataset.util.js';

/**
 * W0.6 (2026-07-10 hot-fix, S1-D): the dataset parser had zero test
 * coverage. Constructs small in-memory ZIPs (no live LEGISCAN_API_KEY /
 * network dependency) to exercise the wrapped/unwrapped shape fallback and
 * the never-throws skip-counting the file's own header comment describes.
 */

async function buildZip(entries: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(entries)) {
    zip.file(path, content);
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('parseDatasetZip', () => {
  it('parses a wrapped bill entry ({bill: {...}})', async () => {
    const zip = await buildZip({
      'TX/2025/bill/HB1234.json': JSON.stringify({ bill: { bill_id: 42, title: 'An act' } }),
    });
    const r = await parseDatasetZip(zip);
    expect(r.bills).toHaveLength(1);
    expect(r.bills[0]?.bill_id).toBe(42);
    expect(r.skipped.bills).toBe(0);
  });

  it('falls back to an UNWRAPPED bill entry (the file itself is the record)', async () => {
    const zip = await buildZip({
      'TX/2025/bill/HB1234.json': JSON.stringify({ bill_id: 99, title: 'Unwrapped' }),
    });
    const r = await parseDatasetZip(zip);
    expect(r.bills).toHaveLength(1);
    expect(r.bills[0]?.bill_id).toBe(99);
  });

  it('parses people under BOTH documented wrapper keys (person, people)', async () => {
    const zip = await buildZip({
      'TX/2025/people/1.json': JSON.stringify({ person: { people_id: 1 } }),
      'TX/2025/people/2.json': JSON.stringify({ people: { people_id: 2 } }),
    });
    const r = await parseDatasetZip(zip);
    expect(r.people.map((p) => p.people_id).sort()).toEqual([1, 2]);
    expect(r.skipped.people).toBe(0);
  });

  it('parses votes under BOTH documented wrapper keys (roll_call, vote)', async () => {
    const zip = await buildZip({
      'TX/2025/vote/1.json': JSON.stringify({ roll_call: { roll_call_id: 1 } }),
      'TX/2025/vote/2.json': JSON.stringify({ vote: { roll_call_id: 2 } }),
    });
    const r = await parseDatasetZip(zip);
    expect(r.votes.map((v) => v.roll_call_id).sort()).toEqual([1, 2]);
    expect(r.skipped.votes).toBe(0);
  });

  it('NEVER THROWS on malformed JSON — increments the correct skip counter by path', async () => {
    const zip = await buildZip({
      'TX/2025/bill/broken.json': '{not valid json',
      'TX/2025/people/broken.json': '{not valid json',
      'TX/2025/vote/broken.json': '{not valid json',
    });
    const r = await parseDatasetZip(zip);
    expect(r.skipped).toEqual({ bills: 1, people: 1, votes: 1 });
    expect(r.bills).toHaveLength(0);
  });

  it('a bill entry missing the required bill_id field is skipped, not thrown', async () => {
    const zip = await buildZip({
      'TX/2025/bill/incomplete.json': JSON.stringify({ bill: { title: 'no id' } }),
    });
    const r = await parseDatasetZip(zip);
    expect(r.bills).toHaveLength(0);
    expect(r.skipped.bills).toBe(1);
  });

  it('ignores non-JSON and unrecognized-path entries entirely (no skip increment)', async () => {
    const zip = await buildZip({
      'TX/2025/readme.txt': 'not json',
      'TX/2025/other/thing.json': JSON.stringify({ some: 'unrelated' }),
    });
    const r = await parseDatasetZip(zip);
    expect(r.skipped).toEqual({ bills: 0, people: 0, votes: 0 });
    expect(r.bills).toHaveLength(0);
    expect(r.people).toHaveLength(0);
    expect(r.votes).toHaveLength(0);
  });

  it('handles a mixed real-shaped dataset (multiple bills/people/votes together)', async () => {
    const zip = await buildZip({
      'TX/2025/bill/1.json': JSON.stringify({ bill: { bill_id: 1 } }),
      'TX/2025/bill/2.json': JSON.stringify({ bill: { bill_id: 2 } }),
      'TX/2025/people/1.json': JSON.stringify({ person: { people_id: 1 } }),
      'TX/2025/vote/1.json': JSON.stringify({ roll_call: { roll_call_id: 1 } }),
    });
    const r = await parseDatasetZip(zip);
    expect(r.bills).toHaveLength(2);
    expect(r.people).toHaveLength(1);
    expect(r.votes).toHaveLength(1);
    expect(r.skipped).toEqual({ bills: 0, people: 0, votes: 0 });
  });
});
