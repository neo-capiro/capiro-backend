import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { useApiScope } from '../../../../lib/use-api-scope.js';
export const EVIDENCE_BASE = '/intel-api/legiwatch/evidence';
export type Row = Record<string, any>;
export function useEvidence<T>(path: string, params: Record<string, string>, enabled = true) {
  const api = useApi(),
    scope = useApiScope();
  const search = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
  return useQuery({
    queryKey: ['legiwatch-evidence', scope, path, search.toString()],
    queryFn: async () => (await api.get<T>(`${EVIDENCE_BASE}/${path}?${search}`)).data,
    enabled,
    retry: false,
  });
}
export const sourceUrl = (raw: unknown) => {
  try {
    const url = new URL(String(raw));
    return ['https:', 'http:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
};
export const money = (value: string | null) => {
  if (value === null) return 'Unavailable';
  const n = BigInt(value),
    a = n < 0n ? -n : n;
  return `${n < 0n ? '-' : ''}$${(a / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(a % 100n).toString().padStart(2, '0')}`;
};
export const basketKey = (scope: string, client: string, folder: string) =>
  `legiwatch-editorial:${scope}:${client}:${folder}`;
export function readBasket(key: string): Row[] {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? '[]');
  } catch {
    return [];
  }
}
export function addBasket(key: string, source: Row) {
  const rows = readBasket(key);
  if (
    !rows.some(
      (r) => r.kind === source.kind && r.id === source.id && r.revision === source.revision,
    )
  )
    rows.push(source);
  sessionStorage.setItem(key, JSON.stringify(rows.slice(0, 50)));
}
