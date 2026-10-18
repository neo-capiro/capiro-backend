import { createHash } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import { CLIENT_PROFILE_SECTIONS, parseClientProfileQuery } from '../meri-client-context.helpers.js';
import { retainedClientContextShape } from './client-context-contract.js';

type RecordValue = Record<string, unknown>;
type ProfileSection = (typeof CLIENT_PROFILE_SECTIONS)[number];

/** Pinned Meri PR158 wording; source owner must return it verbatim. */
export const RETAINED_CLIENT_CONTEXT_COVERAGE_NOTE =
  'Profile counts cover the complete authorized section at read time. Summary records omit fields; request a section for full records and follow nextCursor until complete. For a requested complete inventory, use section + representation summary + limit 50 and exhaust every requested section before summarizing; do not stop at a sample while more records are available. Unavailable or unrequested sections are not empty. submissionHistory is the older capability submission ledger; advocacyMatters and advocacyRecords are current Advocacy History, including unassigned records. An auto-generated matter or inferred evidence class is not verified advocacy or proof of causation. Engagement context contains recent items only.';

export interface RetainedClientContextTrust {
  /** Current admitted run/client authority, never model input. */
  tenantId: string;
  selectedClientId: string;
  /** Meri's authenticated normalizationContext.asOf for this exact read. */
  asOf: string;
  clientResolution: { selector: string; clientId: string };
}

/** Mint this inside the canonical owner invocation from the serialized result.
 * It is a source receipt, never a caller-supplied body or a projection guess. */
export interface RetainedClientContextOwnerReceipt {
  tool: 'get_client_context';
  tenantId: string;
  clientId: string;
  observedAt: string;
  resultSha256: string;
}

export type RetainedClientContextPreparation =
  | { kind: 'prepared'; result: RecordValue }
  | {
      kind: 'refused';
      reason:
        | 'trusted_context_missing'
        | 'selection_mismatch'
        | 'observation_mismatch'
        | 'source_mismatch'
        | 'contract_mismatch'
        | 'coverage_mismatch'
        | 'cursor_mismatch';
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const refused = (reason: Extract<RetainedClientContextPreparation, { kind: 'refused' }>['reason']): RetainedClientContextPreparation =>
  ({ kind: 'refused', reason });

function record(value: unknown): RecordValue | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((entry) => !Object.hasOwn(entry, 'value') || !entry.enumerable)) return null;
  return value as RecordValue;
}

function exactKeys(value: RecordValue, names: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...names].sort().join(',');
}

function canonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

function snapshot(value: unknown): { value: unknown; json: string } | null {
  try {
    const json = canonicalizeCoreRetainedJson(value);
    return { value: JSON.parse(json) as unknown, json };
  } catch {
    return null;
  }
}

function sha256(json: string): string {
  return createHash('sha256').update(json, 'utf8').digest('hex');
}

function same(left: unknown, right: unknown): boolean {
  const a = snapshot(left);
  const b = snapshot(right);
  return a !== null && b !== null && a.json === b.json;
}

function cursor(value: unknown, clientId: string, section: ProfileSection, afterId: string): boolean {
  if (typeof value !== 'string' || value.length > 1024 || !/^[\w-]+$/.test(value)) return false;
  try {
    const decoded = record(JSON.parse(new TextDecoder('utf-8', { fatal: true })
      .decode(Buffer.from(value, 'base64url'))));
    return !!decoded && exactKeys(decoded, ['v', 'clientId', 'section', 'afterId']) &&
      decoded.v === 1 && decoded.clientId === clientId && decoded.section === section &&
      decoded.afterId === afterId;
  } catch {
    return false;
  }
}

function excerpt(value: unknown, cap: number): boolean {
  return typeof value === 'string' && value.length <= cap &&
    !/[^\S ]| {2}/.test(value) && value === value.trim();
}

/**
 * Pure preparation for a task-bound source route. The caller must obtain
 * `ownerReceipt` and the serialized `canonicalResult` from the same current
 * canonical owner invocation. The receipt's timestamp cannot be fabricated
 * from the Meri context or from a later clock read. This function refuses the
 * current legacy handler's independently generated timestamp unless its
 * actual owner read equals the authenticated normalization context exactly.
 */
export function prepareRetainedClientContextV02(args: {
  request?: unknown;
  normalizedInput: unknown;
  trusted: unknown;
  canonicalResult: unknown;
  ownerReceipt: unknown;
}): RetainedClientContextPreparation {
  const trusted = record(args.trusted);
  const resolution = record(trusted?.clientResolution);
  if (!trusted || !resolution || !exactKeys(trusted, ['tenantId', 'selectedClientId', 'asOf', 'clientResolution']) ||
      !exactKeys(resolution, ['selector', 'clientId']) ||
      typeof trusted.tenantId !== 'string' || !UUID.test(trusted.tenantId) ||
      typeof trusted.selectedClientId !== 'string' || !UUID.test(trusted.selectedClientId) ||
      !retainedClientContextShape.context({ asOf: trusted.asOf, clientResolution: resolution }) ||
      !canonicalInstant(trusted.asOf) || typeof resolution.selector !== 'string' ||
      !resolution.selector || resolution.selector !== resolution.selector.trim() ||
      resolution.selector.length > 80 || typeof resolution.clientId !== 'string' ||
      resolution.clientId !== trusted.selectedClientId) return refused('trusted_context_missing');
  if (UUID.test(resolution.selector) &&
      resolution.selector.toLowerCase() !== trusted.selectedClientId.toLowerCase())
    return refused('selection_mismatch');

  const input = record(args.normalizedInput);
  if (!input || !retainedClientContextShape.input(input) ||
      input.clientId !== trusted.selectedClientId ||
      (input.section === null && input.afterId !== null) || input.afterId === '')
    return refused('selection_mismatch');
  const section = input.section as ProfileSection | null;
  const afterId = input.afterId as string | null;
  const limit = input.limit as number;
  const representation = input.representation as 'summary' | 'full';
  // The Meri adapter transmits normalized input, not its original request.
  // When the raw request is available, assert equivalence rather than trying
  // to recreate its cursor or selector from the normalized body.
  if (args.request !== undefined) {
    const request = record(args.request);
    if (!request || !retainedClientContextShape.request(request) ||
        typeof request.clientId !== 'string' ||
        request.clientId.trim().slice(0, 80) !== resolution.selector)
      return refused('selection_mismatch');
    let selected: ReturnType<typeof parseClientProfileQuery>;
    try {
      selected = parseClientProfileQuery(request, trusted.selectedClientId as string);
    } catch {
      return refused('selection_mismatch');
    }
    if (section !== (selected.section ?? null) || afterId !== (selected.afterId ?? null) ||
        limit !== selected.limit || representation !== (selected.representation ?? (section ? 'full' : 'summary')))
      return refused('selection_mismatch');
  }

  const serialized = snapshot(args.canonicalResult);
  const result = record(serialized?.value);
  if (!serialized || !result || !retainedClientContextShape.output(result)) return refused('contract_mismatch');
  if (result.tool !== 'get_client_context' ||
      result.coverageNote !== RETAINED_CLIENT_CONTEXT_COVERAGE_NOTE) return refused('source_mismatch');
  const receipt = record(args.ownerReceipt);
  if (!receipt || !exactKeys(receipt, ['tool', 'tenantId', 'clientId', 'observedAt', 'resultSha256']) ||
      receipt.tool !== 'get_client_context' || receipt.tenantId !== trusted.tenantId ||
      receipt.clientId !== trusted.selectedClientId || typeof receipt.resultSha256 !== 'string' ||
      !SHA.test(receipt.resultSha256) || receipt.resultSha256 !== sha256(serialized.json))
    return refused('source_mismatch');
  if (!canonicalInstant(receipt.observedAt) ||
      receipt.observedAt !== result.generatedAt || result.generatedAt !== trusted.asOf)
    return refused('observation_mismatch');

  const context = record(result.context)!;
  const client = record(context.client)!;
  if (client.id !== trusted.selectedClientId || client.tenantId !== trusted.tenantId ||
      client.status === 'archived') return refused('source_mismatch');

  const coverages = record(result.profileSections)!;
  const profiles = record(result.profile)!;
  const sources = record(result.profileSources)!;
  for (const name of CLIENT_PROFILE_SECTIONS) {
    const coverage = record(coverages[name])!;
    const source = record(coverage.source)!;
    const rows = profiles[name] as RecordValue[];
    const refs = sources[name] as RecordValue[];
    if (source.tool !== 'get_client_context' || source.clientId !== trusted.selectedClientId ||
        source.section !== name || coverage.limit !== limit ||
        coverage.representation !== representation || coverage.returned !== rows.length ||
        rows.length > limit || refs.length !== rows.length) return refused('coverage_mismatch');

    const notRequested = section !== null && section !== name;
    if (notRequested ? coverage.status !== 'not_requested' : coverage.status === 'not_requested')
      return refused('coverage_mismatch');
    if (coverage.status === 'unavailable' || coverage.status === 'not_requested') {
      if (rows.length !== 0 || coverage.total !== null || coverage.truncated !== null ||
          coverage.nextCursor !== null ||
          Object.hasOwn(coverage, 'error') !== (coverage.status === 'unavailable'))
        return refused('coverage_mismatch');
      continue;
    }
    if ((coverage.status !== 'complete' && coverage.status !== 'partial') ||
        !Number.isSafeInteger(coverage.total) || (coverage.total as number) < 0 ||
        coverage.truncated !== (coverage.status === 'partial') || Object.hasOwn(coverage, 'error') ||
        (name !== 'advocacyRecords' && (coverage.total as number) < rows.length))
      return refused('coverage_mismatch');
    if (coverage.status === 'partial' && rows.length !== limit)
      return refused('coverage_mismatch');

    let previous = afterId;
    for (let index = 0; index < rows.length; index += 1) {
      const row = record(rows[index])!;
      const ref = record(refs[index])!;
      if (typeof row.id !== 'string' || !row.id ||
          (previous !== null && row.id <= previous) || ref.recordId !== row.id ||
          (Object.hasOwn(row, 'updatedAt') &&
            (!Object.hasOwn(ref, 'updatedAt') || !same(ref.updatedAt, row.updatedAt))) ||
          (Object.hasOwn(row, 'sourceUrl') && ref.sourceUrl !== row.sourceUrl) ||
          (Object.hasOwn(row, 'clientId') && row.clientId !== trusted.selectedClientId) ||
          (Object.hasOwn(row, 'tenantId') && row.tenantId !== trusted.tenantId))
        return refused('coverage_mismatch');
      previous = row.id;
      if (representation === 'summary') {
        const excerpts: Array<[string, number]> = name === 'capabilities'
          ? [['description', 300], ['districtNexus', 200]]
          : name === 'submissionHistory' ? [['outcome', 240]]
          : name === 'advocacyMatters' ? [['summary', 300]]
          : name === 'advocacyRecords' ? [['summary', 300], ['outcome', 240]] : [];
        if (excerpts.some(([field, cap]) => !excerpt(row[field], cap))) return refused('coverage_mismatch');
      }
    }
    if (coverage.status === 'partial') {
      if (previous === null ||
          !cursor(coverage.nextCursor, trusted.selectedClientId as string, name, previous))
        return refused('cursor_mismatch');
    } else if (coverage.nextCursor !== null) return refused('cursor_mismatch');
  }

  const summary = record(context.summary)!;
  const stakeholders = context.keyStakeholders as unknown[];
  const openTasks = context.openTasks as RecordValue[];
  const openThreads = context.openThreads as RecordValue[];
  if (summary.contacts !== stakeholders.length || summary.openTasks !== openTasks.length ||
      openThreads.length > (summary.mailThreads as number)) return refused('coverage_mismatch');
  let prior = Infinity;
  for (const candidate of context.recentActivity as unknown[]) {
    const activity = record(candidate)!;
    if (!canonicalInstant(activity.date)) return refused('observation_mismatch');
    const time = Date.parse(activity.date);
    if (time > prior) return refused('coverage_mismatch');
    prior = time;
  }
  for (const thread of openThreads) {
    if (thread.status === 'closed' || thread.tenantId !== trusted.tenantId)
      return refused('source_mismatch');
  }
  for (const task of openTasks) {
    if (task.status === 'done' || task.status === 'canceled' ||
        task.clientId !== trusted.selectedClientId || task.tenantId !== trusted.tenantId)
      return refused('source_mismatch');
  }

  return { kind: 'prepared', result };
}
