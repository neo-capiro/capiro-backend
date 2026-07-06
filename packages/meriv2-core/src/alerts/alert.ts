/**
 * Canonical Alert (MeriV2 Phase-1, SC1.1) — the contract now lives in
 * @capiro/shared, the lowest common dependency of all three alert surfaces
 * (apps/web and apps/intel-api depend on shared but not on this package).
 * Re-export seam: every existing meriv2-core importer keeps working unchanged.
 */
export {
  buildAlert,
  isAlertComplete,
  REQUIRED_ALERT_FIELDS,
  SOURCE_TYPES,
  type Alert,
  type AlertBuildResult,
  type RequiredAlertField,
  type SourceType,
} from '@capiro/shared';
