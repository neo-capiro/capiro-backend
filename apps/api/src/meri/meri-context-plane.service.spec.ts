jest.mock('../context/context-plane-gateway.service.js', () => ({ ContextPlaneGatewayService: class ContextPlaneGatewayService {} }));
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class PrismaService {} }));

import { planMeriTurn } from './meri-context-plane.service.js';

describe('MeriContextPlaneService Phase 19 planning', () => {
  test.each([
    ['Research RTX', 'RTX'],
    ['Research "RTX"', 'RTX'],
    ['RESEARCH RTX', 'RTX'],
    ['Research RTX instead of this client', 'RTX'],
    ['Do not use this client; Research RTX', 'RTX'],
    ['Compare RTX and LMT', 'RTX'],
    ['Tell me about SAC Capital', 'SAC Capital'],
    ['Tell me about PE Systems', 'PE Systems'],
  ])('preserves an explicitly requested external organization: %s', (task, targetHint) => {
    const plan = planMeriTurn({ task, uiClientId: 'client-acme', uiClientName: 'Acme Defense' });
    expect(plan).toMatchObject({ subjectScope: 'external_entity', targetHint, query: targetHint });
  });

  test.each([
    'Analyze FY27 appropriations for this client',
    'Find eligible grant funding for this client',
    'Check NIH grants for this client',
    'Compare FY 2027 and FY 2026 for this client',
    'Compare RTX and LMT for this client',
    'Prepare a meeting briefing for HASC staff',
    'Prepare hearing intelligence on FY27 appropriations',
    'Analyze NDAA implementation implications for this client',
    'Prepare an executive briefing with the constraint "Enacted only"',
  ])('keeps the selected client and strategy inputs for professional work: %s', (task) => {
    const plan = planMeriTurn({ task, uiClientId: 'client-acme', uiClientName: 'Acme Defense' });
    expect(plan.subjectScope).toBe('client');
    expect(plan.requestedDomains).toEqual(expect.arrayContaining(['clients', 'contacts', 'strategies_work', 'institutional_knowledge']));
    expect(plan.query).toBeUndefined();
  });

  test('meeting preparation keeps the meeting rail as well as client strategy', () => {
    const plan = planMeriTurn({ task: 'Prepare a meeting briefing', uiClientId: 'client-acme', uiClientName: 'Acme Defense' });
    expect(plan.requestedDomains).toContain('meetings');
    expect(plan.requestedDomains).toContain('strategies_work');
  });

  test('selected-client strategies are retrieved without requiring the client name in their bodies', () => {
    const plan = planMeriTurn({ task: 'Review our strategies and unresolved work', uiClientId: 'client-acme', uiClientName: 'Acme Defense' });
    expect(plan.subjectScope).toBe('client');
    expect(plan.requestedDomains).toContain('strategies_work');
    expect(plan.query).toBeUndefined();
  });

  test('client briefings and recent changes include strategy work', () => {
    for (const task of ['Prepare a briefing', 'What changed recently?']) {
      const plan = planMeriTurn({ task, uiClientId: 'client-acme', uiClientName: 'Acme Defense' });
      expect(plan.requestedDomains).toContain('strategies_work');
      expect(plan.query).toBeUndefined();
    }
  });

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
    expect(plan.requestedDomains).toEqual(['clients', 'contacts', 'tasks', 'outreach', 'strategies_work']);
  });

  test('a client memory question preserves the selected client subject', () => {
    const plan = planMeriTurn({ task: 'What do you remember about this client?', uiClientId: 'client-acme', uiClientName: 'Acme Defense' });
    expect(plan).toMatchObject({ subjectScope: 'client', targetHint: null, queryClass: 'semantic_recall', requestedDomains: ['institutional_knowledge'] });
  });

  test('explicit external memory questions are not silently attributed to the selected client', () => {
    const plan = planMeriTurn({ task: 'What do you remember about RTX?', uiClientId: 'client-acme', uiClientName: 'Acme Defense' });
    expect(plan).toMatchObject({ subjectScope: 'external_entity', targetHint: 'RTX', queryClass: 'semantic_recall' });
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
