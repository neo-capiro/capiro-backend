import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { FolderSourceDataRepository } from '../src/sourcedata/folder-source-data.repository.js';
import { SourceDataRepository } from '../src/sourcedata/source-data.repository.js';
import { FolderTrackerService } from '../src/tracker/folders/folder-tracker.service.js';
import type { WorkspaceTenantContext } from '../src/auth/tenant-context.js';

// Native PostgreSQL parity regressions for the additive LobbyTools-backed contracts.
describe('folder parity PostgreSQL additive filters and daily activity', () => {
  const prisma = new PrismaService();
  const source = new FolderSourceDataRepository(prisma);
  const svc = new FolderTrackerService(prisma, source, new SourceDataRepository(prisma));
  const tenant = randomUUID(),
    foreign = randomUUID(),
    suffix = randomUUID().slice(0, 8);
  const actor = 'parity_owner_' + suffix;
  const ctx: WorkspaceTenantContext = { tenantId: tenant, clerkUserId: actor, role: 'org:admin' };
  const foreignCtx: WorkspaceTenantContext = {
    tenantId: foreign,
    clerkUserId: actor,
    role: 'org:admin',
  };
  let folderId: string, clientFolderId: string, archivedFolderId: string;
  const bill = 'fl-2099-hb7',
    second = 'fl-2099-hb9',
    unassigned = 'fl-2099-hb99',
    clientBill = 'fl-2099-hb11',
    archivedBill = 'fl-2099-hb13';
  const clientId = randomUUID();
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error('Disposable DATABASE_URL is required');
    await prisma.$connect();
    await prisma.withSystem(async (tx) => {
      await tx.$executeRaw`INSERT INTO tenants(id,slug,name) VALUES (${tenant}::uuid,${'parity-' + suffix},'Synthetic parity tenant'),(${foreign}::uuid,${'foreign-' + suffix},'Foreign synthetic')`;
      const uid = randomUUID();
      await tx.$executeRaw`INSERT INTO users(id,clerk_user_id,email) VALUES (${uid}::uuid,${actor},${actor + '@example.invalid'})`;
      await tx.$executeRaw`INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES (${tenant}::uuid,${uid}::uuid,'standard_user','active')`;
      await tx.$executeRaw`INSERT INTO tenant_memberships(tenant_id,user_id,role,status) VALUES (${foreign}::uuid,${uid}::uuid,'standard_user','active')`;
      await tx.$executeRaw`INSERT INTO clients(id,tenant_id,name,status) VALUES (${clientId}::uuid,${tenant}::uuid,'Parity client','active')`;
      await tx.$executeRaw`INSERT INTO state_committee(id,state,chamber,name) VALUES ('fl-lower-health','FL','lower','Health Committee') ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title,chamber,classification,subjects,description,latest_action_text,latest_action_date,current_committee_id) VALUES (${bill},'FL','2099','2099','HB 7','hb7','Synthetic healthcare','H',ARRAY['B'],ARRAY['Health'],'Provider summary healthcare','Referred to committee','2099-01-10'::date,'fl-lower-health') ON CONFLICT(id) DO NOTHING`;
      await tx.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title,chamber,classification,subjects,description,latest_action_text,latest_action_date) VALUES (${second},'FL','2099','2099','SB 9','sb9','Synthetic education','S',ARRAY['B'],ARRAY['Education'],'Provider summary education','Passed','2099-02-11'::date) ON CONFLICT(id) DO NOTHING`;
      await tx.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title,chamber,classification,subjects,description,latest_action_text,latest_action_date) VALUES (${unassigned},'FL','2099','2099','HB 99','hb99','Unassigned synthetic','H',ARRAY['B'],ARRAY['Health'],'Unassigned summary','Filed','2099-01-20'::date) ON CONFLICT(id) DO NOTHING`;
      await tx.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title,chamber,classification,subjects,description,latest_action_text,latest_action_date) VALUES (${clientBill},'FL','2099','2099','HB 11','hb11','Client synthetic','S',ARRAY['B'],ARRAY['Education'],'Client summary','Referred','2099-01-22'::date) ON CONFLICT(id) DO NOTHING`;
      await tx.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title,chamber,classification,subjects,description,latest_action_text,latest_action_date) VALUES (${archivedBill},'FL','2099','2099','HB 13','hb13','Archived folder bill','H',ARRAY['B'],ARRAY['Health'],'Archived summary','Filed','2099-01-25'::date) ON CONFLICT(id) DO NOTHING`;
      await tx.$executeRaw`INSERT INTO state_bill_sponsor(bill_key,name,party,sponsor_type,sponsor_order) VALUES (${bill},'Cosponsor, Jane','D','cosponsor',2) ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`INSERT INTO state_bill_action(bill_key,date,text,order_key) VALUES (${bill},'2099-01-10'::date,'Filed',1) ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`INSERT INTO state_bill_action(bill_key,date,text,order_key) VALUES (${bill},'2099-01-12'::date,'Referred',2) ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`INSERT INTO state_bill_action(bill_key,date,text,order_key) VALUES (${unassigned},'2099-01-20'::date,'Filed',1) ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`INSERT INTO state_bill_action(bill_key,date,text,order_key) VALUES (${clientBill},'2099-01-22'::date,'Referred',1) ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`INSERT INTO state_bill_action(bill_key,date,text,order_key) VALUES (${archivedBill},'2099-01-25'::date,'Filed',1) ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`INSERT INTO state_bill_version(id,bill_key,legiscan_doc_id,version_type,date,state_url) VALUES (${randomUUID()}::uuid,${bill},987654321,'Introduced','2099-01-05'::date,'https://example.gov/hb7') ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`INSERT INTO state_bill_version(id,bill_key,legiscan_doc_id,version_type,date,state_url) VALUES (${randomUUID()}::uuid,${bill},987654322,'Introduced','1970-01-01'::date,'https://example.gov/hb7-epoch') ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`INSERT INTO state_bill_published_record(id,bill_key,kind,source_identity,revision_hash,event_date,source_order,evidence,first_observed_at) VALUES (${randomUUID()}::uuid,${bill},'amendment','amd1','r1','2099-01-15',1,'{"text":"Amendment 1","url":"https://example.gov/amd1"}'::jsonb,now()) ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`INSERT INTO state_bill_published_record(id,bill_key,kind,source_identity,revision_hash,event_date,source_order,evidence,first_observed_at) VALUES (${randomUUID()}::uuid,${bill},'amendment','amd1','r2','2099-01-20',1,'{"text":"Amendment 1 revised","url":"https://example.gov/amd1r2"}'::jsonb,now() + interval '1 hour') ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`INSERT INTO state_bill_published_record(id,bill_key,kind,source_identity,revision_hash,event_date,source_order,evidence,first_observed_at) VALUES (${randomUUID()}::uuid,${bill},'action','act1','r1','2099-01-18',3,'{"text":"Published action v1","url":"https://example.gov/act1v1"}'::jsonb,now()) ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`INSERT INTO state_bill_published_record(id,bill_key,kind,source_identity,revision_hash,event_date,source_order,evidence,first_observed_at) VALUES (${randomUUID()}::uuid,${bill},'action','act1','r2','2099-01-19',3,'{"text":"Published action v2","url":"https://example.gov/act1v2"}'::jsonb,now() + interval '1 hour') ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`INSERT INTO congress_bill(id,bill_type,bill_number,title,congress,origin_chamber,sponsor_name,url,status,latest_action_text,latest_action_date,subjects) VALUES ('2099-hr-1234','hr','1234','Synthetic federal',2099,'house','Rep. Smith','https://congress.gov/hr1234','passed','Passed House','2099-01-15'::date,ARRAY['Health']) ON CONFLICT(id) DO UPDATE SET sponsor_name = EXCLUDED.sponsor_name`;
      await tx.$executeRaw`INSERT INTO congress_bill_action(bill_id,date,text) VALUES ('2099-hr-1234','2099-01-15'::date,'Passed House') ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`INSERT INTO congress_bill_cosponsor(bill_id,bioguide_id,full_name,party,withdrawn_date) VALUES ('2099-hr-1234','S000123','Cosponsor, John','D',NULL) ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`INSERT INTO congress_bill_cosponsor(bill_id,bioguide_id,full_name,party,withdrawn_date) VALUES ('2099-hr-1234','S000124','Cosponsor, Withdrawn','R','2099-01-10'::date) ON CONFLICT DO NOTHING`;
    });
    folderId = (await svc.create(ctx, { name: 'Parity folder' })).id;
    clientFolderId = (await svc.create(ctx, { name: 'Client folder', clientId })).id;
    archivedFolderId = (await svc.create(ctx, { name: 'Archived folder' })).id;
    await svc.bulk(ctx, folderId, { action: 'add', billIds: [bill, second] });
    await svc.bulk(ctx, clientFolderId, { action: 'add', billIds: [clientBill, bill] });
    await svc.bulk(ctx, archivedFolderId, { action: 'add', billIds: [archivedBill] });
  }, 30000);
  afterAll(async () => {
    await prisma.withSystem(async (tx) => {
      await tx.legiWatchFolderBill.deleteMany({ where: { tenantId: tenant } });
      await tx.legiWatchFolder.deleteMany({ where: { tenantId: tenant } });
      await tx.$executeRaw`DELETE FROM state_bill_sponsor WHERE bill_key IN (${bill},${second},${unassigned},${clientBill},${archivedBill})`;
      await tx.$executeRaw`DELETE FROM state_bill_action WHERE bill_key IN (${bill},${second},${unassigned},${clientBill},${archivedBill})`;
      await tx.$executeRaw`DELETE FROM state_bill_version WHERE bill_key IN (${bill},${second},${unassigned},${clientBill},${archivedBill})`;
      await tx.$executeRaw`DELETE FROM state_bill_published_record WHERE bill_key IN (${bill},${second},${unassigned},${clientBill},${archivedBill})`;
      await tx.$executeRaw`DELETE FROM state_bill WHERE id IN (${bill},${second},${unassigned},${clientBill},${archivedBill})`;
      await tx.$executeRaw`DELETE FROM state_committee WHERE id = 'fl-lower-health'`;
      await tx.$executeRaw`DELETE FROM congress_bill_action WHERE bill_id = '2099-hr-1234'`;
      await tx.$executeRaw`DELETE FROM congress_bill_cosponsor WHERE bill_id = '2099-hr-1234'`;
      await tx.$executeRaw`DELETE FROM congress_bill WHERE id = '2099-hr-1234'`;
      await tx.$executeRaw`DELETE FROM clients WHERE id = ${clientId}::uuid`;
      await tx.$executeRaw`DELETE FROM tenant_memberships WHERE tenant_id IN (${tenant}::uuid,${foreign}::uuid)`;
      await tx.$executeRaw`DELETE FROM users WHERE clerk_user_id=${actor}`;
      await tx.$executeRaw`DELETE FROM tenants WHERE id IN (${tenant}::uuid,${foreign}::uuid)`;
    });
    await prisma.$disconnect();
  });
  it('summaryIncluded projects summary/committee/classification, hidden otherwise', async () => {
    const plain = await svc.board(ctx, { folderId, jurisdiction: 'FL', sessionKey: '2099' });
    expect(plain.rows[0]?.summary).toBeNull();
    const withSummary = await svc.board(ctx, {
      folderId,
      jurisdiction: 'FL',
      sessionKey: '2099',
      summaryIncluded: 'true',
    });
    expect(withSummary.rows.find((r) => r.id === bill)?.summary).toBe(
      'Provider summary healthcare',
    );
    expect(withSummary.rows.find((r) => r.id === bill)?.classifications).toEqual(['B']);
    expect(withSummary.rows.find((r) => r.id === bill)?.currentCommittee).toBe('Health Committee');
  });
  it('committee filter matches canonical current committee', async () => {
    const out = await svc.board(ctx, {
      folderId,
      jurisdiction: 'FL',
      sessionKey: '2099',
      committee: 'Health Committee',
    });
    expect(out.rows.map((r) => r.id)).toEqual([bill]);
    const none = await svc.board(ctx, {
      folderId,
      jurisdiction: 'FL',
      sessionKey: '2099',
      committee: 'Other Committee',
    });
    expect(none.total).toBe(0);
  });
  it('committee falls back to report_source_facts currentCommittee', async () => {
    await prisma.$executeRaw`UPDATE state_bill SET report_source_facts = '{"currentCommittee":{"name":"Facts Committee"}}'::jsonb WHERE id = ${second}`;
    const withSummary = await svc.board(ctx, {
      folderId,
      jurisdiction: 'FL',
      sessionKey: '2099',
      summaryIncluded: 'true',
    });
    expect(withSummary.rows.find((r) => r.id === second)?.currentCommittee).toBe('Facts Committee');
    await prisma.$executeRaw`UPDATE state_bill SET report_source_facts = NULL WHERE id = ${second}`;
  });
  it('classification filter matches provider bill type code B', async () => {
    const out = await svc.board(ctx, {
      folderId,
      jurisdiction: 'FL',
      sessionKey: '2099',
      classification: 'B',
    });
    expect(out.total).toBe(2);
    const other = await svc.board(ctx, {
      folderId,
      jurisdiction: 'FL',
      sessionKey: '2099',
      classification: 'R',
    });
    expect(other.total).toBe(0);
  });
  it('subject filter matches provider tags ILIKE', async () => {
    const out = await svc.board(ctx, {
      folderId,
      jurisdiction: 'FL',
      sessionKey: '2099',
      subject: 'health',
    });
    expect(out.rows.map((r) => r.id)).toEqual([bill]);
  });
  it('summary and actionText predicates match provider description and latest action', async () => {
    const bySummary = await svc.board(ctx, {
      folderId,
      jurisdiction: 'FL',
      sessionKey: '2099',
      summary: 'healthcare',
    });
    expect(bySummary.rows.map((r) => r.id)).toEqual([bill]);
    const byAction = await svc.board(ctx, {
      folderId,
      jurisdiction: 'FL',
      sessionKey: '2099',
      actionText: 'referred',
    });
    expect(byAction.rows.map((r) => r.id)).toEqual([bill]);
  });
  it('chamber filter normalizes origin codes (House-origin HB 7 lower, Senate-origin SB 9 upper)', async () => {
    const lower = await svc.board(ctx, {
      folderId,
      jurisdiction: 'FL',
      sessionKey: '2099',
      chamber: 'lower',
    });
    expect(lower.rows.map((r) => r.id)).toEqual([bill]);
    const upper = await svc.board(ctx, {
      folderId,
      jurisdiction: 'FL',
      sessionKey: '2099',
      chamber: 'upper',
    });
    expect(upper.rows.map((r) => r.id)).toEqual([second]);
  });

  it('chamber filter projects ORIGIN chamber, not current chamber (authentic S0032 moved to House)', async () => {
    // Authentic FL 2026 provider rows (legiscan-public-captures): S0032 has
    // body S / current_body H, so state_bill.chamber stores 'H' — but the folder
    // origin filter must keep it under Senate. S0174 stays Senate, H0547 stays
    // House. Malformed/Assembly identifiers must not be mis-classified.
    const s0032 = 'fl-2099-s0032', s0174 = 'fl-2099-s0174', h0547 = 'fl-2099-h0547',
      assembly = 'fl-2099-ab5', malformed = 'fl-2099-soup';
    await prisma.withSystem(async (tx) => {
      // origin Senate, current House (the defect case) — identifier S0032, chamber 'H'
      await tx.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title,chamber) VALUES(${s0032},'FL','2099','2099','S0032','s0032','Senate bill moved to House','H') ON CONFLICT(id) DO NOTHING`;
      // origin Senate, current Senate
      await tx.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title,chamber) VALUES(${s0174},'FL','2099','2099','S0174','s0174','Senate bill','S') ON CONFLICT(id) DO NOTHING`;
      // origin House, current House
      await tx.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title,chamber) VALUES(${h0547},'FL','2099','2099','H0547','h0547','House bill','H') ON CONFLICT(id) DO NOTHING`;
      // Assembly (lower), identifier AB 5, chamber 'A'
      await tx.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title,chamber) VALUES(${assembly},'FL','2099','2099','AB 5','ab5','Assembly bill','A') ON CONFLICT(id) DO NOTHING`;
      // Malformed: no digits — must NOT take the leading 'S' as Senate; falls back to current chamber 'H' -> lower
      await tx.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title,chamber) VALUES(${malformed},'FL','2099','2099','SOUP','soup','Malformed no digits','H') ON CONFLICT(id) DO NOTHING`;
    });
    try {
      // board() JOINs intel_legiwatch_folder_bill, so the bills must be assigned to
      // the parity folder to appear (a board always shows assignments).
      await svc.bulk(ctx, folderId, {
        action: 'add',
        billIds: [s0032, s0174, h0547, assembly, malformed],
      });
      const upper = await svc.board(ctx, { folderId, jurisdiction: 'FL', sessionKey: '2099', chamber: 'upper' });
      const upperIds = upper.rows.map((r) => r.id);
      // S0032 (moved to House) AND S0174 are Senate-origin; the Senate fixture
      // `second` (SB 9) is also upper. No House-origin bill leaks up.
      expect(upperIds).toEqual(expect.arrayContaining([s0032, s0174]));
      expect(upperIds).not.toContain(h0547);
      expect(upperIds).not.toContain(assembly);
      expect(upperIds).not.toContain(malformed); // SOUP must not be mis-read as Senate
      const lower = await svc.board(ctx, { folderId, jurisdiction: 'FL', sessionKey: '2099', chamber: 'lower' });
      const lowerIds = lower.rows.map((r) => r.id);
      expect(lowerIds).toEqual(expect.arrayContaining([h0547, assembly]));
      expect(lowerIds).not.toContain(s0032); // current House, but origin Senate -> NOT under House filter
      expect(lowerIds).not.toContain(s0174);
    } finally {
      await prisma.withSystem(async (tx) => {
        await tx.$executeRaw`DELETE FROM intel_legiwatch_folder_bill WHERE bill_id IN (${s0032},${s0174},${h0547},${assembly},${malformed})`;
        await tx.$executeRaw`DELETE FROM state_bill WHERE id IN (${s0032},${s0174},${h0547},${assembly},${malformed})`;
      });
    }
  });

  it('chamber filter reads origin prefix from a leading-whitespace identifier ( SB 90009)', async () => {
    // Regression: the full-number guard '^\s*[A-Z]+\s*0*\d+$' tolerates leading
    // whitespace, but the prefix substring '^[A-Z]+' did not — so ' SB 90009'
    // with current chamber 'H' fell through to the current-chamber fallback and
    // was mis-classified lower despite a real Senate origin. The prefix read
    // must apply the same normalized trim as the guard. Test-only fixtures:
    // 3-segment keys whose bill segment matches normalizeBillNumber(identifier).
    const wsSenate = 'fl-2099-sb90009', wsHouse = 'fl-2099-hb90008';
    await prisma.withSystem(async (tx) => {
      // Leading-whitespace Senate identifier, current chamber House -> must be upper.
      await tx.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title,chamber) VALUES(${wsSenate},'FL','2099','2099',' SB 90009','sb90009','Whitespace Senate origin','H') ON CONFLICT(id) DO NOTHING`;
      // Leading-whitespace House identifier, current chamber Senate -> must be lower.
      await tx.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title,chamber) VALUES(${wsHouse},'FL','2099','2099',' HB 90008','hb90008','Whitespace House origin','S') ON CONFLICT(id) DO NOTHING`;
    });
    try {
      await svc.bulk(ctx, folderId, { action: 'add', billIds: [wsSenate, wsHouse] });
      const upper = await svc.board(ctx, { folderId, jurisdiction: 'FL', sessionKey: '2099', chamber: 'upper' });
      expect(upper.rows.map((r) => r.id)).toContain(wsSenate);
      expect(upper.rows.map((r) => r.id)).not.toContain(wsHouse);
      const lower = await svc.board(ctx, { folderId, jurisdiction: 'FL', sessionKey: '2099', chamber: 'lower' });
      expect(lower.rows.map((r) => r.id)).toContain(wsHouse);
      expect(lower.rows.map((r) => r.id)).not.toContain(wsSenate);
    } finally {
      await prisma.withSystem(async (tx) => {
        await tx.$executeRaw`DELETE FROM intel_legiwatch_folder_bill WHERE bill_id IN (${wsSenate},${wsHouse})`;
        await tx.$executeRaw`DELETE FROM state_bill WHERE id IN (${wsSenate},${wsHouse})`;
      });
    }
  });
  it('sponsor filter matches state cosponsor and federal active cosponsor, excludes withdrawn', async () => {
    const state = await svc.board(ctx, {
      folderId,
      jurisdiction: 'FL',
      sessionKey: '2099',
      sponsor: 'cosponsor',
    });
    expect(state.rows.map((r) => r.id)).toEqual([bill]);
    const fed = await svc.board(
      ctx,
      { jurisdiction: 'US', sessionKey: '2099', sponsor: 'john' },
      true,
    );
    expect(fed.rows.some((r) => r.id === '2099-hr-1234')).toBe(true);
    const withdrawn = await svc.board(
      ctx,
      { jurisdiction: 'US', sessionKey: '2099', sponsor: 'withdrawn' },
      true,
    );
    expect(withdrawn.rows.some((r) => r.id === '2099-hr-1234')).toBe(false);
  });
  it('foreign tenant folder rejection', async () => {
    await expect(
      svc.board(foreignCtx, { folderId, jurisdiction: 'FL', sessionKey: '2099' }),
    ).rejects.toThrow('FOLDER_NOT_FOUND');
    await expect(
      svc.activities(foreignCtx, {
        jurisdiction: 'FL',
        sessionKey: '2099',
        kind: 'action',
        folderId,
      }),
    ).rejects.toThrow('FOLDER_NOT_FOUND');
  });
  it('activities action returns legacy actions with exact dates and no multiplication from multiple folders', async () => {
    // Remove the published action to test legacy fallback in isolation
    await prisma.$executeRaw`DELETE FROM state_bill_published_record WHERE bill_key = ${bill} AND kind = 'action'`;
    try {
      const out = await svc.activities(ctx, {
        jurisdiction: 'FL',
        sessionKey: '2099',
        kind: 'action',
      });
      const hb7 = out.rows.filter((r) => r.billId === bill);
      expect(hb7.length).toBe(2);
      expect(hb7.map((r) => r.date)).toEqual(['2099-01-12', '2099-01-10']);
      expect(hb7[0]?.provenance).toBe('legacy_action');
      const scoped = await svc.activities(ctx, {
        jurisdiction: 'FL',
        sessionKey: '2099',
        kind: 'action',
        folderId,
      });
      expect(scoped.rows.filter((r) => r.billId === bill).length).toBe(2);
    } finally {
      await prisma.$executeRaw`INSERT INTO state_bill_published_record(id,bill_key,kind,source_identity,revision_hash,event_date,source_order,evidence,first_observed_at) VALUES (${randomUUID()}::uuid,${bill},'action','act1','r1','2099-01-18',3,'{"text":"Published action v1","url":"https://example.gov/act1v1"}'::jsonb,now()) ON CONFLICT DO NOTHING`;
      await prisma.$executeRaw`INSERT INTO state_bill_published_record(id,bill_key,kind,source_identity,revision_hash,event_date,source_order,evidence,first_observed_at) VALUES (${randomUUID()}::uuid,${bill},'action','act1','r2','2099-01-19',3,'{"text":"Published action v2","url":"https://example.gov/act1v2"}'::jsonb,now() + interval '1 hour') ON CONFLICT DO NOTHING`;
    }
  });
  it('activities action dedupes published records by sourceIdentity to newest observed revision', async () => {
    // No observation — fallback to newest observed (r2)
    const out = await svc.activities(ctx, {
      jurisdiction: 'FL',
      sessionKey: '2099',
      kind: 'action',
    });
    const pub = out.rows.filter((r) => r.billId === bill && r.provenance === 'published_record');
    expect(pub.length).toBe(1);
    expect(pub[0]?.date).toBe('2099-01-19');
    expect(pub[0]?.text).toBe('Published action v2');
    expect(pub[0]?.url).toBe('https://example.gov/act1v2');
  });
  it('activities amendment dedupes by sourceIdentity and respects date bounds', async () => {
    const out = await svc.activities(ctx, {
      jurisdiction: 'FL',
      sessionKey: '2099',
      kind: 'amendment',
    });
    const amd = out.rows.filter((r) => r.billId === bill);
    expect(amd.length).toBe(1);
    expect(amd[0]?.date).toBe('2099-01-20');
    const bounded = await svc.activities(ctx, {
      jurisdiction: 'FL',
      sessionKey: '2099',
      kind: 'amendment',
      from: '2099-01-01',
      to: '2099-01-16',
    });
    expect(bounded.rows.filter((r) => r.billId === bill).length).toBe(0);
  });
  it('activities text excludes epoch sentinel rows and returns provider document', async () => {
    const out = await svc.activities(ctx, { jurisdiction: 'FL', sessionKey: '2099', kind: 'text' });
    const txt = out.rows.filter((r) => r.billId === bill);
    expect(txt.length).toBe(1);
    expect(txt[0]?.providerDocumentId).toBe(987654321);
    expect(txt[0]?.date).toBe('2099-01-05');
  });
  it('activities rejects invalid date ranges and cursor scope mismatches', async () => {
    await expect(
      svc.activities(ctx, {
        jurisdiction: 'FL',
        sessionKey: '2099',
        kind: 'action',
        from: '2099-02-01',
        to: '2099-01-01',
      }),
    ).rejects.toThrow('INVALID_DATE_RANGE');
    await expect(
      svc.activities(ctx, {
        jurisdiction: 'FL',
        sessionKey: '2099',
        kind: 'action',
        from: '2099-13-01',
      }),
    ).rejects.toThrow('INVALID_DATE_RANGE');
    const page = await svc.activities(ctx, {
      jurisdiction: 'FL',
      sessionKey: '2099',
      kind: 'action',
      limit: 1,
    });
    expect(page.nextCursor).not.toBeNull();
    await expect(
      svc.activities(ctx, {
        jurisdiction: 'FL',
        sessionKey: '2099',
        kind: 'text',
        cursor: page.nextCursor!,
      }),
    ).rejects.toThrow('INVALID_ACTIVITY_CURSOR');
  });
  it('activities onlyTracked restricts to assigned bills and excludes unassigned', async () => {
    const tracked = await svc.activities(ctx, {
      jurisdiction: 'FL',
      sessionKey: '2099',
      kind: 'action',
      onlyTracked: 'true',
    });
    expect(tracked.rows.filter((r) => r.billId === bill).length).toBe(1);
    expect(tracked.rows.filter((r) => r.billId === unassigned).length).toBe(0);
    expect(tracked.rows.filter((r) => r.billId === clientBill).length).toBe(1);
  });
  it('activities archived folder exclusion: session includes archived bill, onlyTracked excludes it', async () => {
    const folder = await prisma.legiWatchFolder.findFirst({
      where: { tenantId: tenant, id: archivedFolderId },
    });
    await svc.update(ctx, archivedFolderId, {
      name: folder!.name,
      archived: true,
      expectedVersion: folder!.version,
    });
    const session = await svc.activities(ctx, {
      jurisdiction: 'FL',
      sessionKey: '2099',
      kind: 'action',
    });
    expect(session.rows.filter((r) => r.billId === archivedBill).length).toBe(1);
    const tracked = await svc.activities(ctx, {
      jurisdiction: 'FL',
      sessionKey: '2099',
      kind: 'action',
      onlyTracked: 'true',
    });
    expect(tracked.rows.filter((r) => r.billId === archivedBill).length).toBe(0);
    expect(tracked.rows.filter((r) => r.billId === bill).length).toBe(1);
    const folder2 = await prisma.legiWatchFolder.findFirst({
      where: { tenantId: tenant, id: archivedFolderId },
    });
    await svc.update(ctx, archivedFolderId, {
      name: folder2!.name,
      archived: false,
      expectedVersion: folder2!.version,
    });
  });
  it('activities folderId+clientId constrains to same folder assignment', async () => {
    const scoped = await svc.activities(ctx, {
      jurisdiction: 'FL',
      sessionKey: '2099',
      kind: 'action',
      folderId: clientFolderId,
      clientId,
    });
    expect(scoped.rows.filter((r) => r.billId === clientBill).length).toBe(1);
    expect(scoped.rows.filter((r) => r.billId === bill).length).toBe(1);
    const mismatch = await svc.activities(ctx, {
      jurisdiction: 'FL',
      sessionKey: '2099',
      kind: 'action',
      folderId,
      clientId,
    });
    expect(mismatch.rows.filter((r) => r.billId === bill).length).toBe(0);
  });
  it('activities inclusive date bounds and pagination exact rows', async () => {
    // Jan 19 published action is newest observed; Jan 10 legacy is suppressed by canonical coverage
    const oneDay = await svc.activities(ctx, {
      jurisdiction: 'FL',
      sessionKey: '2099',
      kind: 'action',
      from: '2099-01-19',
      to: '2099-01-19',
    });
    const hb7 = oneDay.rows.filter((r) => r.billId === bill);
    expect(hb7.length).toBe(1);
    expect(hb7[0]?.date).toBe('2099-01-19');
    expect(hb7[0]?.text).toBe('Published action v2');
    // Neighboring date with no activity
    const emptyDay = await svc.activities(ctx, {
      jurisdiction: 'FL',
      sessionKey: '2099',
      kind: 'action',
      from: '2099-01-11',
      to: '2099-01-11',
    });
    expect(emptyDay.rows.filter((r) => r.billId === bill).length).toBe(0);
    const page1 = await svc.activities(ctx, {
      jurisdiction: 'FL',
      sessionKey: '2099',
      kind: 'action',
      limit: 1,
    });
    const page2 = await svc.activities(ctx, {
      jurisdiction: 'FL',
      sessionKey: '2099',
      kind: 'action',
      limit: 1,
      cursor: page1.nextCursor!,
    });
    expect(page1.rows.length).toBe(1);
    expect(page2.rows.length).toBe(1);
    expect(page1.rows[0]?.id).not.toBe(page2.rows[0]?.id);
  });
  it('activities federal action with chamber filter', async () => {
    const fed = await svc.activities(ctx, {
      jurisdiction: 'US',
      sessionKey: '2099',
      kind: 'action',
    });
    expect(fed.rows.length).toBe(1);
    expect(fed.rows[0]?.billId).toBe('2099-hr-1234');
    const lower = await svc.activities(ctx, {
      jurisdiction: 'US',
      sessionKey: '2099',
      kind: 'action',
      chamber: 'lower',
    });
    expect(lower.rows.length).toBe(1);
    const upper = await svc.activities(ctx, {
      jurisdiction: 'US',
      sessionKey: '2099',
      kind: 'action',
      chamber: 'upper',
    });
    expect(upper.rows.length).toBe(0);
  });
  it('activities federal text/amendment report source unavailable, never a zero-event count', async () => {
    for (const kind of ['text', 'amendment'] as const) {
      const out = await svc.activities(ctx, { jurisdiction: 'US', sessionKey: '2099', kind });
      expect(out.availability).toBe('unavailable');
      expect(out.reason).toContain('not available from the retained activity sources');
      expect(out.rows).toEqual([]);
      expect(out.total).toBe(0);
      expect(out.nextCursor).toBeNull();
      expect(out.scope?.jurisdiction).toBe('US');
    }
    // Supported sources keep the available marker, including a supported empty result.
    const fedAction = await svc.activities(ctx, {
      jurisdiction: 'US',
      sessionKey: '2099',
      kind: 'action',
    });
    expect(fedAction.availability).toBe('available');
    expect(fedAction.reason).toBeNull();
    expect(fedAction.rows.length).toBe(1);
    const emptyUpper = await svc.activities(ctx, {
      jurisdiction: 'US',
      sessionKey: '2099',
      kind: 'action',
      chamber: 'upper',
    });
    expect(emptyUpper.availability).toBe('available');
    expect(emptyUpper.rows.length).toBe(0);
    const flText = await svc.activities(ctx, { jurisdiction: 'FL', sessionKey: '2099', kind: 'text' });
    expect(flText.availability).toBe('available');
  });
  it('activities federal unsupported kinds still enforce tenant/folder/client and input validation', async () => {
    // Foreign tenant folder ownership is checked before the unavailable short circuit.
    await expect(
      svc.activities(foreignCtx, {
        jurisdiction: 'US',
        sessionKey: '2099',
        kind: 'text',
        folderId,
      }),
    ).rejects.toThrow('FOLDER_NOT_FOUND');
    await expect(
      svc.activities(foreignCtx, {
        jurisdiction: 'US',
        sessionKey: '2099',
        kind: 'amendment',
        folderId,
      }),
    ).rejects.toThrow('FOLDER_NOT_FOUND');
    // Nonexistent client is rejected before the short circuit too.
    await expect(
      svc.activities(ctx, {
        jurisdiction: 'US',
        sessionKey: '2099',
        kind: 'text',
        clientId: randomUUID(),
      }),
    ).rejects.toThrow('CLIENT_NOT_FOUND');
    // Malformed cursor and date range validation still run for unsupported kinds.
    await expect(
      svc.activities(ctx, {
        jurisdiction: 'US',
        sessionKey: '2099',
        kind: 'amendment',
        cursor: 'not-a-cursor',
      }),
    ).rejects.toThrow('INVALID_ACTIVITY_CURSOR');
    await expect(
      svc.activities(ctx, {
        jurisdiction: 'US',
        sessionKey: '2099',
        kind: 'text',
        from: '2099-02-01',
        to: '2099-01-01',
      }),
    ).rejects.toThrow('INVALID_DATE_RANGE');
  });
  it('export includes summary columns when summaryIncluded', async () => {
    const out = await svc.export(ctx, {
      folderId,
      jurisdiction: 'FL',
      sessionKey: '2099',
      scope: 'filtered',
      includeInternalComments: false,
      includeExternalComments: false,
      summaryIncluded: 'true',
    });
    expect(out.csv).toContain('Summary');
    expect(out.csv).toContain('Provider summary healthcare');
    expect(out.csv).toContain('Health Committee');
  });
  it('export respects actual filters with summary columns', async () => {
    const out = await svc.export(ctx, {
      folderId,
      jurisdiction: 'FL',
      sessionKey: '2099',
      scope: 'filtered',
      includeInternalComments: false,
      includeExternalComments: false,
      summaryIncluded: 'true',
      committee: 'Health Committee',
    });
    expect(out.count).toBe(1);
    expect(out.csv).toContain('Provider summary healthcare');
    expect(out.csv).not.toContain('Provider summary education');
  });
  it('activities action uses current source observation when provider reverts to older revision', async () => {
    const rollback = new Error('EXPECTED_TEST_ROLLBACK');
    try {
      await prisma.withTenant(tenant, async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.folder_actor', ${actor}, true), set_config('app.folder_admin', 'on', true)`;
        // Route this instance's actual service SQL through the SAME native transaction.
        // Otherwise activities opens a different transaction and cannot see these inserts.
        const bound = new FolderTrackerService(prisma, source, new SourceDataRepository(prisma));
        bound.withActor = (_ctx, fn) => fn(tx);
        await tx.$executeRaw`INSERT INTO published_record_source_observation(source_key,state_record_id) SELECT 'state:' || bill_key || ':action:act1', id FROM state_bill_published_record WHERE bill_key=${bill} AND kind='action' AND source_identity='act1' AND revision_hash='r2'`;
        await tx.$executeRaw`INSERT INTO published_record_source_observation(source_key,state_record_id) SELECT 'state:' || bill_key || ':action:act1', id FROM state_bill_published_record WHERE bill_key=${bill} AND kind='action' AND source_identity='act1' AND revision_hash='r1'`;
        const out = await bound.activities(ctx, {
          jurisdiction: 'FL',
          sessionKey: '2099',
          kind: 'action',
        });
        const pub = out.rows.filter(
          (r) => r.billId === bill && r.provenance === 'published_record',
        );
        expect(pub).toHaveLength(1);
        expect(pub[0]).toMatchObject({
          text: 'Published action v1',
          date: '2099-01-18',
          url: 'https://example.gov/act1v1',
        });
        const bounded = await bound.activities(ctx, {
          jurisdiction: 'FL',
          sessionKey: '2099',
          kind: 'action',
          from: '2099-01-19',
          to: '2099-01-19',
        });
        expect(bounded.rows.filter((r) => r.billId === bill)).toHaveLength(0);
        throw rollback;
      });
      throw new Error('Expected the native transaction to roll back');
    } catch (error) {
      if (error !== rollback) throw error;
    }
  });
});
