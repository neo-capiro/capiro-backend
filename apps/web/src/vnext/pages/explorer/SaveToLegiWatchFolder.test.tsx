import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SaveToLegiWatchFolder } from './SaveToLegiWatchFolder.js';

const apiGet = vi.hoisted(() => vi.fn());
const apiPost = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/use-api.js', () => ({
  useApi: () => ({ get: apiGet, post: apiPost }),
}));

const FOLDERS = [
  { id: 'f1', name: 'Defense appropriations', clientId: 'c1', archived: false },
  { id: 'f2', name: 'Archived folder', clientId: null, archived: true },
  { id: 'f3', name: 'Space policy', clientId: null, archived: false },
];

const TRACK = '/intel-api/legiwatch/evidence/track';
const ENSURE = '/api/explorer/intel-articles/art-9/legiwatch-observation';

function mount() {
  const row = vi.fn();
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        {/* Stand-in for the NewsItem row, which is itself a click/keyboard button. */}
        <div role="button" aria-label="News row" tabIndex={0} onClick={row} onKeyDown={row}>
          <SaveToLegiWatchFolder articleId="art-9" />
        </div>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { row };
}

async function openAndPick(folderId: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Save to LegiWatch' }));
  const select = await screen.findByRole('combobox', { name: 'LegiWatch folder' });
  await screen.findByRole('option', { name: 'Space policy' });
  fireEvent.change(select, { target: { value: folderId } });
  return select;
}

beforeEach(() => {
  apiGet.mockReset();
  apiPost.mockReset();
  apiGet.mockImplementation(async (url: string) => {
    if (url === '/intel-api/legiwatch/folders') return { data: FOLDERS };
    throw new Error('Unexpected GET ' + url);
  });
  apiPost.mockImplementation(async (url: string) => {
    if (url === ENSURE) return { data: { observationId: 'obs-42' } };
    if (url === TRACK) return { data: { ok: true } };
    throw new Error('Unexpected POST ' + url);
  });
});

describe('SaveToLegiWatchFolder', () => {
  it('loads folders only on open, then ensures the observation before tracking it', async () => {
    const { row } = mount();
    expect(apiGet).not.toHaveBeenCalled();

    const select = await openAndPick('f1');
    expect(apiGet).toHaveBeenCalledWith('/intel-api/legiwatch/folders');
    expect(screen.queryByRole('option', { name: 'Archived folder' })).toBeNull();
    fireEvent.keyDown(select, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Saved to Defense appropriations');
    expect(apiPost).toHaveBeenCalledTimes(2);
    expect(apiPost).toHaveBeenNthCalledWith(1, ENSURE);
    expect(apiPost).toHaveBeenNthCalledWith(2, TRACK, {
      clientId: 'c1',
      folderId: 'f1',
      kind: 'news',
      sourceId: 'obs-42',
      expectedVersion: 0,
      removed: false,
    });
    expect(screen.getByRole('link', { name: 'Defense appropriations' })).toHaveAttribute(
      'href',
      '/legiwatch?tab=bills&folder=f1',
    );
    // Nothing inside the control reached the row button.
    expect(row).not.toHaveBeenCalled();
  });

  it('shows the server failure with a retry that re-runs the whole save', async () => {
    apiPost
      .mockImplementationOnce(async () => ({ data: { observationId: 'obs-42' } }))
      .mockImplementationOnce(async () => {
        throw Object.assign(new Error('boom'), {
          response: { status: 500, data: { message: 'TRACK_FAILED' } },
        });
      });
    mount();
    await openAndPick('f3');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('track failed');
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Saved to Space policy');
    expect(apiPost).toHaveBeenCalledTimes(4);
    expect(apiPost).toHaveBeenNthCalledWith(3, ENSURE);
    expect(apiPost).toHaveBeenNthCalledWith(4, TRACK, expect.objectContaining({
      clientId: null,
      folderId: 'f3',
      sourceId: 'obs-42',
      kind: 'news',
    }));
  });

  it('treats a 409 on track as already-saved rather than a permanent error', async () => {
    // This save always targets a brand-new row (expectedVersion: 0); a 409
    // means one already exists (an earlier session, or LegiWatch's own
    // Evidence tab) — not a real conflict for this one-shot save action.
    apiPost.mockImplementation(async (url: string) => {
      if (url === ENSURE) return { data: { observationId: 'obs-42' } };
      if (url === TRACK) {
        throw Object.assign(new Error('conflict'), {
          response: { status: 409, data: { message: 'TRACKING_VERSION_CHANGED' } },
        });
      }
      throw new Error('Unexpected POST ' + url);
    });
    mount();
    await openAndPick('f1');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Saved to Defense appropriations');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('asks for a folder to be created when none are available', async () => {
    apiGet.mockImplementation(async () => ({ data: [FOLDERS[1]] }));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Save to LegiWatch' }));

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Create a folder in LegiWatch first.',
    );
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(apiPost).not.toHaveBeenCalled();
  });
});
