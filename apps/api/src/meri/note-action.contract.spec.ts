import 'reflect-metadata';
import {
  NOTE_ACTION,
  NOTE_ACTION_SCOPE_KEY,
  assertNoteActionAccess,
  isNoteAction,
  noteActionFingerprint,
  noteActionReceipt,
  noteActionRequest,
  noteBodyHash,
  noteExecutionFailure,
  noteRequest,
  publicNoteActionPreview,
  readNoteScope,
  type NoteActionAccess,
} from './note-action.contract.js';

const client = '11111111-1111-4111-8111-111111111111';
const meeting = '22222222-2222-4222-8222-222222222222';
const conversationId = '33333333-3333-4333-8333-333333333333';
const documentId = '44444444-4444-4444-8444-444444444444';
const scope = {
  conversationId,
  selectedClientId: client,
  identityRevision: 'a'.repeat(64),
  membershipRevision: 'b'.repeat(64),
  contextRevision: 'c'.repeat(64),
};
const access = (over: Partial<NoteActionAccess> = {}): NoteActionAccess => ({
  scope: { ...scope },
  mode: 'execute',
  clientIds: [client],
  assertCurrent: jest.fn().mockResolvedValue(undefined),
  ...over,
});
const noteRow = (over: Record<string, unknown> = {}) => ({
  id: documentId,
  clientId: client,
  body: 'Deployment follow-up',
  ...over,
});

describe('native note request is closed and bounded', () => {
  it('trims the body, keeps only documented fields and rejects unknown authority', () => {
    expect(noteRequest(NOTE_ACTION, { body: '  Deployment follow-up  ', title: 'Kickoff' })).toEqual({
      body: 'Deployment follow-up',
      title: 'Kickoff',
    });
    for (const input of [
      { body: '' },
      { body: 'x'.repeat(40001) },
      { body: 'ok', source: 'model_guess' },
      { body: 'ok', memoryCandidate: true },
      { body: 'ok', conversationId },
      { body: 'ok', meetingId: 'not-a-uuid' },
      { body: 'ok', accessLevel: '' },
    ])
      expect(() => noteRequest(NOTE_ACTION, input)).toThrow();
    expect(isNoteAction(NOTE_ACTION)).toBe(true);
    expect(isNoteAction('save_chat_attachments')).toBe(false);
    expect(() => noteRequest('save_chat_attachments', { body: 'ok' })).toThrow();
  });
  it('exposes the immutable request identity without the private body', () => {
    const view = noteActionRequest({ body: 'Deployment follow-up', title: 'Kickoff' });
    expect(view.bodyHash).toBe(noteBodyHash('Deployment follow-up'));
    expect(view.bodyLength).toBe('Deployment follow-up'.length);
    expect(JSON.stringify(view)).not.toContain('Deployment follow-up');
    expect(view).toMatchObject({ clientId: null, meetingId: null, confidential: null });
  });
});

describe('canonical saved-note receipts', () => {
  it('records a meeting note only with its exact persisted meeting-note id', () => {
    const input = { body: 'Deployment follow-up', meetingId: meeting, clientId: client };
    expect(
      noteActionReceipt(
        NOTE_ACTION,
        {
          tool: NOTE_ACTION,
          status: 'saved',
          generatedAt: '2026-10-27T00:00:00.000Z',
          note: noteRow(),
          meetingNote: { id: meeting, status: 'approved', confidential: true, accessLevel: 'tenant_admins_and_author' },
        },
        input,
      ),
    ).toMatchObject({
      destination: 'meeting',
      noteId: documentId,
      meetingNoteId: meeting,
      meetingNoteStatus: 'approved',
      readiness: 'ready',
    });
    // A meeting receipt for a note that never named a meeting is untrusted.
    expect(() =>
      noteActionReceipt(
        NOTE_ACTION,
        { status: 'saved', note: noteRow(), meetingNote: { id: meeting } },
        { body: 'Deployment follow-up' },
      ),
    ).toThrow('Saved-note receipt unavailable');
  });
  it('keeps stored/scanning/private/unavailable readiness truthful and exact', () => {
    const input = { body: 'Deployment follow-up', clientId: client };
    const receipt = (over: Record<string, unknown>) =>
      noteActionReceipt(
        NOTE_ACTION,
        { status: 'saved', note: noteRow(), documentId, ...over },
        input,
      );
    const location = `/clients?clientId=${client}&tab=files&attachmentId=${documentId}`;
    expect(receipt({ location, indexingStatus: 'indexed' })).toMatchObject({
      destination: 'client_document',
      readiness: 'indexed',
      reused: false,
    });
    expect(receipt({ location, indexingStatus: 'not_indexed' })).toMatchObject({ readiness: 'private' });
    expect(receipt({ location, indexingStatus: 'pending' })).toMatchObject({ readiness: 'indexing' });
    expect(receipt({ status: 'pending', location, indexingStatus: 'pending' })).toMatchObject({
      readiness: 'scanning',
    });
    expect(receipt({ status: 'failed', location, indexingStatus: 'not_indexed' })).toMatchObject({
      readiness: 'unavailable',
    });
    // A link that does not address the exact persisted document is not a receipt.
    expect(() => receipt({ location: '/clients?clientId=' + client, indexingStatus: 'indexed' })).toThrow();
    expect(() => receipt({ location, indexingStatus: 'indexed', documentId: client })).toThrow();
    expect(receipt({ location, indexingStatus: 'indexed', reused: true })).toMatchObject({ reused: true });
  });
  it('refuses a receipt whose persisted body is not this exact request body', () => {
    expect(() =>
      noteActionReceipt(
        NOTE_ACTION,
        { status: 'saved', note: noteRow({ body: 'A different note' }), documentId, location:
            `/clients?clientId=${client}&tab=files&attachmentId=${documentId}` },
        { body: 'Deployment follow-up', clientId: client },
      ),
    ).toThrow('Saved-note receipt unavailable');
  });
  it('treats a clientless ClioNote as a General saved note, never a client Files document', () => {
    const input = { body: 'Deployment follow-up' };
    expect(
      noteActionReceipt(NOTE_ACTION, { status: 'saved', note: noteRow({ clientId: null }) }, input),
    ).toMatchObject({ destination: 'general', clientId: null, readiness: 'ready' });
    // A clientless request must not produce a client-document receipt.
    expect(() =>
      noteActionReceipt(
        NOTE_ACTION,
        { status: 'saved', note: noteRow({ clientId: null }), documentId, location: 'x' },
        input,
      ),
    ).toThrow('Saved-note receipt unavailable');
    // A bare ClioNote row without an identity is not a confirmation at all.
    expect(noteActionReceipt(NOTE_ACTION, { status: 'saved', note: {} }, input)).toBeNull();
    expect(noteActionReceipt(NOTE_ACTION, { status: 'saved' }, input)).toBeNull();
  });
});

describe('note authority binding', () => {
  it('binds the stored scope, hides it from public previews and requires execute authority', async () => {
    const stored = noteActionFingerprint(NOTE_ACTION, { body: 'x' }, scope) as Record<string, unknown>;
    expect(stored[NOTE_ACTION_SCOPE_KEY]).toEqual(scope);
    const preview = publicNoteActionPreview(stored);
    expect(preview[NOTE_ACTION_SCOPE_KEY]).toBeUndefined();
    expect(readNoteScope(stored)).toEqual(scope);
    expect(() => readNoteScope({})).toThrow();
    await expect(
      assertNoteActionAccess(access(), conversationId, NOTE_ACTION, { body: 'x' }, stored),
    ).resolves.toEqual(scope);
    await expect(
      assertNoteActionAccess(access({ mode: 'observe' }), conversationId, NOTE_ACTION, { body: 'x' }),
    ).rejects.toThrow('Current note action access required');
    await expect(
      assertNoteActionAccess(access({ clientIds: [] }), conversationId, NOTE_ACTION, {
        body: 'x',
        clientId: client,
      }),
    ).rejects.toThrow('Current note action access required');
    // A General context may name any client it can currently see (the established
    // native boundary rule); an invisible client is never allowed.
    await expect(
      assertNoteActionAccess(access({ scope: { ...scope, selectedClientId: null } }), conversationId, NOTE_ACTION, {
        body: 'x',
        clientId: client,
      }),
    ).resolves.toMatchObject({ selectedClientId: null });
    await expect(
      assertNoteActionAccess(access({ scope: { ...scope, selectedClientId: null }, clientIds: [] }), conversationId, NOTE_ACTION, {
        body: 'x',
        clientId: client,
      }),
    ).rejects.toThrow('Current note action access required');
    await expect(
      assertNoteActionAccess(access(), '55555555-5555-4555-8555-555555555555', NOTE_ACTION, { body: 'x' }),
    ).rejects.toThrow('Current note action access required');
    await expect(
      assertNoteActionAccess(access(), conversationId, NOTE_ACTION, { body: 'x' }, {
        [NOTE_ACTION_SCOPE_KEY]: { ...scope, contextRevision: 'd'.repeat(64) },
      }),
    ).rejects.toThrow('Note proposal authority changed');
    // A terminal observation may ignore a membership revision that the effect itself changed.
    await expect(
      assertNoteActionAccess(
        access({ mode: 'observe', scope: { ...scope, membershipRevision: 'd'.repeat(64) } }),
        conversationId,
        NOTE_ACTION,
        { body: 'x' },
        { [NOTE_ACTION_SCOPE_KEY]: scope },
        true,
        true,
      ),
    ).resolves.toEqual({ ...scope, membershipRevision: 'd'.repeat(64) });
  });
});

describe('a lost or partial note effect is never retryable', () => {
  const classified = (status: string) => ({ status, code: 'x', message: 'y' });
  it('turns the generic transient classification into UNKNOWN and keeps refusals definite', () => {
    expect(noteExecutionFailure(NOTE_ACTION, classified('failed_retryable'))).toMatchObject({
      status: 'outcome_unknown',
      code: 'note_outcome_unknown',
    });
    expect(noteExecutionFailure(NOTE_ACTION, classified('failed_terminal'))).toBeNull();
    expect(noteExecutionFailure(NOTE_ACTION, classified('outcome_unknown'))).toBeNull();
    expect(noteExecutionFailure('save_chat_attachments', classified('failed_retryable'))).toBeNull();
  });
});
