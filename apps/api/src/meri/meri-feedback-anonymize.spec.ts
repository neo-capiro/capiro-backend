import { describe, expect, it } from '@jest/globals';
import {
  FEEDBACK_ANONYMIZATION_VERSION,
  anonymizeFeedbackExcerpt,
} from './meri-feedback-anonymize.js';
import { normalizeReasons } from './meri-feedback-fixture.service.js';

describe('anonymizeFeedbackExcerpt', () => {
  it('redacts the client name by name, not merely by pattern', () => {
    const out = anonymizeFeedbackExcerpt(
      'Aerovance Systems asked about the mark. Aerovance Systems is the prime.',
      { names: ['Aerovance Systems'] },
    );
    expect(out.text).not.toContain('Aerovance');
    expect(out.text).toContain('[CLIENT]');
    expect(out.redactions['[CLIENT]']).toBe(2);
  });

  it('redacts the longest name first so a substring cannot survive', () => {
    const out = anonymizeFeedbackExcerpt('Acme Defense Systems and Acme both appear.', {
      names: ['Acme', 'Acme Defense Systems'],
    });
    expect(out.text).not.toContain('Acme');
  });

  it('does not redact a substring inside a longer word', () => {
    // The whole-token guard: a short client token must not gut unrelated prose.
    const out = anonymizeFeedbackExcerpt('The ARC program is unrelated to arcane matters.', {
      names: ['ARC'],
    });
    expect(out.text).toContain('arcane');
  });

  it('redacts emails, URLs, phone numbers, dollar figures and long digit runs', () => {
    const out = anonymizeFeedbackExcerpt(
      'Contact jane.doe@example.com or (202) 555-0142, see https://example.com/x. ' +
        'PE 0604270F got $412.5 million; account 998877665.',
    );
    expect(out.text).not.toContain('jane.doe@example.com');
    expect(out.text).not.toContain('555-0142');
    expect(out.text).not.toContain('example.com/x');
    expect(out.text).not.toContain('412.5');
    expect(out.text).not.toContain('998877665');
    expect(out.text).toContain('[EMAIL]');
    expect(out.text).toContain('[PHONE]');
    expect(out.text).toContain('[URL]');
    // In this domain the FIGURE is frequently the identifying detail.
    expect(out.text).toContain('[AMOUNT]');
    expect(out.text).toContain('[NUMBER]');
  });

  it('truncates AFTER redaction so trailing PII cannot slip through the cut', () => {
    const filler = 'x'.repeat(600);
    const out = anonymizeFeedbackExcerpt(`${filler} jane.doe@example.com`, { maxChars: 80 });
    expect(out.text).not.toContain('jane.doe@example.com');
    expect(out.text.length).toBeLessThanOrEqual(81); // 80 + the ellipsis
  });

  it('stamps a VERSION so an old fixture is never credited with newer redaction rules', () => {
    expect(anonymizeFeedbackExcerpt('hello').anonymizationVersion).toBe(
      FEEDBACK_ANONYMIZATION_VERSION,
    );
    expect(FEEDBACK_ANONYMIZATION_VERSION).toMatch(/^feedback-anon-v\d+$/);
  });

  it('never emits the raw 1200-char body the old export shipped', () => {
    const body = `Confidential: ${'y'.repeat(5000)}`;
    expect(anonymizeFeedbackExcerpt(body).text.length).toBeLessThanOrEqual(1001);
  });
});

describe('normalizeReasons', () => {
  it('accepts the LIVE apps/api spellings that used to be silently dropped', () => {
    expect(normalizeReasons(['wrong_tone_or_format', 'tool_or_action_failed'])).toEqual([
      'wrong_tone_or_format',
      'tool_or_action_failed',
    ]);
  });

  it('normalizes the legacy meriv2-core spellings to canonical', () => {
    expect(normalizeReasons(['wrong_tone_format', 'tool_action_failed'])).toEqual([
      'wrong_tone_or_format',
      'tool_or_action_failed',
    ]);
  });

  it('collapses duplicates across spellings and drops unknown codes', () => {
    expect(normalizeReasons(['wrong_tone_format', 'wrong_tone_or_format', 'nonsense'])).toEqual([
      'wrong_tone_or_format',
    ]);
    expect(normalizeReasons(['nonsense'])).toEqual([]);
  });
});
