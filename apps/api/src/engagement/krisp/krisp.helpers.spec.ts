import { krispNotetakerEnabled } from '../../common/krisp-notetaker-flags.js';
import {
  krispArguments,
  krispPayload,
  krispTranscript,
  matchKrispMeeting,
  normalizeKrispMeeting,
} from './krisp.helpers.js';

const id = '0123456789abcdef0123456789abcdef';
describe('Krisp tenant flag and provider contract', () => {
  test('the tenant flag enables Krisp; missing, false, and non-boolean values deny', () => {
    const yes = { clioFeatureFlags: { 'notetaker.krisp.enabled': true } };
    expect(krispNotetakerEnabled(yes)).toBe(true);
    for (const value of [undefined, false, 'true', 1]) {
      expect(
        krispNotetakerEnabled(
          { clioFeatureFlags: { 'notetaker.krisp.enabled': value } },
        ),
      ).toBe(false);
    }
  });
  test('MCP structured and JSON-text results retain full transcript and reject provider errors', () => {
    const data = {
      documents: [{ id, transcript: [{ speaker: 'Alice', text: 'Follow up tomorrow.' }] }],
    };
    expect(
      krispTranscript(krispPayload({ structuredResult: { structuredContent: data } }), id),
    ).toBe('Alice: Follow up tomorrow.');
    expect(
      krispTranscript(
        krispPayload({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
        id,
      ),
    ).toBe('Alice: Follow up tomorrow.');
    expect(() => krispPayload({ isError: true, content: [] })).toThrow();
    expect(
      krispTranscript(
        { documents: [{ id: 'f'.repeat(32), transcript: 'Private other meeting' }] },
        id,
      ),
    ).toBeNull();
    expect(krispTranscript({ documents: [{ id, summary: 'Not a transcript' }] }, id)).toBeNull();
  });
  test('only uses live advertised arguments; unsupported folder and document schemas fail closed', () => {
    expect(
      krispArguments(
        {
          properties: { document_ids: { type: 'array' }, include_transcript: { type: 'boolean' } },
          required: ['document_ids'],
        },
        { ids: [id] },
      ),
    ).toEqual({ document_ids: [id], include_transcript: true });
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
