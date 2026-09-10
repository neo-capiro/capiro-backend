import { buildMeriActionPreview } from './meri-action-preview.js';

describe('client filing action preview', () => {
  it('names the requested PDF format while retaining the document governance preview', () => {
    expect(buildMeriActionPreview({ tool: 'create_word', input: { format: 'pdf', title: 'Brief' }, reason: 'Internal artifact' }))
      .toMatchObject({ label: 'Create PDF document', leavesFirm: false, reversible: true, fields: { title: 'Brief' } });
  });
  it('shows the target client and document count without exposing attachment bodies or IDs', () => {
    const preview = buildMeriActionPreview({
      tool: 'save_chat_attachments',
      input: {
        clientId: 'client-1',
        conversationId: 'conversation-1',
        attachmentIds: ['attachment-1', 'attachment-2', 'attachment-1'],
        body: 'Private document text',
      },
      clientName: 'Sightline Intelligence',
      riskTier: 'high',
      reason: 'Review the client and documents before saving.',
    });
    expect(preview).toMatchObject({
      label: 'Save documents to client',
      client: { id: 'client-1', name: 'Sightline Intelligence' },
      counts: { attachments: 2 },
      leavesFirm: false,
      reversible: true,
      riskTier: 'high',
    });
    expect(preview.fields).toEqual({});
    const serialized = JSON.stringify(preview);
    for (const hidden of ['Private document text', 'attachment-1', 'conversation-1']) {
      expect(serialized).not.toContain(hidden);
    }
  });

  it('keeps note filing targeted without including the full note body', () => {
    const preview = buildMeriActionPreview({
      tool: 'save_note',
      input: { clientId: 'client-1', title: 'Sen Wyden engagement', body: 'Private meeting notes' },
      clientName: 'Sightline Intelligence',
      reason: 'Save the supplied note under this client.',
    });
    expect(preview.client).toEqual({ id: 'client-1', name: 'Sightline Intelligence' });
    expect(preview.fields).toEqual({ title: 'Sen Wyden engagement' });
    expect(JSON.stringify(preview)).not.toContain('Private meeting notes');
  });
});
