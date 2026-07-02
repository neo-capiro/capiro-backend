import { detectAnomalies, type AnomalyInput } from './budget-anomaly.js';

const base: AnomalyInput = {
  appropriationType: 'RDT&E',
  request: null,
  priorYearRequest: null,
  hascMark: null,
  sascMark: null,
  hacDMark: null,
  sacDMark: null,
  quantity: null,
  outyearTotal: null,
};

const types = (x: Partial<AnomalyInput>) => detectAnomalies({ ...base, ...x }).map((a) => a.type);

describe('detectAnomalies — rule fixtures', () => {
  test('M10 Booker pattern: funded last year, zeroed this year -> zeroed_after_funding (sev 3)', () => {
    const r = detectAnomalies({ ...base, appropriationType: 'PROC', priorYearRequest: 439.1, request: 0 });
    expect(r.map((a) => a.type)).toContain('zeroed_after_funding');
    expect(r.find((a) => a.type === 'zeroed_after_funding')?.severity).toBe(3);
  });

  test('request collapse >50% and surge >100% year-over-year', () => {
    expect(types({ priorYearRequest: 200, request: 80 })).toContain('request_collapse');
    expect(types({ priorYearRequest: 100, request: 250 })).toContain('request_surge');
    expect(types({ priorYearRequest: 100, request: 90 })).toHaveLength(0); // ordinary drift
  });

  test('0601103N pattern: chamber funds a line with zero request -> mark_add_on_zero_request', () => {
    expect(types({ request: 0, hascMark: 47.5, sascMark: 75 })).toContain('mark_add_on_zero_request');
  });

  test('one chamber cuts >20% while the other supports -> divergent_cut (both directions)', () => {
    expect(types({ request: 100, hascMark: 70, sascMark: 100 })).toContain('divergent_cut');
    expect(types({ request: 100, hascMark: 100, sascMark: 70 })).toContain('divergent_cut');
    expect(types({ request: 100, hascMark: 95, sascMark: 96 })).toHaveLength(0); // small trims are not anomalies
  });

  test('1507N2294 pattern: authorizers support, HAC-D zeroes -> approps_defies_authorizers (sev 3)', () => {
    const r = detectAnomalies({ ...base, request: 156, hascMark: 156, sascMark: 160, hacDMark: 0 });
    expect(r.map((a) => a.type)).toContain('approps_defies_authorizers');
  });

  test('procurement quantity with no stated outyears -> quantity_without_outyears', () => {
    expect(
      types({ appropriationType: 'PROC', request: 50, quantity: 12, outyearTotal: 0 }),
    ).toContain('quantity_without_outyears');
    // outyears unknown (null) -> silent, never false-flag
    expect(
      types({ appropriationType: 'PROC', request: 50, quantity: 12, outyearTotal: null }),
    ).toHaveLength(0);
  });

  test('structure-of-money rules stay silent when links are UNKNOWN, fire when known-absent', () => {
    expect(types({ appropriationType: 'OM', request: 500 })).toHaveLength(0); // hasProcurementLink undefined
    expect(
      types({ appropriationType: 'OM', request: 500, hasProcurementLink: false }),
    ).toContain('om_without_procurement');
    expect(
      types({ appropriationType: 'PROC', request: 500, hasRdteLink: false }),
    ).toContain('proc_without_rdte');
    expect(types({ appropriationType: 'PROC', request: 500, hasRdteLink: true })).toHaveLength(0);
  });

  test('every anomaly carries evidence + a render-safe sentence', () => {
    const r = detectAnomalies({ ...base, priorYearRequest: 439.1, request: 0 });
    for (const a of r) {
      expect(a.sentence.length).toBeGreaterThan(10);
      expect(Object.keys(a.evidence).length).toBeGreaterThan(0);
    }
  });
});
