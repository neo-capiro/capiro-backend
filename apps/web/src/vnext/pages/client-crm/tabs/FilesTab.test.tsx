import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientCrmFilesProto } from './FilesTab.js';
import type { Client, ClientAttachment } from '../../../../pages/clients/clientTypes.js';

const getMock = vi.hoisted(() => vi.fn());
const postMock = vi.hoisted(() => vi.fn());
const patchMock = vi.hoisted(() => vi.fn());
const deleteMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/use-api.js', () => ({
  useApi: () => ({ get: getMock, post: postMock, patch: patchMock, delete: deleteMock }),
}));

const client: Client = {
  id: 'client-1',
  name: 'Overland AI',
  website: 'overland.ai',
  description: null,
  productDescription: null,
  primaryContactName: null,
  primaryContactEmail: null,
  primaryContactPhone: null,
  logoS3Key: null,
  logoContentType: null,
  logoUploadedAt: null,
  intakeData: null,
  status: 'active',
  createdAt: '2026-01-15T00:00:00.000Z',
  updatedAt: '2026-01-15T00:00:00.000Z',
};

function attachment(overrides: Partial<ClientAttachment> = {}): ClientAttachment {
  return {
    id: 'att-1',
    clientId: client.id,
    meetingId: null,
    mailMessageId: null,
    fileName: 'Budget Memo.pdf',
    contentType: 'application/pdf',
    byteSize: 1024,
    source: 'manual',
    createdAt: '2026-08-01T00:00:00.000Z',
    downloadUrl: 'https://files.example.com/att-1',
    indexedAt: null,
    uploadedByUserId: 'user-1',
    uploadedByName: 'Neo Martinez',
    // Matches the tab's default folder view ('fy27' → "FY27 Strategy") so the
    // row is visible without first navigating the (unrelated) folder tree.
    folder: 'FY27 Strategy',
    ...overrides,
  };
}

function renderFiles() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ClientCrmFilesProto client={client} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  patchMock.mockReset();
  deleteMock.mockReset();
});

describe('ClientCrmFilesProto', () => {
  it('shows a real empty state instead of the design fixture when the client has no files', async () => {
    getMock.mockResolvedValue({ data: [] });
    renderFiles();

    await waitFor(() => expect(screen.getByText('No files uploaded yet.')).toBeInTheDocument());
    // The FILES fixture's designed rows must not leak through as if real.
    expect(screen.queryByText('FY27 Congressional Strategy Memo')).not.toBeInTheDocument();
  });

  it('opens the attachment download URL when a real row is clicked', async () => {
    getMock.mockResolvedValue({ data: [attachment()] });
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderFiles();

    const nameButton = await screen.findByText('Budget Memo');
    fireEvent.click(nameButton);

    expect(openSpy).toHaveBeenCalledWith('https://files.example.com/att-1', '_blank', 'noopener,noreferrer');
    openSpy.mockRestore();
  });

  it('deletes a file via the row menu and the confirm dialog', async () => {
    getMock.mockResolvedValue({ data: [attachment()] });
    deleteMock.mockResolvedValue({ data: { id: 'att-1' } });
    renderFiles();

    await screen.findByText('Budget Memo');
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Budget Memo' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));

    await screen.findByText('Delete file');
    // The row menu is closed by this point, so "Delete" unambiguously refers
    // to the confirm dialog's button (the menu item's role is "menuitem").
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(deleteMock).toHaveBeenCalledWith('/api/engagement/attachments/att-1'),
    );
  });

  it('moves selected files to a folder via the selection bar', async () => {
    getMock.mockResolvedValue({ data: [attachment()] });
    patchMock.mockResolvedValue({ data: { id: 'att-1' } });
    renderFiles();

    await screen.findByText('Budget Memo');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Budget Memo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move to folder' }));

    const confirm = await screen.findByRole('button', { name: /^Move 1 item$/ });
    fireEvent.click(confirm);

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(patchMock.mock.calls[0]?.[0]).toBe('/api/clients/client-1/files/att-1/folder');
  });

  it('uploads a file through the toolbar Upload button', async () => {
    getMock.mockResolvedValue({ data: [] });
    postMock.mockImplementation((url: string) => {
      if (url === '/api/engagement/attachments/upload-url') {
        return Promise.resolve({ data: { url: 'https://s3.example.com/upload', fields: {}, s3Key: 'tenants/t/engagement/f' } });
      }
      if (url === '/api/engagement/attachments/confirm') {
        return Promise.resolve({ data: attachment({ id: 'att-new' }) });
      }
      return Promise.reject(new Error(`unexpected post ${url}`));
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

    const { container } = renderFiles();
    await waitFor(() => expect(screen.getByText('No files uploaded yet.')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Upload' }));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith('/api/engagement/attachments/confirm', expect.objectContaining({ fileName: 'notes.txt' })),
    );
    expect(fetchSpy).toHaveBeenCalledWith('https://s3.example.com/upload', expect.objectContaining({ method: 'POST' }));
    fetchSpy.mockRestore();
  });
});
