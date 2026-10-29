import { walk, resumeLargerDocumentPages, type WalkDeps } from './sync-tango-funding.js';
import { CatalogQuotaPause } from '../src/external/tango/funding-catalog.client.js';
import { catalogEmbeddingState, attachmentEmbeddingState } from '../src/external/tango/funding-embedding-state.js';
import { chunks, grantFields, noticeFields, noticeKey, samUrlKey, searchText, setAsideCode } from '../src/external/tango/funding-catalog.mapper.js';

describe('Tango canonical funding ingestion', () => {
  const key = 'a'.repeat(32);
  test('government identifiers normalize only UUID punctuation, never solicitation numbers', () => {
    expect(noticeKey('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).toBe(key);
    expect(() => noticeKey('FA-2026-123')).toThrow();
    expect(samUrlKey(`https://sam.gov/opp/${key}/view`)).toBe(key);
    expect(() => samUrlKey(`https://sam.gov.attacker.test/opp/${key}/view`)).toThrow();
  });
  test('rejects mismatched source URL and notice ID', () => {
    expect(() => noticeFields({ notice_id: key, sam_url: `https://sam.gov/opp/${'b'.repeat(32)}/view`, title: 'x' })).toThrow('Conflicting');
  });
  test('long official notice labels retain the legacy database display width', () => {
    const row = noticeFields({ notice_id: key, title: 'Bundling notice', meta: { notice_type: { code: 'i', type: 'Consolidate/(Substantially) Bundle' } } });
    expect(row.noticeType).toBe('Consolidate/(Substantially) Bund');
  });
  test('keeps false/zero values while omitting missing enrichment', () => {
    const row = grantFields({ grant_id: 123, title: 'Grant', status: { code: 'P' }, funding_details: { award_ceiling: 0 }, synopsis: { costSharing: false }, description: null });
    expect(row).toMatchObject({ awardCeiling: 0, costSharing: false, status: 'posted' });
    expect(row).not.toHaveProperty('description');
    expect(row).not.toHaveProperty('closeDate');
  });
  test('does not invent a grant status', () => {
    expect(() => grantFields({ grant_id: 1, title: 'x', status: { code: 'unknown' } })).toThrow();
  });
  test('forecast dates retain their estimated status and response explanation', () => {
    const row = grantFields({ grant_id: 1, title: 'Upcoming grant', status: 'F', important_dates: { estimated_application_response_date: '2027-01-12', estimated_application_response_date_description: 'Estimated deadline' } });
    expect(row.status).toBe('forecasted'); expect(row.closeDate).toEqual(new Date('2027-01-12')); expect(row.responseDateDesc).toBe('Estimated deadline');
  });
  test('exact set-aside labels map to codes without guessing unknown restrictions', () => {
    expect(setAsideCode('Service-Disabled Veteran-Owned Small Business Set Aside')).toBe('SDVOSBC');
    expect(setAsideCode('Total Small Business Set-Aside (FAR 19.5)')).toBe('SBA');
    expect(setAsideCode('Unknown custom restriction')).toBeNull(); expect(setAsideCode(undefined)).toBeUndefined();
  });
  test('embedding text removes markup and scripts while retaining inequalities', () => {
    expect(searchText('<p>Research &amp; development</p><script>junk()</script><p>Budget &#36;500</p>')).toBe('Research & development Budget $500');
    expect(searchText('Costs < 100 and quality > 90')).toBe('Costs < 100 and quality > 90');
  });
  test('chunks the complete long document and preserves offset coverage', () => {
    const body = 'abcdef '.repeat(10000).trim(), parts = chunks(body);
    expect(parts.length).toBeGreaterThan(10);
    expect(parts.at(-1)!.end).toBe(body.length);
    for (const part of parts) { expect(part.text.length).toBeLessThanOrEqual(6000); expect(part.text).toBe(body.slice(part.start, part.end)); }
    for (let i = 1; i < parts.length; i++) expect(parts[i]!.start).toBe(parts[i-1]!.end - 400);
  });
  test('Unicode characters remain whole at chunk and overlap boundaries', () => {
    const emoji = '\u{1f680}';
    const body = 'a'.repeat(5599) + emoji + 'b'.repeat(399) + emoji + 'c'.repeat(10000);
    for (const [size, overlap] of [[6000, 400], [2, 1], [3, 0]] as const) {
      const parts = chunks(body, size, overlap);
      expect(parts.at(-1)!.end).toBe(body.length);
      let end = 0;
      for (const part of parts) {
        expect(Buffer.from(part.text, 'utf8').toString('utf8')).toBe(part.text);
        expect(part.text).toBe(body.slice(part.start, part.end));
        expect(part.start).toBeLessThanOrEqual(end);
        expect(part.end).toBeGreaterThanOrEqual(end);
        expect(part.end).toBeGreaterThan(part.start);
        expect(part.text.length).toBeLessThanOrEqual(size);
        end = part.end;
      }
    }
    expect(searchText('invalid &#xD800; scalar')).toBe('invalid \ufffd scalar');
  });
  test('dense PDF glyphs stay within the byte budget without losing text or offsets', () => {
    const body = 'Drawing symbols: ' + '\ufffd\u25a0\u{1f680}'.repeat(6000);
    const parts = chunks(body);
    let end = 0, reconstructed = '';
    for (const part of parts) {
      expect(Buffer.byteLength(part.text, 'utf8')).toBeLessThanOrEqual(6000);
      expect(part.text.length).toBeLessThanOrEqual(6000);
      expect(Buffer.from(part.text, 'utf8').toString('utf8')).toBe(part.text);
      expect(part.text).toBe(body.slice(part.start, part.end));
      expect(part.start).toBeLessThanOrEqual(end);
      expect(part.end).toBeGreaterThan(end);
      reconstructed += part.text.slice(end - part.start);
      end = part.end;
    }
    expect(reconstructed).toBe(body);
    expect(end).toBe(body.length);
    expect(chunks('x'.repeat(12000)).map(p => [p.start,p.end])).toEqual([[0,6000],[5600,11600],[11200,12000]]);
  });
  function deps(): WalkDeps {
    return { read: jest.fn(async () => null), page: jest.fn(async () => ({ count: 2, results: [{ id: 1 }], next: 'https://tango.dev/api/grants/?page=2' })), write: jest.fn(async () => undefined), checkpoint: jest.fn(async () => undefined) };
  }
  test('unchanged observations preserve embedding freshness, while text changes always invalidate it', () => {
    const previous = new Date('2026-10-20'), now = new Date('2026-10-24');
    const row = { title: 'Same title', description: 'Same body', embeddedContentHash: 'hash', embeddedAt: previous, syncedAt: previous };
    expect(catalogEmbeddingState(row, { status: 'closed', raw: { observation: 'new' } }, 'grant', now)).toEqual({ embeddedAt: now });
    expect(catalogEmbeddingState({ ...row, embeddedAt: new Date('2027-01-01') }, { description: 'Amended body' }, 'grant', now)).toEqual({ embeddedAt: null });
    expect(catalogEmbeddingState({ ...row, embeddedAt: new Date('2026-10-19') }, {}, 'grant', now)).toEqual({});
    expect(catalogEmbeddingState({ ...row, embeddedContentHash: null }, {}, 'grant', now)).toEqual({});
  });
  test('paid document freshness includes its source binding and extraction metadata', () => {
    const previous = new Date('2026-10-20'), now = new Date('2026-10-24');
    const row = { providerData: { extracted_text: 'Complete paid document text', doc_role: 'requirement' },
      sourceUrl: 'https://sam.gov/file', samOpportunityId: 'notice-1', embeddedContentHash: 'hash', embeddedAt: previous, providerObservedAt: previous };
    expect(attachmentEmbeddingState(row, {}, now)).toEqual({ embeddedAt: now });
    expect(attachmentEmbeddingState(row, { samOpportunityId: 'notice-2' }, now)).toEqual({ embeddedAt: null });
    expect(attachmentEmbeddingState(row, { providerData: { ...row.providerData, doc_role: 'instructions' } }, now)).toEqual({ embeddedAt: null });
    expect(attachmentEmbeddingState(row, { providerData: {} }, now)).toEqual({ embeddedAt: null });
  });
  test('dry-run makes no checkpoint writes', async () => {
    const d = deps();
    expect(await walk(d, { commit: false, maxPages: 1, incremental: false })).toEqual({ processed: 1, complete: false });
    expect(d.checkpoint).not.toHaveBeenCalled();
  });
  test('recent documents start with a short refresh window, independently of rolling backfill', async () => {
    const d = deps();
    await walk(d, { commit: false, maxPages: 1, incremental: true, initialLookbackDays: 3, now: new Date('2026-10-24T00:00:00Z') });
    expect(d.page).toHaveBeenCalledWith(1, new Date('2026-10-21T00:00:00Z'), new Date('2026-10-24T00:00:00Z'));
  });
  test('a failed row prevents page advancement', async () => {
    const d = deps(); d.write = jest.fn(async () => { throw new Error('database unavailable'); });
    await expect(walk(d, { commit: true, maxPages: 1, incremental: false })).rejects.toThrow('database unavailable');
    expect(d.checkpoint).not.toHaveBeenCalled();
  });
  test('a failed row waits for other in-flight writes before releasing the caller', async () => {
    const d = deps(); let finish!: () => void, rejected = false;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    d.page = jest.fn(async () => ({ count: 2, results: [{id:1},{id:2}], next: null }));
    d.write = jest.fn(async row => { if (row.id === 1) throw new Error('row failed'); await pending; });
    const result = walk(d, { commit: true, maxPages: 1, incremental: false }).catch(error => { rejected = true; return error; });
    await new Promise(resolve => setImmediate(resolve));
    expect(rejected).toBe(false);
    finish(); expect((await result).message).toBe('row failed');
    expect(d.checkpoint).not.toHaveBeenCalled();
  });
  test('resumes the original window and advances only after successful writes', async () => {
    const d = deps(), start = new Date('2026-10-01'), end = new Date('2026-10-14');
    d.read = jest.fn(async () => ({ cursor: '3', windowStart: start, windowEnd: end }));
    d.page = jest.fn(async () => ({ count: 3, results: [{ id: 3 }], next: null }));
    expect(await walk(d, { commit: true, maxPages: 1, incremental: true, now: new Date('2026-11-01') })).toEqual({ processed: 1, complete: true });
    expect(d.page).toHaveBeenCalledWith(3, start, end);
    expect(d.checkpoint).toHaveBeenCalledWith(null, start, end, 1);
  });
  test('quota exhaustion is incomplete and retains the durable cursor', async () => {
    const d = deps(); d.page = jest.fn(async () => { throw new CatalogQuotaPause(); });
    expect(await walk(d, { commit: true, maxPages: 2, incremental: false })).toEqual({ processed: 0, complete: false });
    expect(d.checkpoint).not.toHaveBeenCalled();
  });
  test('larger document pages resume before the old offset without losing the source window', async () => {
    const d = deps(), start = new Date('2026-10-01'), end = new Date('2026-10-14');
    const saved = resumeLargerDocumentPages({ cursor: '123', windowStart: start, windowEnd: end });
    d.read = jest.fn(async () => saved);
    d.page = jest.fn(async () => ({ count: 2500, results: Array.from({length:100}, (_,i) => ({id:2400+i})), next: null }));
    expect(await walk(d, { commit: true, maxPages: 1, incremental: false })).toEqual({ processed: 100, complete: true });
    expect(d.page).toHaveBeenCalledWith(25, start, end);
    expect(d.write).toHaveBeenCalledWith({id:2440});
    expect(d.write).toHaveBeenCalledWith({id:2499});
    expect(() => resumeLargerDocumentPages({ cursor: 'invalid', windowStart: start, windowEnd: end })).toThrow('legacy document cursor');
  });
  test('does not accept a provider silently jumping over a page', async () => {
    const d = deps(); d.page = jest.fn(async () => ({ count: 5, results: [{ id: 1 }], next: 'https://tango.dev/api/grants/?page=4' }));
    await expect(walk(d, { commit: true, maxPages: 1, incremental: false })).rejects.toThrow('progression');
    expect(d.checkpoint).not.toHaveBeenCalled();
  });
});
