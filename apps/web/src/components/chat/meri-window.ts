export const MERI_WINDOW_QUERY = 'meriWindow';
export const MERI_WINDOW_NAME = 'capiro-meri-v3';
export const MERI_WINDOW_PROMPT_QUERY = 'meriPrompt';
export const MERI_WINDOW_CLIENT_QUERY = 'meriClient';
export const MERI_VNEXT_PATH = '/meri';

export interface MeriWorkspaceContextRequest {
  prompt: string;
  clientId?: string | null;
}

export function isMeriWorkspaceWindow(search = window.location.search): boolean {
  return new URLSearchParams(search).get(MERI_WINDOW_QUERY) === '1';
}

function appendWorkspaceContext(url: URL, context?: MeriWorkspaceContextRequest): void {
  const prompt = context?.prompt.trim();
  if (prompt) url.searchParams.set(MERI_WINDOW_PROMPT_QUERY, prompt);
  if (context?.clientId) url.searchParams.set(MERI_WINDOW_CLIENT_QUERY, context.clientId);
}

function hasWorkspaceContext(context?: MeriWorkspaceContextRequest): boolean {
  return Boolean(context?.prompt.trim() || context?.clientId);
}

export function meriWorkspaceUrl(
  origin = window.location.origin,
  context?: MeriWorkspaceContextRequest,
): string {
  const url = new URL('/', origin);
  url.searchParams.set(MERI_WINDOW_QUERY, '1');
  appendWorkspaceContext(url, context);
  return url.toString();
}

/**
 * Canonical vNext Meri workspace URL. Plain launches resolve `/meri`; a
 * contextual launch starts from record-free `/meri/new` so the one-time prompt
 * cannot be lost while `/meri` resolves the newest durable thread.
 */
export function meriVNextWorkspaceUrl(
  origin = window.location.origin,
  context?: MeriWorkspaceContextRequest,
): string {
  const path = hasWorkspaceContext(context) ? `${MERI_VNEXT_PATH}/new` : MERI_VNEXT_PATH;
  const url = new URL(path, origin);
  appendWorkspaceContext(url, context);
  return url.toString();
}

function openWorkspaceUrl(
  url: string,
  opener: Pick<Window, 'open' | 'screenX' | 'screenY' | 'outerWidth' | 'outerHeight'>,
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
  const popup = opener.open(url, MERI_WINDOW_NAME, features);
  popup?.focus();
  return popup;
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
  context?: MeriWorkspaceContextRequest,
): Window | null {
  return openWorkspaceUrl(meriWorkspaceUrl(origin, context), opener);
}

/** Open the canonical vNext Meri route in the same reusable browser-window shell. */
export function openVNextMeriWorkspaceWindow(
  opener: Pick<Window, 'open' | 'screenX' | 'screenY' | 'outerWidth' | 'outerHeight'> = window,
  origin = window.location.origin,
  context?: MeriWorkspaceContextRequest,
): Window | null {
  return openWorkspaceUrl(meriVNextWorkspaceUrl(origin, context), opener);
}

/**
 * Open/focus the Meriv3 workspace with one contextual question ready to run.
 * The prompt lives only in the one-time workspace URL; Meri removes it before
 * executing so refresh/back cannot resend it.
 */
export function openMeriWorkspaceWithContext(
  context: MeriWorkspaceContextRequest,
  opener: Pick<Window, 'open' | 'screenX' | 'screenY' | 'outerWidth' | 'outerHeight'> = window,
  origin = window.location.origin,
): Window | null {
  return openMeriWorkspaceWindow(opener, origin, context);
}
