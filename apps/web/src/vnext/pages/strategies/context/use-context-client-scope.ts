import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useClientFilter } from '../../../../state/client-filter.js';

/** One scope shared by the shell, URL, document list, facts and health. */
export function useContextClientScope() {
  const [params, setParams] = useSearchParams();
  const global = useClientFilter();
  const linked = params.get('clientId') ?? params.get('client');
  const previous = useRef({ global: global.selectedClientId, linked, initialized: false });
  const globalChanged = previous.current.initialized && previous.current.global !== global.selectedClientId;
  const scope = globalChanged ? global.selectedClientId ?? 'all' : linked ?? global.selectedClientId ?? 'all';
  const select = (value: string) => {
    global.setSelectedClientId(value === 'all' || value === 'firm' ? null : value);
    setParams((old) => {
      const next = new URLSearchParams(old);
      next.delete('client');
      next.delete('clientId');
      if (value === 'firm' || value === 'all') next.set('client', value);
      else next.set('clientId', value);
      return next;
    }, { replace: true });
  };
  useEffect(() => {
    const last = previous.current;
    previous.current = { global: global.selectedClientId, linked, initialized: true };
    if (globalChanged) select(global.selectedClientId ?? 'all');
    else if ((!last.initialized || last.linked !== linked) && linked) {
      const id = linked === 'all' || linked === 'firm' ? null : linked;
      previous.current.global = id;
      global.setSelectedClientId(id);
    } else if (!linked) select(scope);
    // Only actual URL/global scope changes synchronize the two stores.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked, global.selectedClientId]);
  return { scope, clientId: scope === 'all' || scope === 'firm' ? null : scope, select,
    matches: (clientId: string | null) => scope === 'all' || clientId === null || clientId === scope,
    query: scope === 'all' || scope === 'firm' ? `?client=${scope}` : `?clientId=${encodeURIComponent(scope)}` };
}
