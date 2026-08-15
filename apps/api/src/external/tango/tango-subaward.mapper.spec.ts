import { mapTangoSubaward } from './tango-subaward.mapper.js';

describe('mapTangoSubaward', () => {
  it('maps the documented nested shape and keeps district unknown when not supplied', () => {
    const mapped = mapTangoSubaward(
      {
        key: 'sub-1',
        award_key: 'CONT_AWD_1',
        piid: 'W56HZV-26-C-0001',
        subaward_details: {
          number: 'SUB-001',
          type: 'contract',
          amount: 0,
          action_date: '2026-08-01',
          description: 'Component manufacturing',
        },
        fsrs_details: { last_modified_date: '2026-08-05T12:00:00Z' },
        prime_recipient: { uei: 'AAA111BBB222', display_name: 'Prime LLC' },
        subaward_recipient: { uei: 'CCC333DDD444', display_name: 'Supplier Inc' },
        place_of_performance: {
          country_code: 'USA',
          state: 'VA',
          city: 'Reston',
          zip: '20190',
        },
      },
      '2026-08-08T00:00:00.000Z',
    );

    expect(mapped).not.toBeNull();
    expect(mapped?.subawardAmount).toBe(0);
    expect(mapped?.subawardNumber).toBe('SUB-001');
    expect(mapped?.primeRecipientUei).toBe('AAA111BBB222');
    expect(mapped?.subawardeeUei).toBe('CCC333DDD444');
    expect(mapped?.providerModifiedAt).toBe('2026-08-05T12:00:00.000Z');
    expect(mapped?.placeOfPerformance).toEqual({
      country: 'USA',
      state: 'VA',
      city: 'Reston',
      zip: '20190',
      congressionalDistrict: null,
    });
  });

  it('rejects an unkeyed provider record rather than inventing identity', () => {
    expect(mapTangoSubaward({ subaward_details: { amount: 10 } })).toBeNull();
  });

  it('hashes semantic content independently of input key order and fetch time', () => {
    const a = mapTangoSubaward(
      { key: 'x', subaward_details: { amount: '1,200', description: 'Work' } },
      '2026-08-08T00:00:00.000Z',
    );
    const b = mapTangoSubaward(
      { subaward_details: { description: 'Work', amount: 1200 }, key: 'x' },
      '2026-08-09T00:00:00.000Z',
    );
    expect(a?.contentSha256).toBe(b?.contentSha256);
    expect(a?.fetchedAt).not.toBe(b?.fetchedAt);
  });

  it('keeps missing money null', () => {
    expect(mapTangoSubaward({ key: 'x' })?.subawardAmount).toBeNull();
  });
});
