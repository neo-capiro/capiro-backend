import {
  INTERNAL_OUTREACH_RECORD_TYPES,
  ownOutreachRecordWhere,
} from '../../engagement/engagement-access.helpers.js';
import {
  OUTREACH_V3_ARTIFACT_ROOT_SCHEMA_VERSION,
  OUTREACH_V3_INTERNAL_RECORD_TYPE,
} from './outreach-v3-artifact-root.service.js';

describe('Outreach V3 hidden artifact root', () => {
  it('reserves one internal record type outside Classic access predicates', () => {
    expect(OUTREACH_V3_INTERNAL_RECORD_TYPE).toBe('outreach_v3');
    expect(INTERNAL_OUTREACH_RECORD_TYPES).toContain(OUTREACH_V3_INTERNAL_RECORD_TYPE);
    expect(OUTREACH_V3_ARTIFACT_ROOT_SCHEMA_VERSION).toBe('outreach_v3_artifact_root_v1');
  });

  it('uses an AND exclusion that cannot be overwritten by a later Classic type filter', () => {
    const owner = ownOutreachRecordWhere('11111111-1111-4111-8111-111111111111');
    expect(owner).toEqual({
      createdByUserId: '11111111-1111-4111-8111-111111111111',
      AND: [{ type: { notIn: ['outreach_v3'] } }],
    });

    // This is the actual composition style used by Classic list queries: a
    // later `type` key cannot replace the separate AND exclusion.
    const crafted = { ...owner, type: 'outreach_v3' };
    expect(crafted.AND).toEqual([{ type: { notIn: ['outreach_v3'] } }]);
    expect(crafted.type).toBe('outreach_v3');
  });
});
