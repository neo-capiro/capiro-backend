import { beforeAll, afterAll, beforeEach, it, expect, jest } from '@jest/globals';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { EngagementService } from '../../src/engagement/engagement.service.js';
import { fixture, actor, tenant, client, ctx, foreign, outsider, id, settled } from './fixture.js';

// Actual Mail/Prisma owners below never sanitize HTML; refuse if a write path is entered.
// Production sanitizer ESM import compatibility is a separate gate.
jest.mock('sanitize-html', () => {
  const fail = () => { throw new Error('Unexpected sanitizer in a Mail read fixture'); };
  return Object.assign(fail, { simpleTransform: () => fail });
});
let h: Awaited<ReturnType<typeof fixture>>;
let service: EngagementService;
const box = id(900), thread = id(1001), message = id(10011);
const asOf = '2026-10-01T12:00:00.000Z';
beforeAll(async () => {
  h = await fixture('mail');
  service = Object.create(EngagementService.prototype) as EngagementService;
  Object.assign(service, { prisma: h.prisma });
});
afterAll(async () => { await h?.close(); });
beforeEach(async () => {
  await h.reset();
  await h.sql(`INSERT INTO engagement_connections(id,tenant_id,provider,account_email,created_by_user_id)
    VALUES($1,$2,'google_workspace','owner@example.test',$3)`, [box, tenant, actor]);
  await h.sql(`INSERT INTO mail_threads(id,tenant_id,client_id,connection_id,subject,snippet,participants_jsonb,
    last_message_at,created_at,updated_at)
    SELECT ('00000000-0000-4000-8000-'||lpad(to_hex(1000+n),12,'0'))::uuid,$1,$2,$3,
      'Synthetic thread '||n,'Stored preview','[{"email":"person@example.test"}]',
      '2026-09-20T12:00:00Z'::timestamptz,'2026-09-01T00:00:00Z'::timestamptz,'2026-09-20T12:00:00Z'::timestamptz
    FROM generate_series(1,60) n`, [tenant, client, box]);
  await h.sql(`INSERT INTO mail_messages(id,tenant_id,thread_id,connection_id,subject,from_email,to_recipients_jsonb,
    body_text,sent_at,received_at,created_at,updated_at,metadata_jsonb)
    SELECT ('00000000-0000-4000-8000-'||lpad(to_hex(10000+n*10+j),12,'0'))::uuid,$1,
      ('00000000-0000-4000-8000-'||lpad(to_hex(1000+n),12,'0'))::uuid,$2,'Synthetic message',
      'person@example.test','[{"email":"owner@example.test"}]','Exact stored body '||j,
      '2026-09-20T12:00:00Z'::timestamptz,'2026-09-20T12:00:00Z'::timestamptz,
      '2026-09-20T12:00:00Z'::timestamptz,'2026-09-20T12:00:00Z'::timestamptz,'{"folder":"inbox","bodyCompleteness":"full"}'
    FROM generate_series(1,60) n CROSS JOIN generate_series(1,7) j`, [tenant, box]);
});
const list = (extra = {}) => service.listMailThreadPage(ctx, { clientId: client, asOf, ...extra });
const detail = (extra = {}) => service.getMailThread(ctx, thread, client, undefined, { asOf, ...extra });
const contact = (extra = {}, scope = ctx) => service.getMailThreadHttpPage(scope, thread, undefined,
  { asOf, associationClientId: client, recipientEmails: ['person@example.test'], ...extra });

it('pages beyond fifty owned threads with bounded previews and honest incomplete coverage', async () => {
  const first = await list();
  expect(first.items).toHaveLength(50); expect(first.hasMore).toBe(true);
  expect((first.items[0]!.messages as unknown[])).toHaveLength(3);
  expect(first.mailboxes).toHaveLength(1); expect(first.mailboxes[0]!.coverage.backfillComplete).toBe(false);
  const last = await list({ cursor: first.nextCursor });
  expect(last.items).toHaveLength(10); expect(last.hasMore).toBe(false); expect(last.nextCursor).toBeNull();
  expect(new Set([...first.items, ...last.items].map(row => row.id)).size).toBe(60);
  expect(first.asOf).toBe(last.asOf);
  expect(await service.listMailThreads(ctx, { clientId: client })).toHaveLength(50);
});

it('pages exact PostgreSQL microsecond and null sort ties without rounding away an item', async () => {
  await h.sql('DELETE FROM mail_threads WHERE id NOT IN ($1,$2,$3)', [id(1001), id(1002), id(1003)]);
  await h.sql(`UPDATE mail_threads SET last_message_at='2026-09-20T12:00:00.000456Z',
    updated_at=CASE WHEN id=$1 THEN '2026-09-20T12:00:00.000123Z'::timestamptz
      ELSE '2026-09-20T12:00:00.000122Z'::timestamptz END`, [id(1001)]);
  await h.sql('UPDATE mail_threads SET last_message_at=NULL WHERE id=$1', [id(1003)]);
  const first = await list({ limit: 1 });
  const second = await list({ limit: 1, cursor: first.nextCursor });
  const third = await list({ limit: 1, cursor: second.nextCursor });
  expect([first.items[0]!.id, second.items[0]!.id, third.items[0]!.id]).toEqual([id(1001), id(1002), id(1003)]);
  expect(third.nextCursor).toBeNull();
});

it('bounds very large thread selection in Prisma and returns exact chronological message pages', async () => {
  await h.sql(`INSERT INTO mail_messages(id,tenant_id,thread_id,connection_id,body_text,created_at,updated_at)
    SELECT ('00000000-0000-4000-8000-'||lpad(to_hex(100000+n),12,'0'))::uuid,$1,$2,$3,
      repeat('Large stored body ',1000),'2026-09-20T12:00:00Z','2026-09-20T12:00:00Z'
    FROM generate_series(1,2000) n`, [tenant, thread, box]);
  const first = await detail();
  expect(first.totalMessages).toBe(2007); expect(first.messages).toHaveLength(3);
  expect(first.messages.map(row => row.id)).toEqual([id(10011), id(10012), id(10013)]);
  const next = await detail({ cursor: first.nextCursor });
  expect(next.messages.map(row => row.id)).toEqual([id(10014), id(10015), id(10016)]);
  expect(next.hasMore).toBe(true); expect(next.asOf).toBe(asOf);
});

it('caps a historical oversized HTTP body and keeps exact Unicode/hash continuation', async () => {
  const body = 'A'.repeat(5999) + '😀' + 'Z'.repeat(2_000_000);
  await h.sql('UPDATE mail_messages SET body_text=$1 WHERE id=$2', [body, message]);
  const first = await service.getMailThreadHttpPage(ctx, thread, client, { asOf, messageId: message });
  const part = first.messages[0]!;
  expect(part.bodyText).toHaveLength(5999); expect(part.bodyLength).toBe(body.length);
  expect(JSON.stringify(first).length).toBeLessThan(15000);
  const next = await service.getMailThreadHttpPage(ctx, thread, client, { asOf, messageId: message,
    bodyOffset: part.nextBodyOffset, expectedBodySha256: part.bodySha256 });
  expect(next.messages[0]!.bodyText).toBe(body.slice(5999,11999));
  expect(next.messages[0]!.bodySha256).toBe(part.bodySha256);
  await h.sql('UPDATE mail_messages SET body_text=body_text||$1 WHERE id=$2', ['changed', message]);
  await expect(service.getMailThreadHttpPage(ctx, thread, client, { asOf, messageId: message,
    bodyOffset: part.nextBodyOffset, expectedBodySha256: part.bodySha256 })).rejects.toBeInstanceOf(ConflictException);
});

it('keeps asOf/date/folder/literal search and exact recipient association inside the owned SQL', async () => {
  await h.sql(`UPDATE clients SET primary_contact_email='PERSON@EXAMPLE.TEST' WHERE id=$1`, [client]);
  await h.sql('UPDATE mail_threads SET client_id=NULL');
  expect((await list({ recipientEmails: ['person@example.test'], folder: 'inbox', withinDays: 14 })).items).toHaveLength(50);
  expect((await list({ folder: 'sent' })).items).toHaveLength(0);
  expect((await list({ query: 'not%_stored' })).items).toHaveLength(0);
  await h.sql('UPDATE mail_messages SET body_text=$1 WHERE thread_id=$2', ['literal not%_stored', thread]);
  expect((await list({ query: 'not%_stored' })).items.map(row => row.id)).toEqual([thread]);
  await h.sql(`UPDATE mail_messages SET created_at='2026-10-02T00:00:00Z' WHERE thread_id=$1`, [thread]);
  expect((await list({ query: 'not%_stored' })).items).toHaveLength(0);
});

it('rejects message deletion/reordering after an earlier page and refuses a removed cited message', async () => {
  const first = await detail();
  await h.sql(`UPDATE mail_messages SET removed_at=now() WHERE id=$1`, [message]);
  await h.sql(`UPDATE mail_threads SET updated_at=now() WHERE id=$1`, [thread]);
  await expect(detail({ cursor: first.nextCursor })).rejects.toBeInstanceOf(ConflictException);
  await expect(detail({ requiredMessageId: message })).rejects.toBeInstanceOf(NotFoundException);
  const refreshed = await detail(); expect(refreshed.totalMessages).toBe(6);
  expect(refreshed.messages[0]!.id).toBe(id(10012));
});

it('rechecks current member role, tenant state and client wall on every continuation', async () => {
  const first = await detail();
  await h.sql(`UPDATE tenant_memberships SET role='client_portal_user' WHERE tenant_id=$1 AND user_id=$2`, [tenant, actor]);
  await expect(detail({ cursor: first.nextCursor })).rejects.toBeInstanceOf(NotFoundException);
  await h.sql(`UPDATE tenant_memberships SET role='standard_user' WHERE tenant_id=$1 AND user_id=$2`, [tenant, actor]);
  await h.sql(`UPDATE tenants SET status='suspended' WHERE id=$1`, [tenant]);
  await expect(list()).rejects.toBeInstanceOf(NotFoundException);
  await h.sql(`UPDATE tenants SET status='active' WHERE id=$1`, [tenant]);
  await h.sql('UPDATE clients SET memory_wall=true WHERE id=$1', [client]);
  await expect(detail()).rejects.toBeInstanceOf(NotFoundException);
  await expect(list()).rejects.toBeInstanceOf(NotFoundException);
  await h.sql('INSERT INTO client_memory_access(tenant_id,client_id,user_id) VALUES($1,$2,$3)', [tenant,client,actor]);
  expect((await detail()).messages).toHaveLength(3);
  await h.sql('DELETE FROM client_memory_access WHERE user_id=$1', [actor]);
  await expect(detail()).rejects.toBeInstanceOf(NotFoundException);
});

it('refuses foreign owners, wrong tenants and disconnected account lineage without leaking history', async () => {
  await expect(service.getMailThread({ ...ctx, userId: outsider }, thread)).rejects.toBeInstanceOf(NotFoundException);
  await expect(service.getMailThread({ ...ctx, tenantId: foreign }, thread)).rejects.toBeInstanceOf(NotFoundException);
  expect((await service.listMailThreadPage({ ...ctx, userId: outsider }, { asOf })).items).toHaveLength(0);
  await h.sql('DELETE FROM engagement_connections WHERE id=$1', [box]);
  await expect(detail()).rejects.toBeInstanceOf(NotFoundException);
  const empty = await list(); expect(empty.items).toHaveLength(0); expect(empty.mailboxes).toHaveLength(0);
});

it('retains live list refresh semantics instead of invalidating unrelated pages on sync', async () => {
  const first = await list({ limit: 2 }); const moved = first.items[0]!.id;
  await h.sql(`UPDATE mail_threads SET last_message_at='2026-09-01T00:00:00Z',updated_at=now() WHERE id=$1`, [moved]);
  const next = await list({ limit: 2, cursor: first.nextCursor });
  expect(next.items).toHaveLength(2); expect(next.notice).toContain('deduplicate');
  const refreshed = await list({ limit: 2 }); expect(refreshed.items[0]!.id).not.toBe(moved);
  await expect(list({ limit: 1, cursor: first.nextCursor })).rejects.toBeInstanceOf(BadRequestException);
});

it('opens an unassigned Contact association while preserving exact-client reads and cursor binding', async () => {
  await h.sql('UPDATE mail_threads SET client_id=NULL WHERE id=$1', [thread]);
  const first = await contact();
  expect(first.clientId).toBeNull(); expect(first.associationClientId).toBe(client);
  expect(first.messages).toHaveLength(3);
  await expect(detail()).rejects.toBeInstanceOf(NotFoundException);
  expect((await contact({ cursor: first.nextCursor })).messageOffset).toBe(3);
  await expect(contact({ cursor: first.nextCursor, recipientEmails: ['other@example.test'] }))
    .rejects.toBeInstanceOf(BadRequestException);
  await expect(service.getMailThreadHttpPage(ctx, thread, client, { associationClientId: client }))
    .rejects.toBeInstanceOf(BadRequestException);
});

it('revokes Contact detail under the selected-client wall, current membership, tenant and actor', async () => {
  const first = await contact();
  await h.sql('UPDATE clients SET memory_wall=true WHERE id=$1', [client]);
  await expect(contact({ cursor: first.nextCursor })).rejects.toBeInstanceOf(NotFoundException);
  await h.sql('INSERT INTO client_memory_access(tenant_id,client_id,user_id) VALUES($1,$2,$3)', [tenant,client,actor]);
  expect((await contact()).messages).toHaveLength(3);
  await h.sql(`UPDATE tenant_memberships SET status='removed' WHERE tenant_id=$1 AND user_id=$2`, [tenant,actor]);
  await expect(contact()).rejects.toBeInstanceOf(NotFoundException);
  await h.sql(`UPDATE tenant_memberships SET status='active' WHERE tenant_id=$1 AND user_id=$2`, [tenant,actor]);
  await expect(contact({}, { ...ctx, userId: outsider })).rejects.toBeInstanceOf(NotFoundException);
  await expect(contact({}, { ...ctx, tenantId: foreign })).rejects.toBeInstanceOf(NotFoundException);
  await h.sql('DELETE FROM client_memory_access WHERE user_id=$1', [actor]);
  await expect(contact()).rejects.toBeInstanceOf(NotFoundException);
});

it('never grants Contact association through inactive, future, foreign-tenant or other-connection messages', async () => {
  await h.sql('UPDATE mail_threads SET client_id=NULL WHERE id=$1', [thread]);
  await h.sql(`UPDATE mail_messages SET from_email='unrelated@example.test' WHERE thread_id=$1`, [thread]);
  await h.sql(`UPDATE mail_messages SET from_email='person@example.test',removed_at=now() WHERE id=$1`, [message]);
  await expect(contact()).rejects.toBeInstanceOf(NotFoundException);
  await h.sql(`UPDATE mail_messages SET removed_at=NULL,created_at='2026-10-02T00:00:00Z' WHERE id=$1`, [message]);
  await expect(contact()).rejects.toBeInstanceOf(NotFoundException);
  await h.sql(`UPDATE mail_messages SET created_at='2026-09-20T12:00:00Z',tenant_id=$1 WHERE id=$2`, [foreign,message]);
  await expect(contact()).rejects.toBeInstanceOf(NotFoundException);
  await h.sql(`INSERT INTO engagement_connections(id,tenant_id,provider,created_by_user_id)
    VALUES($1,$2,'google_workspace',$3)`, [id(901),tenant,outsider]);
  await h.sql('UPDATE mail_messages SET tenant_id=$1,connection_id=$2 WHERE id=$3', [tenant,id(901),message]);
  await expect(contact()).rejects.toBeInstanceOf(NotFoundException);
  await h.sql('UPDATE mail_messages SET connection_id=$1 WHERE id=$2', [box,message]);
  expect((await contact()).messages).toHaveLength(3);
});

it('uses one repeatable read for metadata/count/page while a concurrent write commits', async () => {
  const lock = await h.lock('LOCK TABLE mail_messages IN ACCESS EXCLUSIVE MODE');
  const pending = settled(detail());
  let committed = false;
  try {
    await h.waitForLock('mail_messages');
    await lock.query('UPDATE mail_messages SET removed_at=now() WHERE id=$1', [message]);
    await lock.query('UPDATE mail_threads SET updated_at=now() WHERE id=$1', [thread]);
    await lock.query('COMMIT');
    committed = true;
  } finally {
    try { if (!committed) await lock.query('ROLLBACK'); }
    finally { lock.release(); }
  }
  const result = await pending;
  expect(result.error).toBeUndefined(); expect(result.value!.totalMessages).toBe(7);
  expect(result.value!.messages[0]!.id).toBe(message);
  await expect(detail({ cursor: result.value!.nextCursor })).rejects.toBeInstanceOf(ConflictException);
});
