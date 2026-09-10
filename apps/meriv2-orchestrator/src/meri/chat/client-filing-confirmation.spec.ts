import {
  enforceClientFilingConfirmation,
  MERI_CLIENT_FILING_INSTRUCTIONS,
} from './client-filing-confirmation.js';

describe('client filing confirmations', () => {
  const request = 'For Sightline, how do I log the Sen Wyden engagement notes under that company?';
  test.each([
    'I have saved your notes under Sightline.',
    'Your notes have been logged successfully.',
    'Saved your notes.',
    'Done.',
    '✅ Saved your notes under Sightline.',
    '- Your notes have been saved under Sightline.',
    '1. **Saved your notes.**',
    '### ✅ Done.',
    'Result:\n- Your notes have been saved under Sightline.',
  ])('does not release an unsupported completion: %s', (reply) => {
    expect(enforceClientFilingConfirmation({ request, reply, entries: [] })).toContain(
      'I have not saved',
    );
  });
  test('keeps instructions, negation, quotes and unrelated answers intact', () => {
    for (const reply of [
      'Please provide the notes you want to save.',
      'I have not saved your notes yet.',
      '> I saved your notes.',
      'You can save notes from the Add menu.',
    ]) {
      expect(enforceClientFilingConfirmation({ request, reply, entries: [] })).toBe(reply);
    }
    expect(
      enforceClientFilingConfirmation({
        request: 'Reply exactly READY.',
        reply: 'READY',
        entries: [],
      }),
    ).toBe('READY');
  });
  test('a pending proposal does not authorize a saved claim', () => {
    const reply = enforceClientFilingConfirmation({
      request,
      reply: 'Your notes were saved.',
      entries: [{ tool: 'save_note', result: { pendingApproval: true, proposalId: 'p1' } }],
    });
    expect(reply).toContain('awaits your approval');
    expect(reply).toContain('has not run');
  });
  test('returns the actual client and durable receipt, preserving other paragraphs', () => {
    const reply = enforceClientFilingConfirmation({
      request,
      reply: 'I saved your notes under the wrong client.\n\nDraft text to keep.',
      entries: [
        {
          tool: 'save_note',
          result: {
            status: 'saved',
            note: { id: 'note-1' },
            clientName: 'Sightline',
            location: '/clients?clientId=c1&tab=documents',
            indexingStatus: 'pending',
          },
        },
      ],
    });
    expect(reply).toContain('saved under Sightline');
    expect(reply).toContain('Open saved note');
    expect(reply).toContain('indexing is still pending');
    expect(reply).toContain('Draft text to keep.');
    expect(reply).not.toContain('wrong client');
  });
  test('does not count missing IDs or processing files as saved', () => {
    const reply = enforceClientFilingConfirmation({
      request: 'File these documents under Sightline.',
      reply: 'I saved all your files.',
      entries: [
        {
          tool: 'save_chat_attachments',
          result: {
            error: true,
            resultSummary: {
              status: 'partial',
              clientName: 'Sightline',
              files: [
                { status: 'saved', documentId: 'd1' },
                { status: 'pending', documentId: 'd2' },
                { status: 'failed' },
                { status: 'saved' },
              ],
            },
          },
        },
      ],
    });
    expect(reply).toContain('1 saved, 1 still processing, 2 failed');
    expect(reply).not.toContain('all your files');
  });
  test('tool names and an ok flag alone do not prove a note save', () => {
    expect(
      enforceClientFilingConfirmation({
        request,
        reply: 'I saved your notes.',
        entries: [{ tool: 'save_note', result: { ok: true } }],
      }),
    ).toContain('did not return a confirmed record');
  });
  test.each(['pending', 'failed'])(
    'keeps a stored but %s note out of the saved state',
    (status) => {
      const reply = enforceClientFilingConfirmation({
        request,
        reply: '✅ Saved your notes.',
        entries: [
          { tool: 'save_note', result: { status, documentId: 'd1', clientName: 'Sightline' } },
        ],
      });
      expect(reply).toContain(status === 'pending' ? 'scanning is still pending' : 'unavailable');
      expect(reply).not.toMatch(/\bsaved\b/i);
    },
  );
  test('instructs the provider to collect missing notes and use actual attachments', () => {
    expect(MERI_CLIENT_FILING_INSTRUCTIONS).toContain('does not supply note content');
    expect(MERI_CLIENT_FILING_INSTRUCTIONS).toContain(
      'do not ask the user to paste a file whose content is already available',
    );
    expect(MERI_CLIENT_FILING_INSTRUCTIONS).toContain('save_chat_attachments');
  });
});
