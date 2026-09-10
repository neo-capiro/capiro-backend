/** Canonical client targeting is distinct from the additive watch presets. */
export function watchlistSetupPath(clientId?: string): string {
  return `/legiwatch?tab=settings&sub=watchlist${clientId ? `&client=${encodeURIComponent(clientId)}` : ''}`;
}

export function isWatchlistSetup(params: URLSearchParams): boolean {
  const tab = params.get('tab');
  return (
    tab === 'watchlist' ||
    tab === 'watchlists' ||
    (tab === 'settings' && params.get('sub') === 'watchlist')
  );
}
