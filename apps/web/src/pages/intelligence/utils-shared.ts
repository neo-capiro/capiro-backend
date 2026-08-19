/**
 * UI-free formatting helpers shared between the canonical intelligence pages
 * (utils.tsx, which re-exports these unchanged) and the vNext intelligence
 * module (vnext/pages/intelligence/**, which imports this file directly).
 *
 * Extraction pattern (old-UI purge): utils.tsx is antd-heavy and may not be
 * imported from src/vnext/** (no-legacy-ui.contract.test.ts), so the pure
 * formatting functions moved here. Behavior is byte-identical; utils.tsx's
 * public API is unchanged via re-export.
 */

export function formatMoney(n: number | null | undefined): string {
  if (n == null) return '-';
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n}`;
}

export function formatNum(n: number | null | undefined): string {
  if (n == null) return '-';
  return n.toLocaleString();
}
