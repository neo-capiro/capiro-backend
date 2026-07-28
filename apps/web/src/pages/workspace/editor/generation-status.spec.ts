import { describe, expect, it } from 'vitest';
import {
  describeGenerationRun,
  isStaleSection,
  staleSectionReason,
} from './generation-status';
import { sectionViews } from './section-model';
import type { WsConfig, WsGenerationRun, WsSectionMeta } from '../types';

/**
 * Honest generation reporting. The editor used to announce "Meri re-drafted the
 * document" whenever the request returned 2xx — including runs where sections
 * failed and the visible text was the PREVIOUS draft. These tests pin the
 * reporting rules independently of the DOM.
 */

function run(overrides: Partial<WsGenerationRun> = {}): WsGenerationRun {
  return {
    id: 'run-1',
    status: 'complete',
    requestedSections: ['Overview', 'Request'],
    succeededSections: ['Overview', 'Request'],
    failedSections: [],
    sectionResults: [],
    invalidCitations: [],
    structuralFindings: [],
    groundingFindings: [],
    provider: 'anthropic',
    model: 'claude-sonnet-test',
    credentialSource: 'tenant',
    contextPacketId: 'pkt-1',
    contextTraceHash: 'hash-1',
    contextDegraded: false,
    snapshot: { status: 'created', versionId: 'ver-1' },
    startedAt: '2026-07-28T12:00:00.000Z',
    completedAt: '2026-07-28T12:00:10.000Z',
    retryOfRunId: null,
    ...overrides,
  };
}

const failure = (section: string, staleContentPreserved = true) => ({
  section,
  status: 'failed' as const,
  errorCode: 'provider_unavailable',
  message: 'The model provider was temporarily unavailable.',
  staleContentPreserved,
});

describe('describeGenerationRun', () => {
  it('reports a clean run as success with nothing persistent on screen', () => {
    const report = describeGenerationRun(run());
    expect(report.tone).toBe('success');
    expect(report.persistent).toBe(false);
    expect(report.canRetryFailed).toBe(false);
    expect(report.toast).toBe('Meri drafted the document');
  });

  it('never reports a partial run as success and names the failed sections', () => {
    const report = describeGenerationRun(
      run({
        status: 'partial',
        succeededSections: ['Overview'],
        failedSections: [failure('Request')],
      }),
    );
    expect(report.tone).toBe('error');
    expect(report.persistent).toBe(true);
    expect(report.failedSections).toEqual(['Request']);
    expect(report.canRetryFailed).toBe(true);
    expect(report.detail).toContain('Request');
    // It must NOT claim the whole document was regenerated.
    expect(report.detail).not.toMatch(/re-?drafted the (whole )?document/i);
    expect(report.toast).not.toMatch(/success/i);
  });

  it('says retained content was not regenerated when a failed section had prior text', () => {
    const report = describeGenerationRun(
      run({
        status: 'partial',
        succeededSections: ['Overview'],
        failedSections: [failure('Request', true)],
      }),
    );
    expect(report.staleSections).toEqual(['Request']);
    expect(report.detail).toContain('not regenerated');
  });

  it('says the failed sections were left empty when there was no prior content', () => {
    const report = describeGenerationRun(
      run({
        status: 'partial',
        succeededSections: ['Overview'],
        failedSections: [failure('Request', false)],
      }),
    );
    expect(report.staleSections).toEqual([]);
    expect(report.detail).toContain('left empty');
  });

  it('reports a total failure as generating nothing', () => {
    const report = describeGenerationRun(
      run({
        status: 'failed',
        succeededSections: [],
        failedSections: [failure('Overview'), failure('Request')],
      }),
    );
    expect(report.tone).toBe('error');
    expect(report.headline).toBe('Nothing was generated');
    expect(report.canRetryFailed).toBe(true);
    expect(report.failedSections).toEqual(['Overview', 'Request']);
  });

  it('surfaces a failed snapshot as a warning rather than a plain success', () => {
    const report = describeGenerationRun(
      run({
        status: 'complete_with_warnings',
        snapshot: { status: 'failed', versionId: null, errorCode: 'snapshot_persistence_failed' },
      }),
    );
    expect(report.tone).toBe('warning');
    expect(report.persistent).toBe(true);
    expect(report.detail).toContain('As generated');
    // Nothing failed, so there is nothing to retry.
    expect(report.canRetryFailed).toBe(false);
  });

  it('explains dropped citations and degraded context in a warning run', () => {
    const report = describeGenerationRun(
      run({
        status: 'complete_with_warnings',
        invalidCitations: [{ section: 'Overview', token: '[S:pe:0603851F]' }],
        contextDegraded: true,
      }),
    );
    expect(report.detail).toContain('citation token');
    expect(report.detail).toContain('approved context');
  });

  it('describes a successful retry as re-drafting only the failed sections', () => {
    const report = describeGenerationRun(
      run({
        status: 'complete',
        requestedSections: ['Request'],
        succeededSections: ['Request'],
        retryOfRunId: 'run-0',
      }),
    );
    expect(report.tone).toBe('success');
    expect(report.toast).toContain('previously failed section');
    expect(report.toast).not.toContain('the document');
  });

  it('truncates long failed-section lists rather than dumping every name', () => {
    const report = describeGenerationRun(
      run({
        status: 'failed',
        succeededSections: [],
        failedSections: ['A', 'B', 'C', 'D', 'E'].map((name) => failure(name)),
      }),
    );
    expect(report.detail).toContain('and 2 more');
  });

  it('reports nothing at all when no run has happened', () => {
    const report = describeGenerationRun(null);
    expect(report.persistent).toBe(false);
    expect(report.toast).toBe('');
    expect(report.canRetryFailed).toBe(false);
  });
});

describe('stale section marking', () => {
  const staleMeta: WsSectionMeta = {
    status: 'review',
    generationStatus: 'failed',
    stale: true,
    lastGenerationError: { code: 'provider_timeout', message: 'The provider timed out.' },
  };

  it('treats a failed+stale section as stale and explains why', () => {
    expect(isStaleSection(staleMeta)).toBe(true);
    expect(staleSectionReason(staleMeta)).toBe('The provider timed out.');
  });

  it('does not mark a succeeded section stale', () => {
    const meta: WsSectionMeta = { status: 'review', generationStatus: 'succeeded', stale: false };
    expect(isStaleSection(meta)).toBe(false);
    expect(staleSectionReason(meta)).toBe('');
  });

  it('does not mark a never-generated section stale', () => {
    expect(isStaleSection(undefined)).toBe(false);
    expect(isStaleSection({ status: 'empty' })).toBe(false);
  });

  it('flows stale state into the section view-model without losing the content', () => {
    const cfg = {
      sections: ['Overview', 'Request'],
      sectionContent: {
        Overview: '<p>Fresh overview.</p>',
        Request: '<p>Previously approved ask.</p>',
      },
      sectionMeta: {
        Overview: { status: 'review', generationStatus: 'succeeded', stale: false },
        Request: staleMeta,
      },
    } as unknown as WsConfig;

    const views = sectionViews(cfg);
    const overview = views.find((view) => view.name === 'Overview');
    const request = views.find((view) => view.name === 'Request');

    expect(overview?.stale).toBe(false);
    expect(request?.stale).toBe(true);
    expect(request?.staleReason).toBe('The provider timed out.');
    // The retained content is still rendered — preserved, just labelled.
    expect(request?.content).toBe('<p>Previously approved ask.</p>');
  });
});
