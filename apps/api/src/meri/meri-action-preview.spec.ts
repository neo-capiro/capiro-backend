import { buildMeriActionPreview } from './meri-action-preview.js';

describe('client filing action preview', () => {
  it('identifies the exact snapshot, design, client, branding and fixed expiry before publishing a share link', () => {
    const preview = buildMeriActionPreview({
      tool: 'publish_research_portfolio_share_link',
      input: {
        snapshotId: 'snapshot-a',
        designId: 'design-a',
        clientId: 'client-a',
        branding: false,
        operationKey: 'internal-operation',
        pin: 'sensitive-pin',
        sharePath: '/share/research/private',
      },
      clientName: 'Selected client',
      reason: 'Confirm the proposed publication.',
    });
    expect(preview).toMatchObject({
      label: 'Publish client share link',
      leavesFirm: false,
      client: { id: 'client-a', name: 'Selected client' },
      fields: {
        snapshotId: 'snapshot-a',
        designId: 'design-a',
        branding: false,
        expiresAfterHours: 168,
        delivery: 'You copy the link and share it yourself. Nothing is sent.',
      },
    });
    for (const hidden of ['internal-operation', 'sensitive-pin', '/share/research/private'])
      expect(JSON.stringify(preview)).not.toContain(hidden);
  });

  it('identifies the exact link and immediate effect before revocation', () => {
    const preview = buildMeriActionPreview({
      tool: 'revoke_research_portfolio_share_link',
      input: { linkId: 'link-a', conversationId: 'private-conversation' },
      reason: 'Confirm revocation.',
    });
    expect(preview).toMatchObject({
      label: 'Revoke client share link',
      fields: {
        linkId: 'link-a',
        effect: 'This link will stop working on the next request.',
      },
    });
    expect(JSON.stringify(preview)).not.toContain('private-conversation');
  });
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
