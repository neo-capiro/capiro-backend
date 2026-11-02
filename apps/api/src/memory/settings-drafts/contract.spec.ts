import { createHash, randomUUID } from 'node:crypto';
import {
  memoryDraftRequestBytes,
  memoryDraftSubmissionBytes,
  parseMemoryDraftSave,
  parseMemoryDraftSubmit,
  parseMemoryDraftReceipt,
  parseMemoryDraftSubmissionReceipt,
} from '@capiro/shared/settings-memory-drafts';
import { draftRequestHash, draftTarget, parseDraftWrite } from './input.js';
import { editableSectionKeys } from '../memory-catalog.js';

describe('shared Settings draft wire contract', () => {
  const userId = randomUUID(),
    id = randomUUID();
  const target = draftTarget('user-profile', 'me', userId);
  const keys = [...editableSectionKeys('user-profile')];
  const write = () => ({
    requestId: randomUUID(),
    expectedRevision: 0,
    action: 'save' as const,
    baseItemId: null,
    baseVersion: null,
    sections: keys.map((key) => ({ key, body: 'Draft content' })),
  });
  it('shares exact normalized UTF-8 request bytes with Core without trusting the personal URL slug', () => {
    const body = write();
    const reversed = { ...body, sections: [...body.sections].reverse() };
    const parsed = parseDraftWrite('user-profile', reversed);
    expect(target.slug).toBe(userId);
    expect(memoryDraftRequestBytes(target, id, body)).toBe(
      memoryDraftRequestBytes(target, id, reversed),
    );
    expect(draftRequestHash(target, id, parsed)).toBe(
      createHash('sha256')
        .update(memoryDraftRequestBytes(target, id, body))
        .digest('hex'),
    );
    expect(parseMemoryDraftSave(reversed)).toEqual(parsed);
  });
  it('binds save and submission receipts to every target, operation, identity and revision', () => {
    const body = write();
    const bytes = memoryDraftRequestBytes(target, id, body);
    for (const changed of [
      { ...body, requestId: randomUUID() },
      { ...body, expectedRevision: 1 },
      { ...body, sections: [] },
      { ...body, action: 'discard' as const, sections: [] },
      { ...body, baseItemId: randomUUID(), baseVersion: 'a'.repeat(64) },
    ])
      expect(memoryDraftRequestBytes(target, id, changed)).not.toBe(bytes);
    expect(memoryDraftRequestBytes({ ...target, slug: randomUUID() }, id, body)).not.toBe(bytes);
    expect(memoryDraftRequestBytes(target, randomUUID(), body)).not.toBe(bytes);
    const submission = { requestId: body.requestId, expectedRevision: 1 };
    expect(memoryDraftSubmissionBytes(target, id, submission)).not.toBe(bytes);
    expect(memoryDraftSubmissionBytes(target, id, { ...submission, expectedRevision: 2 })).not.toBe(
      memoryDraftSubmissionBytes(target, id, submission),
    );
  });
  it.each([
    ['unknown fields', (b: ReturnType<typeof write>) => ({ ...b, ownerUserId: randomUUID() })],
    [
      'duplicate sections',
      (b: ReturnType<typeof write>) => ({ ...b, sections: [b.sections[0], b.sections[0]] }),
    ],
    ['unpaired base', (b: ReturnType<typeof write>) => ({ ...b, baseItemId: randomUUID() })],
    ['negative revision', (b: ReturnType<typeof write>) => ({ ...b, expectedRevision: -1 })],
    ['fractional revision', (b: ReturnType<typeof write>) => ({ ...b, expectedRevision: 0.5 })],
    [
      'overflow revision',
      (b: ReturnType<typeof write>) => ({ ...b, expectedRevision: 2147483647 }),
    ],
    ['discarded content', (b: ReturnType<typeof write>) => ({ ...b, action: 'discard' })],
    [
      'oversized UTF-8 content',
      (b: ReturnType<typeof write>) => ({
        ...b,
        sections: [{ key: keys[0], body: 'é'.repeat(65536) }],
      }),
    ],
  ])('rejects %s on both producer and receiver', (_name, change) => {
    expect(() => parseMemoryDraftSave(change(write()))).toThrow();
    expect(() => parseDraftWrite('user-profile', change(write()))).toThrow();
  });
  it('leaves edit authority in Core and refuses engine or unknown sections', () => {
    const body = { ...write(), sections: [{ key: 'unlisted-engine-section', body: 'changed' }] };
    expect(parseMemoryDraftSave(body)).toEqual(body);
    expect(() => parseDraftWrite('user-profile', body)).toThrow('Invalid memory draft section');
  });
  it('requires a saved revision and exact submission keys', () => {
    expect(() =>
      parseMemoryDraftSubmit({ requestId: randomUUID(), expectedRevision: 0 }),
    ).toThrow();
    expect(() =>
      parseMemoryDraftSubmit({ requestId: randomUUID(), expectedRevision: 1, sections: [] }),
    ).toThrow();
  });
  it('does not accept a receipt carrying private draft content or a claimed published outcome', () => {
    const receipt = {
      schema: 'memory-settings-draft-receipt/1',
      requestId: randomUUID(),
      draftId: id,
      requestHash: 'a'.repeat(64),
      revision: 1,
      state: 'draft',
      recordedAt: new Date().toISOString(),
    };
    expect(parseMemoryDraftReceipt(receipt)).toEqual(receipt);
    expect(() => parseMemoryDraftReceipt({ ...receipt, sections: write().sections })).toThrow();
    const submitted = {
      schema: 'memory-settings-submit-receipt/1',
      requestId: randomUUID(),
      draftId: id,
      requestHash: 'a'.repeat(64),
      draftRevision: 1,
      candidateId: randomUUID(),
      submittedAt: new Date().toISOString(),
      status: 'pending_review',
      activeItemUnchanged: true,
    };
    expect(parseMemoryDraftSubmissionReceipt(submitted)).toEqual(submitted);
    expect(() =>
      parseMemoryDraftSubmissionReceipt({ ...submitted, status: 'published' }),
    ).toThrow();
  });
});
