import { PeResolverService } from './pe-resolver.service.js';
import type { AuthoritativePeRecord } from './pe-resolver.service.js';

/** toAmountForComparison is pure (no prisma calls) — a stub is fine here. */
const service = new PeResolverService({} as never);

const baseRecord: AuthoritativePeRecord = {
  peCode: '0207179F',
  title: 'Autonomous Collaborative Engagement',
  description: null,
  service: null,
  appropriationType: null,
  budgetActivity: null,
  budgetActivityName: null,
  status: null,
  years: [],
  people: [],
  contractors: [],
  bills: [],
};

describe('PeResolverService.toAmountForComparison (B11.3 — same-portfolio figure derivation)', () => {
  it('picks the current-cycle FY and the furthest-along authoritative number', () => {
    const rec: AuthoritativePeRecord = {
      ...baseRecord,
      years: [
        { fy: 2026, request: 40, enacted: 40, hascMark: null, sascMark: null },
        { fy: 2027, request: 50, enacted: null, hascMark: 57.22, sascMark: 55 },
      ],
    };
    const amt = service.toAmountForComparison(rec);
    // FY27 has congressional marks → current cycle FY, even though FY26 is
    // enacted — currentCycleFyOf follows the shared canonical rule. Within
    // FY27, the shared precedence ranks SASC ahead of HASC, so sascMark wins
    // over the larger hascMark figure — exactly the canonical "which number
    // counts" rule every other funding surface in the product uses.
    expect(amt).toEqual({
      peCode: '0207179F',
      title: 'Autonomous Collaborative Engagement',
      amountM: 55,
      fy: 2027,
      stageLabel: 'SASC',
      vehicleLabel: 'authorization',
    });
  });

  it('prefers enacted over a mark in the same year', () => {
    const rec: AuthoritativePeRecord = {
      ...baseRecord,
      years: [{ fy: 2027, request: 50, enacted: 48, hascMark: 57.22, sascMark: 55 }],
    };
    const amt = service.toAmountForComparison(rec);
    expect(amt?.amountM).toBe(48);
    expect(amt?.stageLabel).toBe('Enacted');
    expect(amt?.vehicleLabel).toBe('appropriation');
  });

  it('returns null when there is no year with any mark or request at all', () => {
    const rec: AuthoritativePeRecord = { ...baseRecord, years: [] };
    expect(service.toAmountForComparison(rec)).toBeNull();
  });

  it('returns null (not a throw) when a year row exists but carries no figures at all', () => {
    const rec: AuthoritativePeRecord = {
      ...baseRecord,
      years: [{ fy: 2027, request: null, enacted: null, hascMark: null, sascMark: null }],
    };
    expect(service.toAmountForComparison(rec)).toBeNull();
  });
});
