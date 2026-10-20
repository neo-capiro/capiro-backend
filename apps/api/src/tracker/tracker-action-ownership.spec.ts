import {
  classifyChange,
  selectMaterialEvents,
  type ActionLike,
} from './tracker-change-detector.service.js';
import {
  classificationCases,
  expectedClasses,
} from './fixtures/tracker-action-ownership/literals.js';

describe('API tracker action ownership characterization', () => {
  it.each(classificationCases)('$name', ({ text, expected }) => {
    expect(classifyChange(text)).toEqual(expected === null ? null : expectedClasses[expected]);
  });

  it('returns fresh mutable metadata for every classification', () => {
    const first = classifyChange('Public law no. 119-1.');
    const second = classifyChange('Public law no. 119-1.');
    expect(first).toEqual(expectedClasses.enacted);
    expect(first).not.toBe(second);
    first!.label = 'caller mutation';
    expect(second).toEqual(expectedClasses.enacted);
    expect(classifyChange('Public law no. 119-1.')).toEqual(expectedClasses.enacted);
  });
});

it('selects a missing rollup without mutating frozen actions or dates', () => {
  const hearingDate = new Date('2026-01-01T00:00:00Z');
  const passageDate = new Date('2026-01-03T00:00:00Z');
  const latestDate = new Date('2026-01-02T00:00:00Z');
  const passed = Object.freeze({
    date: passageDate,
    text: 'Passed the House.',
    chamber: 'House',
  });
  const hearing = Object.freeze({ date: hearingDate, text: 'Hearing held.' });
  const actions: ActionLike[] = [passed, hearing];
  Object.freeze(actions);
  const latest = Object.freeze({
    date: latestDate,
    text: 'Ordered to be reported.',
    chamber: 'Senate',
  });
  const events = selectMaterialEvents(actions, latest);
  expect(events).toEqual([
    { cls: expectedClasses.hearing, text: 'Hearing held.', date: hearingDate, chamber: null },
    {
      cls: expectedClasses.reported,
      text: 'Ordered to be reported.',
      date: latestDate,
      chamber: 'Senate',
    },
    {
      cls: expectedClasses.passed,
      text: 'Passed the House.',
      date: passageDate,
      chamber: 'House',
    },
  ]);
  expect(actions).toEqual([passed, hearing]);
  expect(events[0]!.date).toBe(hearingDate);
  expect(events[1]!.date).toBe(latestDate);
  expect(events[2]!.date).toBe(passageDate);
});

it('retains the earliest action per class and original order for same-date ties', () => {
  const day = new Date('2026-01-01T00:00:00Z');
  const later = new Date('2026-01-02T00:00:00Z');
  const events = selectMaterialEvents(
    [
      { text: 'Hearing held later.', date: later, chamber: 'Senate' },
      { text: 'Committee markup first.', date: day, chamber: 'House' },
      { text: 'Hearing held first.', date: day, chamber: 'House' },
      { text: 'Committee markup second.', date: day, chamber: 'Senate' },
    ],
    { text: 'Hearing held latest.', date: later },
  );
  expect(events).toEqual([
    { cls: expectedClasses.markup, text: 'Committee markup first.', date: day, chamber: 'House' },
    { cls: expectedClasses.hearing, text: 'Hearing held first.', date: day, chamber: 'House' },
  ]);
});

it('keeps sourced row chamber when the exact rollup carries another chamber', () => {
  const day = new Date('2026-01-01T00:00:00Z');
  const events = selectMaterialEvents([{ text: 'Hearing held.', date: day, chamber: 'House' }], {
    text: 'Hearing held.',
    date: new Date(day),
    chamber: 'Senate',
  });
  expect(events).toEqual([
    { cls: expectedClasses.hearing, text: 'Hearing held.', date: day, chamber: 'House' },
  ]);
});

it('preserves explicit empty chamber and normalizes missing chamber to null', () => {
  expect(
    selectMaterialEvents(
      [
        { text: 'Markup.', date: null, chamber: '' },
        { text: 'Hearing.', date: null },
      ],
      null,
    ),
  ).toEqual([
    { cls: expectedClasses.markup, text: 'Markup.', date: null, chamber: '' },
    { cls: expectedClasses.hearing, text: 'Hearing.', date: null, chamber: null },
  ]);
});

it('treats null and epoch as equal and retains the first source chamber', () => {
  expect(
    selectMaterialEvents([{ text: 'Hearing.', date: null, chamber: 'House' }], {
      text: 'Hearing.',
      date: new Date(0),
      chamber: 'Senate',
    }),
  ).toEqual([{ cls: expectedClasses.hearing, text: 'Hearing.', date: null, chamber: 'House' }]);
});

it('keeps a null-date event ahead of a positive-date event', () => {
  const day = new Date('2026-01-01T00:00:00Z');
  expect(
    selectMaterialEvents(
      [
        { text: 'Hearing.', date: day },
        { text: 'Markup.', date: null },
      ],
      null,
    ),
  ).toEqual([
    { cls: expectedClasses.markup, text: 'Markup.', date: null, chamber: null },
    { cls: expectedClasses.hearing, text: 'Hearing.', date: day, chamber: null },
  ]);
});

it('retains stable input order when an invalid date makes comparison NaN', () => {
  // Existing contract: selectors do not validate or serialize supplied dates.
  const invalid = new Date('invalid');
  expect(
    selectMaterialEvents(
      [
        { text: 'Hearing.', date: invalid },
        { text: 'Markup.', date: new Date(0) },
      ],
      null,
    ),
  ).toEqual([
    { cls: expectedClasses.hearing, text: 'Hearing.', date: invalid, chamber: null },
    { cls: expectedClasses.markup, text: 'Markup.', date: new Date(0), chamber: null },
  ]);
});

it('filters null, empty and procedural actions, including an empty rollup', () => {
  expect(
    selectMaterialEvents(
      [
        { text: null, date: null },
        { text: '', date: null },
        { text: 'Motion to recommit failed.', date: null },
      ],
      { text: '', date: new Date(0) },
    ),
  ).toEqual([]);
  expect(selectMaterialEvents([], null)).toEqual([]);
});

it('uses current source getters in order without re-reading dates for output', () => {
  const trace: string[] = [];
  class ObservedDate extends Date {
    constructor(private readonly owner: string) {
      super(0);
    }
    getTime(): number {
      trace.push(`${this.owner}.getTime`);
      return super.getTime();
    }
  }
  const rowDate = new ObservedDate('row.date');
  const latestDate = new ObservedDate('latest.date');
  const row: ActionLike = {
    get text() {
      trace.push('row.text');
      return 'Hearing.';
    },
    get date() {
      trace.push('row.date');
      return rowDate;
    },
    get chamber() {
      trace.push('row.chamber');
      return 'House';
    },
  };
  const latest: ActionLike = {
    get text() {
      trace.push('latest.text');
      return 'Hearing.';
    },
    get date() {
      trace.push('latest.date');
      return latestDate;
    },
    get chamber(): never {
      throw new Error('duplicate rollup chamber must not be read');
    },
  };
  const events = selectMaterialEvents([row], latest);
  expect(trace).toEqual([
    'latest.text',
    'row.text',
    'latest.text',
    'row.date',
    'row.date.getTime',
    'latest.date',
    'latest.date.getTime',
    'row.text',
    'row.text',
    'row.date',
    'row.chamber',
  ]);
  expect(events).toEqual([
    { cls: expectedClasses.hearing, text: 'Hearing.', date: rowDate, chamber: 'House' },
  ]);
});

it('does not inspect a falsy rollup date or chamber', () => {
  const latest: ActionLike = {
    text: '',
    get date(): never {
      throw new Error('empty rollup date must not be read');
    },
    get chamber(): never {
      throw new Error('empty rollup chamber must not be read');
    },
  };
  expect(selectMaterialEvents([], latest)).toEqual([]);
});

it('returns fresh events and metadata while retaining source Date identity', () => {
  const date = new Date(0);
  const actions = [{ text: 'Markup.', date }];
  const first = selectMaterialEvents(actions, null);
  const second = selectMaterialEvents(actions, null);
  expect(first).not.toBe(second);
  expect(first[0]).not.toBe(second[0]);
  expect(first[0]!.cls).not.toBe(second[0]!.cls);
  expect(first[0]!.date).toBe(date);
  first[0]!.cls.label = 'caller mutation';
  expect(second).toEqual([{ cls: expectedClasses.markup, text: 'Markup.', date, chamber: null }]);
});

it('drops caller extension fields when constructing an action event', () => {
  const action = {
    text: 'Hearing.',
    date: null,
    chamber: 'House',
    sourceUrl: 'https://source.example/hearing',
    extra: { yeas: 12 },
    opaque: 'caller field',
  };
  expect(selectMaterialEvents([action], null)).toEqual([
    { cls: expectedClasses.hearing, text: 'Hearing.', date: null, chamber: 'House' },
  ]);
  expect(action.extra).toEqual({ yeas: 12 });
});
