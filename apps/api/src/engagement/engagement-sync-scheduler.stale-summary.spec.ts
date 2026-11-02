/**
 * The hourly staleness watchdog is the only signal that a mailbox stopped
 * syncing. It used to cover only status IN ('connected','error'), so the two
 * quietest failures were invisible: a connection parked in needs_configuration
 * by a dead refresh token, and a 'connected' row the scheduler can never claim
 * because its creator's tenant membership is no longer active.
 */
import { summarizeStaleConnections } from './engagement-sync-scheduler.service.js';

const at = (value: string | null) => (value ? new Date(value) : null);

describe('summarizeStaleConnections', () => {
  it('says nothing when every schedulable connection is fresh', () => {
    expect(summarizeStaleConnections([])).toEqual([]);
  });

  it('names the exclusion reason for a connected row the scheduler cannot claim', () => {
    const lines = summarizeStaleConnections([
      {
        account_email: 'ryan@capiro.ai',
        last_sync_at: at('2026-10-22T13:19:18.670Z'),
        status: 'connected',
        block: 'creator_membership_inactive',
      },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('ryan@capiro.ai');
    expect(lines[0]).toContain('creator_membership_inactive');
    expect(lines[0]).toContain('2026-10-22');
  });

  it('reports connections parked in needs_configuration with a bounded name list', () => {
    const rows = [
      {
        account_email: 'a@one.test',
        last_sync_at: at('2026-09-06T00:00:00Z'),
        status: 'needs_configuration',
        block: 'needs_reconfiguration',
      },
      {
        account_email: 'b@one.test',
        last_sync_at: at('2026-09-27T00:00:00Z'),
        status: 'needs_configuration',
        block: 'needs_reconfiguration',
      },
      {
        account_email: 'c@one.test',
        last_sync_at: at('2026-09-28T00:00:00Z'),
        status: 'needs_configuration',
        block: 'needs_reconfiguration',
      },
      {
        account_email: 'd@one.test',
        last_sync_at: null,
        status: 'needs_configuration',
        block: 'needs_reconfiguration',
      },
    ];
    const lines = summarizeStaleConnections(rows);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('4');
    expect(lines[0]).toContain('a@one.test');
    expect(lines[0]).toContain('+1 more');
  });

  it('keeps stalled and reconfiguration findings as separate lines', () => {
    const lines = summarizeStaleConnections([
      {
        account_email: 'stalled@one.test',
        last_sync_at: at('2026-10-22T13:19:18.670Z'),
        status: 'connected',
        block: 'scheduled',
      },
      {
        account_email: 'dead@one.test',
        last_sync_at: at('2026-09-06T00:00:00Z'),
        status: 'needs_configuration',
        block: 'needs_reconfiguration',
      },
      {
        account_email: 'fenced@one.test',
        last_sync_at: at('2026-10-31T00:00:00Z'),
        status: 'connected',
        block: 'oauth_attempt_pending',
      },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/stale >24h/);
    expect(lines[0]).toContain('stalled@one.test');
    expect(lines[0]).toContain('fenced@one.test');
    expect(lines[1]).toMatch(/re-configuration|reconfiguration/i);
    expect(lines[1]).toContain('dead@one.test');
  });

  it('tolerates a connection with no recorded address or sync time', () => {
    const lines = summarizeStaleConnections([
      { account_email: null, last_sync_at: null, status: 'connected', block: 'scheduled' },
    ]);
    expect(lines[0]).toContain('last=never');
    expect(lines[0]).not.toContain('undefined');
  });
});
