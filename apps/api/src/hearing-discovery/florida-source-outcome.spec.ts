import { floridaSourceOutcome } from './florida-source-outcome.js';

describe('Florida source availability versus event qualification', () => {
  it('retains a partial event gap without falsely reporting the publisher down', () => {
    const result = floridaSourceOutcome({
      pages: 7,
      observations: 1,
      issues: ['Joint sitting session remains unknown'],
      sourceIssues: [],
    });
    expect(result.coverage).toBe('partial');
    expect(result.health).toEqual({ ok: true, observedEvents: 1, error: null });
  });
  it('does not qualify a negative result merely because the publisher is reachable', () => {
    const result = floridaSourceOutcome({
      pages: 7,
      observations: 0,
      issues: ['Unresolved notice identity'],
      sourceIssues: [],
    });
    expect(result.coverage).toBe('failed');
    expect(result.health.ok).toBe(true);
  });
  it('preserves partial fetched work and exposes the actual failed source', () => {
    const issue = 'House 2026-09-15: Florida source HTTP 503';
    const result = floridaSourceOutcome({
      pages: 6,
      observations: 2,
      issues: [issue],
      sourceIssues: [issue],
    });
    expect(result.coverage).toBe('partial');
    expect(result.health).toEqual({ ok: false, observedEvents: 2, error: issue });
  });
  it('requires an actual source read for a successful health observation', () => {
    const result = floridaSourceOutcome({
      pages: 0,
      observations: 0,
      issues: [],
      sourceIssues: [],
    });
    expect(result.health.ok).toBe(false);
    expect(result.coverage).toBe('failed');
  });
  it('qualifies a verified empty window without creating events', () => {
    const result = floridaSourceOutcome({
      pages: 7,
      observations: 0,
      issues: [],
      sourceIssues: [],
    });
    expect(result.coverage).toBe('complete');
    expect(result.health).toEqual({ ok: true, observedEvents: 0, error: null });
  });
  it('does not lose a source failure if it was not duplicated into qualification issues', () => {
    const result = floridaSourceOutcome({
      pages: 1,
      observations: 0,
      issues: [],
      sourceIssues: ['Senate meeting table unavailable'],
    });
    expect(result.coverage).toBe('failed');
    expect(result.health.ok).toBe(false);
  });
});
