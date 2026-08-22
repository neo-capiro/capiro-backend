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

  it('feeds the template into generation as a structure/tone reference and explicitly forbids copying its sample facts', () => {
    const template = contentTemplateById('hearings_week_ahead')!;
    const selection = contentTemplateContextSelection(template);
    expect(selection.contextClass).toBe('writing_guidance');
    expect(selection.scope).toEqual({ kind: 'campaign' });
    const text = String(selection.locator.text);
    expect(text).toContain('STRUCTURE AND TONE ONLY');
    expect(text).toContain('Do not copy any name, date, dollar figure');
    expect(text).toContain(template.sampleSubject);
    expect(text).toContain(template.sampleBody);
    expect(selection.locator).toMatchObject({ source: 'manual', sourceLabel: 'outreach_review_packet' });
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
