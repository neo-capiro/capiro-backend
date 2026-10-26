import {
  NEWSLETTER_SURVEY_SECTION_TYPES,
  createNewsletterSurveyQuestion,
  defaultNewsletterSurveyDefinition,
  parseNewsletterSurveyDraft,
  parseNewsletterSurveyDraftList,
  type NewsletterSavedSurvey,
} from './newsletter.js';

const id = 'aaaaaaaa-1111-4111-8111-111111111111';
const other = 'bbbbbbbb-2222-4222-8222-222222222222';
const item = (): NewsletterSavedSurvey => ({
  id,
  name: 'Synthetic draft',
  revision: 1,
  status: 'draft',
  updatedAt: '2026-10-26T10:00:00.000Z',
  sourceClientIds: ['cccccccc-3333-7333-8333-333333333333'],
  definition: defaultNewsletterSurveyDefinition(),
});

describe('standalone survey draft receiving', () => {
  it('receives the actual create item and list envelope, including an empty personal library', () => {
    const value = item();
    expect(parseNewsletterSurveyDraft(value, { revision: 1 })).toEqual({ ok: true, value });
    expect(parseNewsletterSurveyDraftList({ items: [value] })).toEqual({
      ok: true,
      value: { items: [value] },
    });
    expect(parseNewsletterSurveyDraftList({ items: [] })).toEqual({
      ok: true,
      value: { items: [] },
    });
    for (const bad of [null, undefined, [], {}, { message: 'not found' }]) {
      expect(parseNewsletterSurveyDraft(bad).ok).toBe(false);
      expect(parseNewsletterSurveyDraftList(bad).ok).toBe(false);
    }
    expect(parseNewsletterSurveyDraft({ items: [value] }).ok).toBe(false);
    expect(parseNewsletterSurveyDraftList([value]).ok).toBe(false);
  });

  it('binds an acknowledged update to its known survey ID and captured revision, without inventing document binding', () => {
    const value = { ...item(), revision: 5 };
    expect(parseNewsletterSurveyDraft(value, { id: id.toUpperCase(), revision: 5 })).toEqual({
      ok: true,
      value,
    });
    expect(parseNewsletterSurveyDraft(value, { id: other, revision: 5 })).toEqual({
      ok: false,
      error: { code: 'identity_mismatch', path: '$.id' },
    });
    expect(parseNewsletterSurveyDraft(value, { id, revision: 4 })).toEqual({
      ok: false,
      error: { code: 'identity_mismatch', path: '$.revision' },
    });
    // The producer can read a concurrent newer revision after its own update. This is
    // a valid row without that expected pin, never positive evidence of no write.
    expect(parseNewsletterSurveyDraft(value, { id }).ok).toBe(true);
    for (const expected of [null, {}, { id: '' }, { revision: 0 }, { documentId: other }])
      expect(parseNewsletterSurveyDraft(value, expected as never).ok).toBe(false);
    // A saved revision1000000 can increment once beyond the request DTO ceiling.
    expect(parseNewsletterSurveyDraft({ ...item(), revision: 1_000_001 }).ok).toBe(true);
  });

  it('preserves supported question vocabulary, absent versus null introduction choice and exact ordered choices', () => {
    const value = item();
    value.definition.questions = NEWSLETTER_SURVEY_SECTION_TYPES.map(([type]) =>
      createNewsletterSurveyQuestion(type),
    );
    value.definition.questions[1]!.options = ['one\nline', 'second'];
    const legacy = createNewsletterSurveyQuestion('introduction');
    delete legacy.introductionType;
    value.definition.questions.push(legacy);
    const received = parseNewsletterSurveyDraft(value);
    expect(received).toEqual({ ok: true, value });
    if (!received.ok) throw new Error('not received');
    expect(received.value.definition.questions[0]!.introductionType).toBeNull();
    expect('introductionType' in received.value.definition.questions.at(-1)!).toBe(false);
    expect(received.value.definition.questions[1]!.options).toEqual(['one\nline', 'second']);
  });

  it('preserves inert read-side JSON additions without granting publication, response or access capability', () => {
    const value = { ...item(), future: { labels: ['keep'], published: true } };
    const wire = { items: [value], future: { cursor: 'not-a-supported-operation' } };
    const result = parseNewsletterSurveyDraftList(wire);
    expect(result).toEqual({ ok: true, value: wire });
    if (!result.ok) throw new Error('not received');
    (result.value.items[0] as typeof value).future.labels.push('local');
    expect(value.future.labels).toEqual(['keep']);
    expect(result.value.items[0]!.status).toBe('draft');
  });

  it('admits 500 actual rows and refuses overflow, duplicate IDs and malformed draft status or nested shapes', () => {
    const values = Array.from({ length: 500 }, (_, i) => ({
      ...item(),
      id: `${i.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`,
    }));
    expect(parseNewsletterSurveyDraftList({ items: values }).ok).toBe(true);
    expect(parseNewsletterSurveyDraftList({ items: [...values, item()] })).toMatchObject({
      ok: false,
      error: { code: 'limit_exceeded' },
    });
    expect(
      parseNewsletterSurveyDraftList({ items: [item(), { ...item(), id: id.toUpperCase() }] }).ok,
    ).toBe(false);
    for (const value of [
      { ...item(), status: 'open' },
      { ...item(), status: 'closed' },
      { ...item(), status: 'published' },
      { ...item(), id: '00000000-0000-0000-0000-000000000000' },
      { ...item(), updatedAt: '2026-10-26' },
      { ...item(), revision: 1.5 },
      {
        ...item(),
        definition: {
          ...item().definition,
          questions: Array(31).fill(createNewsletterSurveyQuestion('text')),
        },
      },
      {
        ...item(),
        definition: {
          ...item().definition,
          questions: [
            {
              ...createNewsletterSurveyQuestion('range'),
              range: { min: '1', max: 5, display: 'stars' },
            },
          ],
        },
      },
      {
        ...item(),
        definition: {
          ...item().definition,
          questions: [{ ...createNewsletterSurveyQuestion('text'), type: 'payment' }],
        },
      },
    ])
      expect(parseNewsletterSurveyDraft(value).ok).toBe(false);
  });

  it('refuses hostile JSON and expected bindings without invoking getters or throwing', () => {
    let touched = 0;
    const accessor = Object.defineProperty(item(), 'definition', {
      enumerable: true,
      get() {
        touched++;
        return {};
      },
    });
    const binding = Object.defineProperty({}, 'id', {
      enumerable: true,
      get() {
        touched++;
        return id;
      },
    });
    const cycle: Record<string, unknown> = { ...item() };
    cycle.self = cycle;
    const throwing = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('hostile');
        },
      },
    );
    for (const value of [
      accessor,
      cycle,
      throwing,
      { ...item(), future: undefined },
      { ...item(), future: BigInt(1) },
    ]) {
      expect(parseNewsletterSurveyDraft(value).ok).toBe(false);
      expect(parseNewsletterSurveyDraftList({ items: [value] }).ok).toBe(false);
    }
    expect(parseNewsletterSurveyDraft(item(), binding as never).ok).toBe(false);
    expect(touched).toBe(0);
  });
});
