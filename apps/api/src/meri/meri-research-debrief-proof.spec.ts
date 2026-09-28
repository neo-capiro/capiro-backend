import type { TenantContext } from '@capiro/shared';
import { buildDebriefReadResult, parseDebriefReadInput } from './meri-debrief-read.helpers';
import {
  currentOwnerResultAuthorizesReplay,
  supportsDurableOwnerReauthorization,
} from './meri-research-replay-authorization';
import { debriefOwnerProof } from './meri-research-debrief-proof';
import { publicResearchSourceTool } from './meri-report-provenance';

const ctx = { tenantId: 'tenant-1', userId: 'owner-1' } as TenantContext;

function result(options: {
  body?: string;
  updatedAt?: string;
  rows?: boolean;
  sourceStatus?: 'healthy' | 'degraded';
} = {}) {
  const selection = parseDebriefReadInput(
    ctx,
    { clientId: 'client-1', debriefId: 'debrief-1', characterLimit: 100 },
    'client-1',
  );
  const rows = options.rows === false
    ? []
    : [{
        id: 'debrief-1',
        meetingId: 'meeting-1',
        clientId: 'client-1',
        body: options.body ?? 'Exact current body',
        status: 'approved',
        authorUserId: 'owner-1',
        author: {
          id: 'owner-1',
          email: 'owner@example.com',
          firstName: 'Owner',
          lastName: 'One',
        },
        createdAt: new Date('2026-09-20T10:00:00.000Z'),
        updatedAt: new Date(options.updatedAt ?? '2026-09-21T10:00:00.000Z'),
        meeting: {
          id: 'meeting-1',
          clientId: 'client-1',
          subject: 'Client review',
          startsAt: new Date('2026-09-19T14:00:00.000Z'),
        },
      }];
  return buildDebriefReadResult(ctx, selection, {
    rows,
    sourceStatus: options.sourceStatus ?? 'healthy',
    sourceReason: options.sourceStatus === 'degraded' ? 'body_unavailable' : null,
    nextAfter: null,
  });
}

describe('query_debriefs current owner proof', () => {
  it('is a finite supported owner and compares canonical bytes/version, not IDs or counts', () => {
    const saved = result();
    expect(supportsDurableOwnerReauthorization('query_debriefs')).toBe(true);
    expect(publicResearchSourceTool('query_debriefs')).toBe('query_debriefs');
    expect(publicResearchSourceTool('query_meeting_transcripts')).toBeNull();
    expect(currentOwnerResultAuthorizesReplay('query_debriefs', saved, result())).toBe(true);
    expect(currentOwnerResultAuthorizesReplay(
      'query_debriefs',
      saved,
      result({ body: 'Edited body with the same IDs and count' }),
    )).toBe(false);
    expect(currentOwnerResultAuthorizesReplay(
      'query_debriefs',
      saved,
      result({ updatedAt: '2026-09-22T10:00:00.000Z' }),
    )).toBe(false);
  });

  it.each([
    ['permission revoked', { rows: false }],
    ['parent/client or lifecycle no longer eligible', { rows: false }],
    ['owner health degraded', { sourceStatus: 'degraded' }],
  ] as const)('invalidates replay when %s', (_label, options) => {
    expect(currentOwnerResultAuthorizesReplay('query_debriefs', result(), result(options))).toBe(false);
  });

  it('rejects a projection whose current parent client does not match the canonical client', () => {
    const changed = result() as any;
    changed.debriefs[0].meeting.clientId = 'client-2';
    changed.debriefs[0].clientId = 'client-2';
    changed.debriefs[0].provenance.currentClientId = 'client-2';

    expect(debriefOwnerProof(changed)).toBeNull();
    expect(currentOwnerResultAuthorizesReplay('query_debriefs', result(), changed)).toBe(false);
  });

  it('does not treat explanatory or generated-at changes as a source version change', () => {
    const current = result() as any;
    current.generatedAt = '2030-01-01T00:00:00.000Z';
    current.coverage.note = 'Different safe explanatory copy';
    current.debriefs[0].bodyCoverage.note = 'Different safe explanatory copy';

    expect(currentOwnerResultAuthorizesReplay('query_debriefs', result(), current)).toBe(true);
  });
});
