import {
  MERI_WINDOW_NAME,
  isMeriWorkspaceWindow,
  meriWorkspaceUrl,
  openMeriWorkspaceWindow,
  openMeriWorkspaceWithContext,
} from './meri-window.js';

describe('MeriV3 browser window', () => {
  test('detects only the explicit workspace query flag', () => {
    expect(isMeriWorkspaceWindow('?meriWindow=1')).toBe(true);
    expect(isMeriWorkspaceWindow('?meriWindow=0')).toBe(false);
    expect(isMeriWorkspaceWindow('?other=1')).toBe(false);
  });

  test('opens a named, reusable, resizable browser window', () => {
    const focus = vi.fn();
    const open = vi.fn(
      (_url?: string | URL, _target?: string, _features?: string) =>
        ({ focus }) as unknown as Window,
    );
    const opener = {
      open,
      screenX: 100,
      screenY: 50,
      outerWidth: 1600,
      outerHeight: 1000,
    } as Pick<Window, 'open' | 'screenX' | 'screenY' | 'outerWidth' | 'outerHeight'>;
    const popup = openMeriWorkspaceWindow(opener, 'https://app.capiro.test');
    expect(popup).not.toBeNull();
    expect(open).toHaveBeenCalledWith(
      meriWorkspaceUrl('https://app.capiro.test'),
      MERI_WINDOW_NAME,
      expect.stringContaining('resizable=yes'),
    );
    expect(open.mock.calls[0]?.[2]).toContain('popup=yes');
    expect(focus).toHaveBeenCalledTimes(1);
  });

  test('encodes a one-time contextual prompt and optional client scope', () => {
    const focus = vi.fn();
    const open = vi.fn(
      (_url?: string | URL, _target?: string, _features?: string) =>
        ({ focus }) as unknown as Window,
    );
    const opener = {
      open,
      screenX: 0,
      screenY: 0,
      outerWidth: 1440,
      outerHeight: 900,
    } as Pick<Window, 'open' | 'screenX' | 'screenY' | 'outerWidth' | 'outerHeight'>;

    openMeriWorkspaceWithContext(
      {
        prompt: 'Explain this contract award and what the client should do next.',
        clientId: 'client-123',
      },
      opener,
      'https://app.capiro.test',
    );

    const url = new URL(String(open.mock.calls[0]?.[0]));
    expect(url.searchParams.get('meriWindow')).toBe('1');
    expect(url.searchParams.get('meriPrompt')).toBe(
      'Explain this contract award and what the client should do next.',
    );
    expect(url.searchParams.get('meriClient')).toBe('client-123');
    expect(open.mock.calls[0]?.[1]).toBe(MERI_WINDOW_NAME);
  });

  test('returns null when the browser blocks the popup', () => {
    const opener = {
      open: vi.fn(() => null),
      screenX: 0,
      screenY: 0,
      outerWidth: 1280,
      outerHeight: 800,
    } as Pick<Window, 'open' | 'screenX' | 'screenY' | 'outerWidth' | 'outerHeight'>;
    expect(openMeriWorkspaceWindow(opener, 'https://app.capiro.test')).toBeNull();
  });
});
