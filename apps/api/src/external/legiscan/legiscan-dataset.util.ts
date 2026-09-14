/**
 * Parse a LegiScan bulk-dataset ZIP (getDataset's base64 `zip`) into its
 * per-bill/per-person/per-vote JSON entries. The dataset's bill/vote JSON
 * files carry the SAME shape as the corresponding Pull API operations
 * (getBill / getRollCall) per LegiScan's dataset documentation — this is what
 * lets `normalizeLegiscanBill` process both paths identically (S1.4).
 *
 * NOTE (flagged, not guessed): the exact top-level wrapper key inside each
 * dataset JSON file (e.g. `{bill: {...}}` vs an unwrapped object) is
 * documented by LegiScan but not independently verified here against a live
 * download (no LEGISCAN_API_KEY available in this environment). This parser
 * therefore tries the documented wrapper key first and falls back to treating
 * the file itself as the record, logging + skipping (never throwing) on a
 * genuine shape mismatch. Per the Phase 0 plan's own week-1 validation items
 * (amendments fields, quota arithmetic), CONFIRM this against one real
 * `backfill-legiscan-datasets` run on a pilot state (TX) before trusting the
 * skip count to be zero.
 */
import type { LegiscanBill, LegiscanPerson, LegiscanRollCall } from './legiscan.client.js';
import type { Readable } from 'node:stream';

export interface ParsedDataset {
  bills: LegiscanBill[];
  people: LegiscanPerson[];
  votes: LegiscanRollCall[];
  skipped: { bills: number; people: number; votes: number };
}

function unwrap<T>(json: unknown, wrapperKeys: string[], requiredField: string): T | null {
  if (json && typeof json === 'object') {
    for (const key of wrapperKeys) {
      const wrapped = (json as Record<string, unknown>)[key];
      if (wrapped && typeof wrapped === 'object' && requiredField in (wrapped as object)) {
        return wrapped as T;
      }
    }
    if (requiredField in (json as object)) return json as T;
  }
  return null;
}

/** Parse a LegiScan bulk dataset ZIP (already base64-decoded to a Buffer). */
export async function parseDatasetZip(zipBuffer: Buffer): Promise<ParsedDataset> {
  if (zipBuffer.length > 120_000_000) throw Error('DATASET_COMPRESSED_SIZE_LIMIT');
  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(zipBuffer);

  const bills: LegiscanBill[] = [];
  const people: LegiscanPerson[] = [];
  const votes: LegiscanRollCall[] = [];
  const skipped = { bills: 0, people: 0, votes: 0 };

  const entries = Object.values(zip.files).filter((f) => !f.dir && f.name.endsWith('.json'));
  if (Object.keys(zip.files).length > 50000) throw Error('DATASET_ENTRY_LIMIT');
  for (const entry of Object.values(zip.files)) {
    const original =
      (entry as typeof entry & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
    if (
      original.startsWith('/') ||
      original.includes('\\') ||
      /^[A-Za-z]:/.test(original) ||
      original.split('/').includes('..') ||
      original.includes('\0')
    )
      throw Error('DATASET_UNSAFE_ENTRY_PATH');
  }
  let expanded = 0;
  for (const entry of entries) {
    const lowerPath = entry.name.toLowerCase();
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0,
        failed = false;
      const stream = entry.nodeStream('nodebuffer') as Readable;
      stream
        .on('data', (chunk: Buffer) => {
          if (failed) return;
          size += chunk.length;
          expanded += chunk.length;
          if (size > 10_000_000 || expanded > 512_000_000) {
            failed = true;
            stream.destroy();
            reject(Error('DATASET_EXPANSION_LIMIT'));
            return;
          }
          chunks.push(chunk);
        })
        .on('error', reject)
        .on('end', () => {
          if (!failed) resolve(Buffer.concat(chunks));
        });
    });
    const text = bytes.toString('utf8');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      if (lowerPath.includes('/bill/')) skipped.bills++;
      else if (lowerPath.includes('/people/')) skipped.people++;
      else if (lowerPath.includes('/vote/')) skipped.votes++;
      continue;
    }

    if (lowerPath.includes('/bill/')) {
      const bill = unwrap<LegiscanBill>(json, ['bill'], 'bill_id');
      if (bill) bills.push(bill);
      else skipped.bills++;
    } else if (lowerPath.includes('/people/')) {
      const person = unwrap<LegiscanPerson>(json, ['person', 'people'], 'people_id');
      if (person) people.push(person);
      else skipped.people++;
    } else if (lowerPath.includes('/vote/')) {
      const rollCall = unwrap<LegiscanRollCall>(json, ['roll_call', 'vote'], 'roll_call_id');
      if (rollCall) votes.push(rollCall);
      else skipped.votes++;
    }
  }

  return { bills, people, votes, skipped };
}
