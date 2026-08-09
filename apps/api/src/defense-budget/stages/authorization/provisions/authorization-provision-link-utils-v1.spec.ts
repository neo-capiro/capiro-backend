import { stableId } from './authorization-provision-link-utils-v1.js';

describe('authorization provision stable IDs', () => {
  it('is invariant to object-key insertion order', () => {
    const first = {
      provisionId: 'provision-1',
      target: 'RDTE_PE:0605053A',
      matchBasis: 'exact_pe_code',
    };
    const second = {
      matchBasis: 'exact_pe_code',
      target: 'RDTE_PE:0605053A',
      provisionId: 'provision-1',
    };

    expect(stableId('provision-link', first)).toBe(stableId('provision-link', second));
  });

  it('still changes when semantic content changes', () => {
    const first = {
      provisionId: 'provision-1',
      target: 'RDTE_PE:0605053A',
      matchBasis: 'exact_pe_code',
    };
    const second = {
      provisionId: 'provision-1',
      target: 'RDTE_PE:0605053A',
      matchBasis: 'reviewed_alias',
    };

    expect(stableId('provision-link', first)).not.toBe(stableId('provision-link', second));
  });
});
