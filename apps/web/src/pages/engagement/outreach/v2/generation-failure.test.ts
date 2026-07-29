/**
 * A generation failure must never destroy a draft that already exists.
 *
 * This is the behaviour that turns "the regenerate failed" into "the app threw
 * away work I never asked it to touch". It matters far more under
 * ENGAGEMENT_GENERATION_GATEWAY, because the gateway converts several previously
 * silent degradations (a cross-client debrief, an unreadable prep, an
 * unverifiable LegiWatch alert) into CRITICAL source failures that block the
 * draft — so the failure path stopped being rare the moment the flag went on.
 */
import { describe, expect, it } from 'vitest';
import { applyGenerationFailure } from './generation.js';
import type { GeneratedDraft } from './types.js';

const PLACEHOLDER = { subject: '[Placeholder] Q3 approps', body: '<p>generation failed</p>' };

describe('a slot with no draft yet', () => {
  it('takes the placeholder and is marked unsendable', () => {
    const out = applyGenerationFailure(undefined, PLACEHOLDER, 'Model timed out');
    expect(out.subject).toBe(PLACEHOLDER.subject);
    expect(out.body).toBe(PLACEHOLDER.body);
    expect(out.status).toBe('error');
    expect(out.failureReason).toBe('Model timed out');
  });

  it('treats a whitespace-only draft as empty', () => {
    const out = applyGenerationFailure(
      { subject: '   ', body: '  ' } as GeneratedDraft,
      PLACEHOLDER,
    );
    expect(out.subject).toBe(PLACEHOLDER.subject);
    expect(out.status).toBe('error');
  });
});

describe('a slot that already holds a draft', () => {
  const existing: GeneratedDraft = {
    subject: 'Following up on FY27 directed energy',
    body: '<p>Dear Dana — as discussed…</p>',
    versionId: 'ver-9',
    artifactId: 'art-1',
    version: 3,
    auditStatus: 'passed',
    approvalStatus: 'not_required',
    sendable: true,
    status: 'ready',
  };

  it('keeps the text verbatim', () => {
    const out = applyGenerationFailure(existing, PLACEHOLDER, 'A source could not be loaded.');
    expect(out.subject).toBe(existing.subject);
    expect(out.body).toBe(existing.body);
    expect(out.body).not.toMatch(/generation failed/);
    expect(out.subject).not.toMatch(/Placeholder/);
  });

  it('records why the attempt failed', () => {
    const out = applyGenerationFailure(existing, PLACEHOLDER, 'A source could not be loaded.');
    expect(out.failureReason).toBe('A source could not be loaded.');
  });

  it('does NOT revoke sendability of the version it already had', () => {
    // The failure is of the new ATTEMPT, not a verdict on the existing text. That
    // text is still backed by an audited version; flipping it to 'error' would
    // drop it out of the send projection, losing the work a second, quieter way.
    const out = applyGenerationFailure(existing, PLACEHOLDER, 'boom');
    expect(out.status).toBe('ready');
    expect(out.sendable).toBe(true);
    expect(out.versionId).toBe('ver-9');
    expect(out.version).toBe(3);
    expect(out.auditStatus).toBe('passed');
  });

  it('preserves an unsaved edit rather than reverting it', () => {
    const dirty: GeneratedDraft = { ...existing, body: '<p>my hand edits</p>', dirty: true };
    const out = applyGenerationFailure(dirty, PLACEHOLDER, 'boom');
    expect(out.body).toBe('<p>my hand edits</p>');
    expect(out.dirty).toBe(true);
  });

  it('omits failureReason entirely when no reason was supplied', () => {
    const out = applyGenerationFailure(existing, PLACEHOLDER);
    expect(out).not.toHaveProperty('failureReason');
  });
});
