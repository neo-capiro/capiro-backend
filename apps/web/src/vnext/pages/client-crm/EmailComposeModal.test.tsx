import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailComposeModal } from './EmailComposeModal.js';

/**
 * The compose window reachable from a Timeline email row and the person
 * drawer's Mail button. Covers: sending posts the right payload to the new
 * single-recipient endpoint, "Rewrite with Meri" replaces the body on a
 * verified rewrite, and — the honesty case this whole feature is built
 * around — an UNVERIFIED rewrite shows the fallback note rather than
 * silently swapping in unverified text.
 */

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock, post: postMock }),
}));

function renderModal(overrides: Partial<Parameters<typeof EmailComposeModal>[0]> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const onSent = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <EmailComposeModal
        open
        onClose={onClose}
        to={{ email: 'patrick@example.com', name: 'Patrick Driscoll' }}
        clientId="client-1"
        clientName="Overland AI"
        {...overrides}
      />
    </QueryClientProvider>,
  );
  return { onClose, onSent };
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  getMock.mockResolvedValue({ data: { html: null, enabled: false } });
});

describe('EmailComposeModal', () => {
  it('shows the pre-filled recipient and disables Send until subject and body are present', async () => {
    renderModal();
    expect(screen.getByText('Patrick Driscoll <patrick@example.com>')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('sends the composed email to the single-recipient endpoint with the right payload', async () => {
    postMock.mockResolvedValue({
      data: { ok: true, threadId: 't1', messageId: 'm1', provider: 'microsoft_graph', senderEmail: 'jordan@capiro.ai' },
    });
    renderModal();

    fireEvent.change(screen.getByPlaceholderText('Subject'), { target: { value: 'Following up' } });
    const editor = screen.getAllByRole('textbox')[1]!; // [0] = Subject input, [1] = rich-text body editor
    fireEvent.input(editor, { target: { innerHTML: '<p>Great meeting you.</p>' } });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [url, body] = postMock.mock.calls[0]!;
    expect(url).toBe('/api/engagement/mail/send');
    expect(body.to).toEqual({ email: 'patrick@example.com', name: 'Patrick Driscoll' });
    expect(body.subject).toBe('Following up');
    expect(body.clientId).toBe('client-1');
  });

  it('replaces the body with a verified rewrite and offers Undo', async () => {
    postMock.mockResolvedValue({
      data: { bodyHtml: '<p>Polished version.</p>', verified: true, unsupportedNumbers: [], unsupportedNames: [], provider: 'anthropic' },
    });
    renderModal();

    const editor = screen.getAllByRole('textbox')[1]!; // [0] = Subject input, [1] = rich-text body editor
    fireEvent.input(editor, { target: { innerHTML: 'rough notes here' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rewrite with Meri' }));

    await waitFor(() => expect(screen.getByText('Undo rewrite')).toBeInTheDocument());
    expect(
      screen.queryByText(/couldn't be fully verified/),
    ).not.toBeInTheDocument();
  });

  it('pre-fills and reveals Cc when a caller passes defaultCc (a thread reply)', async () => {
    renderModal({
      defaultCc: [{ email: 'colleague@example.com', name: 'Alex Colleague' }],
    });
    expect(await screen.findByPlaceholderText('name@example.com, another@example.com')).toHaveValue(
      'colleague@example.com',
    );
  });

  it('shows the honest fallback note when a rewrite fails verification', async () => {
    postMock.mockResolvedValue({
      data: { bodyHtml: '<p>rough notes here</p>', verified: false, unsupportedNumbers: ['2000000'], unsupportedNames: [], provider: 'anthropic' },
    });
    renderModal();

    const editor = screen.getAllByRole('textbox')[1]!; // [0] = Subject input, [1] = rich-text body editor
    fireEvent.input(editor, { target: { innerHTML: 'rough notes here' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rewrite with Meri' }));

    await waitFor(() =>
      expect(screen.getByText(/couldn't be fully verified against your notes/)).toBeInTheDocument(),
    );
  });
});
