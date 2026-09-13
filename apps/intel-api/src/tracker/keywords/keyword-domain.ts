import { BadRequestException } from '@nestjs/common';
import { compileKeywordQuery, type QueryCompilation } from './keyword-query.js';
import { keywordScope, type KeywordScope } from '../../sourcedata/keyword-source.repository.js';
import { object } from '../reports/report-domain.js';
export type KeywordDefinition = {
  id: string;
  raw: string;
  sourceVersion?: number;
  sourceHash?: string;
};
export type KeywordConfig = {
  scope: KeywordScope;
  folderIds: string[];
  definitions: KeywordDefinition[];
  aggregation: 'any-v1' | 'all-v1' | 'unqualified';
  semanticsReviewed: boolean;
  mode: 'suggest' | 'auto_add';
  cadence: 'realtime' | 'end_of_day';
  timezone: string | null;
  localMinutes: number | null;
  source: Record<string, unknown> | null;
  recipients?: Array<{ sourceUserId?: string; userId: string; email: boolean; inApp: boolean }>;
  deliveryEnabled?: boolean;
};
export type KeywordRule = {
  id: string;
  tenant_id: string;
  owner_clerk_id: string;
  name: string;
  version: number;
  state: 'needs_review' | 'active' | 'paused';
  config: KeywordConfig;
  activation: {
    fromNow: string;
    previewRunId: string;
    version: number;
    folderVersions: Record<string, number>;
  } | null;
};
export type CompiledDefinition = KeywordDefinition & { compiled: QueryCompilation };
export function compileDefinitions(definitions: KeywordDefinition[]): CompiledDefinition[] {
  return definitions.map((d) => ({ ...d, compiled: compileKeywordQuery(d.raw) }));
}
export function keywordConfig(value: unknown): KeywordConfig {
  const b = object(value),
    scope = keywordScope(b.scope);
  if (
    !Array.isArray(b.folderIds) ||
    b.folderIds.length > 20 ||
    b.folderIds.some((id) => typeof id !== 'string' || !id || id.length > 200)
  )
    throw new BadRequestException('INVALID_FOLDER_TARGETS');
  if (!Array.isArray(b.definitions) || b.definitions.length > 190)
    throw new BadRequestException('MAX_190_KEYWORD_DEFINITIONS');
  const definitions = b.definitions.map((d) => {
    const x = object(d);
    if (
      typeof x.id !== 'string' ||
      !x.id ||
      x.id.length > 200 ||
      typeof x.raw !== 'string' ||
      x.raw.length > 4096
    )
      throw new BadRequestException('INVALID_KEYWORD_DEFINITION');
    return { id: x.id, raw: x.raw };
  });
  if (new Set(definitions.map((d) => d.id)).size !== definitions.length)
    throw new BadRequestException('DUPLICATE_KEYWORD_ID');
  if (
    !['any-v1', 'all-v1', 'unqualified'].includes(String(b.aggregation)) ||
    !['suggest', 'auto_add'].includes(String(b.mode)) ||
    !['realtime', 'end_of_day'].includes(String(b.cadence))
  )
    throw new BadRequestException('EXPLICIT_RULE_MODE_AND_AGGREGATION_REQUIRED');
  return {
    scope,
    folderIds: [...new Set(b.folderIds)] as string[],
    definitions,
    aggregation: b.aggregation as KeywordConfig['aggregation'],
    semanticsReviewed: b.semanticsReviewed === true,
    mode: b.mode as KeywordConfig['mode'],
    cadence: b.cadence as KeywordConfig['cadence'],
    timezone: typeof b.timezone === 'string' ? b.timezone : null,
    localMinutes: Number.isInteger(b.localMinutes) ? Number(b.localMinutes) : null,
    source: null,
    recipients: [],
    deliveryEnabled: false,
  };
}
export function queryReadiness(config: KeywordConfig): string[] {
  const reasons: string[] = [];
  if (!config.definitions.length) reasons.push('EMPTY_RULE');
  if (!config.folderIds.length) reasons.push('NO_AUTOMATIC_FOLDER_TARGET_SELECTED');
  if (!config.semanticsReviewed || config.aggregation === 'unqualified')
    reasons.push('RULE_AGGREGATION_REVIEW_REQUIRED');
  for (const d of compileDefinitions(config.definitions))
    if (d.compiled.status !== 'supported') reasons.push(`${d.id}:${d.compiled.reasons.join(',')}`);
  if (config.cadence === 'end_of_day') {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: config.timezone ?? '' }).format();
    } catch {
      reasons.push('TIMEZONE_REQUIRED');
    }
    if (config.localMinutes === null || config.localMinutes < 0 || config.localMinutes > 1439)
      reasons.push('LOCAL_CUTOFF_REQUIRED');
  }
  return reasons;
}
