import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assembleSkeletonBody,
  validateContentSkeleton,
  type ContentSkeleton,
} from '../../engagement/generation/content-skeleton.js';
import { outreachTemplateContentSkeletonSchema } from '../templates/outreach-template.contract.js';
import { OUTREACH_COMMAND_PAYLOAD_SCHEMAS } from './outreach-command.contract.js';

/**
 * Guards the boundaries a skeleton crosses.
 *
 * A skeleton is authored in the browser, validated there for fast feedback,
 * validated again by the template zod schema, carried over the wire in a
 * command, stored in a content-addressed spec, and finally read by the assembler.
 * Six representations of the same thing. These tests exist because a divergence
 * between any two of them is invisible in normal use and only shows up as a
 * malformed email to a congressional office.
 */

function meetingSkeleton(): ContentSkeleton {
  return {
    subject: 'Meeting request: {{topic}}',
    body: ['Dear {{salutation}},', '', 'Why this matters', '{{why}}', '', 'Thanks.'].join('\n'),
    slots: [
      { key: 'topic', label: 'Topic', instruction: 'The campaign topic.', required: true },
      { key: 'salutation', label: 'Salutation', instruction: 'Their name.', required: true },
      { key: 'why', label: 'Why', instruction: 'One supported connection.', required: false },
    ],
  };
}

describe('a skeleton survives every representation boundary', () => {
  it('is accepted by the authoring validator, the template schema and the command schema alike', () => {
    const skeleton = meetingSkeleton();
    expect(validateContentSkeleton(skeleton)).toEqual([]);
    expect(() => outreachTemplateContentSkeletonSchema.parse(skeleton)).not.toThrow();
    expect(() =>
      OUTREACH_COMMAND_PAYLOAD_SCHEMAS.SET_CONTENT_SKELETON.parse({ value: skeleton }),
    ).not.toThrow();
  });

  it('round-trips through JSON unchanged, which is what the wire and spec_jsonb do', () => {
    const skeleton = meetingSkeleton();
    const roundTripped = JSON.parse(JSON.stringify(skeleton)) as ContentSkeleton;
    expect(roundTripped).toEqual(skeleton);
    expect(assembleSkeletonBody(roundTripped, { topic: 'x', salutation: 'y', why: 'z' })).toEqual(
      assembleSkeletonBody(skeleton, { topic: 'x', salutation: 'y', why: 'z' }),
    );
  });

  it('the command schema rejects a skeleton with an invalid slot key', () => {
    expect(() =>
      OUTREACH_COMMAND_PAYLOAD_SCHEMAS.SET_CONTENT_SKELETON.parse({
        value: {
          subject: '',
          body: '{{Bad-Key}}',
          slots: [{ key: 'Bad-Key', label: 'x', instruction: 'y', required: true }],
        },
      }),
    ).toThrow();
  });

  it('the command schema accepts null, because clearing a template is a real action', () => {
    expect(() =>
      OUTREACH_COMMAND_PAYLOAD_SCHEMAS.SET_CONTENT_SKELETON.parse({ value: null }),
    ).not.toThrow();
  });

  it('the command schema enforces the same slot ceiling as the authoring side', () => {
    const tooMany = {
      subject: '',
      body: Array.from({ length: 13 }, (_, i) => `{{s${i}}}`).join('\n'),
      slots: Array.from({ length: 13 }, (_, i) => ({
        key: `s${i}`,
        label: `S${i}`,
        instruction: 'x',
        required: true,
      })),
    };
    expect(() =>
      OUTREACH_COMMAND_PAYLOAD_SCHEMAS.SET_CONTENT_SKELETON.parse({ value: tooMany }),
    ).toThrow();
  });
});

describe('the browser and server slot-token syntax agree', () => {
  /**
   * The browser editor duplicates the token regex so it can validate and preview
   * as the user types (no round-trip is possible for that). The duplication is
   * intentional, but a silent divergence would mean the preview shows one layout
   * and the recipient receives another — the single worst outcome for a feature
   * whose entire promise is "what you see is what is sent".
   *
   * This asserts on source text rather than importing the browser module, because
   * apps/web is a separate package the API's jest project cannot resolve.
   */
  const webEditingSource = readFileSync(
    join(
      process.cwd(),
      '..',
      'web',
      'src',
      'vnext',
      'pages',
      'engagement',
      'outreach-v3-skeleton-editing.ts',
    ),
    'utf8',
  );

  it('uses the identical double-brace token pattern', () => {
    expect(webEditingSource).toContain('/\\{\\{([a-z][a-z0-9_]{0,39})\\}\\}/g');
  });

  it('uses the identical slot-key shape', () => {
    expect(webEditingSource).toContain('/^[a-z][a-z0-9_]{0,39}$/');
  });

  it('collapses 3+ newlines exactly as the server assembler does', () => {
    expect(webEditingSource).toContain("replace(/\\n{3,}/g, '\\n\\n')");
  });

  it('drops a token-only line exactly as the server assembler does', () => {
    // Same predicate as assembleSkeletonBody's lineHadOnlyTokens check.
    expect(webEditingSource).toContain(
      '/^\\s*(?:\\{\\{[a-z][a-z0-9_]{0,39}\\}\\}\\s*)+$/',
    );
  });

  it('declares the same limits the server schemas enforce', () => {
    expect(webEditingSource).toContain('maxSlots: 12');
    expect(webEditingSource).toContain('maxBodyChars: 8_000');
    expect(webEditingSource).toContain('maxSubjectChars: 400');
    expect(webEditingSource).toContain('maxInstructionChars: 1_000');
    expect(webEditingSource).toContain('maxLabelChars: 120');
  });
});
