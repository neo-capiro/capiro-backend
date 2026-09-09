import { pacCoverage } from './fec-pac-coverage.js';

describe('PAC coverage evidence', () => {
  const completedAt = new Date('2026-08-01T00:00:00Z');
  it('requires every committee and cycle, not just one successful import', () => {
    const states = [{ committeeId: 'C1', cycle: 2026, status: 'complete', completedAt }];
    expect(pacCoverage(['C1', 'C2'], [2024, 2026], states, false).status).toBe('partial');
    expect(pacCoverage(['C1'], [2026], states, false).status).toBe('complete');
  });
  it('ignores states belonging to other clients or periods', () => {
    const states = [{ committeeId: 'OTHER', cycle: 2026, status: 'error', completedAt }];
    expect(pacCoverage(['C1'], [2026], states, false)).toMatchObject({ status: 'pending', lastSyncedAt: null });
  });
  it('never calls legacy rows or an in-flight refresh complete', () => {
    expect(pacCoverage(['C1'], [2026], [], true).status).toBe('partial');
    expect(pacCoverage(['C1'], [2026], [{ committeeId: 'C1', cycle: 2026,
      status: 'running', completedAt }], false).status).toBe('partial');
  });
});
