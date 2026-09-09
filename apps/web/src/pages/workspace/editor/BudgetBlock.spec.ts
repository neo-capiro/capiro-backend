import { describe, expect, it } from 'vitest';
import {
  budgetFrom,
  countPopulatedIdentifiers,
  describeBudgetProvenance,
  fundingHistoryRows,
  hasBudgetValue,
  type BudgetIdentifiers,
} from './BudgetBlock';
import type { WsAsk, WsConfig } from '../types';

/**
 * F04 — Existing completed Workspace output showed:
 *   "Auto-populated from FY27 R-1 & Navy UPL, 5 of 6 validated"
 * with Account / PE / BA / R-1 / UPL all blank, ask empty, and fabricated
 * FY25 $6M / FY26 $8M / FY27 PB $8M / Request $18M pills that contradicted the
 * step's $14M plus-up. These pure helpers must never reintroduce that claim.
 */

/** Shape of the live July artifact's empty budget surface (ids + ask blank). */
const EMPTY_LIVE_ASK: WsAsk = { amount: '', pb: '', delta: '' };
const EMPTY_LIVE_BUDGET: BudgetIdentifiers = {};

describe('hasBudgetValue', () => {
  it('rejects blank and placeholder strings', () => {
    expect(hasBudgetValue(undefined)).toBe(false);
    expect(hasBudgetValue(null)).toBe(false);
    expect(hasBudgetValue('')).toBe(false);
    expect(hasBudgetValue('   ')).toBe(false);
    expect(hasBudgetValue('—')).toBe(false);
    expect(hasBudgetValue('-')).toBe(false);
    expect(hasBudgetValue('n/a')).toBe(false);
  });

  it('accepts real identifier and dollar strings', () => {
    expect(hasBudgetValue('1319')).toBe(true);
    expect(hasBudgetValue('0605826N')).toBe(true);
    expect(hasBudgetValue('$14M')).toBe(true);
  });
});

describe('describeBudgetProvenance (F04 empty scaffold)', () => {
  it('never claims R-1/UPL validation when every identifier is blank', () => {
    const p = describeBudgetProvenance(EMPTY_LIVE_BUDGET);
    expect(p.populated).toBe(0);
    expect(p.hasAnyIdentifier).toBe(false);
    expect(p.pillLabel).toBe('Needs data');
    expect(p.statusText.toLowerCase()).not.toMatch(/validated/);
    expect(p.statusText).not.toMatch(/FY27 R-1/i);
    expect(p.statusText).not.toMatch(/Navy UPL/i);
    expect(p.statusText).toMatch(/not yet linked|unknown/i);
  });

  it('reports a real count only when identifiers are actually present', () => {
    const p = describeBudgetProvenance({
      account: 'RDTE,N',
      pe: '0605826N',
      ba: 'BA-07',
      r1: '',
      upl: '—',
    });
    expect(p.populated).toBe(3);
    expect(p.hasAnyIdentifier).toBe(true);
    expect(p.pillLabel).toBe('Auto-populated');
    expect(p.statusText).toContain('3 of 5');
    // Still must not invent a "validated" claim — live R-1 pipeline is unwired.
    expect(p.statusText.toLowerCase()).not.toMatch(/validated/);
  });

  it('counts only the five identifier slots (ignores fundingHistory)', () => {
    expect(
      countPopulatedIdentifiers({
        fundingHistory: [{ label: 'FY25 enacted', value: '$1M' }],
      }),
    ).toBe(0);
  });
});

describe('fundingHistoryRows (F04 no fabricated FY amounts)', () => {
  it('returns no rows for the live empty ask + empty budget (no $6M/$8M/$18M)', () => {
    const rows = fundingHistoryRows(EMPTY_LIVE_ASK, EMPTY_LIVE_BUDGET);
    expect(rows).toEqual([]);
    const blob = JSON.stringify(rows);
    expect(blob).not.toMatch(/\$6/);
    expect(blob).not.toMatch(/\$8/);
    expect(blob).not.toMatch(/\$18/);
    expect(blob).not.toMatch(/FY25/);
    expect(blob).not.toMatch(/FY26/);
  });

  it('surfaces only operator-set ask fields when present', () => {
    const rows = fundingHistoryRows(
      { amount: '$14M', pb: '$8M', delta: '+$6M' },
      {},
    );
    expect(rows).toEqual([
      { y: 'FY PB', v: '$8M', known: true },
      { y: 'Request', v: '$14M', known: true },
      { y: 'Delta', v: '+$6M', known: true },
    ]);
  });

  it('includes structured fundingHistory only when both label and value are real', () => {
    const rows = fundingHistoryRows(
      {},
      {
        fundingHistory: [
          { label: 'FY25 enacted', value: '$6.0M' },
          { label: 'FY26 enacted', value: '' },
          { label: '', value: '$1M' },
        ],
      },
    );
    expect(rows).toEqual([{ y: 'FY25 enacted', v: '$6.0M', known: true }]);
  });
});

describe('budgetFrom', () => {
  it('returns empty identifiers when cfg.budget is absent (F04 draft shape)', () => {
    const cfg = { sections: ['Funding history & request'] } as unknown as WsConfig;
    expect(budgetFrom(cfg)).toEqual({
      account: undefined,
      pe: undefined,
      ba: undefined,
      r1: undefined,
      upl: undefined,
      fundingHistory: undefined,
    });
    expect(describeBudgetProvenance(budgetFrom(cfg)).populated).toBe(0);
  });

  it('passes through real budget fields when present', () => {
    const cfg = {
      budget: {
        account: 'RDTE,N',
        pe: '0605826N',
        ba: 'BA-07',
        r1: 'Line 123',
        upl: 'UPL-9',
        fundingHistory: [{ label: 'FY25 enacted', value: '$6.0M' }],
      },
    } as unknown as WsConfig;
    expect(budgetFrom(cfg)).toEqual({
      account: 'RDTE,N',
      pe: '0605826N',
      ba: 'BA-07',
      r1: 'Line 123',
      upl: 'UPL-9',
      fundingHistory: [{ label: 'FY25 enacted', value: '$6.0M' }],
    });
  });
});
