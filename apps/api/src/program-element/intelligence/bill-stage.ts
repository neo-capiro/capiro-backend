/**
 * Bill-action stage normalizer. Implementation now lives in @capiro/shared as
 * normalizeBillStage (LegiWatch A4 — one canonical home). Re-exported here under
 * this module's historical names so existing importers keep their path; the
 * shared type names are ActionStage / ActionStageResult.
 */
export { normalizeBillStage } from '@capiro/shared';
export type {
  ActionStage as BillStage,
  ActionStageResult as BillStageResult,
} from '@capiro/shared';
