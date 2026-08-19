import { planMeriTurn } from './meri-context-plane.service.js';

describe('MeriContextPlaneService Phase 19 planning', () => {
  test('named external entity wins over an unrelated selected client', () => {
    const plan = planMeriTurn({
      task: 'Tell me everything we know about RTX',
      uiClientId: 'client-acme',
      uiClientName: 'Acme Defense',
      now: new Date('2026-08-18T12:00:00.000Z'),
    });

    expect(plan).toMatchObject({
      subjectScope: 'external_entity',
      targetHint: 'RTX',
      queryClass: 'lookup',
      query: 'RTX',
    });
    expect(plan.requestedDomains).toEqual([
      'clients',
      'contacts',
      'institutional_knowledge',
    ]);
  });

  test('explicitly naming the selected client keeps the client as subject', () => {
    const plan = planMeriTurn({
      task: 'What do we know about ACME DEFENSE?',
      uiClientId: 'client-acme',
      uiClientName: 'ACME DEFENSE',
    });

    expect(plan.subjectScope).toBe('client');
    expect(plan.targetHint).toBeNull();
  });

  test('portfolio language preserves the authorized portfolio subject', () => {
    const plan = planMeriTurn({
      task: 'What changed across our clients?',
      uiClientId: 'client-acme',
      uiClientName: 'ACME DEFENSE',
    });

    expect(plan).toMatchObject({
      subjectScope: 'portfolio',
      queryClass: 'portfolio_scan',
      requireComplete: true,
    });
    expect(plan.requestedDomains).toEqual(['clients', 'contacts', 'tasks', 'outreach']);
  });

  test('personal recall is routed through governed institutional knowledge', () => {
    const plan = planMeriTurn({
      task: 'What do you remember about my writing preferences?',
      uiClientId: null,
      uiClientName: null,
    });

    expect(plan).toMatchObject({
      subjectScope: 'general',
      queryClass: 'semantic_recall',
      requestedDomains: ['institutional_knowledge'],
    });
  });

  test('trivial conversation does not manufacture retrieval coverage', () => {
    const plan = planMeriTurn({
      task: 'Thanks!',
      uiClientId: 'client-acme',
      uiClientName: 'ACME DEFENSE',
    });

    expect(plan.subjectScope).toBe('general');
    expect(plan.requestedDomains).toEqual([]);
  });

  test('relationship history asks only domains that support relationship_history', () => {
    const plan = planMeriTurn({
      task: 'Show me our communications and relationship history with RTX',
      uiClientId: null,
      uiClientName: null,
      now: new Date('2026-08-18T12:00:00.000Z'),
    });

    expect(plan.queryClass).toBe('relationship_history');
    expect(plan.requestedDomains).toEqual(['contacts', 'mail', 'meetings']);
    expect(plan.requestedDomains).not.toContain('outreach');
  });
});
