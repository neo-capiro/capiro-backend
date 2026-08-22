/**
 * Compatibility shim. The Eastern-time derivation helpers for the
 * `committee_hearing` corpus moved to `src/hearing-discovery/hearing-time.ts`
 * so the Phase 3 discovery core (which lives under `src/`, and therefore cannot
 * import from the build-excluded `scripts/` tree) shares ONE implementation with
 * `sync-hearings.ts` instead of forking a second copy of the ET math that the
 * 2026-07-29 +4h defect came from.
 *
 * Existing importers (`sync-hearings.ts`, `hearing-time.spec.ts`) keep working
 * unchanged.
 */
export {
  ET_ZONE,
  etParts,
  isDateOnlySentinel,
  formatTime,
  safeDate,
  etCalendarDay,
  hearingCalendarDate,
  etWallClockToInstant,
  parseEtClock,
  houseStartsAt,
} from '../../src/hearing-discovery/hearing-time.js';
export type { EtParts } from '../../src/hearing-discovery/hearing-time.js';
