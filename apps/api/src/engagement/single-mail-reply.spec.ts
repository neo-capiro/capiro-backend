import { gmailReplyIdentity, graphReplyIdentity, prepareMailReply, storedGraphReplyIdentity } from './single-mail-reply.js';

function graphFixture() {
  const mailbox = (address: string) => ({ emailAddress: { address } });
  const detail: any = { id: 'Immutable-Source', conversationId: 'conversation', changeKey: 'version-1',
    isDraft: false, subject: 'Reviewed subject', from: mailbox('person@example.test'), sender: mailbox('person@example.test'),
    replyTo: [], internetMessageId: '<source@example.test>', internetMessageHeaders: [{ name: 'Message-ID', value: '<source@example.test>' }] };
  const source = { id: 'local-original', threadId: 'local-thread', connectionId: 'box', source: 'outlook', externalId: 'default-source',
    subject: detail.subject as string, fromEmail: 'person@example.test', updatedAt: new Date('2026-10-26T20:00:00Z'), removedAt: null as Date | null,
    raw: { graphReplySource: { schema: 'graph-native-reply/1', defaultId: 'default-source', identity: graphReplyIdentity(detail) } } };
  const thread = { id: source.threadId, connectionId: 'box', source: 'outlook', externalId: 'conversation' };
  const connection = { id: 'box', provider: 'microsoft_365', status: 'connected', accountEmail: 'me@example.test' };
  return { detail, source, thread, connection, prepare: (self: string[] = []) => prepareMailReply(source, thread, connection, self) };
}

describe('captured incoming Outlook reply source', () => {
  test('captured empty Reply-To uses From, preserves immutable/default identity separation and keeps provider proof private', () => {
    const h = graphFixture(), prepared = h.prepare()!;
    expect(prepared.provider).toMatchObject({ immutableId: 'Immutable-Source', toEmail: 'person@example.test', replyTo: [] });
    expect(prepared.context).toMatchObject({ originalMessageId: 'local-original', to: [{ email: 'person@example.test' }] });
    expect(JSON.stringify(prepared.context)).not.toMatch(/Immutable|default-source|changeKey/);
    expect(storedGraphReplyIdentity(prepared.provider)).toEqual(prepared.provider);
  });
  test('one explicit Reply-To is the reviewed destination', () => {
    const h = graphFixture(); h.detail.replyTo = [{ emailAddress: { address: 'reply@example.test' } }];
    h.source.raw.graphReplySource.identity = graphReplyIdentity(h.detail);
    expect(h.prepare()?.context.to).toEqual([{ email: 'reply@example.test' }]);
    expect(h.prepare(['reply@example.test'])).toBeNull();
  });
  test.each(['missing-reply-to', 'multiple-reply-to', 'draft', 'delegated', 'message-id', 'duplicate-header', 'missing-version'])('refuses %s evidence', kind => {
    const h = graphFixture();
    if (kind === 'missing-reply-to') delete h.detail.replyTo;
    if (kind === 'multiple-reply-to') h.detail.replyTo = [h.detail.from, h.detail.from];
    if (kind === 'draft') h.detail.isDraft = true;
    if (kind === 'delegated') h.detail.sender = { emailAddress: { address: 'delegate@example.test' } };
    if (kind === 'message-id') h.detail.internetMessageId = '<other@example.test>';
    if (kind === 'duplicate-header') h.detail.internetMessageHeaders.push(h.detail.internetMessageHeaders[0]);
    if (kind === 'missing-version') delete h.detail.changeKey;
    expect(graphReplyIdentity(h.detail)).toBeNull();
  });
  test.each(['missing-capture', 'default-id', 'conversation', 'mailbox', 'removed', 'self', 'untyped-extra'])('refuses %s current lineage', kind => {
    const h = graphFixture();
    if (kind === 'missing-capture') h.source.raw.graphReplySource.schema = 'untrusted';
    if (kind === 'default-id') h.source.externalId = 'Immutable-Source';
    if (kind === 'conversation') h.thread.externalId = 'another';
    if (kind === 'mailbox') h.source.connectionId = 'another';
    if (kind === 'removed') h.source.removedAt = new Date();
    if (kind === 'self') h.connection.accountEmail = 'person@example.test';
    if (kind === 'untyped-extra') Object.assign(h.source.raw.graphReplySource.identity!, { guessed: true });
    expect(h.prepare()).toBeNull();
  });
});

function fixture() {
  const raw = { id: 'provider-original', threadId: 'provider-thread', labelIds: ['INBOX'], payload: { headers: [
    { name: 'From', value: 'Person <person@example.test>' }, { name: 'Reply-To', value: 'Reply <reply@example.test>' },
    { name: 'Subject', value: 'Reviewed subject' }, { name: 'Message-ID', value: '<original@example.test>' },
    { name: 'References', value: '<first@example.test>' },
  ] } };
  const source = { id: 'local-original', threadId: 'local-thread', connectionId: 'box', source: 'google',
    externalId: raw.id, subject: 'Reviewed subject', fromEmail: 'person@example.test',
    updatedAt: new Date('2026-10-26T20:00:00Z'), removedAt: null as Date | null, raw };
  const thread = { id: 'local-thread', connectionId: 'box', source: 'google', externalId: raw.threadId };
  const connection = { id: 'box', provider: 'google_workspace', status: 'connected', accountEmail: 'me@example.test' };
  return { raw, source, thread, connection, prepare: (self: string[] = []) => prepareMailReply(source, thread, connection, self) };
}

describe('exact bounded incoming Gmail reply source', () => {
  it('uses Reply-To, exact subject and RFC ancestry without exposing provider identity in review', () => {
    const h = fixture(), reply = h.prepare()!;
    expect(reply.provider).toEqual({ messageId: h.raw.id, threadId: h.raw.threadId,
      inReplyTo: '<original@example.test>', references: '<first@example.test> <original@example.test>',
      subject: 'Reviewed subject', toEmail: 'reply@example.test', fromEmail: 'person@example.test' });
    expect(reply.context).toEqual({ supported: true, operation: 'reply', originalMessageId: h.source.id,
      originalUpdatedAt: '2026-10-26T20:00:00.000Z', senderConnectionId: 'box',
      subject: 'Reviewed subject', to: [{ email: 'reply@example.test' }] });
    expect(JSON.stringify(reply.context)).not.toContain('provider-');
  });
  it('uses From only when Reply-To is absent', () => {
    const h = fixture(); h.raw.payload.headers.splice(1, 1);
    expect(h.prepare()?.provider.toEmail).toBe('person@example.test');
  });
  it.each(['SENT', 'DRAFT', 'TRASH', 'SPAM'])('refuses %s originals', label => {
    const h = fixture(); h.raw.labelIds.push(label); expect(h.prepare()).toBeNull();
  });
  it.each(['removed', 'connection', 'thread', 'source', 'provider-id', 'thread-id', 'subject', 'sender', 'disconnected'])
    ('refuses changed %s lineage', change => {
      const h = fixture();
      if (change === 'removed') h.source.removedAt = new Date();
      if (change === 'connection') h.source.connectionId = 'other';
      if (change === 'thread') h.source.threadId = 'other';
      if (change === 'source') h.source.source = 'manual';
      if (change === 'provider-id') h.raw.id = 'other';
      if (change === 'thread-id') h.raw.threadId = 'other';
      if (change === 'subject') h.source.subject = 'other';
      if (change === 'sender') h.source.fromEmail = 'other@example.test';
      if (change === 'disconnected') h.connection.status = 'error';
      expect(h.prepare()).toBeNull();
    });
  it.each(['person@example.test', 'reply@example.test'])('refuses known self address %s', email => {
    expect(fixture().prepare([email])).toBeNull();
  });
  it.each([
    ['Message-ID', 'provider-opaque-id'], ['Message-ID', '<x@example.test>\r\nBcc: injected@example.test'],
    ['Reply-To', 'a@example.test,b@example.test'], ['Reply-To', 'broken'],
    ['References', '<first@example.test> <first@example.test>'], ['References', 'bad'],
    ['Subject', 'changed\nsubject'], ['References', '<x@example.test> '.repeat(51)],
  ])('refuses malformed %s', (name, value) => {
    const h = fixture(); h.raw.payload.headers.find(header => header.name === name)!.value = value;
    expect(gmailReplyIdentity(h.raw)).toBeNull();
  });
  it.each(['From', 'Reply-To', 'Subject', 'Message-ID', 'References'])('rejects duplicate case-insensitive %s', name => {
    const h = fixture(); const header = h.raw.payload.headers.find(header => header.name === name)!;
    h.raw.payload.headers.push({ name: name.toLowerCase(), value: header.value });
    expect(h.prepare()).toBeNull();
  });
});
