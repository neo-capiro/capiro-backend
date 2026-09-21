import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <EmailComposeModal
        open
        onClose={onClose}
        to={[{ email: 'patrick@example.com', name: 'Patrick Driscoll' }]}
        clientId="client-1"
        clientName="Overland AI"
        {...overrides}
      />
    </QueryClientProvider>,
  );
  return { onClose, onSent, container };
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  getMock.mockResolvedValue({ data: { html: null, enabled: false } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('EmailComposeModal', () => {
  // The body editor is a contentEditable[role=textbox]; the Subject field and
  // the roster Combobox's search field are also role=textbox, so index-based
  // lookup shifts depending on whether the picker is open. Match on the
  // attribute only the body editor has.
  const bodyEditor = () =>
    screen.getAllByRole('textbox').find((el) => el.hasAttribute('data-placeholder'))!;

  it('shows the pre-filled recipient and disables Send until subject and body are present', async () => {
    renderModal();
    expect(screen.getByText('Patrick Driscoll <patrick@example.com>')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('sends the composed email to the single-recipient endpoint with the right payload', async () => {
    postMock.mockResolvedValue({
      data: {
        ok: true,
        threadId: 't1',
        messageId: 'm1',
        provider: 'microsoft_graph',
        senderEmail: 'jordan@capiro.ai',
      },
    });
    renderModal();

    fireEvent.change(screen.getByPlaceholderText('Subject'), { target: { value: 'Following up' } });
    const editor = bodyEditor();
    fireEvent.input(editor, { target: { innerHTML: '<p>Great meeting you.</p>' } });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [url, body] = postMock.mock.calls[0]!;
    expect(url).toBe('/api/engagement/mail/send');
    expect(body.to).toEqual([{ email: 'patrick@example.com', name: 'Patrick Driscoll' }]);
    expect(body.subject).toBe('Following up');
    expect(body.clientId).toBe('client-1');
  });

  it('adds a second recipient from the client org roster and includes both on send', async () => {
    postMock.mockResolvedValue({
      data: {
        ok: true,
        threadId: 't1',
        messageId: 'm1',
        provider: 'microsoft_graph',
        senderEmail: 'jordan@capiro.ai',
      },
    });
    renderModal({
      orgContacts: [
        { id: 'person-2', name: 'Adam Matherly', email: 'adam@example.com' },
        { id: 'person-3', name: 'Sam Rivera', email: 'sam@example.com' },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: '+ Add recipient' }));
    fireEvent.click(screen.getByRole('button', { name: "Browse this client's contacts" }));
    fireEvent.click(await screen.findByText('Adam Matherly'));

    expect(screen.getByText('Adam Matherly <adam@example.com>')).toBeInTheDocument();
    // Already-added contacts drop out of the picker so they can't be added twice.
    fireEvent.click(screen.getByRole('button', { name: "Browse this client's contacts" }));
    expect(screen.queryByText('Adam Matherly')).not.toBeInTheDocument();
    expect(screen.getByText('Sam Rivera')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Subject'), { target: { value: 'Team update' } });
    const editor = bodyEditor();
    fireEvent.input(editor, { target: { innerHTML: '<p>Sharing an update.</p>' } });

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [, body] = postMock.mock.calls[0]!;
    expect(body.to).toEqual([
      { email: 'patrick@example.com', name: 'Patrick Driscoll' },
      { email: 'adam@example.com', name: 'Adam Matherly' },
    ]);
    expect(body.personIds).toEqual(['person-2']);
  });

  it('allows replacing every recipient and disables sending with an empty To list', async () => {
    renderModal({
      orgContacts: [{ id: 'person-2', name: 'Adam Matherly', email: 'adam@example.com' }],
    });

    fireEvent.click(screen.getByRole('button', { name: '+ Add recipient' }));
    fireEvent.click(screen.getByRole('button', { name: "Browse this client's contacts" }));
    fireEvent.click(await screen.findByText('Adam Matherly'));

    fireEvent.click(screen.getByRole('button', { name: 'Remove Adam Matherly' }));
    expect(screen.queryByText('Adam Matherly <adam@example.com>')).not.toBeInTheDocument();
    expect(screen.getByText('Patrick Driscoll <patrick@example.com>')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Patrick Driscoll' }));
    expect(screen.queryByText('Patrick Driscoll <patrick@example.com>')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('preserves manual email entry when no org roster was passed in (the Timeline reply flow)', async () => {
    renderModal({ orgContacts: undefined });
    fireEvent.click(screen.getByRole('button', { name: '+ Add recipient' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Email address' }), {
      target: { value: 'manual@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('manual@example.com')).toBeInTheDocument();
  });

  it('finds teammates by name, shows the directory before typing, and deduplicates by email', async () => {
    renderModal({
      to: [],
      recipientDirectory: 'team',
      orgContacts: [
        { id: 'u-1', name: 'Ryan Anderson', email: 'ryan@capiro.ai' },
        { id: 'u-duplicate', name: 'Ryan Duplicate', email: 'RYAN@capiro.ai' },
        { id: 'u-2', name: 'Maya Chen', email: 'maya@capiro.ai' },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: '+ Add recipient' }));
    fireEvent.click(screen.getByRole('button', { name: 'Browse your Capiro team' }));
    expect(await screen.findByText('Ryan Anderson')).toBeInTheDocument();
    expect(screen.getByText('Maya Chen')).toBeInTheDocument();
    expect(screen.queryByText('Ryan Duplicate')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search by name or email…' }), {
      target: { value: 'maya' },
    });
    expect(screen.getByText('Maya Chen')).toBeInTheDocument();
    expect(screen.queryByText('Ryan Anderson')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Maya Chen'));
    expect(screen.getByText('Maya Chen <maya@capiro.ai>')).toBeInTheDocument();
  });

  it('rejects invalid or duplicate manual addresses without widening recipients', async () => {
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: '+ Add recipient' }));
    const input = screen.getByRole('textbox', { name: 'Email address' });
    fireEvent.change(input, { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a valid email address.');
    fireEvent.change(input, { target: { value: 'PATRICK@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('alert')).toHaveTextContent('already in To');
    expect(screen.getAllByText(/patrick@example.com/i)).toHaveLength(1);
  });

  it('preserves the draft while a required PDF finishes and blocks send until it is attached', async () => {
    const props = {
      open: true,
      onClose: vi.fn(),
      to: [{ email: 'ryan@capiro.ai', name: 'Ryan Anderson' }],
      defaultSubject: 'Meeting prep',
      requiredAttachmentState: { status: 'loading' as const, label: 'Meeting prep PDF' },
      senderMailboxState: { status: 'ready' as const, label: 'neo@capiro.ai' },
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const rendered = render(
      <QueryClientProvider client={queryClient}>
        <EmailComposeModal {...props} />
      </QueryClientProvider>,
    );
    fireEvent.input(bodyEditor(), { target: { innerHTML: '<p>Please review.</p>' } });
    expect(screen.getByText(/You can keep drafting while it loads/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    rendered.rerender(
      <QueryClientProvider client={queryClient}>
        <EmailComposeModal
          {...props}
          initialAttachments={[{ id: 'att-prep', fileName: 'Meeting prep.pdf' }]}
          requiredAttachmentState={{ status: 'ready', label: 'Meeting prep.pdf' }}
        />
      </QueryClientProvider>,
    );
    expect(bodyEditor()).toHaveTextContent('Please review.');
    expect(screen.getByText('Meeting prep.pdf')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled());
  });

  it('shows a retryable PDF error inline and preserves the draft', async () => {
    const retryPdf = vi.fn();
    renderModal({
      requiredAttachmentState: {
        status: 'error',
        label: 'Meeting prep PDF',
        error: 'Could not prepare the meeting prep PDF.',
        onRetry: retryPdf,
      },
      senderMailboxState: { status: 'ready', label: 'neo@capiro.ai' },
    });
    fireEvent.change(screen.getByPlaceholderText('Subject'), { target: { value: 'Prep' } });
    fireEvent.input(bodyEditor(), { target: { innerHTML: '<p>Draft stays.</p>' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retryPdf).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(bodyEditor()).toHaveTextContent('Draft stays.');
  });

  it('does not close when the resolved send response is not confirmed', async () => {
    postMock.mockResolvedValue({ data: { ok: false } });
    const { onClose } = renderModal();
    fireEvent.change(screen.getByPlaceholderText('Subject'), { target: { value: 'Following up' } });
    fireEvent.input(bodyEditor(), { target: { innerHTML: '<p>Please review.</p>' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not send this email');
    expect(onClose).not.toHaveBeenCalled();
    expect(bodyEditor()).toHaveTextContent('Please review.');
  });

  it('replaces the body with a verified rewrite and offers Undo', async () => {
    postMock.mockResolvedValue({
      data: {
        bodyHtml: '<p>Polished version.</p>',
        verified: true,
        unsupportedNumbers: [],
        unsupportedNames: [],
        provider: 'anthropic',
      },
    });
    renderModal();

    const editor = bodyEditor();
    fireEvent.input(editor, { target: { innerHTML: 'rough notes here' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rewrite with Meri' }));

    await waitFor(() => expect(screen.getByText('Undo rewrite')).toBeInTheDocument());
    expect(screen.queryByText(/couldn't be fully verified/)).not.toBeInTheDocument();
  });

  it('uploads an attached file via the existing attachments upload-url/confirm flow and includes it on send', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    postMock.mockImplementation((url: string) => {
      if (url === '/api/engagement/attachments/upload-url') {
        return Promise.resolve({
          data: {
            url: 'https://s3.example.com/upload',
            fields: { key: 'tenants/x' },
            s3Key: 'tenants/x/file.pdf',
          },
        });
      }
      if (url === '/api/engagement/attachments/confirm') {
        return Promise.resolve({ data: { id: 'att-1', fileName: 'brief.pdf' } });
      }
      if (url === '/api/engagement/mail/send') {
        return Promise.resolve({
          data: {
            ok: true,
            threadId: 't1',
            messageId: 'm1',
            provider: 'microsoft_graph',
            senderEmail: 'jordan@capiro.ai',
          },
        });
      }
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });

    const { container } = renderModal();

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['%PDF-1.4'], 'brief.pdf', { type: 'application/pdf' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => expect(screen.getByText('brief.pdf')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      'https://s3.example.com/upload',
      expect.objectContaining({ method: 'POST' }),
    );

    fireEvent.change(screen.getByPlaceholderText('Subject'), { target: { value: 'Following up' } });
    const editor = bodyEditor();
    fireEvent.input(editor, { target: { innerHTML: '<p>Please see attached.</p>' } });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith(
        '/api/engagement/mail/send',
        expect.objectContaining({ attachmentIds: ['att-1'] }),
      ),
    );

    vi.unstubAllGlobals();
  });

  it('removes an attached file when its remove button is clicked', async () => {
    postMock.mockImplementation((url: string) => {
      if (url === '/api/engagement/attachments/upload-url') {
        return Promise.resolve({
          data: {
            url: 'https://s3.example.com/upload',
            fields: { key: 'tenants/x' },
            s3Key: 'tenants/x/file.pdf',
          },
        });
      }
      if (url === '/api/engagement/attachments/confirm') {
        return Promise.resolve({ data: { id: 'att-1', fileName: 'brief.pdf' } });
      }
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true })),
    );

    const { container } = renderModal();
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: { files: [new File(['x'], 'brief.pdf', { type: 'application/pdf' })] },
    });

    await waitFor(() => expect(screen.getByText('brief.pdf')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Remove brief.pdf' }));
    expect(screen.queryByText('brief.pdf')).not.toBeInTheDocument();

    vi.unstubAllGlobals();
  });

  it('pre-fills and reveals Cc when a caller passes defaultCc (a thread reply)', async () => {
    renderModal({
      defaultCc: [{ email: 'colleague@example.com', name: 'Alex Colleague' }],
    });
    expect(await screen.findByPlaceholderText('name@example.com, another@example.com')).toHaveValue(
      'colleague@example.com',
    );
    // A widened audience is stated in words, not left as a populated text box
    // the user has to notice on their own.
    expect(
      screen.getByText('Reply all — 1 person is copied on this reply: colleague@example.com'),
    ).toBeInTheDocument();
  });

  it('says nothing about copies when the caller passed no defaultCc', async () => {
    renderModal();
    expect(screen.queryByText(/copied on this reply/)).not.toBeInTheDocument();
  });

  it("warns inline when the caller could not confirm the sender's own address", async () => {
    renderModal({ identityUnconfirmed: true });
    // Inline, not a toast: renderModal mounts no CapiroToastProvider, and
    // neither do all of this modal's real callers, so useCapiroToast() falls
    // back to a no-op and a toast would show the user nothing at all.
    expect(screen.getByText(/nobody was excluded from these recipients/i)).toBeInTheDocument();
    // A warning, not a block — the compose window still works.
    expect(screen.getByPlaceholderText('Subject')).toBeInTheDocument();
  });

  it('records the primary addressee in personIds, not just the ones added from the picker', async () => {
    postMock.mockResolvedValue({
      data: {
        ok: true,
        threadId: 't1',
        messageId: 'm1',
        provider: 'microsoft_graph',
        senderEmail: 'jordan@capiro.ai',
      },
    });
    // The roster shape ClientPersonDrawer now passes: the whole org tree,
    // INCLUDING whoever the drawer was opened for.
    renderModal({
      orgContacts: [
        { id: 'p-1', name: 'Patrick Driscoll', email: 'patrick@example.com' },
        { id: 'p-2', name: 'Adam Matherly', email: 'adam@example.com' },
      ],
    });

    fireEvent.change(screen.getByPlaceholderText('Subject'), { target: { value: 'Following up' } });
    fireEvent.input(bodyEditor(), { target: { innerHTML: '<p>Great meeting you.</p>' } });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    const [, body] = postMock.mock.calls[0]!;
    // The drawer used to self-exclude the addressee from the roster, so an
    // ordinary single-recipient send persisted `personIds: []`.
    expect(body.personIds).toEqual(['p-1']);
  });

  it('keeps the primary addressee out of the picker even though the roster now holds them', async () => {
    renderModal({
      orgContacts: [
        { id: 'p-1', name: 'Patrick Driscoll', email: 'patrick@example.com' },
        { id: 'p-2', name: 'Adam Matherly', email: 'adam@example.com' },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: '+ Add recipient' }));
    fireEvent.click(screen.getByRole('button', { name: "Browse this client's contacts" }));

    // The To chip reads "Patrick Driscoll <patrick@example.com>", so an exact
    // match on the bare name can only come from the dropdown.
    expect(await screen.findByText('Adam Matherly')).toBeInTheDocument();
    expect(screen.queryByText('Patrick Driscoll')).not.toBeInTheDocument();
  });

  it('keeps manual email entry available when the addressee is the only contact on the roster', async () => {
    renderModal({
      orgContacts: [{ id: 'p-1', name: 'Patrick Driscoll', email: 'patrick@example.com' }],
    });
    // Otherwise the button appears and can only ever say "everyone is already
    // added" — the roster is no longer the right thing to gate on.
    expect(screen.getByRole('button', { name: '+ Add recipient' })).toBeInTheDocument();
  });

  it('offers only the attachment types the server allowlist accepts', async () => {
    const { container } = renderModal();
    expect(container.querySelector('input[type="file"]')).toHaveAttribute(
      'accept',
      '.pdf,.doc,.docx,.txt,.ppt,.pptx,.xls,.xlsx,.csv,image/*',
    );
  });

  it('refuses an over-3MB attachment before uploading it, and says why', async () => {
    const { container } = renderModal();
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['%PDF-1.4'], 'huge.pdf', { type: 'application/pdf' });
    // File.size is read-only, so the real byte length has to be overridden.
    Object.defineProperty(file, 'size', { value: 4 * 1024 * 1024 });
    fireEvent.change(fileInput, { target: { files: [file] } });

    // The server's send-time gate (loadGraphAttachments) would have let this
    // upload and chip fine, then made the draft unsendable with no way back
    // except removing the chip.
    expect(await screen.findByText(/must be 3MB or smaller/)).toBeInTheDocument();
    expect(screen.queryByText('huge.pdf')).not.toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it('uploads a file the browser reported no type for under its real content type', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true })),
    );
    postMock.mockImplementation((url: string) => {
      if (url === '/api/engagement/attachments/upload-url') {
        return Promise.resolve({
          data: {
            url: 'https://s3.example.com/upload',
            fields: { key: 'tenants/x' },
            s3Key: 'tenants/x/roster.csv',
          },
        });
      }
      if (url === '/api/engagement/attachments/confirm') {
        return Promise.resolve({ data: { id: 'att-2', fileName: 'roster.csv' } });
      }
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });

    const { container } = renderModal();
    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, {
      // Chrome and Safari both report '' for .csv on some platforms, and the
      // old 'application/octet-stream' fallback is the one content type
      // isAllowedAttachmentContentType explicitly rejects — so this 400'd.
      target: { files: [new File(['a,b\n1,2'], 'roster.csv', { type: '' })] },
    });

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith(
        '/api/engagement/attachments/upload-url',
        expect.objectContaining({ contentType: 'text/csv' }),
      ),
    );
    await waitFor(() => expect(screen.getByText('roster.csv')).toBeInTheDocument());

    vi.unstubAllGlobals();
  });

  it('shows the honest fallback note when a rewrite fails verification', async () => {
    postMock.mockResolvedValue({
      data: {
        bodyHtml: '<p>rough notes here</p>',
        verified: false,
        unsupportedNumbers: ['2000000'],
        unsupportedNames: [],
        provider: 'anthropic',
      },
    });
    renderModal();

    const editor = bodyEditor();
    fireEvent.input(editor, { target: { innerHTML: 'rough notes here' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rewrite with Meri' }));

    await waitFor(() =>
      expect(screen.getByText(/couldn't be fully verified against your notes/)).toBeInTheDocument(),
    );
  });
});
