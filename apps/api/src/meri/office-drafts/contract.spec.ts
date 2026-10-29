import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { digest, parseKey, parseLock, parseOpen, parseSave, parseEditorRead } from './input.js';
import { OfficeDraftController } from './controller.js';
import { OfficeDraftRetentionController } from './retention.controller.js';
describe('private draft boundary', () => {
  const key = { conversationId: randomUUID(), draftId: randomUUID() };
  const editor = { editorId: randomUUID(), editorEpoch: 1 };
  const bytes = Buffer.from('private draft'), save = { ...key, ...editor, expectedSequence: 0, lock: 'writer',
    bytesBase64: bytes.toString('base64'), sha256: digest(bytes), kind: 'autosave' };
  it.each([{ bytesBase64: save.bytesBase64 + '\n' }, { sha256: '0'.repeat(64) }, { kind: 'publish' },
    { expectedSequence: -1 }, { expectedSequence: 2147483648 }, { lock: '' }, { lock: '\n' }, { actorId: randomUUID() },
    { editorId: undefined }, { editorEpoch: 0 }, { editorEpoch: 2147483648 }, { editorId: 'other' }])
  ('refuses mismatched bytes, noncanonical encoding, invalid sequences and widened authority %#', patch => {
    expect(() => parseSave({ ...save, ...patch })).toThrow('INPUT');
  });
  it('accepts Save kinds without publication and enforces the decoded byte ceiling', () => {
    for (const kind of ['autosave', 'explicit', 'exit']) expect(parseSave({ ...save, kind }).bytes).toEqual(bytes);
    expect(() => parseSave({ ...save, bytesBase64: 'A'.repeat(4 * Math.ceil(20 * 1024 * 1024 / 3) + 4) })).toThrow('INPUT');
  });
  it('refuses mismatched extensions, PDF editing, path traversal and malformed lock requests', () => {
    const source = { ...key, artifactId: randomUUID(), baseVersionId: randomUUID(), baseSha256: 'a'.repeat(64),
      format: 'docx', filename: 'report.docx' };
    expect(parseOpen(source)).toEqual(source);
    for (const patch of [{ format: 'pdf', filename: 'report.pdf' }, { filename: '../report.docx' }, { filename: 'report.xlsx' }])
      expect(() => parseOpen({ ...source, ...patch })).toThrow('INPUT');
    expect(() => parseLock({ ...key, ...editor, operation: 'relock', lock: 'new' })).toThrow('INPUT');
    expect(() => parseLock({ ...key, operation: 'get' })).toThrow('INPUT');
    expect(parseEditorRead({ ...key, ...editor })).toEqual({ ...key, ...editor });
    expect(() => parseKey({ ...key, tenantId: randomUUID() })).toThrow('INPUT');
  });
  it('rejects direct browser requests before touching native session, storage or publication', async () => {
    const tenant = { readApplicationAuthoritySession: jest.fn() }, controller = new OfficeDraftController({} as never, tenant as never);
    for (const method of ['open','read','editor','editorRead','lock','save','discard','beginPublish','settlePublish'] as const)
      await expect(controller[method]({} as never, {}, {} as never)).rejects.toThrow('Verified service identity required');
    expect(tenant.readApplicationAuthoritySession).not.toHaveBeenCalled();
    expect(() => new OfficeDraftRetentionController({} as never).expire({}, {} as never)).toThrow('Verified service identity required');
  });
});
