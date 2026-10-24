import { createHash } from 'node:crypto';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import type { RetainedSourceV02Admission } from './admission.js';
import {
  assertIdentityContactsOutputV02,
  IdentityContactsV02Unavailable,
  projectIdentityContactsRetainedSourceV02,
} from './identity-contacts.js';

const T = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const AS_OF = '2026-10-18T14:00:00.000Z';
const sha = (value: unknown) => createHash('sha256').update(canonicalizeCoreRetainedJson(value)).digest('hex');
const member = (change: Record<string, unknown> = {}) => ({
  entityType: 'member', canonicalIdType: 'bioguide', canonicalId: 'A000360',
  display: 'Ada Example', party: 'I', state: 'VA', district: 1,
  chamber: 'house', lisId: 'S390', isCurrent: true, matchedBy: 'bioguide-id', ...change,
});
const contact = (change: Record<string, unknown> = {}) => ({
  name: 'Ada Example', email: 'ada@example.com', phone: null, title: null,
  organization: 'Example', lastContact: '2026-10-17T13:00:00.000Z',
  messageCount: 2, source: 'mail_sync', onProfile: true, ...change,
});

function entityFixture() {
  const input = { query: 'A000360', limit: 5 };
  const normalizationContext = { defaultCongress: 119 };
  const metadata = { defaultCongress: 119, bioguideId: 'A000360', committeeId: null,
    billId: null, stateBillSelector: { kind: 'invalid' }, canNameSearch: true };
  const result = { tool: 'resolve_entity', generatedAt: AS_OF, matchesFound: 1, matches: [member()] };
  return fixture('resolve_entity', input, normalizationContext, metadata, result, { kind: 'canonical-registry' });
}
function contactsFixture() {
  const input = { clientId: C, domain: 'example.com', query: 'Ada', limit: 5 };
  const rows = [contact()];
  const result = { tool: 'find_contacts', generatedAt: AS_OF, clientId: C,
    clientName: 'Example Client', matchedOn: { domain: 'example.com', query: 'Ada', linkedClient: true },
    contacts: rows, note: '1 correspondent(s) found; 0 not yet on the People tab. These come from synced mail and calendar - cite them as such. Propose only the missing ones via update_client_profile people[].' };
  return fixture('find_contacts', input, {}, {}, result, { kind: 'selected-client-exact', clientId: C });
}
function fixture(operationId: 'resolve_entity' | 'find_contacts', input: Record<string, unknown>,
  normalizationContext: Record<string, unknown>, metadata: Record<string, unknown>,
  result: Record<string, unknown>, readScope: Record<string, unknown>) {
  const binding = { tenantId: T, actorId: A, conversationId: C, runId: C,
    attemptId: C, workerId: C, writerFence: 1 };
  const subject = { kind: 'client', entityType: 'client', entityIds: [C], tenantId: T, actorId: A, policyRevision: 'a'.repeat(64), scopes: [], rosterVersionId: null };
  const admission = { operation: { id: operationId, version: '0.2.0' as const }, binding, subject,
    input, metadata, normalizationContext, argumentsSha256: sha(input), requestSha256: sha({ input, metadata }),
    clientId: C, hardExpiryMs: Date.parse(AS_OF) + 5000 } as RetainedSourceV02Admission;
  const ownerRead = { operation: operationId, tenantId: T, actorId: A, subjectKind: 'client',
    subjectEntityId: C, inputSha256: sha(input), contextSha256: sha(normalizationContext),
    observedAt: AS_OF, resultSha256: sha(result), readScope, result };
  return { admission, ownerRead };
}
const project = (item: ReturnType<typeof fixture>) => projectIdentityContactsRetainedSourceV02(item);

describe('retained 0.2 identity and contacts canonical source projection', () => {
  it('preserves the complete direct entity DTO in the five-field passive wrapper', () => {
    const f = entityFixture();
    expect(project(f)).toEqual({ binding: f.admission.binding, subject: f.admission.subject,
      operation: f.admission.operation, argumentsSha256: f.admission.argumentsSha256,
      result: f.ownerRead.result });
  });

  it('uses the trusted Congress for direct bill validation and rejects model metadata drift', () => {
    const f = entityFixture();
    f.admission.input = { query: 'H.R. 1', type: 'bill', limit: 5 };
    f.admission.argumentsSha256 = sha(f.admission.input);
    f.admission.metadata = { defaultCongress: 118, bioguideId: null, committeeId: null,
      billId: '118-hr-1', stateBillSelector: { kind: 'invalid' }, canNameSearch: true };
    f.admission.normalizationContext = { defaultCongress: 118 };
    f.ownerRead.inputSha256 = sha(f.admission.input);
    f.ownerRead.contextSha256 = sha(f.admission.normalizationContext);
    f.ownerRead.result = { tool: 'resolve_entity', generatedAt: AS_OF, matchesFound: 1,
      matches: [{ entityType: 'bill', canonicalIdType: 'billId', canonicalId: '118-hr-1',
        display: 'A bill', congress: 118, sponsorName: null, sponsorBioguideId: null,
        latestActionText: null, latestActionDate: null, matchedBy: 'bill-id' }] };
    f.ownerRead.resultSha256 = sha(f.ownerRead.result);
    expect(project(f).result).toEqual(f.ownerRead.result);
    (f.admission.metadata as Record<string, unknown>).billId = '119-hr-1';
    expect(() => project(f)).toThrow(IdentityContactsV02Unavailable);
  });

  it('checks the exact 0.2 entity schema and phase, identity, count, and no-match semantics', () => {
    const f = entityFixture();
    for (const mutate of [
      (r: Record<string, unknown>) => { r.extra = 'verified'; },
      (r: Record<string, unknown>) => { r.matchesFound = 2; },
      (r: Record<string, unknown>) => { (r.matches as Record<string, unknown>[])[0].canonicalId = 'B000001'; },
      (r: Record<string, unknown>) => { (r.matches as Record<string, unknown>[])[0].matchedBy = 'name-search'; },
      (r: Record<string, unknown>) => { (r.matches as Record<string, unknown>[])[0].district = '1'; },
    ]) {
      const value = structuredClone(f.ownerRead.result) as Record<string, unknown>;
      mutate(value);
      expect(() => assertIdentityContactsOutputV02('resolve_entity', value, f.admission.input,
        f.admission.normalizationContext, f.admission.metadata)).toThrow(IdentityContactsV02Unavailable);
    }
    const empty = { tool: 'resolve_entity', generatedAt: AS_OF, matchesFound: 0, matches: [],
      note: 'No canonical entity matched "A000360". Say so explicitly - do NOT fabricate a member, committee, or bill identifier.' };
    expect(assertIdentityContactsOutputV02('resolve_entity', empty, f.admission.input,
      f.admission.normalizationContext, f.admission.metadata)).toEqual(empty);
    empty.note = 'No member exists';
    expect(() => assertIdentityContactsOutputV02('resolve_entity', empty, f.admission.input,
      f.admission.normalizationContext, f.admission.metadata)).toThrow(IdentityContactsV02Unavailable);
  });

  it('requires the owner receipt to bind the same operation, source result, scope and observation', () => {
    const f = entityFixture();
    for (const change of [
      { inputSha256: '0'.repeat(64) }, { resultSha256: '0'.repeat(64) },
      { observedAt: '2026-10-18T14:00:01.000Z' }, { actorId: C },
      { readScope: { kind: 'selected-client-exact', clientId: C } },
    ]) expect(() => project({ ...f, ownerRead: { ...f.ownerRead, ...change } }))
      .toThrow(IdentityContactsV02Unavailable);
  });

  it('accepts selected-client contacts and rejects extra fields, forged notes and hidden history', () => {
    const f = contactsFixture();
    expect(project(f).result).toEqual(f.ownerRead.result);
    for (const mutate of [
      (r: Record<string, unknown>) => { r.complete = true; },
      (r: Record<string, unknown>) => { r.clientId = T; },
      (r: Record<string, unknown>) => { r.note = 'Verified profile completeness'; },
      (r: Record<string, unknown>) => { (r.contacts as Record<string, unknown>[])[0].email = null; },
      (r: Record<string, unknown>) => { (r.contacts as Record<string, unknown>[])[0].extra = true; },
    ]) {
      const value = structuredClone(f.ownerRead.result) as Record<string, unknown>;
      mutate(value);
      expect(() => assertIdentityContactsOutputV02('find_contacts', value, f.admission.input,
        f.admission.normalizationContext, f.admission.metadata)).toThrow(IdentityContactsV02Unavailable);
    }
    expect(() => project({ ...f, ownerRead: { ...f.ownerRead,
      readScope: { kind: 'selected-client-exact', clientId: T } } })).toThrow(IdentityContactsV02Unavailable);
  });

  it('preserves the no-selector refusal but refuses personal or domain-only contact search', () => {
    const input = { clientId: null, domain: null, query: null, limit: 25 };
    const result = { tool: 'find_contacts', generatedAt: AS_OF, contacts: [],
      note: 'Pass a clientId, a domain, or a query — find_contacts will not dump the whole contact table.' };
    const f = fixture('find_contacts', input, {}, {}, result, { kind: 'no-contact-query' });
    expect(project(f).result).toEqual(result);
    f.admission.input = { ...input, query: 'Ada' };
    f.admission.argumentsSha256 = sha(f.admission.input);
    f.ownerRead.inputSha256 = sha(f.admission.input);
    expect(() => project(f)).toThrow(IdentityContactsV02Unavailable);
  });
});
