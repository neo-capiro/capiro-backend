import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

import {
  uiContractShortHash,
  type EngagementApiInfraConfig,
} from './engagement-api-config';

/**
 * Tags applied to every engagement-api resource.
 *
 * Tags are world-readable to anyone with describe permission on the resource
 * and are copied into cost and inventory reports, so they carry release
 * provenance only. No user, target, client, campaign, recipient, or prototype
 * scenario value may ever appear here — `assertNoSensitiveTagValues` enforces
 * that mechanically rather than by review.
 */
export const ENGAGEMENT_API_TAG_KEYS = {
  component: 'capiro:component',
  phase: 'capiro:phase',
  uiContract: 'capiro:ui-contract',
  releaseSha: 'capiro:release-sha',
} as const;

/** Tag keys whose presence would imply campaign or contact data. */
const FORBIDDEN_TAG_KEY = /(target|client|campaign|recipient|contact|email|tenant|user|goal|subject|prompt)/i;

/** Values that look like contact data or free text rather than provenance. */
const FORBIDDEN_TAG_VALUE = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, // email address
  /\s{2,}/, // accidental prose
];

export function engagementApiTags(cfg: EngagementApiInfraConfig): Record<string, string> {
  const tags: Record<string, string> = {
    [ENGAGEMENT_API_TAG_KEYS.component]: 'engagement-api',
    [ENGAGEMENT_API_TAG_KEYS.phase]: '2',
    [ENGAGEMENT_API_TAG_KEYS.uiContract]: uiContractShortHash(cfg.uiContract),
    Project: 'capiro',
    Environment: cfg.environment,
    ManagedBy: 'cdk',
  };
  if (cfg.releaseSha) tags[ENGAGEMENT_API_TAG_KEYS.releaseSha] = cfg.releaseSha;
  assertNoSensitiveTagValues(tags);
  return tags;
}

/**
 * Refuse to emit a tag set that carries anything other than provenance.
 *
 * Throws rather than warns: a tag is applied at deploy time, and a leak here is
 * visible to every principal that can list the resource.
 */
export function assertNoSensitiveTagValues(tags: Record<string, string>): void {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(tags)) {
    // `capiro:ui-contract` and `Environment` are allowlisted provenance keys
    // whose names would otherwise trip the substring check.
    const allowlisted: string[] = [
      ENGAGEMENT_API_TAG_KEYS.component,
      ENGAGEMENT_API_TAG_KEYS.phase,
      ENGAGEMENT_API_TAG_KEYS.uiContract,
      ENGAGEMENT_API_TAG_KEYS.releaseSha,
      'Project',
      'Environment',
      'ManagedBy',
    ];
    if (!allowlisted.includes(key) && FORBIDDEN_TAG_KEY.test(key)) {
      problems.push(`tag key "${key}" implies user or campaign data`);
    }
    if (typeof value !== 'string' || value.length === 0) {
      problems.push(`tag "${key}" has an empty value`);
      continue;
    }
    if (value.length > 64) {
      problems.push(`tag "${key}" value is ${value.length} characters; provenance tags stay short`);
    }
    for (const pattern of FORBIDDEN_TAG_VALUE) {
      if (pattern.test(value)) problems.push(`tag "${key}" value looks like free text or contact data`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`engagement-api tags rejected:\n  - ${problems.join('\n  - ')}`);
  }
}

/** Apply the standard tag set to a construct scope. */
export function applyEngagementApiTags(scope: Construct, cfg: EngagementApiInfraConfig): void {
  for (const [key, value] of Object.entries(engagementApiTags(cfg))) {
    cdk.Tags.of(scope).add(key, value);
  }
}
