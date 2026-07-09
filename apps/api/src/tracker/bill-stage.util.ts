/**
 * Bill-stage + passage-likelihood + congress helpers. The implementations now
 * live in @capiro/shared (LegiWatch A4 — one canonical home; this file is a
 * thin re-export so existing importers keep their path). See deriveBillStatus
 * in @capiro/shared for the richer rule/vote-aware bill-level status.
 */
export {
  billStage,
  passageProbability,
  humanizeBillId,
  currentCongress,
  congressFromBillId,
  BILL_STAGES,
  type BillStage,
} from '@capiro/shared';
