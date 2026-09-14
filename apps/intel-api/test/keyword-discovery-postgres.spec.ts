import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { FolderSourceDataRepository } from '../src/sourcedata/folder-source-data.repository.js';
import { SourceDataRepository } from '../src/sourcedata/source-data.repository.js';
import { KeywordSourceRepository } from '../src/sourcedata/keyword-source.repository.js';
import { FolderTrackerService } from '../src/tracker/folders/folder-tracker.service.js';
import { ReportService } from '../src/tracker/reports/report.service.js';
import { KeywordRuleService } from '../src/tracker/keywords/keyword-rule.service.js';
import { KeywordDiscoveryService } from '../src/tracker/keywords/keyword-discovery.service.js';
import { FeatureFlagService } from '../src/feature-flags/feature-flag.service.js';
import {
  membershipState,
  writeMembershipDecision,
} from '../src/tracker/folders/folder-decisions.js';
import type { WorkspaceTenantContext } from '../src/auth/tenant-context.js';
import type { KeywordRule } from '../src/tracker/keywords/keyword-domain.js';

jest.setTimeout(90000);
describe('Phase 6 real PostgreSQL decisions and paged discovery', () => {
  const p = new PrismaService(),
    folders = new FolderTrackerService(
      p,
      new FolderSourceDataRepository(p),
      new SourceDataRepository(p),
    );
  const reports = new ReportService(folders, new FeatureFlagService(p, new ConfigService()));
  const sources = new KeywordSourceRepository(p),
    rules = new KeywordRuleService(reports, sources),
    discovery = new KeywordDiscoveryService(rules);
  const tenant = randomUUID(),
    actor = 'phase6-' + randomUUID(),
    session = 'phase6-' + randomUUID().slice(0, 8),
    foreign = randomUUID();
  const ctx: WorkspaceTenantContext = { tenantId: tenant, clerkUserId: actor, role: 'org:admin' };
  let folderId: string, secondId: string, rule: KeywordRule, runId: string;
  const billIds = Array.from({ length: 326 }, (_, i) => `${session}-${String(i).padStart(4, '0')}`);
  beforeAll(async () => {
    if (
      process.env.LEGIWATCH_PHASE6_TEST_DATABASE !== 'disposable' ||
      !process.env.DATABASE_URL ||
      !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname)
    )
      throw Error('Explicit disposable local Phase 6 database required');
    await p.$connect();
    await p.withSystem(async (tx) => {
      await tx.$executeRaw`INSERT INTO tenants(id,slug,name) VALUES(${tenant}::uuid,${tenant},'Synthetic Phase 6'),(${foreign}::uuid,${foreign},'Synthetic foreign')`;
      const user = randomUUID();
      await tx.$executeRaw`INSERT INTO users(id,clerk_user_id,email) VALUES(${user}::uuid,${actor},${actor + '@example.invalid'})`;
      await tx.$executeRaw`INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES(${tenant}::uuid,${user}::uuid,'standard_user','active')`;
      await tx.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title)
    SELECT x,'FL',${session},${session},'HB '||n,'hb'||n,CASE WHEN n=326 THEN 'Unrelated education measure' ELSE 'Synthetic health measure' END
    FROM unnest(${billIds}::text[]) WITH ORDINALITY AS u(x,n)`;
      await tx.featureFlag.create({
        data: { tenantId: tenant, feature: 'legiwatch_keyword_discovery_v1', enabled: true },
      });
    });
    folderId = (await folders.create(ctx, { name: 'Synthetic scope' })).id;
    secondId = (await folders.create(ctx, { name: 'Synthetic scope' })).id;
    rule = await rules.save(ctx, {
      name: 'Synthetic reviewed query',
      config: {
        scope: { jurisdiction: 'FL', sessionKey: session, fields: ['title'] },
        folderIds: [folderId, secondId],
        definitions: [{ id: 'synthetic-health', raw: 'health' }],
        aggregation: 'any-v1',
        semanticsReviewed: true,
        mode: 'suggest',
        cadence: 'realtime',
      },
    });
  });
  afterAll(async () => {
    await p.$disconnect();
  }); // append-only fixtures stay in this disposable DB.
  it('pages beyond 300 and 25, resumes, and previews create no assignments or messages', async () => {
    let r = await discovery.start(ctx, rule.id, {
      expectedVersion: rule.version,
      requestKey: randomUUID(),
    });
    runId = r.id;
    let pages = 0;
    while (r.state !== 'complete') {
      r = await discovery.advance(ctx, r.id);
      if (++pages > 20) throw Error('Pagination did not terminate');
    }
    expect(r.counts).toEqual({ evaluated: 326, matched: 325, incomplete: 0, suggestions: 650 });
    expect(pages).toBe(14);
    const replay = await discovery.start(ctx, rule.id, {
      expectedVersion: rule.version,
      requestKey: randomUUID(),
    });
    let next = await discovery.advance(ctx, replay.id);
    while (next.state !== 'complete') next = await discovery.advance(ctx, replay.id);
    expect(next.counts.suggestions).toBe(0);
    expect(
      await p.withTenant(tenant, (tx) =>
        tx.legiWatchFolderBill.count({ where: { tenantId: tenant } }),
      ),
    ).toBe(0);
    let count = 0,
      cursor: string | null = null;
    do {
      const page = await discovery.suggestions(ctx, folderId, {
        jurisdiction: 'FL',
        sessionKey: session,
        cursor,
      });
      count += page.rows.length;
      cursor = page.next;
    } while (cursor);
    expect(count).toBe(325);
  });
  async function candidate(billId: string, folder = folderId) {
    return folders.withActor(ctx, async (tx) => {
      const [s] = await tx.$queryRaw<
        Array<{ id: string; version: number; state: string }>
      >`SELECT id,version,state FROM intel_legiwatch_suggestion WHERE tenant_id=${tenant} AND owner_clerk_id=${actor} AND folder_id=${folder} AND bill_id=${billId} ORDER BY created_at DESC LIMIT 1`;
      if (!s) throw Error('Missing test candidate');
      return s;
    });
  }
  it('concurrent accept and lost acknowledgement commit one membership and receipt', async () => {
    const s = await candidate(billIds[0]!),
      key = randomUUID(),
      body = { action: 'add', expectedVersion: s.version, requestKey: key };
    const [a, b] = await Promise.all([
      discovery.decide(ctx, s.id, body),
      discovery.decide(ctx, s.id, body),
    ]);
    expect(a.outcome).toBe('added');
    expect(b).toEqual(a);
    const c = await folders.context(ctx, folderId, billIds[0]!);
    expect(c.assignment).toMatchObject({
      position: 'none',
      topPriority: false,
      importance: 'normal',
      internalComments: '',
      externalComments: '',
    });
    const other = await candidate(billIds[0]!, secondId);
    expect(
      (
        await discovery.decide(ctx, other.id, {
          action: 'add',
          expectedVersion: other.version,
          requestKey: randomUUID(),
        })
      ).outcome,
    ).toBe('added');
  });
  it('manual removal survives every rule and retains original context revisions', async () => {
    const before = (await folders.context(ctx, folderId, billIds[0]!)).assignment!;
    await folders.updateContext(ctx, folderId, billIds[0]!, {
      expectedVersion: before.version,
      position: 'oppose',
      topPriority: true,
      importance: 'high',
      internalComments: 'Synthetic internal note',
      externalComments: 'Synthetic external note',
    });
    await folders.bulk(ctx, folderId, { action: 'remove', billIds: [billIds[0]!] });
    await folders.withActor(ctx, async (tx) => {
      await folders.folder(tx, ctx, folderId, true);
      const state = await membershipState(tx, ctx, folderId, billIds[0]!);
      expect(state.suppressed).toBe(true);
      const receipt = await writeMembershipDecision(tx, ctx, {
        folderId,
        billId: billIds[0]!,
        action: 'add',
        origin: 'rule',
        ruleId: randomUUID(),
        requestKey: randomUUID(),
        bill: { jurisdiction: 'FL', sessionKey: session },
      });
      expect(receipt.outcome).toBe('excluded');
      const [removal] = await tx.$queryRaw<
        Array<{ payload: any }>
      >`SELECT payload FROM intel_legiwatch_decision WHERE tenant_id=${tenant} AND folder_id=${folderId} AND bill_id=${billIds[0]!} AND action='remove'`;
      expect(removal!.payload.before.position).toBe('oppose');
      expect(removal!.payload.revisions).toHaveLength(1);
    });
    await folders.bulk(ctx, folderId, { action: 'add', billIds: [billIds[0]!] });
    expect(
      (await folders.withActor(ctx, (tx) => membershipState(tx, ctx, folderId, billIds[0]!)))
        .suppressed,
    ).toBe(false);
  });
  it('undo removes only its own untouched assignment and preserves human edits', async () => {
    const s = await candidate(billIds[1]!);
    await discovery.decide(ctx, s.id, {
      action: 'add',
      expectedVersion: s.version,
      requestKey: randomUUID(),
    });
    const added = await candidate(billIds[1]!);
    expect(
      (
        await discovery.decide(ctx, added.id, {
          action: 'undo',
          expectedVersion: added.version,
          requestKey: randomUUID(),
        })
      ).outcome,
    ).toBe('undone');
    expect((await folders.context(ctx, folderId, billIds[1]!)).assignment).toBeNull();
    const t = await candidate(billIds[2]!);
    await discovery.decide(ctx, t.id, {
      action: 'add',
      expectedVersion: t.version,
      requestKey: randomUUID(),
    });
    const a = (await folders.context(ctx, folderId, billIds[2]!)).assignment!;
    await folders.updateContext(ctx, folderId, billIds[2]!, {
      expectedVersion: a.version,
      position: 'support',
      topPriority: false,
      importance: 'normal',
      internalComments: 'Human edit',
      externalComments: '',
    });
    const edited = await candidate(billIds[2]!);
    expect(
      (
        await discovery.decide(ctx, edited.id, {
          action: 'undo',
          expectedVersion: edited.version,
          requestKey: randomUUID(),
        })
      ).outcome,
    ).toBe('undo_conflict');
    expect((await folders.context(ctx, folderId, billIds[2]!)).assignment!.internalComments).toBe(
      'Human edit',
    );
  });
  it('holds stale sources and prevents cross-owner and tenant reads', async () => {
    const s = await candidate(billIds[3]!);
    await p.$executeRaw`UPDATE state_bill SET title='Revised title' WHERE id=${billIds[3]!}`;
    expect(
      (
        await discovery.decide(ctx, s.id, {
          action: 'add',
          expectedVersion: s.version,
          requestKey: randomUUID(),
        })
      ).outcome,
    ).toBe('stale');
    await expect(discovery.read({ ...ctx, clerkUserId: 'unrelated' }, runId)).rejects.toThrow();
    await expect(discovery.read({ ...ctx, tenantId: foreign }, runId)).rejects.toThrow();
    const r = await discovery.start(ctx, rule.id, {
      expectedVersion: rule.version,
      requestKey: randomUUID(),
    });
    await p.$executeRaw`UPDATE state_bill SET title='Another source revision' WHERE id=${billIds[4]!}`;
    expect((await discovery.advance(ctx, r.id)).state).toBe('stale');
  });
  it('rule exclusions and dismissal are folder-specific, and request keys cannot change meaning', async () => {
    const s = await candidate(billIds[5]!),
      key = randomUUID();
    await discovery.decide(ctx, s.id, {
      action: 'exclude',
      expectedVersion: s.version,
      requestKey: key,
    });
    await expect(
      discovery.decide(ctx, s.id, { action: 'add', expectedVersion: s.version, requestKey: key }),
    ).rejects.toThrow('SUGGESTION_REQUEST_KEY_REUSED');
    const other = await candidate(billIds[5]!, secondId);
    expect(other.state).toBe('pending');
    const x = await candidate(billIds[5]!);
    await discovery.decide(ctx, x.id, {
      action: 'restore',
      expectedVersion: x.version,
      requestKey: randomUUID(),
    });
    expect((await candidate(billIds[5]!)).state).toBe('pending');
  });
  it('checks permission again and keeps exact mixed batch outcomes', async () => {
    const first = await candidate(billIds[6]!),
      second = await candidate(billIds[7]!);
    const result = await discovery.batch(ctx, {
      action: 'add',
      items: [
        { id: first.id, expectedVersion: first.version, requestKey: randomUUID() },
        { id: second.id, expectedVersion: 99, requestKey: randomUUID() },
      ],
    });
    expect(result.results.map((r) => r.outcome)).toEqual(['added', 'stale']);
    const f = await folders.withActor(ctx, (tx) => folders.folder(tx, ctx, folderId));
    await folders.update(ctx, folderId, {
      name: f.name,
      expectedVersion: f.version,
      archived: true,
    });
    const s = await candidate(billIds[8]!);
    await expect(
      discovery.decide(ctx, s.id, {
        action: 'add',
        expectedVersion: s.version,
        requestKey: randomUUID(),
      }),
    ).rejects.toThrow('FOLDER_ARCHIVED');
  });
});
