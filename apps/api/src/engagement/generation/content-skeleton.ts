/**
 * Content skeletons: a user-authored email structure the SERVER fills in.
 *
 * ## Why this exists
 *
 * Before this, a chosen "content template" reached generation as
 * `writing_guidance` context — the lowest-authority tier in
 * GATEWAY_PRECEDENCE_LADDER, explicitly described to the model as "STRUCTURE AND
 * TONE ONLY". That is the correct treatment for an *example email*, but it means
 * the model was free to drop a section header, reorder sections, or paraphrase a
 * heading past recognition, and nothing downstream checked. A user who typed an
 * exact skeleton had no guarantee any of it survived.
 *
 * ## The approach: assemble, don't ask
 *
 * The alternative would have been to keep single-shot free-body generation and
 * add a verifier check that the headers came back verbatim. That was rejected:
 * it converts a formatting preference into yet another way for a draft to land
 * in `verifier_hold` (the exact failure class that produced 38 held / 0 sendable
 * drafts and took multiple sessions to unwind), and it still cannot guarantee
 * section ORDER without a much fussier check.
 *
 * Instead the model never writes the skeleton at all. It is asked only for the
 * prose that goes INSIDE each named slot, and this module — plain string
 * substitution, no model involved — renders the user's literal skeleton around
 * those values. Header text, section order, spacing and punctuation are
 * therefore byte-exact by construction rather than by inspection.
 *
 * Two consequences worth stating explicitly:
 *
 *   1. **The accuracy gates are unchanged.** Assembly happens BEFORE the
 *      deterministic verifiers and the Phase 0 audit, so `date_grounding`,
 *      `stale_source_caveat`, citation checks and the rest all run against the
 *      final assembled body exactly as they did against a free-written one. This
 *      module adds structure; it removes no safety.
 *   2. **A skeleton is not evidence.** It is the user's own words about shape.
 *      Slot prose still comes from the validated Message Plan, so a skeleton
 *      cannot introduce a factual claim — and `assembleSkeletonBody` will
 *      happily render a section as empty rather than invent filler.
 */

/** Token syntax is `{{slot_key}}`.
 *
 * Deliberately double-brace: `OutreachTemplateSpecV1` already uses SINGLE-brace
 * `{key}` for campaign variables resolved at template-apply time
 * (`substituteOutreachTemplateVariables`). Those are different things resolved
 * at different times by different code, and a shared syntax would make
 * "which resolver owns this token" ambiguous — and would mean a variable
 * resolver running first could silently eat a slot token. */
const SLOT_TOKEN_RE = /\{\{([a-z][a-z0-9_]{0,39})\}\}/g;

/** Same character class as the token, anchored — for validating a declared key. */
const SLOT_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

export const CONTENT_SKELETON_MAX_SLOTS = 12;
export const CONTENT_SKELETON_MAX_BODY_CHARS = 8_000;
export const CONTENT_SKELETON_MAX_SUBJECT_CHARS = 400;

export interface ContentSkeletonSlot {
  /** Stable lowercase key used in the `{{token}}`. */
  key: string;
  /** Human label shown in the editor and in the model's slot brief. */
  label: string;
  /**
   * What the model should put here. This is the per-slot instruction and it is
   * the main quality lever a template author has.
   */
  instruction: string;
  /**
   * When false, the model may return an empty string and the whole section is
   * dropped from the assembled body (see `assembleSkeletonBody`). This is what
   * lets one skeleton serve recipients whose evidence supports different
   * sections, instead of forcing invented filler.
   */
  required: boolean;
}

export interface ContentSkeleton {
  /** Literal subject line. May contain slot tokens. */
  subject: string;
  /** Literal body with `{{slot}}` tokens where model prose goes. */
  body: string;
  slots: ContentSkeletonSlot[];
}

export interface SkeletonValidationIssue {
  code:
    | 'SKELETON_BODY_EMPTY'
    | 'SKELETON_BODY_TOO_LONG'
    | 'SKELETON_SUBJECT_TOO_LONG'
    | 'SKELETON_TOO_MANY_SLOTS'
    | 'SKELETON_SLOT_KEY_INVALID'
    | 'SKELETON_SLOT_DUPLICATE'
    | 'SKELETON_SLOT_UNDECLARED'
    | 'SKELETON_SLOT_UNUSED'
    | 'SKELETON_NO_SLOTS'
    | 'SKELETON_SLOT_LABEL_EMPTY'
    | 'SKELETON_SLOT_INSTRUCTION_EMPTY';
  message: string;
  /** The slot key or field the issue attaches to. */
  subject?: string;
}

/** Every distinct slot token appearing in the skeleton text, in first-seen order. */
export function extractSkeletonSlotKeys(skeleton: Pick<ContentSkeleton, 'subject' | 'body'>): string[] {
  const seen: string[] = [];
  for (const text of [skeleton.subject, skeleton.body]) {
    for (const match of text.matchAll(SLOT_TOKEN_RE)) {
      const key = match[1]!;
      if (!seen.includes(key)) seen.push(key);
    }
  }
  return seen;
}

/**
 * Full structural validation of an authored skeleton.
 *
 * Returns EVERY issue rather than throwing on the first, because this backs an
 * editor: a template author fixing one problem at a time through five
 * round-trips is a worse experience than seeing all five at once.
 *
 * The two directions of slot/token agreement are both errors, deliberately:
 * an undeclared token would render as literal `{{foo}}` text in a real email to
 * a congressional office, and a declared-but-unused slot means the author
 * thinks they are collecting prose that will silently never appear.
 */
export function validateContentSkeleton(skeleton: ContentSkeleton): SkeletonValidationIssue[] {
  const issues: SkeletonValidationIssue[] = [];
  const body = skeleton.body.trim();

  if (!body) {
    issues.push({ code: 'SKELETON_BODY_EMPTY', message: 'The template body cannot be empty.' });
  }
  if (skeleton.body.length > CONTENT_SKELETON_MAX_BODY_CHARS) {
    issues.push({
      code: 'SKELETON_BODY_TOO_LONG',
      message: `The template body is limited to ${CONTENT_SKELETON_MAX_BODY_CHARS} characters.`,
    });
  }
  if (skeleton.subject.length > CONTENT_SKELETON_MAX_SUBJECT_CHARS) {
    issues.push({
      code: 'SKELETON_SUBJECT_TOO_LONG',
      message: `The subject is limited to ${CONTENT_SKELETON_MAX_SUBJECT_CHARS} characters.`,
    });
  }
  if (skeleton.slots.length > CONTENT_SKELETON_MAX_SLOTS) {
    issues.push({
      code: 'SKELETON_TOO_MANY_SLOTS',
      message: `A template is limited to ${CONTENT_SKELETON_MAX_SLOTS} sections.`,
    });
  }

  const declared = new Set<string>();
  for (const slot of skeleton.slots) {
    if (!SLOT_KEY_RE.test(slot.key)) {
      issues.push({
        code: 'SKELETON_SLOT_KEY_INVALID',
        message: `"${slot.key}" is not a valid section key. Use a lowercase key like why_it_matters.`,
        subject: slot.key,
      });
      continue;
    }
    if (declared.has(slot.key)) {
      issues.push({
        code: 'SKELETON_SLOT_DUPLICATE',
        message: `Section "${slot.key}" is declared more than once.`,
        subject: slot.key,
      });
      continue;
    }
    declared.add(slot.key);
    if (!slot.label.trim()) {
      issues.push({
        code: 'SKELETON_SLOT_LABEL_EMPTY',
        message: `Section "${slot.key}" needs a label.`,
        subject: slot.key,
      });
    }
    if (!slot.instruction.trim()) {
      issues.push({
        code: 'SKELETON_SLOT_INSTRUCTION_EMPTY',
        message: `Section "${slot.key}" needs an instruction telling Meri what to write there.`,
        subject: slot.key,
      });
    }
  }

  const used = extractSkeletonSlotKeys(skeleton);
  for (const key of used) {
    if (!declared.has(key)) {
      issues.push({
        code: 'SKELETON_SLOT_UNDECLARED',
        message: `"{{${key}}}" appears in the template but is not a declared section.`,
        subject: key,
      });
    }
  }
  for (const key of declared) {
    if (!used.includes(key)) {
      issues.push({
        code: 'SKELETON_SLOT_UNUSED',
        message: `Section "${key}" is declared but never placed in the template. Add {{${key}}} where it belongs.`,
        subject: key,
      });
    }
  }
  if (body && !used.length) {
    issues.push({
      code: 'SKELETON_NO_SLOTS',
      message:
        'This template has no {{sections}}, so every recipient would receive identical text. Add at least one section for Meri to personalize.',
    });
  }

  return issues;
}

export class ContentSkeletonInvalidError extends Error {
  readonly code = 'CONTENT_SKELETON_INVALID';
  readonly issues: SkeletonValidationIssue[];
  constructor(issues: SkeletonValidationIssue[]) {
    super(`Content skeleton invalid: ${issues.map((i) => i.code).join(', ')}`);
    this.name = 'ContentSkeletonInvalidError';
    this.issues = issues;
  }
}

export interface AssembleSkeletonResult {
  subject: string;
  body: string;
  /** Slots the model returned empty, which were therefore dropped. */
  omittedSlots: string[];
  /** Required slots the model returned empty — a real generation failure. */
  missingRequiredSlots: string[];
}

/**
 * Render the skeleton with model-supplied slot prose. Pure string work.
 *
 * ### Blank-line collapsing, and why it is not cosmetic
 *
 * When an optional slot comes back empty its token is removed, which would
 * otherwise leave the section's own heading stranded above a gap — e.g. a
 * "Why this matters to your office" header followed by nothing. A recipient
 * reading that sees a mistake, and a reviewer cannot tell whether the model
 * failed or the evidence genuinely did not support the section.
 *
 * So an empty optional slot removes its whole line when the token sits alone on
 * that line, and runs of 3+ newlines collapse to a paragraph break. This is why
 * a template author should keep each optional section's heading on the same
 * logical block as its token.
 *
 * ### Whitespace is trimmed per slot, never mid-body
 *
 * Slot prose is trimmed because models frequently return a leading newline,
 * which would double the paragraph break the skeleton already provides. The
 * skeleton's own text is never trimmed beyond the final result, so an author's
 * intentional indentation survives.
 */
export function assembleSkeletonBody(
  skeleton: ContentSkeleton,
  slotValues: Readonly<Record<string, string>>,
): AssembleSkeletonResult {
  const omittedSlots: string[] = [];
  const missingRequiredSlots: string[] = [];
  const required = new Map(skeleton.slots.map((s) => [s.key, s.required]));
  const resolved = new Map<string, string>();

  for (const key of extractSkeletonSlotKeys(skeleton)) {
    const raw = slotValues[key];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) {
      // A required slot the model left empty is a generation failure, not a
      // formatting choice — the caller decides what to do, but it must not
      // silently ship a skeleton with a hole in it.
      if (required.get(key) === true) missingRequiredSlots.push(key);
      else omittedSlots.push(key);
    }
    resolved.set(key, value);
  }

  const substitute = (text: string): string =>
    text.replace(SLOT_TOKEN_RE, (_token, key: string) => resolved.get(key) ?? '');

  // Drop lines that consisted only of a now-empty token, so an omitted optional
  // section does not leave a blank line where its content was.
  const bodyLines = skeleton.body.split('\n');
  const keptLines: string[] = [];
  for (const line of bodyLines) {
    const substituted = substitute(line);
    const lineHadOnlyTokens = /^\s*(?:\{\{[a-z][a-z0-9_]{0,39}\}\}\s*)+$/.test(line);
    if (lineHadOnlyTokens && !substituted.trim()) continue;
    keptLines.push(substituted);
  }

  const body = keptLines
    .join('\n')
    // Collapse a run of blank lines (left by a dropped section) to one break.
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    subject: substitute(skeleton.subject).trim(),
    body,
    omittedSlots,
    missingRequiredSlots,
  };
}

/**
 * The provider JSON schema for skeleton mode.
 *
 * `sections` is an explicit array of `{key, text}` rather than a free-form
 * object keyed by slot name because both providers enforce structured output
 * only when `additionalProperties: false` and `required` are exhaustive at every
 * level — which is impossible for an object whose property names are dynamic
 * per template. An array of fixed-shape pairs is checkable; a dynamic map is not.
 */
export function skeletonDraftJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['sections', 'contextNote'],
    properties: {
      sections: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['key', 'text'],
          properties: {
            key: { type: 'string' },
            text: { type: 'string' },
          },
        },
      },
      contextNote: { type: 'string' },
    },
  };
}

/**
 * Parse a skeleton-mode completion into a slot map.
 *
 * Unknown keys are DISCARDED rather than treated as an error: a model returning
 * an extra section it invented is a normal, harmless miss, and failing the whole
 * generation over it would trade a cosmetic problem for a lost draft. Unknown
 * keys can never reach the recipient anyway — `assembleSkeletonBody` only reads
 * keys the skeleton actually references.
 */
export function parseSkeletonDraft(
  text: string,
): { sections: Record<string, string>; contextNote: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.sections)) return null;

  const sections: Record<string, string> = {};
  for (const entry of obj.sections) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.key !== 'string' || typeof row.text !== 'string') continue;
    sections[row.key] = row.text;
  }
  return {
    sections,
    contextNote: typeof obj.contextNote === 'string' ? obj.contextNote : '',
  };
}

/**
 * A worked example of the section-writing task: a tiny skeleton, and the exact
 * response it should produce.
 *
 * ## Why an example and not more rules
 *
 * `renderSkeletonInstruction` already tells the model three times, in prose, not
 * to reproduce the template's structure. Prohibitions describe; an example
 * demonstrates. The one failure this feature cannot tolerate — a section that
 * repeats its own heading, so the heading appears twice in the assembled email —
 * is precisely the kind of mistake that survives being forbidden and dies when
 * shown. Here the exemplar skeleton contains the heading "Why this matters" and
 * the exemplar output for that slot conspicuously does NOT, which teaches the
 * mapping in a way another sentence of rules does not.
 *
 * It also demonstrates the two things that are otherwise only asserted:
 * returning `""` for an unsupported optional slot (rather than padding it), and
 * writing a salutation as a bare name with no "Dear" (because the template
 * already supplies the greeting).
 *
 * ## Why it is NOT a finished email
 *
 * A fully-rendered example email in the prompt is an invitation to lift its
 * subject matter, figures and framing into the real draft — the exact
 * subject-matter bleed that made `renderStyleSamples` say, in its own comment,
 * that exemplars are "not a template to fill in". The model does not need to see
 * an assembled result to write a good section; it needs to see the MAPPING from
 * skeleton to sections. This shows only that.
 *
 * ## Why it is deliberately fact-free
 *
 * Every concrete detail here is a detail some draft will eventually assert as
 * true. There are no dates, dollar figures, bill numbers, agencies, or
 * real-sounding proper nouns: the topic is a generic placeholder and the one name
 * is an obvious stand-in. `content-skeleton.spec.ts` greps this constant for
 * specimen facts, the same way `starter-content-templates.spec.ts` does for the
 * shipped templates.
 *
 * Cost: this is byte-identical for every recipient in a campaign, so it lives in
 * the cacheable `userStatic` prefix and is paid once per batch, not once per
 * recipient.
 */
export const SKELETON_SECTIONS_EXEMPLAR = [
  'WORKED EXAMPLE — this shows the SHAPE of the response, not the content to write.',
  'The example below is illustrative only. Ignore its topic entirely; take from it only how a template maps to sections.',
  '',
  'If the template were:',
  '  Subject: Request: {{topic}}',
  '',
  '  Dear {{salutation}},',
  '',
  '  {{opening}}',
  '',
  '  Why this matters',
  '  {{why_it_matters}}',
  '',
  '  Thank you for your time.',
  '',
  'then a correct response would be:',
  '  {"sections":[',
  '    {"key":"topic","text":"the subject topic, as a short phrase"},',
  '    {"key":"salutation","text":"Ms. Example"},',
  '    {"key":"opening","text":"One or two sentences of ordinary prose introducing who is writing and what they are asking for."},',
  '    {"key":"why_it_matters","text":""}',
  '  ]}',
  '',
  'Note three things about that response:',
  '- The "why_it_matters" section is an EMPTY STRING because the plan supported no such claim. It is omitted from the sent email rather than padded with something unsupported. This is correct and expected, not a failure.',
  '- No section repeats the heading "Why this matters", the greeting "Dear", or the closing "Thank you for your time." Those words are already in the template; writing them again would print them twice.',
  '- "salutation" is a bare name and honorific, because the template already supplies the word "Dear".',
].join('\n');

/**
 * The prompt block for skeleton mode.
 *
 * This is a tier-1 USER DIRECTIVE, not an example: it tells the model it is
 * writing section content, never the surrounding structure, and that the
 * structure it can see is there purely so its prose fits the surrounding words.
 * Showing the skeleton matters — a slot written blind reads as a non-sequitur
 * against the heading above it.
 *
 * Pairs with SKELETON_SECTIONS_EXEMPLAR, which demonstrates the same rules on a
 * throwaway template. Rules here, demonstration there.
 */
export function renderSkeletonInstruction(skeleton: ContentSkeleton): string {
  const slotLines = skeleton.slots.map((slot) => {
    const optionality = slot.required
      ? 'REQUIRED — you must write this section'
      : 'OPTIONAL — return an empty string if this campaign’s evidence does not support it, and the section will be omitted';
    return [`- key="${slot.key}" (${slot.label}) — ${optionality}`, `    ${slot.instruction}`].join(
      '\n',
    );
  });

  return [
    'TEMPLATE SECTIONS — THIS IS THE TASK. Read it before anything else:',
    'You are NOT writing a whole email. The user has authored a fixed template and the app will assemble the final message itself. You write ONLY the prose for each named section below; the app inserts it into the template verbatim.',
    'Do NOT reproduce the template text, headings, greeting, or sign-off in your section content — they are already in the template and would appear twice.',
    'Every section is still bound by the VALIDATED MESSAGE PLAN: write only claims the plan supports. If the plan does not support an optional section, return an empty string for it rather than writing something unsupported.',
    '',
    'Sections to write:',
    ...slotLines,
    '',
    'THE TEMPLATE (shown so your prose reads naturally against the words around it — do NOT reproduce any of it):',
    `Subject: ${skeleton.subject}`,
    '',
    skeleton.body,
  ].join('\n');
}
