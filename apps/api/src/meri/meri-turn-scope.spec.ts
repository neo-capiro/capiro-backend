import { captureMeriTurnScope } from './meri-turn-scope.js';

const selected = { clientId: 'l3', client: { id: 'l3', name: 'L3 Harris' } };

describe('immutable Meri turn scope', () => {
  it('records client identity from the dispatch snapshot', () => {
    expect(captureMeriTurnScope(selected, { plan: { subjectScope: 'client' } }, { clientId: 'l3' }))
      .toEqual({ kind: 'client', clientId: 'l3', clientName: 'L3 Harris', targetHint: null });
  });
  it.each(['portfolio', 'general'] as const)('does not relabel %s retrieval with the selected client', (kind) => {
    expect(captureMeriTurnScope(selected, { plan: { subjectScope: kind } }, { clientId: null }))
      .toEqual({ kind, clientId: null, clientName: null, targetHint: null });
  });
  it('keeps the actual external subject even with another client selected', () => {
    expect(captureMeriTurnScope(selected, { plan: { subjectScope: 'external_entity', targetHint: 'Anduril' } }))
      .toEqual({ kind: 'external_entity', clientId: null, clientName: null, targetHint: 'Anduril' });
  });
  it('does not substitute a picker for a conflicting or unscoped packet', () => {
    expect(captureMeriTurnScope(selected, { plan: { subjectScope: 'client' } }, { clientId: 'anduril' }))
      .toMatchObject({ kind: 'client', clientId: 'anduril', clientName: null });
    expect(captureMeriTurnScope(selected, { plan: { subjectScope: 'client' } }, { clientId: null }).kind)
      .toBe('unknown');
  });
  it('keeps absent or unrecognized retrieval scope unknown', () => {
    expect(captureMeriTurnScope(selected).kind).toBe('unknown');
    expect(captureMeriTurnScope(selected, { plan: { subjectScope: 'future' } }).kind).toBe('unknown');
  });
});
