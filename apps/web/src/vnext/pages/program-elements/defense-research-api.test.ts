import { describe, expect, it, vi } from 'vitest';
import {
  getDefenseOffice,
  listDefenseOffices,
  listDefenseRelationships,
  listAcquisitionRecords,
  getAcquisitionRecord,
  getAcquisitionActions,
  getAcquisitionCoverage,
  searchDefenseBudget,
  compareDefenseBudget,
  getDefenseProductCoverage,
} from './defense-research-api.js';

describe('defense research API adapter', () => {
  it('preserves supported office filters without sending empty values', async () => {
    const get = vi.fn().mockResolvedValue({ data: { items: [] } });
    await listDefenseOffices({ get } as never, {
      q: 'PEO C3T',
      component: 'Army',
      capability: '',
      page: 2,
    });
    expect(get).toHaveBeenCalledWith('/api/defense-budget/offices', {
      params: { q: 'PEO C3T', component: 'Army', page: 2 },
    });
  });

  it('encodes office ids and keeps speculative relationship enrichment opt-in', async () => {
    const get = vi.fn().mockResolvedValue({ data: { items: [] } });
    await getDefenseOffice({ get } as never, 'office/a');
    await listDefenseRelationships({ get } as never, {
      from: 'office/a',
      includeSpeculative: false,
    });
    expect(get).toHaveBeenNthCalledWith(1, '/api/defense-budget/offices/office%2Fa');
    expect(get).toHaveBeenNthCalledWith(2, '/api/defense-budget/relationships', {
      params: { from: 'office/a', includeSpeculative: false },
    });
  });

  it('keeps acquisition record identities encoded and every source filter explicit', async () => {
    const get = vi.fn().mockResolvedValue({ data: { items: [] } });
    const api = { get } as never;
    await listAcquisitionRecords(api, { q: 'award', recordKind: 'award', buyerOffice: 'ACC', limit: 25 });
    await getAcquisitionRecord(api, 'fpds:award/A1');
    await getAcquisitionActions(api, 'fpds:award/A1');
    await getAcquisitionCoverage(api, 'acquisition', 'fpds:award/A1');
    expect(get).toHaveBeenNthCalledWith(1, '/api/defense-budget/acquisition-records', { params: { q: 'award', recordKind: 'award', buyerOffice: 'ACC', limit: 25 } });
    expect(get).toHaveBeenNthCalledWith(2, '/api/defense-budget/acquisition-records/fpds%3Aaward%2FA1', { params: { includeSpeculative: false } });
    expect(get).toHaveBeenNthCalledWith(3, '/api/defense-budget/acquisition-records/fpds%3Aaward%2FA1/actions');
    expect(get).toHaveBeenNthCalledWith(4, '/api/defense-budget/acquisition-coverage', { params: { subjectKind: 'acquisition', subjectKey: 'fpds:award/A1' } });
  });

  it('defense search preserves query and semanticEnabled flag', async () => {
    const get = vi.fn().mockResolvedValue({ data: { query: '', exact: { items: [] }, capability: { items: [] }, semantic: { items: [] }, limitations: [] } });
    const api = { get } as never;
    await searchDefenseBudget(api, { q: 'missile defense', semanticEnabled: true });
    expect(get).toHaveBeenCalledWith('/api/defense-budget/search', {
      params: { q: 'missile defense', semanticEnabled: true },
    });
  });

  it('defense compare encodes subjects as comma-separated list', async () => {
    const get = vi.fn().mockResolvedValue({ data: { projectionVersion: '', subjects: [], metrics: [], alignments: [], limitations: [] } });
    const api = { get } as never;
    await compareDefenseBudget(api, { subjects: ['program_element:PE123456', 'program:P789'] });
    expect(get).toHaveBeenCalledWith('/api/defense-budget/compare', {
      params: { subjects: 'program_element:PE123456,program:P789' },
    });
  });

  it('defense product coverage sends only defined filters', async () => {
    const get = vi.fn().mockResolvedValue({ data: { projectionVersion: '', filters: {}, rows: [], denominatorKnown: false, limitations: [] } });
    const api = { get } as never;
    await getDefenseProductCoverage(api, {
      perimeter: 'DoD',
      component: 'RDT&E',
      fiscalYear: 2025,
      stage: 'discovered',
    });
    expect(get).toHaveBeenCalledWith('/api/defense-budget/product-coverage', {
      params: { perimeter: 'DoD', component: 'RDT&E', fiscalYear: 2025, stage: 'discovered' },
    });
  });
});
