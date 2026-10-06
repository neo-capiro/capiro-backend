/** Reviewed publisher/catalog discrepancies for two House select bodies.
 * Congress.gov meeting119538 (119th Congress) publishes hlzs00, while the
 * current committee/roster catalog identifies the same House body as hszs00.
 * Meeting118824 (Jan14,2026) publishes hlqj00 for the January6 select
 * subcommittee; Clerk QJ00 and the current catalog identify it as hsqj00.
 * These aliases are for reads and source lookup only: retain publisher codes
 * in observations and canonical rows. Never generalize hl* to hs* or use titles.
 */
const CATALOG_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  hlzs00: 'hszs00',
  hlqj00: 'hsqj00',
});

export function committeeCatalogCode(value: string | null | undefined): string | null {
  const code = value?.trim().toLowerCase();
  return code ? (CATALOG_ALIASES[code] ?? code) : null;
}

export function committeeCatalogReadCodes(value: string): string[] {
  const code = committeeCatalogCode(value);
  if (!code) return [];
  return [code, ...Object.keys(CATALOG_ALIASES).filter((alias) => CATALOG_ALIASES[alias] === code)];
}
