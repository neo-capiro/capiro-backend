import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KrispNotetakerSettings } from './KrispNotetakerSettings.js';
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../lib/use-api.js', () => ({ useApi: () => api }));
const empty = { preference: null, imports: [] };
describe('Krisp import settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockImplementation(async (url: string) => ({
      data: url.endsWith('/folders') ? [{ id: 'folder', name: 'Client calls' }] : empty,
    }));
    api.post.mockResolvedValue({
      data: { preference: { enabled: true, folderId: 'folder' }, imports: [] },
    });
  });
  afterEach(cleanup);
  it.each(['direct_notes', 'generated'])(
    'describes the server-selected %s flow',
    async (importMode) => {
      api.get.mockImplementation(async (url: string) => ({
        data: url.endsWith('/folders') ? [] : { ...empty, importMode },
      }));
      render(<KrispNotetakerSettings connected />);
      if (importMode === 'direct_notes') {
        expect(await screen.findByText(/generates a Debrief from them/)).toBeInTheDocument();
        expect(screen.queryByText(/from the completed transcripts/)).toBeNull();
      } else {
        await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeDisabled());
        expect(screen.getByText(/from the completed transcripts/)).toBeInTheDocument();
        expect(screen.queryByText(/generates a Debrief from them/)).toBeNull();
      }
    },
  );
  it('requires explicit opt-in and saves the selected folder', async () => {
    render(<KrispNotetakerSettings connected />);
    const toggle = await screen.findByRole('checkbox');
    await waitFor(() => expect(toggle).not.toBeDisabled());
    expect(toggle).not.toBeChecked();
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    await screen.findByRole('option', { name: 'Client calls' });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'folder' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save import settings' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/clio/krisp-notetaker/preferences', {
        enabled: true,
        folderId: 'folder',
      }),
    );
  });
  it('cannot enable import without a connected account', async () => {
    render(<KrispNotetakerSettings connected={false} />);
    expect(await screen.findByRole('checkbox')).toBeDisabled();
    expect(api.post).not.toHaveBeenCalled();
  });
  it('requires an explicit owned meeting selection when matching is ambiguous', async () => {
    const pending = {
      preference: { enabled: true, folderId: null },
      imports: [
        {
          id: 'i',
          title: 'Client call',
          startsAt: '2026-10-05T15:00:00Z',
          status: 'needs_match',
          error: null,
        },
      ],
    };
    api.get.mockImplementation(async (url: string) => ({
      data: url.endsWith('/folders')
        ? []
        : url.endsWith('/candidates')
          ? [{ id: 'meeting', subject: 'Budget review', startsAt: '2026-10-05T15:00:00Z' }]
          : pending,
    }));
    render(<KrispNotetakerSettings connected />);
    fireEvent.click(await screen.findByRole('button', { name: 'Choose meeting' }));
    const select = await screen.findByRole('combobox', { name: 'Meri meeting for Client call' });
    expect(screen.getByRole('button', { name: 'Save to this meeting' })).toBeDisabled();
    fireEvent.change(select, { target: { value: 'meeting' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save to this meeting' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/clio/krisp-notetaker/imports/i/match', {
        meetingId: 'meeting',
      }),
    );
  });
});
