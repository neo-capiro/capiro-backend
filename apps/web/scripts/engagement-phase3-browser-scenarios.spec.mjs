#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertPhase3ScenarioResults,
  buildPhase3BrowserScenarios,
} from './engagement-phase3-browser-scenarios.mjs';

const fixtures = {
  anchor: '2026-08-07T12:00:00.000Z',
  ids: {
    'client.alpha': 'e3000000-0000-4000-8000-000000050001',
    'meeting.past': 'e3000000-0000-4000-8000-000000080003',
    'meeting.deepLinkOutsideRange': 'e3000000-0000-4000-8000-000000080007',
    'absent.meeting': 'e3000000-0000-4000-8000-0000001f0001',
    'outreach.partialWizard': 'e3000000-0000-4000-8000-000000100002',
  },
};

test('catalog covers all required Phase 3 browser domains without duplicate ids', () => {
  const scenarios = buildPhase3BrowserScenarios(fixtures);
  assert.ok(scenarios.length >= 22);
  assert.equal(new Set(scenarios.map((scenario) => scenario.id)).size, scenarios.length);

  const ids = new Set(scenarios.map((scenario) => scenario.id));
  for (const required of [
    'meetings-default',
    'meetings-legacy-overview',
    'meetings-day',
    'meetings-month',
    'meetings-list',
    'meetings-calendar-alias',
    'meetings-legacy-range',
    'meeting-deep-prep',
    'meeting-deep-notes',
    'meeting-deep-debrief',
    'meeting-outside-visible-range',
    'meeting-deleted-not-found',
    'outreach-list',
    'outreach-new-wizard',
    'outreach-partial-resume',
    'reports-current',
    'reports-previous',
    'reports-all',
    'reports-filter-sort-query',
    'integrations',
    'home-cross-surface',
    'client-profile-cross-surface',
  ]) {
    assert.equal(ids.has(required), true, required);
  }
});

test('fixture-backed scenarios fail closed when a required row is missing', () => {
  const drifted = { anchor: fixtures.anchor, ids: { ...fixtures.ids } };
  delete drifted.ids['meeting.deepLinkOutsideRange'];
  assert.throws(
    () => buildPhase3BrowserScenarios(drifted),
    /meeting\.deepLinkOutsideRange/,
  );
});

test('scenario accounting rejects missing, duplicate, and non-terminal results', () => {
  const scenarios = buildPhase3BrowserScenarios(fixtures);
  const complete = scenarios.map((scenario) => ({
    scenarioId: scenario.id,
    status: 'PASS_MAIN_AND_PREVIEW',
  }));
  assert.doesNotThrow(() => assertPhase3ScenarioResults(scenarios, complete));

  assert.throws(
    () => assertPhase3ScenarioResults(scenarios, complete.slice(1)),
    /missing=/,
  );
  assert.throws(
    () => assertPhase3ScenarioResults(scenarios, [...complete, complete[0]]),
    /duplicates=/,
  );
  assert.throws(
    () =>
      assertPhase3ScenarioResults(scenarios, [
        ...complete.slice(1),
        { scenarioId: complete[0].scenarioId, status: 'NOT_RUN' },
      ]),
    /no terminal acceptance state/,
  );
});

test('report filter/sort/query preservation is an explicit required scenario', () => {
  const scenario = buildPhase3BrowserScenarios(fixtures).find(
    (row) => row.id === 'reports-filter-sort-query',
  );
  assert.deepEqual(scenario.expectedSearch, {
    period: 'previous',
    status: 'complete',
    sort: 'pending-desc',
    'phase3-preserve': 'reports',
  });
});
