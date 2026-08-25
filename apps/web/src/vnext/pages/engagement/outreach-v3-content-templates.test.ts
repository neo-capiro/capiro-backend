import { describe, expect, it } from 'vitest';
import {
  OUTREACH_FORMAT_OPTIONS,
  contentTemplateById,
  contentTemplateContextSelection,
  contentTemplatesForWorkflow,
  formatContextSelection,
  formatOptionById,
} from './outreach-v3-content-templates.js';

describe('outreach-v3-content-templates', () => {
  it('offers exactly one meeting-request template and six send-update templates', () => {
    expect(contentTemplatesForWorkflow('request_meeting')).toHaveLength(1);
    expect(contentTemplatesForWorkflow('send_update')).toHaveLength(6);
  });

  it('offers no content templates for the custom workflow or a missing workflow', () => {
    expect(contentTemplatesForWorkflow('custom')).toHaveLength(0);
    expect(contentTemplatesForWorkflow(null)).toHaveLength(0);
  });

  it('resolves a template by id and returns null for an unknown id', () => {
    const template = contentTemplateById('hearings_week_ahead');
    expect(template?.title).toBe('Hearings & markup week-ahead');
    expect(contentTemplateById('not-a-real-template')).toBeNull();
    expect(contentTemplateById(null)).toBeNull();
  });

  it('every send-update template carries a non-empty sample subject and body', () => {
    for (const template of contentTemplatesForWorkflow('send_update')) {
      expect(template.sampleSubject.length).toBeGreaterThan(0);
      expect(template.sampleBody.length).toBeGreaterThan(50);
    }
  });

  it('still feeds a LEGACY (skeleton-less) template in as a structure/tone reference', () => {
    const template = contentTemplateById('hearings_week_ahead')!;
    // Guard the premise: this assertion is only meaningful while the template
    // has no skeleton. Once it gains one, the expectation below flips to null
    // and this test should be updated rather than silently passing for the
    // wrong reason.
    expect(template.skeleton ?? null).toBeNull();
    const selection = contentTemplateContextSelection(template);
    expect(selection).not.toBeNull();
    expect(selection!.contextClass).toBe('writing_guidance');
    expect(selection!.scope).toEqual({ kind: 'campaign' });
    const text = String(selection!.locator.text);
    expect(text).toContain('STRUCTURE AND TONE ONLY');
    expect(text).toContain('Do not copy any name, date, dollar figure');
    expect(text).toContain(template.sampleSubject);
    expect(text).toContain(template.sampleBody);
    expect(selection!.locator).toMatchObject({ source: 'manual', sourceLabel: 'outreach_review_packet' });
  });

  it('returns NULL for a skeleton template, so the prompt never gets two conflicting instructions', () => {
    // A skeleton travels as the campaign's contentSkeleton and the server
    // assembles the body from it. Also sending the sample as guidance would tell
    // the model "here is a whole email, follow its shape" while the skeleton
    // block tells it "write only these sections and never the structure" — the
    // observed result is a section that reproduces the template's own headings,
    // which then appear twice in the assembled email.
    const meeting = contentTemplateById('meeting_request_standard')!;
    expect(meeting.skeleton).toBeTruthy();
    expect(contentTemplateContextSelection(meeting)).toBeNull();
  });

  it('gives the meeting-request skeleton the exact headings, in order, that were asked for', () => {
    const skeleton = contentTemplateById('meeting_request_standard')!.skeleton!;
    const body = skeleton.body;
    expect(body).toContain('Why this matters to your office');
    expect(body).toContain('What we’d cover');
    expect(body).toContain('Availability');
    expect(body.indexOf('Why this matters')).toBeLessThan(body.indexOf('What we’d cover'));
    expect(body.indexOf('What we’d cover')).toBeLessThan(body.indexOf('Availability'));
  });

  it('has no bracket placeholders left in the skeleton — those would ship to a recipient', () => {
    // The legacy sample used "[Sponsor client]" as illustration. In a skeleton
    // that text is LITERAL OUTPUT, so every one must have become a {{slot}}.
    const skeleton = contentTemplateById('meeting_request_standard')!.skeleton!;
    const literal = skeleton.body.replace(/\{\{[a-z0-9_]+\}\}/g, '');
    expect(literal).not.toMatch(/\[[A-Za-z][^\]]*\]/);
  });

  it('declares every skeleton slot that the template body actually uses, and vice versa', () => {
    const skeleton = contentTemplateById('meeting_request_standard')!.skeleton!;
    const used = new Set(
      [...`${skeleton.subject}\n${skeleton.body}`.matchAll(/\{\{([a-z][a-z0-9_]*)\}\}/g)].map(
        (m) => m[1]!,
      ),
    );
    const declared = new Set(skeleton.slots.map((s) => s.key));
    expect([...used].sort()).toEqual([...declared].sort());
  });

  it('offers four plain-text format options including a standard default', () => {
    expect(OUTREACH_FORMAT_OPTIONS.map((format) => format.id)).toEqual([
      'standard',
      'structured_digest',
      'narrative_brief',
      'data_forward',
    ]);
  });

  it('resolves a format option by id and returns null otherwise', () => {
    expect(formatOptionById('standard')?.title).toBe('Standard email');
    expect(formatOptionById('not-a-real-format')).toBeNull();
    expect(formatOptionById(null)).toBeNull();
  });

  it('turns a format choice into campaign-scoped writing guidance', () => {
    const format = formatOptionById('structured_digest')!;
    const selection = formatContextSelection(format);
    expect(selection.contextClass).toBe('writing_guidance');
    expect(selection.scope).toEqual({ kind: 'campaign' });
    expect(String(selection.locator.text)).toContain('Structured digest');
  });
});
