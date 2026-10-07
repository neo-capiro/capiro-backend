const assert = require('node:assert/strict');
const {
  generateComprehensiveMeetingPrep,
} = require('./dist/engagement/meeting-prep-comprehensive.js');
const { withMeetingPrepExecution } = require('./dist/engagement/meeting-prep-job-runtime.js');
const { MEETING_BRIEFING_SECTIONS } = require('./dist/engagement/meeting-prep-policy.js');

const sources = Array.from({ length: 5 }, (_, index) => ({
  id: `mail:large-${index}`,
  kind: 'mail',
  title: 'Synthetic source',
  recordId: `large-${index}`,
  observedAt: null,
  excerpt: 'A'.repeat(39_000),
}));
const input = {
  meeting: { id: 'synthetic', subject: 'Synthetic', startsAt: '2026-10-06T18:00:00Z' },
  client: null,
  attendees: [],
  congressionalDirectoryMatches: [],
  recentMeetings: [],
  recentThreads: [],
  tasks: [],
  evidenceSources: sources,
};
let active = 0;
let maximumActive = 0;
let repairs = 0;
let release;
let reachedFour;
const gate = new Promise((resolve) => { release = resolve; });
const fourStarted = new Promise((resolve) => { reachedFour = resolve; });
const reply = (value) => ({
  text: JSON.stringify(value),
  usage: { inputTokens: 1, outputTokens: 1 },
  truncated: false,
  stopReason: 'end_turn',
  raw: {},
});
const draft = (pass, facts) => ({
  takeaways: [{ text: `Synthetic pass ${pass}`, factIds: facts.slice(0, 1).map((fact) => fact.id) }],
  sections: Object.fromEntries(
    MEETING_BRIEFING_SECTIONS.map((section) => [section, {
      status: section === 'commitments' ? 'evidence_found' : 'no_evidence',
      items: section === 'commitments' ? [{ text: 'Synthetic commitment', factIds: [] }] : [],
      gap: section === 'commitments' ? '' : 'No evidence in synthetic scope.',
    }]),
  ),
  limitations: [],
});
const complete = async (request) => {
  const payload = JSON.parse(request.userVolatile);
  const stage = request.jsonSchemaName;
  if (stage.endsWith('extracting')) {
    assert.equal(request.reasoningEffort, 'medium');
    active++;
    maximumActive = Math.max(maximumActive, active);
    if (active === 4) reachedFour();
    await gate;
    active--;
    return reply({ facts: [{
      section: 'commitments',
      text: 'Synthetic commitment',
      sourceId: payload.sources[0].id,
      quote: 'AAAA',
      importance: 'critical',
      state: 'open',
      eventAt: null,
    }], limitations: [] });
  }
  if (stage.endsWith('checking_coverage')) {
    assert.equal(request.reasoningEffort, 'medium');
    const pass = Number(payload.draft.takeaways[0].text.split(' ').at(-1));
    return reply({ omittedFactIds: pass < 2 ? [payload.ledger[0].id] : [] });
  }
  if (stage.endsWith('synthesizing')) {
    assert.equal(request.reasoningEffort, 'high');
    return reply(draft(0, payload.facts));
  }
  assert.ok(stage.endsWith('repairing'));
  assert.equal(request.reasoningEffort, 'medium');
  repairs++;
  return reply(draft(repairs, payload.facts));
};

(async () => {
  assert.equal(process.version, 'v22.23.3');
  const run = withMeetingPrepExecution({
    jobId: 'synthetic',
    depth: 'standard',
    requestedAt: Date.parse('2026-10-06T18:00:00Z'),
    deadlineAt: Date.now() + 3_600_000,
    signal: new AbortController().signal,
    checkpoint: async () => {},
    loadCheckpoint: () => undefined,
    commit: async () => {},
  }, () => generateComprehensiveMeetingPrep(input, {
    provider: 'openai',
    apiKey: 'synthetic-no-network',
    model: 'gpt-6.1-sol',
    usedTenantKey: false,
  }, { complete }));
  try {
    await fourStarted;
    assert.equal(active, 4);
  } finally {
    release();
  }
  const result = await run;
  assert.equal(maximumActive, 4);
  assert.equal(repairs, 2);
  assert.ok(result.briefing.coverage.extractedBatches > 4);
  assert.equal(Object.keys(result.briefing.sections).length, 7);
  console.log('PREP_SPEED_PACKAGED_PASS');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
