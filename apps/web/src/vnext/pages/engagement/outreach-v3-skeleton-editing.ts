import type { OutreachContentSkeleton, OutreachContentSkeletonSlot } from './outreach-v3-template-api.js';

/**
 * Browser-side skeleton helpers for the step-3 template editor.
 *
 * These MIRROR `apps/api/src/engagement/generation/content-skeleton.ts`. The
 * duplication is deliberate and worth the cost: the editor has to validate and
 * preview as the user types, which cannot involve a round-trip, and the server
 * must never trust a browser's validation. Both sides validating the same rules
 * is the correct arrangement here — the server remains authoritative.
 *
 * Keep the two in sync when changing the rules. The token syntax, the key shape,
 * and the blank-line collapsing in `previewSkeleton` are the parts that must
 * agree exactly, because a preview that differs from the assembled output is
 * worse than no preview at all.
 */

const SLOT_TOKEN_RE = /\{\{([a-z][a-z0-9_]{0,39})\}\}/g;
const SLOT_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

export const SKELETON_LIMITS = {
  maxSlots: 12,
  maxBodyChars: 8_000,
  maxSubjectChars: 400,
  maxInstructionChars: 1_000,
  maxLabelChars: 120,
} as const;

export function extractSlotKeys(subject: string, body: string): string[] {
  const seen: string[] = [];
  for (const text of [subject, body]) {
    for (const match of text.matchAll(SLOT_TOKEN_RE)) {
      const key = match[1]!;
      if (!seen.includes(key)) seen.push(key);
    }
  }
  return seen;
}

export interface SkeletonIssue {
  field: 'subject' | 'body' | 'slots';
  slotKey?: string;
  message: string;
}

/**
 * Validate as the user types. Returns EVERY issue, not just the first, so the
 * editor can show a complete list instead of making the author fix problems one
 * round-trip at a time.
 */
export function validateSkeletonDraft(skeleton: OutreachContentSkeleton): SkeletonIssue[] {
  const issues: SkeletonIssue[] = [];

  if (!skeleton.body.trim()) {
    issues.push({ field: 'body', message: 'The template body cannot be empty.' });
  }
  if (skeleton.body.length > SKELETON_LIMITS.maxBodyChars) {
    issues.push({
      field: 'body',
      message: `The body is limited to ${SKELETON_LIMITS.maxBodyChars.toLocaleString()} characters.`,
    });
  }
  if (skeleton.subject.length > SKELETON_LIMITS.maxSubjectChars) {
    issues.push({
      field: 'subject',
      message: `The subject is limited to ${SKELETON_LIMITS.maxSubjectChars} characters.`,
    });
  }
  if (skeleton.slots.length > SKELETON_LIMITS.maxSlots) {
    issues.push({
      field: 'slots',
      message: `A template is limited to ${SKELETON_LIMITS.maxSlots} sections.`,
    });
  }

  const declared = new Set<string>();
  for (const slot of skeleton.slots) {
    if (!SLOT_KEY_RE.test(slot.key)) {
      issues.push({
        field: 'slots',
        slotKey: slot.key,
        message: `"${slot.key || '(empty)'}" is not a valid section key. Use lowercase letters, numbers and underscores, starting with a letter.`,
      });
      continue;
    }
    if (declared.has(slot.key)) {
      issues.push({
        field: 'slots',
        slotKey: slot.key,
        message: `Section "${slot.key}" is listed more than once.`,
      });
      continue;
    }
    declared.add(slot.key);
    if (!slot.label.trim()) {
      issues.push({ field: 'slots', slotKey: slot.key, message: 'This section needs a name.' });
    }
    if (!slot.instruction.trim()) {
      issues.push({
        field: 'slots',
        slotKey: slot.key,
        message: 'This section needs an instruction telling Meri what to write here.',
      });
    }
  }

  const used = extractSlotKeys(skeleton.subject, skeleton.body);
  for (const key of used) {
    if (!declared.has(key)) {
      issues.push({
        field: 'body',
        slotKey: key,
        message: `{{${key}}} is used in the template but has no section defined. Add the section, or remove the token.`,
      });
    }
  }
  for (const key of declared) {
    if (!used.includes(key)) {
      issues.push({
        field: 'slots',
        slotKey: key,
        message: `Section "${key}" is defined but never placed. Insert {{${key}}} where it belongs.`,
      });
    }
  }
  if (skeleton.body.trim() && !used.length) {
    issues.push({
      field: 'body',
      message:
        'This template has no {{sections}}, so every recipient would get identical text. Add at least one section for Meri to personalize.',
    });
  }

  return issues;
}

/**
 * Render a preview using each slot's label as stand-in content.
 *
 * The blank-line collapsing here must match the server's `assembleSkeletonBody`
 * exactly — a preview that lays out differently from the real email would be
 * actively misleading about the one thing this feature promises.
 */
export function previewSkeleton(
  skeleton: OutreachContentSkeleton,
  options?: { omitOptional?: boolean },
): { subject: string; body: string } {
  const omitOptional = options?.omitOptional ?? false;
  const values = new Map<string, string>();
  for (const slot of skeleton.slots) {
    const omit = omitOptional && !slot.required;
    values.set(slot.key, omit ? '' : `[${slot.label || slot.key}]`);
  }

  const substitute = (text: string): string =>
    text.replace(SLOT_TOKEN_RE, (_t, key: string) => values.get(key) ?? '');

  const keptLines: string[] = [];
  for (const line of skeleton.body.split('\n')) {
    const substituted = substitute(line);
    const lineHadOnlyTokens = /^\s*(?:\{\{[a-z][a-z0-9_]{0,39}\}\}\s*)+$/.test(line);
    if (lineHadOnlyTokens && !substituted.trim()) continue;
    keptLines.push(substituted);
  }

  return {
    subject: substitute(skeleton.subject).trim(),
    body: keptLines.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
  };
}

/** A slug the author is unlikely to have used yet, derived from a label. */
export function suggestSlotKey(label: string, taken: string[]): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/^([0-9])/, 'section_$1')
      .slice(0, 40) || 'section';
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}_${n}`.slice(0, 40);
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base}_x`;
}

export function blankSkeletonSlot(label: string, taken: string[]): OutreachContentSkeletonSlot {
  return {
    key: suggestSlotKey(label, taken),
    label,
    instruction: '',
    required: true,
  };
}

/**
 * A minimal starting skeleton for "create your own".
 *
 * Deliberately not empty: an empty textarea plus an abstract explanation of
 * `{{tokens}}` is a much worse starting point than a tiny working example the
 * author can edit into shape.
 */
export function starterSkeletonDraft(): OutreachContentSkeleton {
  return {
    subject: 'Meeting request: {{topic}}',
    body: ['Dear {{salutation}},', '', '{{opening}}', '', '{{closing_line}}'].join('\n'),
    slots: [
      {
        key: 'topic',
        label: 'Subject topic',
        instruction: 'The campaign topic as it should read in the subject line.',
        required: true,
      },
      {
        key: 'salutation',
        label: 'Salutation',
        instruction: 'How to address the recipient, using their resolved identity.',
        required: true,
      },
      {
        key: 'opening',
        label: 'Opening',
        instruction: 'Who is writing, on whose behalf, and what they are asking for.',
        required: true,
      },
      {
        key: 'closing_line',
        label: 'Closing line',
        instruction: 'One short courteous closing sentence. No signature block.',
        required: true,
      },
    ],
  };
}
