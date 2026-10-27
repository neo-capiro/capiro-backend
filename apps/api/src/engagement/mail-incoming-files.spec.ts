import { IncomingFilesHandoff, INCOMING_FILE_MAX_BYTES, decodeIncomingFile, gmailIncomingFiles,
  graphIncomingFiles, incomingProviderGet, readIncomingProviderFiles, type IncomingProviderSource } from './mail-incoming-files.js';

const source: IncomingProviderSource = { provider: 'gmail', messageId: 'message', threadId: 'thread', version: '12' };
const part = (overrides = {}) => ({ partId: '1', filename: 'memo.txt', mimeType: 'text/plain',
  headers: [{ name: 'Content-Disposition', value: 'attachment; filename="memo.txt"' }], body: { size: 4, attachmentId: 'file' }, ...overrides });
const message = (parts = [part()]) => ({ id: 'message', threadId: 'thread', historyId: '12',
  payload: { partId: '', filename: '', mimeType: 'multipart/mixed', headers: [], parts } });
const graphSource: IncomingProviderSource = { provider: 'microsoft_graph', messageId: 'immutable', threadId: 'conversation', version: 'change' };
const graphFile = (overrides = {}) => ({ '@odata.type': '#microsoft.graph.fileAttachment', id: 'file', name: 'memo.txt',
  contentType: 'text/plain', size: 4, isInline: false, ...overrides });
const allow = (mime: string) => mime === 'text/plain';

describe('bounded incoming provider files', () => {
  it('imports one exact Gmail file after current manifest and source checks, with GET-only fixed URLs', async () => {
    const get = jest.fn(async (url: string) => url.includes('/attachments/') ? { size: 4, data: Buffer.from('memo').toString('base64url') } : message());
    const manifest = await readIncomingProviderFiles(source, get, undefined, allow);
    const result = await readIncomingProviderFiles(source, get, { fileKey: manifest.files[0]!.key, manifestSha256: manifest.manifestSha256 }, allow);
    expect(result.imported?.buffer.toString()).toBe('memo');
    expect(get.mock.calls.every(([url]) => url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages/message'))).toBe(true);
    expect(get.mock.calls.filter(([url]) => url.includes('/attachments/'))).toHaveLength(1);
  });
  it('imports an ordinary Graph file only with immutable source checks before and after content', async () => {
    const get = jest.fn(async (url: string) => url.includes('/attachments/file') ? { ...graphFile(), contentBytes: 'bWVtbw==' }
      : url.includes('/attachments?') ? { value: [graphFile()] } : { id: 'immutable', conversationId: 'conversation', changeKey: 'change', isDraft: false });
    const manifest = await readIncomingProviderFiles(graphSource, get, undefined, allow);
    const result = await readIncomingProviderFiles(graphSource, get, { fileKey: manifest.files[0]!.key, manifestSha256: manifest.manifestSha256 }, allow);
    expect(result.imported?.buffer.toString()).toBe('memo');
    expect(get.mock.calls.every(call => (call as unknown as [string, Record<string,string>])[1]?.Prefer === 'IdType="ImmutableId"')).toBe(true);
  });
  it.each([
    ['CID', part({ headers: [{ name: 'Content-ID', value: '<image>' }] }), 'inline_or_cid'],
    ['inline', part({ headers: [{ name: 'Content-Disposition', value: 'inline' }] }), 'inline_or_cid'],
    ['nested message', part({ mimeType: 'message/rfc822', parts: [part()] }), 'embedded_message'],
    ['unproven disposition', part({ headers: [] }), 'unsupported_disposition'],
    ['oversize', part({ body: { size: INCOMING_FILE_MAX_BYTES + 1, attachmentId: 'file' } }), 'file_too_large'],
  ])('keeps %s explicit and refuses any file-byte fetch', async (_label, file, reason) => {
    const get = jest.fn(async () => message([file as ReturnType<typeof part>]));
    const manifest = await readIncomingProviderFiles(source, get, undefined, allow);
    expect(manifest.files[0]?.handoff).toBe(reason);
    await expect(readIncomingProviderFiles(source, get, { fileKey: manifest.files[0]!.key, manifestSha256: manifest.manifestSha256 }, allow)).rejects.toBeInstanceOf(IncomingFilesHandoff);
    expect(get).toHaveBeenCalledTimes(2);
  });
  it('does not invent empty success for duplicate attachment IDs, excessive parts or unknown MIME', () => {
    expect(() => gmailIncomingFiles(message([part(), part({ partId: '2' })]), source)).toThrow('ambiguous_attachment_ids');
    expect(() => gmailIncomingFiles(message(Array.from({length:101}, (_, i) => part({partId:String(i)}))), source)).toThrow();
    expect(() => gmailIncomingFiles(message([part({filename:'',headers:[],mimeType:'application/unknown'})]), source)).toThrow('unsupported_mime_part');
    expect(() => gmailIncomingFiles({...message(), payload:{...message().payload,mimeType:'multipart/encrypted'}},source)).toThrow('unsupported_mime_container');
    expect(() => graphIncomingFiles({ value: [graphFile()], '@odata.nextLink': 'https://evil.test/' }, graphSource)).toThrow('file_count_or_page_limit');
  });
  it('keeps Graph item/reference variants as mailbox handoffs', () => {
    expect(graphIncomingFiles({value:[graphFile({'@odata.type':'#microsoft.graph.itemAttachment'})]},graphSource)[0]?.handoff).toBe('item_or_reference_attachment');
    expect(graphIncomingFiles({value:[graphFile({contentId:'cid'})]},graphSource)[0]?.handoff).toBe('inline_or_cid');
  });
  it('refuses changed manifests, source history and unsupported MIME before byte fetch', async () => {
    const get = jest.fn(async () => message());
    const manifest = await readIncomingProviderFiles(source, get, undefined, allow);
    await expect(readIncomingProviderFiles(source, get, {fileKey:manifest.files[0]!.key,manifestSha256:'0'.repeat(64)},allow)).rejects.toThrow('file list changed');
    await expect(readIncomingProviderFiles(source, get, {fileKey:manifest.files[0]!.key,manifestSha256:manifest.manifestSha256},()=>false)).rejects.toThrow('unsupported_file_type');
    expect(() => gmailIncomingFiles({...message(),historyId:'13'},source)).toThrow('original message changed');
    expect(get).toHaveBeenCalledTimes(3);
  });
  it('decodes exact bounded bytes and refuses malformed/size-mismatched base64', () => {
    const bytes=Buffer.alloc(INCOMING_FILE_MAX_BYTES,1);
    expect(decodeIncomingFile(bytes.toString('base64'),bytes.length,'base64')).toEqual(bytes);
    expect(()=>decodeIncomingFile('bWVtbw==',3,'base64')).toThrow();
    expect(()=>decodeIncomingFile('bWVtbw!!',4,'base64')).toThrow();
    expect(()=>decodeIncomingFile('',INCOMING_FILE_MAX_BYTES+1,'base64')).toThrow();
  });
  it('bounds actual response bytes and refuses redirects and unavailable sources without exposing driver text', async () => {
    const original=global.fetch;
    const fetcher=jest.fn().mockResolvedValueOnce(new Response('private provider text',{status:403}))
      .mockResolvedValueOnce(new Response('x'.repeat(4*1024*1024+262145)));
    global.fetch=fetcher;
    try {
      await expect(incomingProviderGet('https://gmail.googleapis.com/gmail/v1/users/me/messages/m','synthetic')).rejects.toThrow('Incoming files could not be read');
      expect(fetcher.mock.calls[0][1]).toMatchObject({method:'GET',redirect:'error'});
      await expect(incomingProviderGet('https://graph.microsoft.com/v1.0/me/messages/m','synthetic')).rejects.toThrow('provider_response_limit');
      await expect(incomingProviderGet('https://evil.test/','synthetic')).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {global.fetch=original;}
  });
});
