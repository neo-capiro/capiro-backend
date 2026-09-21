import { FLORIDA_JLBC_ALIAS_REVIEW } from './florida-jlbc-alias-review.js';
import { floridaJlbcAliasConfirmation } from './florida-jlbc-alias-reconciliation.js';

describe('Florida JLBC alias reconciliation guard', () => {
  it('uses a one-pair confirmation token distinct from the generic repair', () => {
    expect(floridaJlbcAliasConfirmation(FLORIDA_JLBC_ALIAS_REVIEW.repairId)).toBe(
      'fl-jlbc-openstates-official-2026-09-20:apply-reviewed-aliases:jlbc-official-calendar',
    );
  });
});
