/**
 * Bill-stage + passage-likelihood + congress helpers. Implementations now live
 * in @capiro/shared (LegiWatch A4 — one canonical home; previously duplicated
 * verbatim from apps/api). Thin re-export so existing importers keep their path.
 */
export {
  billStage,
  passageProbability,
  currentCongress,
  congressFromBillId,
  BILL_STAGES,
  type BillStage,
} from '@capiro/shared';
