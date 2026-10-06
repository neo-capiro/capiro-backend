/** Reviewed publisher/catalog discrepancy for the China Select Committee.
 * Congress.gov meeting119538 (119th Congress) publishes hlzs00, while the
 * current committee/roster catalog identifies the same House body as hszs00.
 * These aliases are for reads and source lookup only: retain publisher codes
 * in observations and canonical rows. Never generalize hl* to hs* or use titles.
 */
const CATALOG_ALIASES: Readonly<Record<string, string>> = Object.freeze({ hlzs00: 'hszs00' });

export function committeeCatalogCode(value: string | null | undefined): string | null {
  const code = value?.trim().toLowerCase();
  return code ? (CATALOG_ALIASES[code] ?? code) : null;
}

export function committeeCatalogReadCodes(value: string): string[] {
  const code = committeeCatalogCode(value);
  if (!code) return [];
  return [code, ...Object.keys(CATALOG_ALIASES).filter((alias) => CATALOG_ALIASES[alias] === code)];
}
