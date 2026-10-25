import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EmailService } from './email.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SESv2Client } from '@aws-sdk/client-sesv2';

jest.mock('@aws-sdk/client-sesv2', () => ({
  ...jest.requireActual('@aws-sdk/client-sesv2'),
  SESv2Client: jest.fn().mockImplementation(() => ({ send: jest.fn(), destroy: jest.fn() })),
}));
const repoRoot = resolve(__dirname, '../../../..');
const helper = require(join(repoRoot, 'scripts/testing/a1-disposable-postgres.cjs'));
const readiness = helper.nativePostgresReadiness({ repoRoot });
const native = readiness.available ? describe : describe.skip;

native(`onboarding claim PostgreSQL16 [${readiness.reason}]`, () => {
  let database: { url: string; cleanup(): Promise<void> };
  let db: PrismaService;
  let send: jest.Mock;
  let service: EmailService;
  const input = { to: 'synthetic@example.test', kind: 'receipt', dedupeKey: 'synthetic-attempt',
    subject: 'Receipt', html: '<p>Receipt</p>', text: 'Receipt' };
  beforeAll(async () => {
    // Extract the actual owned model; unrelated mirrored Core tables require
    // Core's extension setup and are outside this migration's authority.
    const source = await readFile(join(repoRoot, 'apps/onboard-api/prisma/schema.prisma'), 'utf8');
    const declarations = ['generator client', 'datasource db', 'model OnboardEmailLog']
      .map(name => source.match(new RegExp(`^${name} \\{[\\s\\S]*?^\\}`, 'm'))?.[0]);
    if (declarations.some(d => !d)) throw new Error('Missing actual Onboard email schema declaration');
    const folder = await mkdtemp(join(tmpdir(), 'wave3-onboard-schema-'));
    try {
      const schemaPath = join(folder, 'schema.prisma');
      await writeFile(schemaPath, declarations.join('\n'));
      database = await helper.createDisposableSchema({ repoRoot, coreSchemaPath: schemaPath });
    } finally { await rm(folder, { recursive: true, force: true }); }
    db = new PrismaService({ datasources: { db: { url: database.url } } });
    await db.$connect();
    // Reconstruct the unchanged pre-migration log shape from the current schema.
    await db.$executeRawUnsafe('ALTER TABLE onboard_email_log DROP COLUMN status, DROP COLUMN request_hash');
    for (const value of ['disabled', 'accepted-id', 'unknown', null]) {
      await db.$executeRaw`INSERT INTO onboard_email_log (id,kind,to_email,dedupe_key,ses_message_id)
        VALUES (gen_random_uuid(),'receipt','synthetic@example.test',${String(value)},${value})`;
    }
    const sql = await readFile(join(repoRoot, 'apps/onboard-api/prisma/migrations/20261025120000_onboard_email_delivery_claim/migration.sql'), 'utf8');
    await db.$transaction(async tx => { for (const statement of sql.replace(/^--.*$/gm, '').split(';').filter(s => s.trim()))
      await tx.$executeRawUnsafe(statement); });
  }, 240_000);
  afterAll(async () => { try { service?.onModuleDestroy(); await db?.$disconnect(); } finally { await database?.cleanup(); } }, 60_000);
  function client() {
    const result = new EmailService(db, { get: (key: string) => key === 'ONBOARD_EMAIL_ENABLED' ? 'true' : undefined } as never);
    const instance = (SESv2Client as unknown as jest.Mock).mock.results.at(-1)!.value;
    instance.send = send;
    return result;
  }
  it('preserves historical rows and marks disabled, accepted and uncertain outcomes accurately', async () => {
    const rows = await db.onboardEmailLog.findMany({ orderBy: { dedupeKey: 'asc' } });
    expect(rows.map(r => [r.dedupeKey, r.status, r.requestHash])).toEqual([
      ['accepted-id', 'sent', null], ['disabled', 'disabled', null],
      ['null', 'outcome_unknown', null], ['unknown', 'outcome_unknown', null],
    ]);
    await expect(db.onboardEmailLog.updateMany({ data: { status: 'invalid' } })).rejects.toThrow();
    await expect(db.onboardEmailLog.updateMany({ data: { requestHash: 'invalid' } })).rejects.toThrow();
  });
  it('uses the actual unique constraint to claim once before a competing provider attempt', async () => {
    send = jest.fn(async () => {
      const claim = await db.onboardEmailLog.findUniqueOrThrow({ where: { dedupeKey: input.dedupeKey } });
      expect(claim.status).toBe('sending');
      return { MessageId: 'accepted-synthetic' };
    });
    service = client(); const other = client();
    try {
      const outcomes = await Promise.all([service.send(input), other.send(input)]);
      expect(send).toHaveBeenCalledTimes(1);
      expect(outcomes.filter(r => r.sent)).toHaveLength(1);
      expect(await db.onboardEmailLog.count({ where: { dedupeKey: input.dedupeKey } })).toBe(1);
      await expect(other.send({ ...input, text: 'Changed' })).rejects.toMatchObject({ status: 409 });
      expect(send).toHaveBeenCalledTimes(1);
    } finally { other.onModuleDestroy(); }
  });
  it('fences a lost receipt after provider acceptance across a new service instance', async () => {
    send = jest.fn(async () => ({ MessageId: 'accepted-synthetic' }));
    service = client();
    const lost = { ...input, dedupeKey: 'synthetic-lost-receipt' };
    await db.$executeRawUnsafe("ALTER TABLE onboard_email_log ADD CONSTRAINT wave3_test_no_finish CHECK (dedupe_key <> 'synthetic-lost-receipt' OR status = 'sending')");
    try { await expect(service.send(lost)).rejects.toThrow(); }
    finally { await db.$executeRawUnsafe('ALTER TABLE onboard_email_log DROP CONSTRAINT wave3_test_no_finish'); }
    const restarted = client();
    try {
      await expect(restarted.send(lost)).resolves.toMatchObject({ sent: false, skipped: true, status: 'sending' });
      expect(send).toHaveBeenCalledTimes(1);
    } finally { restarted.onModuleDestroy(); }
  });
});
