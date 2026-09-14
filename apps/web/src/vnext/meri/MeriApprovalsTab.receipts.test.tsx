import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { PendingApproval } from '../../components/chat/useMeriChatController.js';
import { clientSaveReceipt } from '../../components/chat/meri-client-save-receipt.js';
import { resolveCrmRoute } from '../pages/client-crm/client-crm-routing.js';
import { describeApprovalOutcome } from '../../components/chat/meri-pending-approvals.js';

vi.mock('./meri-icons.js', () => ({ MeriIcon: () => null }));
vi.mock('./MeriActionConfirm.js', () => ({
  MeriActionConfirm: () => null,
  MeriBulkActionConfirm: () => null,
}));

import { MeriApprovalsTab } from './MeriApprovalsTab.js';
import { MeriApprovalNotice } from './MeriApprovalNotice.js';

const clientId = '13d1f9a3-3b37-41df-8a62-63bd450d6d73';
const location = `/clients?clientId=${clientId}&tab=documents`;
const savedLocation = `/clients?clientId=${clientId}&tab=files&attachmentId=document-a`;

function proposal(
  resultSummary: unknown,
  overrides: Partial<PendingApproval> = {},
): PendingApproval {
  return {
    proposalId: 'proposal-a',
    tool: 'save_note',
    status: 'succeeded',
    preview: { label: 'Save note', fields: {}, counts: {} },
    reason: 'Client note request',
    resultSummary,
    ...overrides,
  } as PendingApproval;
}

function show(value: PendingApproval) {
  render(
    <MeriApprovalsTab
      approvals={[value]}
      approvingProposalId={null}
      onApprove={vi.fn()}
      onApproveAll={vi.fn()}
      onDismiss={vi.fn()}
    />,
  );
}

function noteReceipt(overrides: Record<string, unknown> = {}) {
  return {
    tool: 'save_note',
    status: 'saved',
    clientId,
    clientName: 'Sightline Intelligence',
    note: { id: 'document-a', clientId },
    documentId: 'document-a',
    location,
    ...overrides,
  };
}

describe('confirmed client save receipts', () => {
  test('shows a client-specific saved note and canonical link only from the confirmed receipt', () => {
    const value = proposal(noteReceipt());
    show(value);
    expect(screen.getByText('NOTE SAVED · SAVE NOTE')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open saved note in Files' })).toHaveAttribute('href', savedLocation);
    expect(describeApprovalOutcome(value)).toBe('Note saved in Sightline Intelligence’s Files.');
  });

  test.each([
    null,
    { message: 'Saved successfully' },
    noteReceipt({ note: {} }),
    noteReceipt({ clientId: null }),
    noteReceipt({ note: { id: 'note-a', clientId: 'different-client' } }),
    noteReceipt({ note: { id: 'different-document', clientId } }),
  ])('does not turn an absent or inconsistent durable receipt into a saved claim', (receipt) => {
    const value = proposal(receipt);
    show(value);
    expect(screen.getByText('SAVE NOT CONFIRMED · SAVE NOTE')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(describeApprovalOutcome(value)).toContain('could not be confirmed');
    expect(screen.queryByText('Saved successfully')).not.toBeInTheDocument();
  });

  test.each(['proposed', 'approved', 'executing'] as const)(
    '%s is not a saved receipt',
    (status) => {
      show(proposal(noteReceipt(), { status }));
      expect(screen.queryByText('NOTE SAVED · SAVE NOTE')).not.toBeInTheDocument();
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
    },
  );

  test('a durable note awaiting scanning shows processing and the actual reason', () => {
    const message = 'The note is stored in client Documents; document scanning is still pending.';
    const value = proposal(noteReceipt({ status: 'pending', message }));
    show(value);
    expect(screen.getByText('NOTE PROCESSING · SAVE NOTE')).toBeInTheDocument();
    expect(
      screen.getByText(`Note processing in Sightline Intelligence’s Files. ${message}`),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open saved note in Files' })).not.toBeInTheDocument();
    expect(screen.queryByText(/SAVE NOT CONFIRMED/)).not.toBeInTheDocument();
    expect(describeApprovalOutcome(value)).toBe(
      `Note processing in Sightline Intelligence’s Files. ${message}`,
    );
  });

  test('a durable note rejected by readiness shows failure, reason, and retry without a saved claim', () => {
    const message = 'The note is unavailable under the document readiness policy.';
    const value = proposal(noteReceipt({ status: 'failed', message }), {
      status: 'failed_retryable',
    });
    show(value);
    expect(screen.getByText('NOTE FILING FAILED · SAVE NOTE')).toBeInTheDocument();
    expect(
      screen.getByText(`Note filing failed in Sightline Intelligence’s Files. ${message}`),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Open saved note in Files' })).not.toBeInTheDocument();
    expect(describeApprovalOutcome(value)).toBe(
      `Note filing failed in Sightline Intelligence’s Files. ${message}`,
    );
  });

  test.each(['pending', 'failed'])(
    'a %s note with a missing document receipt stays unconfirmed',
    (status) => {
      const value = proposal(noteReceipt({ status, documentId: undefined }));
      show(value);
      expect(screen.getByText('SAVE NOT CONFIRMED · SAVE NOTE')).toBeInTheDocument();
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
    },
  );

  test('a private saved note discloses its exclusion from shared knowledge', () => {
    const message =
      'Private note saved in client Documents for your access. It is excluded from shared client knowledge.';
    const value = proposal(noteReceipt({ message }));
    show(value);
    expect(screen.getByText(/It is excluded from shared client knowledge/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open saved note in Files' })).toHaveAttribute('href', savedLocation);
    expect(describeApprovalOutcome(value)).toContain(message);
  });

  test.each([
    'https://example.com/steal',
    '//example.com/steal',
    'javascript:alert(1)',
    '/clients?clientId=another-client&tab=documents',
    `/clients?clientId=${clientId}&tab=intelligence`,
    `/clients?clientId=${clientId}&tab=files&attachmentId=different-document`,
    `/clients?clientId=${clientId}&clientId=another-client&tab=files`,
    `/clients?clientId=${clientId}&tab=files&tab=documents`,
    `${savedLocation}&attachmentId=different-document`,
    `${savedLocation}#other-document`,
  ])('never opens a noncanonical or wrong-client receipt URL: %s', (href) => {
    show(proposal(noteReceipt({ location: href })));
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  test.each([location, savedLocation])('opens the exact filed document from current and legacy receipts: %s', (href) => {
    const value = proposal(noteReceipt({ location: href }));
    const receipt = clientSaveReceipt(value);
    expect(receipt?.location).toBe(savedLocation);
    const params = new URL(receipt!.location!, 'https://capiro.invalid').searchParams;
    expect(resolveCrmRoute(params)).toEqual({ tab: 'files', view: null, didNormalize: false });
    expect(params.get('clientId')).toBe(clientId);
    expect(params.get('attachmentId')).toBe('document-a');
  });

  test('the transcript exposes exact saved files while preserving pending and failed results', () => {
    const value = proposal({
      tool: 'save_chat_attachments', status: 'partial', clientId, clientName: 'Sightline Intelligence',
      files: [
        { attachmentId: 'chat-a', documentId: 'document-a', fileName: 'Strat Discussion.pptx', status: 'saved', location: savedLocation },
        { attachmentId: 'chat-b', documentId: 'document-b', fileName: 'scan.pdf', status: 'pending', location },
        { attachmentId: 'chat-c', fileName: 'corrupt.pdf', status: 'failed', location, reason: 'Unreadable.' },
      ],
    }, { tool: 'save_chat_attachments', status: 'failed_retryable' });
    render(<MeriApprovalNotice approvals={[value]} onReview={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'Open in Files: Strat Discussion.pptx' })).toHaveAttribute('href', savedLocation);
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('1 saved, 1 processing, 1 failed in Sightline Intelligence’s Files');
    expect(screen.getByRole('button', { name: 'Review it' })).toBeInTheDocument();
  });

  test.each(['proposed', 'executing', 'outcome_unknown'] as const)('the transcript never exposes a saved link for %s', (status) => {
    render(<MeriApprovalNotice approvals={[proposal(noteReceipt({ location: savedLocation }), { status })]} onReview={vi.fn()} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  test('does not duplicate the same saved file across repeated action receipts', () => {
    const value = proposal(noteReceipt({ location: savedLocation }));
    render(<MeriApprovalNotice approvals={[value, { ...value, proposalId: 'proposal-b' }]} onReview={vi.fn()} />);
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  test('reports processing separately from saved even when the action execution succeeded', () => {
    const value = proposal(
      {
        tool: 'save_chat_attachments',
        status: 'pending',
        clientId,
        clientName: 'Sightline Intelligence',
        files: [
          {
            attachmentId: 'attachment-a',
            fileName: 'scanned-letter.pdf',
            status: 'pending',
            documentId: 'document-a',
            location,
          },
        ],
      },
      {
        tool: 'save_chat_attachments',
        preview: { label: 'Save attached documents' } as PendingApproval['preview'],
      },
    );
    show(value);
    expect(screen.getByText('PROCESSING FILES · SAVE ATTACHED DOCUMENTS')).toBeInTheDocument();
    expect(screen.getByText('scanned-letter.pdf — Processing')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(describeApprovalOutcome(value)).toBe(
      '0 saved, 1 processing, 0 failed in Sightline Intelligence’s Files.',
    );
  });

  test('partial batches show each result, exact counts, and a retry with only confirmed saved links', () => {
    const value = proposal(
      {
        tool: 'save_chat_attachments',
        status: 'partial',
        clientId,
        clientName: 'Sightline Intelligence',
        files: [
          {
            attachmentId: 'attachment-a',
            fileName: 'letter.docx',
            status: 'saved',
            documentId: 'document-a',
            location,
          },
          {
            attachmentId: 'attachment-b',
            fileName: 'scan.pdf',
            status: 'pending',
            documentId: 'document-b',
            location,
          },
          {
            attachmentId: 'attachment-c',
            fileName: 'corrupt.pdf',
            status: 'failed',
            reason: 'Unreadable file. Upload a readable copy.',
          },
        ],
      },
      { tool: 'save_chat_attachments', status: 'failed_retryable' },
    );
    show(value);
    expect(screen.getByText('PARTIALLY SAVED · SAVE NOTE')).toBeInTheDocument();
    expect(
      screen.getByText(/1 saved, 1 processing, 1 failed in Sightline Intelligence’s Files/),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in Files: letter.docx' })).toHaveAttribute(
      'href',
      savedLocation,
    );
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByText('Unreadable file. Upload a readable copy.')).toBeInTheDocument();
  });

  test('transcript notice uses the same receipt outcome rather than generic execution success', () => {
    const value = proposal(null);
    render(<MeriApprovalNotice approvals={[value]} onReview={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('could not be confirmed');
    expect(screen.queryByText(/completed successfully/)).not.toBeInTheDocument();
  });

  test('a saved-plus-pending API partial receipt preserves the saved document and processing count', () => {
    show(
      proposal(
        {
          tool: 'save_chat_attachments',
          status: 'partial',
          clientId,
          files: [
            {
              attachmentId: 'attachment-a',
              fileName: 'letter.docx',
              status: 'saved',
              documentId: 'document-a',
              location,
            },
            {
              attachmentId: 'attachment-b',
              fileName: 'scan.pdf',
              status: 'pending',
              documentId: 'document-b',
              location,
            },
          ],
        },
        { tool: 'save_chat_attachments', status: 'failed_retryable' },
      ),
    );
    expect(screen.getByText(/PROCESSING FILES/)).toBeInTheDocument();
    expect(screen.getByText('1 saved, 1 processing, 0 failed.')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Open in Files: letter.docx' }),
    ).toBeInTheDocument();
  });

  test('an unavailable attachment with no filename does not hide successfully saved siblings', () => {
    show(
      proposal(
        {
          tool: 'save_chat_attachments',
          status: 'partial',
          clientId,
          files: [
            {
              attachmentId: 'attachment-a',
              fileName: 'letter.docx',
              status: 'saved',
              documentId: 'document-a',
              location,
            },
            {
              attachmentId: 'attachment-b',
              fileName: null,
              status: 'failed',
              reason: 'Attachment unavailable.',
            },
          ],
        },
        { tool: 'save_chat_attachments', status: 'failed_retryable' },
      ),
    );
    expect(screen.getByText('Unavailable attachment — Failed')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Open in Files: letter.docx' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 saved, 0 processing, 1 failed/)).toBeInTheDocument();
  });

  test('retains every receipt in a ten-file batch', () => {
    const files = Array.from({ length: 10 }, (_, index) => ({
      attachmentId: `attachment-${index}`,
      fileName: `document-${index}.txt`,
      status: 'saved',
      documentId: `document-${index}`,
      location,
    }));
    show(
      proposal(
        { tool: 'save_chat_attachments', status: 'saved', clientId, files },
        { tool: 'save_chat_attachments' },
      ),
    );
    expect(screen.getAllByRole('link')).toHaveLength(10);
    expect(screen.getByText('10 saved, 0 processing, 0 failed.')).toBeInTheDocument();
  });

  test.each([clientId, null])(
    'preserves confirmed existing meeting/personal note receipts with scope %s',
    (noteClientId) => {
      const value = proposal({
        tool: 'save_note',
        status: 'saved',
        note: { id: 'existing-note', clientId: noteClientId },
      });
      show(value);
      expect(screen.getByText('NOTE SAVED · SAVE NOTE')).toBeInTheDocument();
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      expect(describeApprovalOutcome(value)).toBe('Note saved.');
    },
  );
});
