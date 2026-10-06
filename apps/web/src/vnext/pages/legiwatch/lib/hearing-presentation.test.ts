import { describe, expect, it } from 'vitest';
import { hearingEventLabel, hearingHasPassed, hasTestSessionTitle, recordingAttemptDate } from './hearing-presentation.js';
import { presentHearingIntelligence } from './hearing-intelligence-presentation.js';

describe('honest hearing presentation', () => {
  const now = Date.parse('2026-10-06T14:00:00Z');
  it('distinguishes stale scheduled listings from confirmed outcomes and never invents a time', () => {
    expect(hearingEventLabel('scheduled', '2026-10-05T10:00:00Z', undefined, now)).toBe('Past · outcome unconfirmed');
    expect(hearingEventLabel('completed', '2026-10-05T10:00:00Z', undefined, now)).toBe('Completed');
    expect(hearingEventLabel('scheduled', undefined, '2026-10-06', now)).toBe('Scheduled');
    expect(hearingHasPassed(undefined, '2026-10-05', now)).toBe(true);
    expect(hearingHasPassed(undefined, undefined, now)).toBe(false);
    expect(recordingAttemptDate('2025-02-09T14:00:00Z')).toContain('2025');
  });
  it('only filters explicit test/QA title words', () => {
    expect(hasTestSessionTitle('QA smoke recording')).toBe(true);
    expect(hasTestSessionTitle('[test] replay')).toBe(true);
    expect(hasTestSessionTitle('Water quality testing oversight')).toBe(false);
  });
  it('deduplicates the same source finding and replaces fragments with attributed transcript context', () => {
    const segments = [
      { id: 'before', sequence: 0, startMs: 0, endMs: 1000, text: 'Our shipyard is in', speakerLabel: '8', speakerName: 'Senator Tim Kaine', isFinal: true },
      { id: 'source', sequence: 1, startMs: 1000, endMs: 2000, text: 'Maine?', speakerLabel: '8', speakerName: 'Senator Tim Kaine', isFinal: true },
      { id: 'other', sequence: 2, startMs: 2000, endMs: 3000, text: 'Yes.', speakerLabel: '2', isFinal: true },
    ];
    const finding = { id: '1', insightType: 'QUESTION', title: 'Maine?', summary: 'Maine?', segmentId: 'source', evidenceText: 'Maine?', speakerName: 'Wrong stale identity' };
    const result = presentHearingIntelligence([finding, { ...finding, id: '2' }], segments);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ speakerName: 'Senator Tim Kaine', evidenceText: 'Our shipyard is in Maine?', preliminary: true });
    expect(result[0]!.title).toContain('review in context');
    expect(result[0]!.evidenceText).not.toContain('Yes.');
    expect(presentHearingIntelligence([finding], [])[0]).toMatchObject({ speakerName: undefined, preliminary: true });
    expect(presentHearingIntelligence([{ ...finding, id: '3', segmentId: 'other' }], segments)[0]!.speakerName).toBe('Speaker 3');
  });
});
