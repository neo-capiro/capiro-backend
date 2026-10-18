import { types as nodeTypes } from 'node:util';
import { CLIENT_PROFILE_SECTIONS, parseClientProfileQuery } from '../meri-client-context.helpers.js';

type RecordValue = Record<string, unknown>;
type ProfileSection = (typeof CLIENT_PROFILE_SECTIONS)[number];

/** The canonical handler's wording is part of Meri's 0.2 profile contract. */
export const RETAINED_CLIENT_CONTEXT_COVERAGE_NOTE =
  'Profile counts cover the complete authorized section at read time. Summary records omit fields; request a section for full records and follow nextCursor until complete. For a requested complete inventory, use section + representation summary + limit 50 and exhaust every requested section before summarizing; do not stop at a sample while more records are available. Unavailable or unrequested sections are not empty. submissionHistory is the older capability submission ledger; advocacyMatters and advocacyRecords are current Advocacy History, including unassigned records. An auto-generated matter or inferred evidence class is not verified advocacy or proof of causation. Engagement context contains recent items only.';

export interface RetainedClientContextTrust {
  /** Established by the current run/client authority, never read from tool input. */
  tenantId: string;
  selectedClientId: string;
  /** The 0.2 normalizer's trusted observation instant, not a local clock guess. */
  asOf: string;
  clientResolution: { selector: string; clientId: string };
}

export type RetainedClientContextPreparation =
  | {
      kind: 'prepared';
      /** Still requires Meri's complete 0.2 output-schema check before release. */
      requiresFullContractValidation: true;
      result: RecordValue;
    }
  | {
      kind: 'refused';
      reason:
        | 'trusted_context_missing'
        | 'selection_mismatch'
        | 'observation_mismatch'
        | 'source_mismatch'
        | 'coverage_mismatch'
        | 'cursor_mismatch';
    };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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

function cursor(value: unknown, clientId: string, section: ProfileSection, afterId: string): boolean {
  if (typeof value !== 'string' || value.length > 1024 || !/^[\w-]+$/.test(value)) return false;
  try {
    const decoded = record(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    return !!decoded && exactKeys(decoded, ['v', 'clientId', 'section', 'afterId']) &&
      decoded.v === 1 && decoded.clientId === clientId && decoded.section === section &&
      decoded.afterId === afterId;
  } catch {
    return false;
  }
}

/**
 * Pure preparation for a future task-bound source route. The route must supply
 * independently trusted run/client facts and the original normalized request.
 * It must then run the full Meri 0.2 schema check and current release gate.
 * The current legacy owner stamps `generatedAt` with its own clock; this helper
 * refuses unless that stamp genuinely equals the trusted `asOf`.
 */
export function prepareRetainedClientContextV02(args: {
  request: unknown;
  normalizedInput: unknown;
  trusted: unknown;
  canonicalResult: unknown;
}): RetainedClientContextPreparation {
  const trusted = record(args.trusted);
  const resolution = record(trusted?.clientResolution);
  if (!trusted || !resolution || !exactKeys(trusted, ['tenantId', 'selectedClientId', 'asOf', 'clientResolution']) ||
      !exactKeys(resolution, ['selector', 'clientId']) ||
      typeof trusted.tenantId !== 'string' || !UUID.test(trusted.tenantId) ||
      typeof trusted.selectedClientId !== 'string' || !UUID.test(trusted.selectedClientId) ||
      !canonicalInstant(trusted.asOf) || typeof resolution.selector !== 'string' ||
      !resolution.selector.trim() || typeof resolution.clientId !== 'string' ||
      resolution.clientId !== trusted.selectedClientId) return refused('trusted_context_missing');

  const request = record(args.request);
  const input = record(args.normalizedInput);
  if (!request || !input || typeof request.clientId !== 'string' ||
      request.clientId.trim() !== resolution.selector ||
      !exactKeys(input, ['clientId', 'section', 'afterId', 'limit', 'representation']) ||
      input.clientId !== trusted.selectedClientId) return refused('selection_mismatch');

  let selected: ReturnType<typeof parseClientProfileQuery>;
  try {
    selected = parseClientProfileQuery(request, trusted.selectedClientId as string);
  } catch {
    return refused('selection_mismatch');
  }
  const section = selected.section ?? null;
  const afterId = selected.afterId ?? null;
  const representation = selected.representation ?? (section ? 'full' : 'summary');
  if (input.section !== section || input.afterId !== afterId || input.limit !== selected.limit ||
      input.representation !== representation) return refused('selection_mismatch');

  const result = record(args.canonicalResult);
  if (!result || !exactKeys(result, [
    'tool', 'generatedAt', 'profileSections', 'coverageNote', 'profile', 'profileSources', 'context',
  ]) || result.tool !== 'get_client_context' ||
      result.coverageNote !== RETAINED_CLIENT_CONTEXT_COVERAGE_NOTE) return refused('source_mismatch');
  if (result.generatedAt !== trusted.asOf) return refused('observation_mismatch');

  const context = record(result.context);
  const client = record(context?.client);
  if (!context || !client || client.id !== trusted.selectedClientId ||
      client.tenantId !== trusted.tenantId || client.status === 'archived') return refused('source_mismatch');

  const coverages = record(result.profileSections);
  const profiles = record(result.profile);
  const sources = record(result.profileSources);
  if (!coverages || !profiles || !sources ||
      ![coverages, profiles, sources].every((value) => exactKeys(value, CLIENT_PROFILE_SECTIONS)))
    return refused('coverage_mismatch');

  for (const name of CLIENT_PROFILE_SECTIONS) {
    const coverage = record(coverages[name]);
    const rows = profiles[name];
    const refs = sources[name];
    if (!coverage || !Array.isArray(rows) || nodeTypes.isProxy(rows) ||
        !Array.isArray(refs) || nodeTypes.isProxy(refs) ||
        rows.length > selected.limit || refs.length !== rows.length) return refused('coverage_mismatch');
    const source = record(coverage.source);
    if (!source || !exactKeys(source, ['tool', 'clientId', 'section']) ||
        source.tool !== 'get_client_context' || source.clientId !== trusted.selectedClientId ||
        source.section !== name || coverage.limit !== selected.limit ||
        coverage.representation !== representation || coverage.returned !== rows.length)
      return refused('coverage_mismatch');

    const notRequested = section !== null && section !== name;
    if (notRequested ? coverage.status !== 'not_requested' : coverage.status === 'not_requested')
      return refused('coverage_mismatch');
    if (coverage.status === 'unavailable' || coverage.status === 'not_requested') {
      if (rows.length !== 0 || coverage.total !== null || coverage.truncated !== null ||
          coverage.nextCursor !== null ||
          (coverage.status === 'unavailable' ? coverage.error !== 'section_unavailable' : Object.hasOwn(coverage, 'error')))
        return refused('coverage_mismatch');
      continue;
    }
    if ((coverage.status !== 'complete' && coverage.status !== 'partial') ||
        !Number.isSafeInteger(coverage.total) || (coverage.total as number) < rows.length ||
        coverage.truncated !== (coverage.status === 'partial') || Object.hasOwn(coverage, 'error'))
      return refused('coverage_mismatch');

    let previous = section === name ? afterId : null;
    for (let i = 0; i < rows.length; i += 1) {
      const row = record(rows[i]);
      const reference = record(refs[i]);
      if (!row || !reference || typeof row.id !== 'string' || !row.id ||
          (previous !== null && row.id <= previous) || reference.recordId !== row.id)
        return refused('coverage_mismatch');
      previous = row.id;
    }
    if (coverage.status === 'partial') {
      if (rows.length !== selected.limit || previous === null ||
          !cursor(coverage.nextCursor, trusted.selectedClientId as string, name, previous))
        return refused('cursor_mismatch');
    } else if (coverage.nextCursor !== null) return refused('cursor_mismatch');
  }

  return { kind: 'prepared', requiresFullContractValidation: true, result };
}
