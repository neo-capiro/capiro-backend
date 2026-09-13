import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { LegiWatchLifecycleNotificationService } from './legiwatch-lifecycle-notification.service.js';

if (
  process.env.LEGIWATCH_RECORDING_TEST_DATABASE !== 'disposable' ||
  !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname)
)
  throw Error('Local disposable PostgreSQL required');

describe('approved hearing version in the existing inbox', () => {
  const p = new PrismaService({ transactionOptions: { maxWait: 10000, timeout: 10000 } }),
    service = new LegiWatchLifecycleNotificationService(p);
  const sibling = new PrismaService({ transactionOptions: { maxWait: 10000, timeout: 10000 } });
  const tenantId = randomUUID(),
    internalUser = randomUUID(),
    actor = 'inbox-' + randomUUID(),
    sessionId = 'inbox-session-' + randomUUID();
  const publicationId = randomUUID(),
    contentHash = 'a'.repeat(64);
  const input = {
    tenantId,
    userId: actor,
    publicationId,
    contentHash,
    title: 'Unofficial owned testimony update',
    body: 'A speaker recommended bridge inspections. Evidence: fixture-final (1–5 seconds).',
  };
  beforeAll(async () => {
    await p.$executeRaw`INSERT INTO tenants(id,slug,name) VALUES(${tenantId}::uuid,${'inbox-' + tenantId},'Owned inbox fixture')`;
    await p.$executeRaw`INSERT INTO users(id,clerk_user_id,email) VALUES(${internalUser}::uuid,${actor},${actor + '@example.invalid'})`;
    await p.$executeRaw`INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES(${tenantId}::uuid,${internalUser}::uuid,'standard_user','active')`;
    await p.$executeRaw`INSERT INTO intel_feature_flag(id,tenant_id,feature,enabled,created_at) VALUES(${randomUUID()},${tenantId},'legiwatch_hearing_updates_v1',true,now())`;
    await p.$executeRaw`INSERT INTO intel_live_hearing_session(id,tenant_id,created_by,title,source_type,audio_source,recording_policy,status,consent_status,issue_ids,bill_ids,program_element_ids,agency_ids,updated_at)
      VALUES(${sessionId},${tenantId},${actor},'Owned private session','meeting','browser_mic','transcript_only','ended','confirmed',ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],now())`;
    await p.$executeRaw`INSERT INTO intel_hearing_publication(id,tenant_id,session_id,owner_clerk_id,series_id,version,kind,status,content_hash,payload,approved_at,approved_by)
      VALUES(${publicationId},${tenantId},${sessionId},${actor},${publicationId},1,'live_update','draft',${contentHash},'{}'::jsonb,NULL,NULL)`;
    await p.$executeRaw`UPDATE intel_hearing_publication SET status='approved',approved_at=now(),approved_by=${actor} WHERE id=${publicationId}`;
  });
  afterAll(async () => {
    await p.$disconnect();
    await sibling.$disconnect();
  });
  it('is idempotent and visible under the actual API user UUID', async () => {
    const outcomes = await Promise.all([
      service.emitHearingPublication(input),
      new LegiWatchLifecycleNotificationService(sibling).emitHearingPublication(input),
    ]);
    expect(outcomes.reduce((sum, result) => sum + result.created, 0)).toBe(1);
    const page = await service.inbox({ tenantId, userId: internalUser } as any, {});
    expect(page.total).toBe(1);
    expect((page.rows as any[])[0]).toMatchObject({
      eventType: 'live_update',
      title: input.title,
      deepLink: '/intelligence/hearing-watch/' + sessionId + '?publication=' + publicationId,
    });
  });
  it('deduplicates typed keyword inbox events and honors its independent runtime and membership gates', async () => {
    const prior = process.env.LEGIWATCH_KEYWORD_DELIVERY_ENABLED;
    const keyword = {
      tenantId,
      userId: actor,
      billId: 'fl-keyword-' + randomUUID(),
      eventKey: randomUUID(),
      title: 'Synthetic keyword match',
      body: 'Reviewed source excerpt',
    };
    try {
      await p.$executeRaw`INSERT INTO intel_feature_flag(id,tenant_id,feature,enabled,created_at) VALUES(${randomUUID()},${tenantId},'legiwatch_keyword_delivery_v1',true,now())`;
      process.env.LEGIWATCH_KEYWORD_DELIVERY_ENABLED = 'false';
      expect(await service.emitKeyword(keyword)).toMatchObject({ created: 0, suppressed: true });
      process.env.LEGIWATCH_KEYWORD_DELIVERY_ENABLED = 'true';
      const results = await Promise.all([
        service.emitKeyword(keyword),
        new LegiWatchLifecycleNotificationService(sibling).emitKeyword(keyword),
      ]);
      expect(results.reduce((n, result) => n + result.created, 0)).toBe(1);
      const page = await service.inbox({ tenantId, userId: internalUser } as any, {});
      expect((page.rows as any[]).find((row) => row.eventType === 'bill_keyword')).toMatchObject({
        title: keyword.title,
        deepLink: '/bills/' + keyword.billId,
      });
      expect(await service.emitKeyword({ ...keyword, userId: 'removed-owner' })).toMatchObject({
        created: 0,
        suppressed: true,
      });
    } finally {
      if (prior === undefined) delete process.env.LEGIWATCH_KEYWORD_DELIVERY_ENABLED;
      else process.env.LEGIWATCH_KEYWORD_DELIVERY_ENABLED = prior;
    }
  });
  it('rejects an altered version hash, another owner, and removed membership', async () => {
    expect(
      await service.emitHearingPublication({ ...input, contentHash: 'b'.repeat(64) }),
    ).toMatchObject({ created: 0, suppressed: true });
    expect(
      await service.emitHearingPublication({ ...input, userId: 'different-owner' }),
    ).toMatchObject({ created: 0, suppressed: true });
    await p.$executeRaw`UPDATE tenant_memberships SET status='removed' WHERE tenant_id=${tenantId}::uuid`;
    expect(await service.emitHearingPublication(input)).toMatchObject({
      created: 0,
      suppressed: true,
    });
  });
});
