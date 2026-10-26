/** Survey receiving only. Core owns current access and draft writes; this module never performs either. */
import type { NewsletterSavedSurvey } from './newsletter.js';
import {
  array,
  bool,
  literal,
  nullable,
  number,
  object,
  receive,
  refuse,
  revision,
  row,
  snapshot,
  text,
  timestamp,
  uuid,
  vocabulary,
  workspaceUuid,
  type Rule,
  type ReceiveResult,
  type Json,
} from './json-receiving.js';

export const NEWSLETTER_SURVEY_SECTION_TYPES = [
  ['introduction', 'Introduction'],
  ['radio', 'Radio Buttons'],
  ['checkbox', 'Checkboxes'],
  ['range', 'Range'],
  ['text', 'Open Text'],
  ['email', 'Email'],
  ['contact', 'Contact Information'],
  ['content', 'Content Block'],
] as const;

// An embedded saved-survey snapshot is not a resource lookup or a stage capability.
const SAVED_SURVEY_ID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const savedSurveyId: Rule = (value, path) => {
  if (typeof value !== 'string' || !SAVED_SURVEY_ID.test(value)) refuse(path);
};
const savedSurveyTime: Rule = (value, path) => {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value)))
    refuse(path);
};
const question = object(
  {
    id: text,
    type: vocabulary(() => NEWSLETTER_SURVEY_SECTION_TYPES.map(([key]) => key)),
    prompt: text,
    required: bool,
    options: array(text, 30),
    other: bool,
    range: object({
      min: number,
      max: number,
      display: literal('numbers', 'stars', 'emojis', 'hearts'),
    }),
    contactField: literal('firstName', 'lastName', 'age', 'gender', 'address'),
    askToSubscribe: bool,
    imageUrl: text,
    alt: text,
    videoUrl: text,
  },
  { introductionType: nullable(literal('text', 'image', 'video')) },
);
const surveyDefinition = object({
  version: literal(1),
  questions: array(question, 30),
  title: text,
  description: text,
  logoUrl: text,
  submitLabel: text,
  confirmation: text,
  closedMessage: text,
  requiredMessage: text,
  background: text,
  buttonColor: text,
  buttonTextColor: text,
});
export const savedSurvey = object({
  id: savedSurveyId,
  name: text,
  revision,
  status: literal('draft'),
  updatedAt: savedSurveyTime,
  sourceClientIds: array(workspaceUuid, 100),
  definition: surveyDefinition,
});

/** The existing GET envelope is a bounded personal library, not a document-exclusive list. */
export interface NewsletterSurveyDraftList {
  items: NewsletterSavedSurvey[];
}

// Native resource rows have UUIDs and ISO instants. Embedded historical snapshots retain
// their more permissive original savedSurvey guards above, including nil IDs/date-only time.
const currentDraft: Rule = (value, path) => {
  savedSurvey(value, path);
  object({ id: uuid, updatedAt: timestamp })(value, path);
};

/** POST returns a current readback, not a request receipt. It can already be a newer revision.
 * Bind only echoed survey identity/revision; document, tenant and request identity are not echoed.
 * A mismatch never proves that the write did not commit and never authorizes automatic replay.
 */
export function parseNewsletterSurveyDraft(
  value: unknown,
  expected?: { id?: string; revision?: number },
): ReceiveResult<NewsletterSavedSurvey> {
  return receive(value, currentDraft, (parsed) => {
    if (expected === undefined) return;
    const binding = row(snapshot(expected), '$expected');
    object({}, { id: uuid, revision })(binding, '$expected');
    const keys = Object.keys(binding);
    if (!keys.length) refuse('$expected');
    for (const key of keys) if (key !== 'id' && key !== 'revision') refuse(`$expected.${key}`);
    const item = row(parsed, '$');
    if (
      binding.id !== undefined &&
      (binding.id as string).toLowerCase() !== (item.id as string).toLowerCase()
    )
      refuse('$.id', 'identity_mismatch');
    if (binding.revision !== undefined && binding.revision !== item.revision)
      refuse('$.revision', 'identity_mismatch');
  });
}

/** Empty means no rows in this bounded response; it is neither non-commit nor completeness proof. */
export function parseNewsletterSurveyDraftList(
  value: unknown,
): ReceiveResult<NewsletterSurveyDraftList> {
  return receive(value, object({ items: array(currentDraft, 500) }), (parsed) => {
    const seen = new Set<string>();
    for (const [index, item] of (row(parsed, '$').items as Json[]).entries()) {
      const id = (row(item, `$.items.${index}`).id as string).toLowerCase();
      if (seen.has(id)) refuse(`$.items.${index}.id`);
      seen.add(id);
    }
  });
}
