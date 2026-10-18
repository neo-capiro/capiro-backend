import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import entitySchema from './entity-candidates.schema.json';
import contactsSchema from './tenant-contacts.schema.json';
import type { RetainedSourceV02Admission } from './admission.js';

/**
 * Passive 0.2 projection of a canonical Core owner read. The owner must return
 * the result and receipt together, from the same invocation, after its own
 * current scope check. This module performs no read or authorization and never
 * substitutes the legacy model-facing contact query.
 */
export type IdentityContactsOperationV02 = 'resolve_entity' | 'find_contacts';
type JsonRecord = Record<string, unknown>;

// Exact Meri PR158 0.2 schema mirrors. SHA-256 file pins:
// entity-candidates 2b8eb948781d2e0c486b58f09fafbe821a6216942eb5ee33797135392f78d100
// tenant-contacts   065ff9d94072c8d54cb1f490957be23c952334ee2c9184bbeb76f5d82c59f691
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(entitySchema);
ajv.addSchema(contactsSchema);
const entityRef = `${entitySchema.$id}#/$defs/`;
const contactRef = `${contactsSchema.$id}#/$defs/`;
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
function shape(family: 'entity' | 'contacts', name: string, value: unknown): void {
  const ref = (family === 'entity' ? entityRef : contactRef) + name;
  let check = validators.get(ref);
  if (!check) {
    check = ajv.compile({ $ref: ref });
    validators.set(ref, check);
  }
  if (!check(value)) fail(`invalid ${name}`);
}

export interface IdentityContactsOwnerReadV02 {
  operation: IdentityContactsOperationV02;
  tenantId: string;
  actorId: string;
  subjectKind: string;
  subjectEntityId: string;
  inputSha256: string;
  contextSha256: string;
  observedAt: string;
  resultSha256: string;
  readScope: { kind: 'canonical-registry' } |
    { kind: 'selected-client-exact'; clientId: string } |
    { kind: 'no-contact-query' };
  /** JSON projection of the actual owner return, not a rebuilt DTO. */
  result: unknown;
}

export class IdentityContactsV02Unavailable extends Error {
  readonly code = 'RETAINED_SOURCE_UNAVAILABLE';
  constructor(reason: string) { super(reason); this.name = 'IdentityContactsV02Unavailable'; }
}

const fail = (reason: string): never => { throw new IdentityContactsV02Unavailable(reason); };
const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function object(value: unknown, label: string): JsonRecord {
  return isRecord(value) ? value : fail(label);
}
function list(value: unknown, label: string): unknown[] {
  return Array.isArray(value) ? value : fail(label);
}
function exact(value: JsonRecord, keys: readonly string[], optional: readonly string[] = []): void {
  const actual = Object.keys(value);
  if (actual.length < keys.length || actual.length > keys.length + optional.length ||
      keys.some((key) => !Object.hasOwn(value, key)) ||
      actual.some((key) => !keys.includes(key) && !optional.includes(key))) fail('unexpected fields');
}
function text(value: unknown, label: string, max = 16384): string {
  if (typeof value !== 'string' || value.length > max) return fail(label);
  return value;
}
function nullableText(value: unknown, label: string): string | null {
  return value === null ? null : text(value, label);
}
function integer(value: unknown, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fail(label);
  return value as number;
}
function instant(value: unknown, label: string, dateOnly = false): string {
  const raw = text(value, label, 80);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== raw ||
      dateOnly && !raw.endsWith('T00:00:00.000Z')) fail(label);
  return raw;
}
function digest(value: unknown): string {
  try { return createHash('sha256').update(canonicalizeCoreRetainedJson(value), 'utf8').digest('hex'); }
  catch { return fail('non-JSON source value'); }
}
function snapshot(value: unknown): JsonRecord {
  try { return object(JSON.parse(canonicalizeCoreRetainedJson(value)), 'non-object source value'); }
  catch { return fail('non-JSON source value'); }
}
function equal(left: unknown, right: unknown): boolean {
  try { return canonicalizeCoreRetainedJson(left) === canonicalizeCoreRetainedJson(right); }
  catch { return false; }
}

const DIRECT = ['member', 'committee', 'bill', 'state_bill'] as const;
const DIRECT_METHOD: Record<string, string> = {
  member: 'bioguide-id', committee: 'system-code', bill: 'bill-id', state_bill: 'state-bill-key',
};
const NAME = ['member', 'committee', 'state_legislator'] as const;
const CROSSWALK = ['member', 'state_bill', 'state_legislator'];
const BILL_TYPES: Record<string, readonly string[]> = {
  hr: ['h', 'r'], s: ['s'], hjres: ['h', 'j', 'res'], sjres: ['s', 'j', 'res'],
  hconres: ['h', 'con', 'res'], sconres: ['s', 'con', 'res'], hres: ['h', 'res'], sres: ['s', 'res'],
};
function billId(query: string, defaultCongress: number): string | null {
  const lower = query.toLowerCase();
  if (/^[0-9]{2,3}-(?:hr|s|hjres|sjres|hconres|sconres|hres|sres)-[0-9]{1,5}$/.test(lower))
    return lower;
  const suffix = /\(([0-9]{2,3})(?:st|nd|rd|th)?\)\s*$/.exec(query);
  const congress = suffix ? Number(suffix[1]) : defaultCongress;
  const body = suffix ? query.slice(0, suffix.index).trim() : query;
  for (const [type, parts] of Object.entries(BILL_TYPES)) {
    const pattern = new RegExp(`^${parts.map((part) => `${part}\\.?`).join('\\s*')}\\s*([0-9]{1,5})$`, 'i');
    const match = pattern.exec(body);
    if (match) return congress > 0 && Number(match[1]) > 0 ? `${congress}-${type}-${Number(match[1])}` : null;
  }
  return null;
}
type StateSelector = { kind: 'missing' | 'invalid' } |
  { kind: 'canonical'; key: string } | { kind: 'designation'; state: string; billNumber: string };
function stateBillSelector(raw: string | null): StateSelector {
  if (!raw) return { kind: 'missing' };
  const key = raw.toLowerCase().replace(/\s+/g, '').replace(/\./g, '');
  if (/^[a-z]{2}-\d{4}(x\d+)?-[a-z]+\d+[a-z]?$/.test(key)) return { kind: 'canonical', key };
  const leading = /^([A-Za-z]{2})\s+(.+)$/.exec(raw);
  if (leading?.[1] && leading[2]) {
    const match = /^([A-Za-z]+)\s*([0-9]+(?:-[0-9]+)*)([A-Za-z]?)$/.exec(leading[2].trim().replace(/\./g, ''));
    if (match?.[1] && match[2] && match[3] !== undefined) return {
      kind: 'designation', state: leading[1].toUpperCase(),
      billNumber: `${match[1]}${match[2].replace(/-/g, '')}${match[3]}`.toLowerCase(),
    };
  }
  return { kind: 'invalid' };
}
function stateSelectionMatches(id: string, selector: StateSelector): boolean {
  if (selector.kind === 'canonical') return id === selector.key;
  if (selector.kind !== 'designation') return false;
  const resolved = stateBillSelector(id);
  return resolved.kind === 'canonical' && resolved.key === id &&
    id.startsWith(`${selector.state.toLowerCase()}-`) &&
    id.slice(id.lastIndexOf('-') + 1) === selector.billNumber;
}

function entitySelection(selection: JsonRecord, context: JsonRecord, metadata: unknown) {
  shape('entity', 'EntityCandidatesContext', context);
  shape('entity', 'EntityCandidatesInput', selection);
  const defaultCongress = integer(context.defaultCongress, 1, 2147483647, 'defaultCongress');
  const limit = integer(selection.limit, 1, 10, 'entity limit');
  const query = selection.query === undefined ? null : text(selection.query, 'entity query', 200);
  const type = selection.type === undefined ? null : text(selection.type, 'entity type', 40);
  if (query !== null && (!query.trim() || query.trim() !== query) ||
      type !== null && (!type.trim() || type.trim() !== type || type.toLowerCase() !== type))
    fail('entity selection is not normalized');
  const upper = query?.toUpperCase(), lower = query?.toLowerCase();
  const derived = { defaultCongress,
    bioguideId: upper && /^[A-Z][0-9]{6}$/.test(upper) ? upper : null,
    committeeId: lower && /^[hsj][sc][a-z]{2}[0-9]{2}$/.test(lower) ? lower : null,
    billId: billId(query ?? '', defaultCongress), stateBillSelector: stateBillSelector(query),
    canNameSearch: Boolean(query && /[a-z]/i.test(query)) };
  if (!equal(metadata, derived)) fail('entity normalization metadata mismatch');
  return { limit, query, type, derived };
}
function entityResult(value: JsonRecord, selection: JsonRecord, context: JsonRecord, metadata: unknown): void {
  const { limit, query, type, derived } = entitySelection(selection, context, metadata);
  shape('entity', 'EntityCandidatesOutput', value);
  instant(value.generatedAt, 'entity generatedAt');
  const rows = list(value.matches, 'entity matches').map((row) => object(row, 'entity row'));
  if (rows.length > limit || integer(value.matchesFound, 0, 10, 'matchesFound') !== rows.length) fail('entity window');
  if (!query || rows.length === 0) {
    if (rows.length || value.note !== (query
      ? `No canonical entity matched "${query}". Say so explicitly - do NOT fabricate a member, committee, or bill identifier.`
      : 'resolve_entity requires a query (an id, bill designation, or name).')) fail('entity absence note');
    return;
  }
  if (Object.hasOwn(value, 'note')) fail('entity match note');
  let phase: string | null = null, directRank = -1, nameRank = -1;
  const current = new Map<string, boolean>(), nameIds = new Map<string, Set<string>>();
  for (const row of rows) {
    const kind = row.entityType as string, method = row.matchedBy as string;
    if ((kind === 'bill' || kind === 'state_bill') && row.latestActionDate !== null)
      instant(row.latestActionDate, 'latest action date', true);
    if (type && kind !== type) fail('entity type selection');
    const currentPhase = DIRECT_METHOD[kind] === method ? 'direct'
      : CROSSWALK.includes(kind) && method.endsWith('-crosswalk') ? 'crosswalk'
      : NAME.includes(kind as typeof NAME[number]) && method === 'name-search' ? 'name' : fail('entity phase');
    if (phase && phase !== currentPhase) fail('mixed entity phases');
    phase = currentPhase;
    if (phase === 'direct') {
      const expected = kind === 'member' ? derived.bioguideId : kind === 'committee' ? derived.committeeId : derived.billId;
      if (kind === 'state_bill' ? !stateSelectionMatches(row.canonicalId as string, derived.stateBillSelector)
        : expected === null || row.canonicalId !== expected) fail('direct entity mismatch');
      const rank = DIRECT.indexOf(kind as typeof DIRECT[number]);
      if (rank <= directRank) fail('direct entity order');
      directRank = rank;
    } else if (phase === 'name') {
      if (!derived.canNameSearch) fail('name predicate');
      const ids = nameIds.get(kind) ?? new Set<string>();
      if (ids.has(row.canonicalId as string)) fail('duplicate name identity');
      ids.add(row.canonicalId as string); nameIds.set(kind, ids);
      const rank = NAME.indexOf(kind as typeof NAME[number]);
      if (rank < nameRank || current.get(kind) === false && row.isCurrent === true) fail('name order');
      nameRank = rank; current.set(kind, row.isCurrent as boolean);
    }
  }
}

const CONTACT_NOTE = (count: number, missing: number) =>
  `${count} correspondent(s) found; ${missing} not yet on the People tab. These come from synced mail and calendar - cite them as such. Propose only the missing ones via update_client_profile people[].`;
function contactsSelection(selection: JsonRecord, context: JsonRecord, metadata: unknown) {
  shape('contacts', 'TenantContactsContext', context);
  shape('contacts', 'TenantContactsInput', selection);
  if (!equal(metadata, {})) fail('contacts metadata');
  const clientId = nullableText(selection.clientId, 'contacts clientId');
  const domain = nullableText(selection.domain, 'contacts domain');
  const query = nullableText(selection.query, 'contacts query');
  const limit = integer(selection.limit, 1, 100, 'contacts limit');
  if ([clientId, domain, query].some((item) => item !== null && (!item.trim() || item.trim() !== item)) ||
      domain !== null && domain.toLowerCase() !== domain) fail('contacts selection is not normalized');
  return { clientId, domain, query, limit };
}
function contactsResult(value: JsonRecord, selection: JsonRecord, context: JsonRecord, metadata: unknown): void {
  const { clientId, domain, query, limit } = contactsSelection(selection, context, metadata);
  shape('contacts', 'TenantContactsResult', value);
  const hasSelector = clientId !== null || domain !== null || query !== null;
  instant(value.generatedAt, 'contacts generatedAt');
  if (!hasSelector) {
    shape('contacts', 'TenantContactsRefusal', value);
    if (list(value.contacts, 'contacts refusal').length !== 0 ||
        value.note !== 'Pass a clientId, a domain, or a query — find_contacts will not dump the whole contact table.')
      fail('contacts no-selector refusal');
    return;
  }
  shape('contacts', 'TenantContactsPage', value);
  if (value.clientId !== clientId || (clientId === null && value.clientName !== null)) fail('contacts client');
  if (value.clientName !== null) text(value.clientName, 'contacts client name');
  const matched = object(value.matchedOn, 'matchedOn');
  const reportedDomain = nullableText(matched.domain, 'matched domain');
  if (matched.query !== query || matched.linkedClient !== (clientId !== null) ||
      (domain !== null && reportedDomain !== domain) ||
      (clientId === null && reportedDomain !== domain)) fail('contacts matched selection');
  const rows = list(value.contacts, 'contacts rows');
  if (rows.length > limit) fail('contacts window');
  let previous = Infinity, nullSeen = false, missing = 0;
  for (const item of rows) {
    const row = object(item, 'contact');
    if (row.onProfile === false) missing += 1;
    if (row.lastContact === null) nullSeen = true;
    else {
      const time = Date.parse(instant(row.lastContact, 'contact lastContact'));
      if (nullSeen || time > previous) fail('contact timestamp order');
      previous = time;
    }
    const email = row.email as string | null, name = row.name as string | null;
    if (!email?.trim() && (row.messageCount !== 0 || row.lastContact !== null)) fail('email-less contact history');
    if (row.onProfile && (clientId === null || !email?.trim() && !name?.trim())) fail('contact profile assertion');
    if (clientId === null && email === null && (query === null || name === null)) fail('contact search field');
  }
  const expectedNote = clientId === null
    ? `${rows.length} correspondent(s) found from synced mail and calendar.`
    : CONTACT_NOTE(rows.length, missing);
  if (value.note !== expectedNote) fail('contacts note');
}

/** Validate the complete Meri 0.2 identity/contact result, retaining its raw DTO. */
export function assertIdentityContactsOutputV02(
  operation: IdentityContactsOperationV02, value: unknown, selection: unknown,
  normalizationContext: unknown, metadata: unknown,
): JsonRecord {
  const result = snapshot(value), input = snapshot(selection), context = snapshot(normalizationContext);
  if (operation === 'resolve_entity') entityResult(result, input, context, metadata);
  else if (operation === 'find_contacts') contactsResult(result, input, context, metadata);
  else fail('operation');
  return result;
}

/**
 * Release a five-field passive wrapper only when the canonical owner supplied
 * the result and receipt in one return. A caller cannot build this receipt from
 * model input or infer a client association from email/domain. Personal contact
 * search still needs a separately scoped owner; it refuses here.
 */
export function projectIdentityContactsRetainedSourceV02(args: {
  admission: RetainedSourceV02Admission;
  ownerRead: unknown;
}): JsonRecord {
  const admission = args.admission;
  if (!admission || !['resolve_entity', 'find_contacts'].includes(admission.operation?.id) ||
      admission.operation.version !== '0.2.0') fail('operation admission');
  const operation = admission.operation.id as IdentityContactsOperationV02;
  const binding = snapshot(admission.binding), subject = snapshot(admission.subject);
  const input = snapshot(admission.input);
  const context = snapshot(admission.normalizationContext);
  const owner = snapshot(args.ownerRead), scope = object(owner.readScope, 'owner read scope');
  exact(owner, ['operation', 'tenantId', 'actorId', 'subjectKind', 'subjectEntityId',
    'inputSha256', 'contextSha256', 'observedAt', 'resultSha256', 'readScope', 'result']);
  const ids = list(subject.entityIds, 'subject ids');
  if (ids.length !== 1 || owner.operation !== operation ||
      owner.tenantId !== binding.tenantId || owner.actorId !== binding.actorId ||
      owner.subjectKind !== subject.kind || owner.subjectEntityId !== ids[0] ||
      subject.tenantId !== binding.tenantId || subject.actorId !== binding.actorId ||
      owner.inputSha256 !== digest(input) || owner.contextSha256 !== digest(context) ||
      admission.argumentsSha256 !== digest(input)) fail('owner read lineage');
  const result = assertIdentityContactsOutputV02(operation, owner.result, input, context, admission.metadata);
  if (owner.resultSha256 !== digest(result) || owner.observedAt !== result.generatedAt ||
      instant(owner.observedAt, 'owner observation') !== owner.observedAt) fail('owner observation');
  if (operation === 'resolve_entity') {
    exact(scope, ['kind']);
    if (scope.kind !== 'canonical-registry') fail('entity owner scope');
  } else {
    const selected = input.clientId;
    if (selected === null && input.domain === null && input.query === null) {
      exact(scope, ['kind']);
      if (scope.kind !== 'no-contact-query' || list(result.contacts, 'contacts').length) fail('contacts refusal scope');
    } else {
      exact(scope, ['kind', 'clientId']);
      if (scope.kind !== 'selected-client-exact' || subject.kind !== 'client' ||
          subject.entityType !== 'client' || selected !== ids[0] || scope.clientId !== selected)
        fail('contacts owner scope');
    }
  }
  return snapshot({ binding, subject, operation: { id: operation, version: '0.2.0' },
    argumentsSha256: admission.argumentsSha256, result });
}
