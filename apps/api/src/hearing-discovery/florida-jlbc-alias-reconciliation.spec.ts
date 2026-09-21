import { FLORIDA_JLBC_ALIAS_REVIEW } from './florida-jlbc-alias-review.js';
import { floridaJlbcAliasConfirmation } from './florida-jlbc-alias-reconciliation.js';

describe('Florida JLBC alias reconciliation guard', () => {
  it('uses a one-pair confirmation token distinct from the generic repair', () => {
    expect(floridaJlbcAliasConfirmation(FLORIDA_JLBC_ALIAS_REVIEW.repairId)).toBe(
      'fl-jlbc-openstates-official-2026-09-20:apply-reviewed-aliases:jlbc-official-calendar',
    );
  });

  it('pins both observed OpenStates ledger shapes to the reviewed Florida committee', () => {
    expect(FLORIDA_JLBC_ALIAS_REVIEW).toMatchObject({
      externalEventId: 'ocd-event/a02f8006-d61c-436b-bd3b-e5080dad8f67',
      enrichedExternalEventId: 'openstates:event:ocd-event/a02f8006-d61c-436b-bd3b-e5080dad8f67',
      aliasBodySourceKey:
        'unresolved-body:openstates:ocd-organization/e779cf08-9f72-4663-a9e0-ad306359310a',
      enrichedAliasBodySourceKey:
        'openstates:ocd-organization/e779cf08-9f72-4663-a9e0-ad306359310a',
      aliasStateCommitteeId: 'official-203133a6dd941346b3a08cfec2a92ccc',
      legislativeSession: '2026',
    });
  });
});
