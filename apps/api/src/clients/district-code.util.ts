/**
 * Re-export shim. The implementation moved to `common/district-code.util.ts`
 * (§7-A1) so the six district-code helpers that used to live in four separate
 * files share one definition of "same district". Kept as a module so existing
 * importers (the representation resolver's join-time comparison and the
 * facility geocode discrepancy check) don't all have to change at once.
 */
export { normalizeDistrictCode } from '../common/district-code.util.js';
