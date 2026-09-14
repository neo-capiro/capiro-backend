/** Exact provider IDs: year labels do not identify regular/special sessions. */
export function selectedSessionIds(raw: string | undefined): number[] {
  if (!raw) return [];
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.length > 4 || parts.some((s) => !/^\d{1,9}$/.test(s) || Number(s) < 1))
    throw Error('INVALID_SELECTED_SESSION_ALLOWLIST');
  return [...new Set(parts.map(Number))];
}
export function selectHistoricalSessions<T extends { session_id: number; prior: number }>(
  sessions: T[],
  mode: string,
  allowlist: number[],
) {
  if (!['current', 'all', 'selected'].includes(mode)) throw Error('INVALID_SESSION_MODE');
  if (mode === 'selected' && !allowlist.length) throw Error('SELECTED_SESSION_ALLOWLIST_REQUIRED');
  if (mode !== 'selected' && allowlist.length)
    throw Error('SESSION_ALLOWLIST_REQUIRES_SELECTED_MODE');
  if (allowlist.some((id) => !sessions.some((s) => s.session_id === id)))
    throw Error('PROVIDER_SESSION_ID_NOT_FOUND');
  return sessions.filter((s) =>
    mode === 'selected' ? allowlist.includes(s.session_id) : mode === 'all' || s.prior !== 1,
  );
}
