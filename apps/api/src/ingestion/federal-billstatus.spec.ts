import JSZip from 'jszip';
import {
  federalHash,
  inspectFrozenFederalBillStatus,
  normalizeFederalVersions,
  parseFederalBillStatusXml,
  normalizeFederalCosponsors,
  qualifiedFederalTextUrl,
} from './federal-billstatus';
import { enrichFederalBulkMetadata } from './federal-billstatus-import';

const xml = (inside = '') =>
  `<billStatus><bill><congress>119</congress><type>HR</type><number>1</number><introducedDate>2025-01-01</introducedDate><updateDate>2026-01-01T00:00:00Z</updateDate><actions><item><actionDate>2026-02-01</actionDate></item></actions>${inside}</bill></billStatus>`;
const scope = { congress: 119, billType: 'hr' as const };
describe('frozen federal BILLSTATUS adapter', () => {
  it('admits by action and keeps null dates, every format and actual PLAW collection', () => {
    const bill = parseFederalBillStatusXml(
      xml(
        `<textVersions><item><type>Enrolled Bill</type><date/><formats><item><type>United States Legislative Markup</type><url>https://www.govinfo.gov/content/pkg/BILLS-119hr1enr/uslm/BILLS-119hr1enr.xml</url></item></formats></item><item><type>Public Law</type><date>2026-01-03</date><formats><item><url>https://www.govinfo.gov/content/pkg/PLAW-119publ1/pdf/PLAW-119publ1.pdf</url></item></formats></item></textVersions>`,
      ),
      scope,
    );
    expect(bill.eligible).toBe(true);
    expect(bill.versions).toHaveLength(2);
    expect(bill.versions[0]).toMatchObject({ date: null, collection: 'BILLS', versionCode: 'enr' });
    expect(bill.versions[1]).toMatchObject({
      collection: 'PLAW',
      packageId: 'PLAW-119publ1',
      versionCode: null,
    });
    expect(
      parseFederalBillStatusXml(xml().replace('2026-02-01', '2025-09-31'), scope).eligible,
    ).toBe(false);
  });
  it('retains unavailable version stubs instead of converting them to an empty list', () => {
    const bill = parseFederalBillStatusXml(
      xml('<textVersions><item><type>Introduced</type><date/></item></textVersions>'),
      scope,
    );
    expect(bill.versions).toEqual([
      expect.objectContaining({
        formats: [],
        date: null,
        packageId: null,
        sourceUrl: null,
        versionCode: null,
      }),
    ]);
  });
  it('rejects wrong subject identity, unsafe URLs, malformed XML and declaration entities', () => {
    expect(() => parseFederalBillStatusXml(xml(), scope, 'BILLSTATUS-119hr2.xml')).toThrow(
      'IDENTITY_MISMATCH',
    );
    expect(() => parseFederalBillStatusXml('<!DOCTYPE billStatus>' + xml(), scope)).toThrow(
      'XML_INVALID',
    );
    expect(() => parseFederalBillStatusXml(xml().slice(0, -4), scope)).toThrow('XML_INVALID');
    expect(() =>
      normalizeFederalVersions('119-hr-1', 'text', [
        {
          type: 'Introduced',
          formats: [
            { url: 'https://www.govinfo.gov/content/pkg/BILLS-119hr2ih/xml/BILLS-119hr2ih.xml' },
          ],
        },
      ]),
    ).toThrow('PARENT_MISMATCH');
    expect(() =>
      normalizeFederalVersions('119-hr-1', 'text', [
        { type: 'Introduced', formats: [{ url: 'https://evil.example/doc.xml' }] },
      ]),
    ).toThrow('URL_UNQUALIFIED');
  });
  it('keeps withdrawn/rejoined episodes while projecting the latest canonical member row', () => {
    const base = {
      bioguideId: 'A000001',
      fullName: 'Synthetic Member',
      party: 'X',
      state: 'FL',
      isOriginalCosponsor: false,
    };
    const normalized = normalizeFederalCosponsors([
      { ...base, sponsorshipDate: '2026-01-01', sponsorshipWithdrawnDate: '2026-01-02' },
      { ...base, sponsorshipDate: '2026-01-03' },
    ]);
    expect(normalized.episodes).toHaveLength(2);
    expect(normalized.current).toHaveLength(1);
    expect(normalized.current[0]).toMatchObject({
      sponsorshipDate: '2026-01-03',
      withdrawnDate: null,
    });
  });
  it('checks compressed hash, entry identity and complete declared count before admission', async () => {
    const zip = new JSZip();
    zip.file('BILLSTATUS-119hr1.xml', xml());
    const bytes = await zip.generateAsync({ type: 'nodebuffer' }),
      full = { ...scope, archiveHash: federalHash(bytes), expectedBills: 1 };
    expect((await inspectFrozenFederalBillStatus(bytes, full)).eligible).toHaveLength(1);
    await expect(
      inspectFrozenFederalBillStatus(bytes, { ...full, archiveHash: '0'.repeat(64) }),
    ).rejects.toThrow('HASH_MISMATCH');
    await expect(
      inspectFrozenFederalBillStatus(bytes, { ...full, expectedBills: 2 }),
    ).rejects.toThrow('COUNT_MISMATCH');
    const unsafe = new JSZip();
    unsafe.file('../BILLSTATUS-119hr1.xml', xml());
    const bad = await unsafe.generateAsync({ type: 'nodebuffer' });
    await expect(
      inspectFrozenFederalBillStatus(bad, {
        ...full,
        archiveHash: federalHash(bad),
        expectedBills: Object.keys(unsafe.files).length,
      }),
    ).rejects.toThrow('UNSAFE_ENTRY');
  });
  it('rejects an amendment whose provider parent differs from the enclosing bill', () => {
    expect(() =>
      parseFederalBillStatusXml(
        xml(
          '<amendments><amendment><congress>119</congress><type>SAMDT</type><number>1</number><amendedBill><congress>119</congress><type>HR</type><number>2</number></amendedBill></amendment></amendments>',
        ),
        scope,
      ),
    ).toThrow('PARENT_MISMATCH');
  });
});
describe('Congress public-law publication URLs', () => {
  const root = 'https://www.congress.gov/119/plaws/publ131/PLAW-119publ131';
  const publication = {
    type: 'Public Law',
    date: '2026-10-21T03:59:59Z',
    formats: [
      { type: 'Formatted Text', url: `${root}.htm` },
      { type: 'PDF', url: `${root}.pdf` },
      { type: 'United States Legislative Markup', url: `${root}_uslm.xml` },
    ],
  };

  it('retains all official formats as one canonical PLAW version bound to its parent Congress', () => {
    const versions = normalizeFederalVersions('119-hr-4307', 'text', [publication]);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      collection: 'PLAW',
      packageId: 'PLAW-119publ131',
      versionCode: null,
      date: publication.date,
      sourceUrl: `${root}_uslm.xml`,
    });
    expect(versions[0]!.formats).toHaveLength(3);
    expect(versions[0]!.formats).toEqual(
      expect.arrayContaining([
        { type: 'html', url: `${root}.htm` },
        { type: 'pdf', url: `${root}.pdf` },
        { type: 'xml', url: `${root}_uslm.xml` },
      ]),
    );
    expect(
      normalizeFederalVersions('119-hr-4307', 'text', [
        { ...publication, formats: [...publication.formats].reverse() },
      ]),
    ).toEqual(versions);
    expect(qualifiedFederalTextUrl(`${root}.xml`).pathname).toBe(
      '/119/plaws/publ131/PLAW-119publ131.xml',
    );
  });

  it('recognizes the same GovInfo package while refusing conflicting law packages or parent Congress', () => {
    const govinfo = {
      url: 'https://www.govinfo.gov/content/pkg/PLAW-119publ131/pdf/PLAW-119publ131.pdf',
    };
    expect(
      normalizeFederalVersions('119-hr-4307', 'text', [
        { ...publication, formats: [...publication.formats, govinfo] },
      ])[0],
    ).toMatchObject({ collection: 'PLAW', packageId: 'PLAW-119publ131' });
    expect(() =>
      normalizeFederalVersions('119-hr-4307', 'text', [
        {
          ...publication,
          formats: [...publication.formats, { url: govinfo.url.replaceAll('publ131', 'publ132') }],
        },
      ]),
    ).toThrow('FEDERAL_VERSION_PACKAGE_CONFLICT');
    expect(() => normalizeFederalVersions('118-hr-4307', 'text', [publication])).toThrow(
      'FEDERAL_VERSION_PARENT_MISMATCH',
    );
    expect(() => normalizeFederalVersions('119-samdt-4307', 'amendment', [publication])).toThrow(
      'FEDERAL_VERSION_PARENT_MISMATCH',
    );
  });

  it.each([
    root.replace('https:', 'http:') + '.pdf',
    root.replace('www.congress.gov', 'www.congress.gov.evil.test') + '.pdf',
    root.replace('www.congress.gov', 'www.govinfo.gov') + '.pdf',
    root.replace('https://', 'https://synthetic@') + '.pdf',
    root.replace('www.congress.gov', 'www.congress.gov:444') + '.pdf',
    `${root}.pdf#fragment`,
    `${root}.pdf?redirect=other`,
    root.replace('/119/', '/118/') + '.pdf',
    root.replace('/publ131/', '/publ132/') + '.pdf',
    `${root}extra.pdf`,
    `${root}_uslm.pdf`,
    `${root}.pdf/extra`,
    root.replace('/plaws/', '/plaws%2f') + '.pdf',
    root.replaceAll('publ131', 'publ0') + '.pdf',
    'https://www.congress.gov/119/plaws/arbitrary.xml',
  ])('refuses unqualified law URL %s', (url) => {
    expect(() => qualifiedFederalTextUrl(url)).toThrow('FEDERAL_TEXT_URL_UNQUALIFIED');
  });
});

describe('authoritative federal metadata enrichment', () => {
  function db(date: string) {
    const changes: string[] = [];
    const tx: any = {
      $transaction: async (fn: any) => fn(tx),
      $queryRawUnsafe: jest.fn(async (sql: string, ...args: any[]) =>
        sql.includes('FOR UPDATE')
          ? [{ updateDate: new Date(date) }]
          : sql.includes('AS "providerUpdatedAt"')
            ? []
            : [{ id: args[0] }],
      ),
      $executeRawUnsafe: jest.fn(async () => 1),
      congressBillSubject: {
        deleteMany: jest.fn(async () => changes.push('deleteSubjects')),
        createMany: jest.fn(),
      },
      congressBillCosponsor: {
        deleteMany: jest.fn(async () => changes.push('deleteCosponsors')),
        createMany: jest.fn(),
      },
      congressBill: { update: jest.fn(async () => changes.push('updateProjection')) },
    };
    return { tx, changes };
  }
  it('preserves newer metadata and records an incomplete checked receipt', async () => {
    const h = db('2026-02-01'),
      bill = parseFederalBillStatusXml(xml(), scope);
    expect(await enrichFederalBulkMetadata(h.tx, bill, 'a'.repeat(64))).toBe('held');
    expect(h.changes).toEqual([]);
    const receipt = h.tx.$executeRawUnsafe.mock.calls[0];
    expect(receipt[5]).toBe(false);
    expect(JSON.parse(receipt[4])).toMatchObject({
      subjectsChecked: false,
      cosponsorsChecked: false,
    });
  });
  it('authoritative empty lists clear only subjects/cosponsors in the same transaction', async () => {
    const h = db('2025-12-31'),
      bill = parseFederalBillStatusXml(xml(), scope);
    expect(await enrichFederalBulkMetadata(h.tx, bill, 'a'.repeat(64))).toBe('enriched');
    expect(h.changes).toEqual(['deleteSubjects', 'deleteCosponsors', 'updateProjection']);
    expect(h.tx.congressBill.update).toHaveBeenCalledWith({
      where: { id: bill.id },
      select: { id: true },
      data: { subjects: [], cosponsorsCount: 0 },
    });
  });
});
