const ORIGIN = 'https://os.capiro.ai';
const CLERK = 'https://clerk.app.capiro.ai';
const PREFERENCE_PATH = '/api/clio/vnext/preferences';
const PHASES = ['initial', 'afterReload'];
const need = (ok) => {
  if (!ok) throw new Error('CASE17_UI_WRITE_ACCOUNTING');
};

/** Counts denied requests only. Nothing here authorizes forwarding a write. */
export function createCase17WriteAccounting() {
  let phase = 'outsidePanel',
    blockedWrites = 0,
    blockedPreferenceWrites = 0;
  const blockedWriteRequests = [];
  return Object.freeze({
    panelPhase(next) {
      need(PHASES.includes(next) || next === 'outsidePanel');
      phase = next;
    },
    deny(request) {
      const url = new URL(request.url()),
        method = request.method();
      if (['GET', 'HEAD', 'OPTIONS'].includes(method) || url.origin === CLERK) return false;
      blockedWrites++;
      const preference =
        method === 'PUT' &&
        url.origin === ORIGIN &&
        url.pathname === PREFERENCE_PATH &&
        !url.search &&
        !url.hash &&
        PHASES.includes(phase);
      if (preference) blockedPreferenceWrites++;
      // Unknown URLs may contain user content. Record only fixed categories,
      // never arbitrary paths, query strings, request headers or bodies.
      if (blockedWriteRequests.length < 16)
        blockedWriteRequests.push({
          method: ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? method : 'OTHER',
          path: preference ? PREFERENCE_PATH : '[redacted]',
          phase,
          kind: preference ? 'blocked_panel_preference' : 'blocked_other_write',
        });
      return true;
    },
    snapshot() {
      return {
        blockedWrites,
        blockedPreferenceWrites,
        blockedWriteRequests: structuredClone(blockedWriteRequests),
      };
    },
  });
}

/** Pure receipt validation; it grants no browser or live-capture authority. */
export function inspectCase17WriteAccounting(value) {
  need(
    Number.isSafeInteger(value?.blockedWrites) &&
      value.blockedWrites >= 0 &&
      value.blockedWrites <= 6,
  );
  need(
    value.blockedPreferenceWrites === value.blockedWrites &&
      Array.isArray(value.blockedWriteRequests) &&
      value.blockedWriteRequests.length === value.blockedWrites,
  );
  for (const item of value.blockedWriteRequests)
    need(
      item?.method === 'PUT' &&
        item.path === PREFERENCE_PATH &&
        PHASES.includes(item.phase) &&
        item.kind === 'blocked_panel_preference',
    );
  // Each round can click at most Expand panel, Open Context and Memory, Memory.
  for (const phase of PHASES)
    need(value.blockedWriteRequests.filter((item) => item.phase === phase).length <= 3);
  return true;
}
