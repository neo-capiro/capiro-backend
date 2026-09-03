import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientCrmFilesProto } from './FilesTab.js';
import type { Client, ClientAttachment } from '../../../../pages/clients/clientTypes.js';

const openMeriMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../components/chat/meri-window.js', () => ({
  openMeriWorkspaceWithContext: openMeriMock,
}));

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

/**
 * The tab now issues two GETs — attachments and the real folder tree
 * (`/files/folders`). Route by URL so a folders response is never mistaken for
 * an attachments response (a single mockResolvedValue would answer both).
 */
function mockApi({
  attachments = [],
  folders,
}: {
  attachments?: ClientAttachment[];
  folders?: Array<{ folder: string | null; count: number }>;
}) {
  const groups =
    folders ??
    Object.entries(
      attachments.reduce<Record<string, number>>((acc, file) => {
        const key = file.folder?.trim() ? file.folder.trim() : '';
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
    ).map(([folder, count]) => ({ folder: folder === '' ? null : folder, count }));

  getMock.mockImplementation((url: string) => {
    if (url.endsWith('/files/folders')) return Promise.resolve({ data: groups });
    return Promise.resolve({ data: attachments });
  });
}

beforeEach(() => {
  getMock.mockReset();
  postMock.mockReset();
  patchMock.mockReset();
  deleteMock.mockReset();
});

describe('ClientCrmFilesProto', () => {
  it('shows a real empty state instead of the design fixture when the client has no files', async () => {
    mockApi({ attachments: [] });
    renderFiles();

    await waitFor(() => expect(screen.getByText('No files uploaded yet.')).toBeInTheDocument());
    // The FILES fixture's designed rows must not leak through as if real.
    expect(screen.queryByText('FY27 Congressional Strategy Memo')).not.toBeInTheDocument();
  });

  it('opens the preview modal instead of downloading when a real row is clicked', async () => {
    mockApi({ attachments: [attachment()] });
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderFiles();

    const nameButton = await screen.findByText('Budget Memo');
    fireEvent.click(nameButton);

    // Clicking the row no longer downloads by itself.
    expect(openSpy).not.toHaveBeenCalled();
    expect(await screen.findByRole('dialog', { name: 'Budget Memo' })).toBeInTheDocument();
    openSpy.mockRestore();
  });

  it('shows an inline preview for a previewable content type', async () => {
    mockApi({
      attachments: [attachment({ previewUrl: 'https://files.example.com/att-1?inline' })],
    });
    renderFiles();

    fireEvent.click(await screen.findByText('Budget Memo'));

    const dialog = await screen.findByRole('dialog', { name: 'Budget Memo' });
    const iframe = dialog.querySelector('iframe');
    expect(iframe).toHaveAttribute('src', 'https://files.example.com/att-1?inline');
    expect(screen.queryByText(/No preview available/)).not.toBeInTheDocument();
  });

  it('falls back to a download-only state when the file has no previewUrl', async () => {
    mockApi({ attachments: [attachment({ previewUrl: null })] });
    renderFiles();

    fireEvent.click(await screen.findByText('Budget Memo'));

    const dialog = await screen.findByRole('dialog', { name: 'Budget Memo' });
    await screen.findByText(/No preview available for this file type/);
    expect(dialog.querySelector('iframe')).not.toBeInTheDocument();
  });

  it('downloads via the modal Download button, closes via the X button', async () => {
    mockApi({ attachments: [attachment({ previewUrl: null })] });
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderFiles();

    fireEvent.click(await screen.findByText('Budget Memo'));
    await screen.findByRole('dialog', { name: 'Budget Memo' });

    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(openSpy).toHaveBeenCalledWith('https://files.example.com/att-1', '_blank', 'noopener,noreferrer');

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Budget Memo' })).not.toBeInTheDocument(),
    );
    openSpy.mockRestore();
  });

  it('deletes a file via the row menu and the confirm dialog', async () => {
    mockApi({ attachments: [attachment()] });
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
    mockApi({ attachments: [attachment()] });
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
    mockApi({ attachments: [] });
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

  /* ── folder tree + New folder ("3 Compose extend" items 2-3) ───────────── */

  it('builds the folder tree from the real folders endpoint, not the FOLDERS fixture', async () => {
    // None of these labels exist in portfolio-fixtures.ts, so the assertions
    // cannot pass against the fixture tree.
    mockApi({
      attachments: [attachment({ folder: 'Hill Submissions' })],
      folders: [
        { folder: 'Hill Submissions', count: 4 },
        { folder: 'Award Docs', count: 2 },
        { folder: null, count: 3 },
      ],
    });
    renderFiles();

    // Root is the client, counted across every folder including unfiled.
    expect(await screen.findByRole('button', { name: /Overland AI\s*9/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Award Docs\s*2/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Hill Submissions\s*4/ })).toBeInTheDocument();
    // Unfiled appears because files are genuinely unfiled.
    expect(screen.getByRole('button', { name: /Unfiled\s*3/ })).toBeInTheDocument();
    // The fixture's invented hierarchy must be gone.
    expect(screen.queryByText('FY27 Strategy')).not.toBeInTheDocument();
    expect(screen.queryByText('Deliverables')).not.toBeInTheDocument();
  });

  it('omits Unfiled when every file is filed', async () => {
    mockApi({ folders: [{ folder: 'Award Docs', count: 2 }], attachments: [attachment({ folder: 'Award Docs' })] });
    renderFiles();

    await screen.findByRole('button', { name: /Award Docs\s*2/ });
    expect(screen.queryByText('Unfiled')).not.toBeInTheDocument();
  });

  it('scopes the file list to the selected real folder', async () => {
    mockApi({
      attachments: [
        attachment({ id: 'att-1', fileName: 'Hill Ask.pdf', folder: 'Hill Submissions' }),
        attachment({ id: 'att-2', fileName: 'Award Notice.pdf', folder: 'Award Docs' }),
      ],
    });
    renderFiles();

    // Root shows both.
    expect(await screen.findByText('Hill Ask')).toBeInTheDocument();
    expect(screen.getByText('Award Notice')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Award Docs\s*1/ }));
    await waitFor(() => expect(screen.queryByText('Hill Ask')).not.toBeInTheDocument());
    expect(screen.getByText('Award Notice')).toBeInTheDocument();
  });

  it('creates a folder by filing the current selection into it', async () => {
    mockApi({ attachments: [attachment()] });
    patchMock.mockResolvedValue({ data: { id: 'att-1' } });
    renderFiles();

    await screen.findByText('Budget Memo');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Budget Memo' }));
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }));

    fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'Hill Submissions' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create and file 1' }));

    await waitFor(() => expect(patchMock).toHaveBeenCalledTimes(1));
    expect(patchMock.mock.calls[0]?.[0]).toBe('/api/clients/client-1/files/att-1/folder');
    expect(patchMock.mock.calls[0]?.[1]).toEqual({ folder: 'Hill Submissions' });
  });

  it('opens a draft folder — and writes nothing — when nothing is selected', async () => {
    mockApi({ attachments: [attachment()] });
    renderFiles();

    await screen.findByText('Budget Memo');
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
    fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'Hill Submissions' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create folder' }));

    // Shown as a draft, and no move was issued — there is no create endpoint,
    // and inventing a request that 404s would be worse than saying "draft".
    expect(await screen.findByRole('button', { name: /Hill Submissions\s*Draft/ })).toBeInTheDocument();
    expect(patchMock).not.toHaveBeenCalled();
    expect(screen.getByText('Draft folder · upload or move a file here to create it')).toBeInTheDocument();
  });

  it('refuses a folder name that already exists', async () => {
    mockApi({ attachments: [attachment({ folder: 'Award Docs' })] });
    renderFiles();

    await screen.findByText('Budget Memo');
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
    // Case-insensitive: "award docs" is the same folder to a human.
    fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'award docs' } });

    expect(screen.getByText('That folder already exists.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create folder' })).toBeDisabled();
  });
});

/* ── "4 New capability" rows 3-4 ──────────────────────────────────────────── */

describe('ClientCrmFilesProto — Meri and link health', () => {
  it('opens the real Meri workspace scoped to this client (row 4)', async () => {
    openMeriMock.mockReset();
    mockApi({ attachments: [attachment()] });
    renderFiles();

    await screen.findByText('Budget Memo');
    fireEvent.click(screen.getByRole('button', { name: 'Create with Meri' }));

    // clientId must be carried AND a prompt must be present — Meri drops a
    // clientId that arrives without one.
    expect(openMeriMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'client-1', prompt: expect.stringContaining('Overland AI') }),
    );
  });

  it('no longer claims all source links are healthy (row 3)', async () => {
    mockApi({ attachments: [attachment()] });
    renderFiles();

    await screen.findByText('Budget Memo');
    // Nothing checks whether a smart link still resolves, so the pill asserted
    // a health it never measured.
    expect(screen.queryByText('All source links healthy')).not.toBeInTheDocument();
  });
});

/* ── Client storage — real bytes, no invented quota ───────────────────────── */

describe('ClientCrmFilesProto — client storage', () => {
  it('sums the real stored byteSize and drops the invented 10 GB quota', async () => {
    mockApi({
      attachments: [
        attachment({ id: 'a1', fileName: 'One.pdf', byteSize: 3 * 1024 * 1024 }),
        attachment({ id: 'a2', fileName: 'Two.pdf', byteSize: 1024 * 1024 }),
        // An older upload whose size was never captured contributes nothing
        // rather than being guessed at.
        attachment({ id: 'a3', fileName: 'Three.pdf', byteSize: null }),
      ],
    });
    renderFiles();

    // Numerator is the real sum; denominator is the shared product allowance.
    expect(await screen.findByText('4.0 MB of 10.0 GB')).toBeInTheDocument();
    expect(screen.getByText('<1% used · 3 files')).toBeInTheDocument();
    // The design's fabricated reading must not survive against real files.
    expect(screen.queryByText('1.8 GB of 10 GB')).not.toBeInTheDocument();
  });

  it('states an overage rather than silently clamping the meter', async () => {
    mockApi({
      attachments: [
        attachment({ id: 'big', fileName: 'Huge.bin', byteSize: 11 * 1024 * 1024 * 1024 }),
      ],
    });
    renderFiles();

    // Nothing enforces the total today, so a client CAN exceed it — the meter
    // says so instead of pinning at a tidy 100%.
    expect(await screen.findByText(/Over the 10\.0 GB allowance/)).toBeInTheDocument();
  });

  it('shows an honest measuring state while loading — never the invented 1.8 GB figure', () => {
    getMock.mockImplementation(() => new Promise(() => {})); // never resolves
    renderFiles();

    // "1.8 GB of 10 GB" was fabricated storage attributed to whatever client
    // happened to be loading. The meter now says it is measuring instead.
    expect(screen.queryByText('1.8 GB of 10 GB')).not.toBeInTheDocument();
    expect(screen.getByText('Measuring…')).toBeInTheDocument();
  });
});
