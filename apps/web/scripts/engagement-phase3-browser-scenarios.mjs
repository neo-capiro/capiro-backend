#!/usr/bin/env node
/**
 * Pure, deterministic browser scenario catalog for Phase 3.
 *
 * The browser runner consumes this catalog for BOTH main and preview contexts.
 * A scenario is never silently dropped: fixture-backed scenarios throw while
 * building when their required id is absent, and the runner must emit one
 * terminal result for every catalog entry.
 */

function requiredId(fixtures, key) {
  const value = fixtures?.ids?.[key];
  if (typeof value !== 'string' || !value) {
    throw new Error(`Phase 3 browser fixture index is missing ${key}`);
  }
  return value;
}

function anchorDate(fixtures) {
  const raw = fixtures?.anchor;
  const parsed = typeof raw === 'string' ? new Date(raw) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) {
    throw new Error('Phase 3 browser fixture index has no valid anchor');
  }
  return parsed.toISOString().slice(0, 10);
}

function state(id, category, pathname, expectedPathname, options = {}) {
  return {
    id,
    category,
    pathname,
    expectedPathname,
    requiredText: options.requiredText ?? [],
    forbiddenText: options.forbiddenText ?? [],
    expectedSearch: options.expectedSearch ?? {},
    absentSearch: options.absentSearch ?? [],
    requireEngagementRequest: options.requireEngagementRequest ?? true,
  };
}

export function buildPhase3BrowserScenarios(fixtures) {
  const date = anchorDate(fixtures);
  const clientId = requiredId(fixtures, 'client.alpha');
  const meetingPast = requiredId(fixtures, 'meeting.past');
  const meetingOutside = requiredId(fixtures, 'meeting.deepLinkOutsideRange');
  const absentMeeting = requiredId(fixtures, 'absent.meeting');
  const partialOutreach = requiredId(fixtures, 'outreach.partialWizard');

  return [
    state('meetings-default', 'meetings', '/engagement', '/engagement/meetings', {
      requiredText: ['Meetings'],
    }),
    state(
      'meetings-legacy-overview',
      'meetings',
      '/engagement/overview',
      '/engagement/meetings',
      { requiredText: ['Meetings'] },
    ),
    state(
      'meetings-day',
      'meetings',
      `/engagement/meetings?date=${date}`,
      '/engagement/meetings',
      { expectedSearch: { date }, requiredText: ['Meetings', 'Day', 'List', 'Month'] },
    ),
    state(
      'meetings-month',
      'meetings',
      `/engagement/meetings?view=month&date=${date}`,
      '/engagement/meetings',
      { expectedSearch: { view: 'month', date }, requiredText: ['Meetings', 'Month'] },
    ),
    state(
      'meetings-list',
      'meetings',
      `/engagement/meetings?view=list&date=${date}`,
      '/engagement/meetings',
      { expectedSearch: { view: 'list', date }, requiredText: ['Meetings', 'List'] },
    ),
    state(
      'meetings-calendar-alias',
      'meetings',
      `/engagement/meetings?view=calendar&date=${date}`,
      '/engagement/meetings',
      { expectedSearch: { view: 'month', date }, requiredText: ['Meetings', 'Month'] },
    ),
    state(
      'meetings-legacy-range',
      'meetings',
      `/engagement/meetings?from=${date}&to=${date}`,
      '/engagement/meetings',
      { requiredText: ['Meetings'] },
    ),
    state(
      'meeting-deep-prep',
      'meetings',
      `/engagement/meetings/${meetingPast}?detail=prep&date=${date}`,
      `/engagement/meetings/${meetingPast}`,
      { expectedSearch: { date }, requiredText: ['Past appropriations meeting', 'Prep'] },
    ),
    state(
      'meeting-deep-notes',
      'meetings',
      `/engagement/meetings/${meetingPast}?detail=notes&date=${date}`,
      `/engagement/meetings/${meetingPast}`,
      {
        expectedSearch: { detail: 'notes', date },
        requiredText: ['Past appropriations meeting', 'Notes'],
      },
    ),
    state(
      'meeting-deep-debrief',
      'meetings',
      `/engagement/meetings/${meetingPast}?detail=debrief&date=${date}`,
      `/engagement/meetings/${meetingPast}`,
      {
        expectedSearch: { detail: 'debrief', date },
        requiredText: ['Past appropriations meeting', 'Debrief'],
      },
    ),
    state(
      'meeting-outside-visible-range',
      'meetings',
      `/engagement/meetings/${meetingOutside}?detail=prep&date=${date}`,
      `/engagement/meetings/${meetingOutside}`,
      {
        expectedSearch: { date },
        requiredText: ['Deep-linked meeting outside visible range'],
      },
    ),
    state(
      'meeting-deleted-not-found',
      'meetings',
      `/engagement/meetings/${absentMeeting}?date=${date}`,
      `/engagement/meetings/${absentMeeting}`,
      { expectedSearch: { date }, requiredText: ['Meeting not found'] },
    ),
    state('outreach-list', 'outreach', '/engagement/outreach', '/engagement/outreach', {
      requiredText: ['Outreach', 'Draft campaign at step 1', 'Sent campaign'],
    }),
    state(
      'outreach-new-wizard',
      'outreach',
      '/engagement/outreach/new',
      '/engagement/outreach/new/wizard',
      { requiredText: ['Step 1 of 6', 'Direction'] },
    ),
    state(
      'outreach-partial-resume',
      'outreach',
      `/engagement/outreach/draft/${partialOutreach}`,
      `/engagement/outreach/draft/${partialOutreach}`,
      { requiredText: ['Step 4 of 6', 'Build Context'] },
    ),
    state('reports-current', 'reports', '/engagement/reports', '/engagement/reports', {
      requiredText: ['Reports', 'Current Cycle', 'Office Engagement Tracker'],
    }),
    state(
      'reports-previous',
      'reports',
      '/engagement/reports?period=previous',
      '/engagement/reports',
      { expectedSearch: { period: 'previous' }, requiredText: ['Previous Cycle'] },
    ),
    state(
      'reports-all',
      'reports',
      '/engagement/reports?period=all',
      '/engagement/reports',
      { expectedSearch: { period: 'all' }, requiredText: ['All Time'] },
    ),
    state(
      'reports-filter-sort-query',
      'reports',
      '/engagement/reports?period=previous&status=complete&sort=pending-desc&phase3-preserve=reports',
      '/engagement/reports',
      {
        expectedSearch: {
          period: 'previous',
          status: 'complete',
          sort: 'pending-desc',
          'phase3-preserve': 'reports',
        },
        requiredText: ['Reports', 'Previous Cycle'],
      },
    ),
    state('integrations', 'integrations', '/settings/integrations', '/settings/integrations', {
      requiredText: ['Microsoft 365', 'Google Workspace'],
    }),
    state('home-cross-surface', 'cross-surface', '/', '/', {
      requireEngagementRequest: true,
    }),
    state(
      'client-profile-cross-surface',
      'cross-surface',
      `/clients/${clientId}`,
      `/clients/${clientId}`,
      { requireEngagementRequest: true, requiredText: ['Alpha Systems'] },
    ),
  ];
}

export function assertPhase3ScenarioResults(scenarios, results) {
  const expected = new Set(scenarios.map((scenario) => scenario.id));
  const observed = new Set(results.map((result) => result.scenarioId));
  const missing = [...expected].filter((id) => !observed.has(id));
  const unknown = [...observed].filter((id) => !expected.has(id));
  const duplicates = results
    .map((result) => result.scenarioId)
    .filter((id, index, all) => all.indexOf(id) !== index);
  if (missing.length || unknown.length || duplicates.length) {
    throw new Error(
      `Phase 3 browser scenario accounting failed: ` +
        `missing=[${missing.join(', ')}] unknown=[${unknown.join(', ')}] ` +
        `duplicates=[${[...new Set(duplicates)].join(', ')}]`,
    );
  }
  const unfinished = results.filter(
    (result) => !['PASS_MAIN_AND_PREVIEW', 'BASELINE_DEFECT_PROVEN'].includes(result.status),
  );
  if (unfinished.length) {
    throw new Error(
      `Phase 3 browser scenarios have no terminal acceptance state: ` +
        unfinished.map((result) => result.scenarioId).join(', '),
    );
  }
}
