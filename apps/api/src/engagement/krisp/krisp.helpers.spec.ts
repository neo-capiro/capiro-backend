import { krispImportMode, krispNotetakerEnabled } from '../../common/krisp-notetaker-flags.js';
import {
  krispArguments,
  krispPayload,
  krispNotes,
  krispTranscript,
  krispNextPage,
  matchKrispMeeting,
  normalizeKrispMeeting,
} from './krisp.helpers.js';

const id = '0123456789abcdef0123456789abcdef';
describe('Krisp tenant flag and provider contract', () => {
  test('only C2 uses direct notes, independently of whether Krisp is enabled', () => {
    expect(krispImportMode('c2-strategies')).toBe('direct_notes');
    for (const slug of ['capiro-internal', 'other-firm', '', 'c2-strategies-other'])
      expect(krispImportMode(slug)).toBe('generated');
  });
  test('the generation path requests and parses only the matching complete transcript', () => {
    const schema = {
      properties: {
        ids: {},
        include: { type: 'array', items: { enum: ['notes', 'transcript'] } },
        format: { enum: ['json'] },
      },
    };
    expect(krispArguments(schema, { ids: [id], content: 'transcript' })).toEqual({
      ids: [id],
      include: ['transcript'],
      format: 'json',
    });
    const data = {
      results: [
        { id, document: { id, transcript: 'Pat: Send the proposal.', notes: 'Do not copy me' } },
      ],
    };
    expect(krispTranscript(data, id)).toBe('Pat: Send the proposal.');
    expect(krispTranscript(data, 'f'.repeat(32))).toBeNull();
    expect(krispTranscript({ documents: [{ id, notes: 'Notes only' }] }, id)).toBeNull();
    expect(
      krispTranscript(
        {
          documents: [
            { id, full_transcript: { segments: [{ speaker: { name: 'Pat' }, text: 'Send it.' }] } },
          ],
        },
        id,
      ),
    ).toBe('Pat: Send it.');
    expect(() =>
      krispTranscript(
        { results: [{ id, document: { id: 'f'.repeat(32), transcript: 'Other meeting' } }] },
        id,
      ),
    ).toThrow('different document');
    for (const doc of [
      { id, transcript: 'x'.repeat(100001) },
      { id, transcript: 'partial', truncated: true },
      { id, transcript: { text: 'partial', truncated: true } },
    ])
      expect(() => krispTranscript({ documents: [doc] }, id)).toThrow('limit');
  });
  test('the tenant flag enables Krisp; missing, false, and non-boolean values deny', () => {
    const yes = { clioFeatureFlags: { 'notetaker.krisp.enabled': true } };
    expect(krispNotetakerEnabled(yes)).toBe(true);
    for (const value of [undefined, false, 'true', 1]) {
      expect(
        krispNotetakerEnabled({ clioFeatureFlags: { 'notetaker.krisp.enabled': value } }),
      ).toBe(false);
    }
  });
  test('live JSON document envelope preserves notes verbatim and never uses other content', () => {
    const notes = '  # Notes\n\n**Decision:** Proceed.\n';
    const data = { results: [{ id, document: { id, name: 'Meeting', notes } }] };
    expect(krispNotes(krispPayload({ structuredResult: { structuredContent: data } }), id)).toBe(
      notes,
    );
    expect(
      krispNotes(krispPayload({ content: [{ type: 'text', text: JSON.stringify(data) }] }), id),
    ).toBe(notes);
    expect(() => krispPayload({ isError: true, content: [] })).toThrow();
    expect(krispNotes(data, 'f'.repeat(32))).toBeNull();
    expect(krispNotes({ results: [{ id, document: null }] }, id)).toBeNull();
    expect(
      krispNotes({ documents: [{ id, transcript: 'raw', summary: 'summary' }] }, id),
    ).toBeNull();
    expect(() =>
      krispNotes({ results: [{ id, document: { id: 'f'.repeat(32), notes } }] }, id),
    ).toThrow('different document');
    expect(() => krispNotes({ documents: [{ id, notes: { unknown: 'shape' } }] }, id)).toThrow(
      'format',
    );
    expect(() => krispNotes({ documents: [{ id, notes: 'x'.repeat(100001) }] }, id)).toThrow(
      'limit',
    );
    expect(() => krispNotes({ documents: [{ id, notes, truncated: true }] }, id)).toThrow('limit');
  });
  test('live notes, date and folder parameters and count-only pagination', () => {
    expect(
      krispArguments(
        {
          properties: {
            ids: {},
            include: { type: 'array', items: { enum: ['notes', 'transcript'] } },
            format: { enum: ['markdown', 'json'] },
          },
        },
        { ids: [id] },
      ),
    ).toEqual({ ids: [id], include: ['notes'], format: 'json' });
    expect(
      krispArguments(
        { properties: { after: {}, before: {}, folder_ids: {}, limit: {}, offset: {} } },
        { since: 'start', until: 'end', folderId: id, offset: 50 },
      ),
    ).toEqual({ after: 'start', before: 'end', folder_ids: [id], limit: 50, offset: 50 });
    expect(krispNextPage({ count: 50 }, 50, 0).more).toBe(true);
    expect(krispNextPage({ count: 3 }, 3, 50).more).toBe(false);
    expect(krispNextPage({ total: 50 }, 50, 0).more).toBe(false);
  });
  test('only uses live advertised arguments; unsupported folder and document schemas fail closed', () => {
    expect(
      krispArguments(
        {
          properties: {
            document_ids: { type: 'array' },
            include_transcript: { type: 'boolean' },
            include_notes: { type: 'boolean' },
          },
          required: ['document_ids'],
        },
        { ids: [id] },
      ),
    ).toEqual({ document_ids: [id], include_transcript: false, include_notes: true });
    expect(() => krispArguments({ properties: {} }, { ids: [id] })).toThrow('lookup schema');
    expect(() => krispArguments({ properties: {} }, { folderId: 'private-folder' })).toThrow(
      'folder filtering',
    );
    expect(() =>
      krispArguments({ properties: { unknown: { type: 'string' } }, required: ['unknown'] }, {}),
    ).toThrow('unsupported parameter');
  });
  test('matching requires a unique strong match near the meeting time', () => {
    const source = normalizeKrispMeeting({
      id,
      title: 'Weekly meeting',
      start_time: '2026-10-05T15:00:00Z',
      organizer_email: 'alice@example.test',
    })!;
    const candidate = {
      id: 'meri-1',
      subject: source.title,
      startsAt: source.startsAt,
      iCalUId: null,
      externalId: null,
      joinLink: null,
      organizerEmail: 'alice@example.test',
    };
    expect(matchKrispMeeting(source, [candidate])).toBe('meri-1');
    expect(matchKrispMeeting(source, [candidate, { ...candidate, id: 'meri-2' }])).toBeNull();
    expect(matchKrispMeeting({ ...source, organizer: null }, [candidate])).toBeNull();
    expect(
      matchKrispMeeting(source, [{ ...candidate, startsAt: new Date('2026-10-06T15:00:00Z') }]),
    ).toBeNull();
    expect(normalizeKrispMeeting({ id: 'invalid', title: 'Meeting', date: 'nonsense' })).toBeNull();
  });
});
