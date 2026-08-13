import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildFixturePlan } from './engagement-phase3-fixture-plan.js';
import {
  PHASE3_JOB_READ_ABSENCE_REASON,
  materializePhase3Read,
  uniquePhase3Reads,
  type Phase3FixtureIndex,
  type Phase3ReadInventoryRequest,
} from './engagement-phase3-read-materialization.js';

interface Inventory {
  requests: Phase3ReadInventoryRequest[];
}

function fixtureIndex(): Phase3FixtureIndex {
  const plan = buildFixturePlan();
  const ids: Record<string, string> = {};
  for (const value of Object.values(plan)) {
    if (!Array.isArray(value)) continue;
    for (const row of value) {
      if (row && typeof row === 'object' && 'key' in row && 'id' in row) {
        ids[String((row as { key: unknown }).key)] = String((row as { id: unknown }).id);
      }
    }
  }
  return { ids };
}

function inventory(): Inventory {
  const filename = path.resolve(
    __dirname,
    '../../web/src/pages/engagement/__fixtures__/engagement-current-ui-surface-manifest.v1.json',
  );
  return JSON.parse(readFileSync(filename, 'utf8')) as Inventory;
}

describe('Phase 3 full-read materialization', () => {
  test('materializes every unique current UI read without an unresolved placeholder', () => {
    const source = inventory();
    const scoped = Boolean(process.env.ENGAGEMENT_PHASE3_SCOPE_END);
    const reads = uniquePhase3Reads(
      source.requests.filter((row) => !scoped || row.routeManifestKey),
    );
    const fixtures = fixtureIndex();
    // The exact count is generated-inventory-owned and may legitimately grow.
    // Prove we did not collapse the workload and that dedupe retained exactly
    // one entry per method/path instead of pinning a second hand-maintained count.
    expect(reads.length).toBeGreaterThanOrEqual(25);
    expect(reads).toHaveLength(
      new Set(
        source.requests
          .filter((row) => row.classification === 'read' && (!scoped || row.routeManifestKey))
          .map((row) => `${row.method} ${row.requestPath}`),
      ).size,
    );

    const materialized = reads.map((request) => ({
      request,
      result: materializePhase3Read(request, fixtures),
    }));
    for (const { request, result } of materialized) {
      expect(result.relative).not.toMatch(/:[A-Za-z0-9_]+/);
      expect(result.relative).toMatch(/^\/api\/engagement/);
      expect(result.expectation.allowedStatuses.length).toBeGreaterThan(0);
    }

    const absences = materialized.filter(
      ({ result }) => result.expectation.kind === 'declared_absence',
    );
    expect(absences).toHaveLength(1);
    expect(absences[0]?.request.routeManifestKey).toBe('GET /api/engagement/outreach/jobs/:id');
    expect(absences[0]?.result.expectation).toEqual({
      kind: 'declared_absence',
      allowedStatuses: [404],
      reason: PHASE3_JOB_READ_ABSENCE_REASON,
    });
  });

  test('adds the required attachment parent instead of accepting a matching 400', () => {
    const request = uniquePhase3Reads(inventory().requests).find(
      (row) => row.routeManifestKey === 'GET /api/engagement/attachments',
    );
    expect(request).toBeDefined();
    const fixtures = fixtureIndex();
    const result = materializePhase3Read(request!, fixtures);
    const parsed = new URL(result.relative, 'http://phase3.invalid');
    expect(parsed.searchParams.get('meetingId')).toBe(fixtures.ids['meeting.past']);
    expect(result.expectation.kind).toBe('data');
  });

  test('binds named nested parameters to the row that actually owns data', () => {
    const request = uniquePhase3Reads(inventory().requests).find(
      (row) =>
        row.routeManifestKey ===
        'GET /api/engagement/outreach/:outreachRecordId/draft-artifacts',
    );
    expect(request).toBeDefined();
    const fixtures = fixtureIndex();
    const result = materializePhase3Read(request!, fixtures);
    expect(result.relative).toBe(
      `/api/engagement/outreach/${fixtures.ids['outreach.sent']}/draft-artifacts`,
    );
    expect(result.bindings).toEqual({ outreachRecordId: 'outreach.sent' });
  });

  test('uses the real send-intent fixture and the deliberate no-job absence', () => {
    const reads = uniquePhase3Reads(inventory().requests);
    const fixtures = fixtureIndex();
    const sendIntent = materializePhase3Read(
      reads.find(
        (row) => row.routeManifestKey === 'GET /api/engagement/outreach/send-intents/:id',
      )!,
      fixtures,
    );
    expect(sendIntent.relative).toContain(fixtures.ids['sendIntent.deliveryUnknown']!);
    expect(sendIntent.expectation.kind).toBe('data');

    const job = materializePhase3Read(
      reads.find((row) => row.routeManifestKey === 'GET /api/engagement/outreach/jobs/:id')!,
      fixtures,
    );
    expect(job.relative).toContain(fixtures.ids['absent.outreachRecord']!);
    expect(job.expectation.kind).toBe('declared_absence');
  });

  test('negative controls fail on fixture drift, path drift, and unknown parameters', () => {
    const reads = uniquePhase3Reads(inventory().requests);
    const fixtures = fixtureIndex();
    const meeting = reads.find((row) => row.routeManifestKey === 'GET /api/engagement/meetings/:id')!;

    const missingMeeting = { ids: { ...fixtures.ids } };
    delete missingMeeting.ids['meeting.past'];
    expect(() => materializePhase3Read(meeting, missingMeeting)).toThrow(/meeting\.past/);

    expect(() =>
      materializePhase3Read(
        { ...meeting, requestPath: '/api/engagement/not-the-same/:param' },
        fixtures,
      ),
    ).toThrow(/structurally match/);

    expect(() =>
      materializePhase3Read(
        {
          ...meeting,
          requestPath: '/api/engagement/meetings/:param/unknown/:param',
          routeManifestKey: 'GET /api/engagement/meetings/:id/unknown/:mysteryId',
        },
        fixtures,
      ),
    ).toThrow(/mysteryId/);
  });
});
