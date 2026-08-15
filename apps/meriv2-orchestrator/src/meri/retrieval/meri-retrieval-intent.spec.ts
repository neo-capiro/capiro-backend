import {
  classifyMeriRetrievalIntent,
  meriRetrievalIntentPrompt,
  meriRetrievalTargetHint,
} from './meri-retrieval-intent.js';

describe('classifyMeriRetrievalIntent', () => {
  test('treats a weekly cross-client change request as an exhaustive portfolio scan', () => {
    const result = classifyMeriRetrievalIntent(
      'What changed across my clients this week?',
      'selected-client',
    );

    expect(result).toEqual(
      expect.objectContaining({
        subjectScope: 'portfolio',
        queryClass: 'change_detection',
        requireCompleteCoverage: true,
        includeFocusedClientContext: false,
        targetHint: null,
      }),
    );
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining([
        'explicit_portfolio_scope',
        'change_request',
        'complete_coverage_required',
      ]),
    );
  });

  test('recognizes an inbox relationship brief about a named non-client entity', () => {
    const result = classifyMeriRetrievalIntent(
      'Look in my inbox and tell me everything I should know about Victory 6',
      'stale-ui-client',
    );

    expect(result).toEqual(
      expect.objectContaining({
        subjectScope: 'external_entity',
        queryClass: 'relationship_history',
        requireCompleteCoverage: true,
        includeFocusedClientContext: false,
        targetHint: 'Victory 6',
      }),
    );
  });

  test('recognizes an email summary about a named organization as external to stale UI focus', () => {
    const result = classifyMeriRetrievalIntent(
      'Give me a summary of my emails from Powers Interactive',
      'legistorm-client-id',
    );

    expect(result.subjectScope).toBe('external_entity');
    expect(result.queryClass).toBe('relationship_history');
    expect(result.includeFocusedClientContext).toBe(false);
    expect(result.targetHint).toBe('Powers Interactive');
  });

  test('automatically classifies a misspelled domain-style company request for federal-market research', () => {
    const result = classifyMeriRetrievalIntent(
      'Give me a comprehensive strategy on kindeticindustries.inc. Tell me what Program Elements, grants, or government contracts they should pursue.',
      'stale-ui-client',
    );

    expect(result).toEqual(
      expect.objectContaining({
        subjectScope: 'external_entity',
        queryClass: 'federal_market_analysis',
        requireCompleteCoverage: true,
        includeFocusedClientContext: false,
        targetHint: 'kindeticindustries.inc',
      }),
    );
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining(['external_discovery', 'federal_market_request']),
    );
  });

  test('treats a simple explicit company name as independent from stale client focus', () => {
    const result = classifyMeriRetrievalIntent('Tell me about Anduril', 'legistorm-client-id');

    expect(result).toEqual(
      expect.objectContaining({
        subjectScope: 'external_entity',
        queryClass: 'lookup',
        includeFocusedClientContext: false,
        targetHint: 'Anduril',
      }),
    );
    expect(result.reasonCodes).toContain('explicit_named_subject');
  });

  test('does not mistake a client-scoped topic for an external entity', () => {
    const result = classifyMeriRetrievalIntent(
      'What did our client say about pricing strategy?',
      'client-a',
    );

    expect(result.subjectScope).toBe('client');
    expect(result.includeFocusedClientContext).toBe(true);
  });

  test('retains the selected client only as a deliberate comparison anchor', () => {
    const result = classifyMeriRetrievalIntent(
      'Compare my client with Shield AI',
      'client-a',
    );

    expect(result).toEqual(
      expect.objectContaining({
        subjectScope: 'external_entity',
        queryClass: 'comparison',
        includeFocusedClientContext: true,
        targetHint: 'Shield AI',
      }),
    );
  });

  test('keeps an ordinary focused-client question client-scoped', () => {
    const result = classifyMeriRetrievalIntent(
      "What are this client's active congressional priorities?",
      'client-a',
    );

    expect(result.subjectScope).toBe('client');
    expect(result.includeFocusedClientContext).toBe(true);
  });

  test('does not mistake a literal client reference for a named external entity', () => {
    const result = classifyMeriRetrievalIntent('Tell me about client B', 'client-a');

    expect(result.subjectScope).toBe('client');
    expect(result.includeFocusedClientContext).toBe(true);
    expect(result.targetHint).toBeNull();
  });

  test('classifies the explicit Search across clients command as portfolio-wide', () => {
    const result = classifyMeriRetrievalIntent('Search across clients', 'client-a');

    expect(result.subjectScope).toBe('portfolio');
    expect(result.queryClass).toBe('portfolio_scan');
    expect(result.requireCompleteCoverage).toBe(true);
  });
});

describe('meriRetrievalTargetHint', () => {
  test.each([
    ['Tell me everything about Victory Six', 'Victory Six'],
    ['Give me a strategy on Kinetic Industries Inc.', 'Kinetic Industries Inc'],
    ['Compare my client with Shield AI', 'Shield AI'],
    ['Research https://www.saronic.com/ and tell me what they do', 'saronic.com'],
  ])('extracts %s', (request, expected) => {
    expect(meriRetrievalTargetHint(request)).toBe(expected);
  });
});

describe('meriRetrievalIntentPrompt', () => {
  test('states that a stale selected client must not narrow external research', () => {
    const intent = classifyMeriRetrievalIntent(
      'Give me a summary of my emails from Powers Interactive',
      'legistorm-client-id',
    );
    const prompt = meriRetrievalIntentPrompt(intent, 'legistorm-client-id');

    expect(prompt).toContain('Subject scope: external_entity.');
    expect(prompt).toContain('Named subject hint: Powers Interactive.');
    expect(prompt).toContain('it is NOT the subject');
    expect(prompt).toContain('Do not silently narrow tool calls');
    expect(prompt).toContain('Zero matches are not proof of absence');
    expect(prompt).toContain('search_research_sources is broad INTERNAL discovery');
  });

  test('requires portfolio enumeration rather than a handful of search hits', () => {
    const intent = classifyMeriRetrievalIntent(
      'What changed across my clients this week?',
      'client-a',
    );
    const prompt = meriRetrievalIntentPrompt(intent, 'client-a');

    expect(prompt).toContain('Enumerate the authorized client roster');
    expect(prompt).toContain('A few top search hits are not a portfolio scan');
    expect(prompt).toContain('Complete coverage required: yes.');
  });
});
