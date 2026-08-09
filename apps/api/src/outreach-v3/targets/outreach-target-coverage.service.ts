import { Injectable } from '@nestjs/common';
import type {
  OutreachCampaignSpecV1,
  TargetCriteriaV1,
} from '../state/outreach-campaign-spec.v1.js';
import type { OutreachResolvedTargetRefV1 } from '../../capabilities/targets/outreach-target.contract.js';
import {
  deriveTargetCoverage,
  TARGET_COVERAGE_GAP_CODES,
  TARGET_HEALTH_CODES,
  type TargetCoverageGapCode,
  type TargetCoverageGapV1,
  type TargetCoverageV1,
  type TargetHealthCode,
  type TargetHealthResultV1,
} from '../../capabilities/targets/target-coverage.js';

export const OUTREACH_TARGET_HEALTH_CODES = TARGET_HEALTH_CODES;
export const OUTREACH_TARGET_COVERAGE_GAP_CODES = TARGET_COVERAGE_GAP_CODES;
export type OutreachTargetHealthCode = TargetHealthCode;
export type OutreachTargetCoverageGapCode = TargetCoverageGapCode;
export type { TargetHealthResultV1, TargetCoverageGapV1 };
export type OutreachTargetCoverageV1 = TargetCoverageV1;

@Injectable()
export class OutreachTargetCoverageService {
  analyze(spec: OutreachCampaignSpecV1): OutreachTargetCoverageV1 {
    return deriveOutreachTargetCoverage(spec.targeting.criteria, spec.targeting.selectedTargetRefs);
  }
}

export function deriveOutreachTargetCoverage(
  criteria: TargetCriteriaV1 | null,
  targets: readonly OutreachResolvedTargetRefV1[],
): OutreachTargetCoverageV1 {
  return deriveTargetCoverage(criteria, targets);
}
