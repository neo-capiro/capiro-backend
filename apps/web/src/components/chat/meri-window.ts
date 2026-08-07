export const MERI_WINDOW_QUERY = 'meriWindow';
export const MERI_WINDOW_NAME = 'capiro-meri-v3';

export function isMeriWorkspaceWindow(search = window.location.search): boolean {
  return new URLSearchParams(search).get(MERI_WINDOW_QUERY) === '1';
}

export function meriWorkspaceUrl(origin = window.location.origin): string {
  const url = new URL('/', origin);
  url.searchParams.set(MERI_WINDOW_QUERY, '1');
  return url.toString();
}

/**
 * A real top-level browser window, not an element dragged inside Capiro. The OS
 * can move it to another monitor, resize it, maximize it and keep it beside the
 * main application. A named window makes repeated launcher clicks focus/reuse
 * the same Meri workspace instead of multiplying sessions.
 */
export function openMeriWorkspaceWindow(
  opener: Pick<Window, 'open' | 'screenX' | 'screenY' | 'outerWidth' | 'outerHeight'> = window,
  origin = window.location.origin,
): Window | null {
  const width = Math.max(980, Math.min(1480, Math.round(opener.outerWidth * 0.86)));
  const height = Math.max(720, Math.min(980, Math.round(opener.outerHeight * 0.9)));
  const left = Math.max(0, Math.round(opener.screenX + (opener.outerWidth - width) / 2));
  const top = Math.max(0, Math.round(opener.screenY + (opener.outerHeight - height) / 2));
  const features = [
    'popup=yes',
    'resizable=yes',
    'scrollbars=yes',
    `width=${width}`,
    `height=${height}`,
    `left=${left}`,
    `top=${top}`,
  ].join(',');
  const popup = opener.open(meriWorkspaceUrl(origin), MERI_WINDOW_NAME, features);
  popup?.focus();
  return popup;
}
