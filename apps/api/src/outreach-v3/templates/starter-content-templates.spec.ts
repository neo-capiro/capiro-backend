import { describe, expect, it } from '@jest/globals';
import {
  assembleSkeletonBody,
  validateContentSkeleton,
  type ContentSkeleton,
} from '../../engagement/generation/content-skeleton.js';
import { outreachTemplateContentSkeletonSchema } from './outreach-template.contract.js';
import {
  STARTER_CONTENT_TEMPLATES,
  starterContentTemplatesForWorkflow,
} from './starter-content-templates.js';

describe('starter content templates', () => {
  it('ships the seven starters that replace the old hardcoded frontend samples', () => {
    expect(STARTER_CONTENT_TEMPLATES).toHaveLength(7);
    expect(starterContentTemplatesForWorkflow('request_meeting')).toHaveLength(1);
    expect(starterContentTemplatesForWorkflow('send_update')).toHaveLength(6);
  });

  it('has a unique key per starter, since the key is the seeding idempotency key', () => {
    const keys = STARTER_CONTENT_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  describe.each(STARTER_CONTENT_TEMPLATES.map((t) => [t.key, t] as const))(
    '%s',
    (_key, template) => {
      it('passes the authoring validator with zero issues', () => {
        expect(validateContentSkeleton(template.skeleton as ContentSkeleton)).toEqual([]);
      });

      it('passes the stored-template zod schema', () => {
        expect(() =>
          outreachTemplateContentSkeletonSchema.parse(template.skeleton),
        ).not.toThrow();
      });

      it('assembles to a body with no leftover tokens when every slot is filled', () => {
        const values = Object.fromEntries(
          template.skeleton.slots.map((slot) => [slot.key, `[${slot.key} content]`]),
        );
        const { body, subject, missingRequiredSlots } = assembleSkeletonBody(
          template.skeleton as ContentSkeleton,
          values,
        );
        expect(missingRequiredSlots).toEqual([]);
        expect(body).not.toContain('{{');
        expect(subject).not.toContain('{{');
        expect(body.trim().length).toBeGreaterThan(0);
      });

      it('assembles cleanly when every OPTIONAL slot is empty — the thin-evidence case', () => {
        // This is the case that matters in production: a recipient whose evidence
        // supports only the required sections must still receive a well-formed
        // email, with no stranded headings and no runs of blank lines.
        const values = Object.fromEntries(
          template.skeleton.slots
            .filter((slot) => slot.required)
            .map((slot) => [slot.key, `[${slot.key} content]`]),
        );
        const { body, missingRequiredSlots } = assembleSkeletonBody(
          template.skeleton as ContentSkeleton,
          values,
        );
        expect(missingRequiredSlots).toEqual([]);
        expect(body).not.toContain('{{');
        expect(body).not.toMatch(/\n{3,}/);
      });

      it('contains no specimen facts — every fact must be a slot, not literal text', () => {
        // The old samples carried invented dates, dollar figures and agency names
        // as illustration, and the prompt had to tell the model not to copy them.
        // In a skeleton that text would be LITERAL OUTPUT to a real recipient.
        const literal = template.skeleton.body.replace(/\{\{[a-z0-9_]+\}\}/g, '');
        expect(literal).not.toMatch(/\$[\d,]/);
        expect(literal).not.toMatch(/\bFY20\d\d\b/);
        expect(literal).not.toMatch(/\b(?:H\.R\.|S\.)\s?\d+/);
        expect(literal).not.toMatch(/\b\d{1,2}:\d{2}\s?(?:ET|ET\b|am|pm)/i);
        // No bracket placeholders either — those were the old sample's idiom and
        // would now ship to a recipient as literal "[Sponsor client]" text.
        expect(literal).not.toMatch(/\[[A-Za-z][^\]]*\]/);
      });

      it('has at least one required slot, so a draft is never entirely empty', () => {
        expect(template.skeleton.slots.some((slot) => slot.required)).toBe(true);
      });

      it('gives every slot a non-trivial instruction, which is the real quality lever', () => {
        for (const slot of template.skeleton.slots) {
          expect(slot.instruction.trim().length).toBeGreaterThan(20);
        }
      });

      it('tells the model to return empty rather than invent, on every optional slot', () => {
        for (const slot of template.skeleton.slots.filter((s) => !s.required)) {
          expect(slot.instruction.toLowerCase()).toMatch(/empty string/);
        }
      });
    },
  );

  it('keeps the caveat sections REQUIRED on the digests that need them', () => {
    // These are the sections that stop an empty result reading as "nothing
    // exists in the world" — the exact failure the source samples warned about
    // in their own footers. As slots they must not be optional.
    const awards = STARTER_CONTENT_TEMPLATES.find((t) => t.key === 'starter_federal_awards_rollup')!;
    expect(awards.skeleton.slots.find((s) => s.key === 'basis_note')?.required).toBe(true);

    const fo = STARTER_CONTENT_TEMPLATES.find(
      (t) => t.key === 'starter_funding_opportunity_digest',
    )!;
    expect(fo.skeleton.slots.find((s) => s.key === 'scope_note')?.required).toBe(true);

    const toplines = STARTER_CONTENT_TEMPLATES.find((t) => t.key === 'starter_defense_toplines')!;
    expect(toplines.skeleton.slots.find((s) => s.key === 'exclusions')?.required).toBe(true);
  });

  it('keeps authorization and appropriations as separate slots, never merged', () => {
    // Mixing the two tracks is a domain error the source sample called out
    // explicitly; separate slots make it structurally impossible.
    const toplines = STARTER_CONTENT_TEMPLATES.find((t) => t.key === 'starter_defense_toplines')!;
    const keys = toplines.skeleton.slots.map((s) => s.key);
    expect(keys).toContain('authorization');
    expect(keys).toContain('appropriations');
  });

  it('preserves the meeting-request structure the feature was requested for', () => {
    const meeting = STARTER_CONTENT_TEMPLATES.find(
      (t) => t.key === 'starter_meeting_request_standard',
    )!;
    // The literal headings the user asked to be preserved, in order.
    const body = meeting.skeleton.body;
    expect(body).toContain('Why this matters to your office');
    expect(body).toContain('What we’d cover');
    expect(body).toContain('Availability');
    expect(body.indexOf('Why this matters')).toBeLessThan(body.indexOf('What we’d cover'));
    expect(body.indexOf('What we’d cover')).toBeLessThan(body.indexOf('Availability'));
  });
});
