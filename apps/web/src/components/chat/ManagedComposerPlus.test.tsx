import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  managed: true,
}));

vi.mock('./managed-mcp-apps.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./managed-mcp-apps.js')>(),
  useManagedMcpApps: () =>
    mocks.managed
      ? {
          apps: [
            {
              id: 'hubspot',
              name: 'HubSpot',
              description: 'CRM',
              status: 'disconnected',
              connected: false,
              available: true,
              needsReauth: false,
              lastError: null,
            },
            ...(['monday', 'google-drive'] as const).map((id) => ({
              id, name: id === 'monday' ? 'monday.com' : 'Google Drive',
              description: 'Read your information', status: 'disconnected', connected: false,
              available: true, needsReauth: false, lastError: null,
            })),
            {
              id: 'airtable',
              name: 'Airtable',
              description: 'Tables',
              status: 'connected',
              connected: true,
              available: true,
              needsReauth: false,
              lastError: null,
            },
          ],
          loading: false,
          busyAppId: null,
          error: null,
          connect: mocks.connect,
          disconnect: mocks.disconnect,
          refresh: vi.fn(),
        }
      : null,
}));

import { ManagedComposerPlus } from './ManagedComposerPlus.js';

describe('ManagedComposerPlus', () => {
  beforeEach(() => {
    mocks.connect.mockReset();
    mocks.disconnect.mockReset();
    mocks.managed = true;
  });

  test('MeriV3 plus menu contains upload and all four managed apps', () => {
    render(<ManagedComposerPlus onUpload={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add files or connected apps' }));
    expect(screen.getByText('Upload files')).toBeTruthy();
    expect(screen.getByText('HubSpot')).toBeTruthy();
    expect(screen.getByText('Airtable')).toBeTruthy();
    expect(screen.getByText('monday.com')).toBeTruthy();
    expect(screen.getByText('Google Drive')).toBeTruthy();
    expect(screen.queryByText('SharePoint')).toBeNull();
    expect(screen.queryByText(/server url/i)).toBeNull();
    expect(screen.queryByText(/client secret/i)).toBeNull();
  });

  test('connect and disconnect are one-click product actions', () => {
    render(<ManagedComposerPlus onUpload={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add files or connected apps' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Connect' })[0]!);
    expect(mocks.connect).toHaveBeenCalledWith('hubspot');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(mocks.disconnect).toHaveBeenCalledWith('airtable');
  });

  test('outside MeriV3 the same component is the legacy paperclip', () => {
    mocks.managed = false;
    const upload = vi.fn();
    render(<ManagedComposerPlus onUpload={upload} />);
    const button = screen.getByRole('button', { name: 'Attach files' });
    fireEvent.click(button);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('HubSpot')).toBeNull();
  });
});
