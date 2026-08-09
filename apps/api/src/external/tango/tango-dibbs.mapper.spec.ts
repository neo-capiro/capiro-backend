import {
  dateOnly,
  decimalString,
  mapDibbsAward,
  mapDibbsRfp,
  mapDibbsRfq,
  reconcileQuantity,
} from './tango-dibbs.mapper.js';

/**
 * Funding Opportunities P40 — the DIBBS mappers.
 *
 * Most of this file pins CAPIRO'S READING of a published field list, not
 * observed provider behaviour — these tests catch a regression in our own
 * coercions, and were written before any live call was possible.
 *
 * THAT CHANGED 2026-08-09. An operator captured five real records per
 * endpoint (decision-log D-71); `__fixtures__/dibbs-contract-capture-2026-08-09.json`
 * holds them verbatim, and the `real capture` describe block below runs every
 * one of them through the actual mapper. Nothing in it was hand-written to
 * pass — it is the first genuine confirmation that these mappers survive
 * contact with the provider, not merely with our own assumptions about it.
 */

describe('dateOnly', () => {
  it('anchors a date-only value at UTC midnight, not local midnight', () => {
    // The bug this forbids: a bid closing on the 30th showing as the 29th for
    // anyone west of Greenwich, in the one field a pursuer acts on.
    expect(dateOnly('2026-09-30')?.toISOString()).toBe('2026-09-30T00:00:00.000Z');
  });

  it('reduces a full timestamp to its UTC calendar day', () => {
    expect(dateOnly('2026-09-30T18:45:00Z')?.toISOString()).toBe('2026-09-30T00:00:00.000Z');
  });

  it('returns null for junk rather than an Invalid Date', () => {
    // An Invalid Date passes every type check and is wrong at the database.
    for (const junk of ['not-a-date', '', '   ', null, undefined, {}, [], '2026-13-45']) {
      expect(dateOnly(junk)).toBeNull();
    }
  });
});

describe('decimalString', () => {
  it('preserves an exact numeric string rather than round-tripping it through a float', () => {
    // NUMERIC(18,2) exceeds 2^53. This is the case a `num()`-based mapper loses.
    expect(decimalString('12345678901234.56')).toBe('12345678901234.56');
    expect(decimalString('0.0001')).toBe('0.0001');
  });

  it('keeps a stated zero, which is a fact, not an absence', () => {
    expect(decimalString('0')).toBe('0');
    expect(decimalString(0)).toBe('0');
  });

  it('returns null for absence, and never confuses it with zero', () => {
    expect(decimalString(null)).toBeNull();
    expect(decimalString(undefined)).toBeNull();
    expect(decimalString('')).toBeNull();
  });

  it('falls back for a decorated value, accepting the float trip it was never exact anyway', () => {
    expect(decimalString('$1,234.50')).toBe('1234.5');
  });

  it('returns null for text that is not a number at all', () => {
    expect(decimalString('unpriced')).toBeNull();
  });
});

describe('reconcileQuantity', () => {
  it('drops a quantity that has no unit, and says so', () => {
    // 500 of an unknown unit is not 500 each. Inventing "EA" would invent the
    // fact; the DB check refuses the pair; so the quantity goes.
    expect(reconcileQuantity('500', null)).toEqual({
      quantity: null,
      unitOfIssue: null,
      quantityDropped: true,
    });
  });

  it('keeps a quantity that has its unit', () => {
    expect(reconcileQuantity('500', 'EA')).toEqual({
      quantity: '500',
      unitOfIssue: 'EA',
      quantityDropped: false,
    });
  });

  it('keeps a unit with no quantity — that violates nothing', () => {
    expect(reconcileQuantity(null, 'EA')).toEqual({
      quantity: null,
      unitOfIssue: 'EA',
      quantityDropped: false,
    });
  });
});

describe('mapDibbsRfq', () => {
  const rfq = {
    uuid: 'u-1',
    solicitation: 'SPE7M123R0001',
    solicitation_formatted: 'SPE7M1-23-R-0001',
    purchase_request: 'PR-9',
    nsn: '5310-01-234-5678',
    part_number: 'MS35338-42',
    nomenclature: 'WASHER,LOCK',
    quantity: '1200',
    unit_of_issue: 'EA',
    set_aside: 'SBA',
    status_code: 'A',
    return_by_date: '2026-10-15',
    issue_date: '2026-09-30',
    is_open: true,
    document_url: 'https://example.invalid/rfq.pdf',
  };

  it('maps a full record onto the shared solicitation row', () => {
    expect(mapDibbsRfq(rfq)).toMatchObject({
      tangoDibbsId: 'u-1',
      documentType: 'rfq',
      solicitation: 'SPE7M123R0001',
      nsn: '5310-01-234-5678',
      quantity: '1200',
      unitOfIssue: 'EA',
      setAside: 'SBA',
      isOpen: true,
    });
  });

  it("reads the RFQ's OWN date spelling, not the RFP's", () => {
    const row = mapDibbsRfq(rfq);
    expect(row?.issuedDate).toEqual(new Date('2026-09-30T00:00:00.000Z'));
    expect(row?.closesDate).toEqual(new Date('2026-10-15T00:00:00.000Z'));
  });

  it('does NOT silently accept an RFP-shaped record', () => {
    // The point of two mappers instead of one that reads four keys: if the
    // provider changes a spelling, the right outcome is a null and a failing
    // test, not a quiet success against the other endpoint's schema.
    const rfpShaped = {
      uuid: 'u-2',
      solicitation: 'S-1',
      issued_date: '2026-09-30',
      closes_date: '2026-10-15',
    };
    const row = mapDibbsRfq(rfpShaped);
    expect(row?.issuedDate).toBeNull();
    expect(row?.closesDate).toBeNull();
  });

  it('leaves RFP-only fields null rather than inventing them', () => {
    expect(mapDibbsRfq(rfq)).toMatchObject({ buyerCode: null, techDocsUrl: null });
  });

  it('drops a quantity with no unit but KEEPS the solicitation', () => {
    const row = mapDibbsRfq({ ...rfq, unit_of_issue: null });
    expect(row).not.toBeNull();
    expect(row?.quantity).toBeNull();
    expect(row?.unitOfIssue).toBeNull();
    expect(row?.solicitation).toBe('SPE7M123R0001'); // the real item survives
  });

  it('RETURNS NULL when there is no provider uuid — the upsert key cannot be invented', () => {
    expect(mapDibbsRfq({ ...rfq, uuid: null })).toBeNull();
  });

  it('RETURNS NULL when there is no solicitation — the column is NOT NULL', () => {
    expect(mapDibbsRfq({ ...rfq, solicitation: '  ' })).toBeNull();
  });

  it('treats a missing is_open as UNKNOWN, never as closed', () => {
    expect(mapDibbsRfq({ ...rfq, is_open: undefined })?.isOpen).toBeNull();
  });

  it('preserves an NSN with leading zeros as text', () => {
    expect(mapDibbsRfq({ ...rfq, nsn: '0005-00-000-0001' })?.nsn).toBe('0005-00-000-0001');
  });
});

describe('mapDibbsRfp', () => {
  const rfp = {
    uuid: 'u-10',
    solicitation: 'SPE7M124B0002',
    nsn: '2940-00-123-4567',
    part_number: 'PN-77',
    nomenclature: 'FILTER ELEMENT',
    buyer_code: 'PZ21',
    issued_date: '2026-09-01',
    closes_date: '2026-09-28',
    is_open: false,
    document_url: 'https://example.invalid/rfp.pdf',
    tech_docs_url: 'https://example.invalid/tech.zip',
  };

  it('maps a full record, with its own date spelling', () => {
    const row = mapDibbsRfp(rfp);
    expect(row).toMatchObject({
      tangoDibbsId: 'u-10',
      documentType: 'rfp',
      buyerCode: 'PZ21',
      techDocsUrl: 'https://example.invalid/tech.zip',
      isOpen: false,
    });
    expect(row?.issuedDate).toEqual(new Date('2026-09-01T00:00:00.000Z'));
    expect(row?.closesDate).toEqual(new Date('2026-09-28T00:00:00.000Z'));
  });

  it('leaves quantity and unit null — an RFP states neither, and null is not zero', () => {
    expect(mapDibbsRfp(rfp)).toMatchObject({ quantity: null, unitOfIssue: null });
  });

  it('leaves RFQ-only fields null rather than inventing them', () => {
    expect(mapDibbsRfp(rfp)).toMatchObject({
      purchaseRequest: null,
      setAside: null,
      statusCode: null,
      solicitationFormatted: null,
    });
  });

  it('does NOT silently accept an RFQ-shaped record', () => {
    const rfqShaped = {
      uuid: 'u-11',
      solicitation: 'S-2',
      issue_date: '2026-09-01',
      return_by_date: '2026-09-28',
    };
    const row = mapDibbsRfp(rfqShaped);
    expect(row?.issuedDate).toBeNull();
    expect(row?.closesDate).toBeNull();
  });

  it('RETURNS NULL with no uuid or no solicitation', () => {
    expect(mapDibbsRfp({ ...rfp, uuid: '' })).toBeNull();
    expect(mapDibbsRfp({ ...rfp, solicitation: null })).toBeNull();
  });
});

describe('mapDibbsAward', () => {
  const award = {
    uuid: 'a-1',
    award_number: 'SPE7M126D0001',
    delivery_order_number: 'DO-0003',
    delivery_order_counter: 3,
    nsn: '5310-01-234-5678',
    part_number: 'MS35338-42',
    purchase_request: 'PR-9',
    nomenclature: 'WASHER,LOCK',
    awardee_cage: '1ABC2',
    total_contract_price: '48250.75',
    total_contract_price_text: '$48,250.75',
    award_date: '2026-08-01',
    posted_date: '2026-08-03',
    last_mod_posting_date: '2026-08-09',
    solicitation: 'SPE7M123R0001',
    awardee: { uei: 'ABC123DEF456', cage_code: '1ABC2', legal_business_name: 'ACME FASTENERS INC' },
  };

  it('maps a full award, flattening the nested awardee', () => {
    expect(mapDibbsAward(award)).toMatchObject({
      tangoDibbsId: 'a-1',
      awardNumber: 'SPE7M126D0001',
      deliveryOrderNumber: 'DO-0003',
      deliveryOrderCounter: 3,
      totalContractPrice: '48250.75',
      totalContractPriceText: '$48,250.75',
      awardeeUei: 'ABC123DEF456',
      awardeeLegalBusinessName: 'ACME FASTENERS INC',
    });
  });

  it('stores the top-level cage and the nested cage_code SEPARATELY', () => {
    // They usually agree. A mapper that collapsed them would destroy the only
    // evidence available on the day they do not.
    const row = mapDibbsAward({
      ...award,
      awardee_cage: '1ABC2',
      awardee: { ...award.awardee, cage_code: '9XYZ8' },
    });
    expect(row?.awardeeCage).toBe('1ABC2');
    expect(row?.awardeeCageCode).toBe('9XYZ8');
  });

  it('survives an awardee that is absent, null, or the wrong shape', () => {
    for (const awardee of [undefined, null, 'ACME', [], 42]) {
      const row = mapDibbsAward({ ...award, awardee });
      expect(row).not.toBeNull();
      expect(row?.awardeeUei).toBeNull();
      expect(row?.awardeeCage).toBe('1ABC2'); // the top-level fact still stands
    }
  });

  it('keeps a zero-dollar award — an unfunded line is a real thing', () => {
    expect(mapDibbsAward({ ...award, total_contract_price: '0' })?.totalContractPrice).toBe('0');
  });

  it('keeps the price TEXT when the numeric field is absent', () => {
    // The text is then the only evidence of what the source displayed.
    const row = mapDibbsAward({ ...award, total_contract_price: null });
    expect(row?.totalContractPrice).toBeNull();
    expect(row?.totalContractPriceText).toBe('$48,250.75');
  });

  it('RETURNS NULL with no uuid or no award_number', () => {
    expect(mapDibbsAward({ ...award, uuid: null })).toBeNull();
    expect(mapDibbsAward({ ...award, award_number: '   ' })).toBeNull();
  });

  it('keeps an award whose solicitation was never synced — no FK, by design', () => {
    const row = mapDibbsAward({ ...award, solicitation: 'NEVER-SYNCED' });
    expect(row?.solicitation).toBe('NEVER-SYNCED');
  });

  it('keeps line items of one contract DISTINCT by provider uuid', () => {
    // Two delivery orders of one award are two rows. This is why
    // total_contract_price must never be summed across them.
    const a = mapDibbsAward({ ...award, uuid: 'a-1', delivery_order_counter: 1 });
    const b = mapDibbsAward({ ...award, uuid: 'a-2', delivery_order_counter: 2 });
    expect(a?.tangoDibbsId).not.toBe(b?.tangoDibbsId);
    expect(a?.awardNumber).toBe(b?.awardNumber);
  });
});

describe('no alias-fallback logic — enforced structurally, not by convention', () => {
  // The other negative tests in this file prove the CURRENT mappers do not
  // cross endpoint vocabularies. They cannot prove the next edit will not
  // introduce a `raw['issue_date'] ?? raw['issued_date']` as a well-meaning
  // "be liberal in what you accept" fix. That single line would restore
  // exactly the failure mode two mappers exist to prevent: an RFP arriving
  // with RFQ field names would map cleanly, produce a plausible record, and
  // report success.
  //
  // So the rule is checked against the source itself. "First available of
  // these aliases" is forbidden unless the provider DOCUMENTS aliases, and
  // dibbs-sbir-rest-contract.md records that it does not.

  const mapperSource = (): string => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { join } = require('node:path') as typeof import('node:path');
    const raw = readFileSync(
      join(process.cwd(), 'src/external/tango/tango-dibbs.mapper.ts'),
      'utf8',
    );
    // Strip comments BEFORE scanning. An earlier source-scanning test in this
    // repo failed on its own explanatory prose; the rule is about code, so
    // only code is scanned.
    return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  };

  it('never reads one provider key as a fallback for another', () => {
    // `raw['a'] ?? raw['b']` / `raw['a'] || raw['b']`
    expect(/raw\[[^\]]+\]\s*(\?\?|\|\|)/.test(mapperSource())).toBe(false);
  });

  it('never reads a provider key as the fallback SIDE of an alternative either', () => {
    // The mirror image: `something ?? raw['b']`. Same defect, written the
    // other way round, and a regex anchored only on the left would miss it.
    expect(/(\?\?|\|\|)\s*raw\[/.test(mapperSource())).toBe(false);
  });

  it('the guard itself can fail — a synthetic alias is caught', () => {
    // A guard that cannot fail is theater. This is the same check the two
    // tests above run, applied to a string that genuinely contains the
    // pattern, so a regex that silently stopped matching would be caught.
    const synthetic = "issuedDate: dateOnly(raw['issue_date'] ?? raw['issued_date']),";
    expect(/raw\[[^\]]+\]\s*(\?\?|\|\|)/.test(synthetic)).toBe(true);
  });
});

// ── Real capture, 2026-08-09 (D-71) ─────────────────────────────────────────

describe('real capture — every mapper against records the provider actually sent', () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  const capture = JSON.parse(
    readFileSync(
      join(__dirname, '__fixtures__/real-captures/dibbs-contract-capture-2026-08-09.json'),
      'utf8',
    ),
  );

  test('every RFQ maps without dropping a required field', () => {
    for (const raw of capture.rfqs) {
      const row = mapDibbsRfq(raw);
      expect(row).not.toBeNull();
      expect(row!.tangoDibbsId).toBe(raw.uuid);
      expect(row!.solicitation).toBe(raw.solicitation);
    }
  });

  test('every RFP maps without dropping a required field', () => {
    for (const raw of capture.rfps) {
      const row = mapDibbsRfp(raw);
      expect(row).not.toBeNull();
      expect(row!.tangoDibbsId).toBe(raw.uuid);
    }
  });

  test('every award maps without dropping a required field', () => {
    for (const raw of capture.awards) {
      const row = mapDibbsAward(raw);
      expect(row).not.toBeNull();
      expect(row!.tangoDibbsId).toBe(raw.uuid);
    }
  });

  /**
   * `delivery_order_counter` arrived as a STRING ("53883"), not the JSON
   * number the column's INTEGER type might suggest. `int()` already coerces a
   * numeric string, so this is a confirmation, not a fix — but it is the exact
   * kind of thing a fixture is for: the next person who "simplifies" `int()`
   * to a bare `typeof value === 'number' ? value : null` would silently start
   * dropping every real delivery-order counter this provider sends.
   */
  test('a string-typed delivery_order_counter still maps to a number', () => {
    const withCounter = capture.awards.find((a: { delivery_order_counter: unknown }) =>
      typeof a.delivery_order_counter === 'string',
    );
    expect(withCounter).toBeDefined();
    const row = mapDibbsAward(withCounter)!;
    expect(row.deliveryOrderCounter).toBe(Number(withCounter.delivery_order_counter));
  });

  /**
   * `total_contract_price` arrives as a native JSON NUMBER when present
   * (2500, 16093.28), never as the exact-digit string `decimalString`'s own
   * doc comment is written to protect. That protection is real for a string
   * input; it is not exercised by anything this capture observed, because the
   * provider's own JSON encoding already round-tripped the value through a
   * float before this code ever sees it. Recorded rather than "fixed" — there
   * is nothing downstream of a JSON parse that could recover a digit the
   * provider's own encoder already lost.
   */
  test('a numeric total_contract_price round-trips through decimalString', () => {
    const priced = capture.awards.find(
      (a: { total_contract_price: unknown }) => typeof a.total_contract_price === 'number',
    );
    expect(priced).toBeDefined();
    expect(decimalString(priced.total_contract_price)).toBe(String(priced.total_contract_price));
  });

  /** `total_contract_price_text` carries the source's own rendering when the numeric field is null — exactly the case the schema comment anticipated. */
  test('a null price with a text fallback maps both fields correctly', () => {
    const noPrice = capture.awards.find(
      (a: { total_contract_price: unknown }) => a.total_contract_price === null,
    );
    expect(noPrice).toBeDefined();
    const row = mapDibbsAward(noPrice)!;
    expect(row.totalContractPrice).toBeNull();
    expect(row.totalContractPriceText).toBe(noPrice.total_contract_price_text);
  });

  /**
   * Every RFP in this sample had `document_url: null` while every RFQ had one
   * populated — five records is not proof RFPs never carry one, but the
   * mapper must not assume either way. Confirmed: `mapDibbsRfp` reads it
   * exactly like RFQ does, via `str()`, which returns null for null input
   * without complaint.
   */
  test('an RFP with no document_url maps to null, not to a crash or a default', () => {
    const noDoc = capture.rfps.find((r: { document_url: unknown }) => r.document_url === null);
    expect(noDoc).toBeDefined();
    expect(mapDibbsRfp(noDoc)!.documentUrl).toBeNull();
  });

  test('every date field in the capture parses as the calendar day it names', () => {
    for (const raw of capture.rfqs) {
      expect(dateOnly(raw.issue_date)?.toISOString().slice(0, 10)).toBe(raw.issue_date);
      expect(dateOnly(raw.return_by_date)?.toISOString().slice(0, 10)).toBe(raw.return_by_date);
    }
  });

  test('no captured RFQ needed reconcileQuantity to drop a quantity', () => {
    // Every RFQ in this sample carried BOTH quantity and unit_of_issue, so the
    // gap this function guards against did not occur here. Asserted anyway, so
    // a future capture that DOES trigger it is a visible change in this test,
    // not a silent pass.
    for (const raw of capture.rfqs) {
      const { quantityDropped } = reconcileQuantity(
        decimalString(raw.quantity),
        raw.unit_of_issue,
      );
      expect(quantityDropped).toBe(false);
    }
  });
});
