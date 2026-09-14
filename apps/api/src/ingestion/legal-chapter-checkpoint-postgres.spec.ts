import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { parseFloridaCitation } from '@capiro/shared';
import { fetchFloridaStatutes } from '../external/state-register/fl-statutes.client.js';
import { runLegalResearch } from '../../scripts/sync-legal-research.js';

jest.mock('../external/state-register/fl-statutes.client.js', () => ({
  fetchFloridaStatutes: jest.fn(),
}));

describe('statute chapter checkpoints', () => {
  const p = new PrismaClient();
  const salt = randomUUID();
  const hash = (value: string) =>
    createHash('sha256')
      .update(salt + value)
      .digest('hex');
  const manifest = {
    jurisdiction: 'FL' as const,
    edition: '2026',
    sessionKey: '2026',
    citations: ['Chapter 316'],
    billIds: [],
  };
  const revisions = ['316.001', '316.002'].map((section) => ({
    id: hash(section),
    reference: parseFloridaCitation(section)!,
    edition: '2026',
    sourceUrl: 'https://www.flsenate.gov/Laws/Statutes/2026/Chapter316/All',
    contentHash: hash('html'),
    extractionHash: hash(section + 'text'),
    parserVersion: 'synthetic-checkpoint-test',
    title: 'Synthetic ' + section,
    sections: [
      { locator: 'section:' + section, text: 'Synthetic section', hash: hash(section + 'text') },
    ],
    originalHtml: '<html>Synthetic fixture ' + salt + '</html>',
    historyText: null,
    complete: true,
    coverage: { scope: 'synthetic_test' },
  }));
  beforeAll(async () => {
    if (
      process.env.LEGIWATCH_PHASE7_TEST_DATABASE !== 'disposable' ||
      !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL!).hostname)
    )
      throw Error('DISPOSABLE_LOCAL_DATABASE_REQUIRED');
    await p.$connect();
  });
  afterAll(() => p.$disconnect());
  it('retains completed sections after a later failure and retries without rewriting evidence', async () => {
    (fetchFloridaStatutes as jest.Mock).mockResolvedValue({ revisions, complete: true });
    await p.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION phase7_checkpoint_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${revisions[1]!.id}' THEN RAISE EXCEPTION 'SYNTHETIC_LATE_SECTION_FAILURE'; END IF; RETURN NEW; END $$`,
    );
    await p.$executeRawUnsafe(
      'CREATE TRIGGER phase7_checkpoint_failure BEFORE INSERT ON legal_text_revision FOR EACH ROW EXECUTE FUNCTION phase7_checkpoint_failure()',
    );
    try {
      const failed = await runLegalResearch(p, manifest);
      expect(failed).toMatchObject({ complete: false, clientAssignments: 0, notifications: 0 });
      expect(failed.outcomes[0]).toMatchObject({ status: 'unresolved' });
      expect(failed.outcomes[0]!.reason).toContain('SYNTHETIC_LATE_SECTION_FAILURE');
      const retained = await p.$queryRaw<
        Array<Record<string, unknown>>
      >`SELECT * FROM legal_text_revision WHERE id=${revisions[0]!.id}`;
      expect(retained).toHaveLength(1);
      expect(
        await p.$queryRaw`SELECT id FROM legal_text_revision WHERE id=${revisions[1]!.id}`,
      ).toEqual([]);
      await p.$executeRawUnsafe('DROP TRIGGER phase7_checkpoint_failure ON legal_text_revision');
      const retried = await runLegalResearch(p, manifest);
      expect(retried).toMatchObject({ complete: true, clientAssignments: 0, notifications: 0 });
      expect(retried.outcomes[0]).toMatchObject({
        status: 'ingested',
        revisions: revisions.map((r) => r.id),
      });
      expect(
        await p.$queryRaw`SELECT * FROM legal_text_revision WHERE id=${revisions[0]!.id}`,
      ).toEqual(retained);
      expect(
        await p.$queryRaw`SELECT id FROM legal_text_revision WHERE id=ANY(${revisions.map((r) => r.id)}::text[])`,
      ).toHaveLength(2);
    } finally {
      await p.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS phase7_checkpoint_failure ON legal_text_revision',
      );
      await p.$executeRawUnsafe('DROP FUNCTION phase7_checkpoint_failure()');
    }
  });
});
